import { spawnSync } from "node:child_process";

export const JEV_DECISIONS = Object.freeze([
  "AUTO_CONTINUE",
  "HUMAN_REVIEW",
  "BLOCKED",
  "NEED_MORE_INFO"
]);

export const DEFAULT_JEV_MODEL = "jev-1.13.0";
export const DEFAULT_JEV_MIN_CONFIDENCE = 0.85;

const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODELS_URL = "https://api.typesafe.ai/v1/models";

const BLOCKED_RUNNER_STATES = new Set([
  "FAILED",
  "BLOCKED",
  "TIMED_OUT",
  "PAUSED_QUOTA",
  "UNKNOWN"
]);

const DECISION_INSTRUCTIONS =
  "Choose the next collaboration workflow action from the observable state. Do not invent missing facts.";

const DECISION_CRITERIA = Object.freeze({
  AUTO_CONTINUE:
    "Continue without asking the user to send another continue message when the next action stays inside the already-authorized scope, available evidence is sufficient, and no new user-owned decision or irreversible external action is required. REVIEW with next owner ChatGPT is not by itself a reason to interrupt the user: already-authorized evidence review, acceptance checks, local regression tests, or internal drafting may continue automatically.",
  HUMAN_REVIEW:
    "Stop for the human user only when a user-owned business choice or explicit approval is required, including merge, publish, deploy, final submit, external send or upload, or a new real-system side effect. Do not use HUMAN_REVIEW merely because the handoff status is REVIEW or the next owner is ChatGPT.",
  BLOCKED:
    "The workflow is explicitly blocked, failed, timed out, quota-paused, unknown, or a safety, identity, lock, or scope invariant prevents safe continuation.",
  NEED_MORE_INFO:
    "Continuation requires a missing factual input that is necessary and cannot be obtained from the already available files, tools, logs, or authorized retrieval sources."
});

function clip(value, max = 2400) {
  const text = String(value || "").trim();
  return text.length <= max ? text : text.slice(0, max) + "\n[truncated]";
}

function extractSection(body, heading) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const wanted = "## " + heading;
  let active = false;
  const out = [];
  for (const line of lines) {
    if (line.trim() === wanted) {
      active = true;
      continue;
    }
    if (active && /^##\s+/.test(line)) break;
    if (active) out.push(line);
  }
  return clip(out.join("\n"));
}

function boolMeta(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function questionPayload() {
  return {
    answer: {
      type: "choice",
      instructions: DECISION_INSTRUCTIONS,
      criteria: { ...DECISION_CRITERIA }
    }
  };
}

export function validateJevConfidence(value, fallback = DEFAULT_JEV_MIN_CONFIDENCE) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error("min-confidence must be > 0 and <= 1");
  }
  return n;
}

function callJev(args, options = {}) {
  return spawnSync("jev", args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: options.timeoutMs || 15000,
    input: options.input,
    env: options.env || process.env
  });
}

function readWindowsUserTypeSafeKey() {
  if (process.platform !== "win32") return null;
  const script =
    "[Console]::Out.Write([Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY','User'))";
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 5000
    }
  );
  if (r.error || r.status !== 0) return null;
  const key = String(r.stdout || "").trim();
  return key || null;
}

