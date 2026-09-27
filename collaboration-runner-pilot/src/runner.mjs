import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  JOBS_ROOT,
  approveArtifact,
  artifactManifestPath,
  boundedText,
  createJobAtomic,
  findJob,
  isWithin,
  observedState,
  parseCliArgs,
  readDoc,
  readJson,
  readArtifactManifest,
  resolveCurrentIdentity,
  resolveRegisteredProject,
  runnerBuildIdentity,
  validateReadyProject,
  validateTimeout,
  updateJob
} from "./lib.mjs";
import { resolveCodexRuntime } from "./executors/codex.mjs";
import { isDeterministicLocalCopyTask } from "./executors/local-copy.mjs";
import { captureProcessIdentity, inspectProcessIdentity } from "./process-lifecycle.mjs";
import { modelForRoute, resolveModelRoute, timeoutPolicyForRoute } from "./model-policy.mjs";
import { decideContinuation, probeJev } from "./jev.mjs";
import { jevShadowStatus, writeJevShadowConfig } from "./jev-shadow.mjs";
import { recoverCode } from "./recovery.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "worker.mjs");

function fail(message, code = 2) {
  console.error("[runner] ERROR:", message);
  process.exit(code);
}

function requireProject(args) {
  const p = String(args.project || "");
  if (!p) fail("--project <registered-project-id> is required");
  return p;
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function validateOptions(args, allowed) {
  if (args._.length !== 1) fail("unexpected positional arguments");
  for (const key of Object.keys(args)) {
    if (key === "_") continue;
    if (!allowed.includes(key)) fail("unsupported option: --" + key);
  }
}

function publicFailureEnvelope(job) {
  const kindMap = {
    claim_failed: "PROJECT_CLAIM_FAILED",
    claim_blocked: "PROJECT_CLAIM_BLOCKED",
    quota: "CODEX_QUOTA",
    executor_launch_timeout: "EXECUTOR_LAUNCH_TIMEOUT",
    executor_max_runtime: "EXECUTOR_MAX_RUNTIME",
    timeout: "EXECUTOR_MAX_RUNTIME",
    executor_lifecycle_unknown: "EXECUTOR_PROCESS_UNKNOWN",
    executor_error: "EXECUTOR_ERROR",
    nonzero_exit: "EXECUTOR_NONZERO_EXIT",
    pseudo_success: "RESULT_VALIDATION_FAILED",
    structured_materialization: "RESULT_MATERIALIZATION_FAILED",
    return_failed: "HANDOFF_RETURN_FAILED",
    post_return_verification: "RESULT_VALIDATION_FAILED",
    worker_exception: "RUNNER_WORKER_ERROR"
  };

  const primaryFailureKind = job.failureKind
    ? (kindMap[job.failureKind] || String(job.failureKind).toUpperCase())
    : null;

  const layer = !primaryFailureKind
    ? null
    : (primaryFailureKind.startsWith("CODEX_") || primaryFailureKind.startsWith("EXECUTOR_")
      ? "executor"
      : (primaryFailureKind.startsWith("RESULT_") || primaryFailureKind.startsWith("HANDOFF_")
        ? "runner_validation"
        : "runner"));

  const executorLaunchState = job.protocolStartedAt
    ? "PROTOCOL_STARTED"
    : (job.executorStartedAt
      ? "PROCESS_STARTED"
      : (job.childPid ? "PROCESS_ID_RECORDED" : "NOT_STARTED"));

  let terminationConfidence = null;
  if (job.termination) {
    if (job.termination.verifiedGone === true) terminationConfidence = "VERIFIED_GONE";
    else if (job.termination.ownershipUncertain === true) terminationConfidence = "OWNERSHIP_UNCERTAIN";
  } else if (job.executorExitedAt || (job.executorEndedAt && job.executorAlive === false)) {
    terminationConfidence = "EXIT_OBSERVED";
  } else if (job.executorAlive === true) {
    terminationConfidence = "ALIVE";
  } else if (job.executorAlive === null) {
    terminationConfidence = "UNKNOWN";
  }
  if (!terminationConfidence && observedState(job) === "UNKNOWN") {
    terminationConfidence = "UNKNOWN";
  }

  const secondaryFailures = [];
  if (job.blockResult && job.blockResult.attempted && job.blockResult.ok === false) {
    secondaryFailures.push("HANDOFF_BLOCK_NOT_CONFIRMED");
  }
  if (job.termination && job.termination.reason && job.termination.verifiedGone !== true) {
    secondaryFailures.push("PROCESS_TERMINATION_NOT_VERIFIED");
  }

  return {
    layer,
    primaryFailureKind,
    secondaryFailures,
    executorLaunchState,
    terminationConfidence
  };
}

function publicJob(job, extra = {}) {
  return {
    jobId: job.jobId || null,
    projectId: job.projectId,
    taskId: job.taskId,
    revision: job.revision,
    taskType: job.taskType || null,
    executor: job.executor || null,
    modelRoute: job.modelRoute || null,
    modelRequested: job.modelRequested || null,
    codexSource: job.codexSource || null,
    codexVersion: job.codexVersion || null,
    codexJs: job.codexJs || null,
    runnerBuildIdentity: job.runnerBuildIdentity || null,
    policyIdentity: job.policyIdentity || null,
    writerFence: job.writerFence || null,
    workerProcessIdentity: job.workerProcessIdentity || null,
    childProcessIdentity: job.childProcessIdentity || null,
    state: job.state,
    observedState: observedState(job),
    workerPid: job.workerPid || null,
    childPid: job.childPid || null,
    createdAt: job.createdAt || null,
    launchedAt: job.launchedAt || null,
    workerStartedAt: job.workerStartedAt || null,
    claimedAt: job.claimedAt || null,
    executorStartedAt: job.executorStartedAt || null,
    executorEndedAt: job.executorEndedAt || null,
    endedAt: job.endedAt || null,
    executorExitCode: job.executorExitCode ?? null,
    failureKind: job.failureKind || null,
    failureMessage: job.failureMessage || null,
    ...publicFailureEnvelope(job),
    handoffState: job.handoffState || null,
    resultPath: job.resultPath || null,
    checkpoint: job.checkpoint || null,
    phase: job.phase || null,
    heartbeatAt: job.heartbeatAt || null,
    workerHeartbeatAt: job.workerHeartbeatAt || null,
    executorHeartbeatAt: job.executorHeartbeatAt || null,
    executorAlive: job.executorAlive === true ? true : (job.executorAlive === false ? false : null),
    executorExitedAt: job.executorExitedAt || null,
    protocolStartedAt: job.protocolStartedAt || null,
    lastProgressAt: job.lastProgressAt || null,
    lastProgressType: job.lastProgressType || null,
    lastTransportActivityAt: job.lastTransportActivityAt || null,
    idleObservationAt: job.idleObservationAt || null,
    idleForMs: job.idleForMs ?? null,
    timeoutPolicy: job.timeoutPolicy || null,
    lastActivityAt: job.lastActivityAt || null,
    nextAction: job.nextAction || null,
    failureLedger: job.failureLedger || null,
    escalationGate: job.escalationGate === true,
    workerLog: job.workerLog || null,
    executorStdout: job.executorStdout || null,
    executorStderr: job.executorStderr || null,
    jevShadowEnabled: job.jevShadowEnabled === true,
    jevShadowLog: job.jevShadowLog || null,
    jevShadowLatest: job.jevShadowLatest || null,
    continuationDecision: job.continuationDecision || null,
    autoContinue: job.autoContinue === true,
    requiresUserInput: job.requiresUserInput === true,
    workflowBlocked: job.workflowBlocked === true,
    mustReturnCheckpoint: job.mustReturnCheckpoint === true,
    checkpointReason: job.checkpointReason || null,
    localCopyVerification: Array.isArray(job.localCopyVerification) ? job.localCopyVerification : null,
    ...extra
  };
}

function loadJobFromArgs(args) {
  if (args.job) {
    const jobId = String(args.job);
    if (!/^[0-9a-f]{32}$/.test(jobId)) fail("--job must be a 32-character lowercase hex job id");
    const file = path.join(JOBS_ROOT, jobId, "job.json");
    if (!fs.existsSync(file)) fail("job not found: " + jobId);
    return readJson(file);
  }

  const projectId = requireProject(args);
  const identity = resolveCurrentIdentity(projectId);
  const file = path.join(JOBS_ROOT, (awaitKey(identity)), "job.json");
  if (!fs.existsSync(file)) fail("no runner job found for current task/revision");
  return readJson(file);
}

function awaitKey(identity) {
  return crypto.createHash("sha256")
    .update(identity.projectId + "\n" + identity.taskId + "\n" + identity.revision)
    .digest("hex")
    .slice(0, 32);
}

function commandPreflight(args) {
  validateOptions(args, ["project"]);
  const projectId = requireProject(args);
  const P = resolveRegisteredProject(projectId);

  let doc;
  try {
    doc = readDoc(P.current);
  } catch (err) {
    printJson({
      ok: true,
      projectId,
      preflightStatus: "HANDOFF_UNREADABLE",
      readyForNewLaunch: false,
      duplicateSubmission: false,
      existingJob: null,
      diagnostic: String(err && err.message ? err.message : err),
      handoff: { status: null, owner: null, currentPath: P.current, projectRules: P.rules },
      runnerBuildIdentity: runnerBuildIdentity(),
      validationSource: "collaboration-runner-pilot/src/runner.mjs#preflight"
    });
    return;
  }

  let validated;
  try {
    validated = validateReadyProject(projectId, { allowExistingJob: true });
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    const invalidHandoff = /task_id|handoff_revision|task_type|project_id mismatch|policy_schema_version|policy identity mismatch|policy manifest|normative policy|cannot weaken|rules hash mismatch|handoff file|front matter|unsupported characters/.test(message);
    const preflightStatus = message === "handoff is not READY"
      ? "NOT_READY"
      : (invalidHandoff ? "INVALID_HANDOFF" : "BLOCKED");
    const taskId = String(doc.meta.task_id || "");
    const revision = String(doc.meta.handoff_revision || "");
    printJson({
      ok: true,
      projectId,
      taskId: /^[A-Za-z0-9._-]{1,160}$/.test(taskId) ? taskId : null,
      revision: /^[1-9][0-9]*$/.test(revision) ? revision : null,
      taskType: String(doc.meta.task_type || ""),
      preflightStatus,
      blockReason: preflightStatus === "NOT_READY"
        ? "HANDOFF_NOT_READY"
        : (preflightStatus === "INVALID_HANDOFF" ? "HANDOFF_INVALID" : "PREFLIGHT_VALIDATION_FAILED"),
      readyForNewLaunch: false,
      duplicateSubmission: false,
      existingJob: null,
      diagnostic: message,
      handoff: {
        status: doc.meta.status || null,
        owner: doc.meta.owner || null,
        currentPath: P.current,
        projectRules: P.rules
      },
      policyIdentity: null,
      runnerBuildIdentity: runnerBuildIdentity(),
      validationSource: "collaboration-runner-pilot/src/runner.mjs#preflight"
    });
    return;
  }

  const current = validated.doc.meta || {};
  const job = validated.job || null;
  printJson({
    ok: true,
    projectId: validated.identity.projectId,
    taskId: validated.identity.taskId,
    revision: validated.identity.revision,
    taskType: String(current.task_type || ""),
    preflightStatus: validated.duplicate ? "DUPLICATE" : "READY",
    handoff: {
      status: current.status || null,
      owner: current.owner || null,
      currentPath: validated.P.current,
      projectRules: validated.P.rules
    },
    policyIdentity: validated.policyIdentity || null,
    readyForNewLaunch: validated.duplicate !== true,
    duplicateSubmission: validated.duplicate === true,
    existingJob: job ? {
      jobId: job.jobId || null,
      state: job.state || null,
      observedState: observedState(job),
      phase: job.phase || null,
      modelRoute: job.modelRoute || null
    } : null,
    runnerBuildIdentity: runnerBuildIdentity(),
    validationSource: "collaboration-runner-pilot/src/runner.mjs#preflight"
  });
}
async function commandSubmit(args) {
  validateOptions(args, ["project", "executor", "fake-mode", "timeout-ms", "model-route"]);
  if (process.env.COLLAB_RUNNER_CHILD === "1") {
    fail("recursive submit is forbidden inside a delegated Codex process");
  }

  const projectId = requireProject(args);
  resolveRegisteredProject(projectId);

  const requestedExecutor = String(args.executor || "auto");
  if (!["auto", "codex", "fake"].includes(requestedExecutor)) {
    fail("--executor must be auto, codex or fake");
  }

  const fakeMode = String(args["fake-mode"] || "success");
  if (requestedExecutor === "fake" && !["success", "fail", "timeout", "pseudo_success", "crash", "quota"].includes(fakeMode)) {
    fail("unsupported --fake-mode");
  }

  const validated = validateReadyProject(projectId, { allowExistingJob: true });

  if (validated.duplicate && validated.job) {
    printJson(publicJob(validated.job, { duplicateSubmission: true, launched: false }));
    return;
  }

  const localCopy = requestedExecutor === "auto" &&
    String(validated.doc.meta.task_type || "") === "non_code" &&
    isDeterministicLocalCopyTask(validated.doc);
  const executor = localCopy ? "local_copy" : (requestedExecutor === "auto" ? "codex" : requestedExecutor);

  if (executor === "fake" && projectId !== "collaboration-runner-pilot") {
    fail("fake executor is restricted to collaboration-runner-pilot");
  }
  if (executor === "local_copy" && args["model-route"]) {
    fail("deterministic local copy does not accept --model-route");
  }

  const modelRoute = executor === "codex" ? resolveModelRoute(args["model-route"]) : null;
  const baseTimeoutPolicy = executor === "codex"
    ? timeoutPolicyForRoute(modelRoute)
    : {
        version: executor === "local_copy" ? "local-copy-v1" : "fake-v1",
        launchTimeoutMs: null,
        idleObservationMs: null,
        maxRuntimeMs: 10000
      };
  const timeoutMs = validateTimeout(args["timeout-ms"], baseTimeoutPolicy.maxRuntimeMs);
  const timeoutPolicy = {
    ...baseTimeoutPolicy,
    maxRuntimeMs: timeoutMs,
    maxRuntimeOverridden: args["timeout-ms"] !== undefined
  };
  const requestedModel = executor === "local_copy" ? "none" : (modelRoute ? modelForRoute(modelRoute) : null);
  const codexRuntime = executor === "codex" ? resolveCodexRuntime() : null;

  const initial = {
    taskType: String(validated.doc.meta.task_type),
    executor,
    fakeMode: executor === "fake" ? fakeMode : null,
    timeoutMs,
    timeoutPolicy,
    modelRoute,
    modelRequested: requestedModel,
    codexSource: codexRuntime ? codexRuntime.source : null,
    codexVersion: codexRuntime ? codexRuntime.version : null,
    codexJs: codexRuntime ? codexRuntime.codexJs : null,
    runnerBuildIdentity: runnerBuildIdentity(),
    writerFence: "active",
    handoffSpecHash: String(validated.doc.meta.spec_hash),
    rootRulesHash: String(validated.doc.meta.root_rules_hash),
    projectRulesHash: String(validated.doc.meta.project_rules_hash),
    policyIdentity: validated.policyIdentity || null,
    currentPath: validated.P.current,
    resultPath: validated.P.result,
    requestedAt: new Date().toISOString()
  };

  const made = createJobAtomic(validated.identity, initial);
  if (!made.created) {
    printJson(publicJob(made.job, { duplicateSubmission: true, launched: false }));
    return;
  }

  const child = spawn(process.execPath, [WORKER, "--job-file", made.job.jobFile], {
    cwd: path.dirname(WORKER),
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      COLLAB_RUNNER_WORKER: "1"
    }
  });
  child.unref();

  const workerProcessIdentity = captureProcessIdentity(child.pid);
  const job = updateJob(made.job.jobFile, {
    workerPid: child.pid,
    workerProcessIdentity,
    launchedAt: new Date().toISOString()
  });

  printJson(publicJob(job, { duplicateSubmission: false, launched: true }));
}

