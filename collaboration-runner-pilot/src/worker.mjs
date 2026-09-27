import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  HANDOFF_ENGINE,
  appendWorkerLog,
  finalizeStage,
  parseCliArgs,
  readDoc,
  readJson,
  resolveRegisteredProject,
  recordFailure,
  updateJob,
  verifyResultAndReview,
  writeBounded
} from "./lib.mjs";
import { runFakeExecutor } from "./executors/fake.mjs";
import { runCodexExecutor } from "./executors/codex.mjs";
import { runLocalCopyExecutor, verifyLocalCopyMaterialization } from "./executors/local-copy.mjs";
import { captureProcessIdentity } from "./process-lifecycle.mjs";
import { materializeCodeResult } from "./code.mjs";
import { materializeNonCodeResult } from "./noncode.mjs";
import { decideContinuation } from "./jev.mjs";
import { runJevShadowSet } from "./jev-shadow.mjs";

function runHandoff(projectId, command, extra = []) {
  const args = [HANDOFF_ENGINE, "--project", projectId, command, ...extra];
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || "")
  };
}

function timeoutPromise(ms) {
  return new Promise((_, reject) => {
    const t = setTimeout(() => {
      const err = new Error("executor timed out after " + ms + " ms");
      err.code = "EXECUTOR_TIMEOUT";
      reject(err);
    }, ms);
  });
}

async function runExecutor(job, project, current) {
  const ctx = {
    job,
    project,
    current,
    timeoutMs: job.timeoutMs,
    timeoutPolicy: job.timeoutPolicy || {
      version: "legacy",
      launchTimeoutMs: null,
      idleObservationMs: null,
      maxRuntimeMs: job.timeoutMs
    },
    mode: job.fakeMode
  };
  ctx.onSpawn = (childPid, childProcessIdentity = null) => finalizeStage(job.jobFile, "executor_running", "WAIT_FOR_EXECUTOR", {
    childPid,
    childProcessIdentity,
    executorAlive: true,
    executorHeartbeatAt: new Date().toISOString()
  });
  ctx.onHeartbeat = (childPid) => {
    const at = new Date().toISOString();
    updateJob(job.jobFile, {
      childPid,
      executorAlive: true,
      executorHeartbeatAt: at,
      heartbeatAt: at
    });
  };
  ctx.onActivity = () => updateJob(job.jobFile, {
    lastActivityAt: new Date().toISOString()
  });
  ctx.onTransportActivity = ({ stream, at }) => updateJob(job.jobFile, {
    lastTransportActivityAt: at || new Date().toISOString(),
    lastTransportStream: stream || null
  });
  ctx.onProtocolStarted = ({ type, at }) => updateJob(job.jobFile, {
    protocolStartedAt: at || new Date().toISOString(),
    lastProgressAt: at || new Date().toISOString(),
    lastProgressType: type || null
  });
  ctx.onProgress = ({ type, at }) => updateJob(job.jobFile, {
    lastProgressAt: at || new Date().toISOString(),
    lastProgressType: type || null
  });
  ctx.onIdleObservation = ({ idleForMs, lastProgressAt }) => updateJob(job.jobFile, {
    idleObservationAt: new Date().toISOString(),
    idleForMs,
    lastProgressAt: lastProgressAt || job.lastProgressAt || null
  });
  ctx.onExecutorExit = ({ code, signal, pid }) => finalizeStage(
    job.jobFile,
    "executor_draining",
    "WAIT_FOR_STREAM_DRAIN",
    {
      childPid: pid,
      executorAlive: false,
      executorExitedAt: new Date().toISOString(),
      executorExitCodeObserved: code,
      executorSignalObserved: signal || null
    }
  );
  ctx.onReconciling = ({ pid, reason }) => finalizeStage(
    job.jobFile,
    "executor_reconciling",
    "WAIT_FOR_RECONCILIATION",
    {
      childPid: pid,
      executorAlive: null,
      reconciliationReason: reason || "timeout"
    }
  );
  ctx.onLivenessLost = ({ pid }) => finalizeStage(
    job.jobFile,
    "executor_reconciling",
    "WAIT_FOR_RECONCILIATION",
    {
      childPid: pid,
      executorAlive: null,
      reconciliationReason: "liveness_lost"
    }
  );

  if (job.executor === "fake") {
    return await Promise.race([runFakeExecutor(ctx), timeoutPromise(job.timeoutMs)]);
  }
  if (job.executor === "codex") {
    return await runCodexExecutor(ctx);
  }
  if (job.executor === "local_copy") {
    return await runLocalCopyExecutor(ctx);
  }
  throw new Error("unsupported executor: " + job.executor);
}