export function resolveTypeSafeCredential(
  env = process.env,
  userKeyReader = readWindowsUserTypeSafeKey
) {
  const processKey = String(env.TYPESAFE_API_KEY || "").trim();
  if (processKey) return { key: processKey, source: "process_env" };

  const userKey = userKeyReader ? String(userKeyReader() || "").trim() : "";
  if (userKey) return { key: userKey, source: "windows_user_env" };

  return { key: null, source: null };
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function cliProbe(env) {
  const version = callJev(["--version"], { timeoutMs: 5000, env });
  if (version.error) {
    return {
      available: false,
      command: "jev",
      error: version.error.code || String(version.error.message || version.error)
    };
  }
  if (version.status !== 0) {
    return {
      available: false,
      command: "jev",
      exitCode: version.status,
      stderr: clip(version.stderr, 1200)
    };
  }

  const auth = callJev(["auth", "status"], { timeoutMs: 5000, env });
  return {
    available: true,
    mode: "cli",
    command: "jev",
    version: clip(version.stdout || version.stderr, 400),
    authStatusOk: !auth.error && auth.status === 0,
    authStatus: clip(auth.stdout || auth.stderr, 1800)
  };
}

export async function probeJev({
  env = process.env,
  fetchImpl = globalThis.fetch,
  credentialResolver = resolveTypeSafeCredential
} = {}) {
  const cli = cliProbe(env);
  if (cli.available) return cli;

  const credential = credentialResolver(env);
  if (!credential || !credential.key) {
    return {
      ...cli,
      directApiAvailable: false,
      credentialSource: null
    };
  }

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      TYPESAFE_MODELS_URL,
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + credential.key,
          Accept: "application/json",
          "User-Agent": "collaboration-runner-pilot/jev-gate"
        }
      },
      10000
    );
    const text = await response.text();
    return {
      available: response.ok,
      mode: response.ok ? "typesafe_direct" : null,
      cliAvailable: false,
      cliError: cli.error || null,
      directApiAvailable: response.ok,
      credentialSource: credential.source,
      authCheckOk: response.ok,
      httpStatus: response.status,
      modelsPreview: response.ok ? clip(text, 1200) : null,
      error: response.ok ? null : "typesafe_auth_check_failed"
    };
  } catch (err) {
    return {
      available: false,
      mode: null,
      cliAvailable: false,
      cliError: cli.error || null,
      directApiAvailable: false,
      credentialSource: credential.source,
      authCheckOk: false,
      error: String(err && err.name === "AbortError" ? "typesafe_auth_check_timeout" : (err.message || err))
    };
  }
}

function continuationSideEffectPolicy(current) {
  const meta = current?.meta || {};
  return {
    allow_real_system_write: boolMeta(meta.allow_real_system_write),
    allow_bulk_write: boolMeta(meta.allow_bulk_write),
    allow_final_submit: boolMeta(meta.allow_final_submit),
    allow_git_push: boolMeta(meta.allow_git_push),
    allow_external_upload: boolMeta(meta.allow_external_upload)
  };
}

export function buildContinuationState({ projectId, current, result = null, job = null, observed = null }) {
  const c = current || { meta: {}, body: "" };
  const r = result || { meta: {}, body: "" };
  return JSON.stringify({
    project_id: projectId,
    task_id: c.meta.task_id || null,
    handoff_revision: c.meta.handoff_revision || null,
    task_type: c.meta.task_type || null,
    handoff_status: c.meta.status || null,
    owner: c.meta.owner || null,
    runner_state: job ? job.state || null : null,
    runner_observed_state: observed || null,
    result_status: result ? (r.meta.status || null) : null,
    result_next_owner: result ? (r.meta.next_owner || null) : null,
    side_effect_policy: continuationSideEffectPolicy(c),
    goal: extractSection(c.body, "Goal"),
    intended_flow: extractSection(c.body, "State Machine / Intended Flow"),
    business_acceptance: extractSection(c.body, "ChatGPT Business Acceptance"),
    side_effect_notes: extractSection(c.body, "Side-effect Notes"),
    stop_conditions: extractSection(c.body, "Stop Conditions"),
    completion_basis: result ? extractSection(r.body, "Root Cause / Completion Basis") : "",
    acceptance_evidence: result ? extractSection(r.body, "Acceptance Evidence") : "",
    remaining_risks: result ? extractSection(r.body, "Remaining Risks / Unknowns") : ""
  });
}

function failSafe(reason, extra = {}) {
  return {
    decision: "HUMAN_REVIEW",
    source: "fail_safe",
    confidence: null,
    reason,
    ...extra
  };
}

function interpretChoicePayload(payload, status, threshold, source, stderr = "") {
  const answer = payload && payload.answer ? payload.answer : {};
  const choice = String(answer.choice || "");
  const confidence = Number(answer.confidence);

  if (!JEV_DECISIONS.includes(choice)) {
    return failSafe("jev_invalid_choice", {
      decisionSource: source,
      exitCode: status,
      model: payload?.model || null,
      provider: payload?.provider || null,
      suggestedChoice: choice || null,
      confidence: Number.isFinite(confidence) ? confidence : null,
      usage: payload?.usage || null
    });
  }

  if (status === 1 || !Number.isFinite(confidence) || confidence < threshold) {
    return {
      decision: "HUMAN_REVIEW",
      source,
      reason: "low_confidence",
      suggestedChoice: choice,
      confidence: Number.isFinite(confidence) ? confidence : null,
      minConfidence: threshold,
      model: payload?.model || null,
      provider: payload?.provider || null,
      usage: payload?.usage || null
    };
  }

  if (status !== 0) {
    return failSafe("jev_error", {
      decisionSource: source,
      exitCode: status,
      stderr: clip(stderr, 1200),
      model: payload?.model || null,
      provider: payload?.provider || null,
      usage: payload?.usage || null
    });
  }

  return {
    decision: choice,
    source,
    reason: "classified",
    confidence,
    minConfidence: threshold,
    model: payload?.model || null,
    provider: payload?.provider || null,
    probabilities: answer.probabilities || null,
    usage: payload?.usage || null
  };
}