function commandRecoverCode(args) {
  validateOptions(args, ["project", "structured-result"]);
  const job = recoverCode({ projectId: requireProject(args), structuredResultPath: String(args["structured-result"] || "") });
  printJson(publicJob(job, { launched: false, synchronous: true, noModel: true }));
}

function commandStatus(args) {
  validateOptions(args, ["project", "job"]);
  const job = loadJobFromArgs(args);
  let handoff = null;
  let lock = null;
  try {
    const P = resolveRegisteredProject(job.projectId);
    const current = readDoc(P.current);
    handoff = {
      taskId: current.meta.task_id || null,
      revision: current.meta.handoff_revision || null,
      status: current.meta.status || null,
      owner: current.meta.owner || null
    };
    if (fs.existsSync(P.lock)) {
      lock = JSON.parse(fs.readFileSync(P.lock, "utf8"));
    }
  } catch (err) {
    handoff = { diagnostic: String(err.message || err) };
  }

  const observed = observedState(job);
  const diagnostic = observed === "UNKNOWN"
    ? "worker PID is no longer alive while completion is unconfirmed; state is not auto-retried and any project handoff lock is left untouched"
    : null;

  printJson(publicJob(job, {
    observedState: observed,
    diagnostic,
    handoff,
    projectLock: lock
  }));
}

