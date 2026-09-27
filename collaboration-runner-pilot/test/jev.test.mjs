import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_JEV_MIN_CONFIDENCE,
  buildContinuationState,
  decideContinuation,
  deterministicContinuationDecision,
  resolveTypeSafeCredential,
  runJevChoice,
  runJevDecision,
  runJevDecisionDirect,
  validateJevConfidence
} from "../src/jev.mjs";

function fakeInvoke(payload, status = 0) {
  return (_args, _options) => ({
    status,
    stdout: JSON.stringify(payload),
    stderr: "",
    error: null
  });
}

test("Jev decision parses typed AUTO_CONTINUE output", () => {
  const result = runJevDecision({
    state: JSON.stringify({ handoff_status: "REVIEW" }),
    invoke: fakeInvoke({
      model: "jev-1.13.0",
      id: "fake-id",
      provider: "typesafe",
      answer: {
        type: "choice",
        choice: "AUTO_CONTINUE",
        confidence: 0.96,
        probabilities: {
          AUTO_CONTINUE: 0.97,
          HUMAN_REVIEW: 0.02,
          BLOCKED: 0.01,
          NEED_MORE_INFO: 0
        }
      },
      usage: { input_tokens: 347, output_tokens: 38 }
    })
  });

  assert.equal(result.decision, "AUTO_CONTINUE");
  assert.equal(result.source, "jev_cli");
  assert.equal(result.confidence, 0.96);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.usage.input_tokens, 347);
});

test("generic Jev choice supports advisory shadow classifications", () => {
  const result = runJevChoice({
    state: JSON.stringify({ goal: "finish the task" }),
    instructions: "Classify progress.",
    criteria: {
      ADVANCING: "Concrete progress is visible.",
      STALLED: "No material progress is visible."
    },
    invoke: fakeInvoke({
      model: "jev-1.13.0",
      provider: "typesafe",
      answer: {
        type: "choice",
        choice: "ADVANCING",
        confidence: 0.91,
        probabilities: { ADVANCING: 0.91, STALLED: 0.09 }
      },
      usage: { input_tokens: 80, output_tokens: 12 }
    })
  });

  assert.equal(result.choice, "ADVANCING");
  assert.equal(result.accepted, true);
  assert.equal(result.confidence, 0.91);
  assert.equal(result.source, "jev_cli");
});

test("deterministic continuation auto-continues safe local REVIEW without calling Jev", async () => {
  const current = {
    meta: {
      task_id: "task-safe-review",
      handoff_revision: "1",
      task_type: "code",
      status: "REVIEW",
      owner: "ChatGPT",
      allow_real_system_write: "false",
      allow_bulk_write: "false",
      allow_final_submit: "false",
      allow_git_push: "false",
      allow_external_upload: "false"
    },
    body: "# Current Handoff\n\n## Goal\n\nReview local evidence.\n"
  };
  const result = {
    meta: {
      task_id: "task-safe-review",
      handoff_revision: "1",
      status: "REVIEW",
      next_owner: "ChatGPT"
    },
    body: "# Codex Result\n\n## Acceptance Evidence\n\n- local tests passed\n"
  };
  let called = false;
  const decision = await decideContinuation({
    projectId: "pilot",
    current,
    result,
    job: { state: "SUCCEEDED" },
    observed: "SUCCEEDED",
    invoke: () => {
      called = true;
      throw new Error("Jev should not be called for deterministic local review");
    }
  });

  assert.equal(called, false);
  assert.equal(decision.decision, "AUTO_CONTINUE");
  assert.equal(decision.source, "deterministic");
  assert.equal(decision.reason, "local_review_no_new_side_effects");
  assert.equal(decision.nextAction, "CHATGPT_LOCAL_REVIEW");
  assert.equal(decision.requiresUserInput, false);
  assert.equal(decision.mustReturnCheckpoint, false);
});

test("deterministic continuation keeps an already-running executor moving without model input", () => {
  const decision = deterministicContinuationDecision({
    current: { meta: { status: "IN_PROGRESS", task_id: "task-1", handoff_revision: "2" } },
    job: { taskId: "task-1", revision: "2", state: "RUNNING", nextAction: "WAIT_FOR_EXECUTOR" },
    observed: "RUNNING"
  });
  assert.equal(decision.decision, "AUTO_CONTINUE");
  assert.equal(decision.reason, "runner_already_progressing");
  assert.equal(decision.nextAction, "WAIT_FOR_EXECUTOR");
  assert.equal(decision.requiresUserInput, false);
  assert.equal(decision.mustReturnCheckpoint, false);
});