export function runJevDecision({
  state,
  minConfidence = DEFAULT_JEV_MIN_CONFIDENCE,
  model = process.env.JEV_MODEL || DEFAULT_JEV_MODEL,
  env = process.env,
  timeoutMs = 15000,
  invoke = callJev
}) {
  const threshold = validateJevConfidence(minConfidence);
  const args = [
    "pick",
    DECISION_INSTRUCTIONS,
    ...Object.entries(DECISION_CRITERIA).map(([name, desc]) => name + "=" + desc),
    "-m",
    String(model),
    "--min-confidence",
    String(threshold),
    "--json"
  ];

  const r = invoke(args, { timeoutMs, input: state, env });
  if (r.error) {
    return failSafe("jev_unavailable", {
      error: r.error.code || String(r.error.message || r.error)
    });
  }

  let payload;
  try {
    payload = JSON.parse(String(r.stdout || "").trim());
  } catch (err) {
    return failSafe("jev_invalid_json", {
      exitCode: r.status,
      stderr: clip(r.stderr, 1200),
      error: String(err.message || err)
    });
  }

  return interpretChoicePayload(payload, r.status, threshold, "jev_cli", r.stderr);
}

export async function runJevDecisionDirect({
  state,
  minConfidence = DEFAULT_JEV_MIN_CONFIDENCE,
  model = process.env.JEV_MODEL || DEFAULT_JEV_MODEL,
  env = process.env,
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
  credentialResolver = resolveTypeSafeCredential
}) {
  const threshold = validateJevConfidence(minConfidence);
  const credential = credentialResolver(env);
  if (!credential || !credential.key) {
    return failSafe("typesafe_key_unavailable");
  }

  let parsedState = state;
  try {
    parsedState = JSON.parse(String(state));
  } catch {}

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      TYPESAFE_SYSTEM_ONE_URL,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + credential.key,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "collaboration-runner-pilot/jev-gate"
        },
        body: JSON.stringify({
          model: String(model),
          state: parsedState,
          questions: questionPayload()
        })
      },
      timeoutMs
    );

    const raw = await response.text();
    if (!response.ok) {
      return failSafe("typesafe_api_error", {
        httpStatus: response.status,
        credentialSource: credential.source,
        responsePreview: clip(raw, 800)
      });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      return failSafe("typesafe_invalid_json", {
        httpStatus: response.status,
        credentialSource: credential.source,
        error: String(err.message || err)
      });
    }

    const payload = {
      model: body.model || null,
      id: body.id || null,
      provider: "typesafe",
      answer: body.answers?.answer || {},
      usage: body.usage || null
    };
    const interpreted = interpretChoicePayload(payload, 0, threshold, "typesafe_direct");
    return { ...interpreted, credentialSource: credential.source };
  } catch (err) {
    return failSafe(
      err && err.name === "AbortError" ? "typesafe_api_timeout" : "typesafe_api_unavailable",
      { error: String(err && err.message ? err.message : err) }
    );
  }
}

function validateChoiceCriteria(criteria) {
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) {
    throw new Error("Jev choice criteria must be an object");
  }
  const entries = Object.entries(criteria)
    .map(([name, description]) => [String(name).trim(), String(description || "").trim()])
    .filter(([name, description]) => name && description);
  if (entries.length < 2) throw new Error("Jev choice requires at least two non-empty criteria");
  return Object.fromEntries(entries);
}