function commandResult(args) {
  validateOptions(args, ["project", "job"]);
  const job = loadJobFromArgs(args);
  const P = resolveRegisteredProject(job.projectId);
  let resultText = "";
  let resultSource = null;

  if (
    job.resultSnapshot &&
    isWithin(job.jobDir, job.resultSnapshot) &&
    fs.existsSync(job.resultSnapshot)
  ) {
    resultText = fs.readFileSync(job.resultSnapshot, "utf8");
    resultSource = "job_snapshot";
  } else if (fs.existsSync(P.result)) {
    try {
      const currentResult = readDoc(P.result);
      if (
        String(currentResult.meta.task_id || "") === job.taskId &&
        String(currentResult.meta.handoff_revision || "") === job.revision
      ) {
        resultText = fs.readFileSync(P.result, "utf8");
        resultSource = "project_current";
      }
    } catch {}
  }

  printJson(publicJob(job, {
    handoffResultExists: Boolean(resultSource),
    resultSource,
    resultPreviewTruncated: Buffer.byteLength(resultText, "utf8") > 64 * 1024
  }));
  process.stdout.write("--- RESULT.md ---\n");
  if (!resultText) {
    process.stdout.write("[no matching job-specific RESULT snapshot available]\n");
    return;
  }
  process.stdout.write(boundedText(resultText, 64 * 1024) + (resultText.endsWith("\n") ? "" : "\n"));
}