function snapshotResult(jobFile, project) {
  try {
    if (!fs.existsSync(project.result)) return null;
    const job = readJson(jobFile);
    const snapshot = path.join(job.jobDir, "RESULT.snapshot.md");
    fs.copyFileSync(project.result, snapshot);
    updateJob(jobFile, { resultSnapshot: snapshot });
    return snapshot;
  } catch {
    return null;
  }
}

function safeBlock(job, reason) {
  try {
    const P = resolveRegisteredProject(job.projectId);
    const current = readDoc(P.current);
    if (
      String(current.meta.status) === "IN_PROGRESS" &&
      String(current.meta.task_id) === job.taskId &&
      String(current.meta.handoff_revision) === job.revision
    ) {
      const r = runHandoff(job.projectId, "block", ["--reason", String(reason).slice(0, 800)]);
      return {
        attempted: true,
        ok: r.ok,
        stdout: r.stdout.slice(-4000),
        stderr: r.stderr.slice(-4000)
      };
    }
  } catch (err) {
    return { attempted: true, ok: false, error: String(err && err.message ? err.message : err) };
  }
  return { attempted: false, ok: false };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const jobFile = String(args["job-file"] || "");
  if (!jobFile || !fs.existsSync(jobFile)) {
    process.exitCode = 2;
    return;
  }

  let job = readJson(jobFile);
  let shadowCurrent = null;
  let shadowExecutorResult = null;
  appendWorkerLog(jobFile, "worker started pid=" + process.pid);
  const workerHeartbeat = setInterval(() => {
    try {
      updateJob(jobFile, { workerHeartbeatAt: new Date().toISOString() });
    } catch {}
  }, 15000);
  if (workerHeartbeat.unref) workerHeartbeat.unref();

  try {
    const workerStartedAt = new Date().toISOString();
    updateJob(jobFile, {
      workerPid: process.pid,
      workerProcessIdentity: captureProcessIdentity(process.pid),
      writerFence: "active",
      workerStartedAt,
      workerHeartbeatAt: workerStartedAt
    });

    const project = resolveRegisteredProject(job.projectId);

    const pre = readDoc(project.current);
    shadowCurrent = pre;
    if (
      String(pre.meta.task_id) !== job.taskId ||
      String(pre.meta.handoff_revision) !== job.revision ||
      String(pre.meta.status) !== "READY"
    ) {
      throw Object.assign(new Error("handoff identity/status changed before claim"), { code: "CLAIM_BLOCKED" });
    }

    const claim = runHandoff(job.projectId, "claim");
    if (!claim.ok) {
      updateJob(jobFile, {
        state: "BLOCKED",
        writerFence: "reconciled",
        endedAt: new Date().toISOString(),
        failureKind: "claim_failed",
        failureMessage: (claim.stderr || claim.stdout).slice(-8000),
        claimOutput: claim.stdout.slice(-8000)
      });
      appendWorkerLog(jobFile, "claim failed; worker will not clear project lock");
      return;
    }

    job = updateJob(jobFile, {
      state: "RUNNING",
      claimedAt: new Date().toISOString(),
      claimOutput: claim.stdout.slice(-8000),
      handoffState: "IN_PROGRESS"
    });
    appendWorkerLog(jobFile, "handoff claimed by worker");
    finalizeStage(jobFile, "claimed", "START_EXECUTOR", { autoConsumed: true });

    const current = readDoc(project.current);
    shadowCurrent = current;
    const executorStartedAt = new Date().toISOString();
    updateJob(jobFile, {
      executorStartedAt,
      checkpoint: {
        phase: "executor_started",
        recordedAt: executorStartedAt,
        taskId: job.taskId,
        revision: job.revision,
        worktree: job.taskType === "code" ? (current.meta.codex_worktree || null) : null
      }
    });

    let result;
    try {
      result = await runExecutor(job, project, current);
      shadowExecutorResult = result;
    } catch (err) {
      const launchTimedOut = err && err.code === "EXECUTOR_LAUNCH_TIMEOUT";
      const maxRuntimeTimedOut = err && err.code === "EXECUTOR_MAX_RUNTIME";
      const legacyTimedOut = err && err.code === "EXECUTOR_TIMEOUT";
      const timedOut = launchTimedOut || maxRuntimeTimedOut || legacyTimedOut;
      const lifecycleUnknown = err && err.code === "EXECUTOR_LIFECYCLE_UNKNOWN";
      const quotaPaused = err && err.code === "EXECUTOR_QUOTA";

      if (err && err.stdout !== undefined) writeBounded(job.executorStdout, err.stdout);
      if (err && err.stderr !== undefined) writeBounded(job.executorStderr, err.stderr);

      const failureKind = quotaPaused
        ? "quota"
        : (launchTimedOut
          ? "executor_launch_timeout"
          : ((maxRuntimeTimedOut || legacyTimedOut)
            ? "executor_max_runtime"
            : (lifecycleUnknown ? "executor_lifecycle_unknown" : "executor_error")));

      const reason = quotaPaused
        ? "executor quota pause"
        : (launchTimedOut
          ? "executor launch timeout"
          : ((maxRuntimeTimedOut || legacyTimedOut)
            ? "executor max runtime reached"
            : (lifecycleUnknown
              ? "executor lifecycle unknown: " + String(err.message || err)
              : "executor failure: " + String(err.message || err))));

      // UNKNOWN is intentionally not passed through handoff block: blocking would
      // release the project lock even though the old writer may still exist.
      const block = lifecycleUnknown
        ? { attempted: false, ok: false, reason: "UNKNOWN keeps existing handoff lock for reconciliation" }
        : safeBlock(job, reason);

      snapshotResult(jobFile, project);
      updateJob(jobFile, {
        state: quotaPaused ? "PAUSED_QUOTA" : (timedOut ? "TIMED_OUT" : (lifecycleUnknown ? "UNKNOWN" : "FAILED")),
        writerFence: lifecycleUnknown ? "uncertain" : "reconciled",
        checkpoint: quotaPaused ? {
          phase: "quota_paused",
          recordedAt: new Date().toISOString(),
          taskId: job.taskId,
          revision: job.revision,
          worktree: job.taskType === "code" ? (current.meta.codex_worktree || null) : null,
          resumeRule: "create a new handoff revision; do not auto-retry this job"
        } : job.checkpoint,
        handoffState: lifecycleUnknown ? "IN_PROGRESS" : (block.ok ? "BLOCKED" : "IN_PROGRESS"),
        executorEndedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        failureKind,
        failureMessage: String(err && err.message ? err.message : err).slice(0, 8000),
        childPid: err && err.childPid ? err.childPid : undefined,
        executorAlive: lifecycleUnknown ? null : false,
        timeoutPolicy: err && err.timeoutPolicy ? err.timeoutPolicy : job.timeoutPolicy,
        termination: err && err.termination ? err.termination : undefined,
        blockResult: block
      });

      recordFailure(jobFile, failureKind, String(err && err.message ? err.message : err));
      if (lifecycleUnknown) {
        updateJob(jobFile, { nextAction: "RECONCILE_PROCESS_OWNERSHIP" });
      } else if (timedOut) {
        updateJob(jobFile, { nextAction: "CHATGPT_LOCAL_DIAGNOSIS" });
      } else if (quotaPaused) {
        updateJob(jobFile, { nextAction: "CHATGPT_LOCAL_DIAGNOSIS" });
      }
      appendWorkerLog(jobFile, quotaPaused
        ? "executor paused for quota"
        : (launchTimedOut
          ? "executor launch timeout"
          : ((maxRuntimeTimedOut || legacyTimedOut)
            ? "executor max runtime reached"
            : (lifecycleUnknown ? "executor lifecycle became UNKNOWN" : "executor failed"))));
      return;
    }

    writeBounded(job.executorStdout, result.stdout || "");
    writeBounded(job.executorStderr, result.stderr || "");
    job = updateJob(jobFile, {
      executorEndedAt: new Date().toISOString(),
      executorAlive: false,
      executorExitCode: result.exitCode,
      executorSignal: result.signal || null,
      childPid: result.childPid || null,
      modelRequested: result.modelRequested || job.modelRequested || null,
      codexSource: result.codexRuntime ? result.codexRuntime.source : (job.codexSource || null),
      codexVersion: result.codexRuntime ? result.codexRuntime.version : (job.codexVersion || null),
      codexJs: result.codexRuntime ? result.codexRuntime.codexJs : (job.codexJs || null),
      commandEvidence: result.commandEvidence || null
    });

    if (result.exitCode !== 0) {
      const detailSource = String(result.stderr || result.stdout || "").trim();
      const detail = detailSource ? detailSource.slice(-4000) : "no executor error text";
      const failureMessage = "executor exit code " + result.exitCode + ": " + detail;
      const block = safeBlock(job, failureMessage);
      snapshotResult(jobFile, project);
      updateJob(jobFile, {
        state: "FAILED",
        writerFence: "reconciled",
        handoffState: block.ok ? "BLOCKED" : "IN_PROGRESS",
        endedAt: new Date().toISOString(),
        failureKind: "nonzero_exit",
        failureMessage,
        blockResult: block
      });
      recordFailure(jobFile, "nonzero_exit", failureMessage);
      appendWorkerLog(jobFile, "executor exited non-zero");
      return;
    }

    if (
      result.structuredResult &&
      job.taskType === "non_code" &&
      /^BLOCKED\b/i.test(String(result.structuredResult.completion_basis || "").trim())
    ) {
      const reason = String(result.structuredResult.completion_basis || "Codex reported BLOCKED").slice(0, 800);
      const block = safeBlock(job, reason);
      snapshotResult(jobFile, project);
      updateJob(jobFile, {
        state: "BLOCKED",
        writerFence: "reconciled",
        handoffState: block.ok ? "BLOCKED" : "IN_PROGRESS",
        endedAt: new Date().toISOString(),
        failureKind: "executor_reported_blocked",
        failureMessage: reason,
        blockResult: block
      });
      appendWorkerLog(jobFile, "executor reported BLOCKED; success rejected");
      return;
    }

    if (result.structuredResult) {
      try {
        if (job.taskType === "non_code") {
          const materialized = materializeNonCodeResult({
            job,
            project,
            current,
            structured: result.structuredResult,
            codexRuntime: result.codexRuntime
          });
          const localCopyVerification = job.executor === "local_copy"
            ? verifyLocalCopyMaterialization(result.localCopyPlan)
            : null;
          job = updateJob(jobFile, {
            structuredResultMaterialized: true,
            deliverablePaths: materialized.deliverablePaths,
            localCopyVerification
          });
          appendWorkerLog(
            jobFile,
            job.executor === "local_copy"
              ? "deterministic local-copy output materialized and SHA-256 verified by parent worker"
              : "structured non-code output materialized by parent worker"
          );
        } else if (job.taskType === "code") {
          const materialized = materializeCodeResult({
            job,
            project,
            current,
            structured: result.structuredResult,
            codexRuntime: result.codexRuntime
          });
          job = updateJob(jobFile, {
            structuredResultMaterialized: true,
            resultCommit: materialized.commit,
            changedFiles: materialized.changedFiles
          });
          appendWorkerLog(jobFile, "structured code output verified and RESULT materialized by parent worker");
        }
      } catch (err) {
        const kind = job.taskType === "code" ? "structured code" : "structured non-code";
        const block = safeBlock(job, kind + " materialization failed: " + String(err.message || err));
        snapshotResult(jobFile, project);
        updateJob(jobFile, {
          state: "FAILED",
          writerFence: "reconciled",
          handoffState: block.ok ? "BLOCKED" : "IN_PROGRESS",
          endedAt: new Date().toISOString(),
          failureKind: "structured_materialization",
          failureMessage: String(err && err.message ? err.message : err).slice(0, 8000),
          blockResult: block
        });
        recordFailure(jobFile, "structured_materialization", String(err && err.message ? err.message : err));
        appendWorkerLog(jobFile, kind + " materialization failed");
        return;
      }
    }

    if (!fs.existsSync(project.result)) {
      const block = safeBlock(job, "executor exited 0 but RESULT.md is missing");
      snapshotResult(jobFile, project);
      updateJob(jobFile, {
        state: "FAILED",
        writerFence: "reconciled",
        handoffState: block.ok ? "BLOCKED" : "IN_PROGRESS",
        endedAt: new Date().toISOString(),
        failureKind: "pseudo_success",
        failureMessage: "executor exit 0 but RESULT.md is missing",
        blockResult: block
      });
      appendWorkerLog(jobFile, "pseudo-success rejected: RESULT missing");
      return;
    }

    const resultDoc = readDoc(project.result);
    if (
      String(resultDoc.meta.task_id || "") !== job.taskId ||
      String(resultDoc.meta.handoff_revision || "") !== job.revision
    ) {
      const block = safeBlock(job, "executor RESULT identity/revision mismatch");
      snapshotResult(jobFile, project);
      updateJob(jobFile, {
        state: "FAILED",
        writerFence: "reconciled",
        handoffState: block.ok ? "BLOCKED" : "IN_PROGRESS",
        endedAt: new Date().toISOString(),
        failureKind: "pseudo_success",
        failureMessage: "RESULT task_id/revision mismatch",
        blockResult: block
      });
      appendWorkerLog(jobFile, "pseudo-success rejected: RESULT identity mismatch");
      return;
    }

    const returned = runHandoff(job.projectId, "return");
    if (!returned.ok) {
      const block = safeBlock(job, "handoff return validation failed");
      snapshotResult(jobFile, project);
      updateJob(jobFile, {
        state: "FAILED",
        writerFence: "reconciled",
        handoffState: block.ok ? "BLOCKED" : "IN_PROGRESS",
        endedAt: new Date().toISOString(),
        failureKind: "return_failed",
        failureMessage: (returned.stderr || returned.stdout).slice(-8000),
        returnOutput: returned.stdout.slice(-8000),
        blockResult: block
      });
      appendWorkerLog(jobFile, "handoff return failed");
      return;
    }

    job = updateJob(jobFile, {
      returnOutput: returned.stdout.slice(-8000),
      handoffState: "REVIEW"
    });
    finalizeStage(jobFile, "returned", "VERIFY_RESULT", { autoConsumed: true });

    const verified = verifyResultAndReview(job);
    if (!verified.ok) {
      updateJob(jobFile, {
        state: "FAILED",
        writerFence: "reconciled",
        endedAt: new Date().toISOString(),
        failureKind: "post_return_verification",
        failureMessage: verified.problems.join("; ")
      });
      appendWorkerLog(jobFile, "post-return verification failed");
      return;
    }

    const resultSnapshot = snapshotResult(jobFile, project);
    const reviewCurrent = readDoc(project.current);
    const reviewResult = readDoc(project.result);
    const continuation = await decideContinuation({
      projectId: job.projectId,
      current: reviewCurrent,
      result: reviewResult,
      job: { ...readJson(jobFile), state: "SUCCEEDED" },
      observed: "SUCCEEDED"
    });
    const autoContinue = continuation.decision === "AUTO_CONTINUE";
    const nextAction = continuation.nextAction || (
      autoContinue ? "CHATGPT_LOCAL_REVIEW" :
      continuation.decision === "NEED_MORE_INFO" ? "WAIT_FOR_REQUIRED_INFO" :
      continuation.decision === "BLOCKED" ? "STOP_BLOCKED" :
      "WAIT_FOR_HUMAN_REVIEW"
    );

    updateJob(jobFile, {
      state: "SUCCEEDED",
      writerFence: "reconciled",
      endedAt: new Date().toISOString(),
      handoffState: "REVIEW",
      resultPath: project.result,
      resultSnapshot,
      continuationDecision: continuation,
      autoContinue,
      workflowBlocked: continuation.workflowBlocked === true,
      requiresUserInput: continuation.requiresUserInput === true,
      mustReturnCheckpoint: continuation.mustReturnCheckpoint === true,
      checkpointReason: continuation.checkpointReason || null
    });
    finalizeStage(jobFile, "completed", nextAction, {
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
    appendWorkerLog(
      jobFile,
      "job succeeded and continuation gate decided " + continuation.decision + " -> " + nextAction
    );
  } catch (err) {
    let jobNow;
    try { jobNow = readJson(jobFile); } catch { jobNow = job; }
    if (jobNow && jobNow.state === "RUNNING") {
      const block = safeBlock(jobNow, "worker exception: " + String(err.message || err));
      snapshotResult(jobFile, resolveRegisteredProject(jobNow.projectId));
      updateJob(jobFile, {
        state: "FAILED",
        handoffState: block.ok ? "BLOCKED" : "IN_PROGRESS",
        endedAt: new Date().toISOString(),
        failureKind: "worker_exception",
        failureMessage: String(err && err.stack ? err.stack : err).slice(-12000),
        blockResult: block
      });
    } else {
      updateJob(jobFile, {
        state: err && err.code === "CLAIM_BLOCKED" ? "BLOCKED" : "FAILED",
        endedAt: new Date().toISOString(),
        failureKind: err && err.code === "CLAIM_BLOCKED" ? "claim_blocked" : "worker_exception",
        failureMessage: String(err && err.stack ? err.stack : err).slice(-12000)
      });
    }
    appendWorkerLog(jobFile, "worker exception: " + String(err && err.message ? err.message : err));
  } finally {
    clearInterval(workerHeartbeat);
    try {
      const terminalJob = readJson(jobFile);
      const terminalStates = new Set([
        "SUCCEEDED", "FAILED", "BLOCKED", "TIMED_OUT", "PAUSED_QUOTA", "UNKNOWN"
      ]);
      if (shadowCurrent && terminalStates.has(String(terminalJob.state || ""))) {
        let shadowResultDoc = null;
        try {
          const project = resolveRegisteredProject(terminalJob.projectId);
          if (fs.existsSync(project.result)) {
            const candidate = readDoc(project.result);
            if (
              String(candidate.meta.task_id || "") === String(terminalJob.taskId || "") &&
              String(candidate.meta.handoff_revision || "") === String(terminalJob.revision || "")
            ) {
              shadowResultDoc = candidate;
            }
          }
        } catch {}

        const shadow = await runJevShadowSet({
          jobFile,
          current: shadowCurrent,
          executorResult: shadowExecutorResult,
          resultDoc: shadowResultDoc
        });
        if (shadow.enabled) {
          appendWorkerLog(jobFile, "Jev shadow recorded " + shadow.events.length + " advisory decisions");
        }
      }
    } catch (shadowErr) {
      try {
        appendWorkerLog(jobFile, "Jev shadow failed safely: " + String(shadowErr && shadowErr.message ? shadowErr.message : shadowErr));
      } catch {}
    }
  }
}

await main();