function interpretGenericChoice(payload, status, threshold, source, allowedChoices, stderr = "") {
  const answer = payload && payload.answer ? payload.answer : {};
  const choice = String(answer.choice || "");
  const confidence = Number(answer.confidence);
  const validChoice = allowedChoices.includes(choice);
  const validConfidence = Number.isFinite(confidence);

  if (!validChoice) {
    return {
      choice: null,
      accepted: false,
      source,
      reason: "jev_invalid_choice",
      suggestedChoice: choice || null,
      confidence: validConfidence ? confidence : null,
      model: payload?.model || null,
      provider: payload?.provider || null,
      usage: payload?.usage || null,
      exitCode: status
    };
  }

  if (!validConfidence || confidence < threshold || status === 1) {
    return {
      choice,
      accepted: false,
      source,
      reason: "low_confidence",
      confidence: validConfidence ? confidence : null,
      minConfidence: threshold,
      model: payload?.model || null,
      provider: payload?.provider || null,
      probabilities: answer.probabilities || null,
      usage: payload?.usage || null,
      exitCode: status
    };
  }

  if (status !== 0) {
    return {
      choice,
      accepted: false,
      source,
      reason: "jev_error",
      confidence,
      minConfidence: threshold,
      model: payload?.model || null,
      provider: payload?.provider || null,
      probabilities: answer.probabilities || null,
      usage: payload?.usage || null,
      exitCode: status,
      stderr: clip(stderr, 1200)
    };
  }

  return {
    choice,
    accepted: true,
    source,
    reason: "classified",
    confidence,
    minConfidence: threshold,
    model: payload?.model || null,
    provider: payload?.provider || null,
    probabilities: answer.probabilities || null,
    usage: payload?.usage || null
  };
}

export function runJevChoice({
  state,
  instructions,
  criteria,
  minConfidence = 0.01,
  model = process.env.JEV_MODEL || DEFAULT_JEV_MODEL,
  env = process.env,
  timeoutMs = 8000,
  invoke = callJev
}) {
  const normalizedCriteria = validateChoiceCriteria(criteria);
  const threshold = validateJevConfidence(minConfidence, 0.01);
  const args = [
    "pick",
    String(instructions || "Choose the best matching option from the observable state."),
    ...Object.entries(normalizedCriteria).map(([name, desc]) => name + "=" + desc),
    "-m",
    String(model),
    "--min-confidence",
    String(threshold),
    "--json"
  ];

  const r = invoke(args, { timeoutMs, input: state, env });
  if (r.error) {
    return {
      choice: null,
      accepted: false,
      source: "fail_safe",
      reason: "jev_unavailable",
      error: r.error.code || String(r.error.message || r.error)
    };
  }

  let payload;
  try {
    payload = JSON.parse(String(r.stdout || "").trim());
  } catch (err) {
    return {
      choice: null,
      accepted: false,
      source: "fail_safe",
      reason: "jev_invalid_json",
      exitCode: r.status,
      stderr: clip(r.stderr, 1200),
      error: String(err.message || err)
    };
  }

  return interpretGenericChoice(
    payload,
    r.status,
    threshold,
    "jev_cli",
    Object.keys(normalizedCriteria),
    r.stderr
  );
}

export async function runJevChoiceDirect({
  state,
  instructions,
  criteria,
  minConfidence = 0.01,
  model = process.env.JEV_MODEL || DEFAULT_JEV_MODEL,
  env = process.env,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
  credentialResolver = resolveTypeSafeCredential
}) {
  const normalizedCriteria = validateChoiceCriteria(criteria);
  const threshold = validateJevConfidence(minConfidence, 0.01);
  const credential = credentialResolver(env);
  if (!credential || !credential.key) {
    return {
      choice: null,
      accepted: false,
      source: "fail_safe",
      reason: "typesafe_key_unavailable"
    };
  }

  let parsedState = state;
  try {
    parsedState = JSON.parse(String(state));
  } catch {}

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      TYPESAFE_SYSTEM_ONE_URL,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + credential.key,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "collaboration-runner-pilot/jev-shadow"
        },
        body: JSON.stringify({
          model: String(model),
          state: parsedState,
          questions: {
            answer: {
              type: "choice",
              instructions: String(instructions || "Choose the best matching option from the observable state."),
              criteria: normalizedCriteria
            }
          }
        })
      },
      timeoutMs
    );

    const raw = await response.text();
    if (!response.ok) {
      return {
        choice: null,
        accepted: false,
        source: "fail_safe",
        reason: "typesafe_api_error",
        httpStatus: response.status,
        credentialSource: credential.source,
        responsePreview: clip(raw, 800)
      };
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      return {
        choice: null,
        accepted: false,
        source: "fail_safe",
        reason: "typesafe_invalid_json",
        httpStatus: response.status,
        credentialSource: credential.source,
        error: String(err.message || err)
      };
    }

    const payload = {
      model: body.model || null,
      id: body.id || null,
      provider: "typesafe",
      answer: body.answers?.answer || {},
      usage: body.usage || null
    };
    return {
      ...interpretGenericChoice(
        payload,
        0,
        threshold,
        "typesafe_direct",
        Object.keys(normalizedCriteria)
      ),
      credentialSource: credential.source
    };
  } catch (err) {
    return {
      choice: null,
      accepted: false,
      source: "fail_safe",
      reason: err && err.name === "AbortError"
        ? "typesafe_api_timeout"
        : "typesafe_api_unavailable",
      error: String(err && err.message ? err.message : err)
    };
  }
}