async function commandResume(args) {
  validateOptions(args, ["project", "diagnosis-complete", "unavailable-count"]);
  const projectId = requireProject(args);
  const diagnosisComplete = String(args["diagnosis-complete"] || "false").toLowerCase();
  if (!["true", "false"].includes(diagnosisComplete)) fail("--diagnosis-complete must be true or false");
  const unavailableCount = args["unavailable-count"] === undefined ? 0 : Number(args["unavailable-count"]);
  if (!Number.isInteger(unavailableCount) || unavailableCount < 0 || unavailableCount > 2) {
    fail("--unavailable-count must be an integer from 0 to 2");
  }
  const P = resolveRegisteredProject(projectId);
  const current = readDoc(P.current);
  const identity = resolveCurrentIdentity(projectId);
  const job = findJob(identity);
  let resultDoc = null;
  let result = { present: false, matchingIdentity: false };
  if (fs.existsSync(P.result)) {
    try {
      const doc = readDoc(P.result);
      resultDoc = doc;
      result = {
        present: true,
        matchingIdentity: String(doc.meta.task_id || "") === identity.taskId && String(doc.meta.handoff_revision || "") === identity.revision,
        status: doc.meta.status || null,
        nextOwner: doc.meta.next_owner || null
      };
    } catch (err) { result = { present: true, matchingIdentity: false, diagnostic: String(err.message || err) }; }
  }

  const continuation = await decideContinuation({
    projectId,
    current,
    result: resultDoc && result.matchingIdentity ? resultDoc : null,
    job,
    observed: job ? observedState(job) : null,
    localDiagnosisComplete: diagnosisComplete === "true",
    transientUnavailableCount: unavailableCount
  });

  const manifest = readArtifactManifest(P);
  printJson({
    projectId, taskId: identity.taskId, revision: identity.revision,
    handoff: { status: current.meta.status || null, owner: current.meta.owner || null },
    job: job ? {
      jobId: job.jobId || null, state: job.state || null, observedState: observedState(job),
      phase: job.phase || null, nextAction: job.nextAction || null, checkpoint: job.checkpoint || null,
      modelRoute: job.modelRoute || null, modelRequested: job.modelRequested || null,
      continuationDecision: job.continuationDecision || null,
      autoContinue: job.autoContinue === true,
      requiresUserInput: continuation.requiresUserInput === true,
      workflowBlocked: continuation.workflowBlocked === true,
      mustReturnCheckpoint: continuation.mustReturnCheckpoint === true,
      checkpointReason: continuation.checkpointReason || null
    } : null,
    continuation,
    result,
    artifacts: { manifestPath: artifactManifestPath(P), present: fs.existsSync(artifactManifestPath(P)), current: manifest.current, statuses: manifest.artifacts.map((item) => ({ logical_id: item.logical_id, version: item.version, status: item.status })) },
    connectorHealth: "unknown_not_asserted"
  });
}