test("RUNNING without the exact task and revision identity is blocked", () => {
  const decision = deterministicContinuationDecision({
    current: { meta: { status: "IN_PROGRESS", task_id: "task-1", handoff_revision: "2" } },
    job: { taskId: "task-1", revision: "1", state: "RUNNING" },
    observed: "RUNNING"
  });
  assert.equal(decision.decision, "BLOCKED");
  assert.equal(decision.workflowBlocked, true);
  assert.equal(decision.requiresUserInput, false);
  assert.equal(decision.mustReturnCheckpoint, false);
  assert.equal(decision.nextAction, "RECONCILE_TASK_REVISION_IDENTITY");
});

test("DONE handoff returns a checkpoint without requiring a user decision", () => {
  const decision = deterministicContinuationDecision({
    current: { meta: { status: "DONE", task_id: "m1", handoff_revision: "1" } },
    job: { state: "SUCCEEDED" },
    observed: "SUCCEEDED"
  });
  assert.equal(decision.decision, null);
  assert.equal(decision.workflowBlocked, false);
  assert.equal(decision.requiresUserInput, false);
  assert.equal(decision.mustReturnCheckpoint, true);
  assert.equal(decision.checkpointReason, "MILESTONE_ACCEPTANCE_COMPLETE");
  assert.equal(decision.nextAction, "RETURN_CHECKPOINT");
});

test("timed out diagnosis is automatic and returns a checkpoint when complete", () => {
  const current = { meta: { status: "BLOCKED" } };
  const pending = deterministicContinuationDecision({ current, job: { state: "TIMED_OUT" } });
  assert.equal(pending.workflowBlocked, true);
  assert.equal(pending.requiresUserInput, false);
  assert.equal(pending.mustReturnCheckpoint, false);
  assert.equal(pending.nextAction, "CHATGPT_LOCAL_DIAGNOSIS");
  assert.ok(pending.safeLocalActions.includes("LOCAL_DIAGNOSIS"));

  const completed = deterministicContinuationDecision({
    current,
    job: { state: "TIMED_OUT" },
    localDiagnosisComplete: true
  });
  assert.equal(completed.workflowBlocked, true);
  assert.equal(completed.requiresUserInput, false);
  assert.equal(completed.mustReturnCheckpoint, true);
  assert.match(completed.checkpointReason, /DIAGNOSIS_COMPLETE/);
  assert.equal(completed.nextAction, "RETURN_CHECKPOINT_WITH_FAILURE_EVIDENCE");
});

test("transient UNAVAILABLE retries the same step at most twice then checkpoints", () => {
  const current = { meta: { status: "IN_PROGRESS" } };
  const retry = deterministicContinuationDecision({ current, job: { state: "RUNNING" }, transientUnavailableCount: 1 });
  assert.equal(retry.decision, "AUTO_CONTINUE");
  assert.equal(retry.nextAction, "RETRY_SAME_STEP");
  assert.equal(retry.mustReturnCheckpoint, false);
  assert.equal(retry.retryLimit, 2);

  const stopped = deterministicContinuationDecision({ current, job: { state: "RUNNING" }, transientUnavailableCount: 2 });
  assert.equal(stopped.workflowBlocked, true);
  assert.equal(stopped.requiresUserInput, false);
  assert.equal(stopped.mustReturnCheckpoint, true);
  assert.equal(stopped.nextAction, "RETURN_CHECKPOINT_WITH_FAILURE_EVIDENCE");
});

test("low-confidence Jev output fails safe to HUMAN_REVIEW", () => {
  const result = runJevDecision({
    state: "{}",
    minConfidence: 0.85,
    invoke: fakeInvoke({
      model: "jev-1.13.0",
      provider: "typesafe",
      answer: {
        type: "choice",
        choice: "AUTO_CONTINUE",
        confidence: 0.61,
        probabilities: {
          AUTO_CONTINUE: 0.52,
          HUMAN_REVIEW: 0.44,
          BLOCKED: 0.02,
          NEED_MORE_INFO: 0.02
        }
      },
      usage: { input_tokens: 200, output_tokens: 20 }
    }, 1)
  });

  assert.equal(result.decision, "HUMAN_REVIEW");
  assert.equal(result.reason, "low_confidence");
  assert.equal(result.suggestedChoice, "AUTO_CONTINUE");
  assert.equal(result.confidence, 0.61);
});