export async function runJevChoiceWithFallback(options) {
  const cli = runJevChoice(options);
  if (cli.reason !== "jev_unavailable" || cli.error !== "ENOENT") return cli;
  return await runJevChoiceDirect(options);
}

export async function runJevDecisionWithFallback(options) {
  const cli = runJevDecision(options);
  if (cli.reason !== "jev_unavailable" || cli.error !== "ENOENT") return cli;
  return await runJevDecisionDirect(options);
}

export function deterministicContinuationDecision({
  current,
  result = null,
  job = null,
  observed = null,
  localDiagnosisComplete = false,
  transientUnavailableCount = 0,
  transientUnavailableLimit = 2
}) {
  const handoffStatus = String(current?.meta?.status || "");
  const runnerState = String(observed || job?.state || "");

  if (handoffStatus === "DONE") {
    return {
      decision: null,
      source: "deterministic",
      confidence: 1,
      reason: "milestone_acceptance_complete",
      workflowBlocked: false,
      requiresUserInput: false,
      mustReturnCheckpoint: true,
      checkpointReason: "MILESTONE_ACCEPTANCE_COMPLETE",
      nextAction: "RETURN_CHECKPOINT",
      safeLocalActions: []
    };
  }

  const unavailableCount = Number(transientUnavailableCount);
  const unavailableLimit = Number(transientUnavailableLimit);
  if (!Number.isInteger(unavailableCount) || unavailableCount < 0 ||
      !Number.isInteger(unavailableLimit) || unavailableLimit < 1) {
    throw new Error("transient unavailable counts must be non-negative integers and limit must be positive");
  }

  if (handoffStatus === "BLOCKED" || BLOCKED_RUNNER_STATES.has(runnerState)) {
    const isUnknown = runnerState === "UNKNOWN";
    if (localDiagnosisComplete) {
      return {
        decision: null,
        source: "deterministic",
        confidence: 1,
        reason: "local_diagnosis_complete_after_failure",
        workflowBlocked: true,
        requiresUserInput: false,
        mustReturnCheckpoint: true,
        checkpointReason: "LOCAL_DIAGNOSIS_COMPLETE_AFTER_" + (runnerState || handoffStatus),
        nextAction: "RETURN_CHECKPOINT_WITH_FAILURE_EVIDENCE",
        safeLocalActions: []
      };
    }
    return {
      decision: "BLOCKED",
      source: "deterministic",
      confidence: 1,
      reason: handoffStatus === "BLOCKED"
        ? "handoff_status_blocked"
        : "runner_state_" + runnerState.toLowerCase(),
      workflowBlocked: true,
      safeLocalActions: isUnknown
        ? ["READ_STATUS", "READ_LOGS", "RECONCILE_PROCESS_OWNERSHIP"]
        : ["READ_STATUS", "READ_RESULT", "READ_LOGS", "LOCAL_DIAGNOSIS"],
      nextAction: isUnknown ? "RECONCILE_PROCESS_OWNERSHIP" : "CHATGPT_LOCAL_DIAGNOSIS",
      requiresUserInput: false,
      mustReturnCheckpoint: false,
      checkpointReason: "RETURN_AFTER_LOCAL_DIAGNOSIS"
    };
  }

  if (unavailableCount >= unavailableLimit) {
    return {
      decision: null,
      source: "deterministic",
      confidence: 1,
      reason: "transient_unavailable_retry_budget_exhausted",
      workflowBlocked: true,
      requiresUserInput: false,
      mustReturnCheckpoint: true,
      checkpointReason: "TRANSIENT_UNAVAILABLE_RETRY_BUDGET_EXHAUSTED",
      nextAction: "RETURN_CHECKPOINT_WITH_FAILURE_EVIDENCE",
      safeLocalActions: ["PRESERVE_FAILURE_EVIDENCE"],
      retryCount: unavailableCount,
      retryLimit: unavailableLimit
    };
  }

  if (unavailableCount > 0) {
    return {
      decision: "AUTO_CONTINUE",
      source: "deterministic",
      confidence: 1,
      reason: "transient_unavailable_bounded_same_step_retry",
      workflowBlocked: false,
      requiresUserInput: false,
      mustReturnCheckpoint: false,
      checkpointReason: null,
      nextAction: "RETRY_SAME_STEP",
      safeLocalActions: ["RETRY_SAME_STEP"],
      retryCount: unavailableCount,
      retryLimit: unavailableLimit
    };
  }

  if (handoffStatus === "IN_PROGRESS" && runnerState === "RUNNING") {
    const jobMatchesCurrent =
      Boolean(job) &&
      String(job.taskId || "") === String(current?.meta?.task_id || "") &&
      String(job.revision || "") === String(current?.meta?.handoff_revision || "");
    if (!jobMatchesCurrent) {
      return {
        decision: "BLOCKED",
        source: "deterministic",
        confidence: 1,
        reason: "runner_task_revision_identity_mismatch",
        workflowBlocked: true,
        requiresUserInput: false,
        mustReturnCheckpoint: false,
        checkpointReason: "RETURN_AFTER_IDENTITY_RECONCILIATION",
        nextAction: "RECONCILE_TASK_REVISION_IDENTITY",
        safeLocalActions: ["READ_STATUS", "READ_LOGS"]
      };
    }
    return {
      decision: "AUTO_CONTINUE",
      source: "deterministic",
      confidence: 1,
      reason: "runner_already_progressing",
      workflowBlocked: false,
      safeLocalActions: ["READ_STATUS", "WAIT_FOR_EXECUTOR"],
      nextAction: job?.nextAction || "WAIT_FOR_EXECUTOR",
      requiresUserInput: false,
      mustReturnCheckpoint: false,
      checkpointReason: null
    };
  }

  if (handoffStatus === "REVIEW" && result) {
    const sameIdentity =
      String(result.meta?.task_id || "") === String(current?.meta?.task_id || "") &&
      String(result.meta?.handoff_revision || "") === String(current?.meta?.handoff_revision || "");
    const resultReady =
      sameIdentity &&
      String(result.meta?.status || "") === "REVIEW" &&
      String(result.meta?.next_owner || "") === "ChatGPT";
    const sideEffects = continuationSideEffectPolicy(current);
    const noNewExternalSideEffect = Object.values(sideEffects).every((value) => value === false);

    if (resultReady && noNewExternalSideEffect) {
      return {
        decision: "AUTO_CONTINUE",
        source: "deterministic",
        confidence: 1,
        reason: "local_review_no_new_side_effects",
        workflowBlocked: false,
        safeLocalActions: ["READ_RESULT", "REVIEW_EVIDENCE", "RUN_LOCAL_VALIDATION"],
        nextAction: "CHATGPT_LOCAL_REVIEW",
        requiresUserInput: false,
        mustReturnCheckpoint: false,
        checkpointReason: null
      };
    }
  }

  return null;
}