function commandArtifactStatus(args) {
  validateOptions(args, ["project"]);
  const P = resolveRegisteredProject(requireProject(args));
  printJson({ manifestPath: artifactManifestPath(P), manifest: readArtifactManifest(P) });
}

function commandArtifactApprove(args) {
  validateOptions(args, ["project", "logical-id", "version", "relative-path", "content-hash", "approval-ref"]);
  const P = resolveRegisteredProject(requireProject(args));
  const required = ["logical-id", "version", "relative-path", "content-hash", "approval-ref"];
  for (const key of required) if (!args[key]) fail("--" + key + " is required");
  const approved = approveArtifact(P, {
    logical_id: String(args["logical-id"]), version: String(args.version),
    relative_path: String(args["relative-path"]), content_hash: String(args["content-hash"]),
    approval_ref: String(args["approval-ref"])
  });
  printJson({ approved, current: readArtifactManifest(P).current[approved.logical_id] });
}

async function commandJevStatus(args) {
  validateOptions(args, []);
  printJson(await probeJev());
}

function commandJevShadow(args) {
  if (args._.length !== 2) fail("usage: runner.mjs jev-shadow <enable|disable|status>");
  for (const key of Object.keys(args)) {
    if (key !== "_") fail("unsupported option: --" + key);
  }
  const action = String(args._[1] || "");
  if (action === "enable") {
    const config = writeJevShadowConfig({ enabled: true });
    printJson({ action, config, status: jevShadowStatus() });
    return;
  }
  if (action === "disable") {
    const config = writeJevShadowConfig({ enabled: false });
    printJson({ action, config, status: jevShadowStatus() });
    return;
  }
  if (action === "status") {
    printJson(jevShadowStatus());
    return;
  }
  fail("usage: runner.mjs jev-shadow <enable|disable|status>");
}