test("explicit BLOCKED state bypasses Jev", async () => {
  let called = false;
  const current = {
    meta: { status: "BLOCKED", task_id: "x", handoff_revision: "1" },
    body: "# Current Handoff\n"
  };
  const result = await decideContinuation({
    projectId: "pilot",
    current,
    invoke: () => {
      called = true;
      throw new Error("should not be called");
    }
  });

  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.source, "deterministic");
  assert.equal(result.workflowBlocked, true);
  assert.equal(result.requiresUserInput, false);
  assert.equal(result.mustReturnCheckpoint, false);
  assert.equal(result.nextAction, "CHATGPT_LOCAL_DIAGNOSIS");
  assert.ok(result.safeLocalActions.includes("LOCAL_DIAGNOSIS"));
  assert.equal(called, false);
});

test("UNKNOWN blocks writers but keeps read-only reconciliation automatic", () => {
  const result = deterministicContinuationDecision({
    current: { meta: { status: "IN_PROGRESS" } },
    job: { state: "UNKNOWN" },
    observed: "UNKNOWN"
  });
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.workflowBlocked, true);
  assert.equal(result.requiresUserInput, false);
  assert.equal(result.mustReturnCheckpoint, false);
  assert.equal(result.nextAction, "RECONCILE_PROCESS_OWNERSHIP");
  assert.ok(result.safeLocalActions.includes("RECONCILE_PROCESS_OWNERSHIP"));
});

test("continuation state is bounded and only includes selected sections", () => {
  const current = {
    meta: {
      task_id: "task-1",
      handoff_revision: "2",
      task_type: "code",
      status: "REVIEW",
      owner: "ChatGPT",
      allow_real_system_write: "false",
      allow_bulk_write: "false",
      allow_final_submit: "false",
      allow_git_push: "false",
      allow_external_upload: "false"
    },
    body: [
      "# Current Handoff",
      "",
      "## Goal",
      "",
      "Finish the internal stage.",
      "",
      "## Confirmed Facts",
      "",
      "X".repeat(20000),
      "",
      "## ChatGPT Business Acceptance",
      "",
      "- [ ] Verify the result.",
      "",
      "## Side-effect Notes",
      "",
      "No external effects.",
      "",
      "## Stop Conditions",
      "",
      "Stop only on a new approval requirement."
    ].join("\n")
  };

  const state = buildContinuationState({
    projectId: "pilot",
    current,
    observed: "SUCCEEDED"
  });
  const parsed = JSON.parse(state);

  assert.equal(parsed.goal, "Finish the internal stage.");
  assert.equal(parsed.business_acceptance, "- [ ] Verify the result.");
  assert.equal(parsed.side_effect_notes, "No external effects.");
  assert.ok(state.length < 12000);
  assert.doesNotMatch(state, /XXXXX/);
});

test("direct TypeSafe fallback preserves typed decision without exposing credential", async () => {
  const fakeFetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.model, "jev-1.13.0");
    assert.equal(request.questions.answer.type, "choice");
    assert.ok(request.questions.answer.criteria.AUTO_CONTINUE);
    assert.match(options.headers.Authorization, /^Bearer /);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          id: "direct-id",
          model: "jev-1.13.0",
          answers: {
            answer: {
              type: "choice",
              choice: "AUTO_CONTINUE",
              confidence: 0.94,
              probabilities: {
                AUTO_CONTINUE: 0.94,
                HUMAN_REVIEW: 0.04,
                BLOCKED: 0.01,
                NEED_MORE_INFO: 0.01
              }
            }
          },
          usage: { input_tokens: 123, output_tokens: 12 }
        });
      }
    };
  };

  const result = await runJevDecisionDirect({
    state: JSON.stringify({ handoff_status: "REVIEW" }),
    fetchImpl: fakeFetch,
    credentialResolver: () => ({ key: "secret-test-key", source: "test" })
  });

  assert.equal(result.decision, "AUTO_CONTINUE");
  assert.equal(result.source, "typesafe_direct");
  assert.equal(result.credentialSource, "test");
  assert.doesNotMatch(JSON.stringify(result), /secret-test-key/);
});

test("credential resolution prefers process environment and never returns an invented key", () => {
  assert.deepEqual(
    resolveTypeSafeCredential({ TYPESAFE_API_KEY: "process-secret" }, () => "user-secret"),
    { key: "process-secret", source: "process_env" }
  );
  assert.deepEqual(
    resolveTypeSafeCredential({}, () => "user-secret"),
    { key: "user-secret", source: "windows_user_env" }
  );
  assert.deepEqual(
    resolveTypeSafeCredential({}, () => null),
    { key: null, source: null }
  );
});

test("confidence validation keeps a conservative default", () => {
  assert.equal(validateJevConfidence(undefined), DEFAULT_JEV_MIN_CONFIDENCE);
  assert.equal(validateJevConfidence("0.9"), 0.9);
  assert.throws(() => validateJevConfidence("1.2"), /min-confidence/);
  assert.throws(() => validateJevConfidence("0"), /min-confidence/);
});