export async function decideContinuation({
  projectId,
  current,
  result = null,
  job = null,
  observed = null,
  localDiagnosisComplete = false,
  transientUnavailableCount = 0,
  transientUnavailableLimit = 2,
  minConfidence,
  env,
  invoke,
  fetchImpl,
  credentialResolver
}) {
  const deterministic = deterministicContinuationDecision({
    current,
    result,
    job,
    observed,
    localDiagnosisComplete,
    transientUnavailableCount,
    transientUnavailableLimit
  });
  if (deterministic) return deterministic;

  const state = buildContinuationState({ projectId, current, result, job, observed });
  const decision = invoke
    ? runJevDecision({ state, minConfidence, env, invoke })
    : await runJevDecisionWithFallback({ state, minConfidence, env, fetchImpl, credentialResolver });
  return {
    ...decision,
    workflowBlocked: decision.decision === "BLOCKED",
    requiresUserInput: decision.decision === "HUMAN_REVIEW" || decision.decision === "NEED_MORE_INFO",
    mustReturnCheckpoint: false,
    checkpointReason: null,
    nextAction: decision.decision === "AUTO_CONTINUE"
      ? "CONTINUE_CURRENT_MILESTONE"
      : decision.decision === "BLOCKED" ? "CHATGPT_LOCAL_DIAGNOSIS"
        : decision.decision === "NEED_MORE_INFO" ? "WAIT_FOR_REQUIRED_INFO" : "WAIT_FOR_USER_DECISION",
    safeLocalActions: decision.decision === "AUTO_CONTINUE"
      ? ["CONTINUE_CURRENT_MILESTONE"]
      : decision.decision === "BLOCKED" ? ["READ_STATUS", "READ_RESULT", "READ_LOGS", "LOCAL_DIAGNOSIS"] : []
  };
}