async function commandDecide(args) {
  validateOptions(args, ["project", "min-confidence", "diagnosis-complete", "unavailable-count"]);
  const projectId = requireProject(args);
  const diagnosisComplete = String(args["diagnosis-complete"] || "false").toLowerCase();
  if (!["true", "false"].includes(diagnosisComplete)) fail("--diagnosis-complete must be true or false");
  const unavailableCount = args["unavailable-count"] === undefined ? 0 : Number(args["unavailable-count"]);
  if (!Number.isInteger(unavailableCount) || unavailableCount < 0 || unavailableCount > 2) {
    fail("--unavailable-count must be an integer from 0 to 2");
  }
  const P = resolveRegisteredProject(projectId);
  const current = readDoc(P.current);
  const identity = resolveCurrentIdentity(projectId);
  const job = findJob(identity);
  const observed = job ? observedState(job) : null;

  let result = null;
  if (fs.existsSync(P.result)) {
    try {
      const candidate = readDoc(P.result);
      if (
        String(candidate.meta.task_id || "") === String(current.meta.task_id || "") &&
        String(candidate.meta.handoff_revision || "") === String(current.meta.handoff_revision || "")
      ) {
        result = candidate;
      }
    } catch {}
  }

  const decision = await decideContinuation({
    projectId,
    current,
    result,
    job,
    observed,
    localDiagnosisComplete: diagnosisComplete === "true",
    transientUnavailableCount: unavailableCount,
    minConfidence: args["min-confidence"]
  });

  printJson({
    projectId,
    taskId: current.meta.task_id || null,
    revision: current.meta.handoff_revision || null,
    handoffStatus: current.meta.status || null,
    runnerState: job ? job.state || null : null,
    observedState: observed,
    ...decision
  });
}

const args = parseCliArgs(process.argv.slice(2));
const command = args._[0] || "";

try {
  if (command === "preflight") commandPreflight(args);
  else if (command === "submit") await commandSubmit(args);
  else if (command === "recover-code") commandRecoverCode(args);
  else if (command === "status") commandStatus(args);
  else if (command === "result") commandResult(args);
  else if (command === "resume") await commandResume(args);
  else if (command === "artifact-status") commandArtifactStatus(args);
  else if (command === "artifact-approve") commandArtifactApprove(args);
  else if (command === "decide") await commandDecide(args);
  else if (command === "jev-status") await commandJevStatus(args);
  else if (command === "jev-shadow") commandJevShadow(args);
  else fail("usage: runner.mjs <preflight|submit|recover-code|status|result|resume|artifact-status|artifact-approve|decide|jev-status|jev-shadow> [--project <id>] [options]");
} catch (err) {
  fail(String(err && err.message ? err.message : err));
}
