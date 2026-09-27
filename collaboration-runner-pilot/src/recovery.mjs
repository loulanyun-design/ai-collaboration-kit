import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  HANDOFF_ENGINE,
  RUNTIME_ROOT,
  appendWorkerLog,
  assertRealPathWithin,
  createJobAtomic,
  finalizeStage,
  isWithin,
  readDoc,
  readJson,
  recordFailure,
  resolveRegisteredProject,
  updateJob,
  validateReadyProject,
  verifyResultAndReview
} from "./lib.mjs";
import { materializeCodeResult, validateCodeStructuredResult } from "./code.mjs";
import { deterministicContinuationDecision } from "./jev.mjs";

function runHandoff(projectId, command, extra = []) {
  const r = spawnSync(process.execPath, [HANDOFF_ENGINE, "--project", projectId, command, ...extra], {
    encoding: "utf8", shell: false, windowsHide: true
  });
  return { ok: r.status === 0, status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}

function block(job, reason) {
  const current = readDoc(resolveRegisteredProject(job.projectId).current);
  if (String(current.meta.status) !== "IN_PROGRESS") return { attempted: false, ok: false };
  const r = runHandoff(job.projectId, "block", ["--reason", String(reason).slice(0, 800)]);
  return { attempted: true, ok: r.ok, stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-4000) };
}

function recoveryResultPath(project, value) {
  if (!value || typeof value !== "string") throw new Error("--structured-result <local-json-file> is required");
  const resolved = path.resolve(value);
  const allowed = isWithin(project.root, resolved) || isWithin(RUNTIME_ROOT, resolved);
  if (!allowed) throw new Error("structured-result path escapes allowed roots");
  assertRealPathWithin(isWithin(project.root, resolved) ? project.root : RUNTIME_ROOT, resolved, "structured-result path");
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("structured-result must be a local JSON file no larger than 1MiB");
  return resolved;
}

export function recoverCode({ projectId, structuredResultPath }) {
  if (process.env.COLLAB_RUNNER_CHILD === "1") throw new Error("recursive recover-code is forbidden inside a delegated Codex process");
  const validated = validateReadyProject(projectId, { allowExistingJob: false });
  if (String(validated.doc.meta.task_type) !== "code") throw new Error("recover-code requires a code handoff");
  const source = recoveryResultPath(validated.P, structuredResultPath);
  const made = createJobAtomic(validated.identity, {
    taskType: "code", executor: "recovery", modelRoute: "none", modelRequested: "none",
    recoveryMode: "validated-local-structured-result", structuredResultPath: source,
    handoffSpecHash: String(validated.doc.meta.spec_hash), rootRulesHash: String(validated.doc.meta.root_rules_hash),
    projectRulesHash: String(validated.doc.meta.project_rules_hash), policyIdentity: validated.policyIdentity || null,
    currentPath: validated.P.current,
    resultPath: validated.P.result, requestedAt: new Date().toISOString()
  });
  if (!made.created) throw new Error("runner job already exists for this task/revision");
  let job = updateJob(made.job.jobFile, { workerPid: process.pid, workerStartedAt: new Date().toISOString() });
  appendWorkerLog(job.jobFile, "no-model recovery started");
  try {
    const claim = runHandoff(projectId, "claim");
    if (!claim.ok) throw Object.assign(new Error("handoff claim failed: " + (claim.stderr || claim.stdout).slice(-4000)), { kind: "claim_failed" });
    job = updateJob(job.jobFile, { state: "RUNNING", claimedAt: new Date().toISOString(), claimOutput: claim.stdout.slice(-8000), handoffState: "IN_PROGRESS" });
    finalizeStage(job.jobFile, "claimed", "VALIDATE_RECOVERY_RESULT", { autoConsumed: true });
    const current = readDoc(validated.P.current);
    const structured = validateCodeStructuredResult(readJson(source));
    const materialized = materializeCodeResult({ job, project: validated.P, current, structured, codexRuntime: null });
    job = updateJob(job.jobFile, { structuredResultMaterialized: true, resultCommit: materialized.commit, changedFiles: materialized.changedFiles });
    const returned = runHandoff(projectId, "return");
    if (!returned.ok) throw Object.assign(new Error("handoff return failed: " + (returned.stderr || returned.stdout).slice(-4000)), { kind: "return_failed" });
    job = updateJob(job.jobFile, { returnOutput: returned.stdout.slice(-8000), handoffState: "REVIEW" });
    const verified = verifyResultAndReview(job);
    if (!verified.ok) throw Object.assign(new Error(verified.problems.join("; ")), { kind: "post_return_verification" });

    const reviewCurrent = readDoc(validated.P.current);
    const reviewResult = readDoc(validated.P.result);
    const continuation = deterministicContinuationDecision({
      current: reviewCurrent,
      result: reviewResult,
      job: { ...readJson(job.jobFile), state: "SUCCEEDED" },
      observed: "SUCCEEDED"
    }) || {
      decision: "HUMAN_REVIEW",
      source: "deterministic",
      confidence: 1,
      reason: "recovery_requires_review",
      workflowBlocked: false,
      requiresUserInput: true,
      mustReturnCheckpoint: false,
      checkpointReason: null,
      nextAction: "WAIT_FOR_HUMAN_REVIEW",
      safeLocalActions: []
    };
    const autoContinue = continuation.decision === "AUTO_CONTINUE";
    const nextAction = continuation.nextAction || (autoContinue ? "CHATGPT_LOCAL_REVIEW" : "WAIT_FOR_HUMAN_REVIEW");

    job = updateJob(job.jobFile, {
      state: "SUCCEEDED",
      endedAt: new Date().toISOString(),
      handoffState: "REVIEW",
      resultPath: validated.P.result,
      continuationDecision: continuation,
      autoContinue,
      workflowBlocked: continuation.workflowBlocked === true,
      requiresUserInput: continuation.requiresUserInput === true,
      mustReturnCheckpoint: continuation.mustReturnCheckpoint === true,
      checkpointReason: continuation.checkpointReason || null
    });
    finalizeStage(job.jobFile, "completed", nextAction, {
      decision: continuation.decision,
      decisionSource: continuation.source || null,
      decisionReason: continuation.reason || null,
      autoContinue,
      workflowBlocked: continuation.workflowBlocked === true,
      requiresUserInput: continuation.requiresUserInput === true,
      mustReturnCheckpoint: continuation.mustReturnCheckpoint === true,
      checkpointReason: continuation.checkpointReason || null,
      decisionConsumedInProcess: true,
      externalJobStarted: false
    });
    appendWorkerLog(job.jobFile, "no-model recovery succeeded; continuation=" + continuation.decision);
    return readJson(job.jobFile);
  } catch (err) {
    const currentJob = readJson(job.jobFile);
    const blocked = currentJob.state === "RUNNING" ? block(currentJob, "recovery failed: " + String(err.message || err)) : { attempted: false, ok: false };
    updateJob(job.jobFile, { state: "FAILED", endedAt: new Date().toISOString(), handoffState: blocked.ok ? "BLOCKED" : (currentJob.handoffState || "READY"), failureKind: err.kind || "recovery_validation", failureMessage: String(err.message || err).slice(0, 8000), blockResult: blocked });
    recordFailure(job.jobFile, err.kind || "recovery_validation", String(err.message || err));
    appendWorkerLog(job.jobFile, "no-model recovery failed: " + String(err.message || err));
    throw err;
  }
}
