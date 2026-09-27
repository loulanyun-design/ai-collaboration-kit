import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appendBounded, boundedText, COLLAB_ROOT, PILOT_ROOT, ROOT_RULES } from "../lib.mjs";
import { captureProcessIdentity, waitForChildTerminal } from "../process-lifecycle.mjs";
import { buildCodePrompt, buildCodeSchema } from "../code.mjs";
import { buildNonCodePrompt, buildNonCodeSchema } from "../noncode.mjs";
import { modelForRoute, resolveModelRoute } from "../model-policy.mjs";

export const REQUIRED_MODEL = "gpt-6-astra";
export const ISOLATED_CODEX_VERSION = "0.155.1";

function parseVersion(version) {
  const m = String(version || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersion(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av || !bv) return null;
  for (let i = 0; i < 3; i++) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

function readPackageRuntime(root, source) {
  const packageJson = path.join(root, "node_modules", "@openai", "codex", "package.json");
  const codexJs = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!fs.existsSync(packageJson) || !fs.existsSync(codexJs)) return null;
  const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
  return {
    source,
    version: String(pkg.version || ""),
    codexJs
  };
}

export function resolveCodexRuntime() {
  const isolatedRoot = path.join(PILOT_ROOT, ".tools", "codex");
  const isolated = readPackageRuntime(isolatedRoot, "isolated");
  if (!isolated) {
    throw new Error(
      "Pinned isolated Codex CLI is missing. Install exactly " +
      ISOLATED_CODEX_VERSION + " with: npm run install:codex-cli"
    );
  }
  if (isolated.version !== ISOLATED_CODEX_VERSION) {
    throw new Error(
      "Pinned isolated Codex CLI version mismatch: expected " +
      ISOLATED_CODEX_VERSION + ", found " + isolated.version
    );
  }
  return isolated;
}

export function resolveCodexJs() {
  return resolveCodexRuntime().codexJs;
}

export function childEnvironment(baseEnv = process.env) {
  const appData = baseEnv.APPDATA;
  const shimDir = appData ? path.resolve(appData, "npm").toLowerCase() : "";
  const pathValue = String(baseEnv.PATH || baseEnv.Path || "");
  const filteredPath = pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => path.resolve(entry).toLowerCase() !== shimDir)
    .join(path.delimiter);

  return {
    ...baseEnv,
    PATH: filteredPath,
    Path: filteredPath,
    COLLAB_RUNNER_CHILD: "1"
  };
}

export async function runCodexExecutor(ctx) {
  const runtime = resolveCodexRuntime();
  const cwd = ctx.job.taskType === "code" ? ctx.current.meta.codex_worktree : ctx.project.root;
  if (!cwd || !fs.existsSync(cwd)) throw new Error("Codex working directory does not exist: " + cwd);

  const isNonCode = ctx.job.taskType === "non_code";
  const modelRoute = resolveModelRoute(ctx.job.modelRoute);
  const requestedModel = modelForRoute(modelRoute);
  let schemaPath = null;
  let finalMessagePath = null;
  let prompt = null;

  const args = [
    runtime.codexJs,
    "exec",
    "--ignore-user-config",
    "-m", requestedModel,
    "--ephemeral",
    "--json",
    "-C", cwd
  ];

  if (isNonCode) {
    args.push("--skip-git-repo-check", "-s", "read-only");
  } else {
    // --approve-for-me already routes approvals through automatic review
    // using the workspace-write sandbox. Codex 0.155.1 rejects combining
    // it with an explicit --sandbox argument.
    args.push("--approve-for-me");
  }

  schemaPath = path.join(ctx.job.jobDir, "codex-output.schema.json");
  finalMessagePath = path.join(ctx.job.jobDir, "codex-final.json");

  if (isNonCode) {
    fs.writeFileSync(
      schemaPath,
      JSON.stringify(buildNonCodeSchema({ ...ctx, rootRules: ROOT_RULES }), null, 2) + "\n",
      "utf8"
    );
    args.push("--output-schema", schemaPath, "-o", finalMessagePath);
    prompt = buildNonCodePrompt({ ...ctx, rootRules: ROOT_RULES });
  } else {
    fs.writeFileSync(
      schemaPath,
      JSON.stringify(buildCodeSchema({ ...ctx, rootRules: ROOT_RULES }), null, 2) + "\n",
      "utf8"
    );
    args.push("--output-schema", schemaPath, "-o", finalMessagePath);
    prompt = buildCodePrompt({ ...ctx, rootRules: ROOT_RULES });
  }

  args.push("-");

  const env = {
    ...childEnvironment(process.env),
    COLLAB_RUNNER_JOB_ID: ctx.job.jobId,
    COLLAB_RUNNER_TASK_ID: ctx.job.taskId,
    COLLAB_RUNNER_REVISION: ctx.job.revision
  };

  fs.writeFileSync(ctx.job.executorStdout, "", "utf8");
  fs.writeFileSync(ctx.job.executorStderr, "", "utf8");

  const child = spawn(process.execPath, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const processIdentity = captureProcessIdentity(child.pid);
  if (ctx.onSpawn) ctx.onSpawn(child.pid, processIdentity);

  let stdout = "";
  let stderr = "";
  let stdoutLineBuffer = "";
  let protocolStarted = false;
  let lastProgressAt = null;

  const observeCodexEvent = (line) => {
    const text = String(line || "").trim();
    if (!text) return;
    let event;
    try { event = JSON.parse(text); } catch { return; }
    const type = String(event && event.type || "");
    if (!type) return;

    const at = new Date().toISOString();
    if (type === "thread.started" || type === "turn.started") {
      if (!protocolStarted) {
        protocolStarted = true;
        if (ctx.onProtocolStarted) ctx.onProtocolStarted({ type, at });
      }
    }
    if (type !== "error") {
      lastProgressAt = at;
      if (ctx.onProgress) ctx.onProgress({ type, at });
    }
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = boundedText(stdout + chunk);
    try { appendBounded(ctx.job.executorStdout, chunk); } catch {}
    const at = new Date().toISOString();
    if (ctx.onTransportActivity) ctx.onTransportActivity({ stream: "stdout", at });
    if (ctx.onActivity) ctx.onActivity("stdout");

    stdoutLineBuffer += chunk;
    let newline;
    while ((newline = stdoutLineBuffer.indexOf("\n")) >= 0) {
      const line = stdoutLineBuffer.slice(0, newline);
      stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1);
      observeCodexEvent(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = boundedText(stderr + chunk);
    try { appendBounded(ctx.job.executorStderr, chunk); } catch {}
    const at = new Date().toISOString();
    if (ctx.onTransportActivity) ctx.onTransportActivity({ stream: "stderr", at });
    if (ctx.onActivity) ctx.onActivity("stderr");
  });

  child.stdin.end(prompt);

  const timeoutPolicy = ctx.timeoutPolicy || {
    version: "legacy",
    launchTimeoutMs: null,
    idleObservationMs: null,
    maxRuntimeMs: ctx.timeoutMs
  };

  const terminal = await waitForChildTerminal({
    child,
    timeoutMs: timeoutPolicy.maxRuntimeMs,
    launchTimeoutMs: timeoutPolicy.launchTimeoutMs,
    idleObservationMs: timeoutPolicy.idleObservationMs,
    identity: processIdentity,
    isProtocolStarted: () => protocolStarted,
    getLastProgressAt: () => lastProgressAt,
    onHeartbeat: ({ pid }) => {
      if (ctx.onHeartbeat) ctx.onHeartbeat(pid);
    },
    onIdleObservation: (info) => {
      if (ctx.onIdleObservation) ctx.onIdleObservation(info);
    },
    onExit: (info) => {
      if (ctx.onExecutorExit) ctx.onExecutorExit(info);
    },
    onReconciling: (info) => {
      if (ctx.onReconciling) ctx.onReconciling(info);
    },
    onLivenessLost: (info) => {
      if (ctx.onLivenessLost) ctx.onLivenessLost(info);
    }
  });

  if (terminal.kind === "error") {
    const err = terminal.error instanceof Error ? terminal.error : new Error(String(terminal.error || "executor spawn error"));
    err.stdout = stdout;
    err.stderr = stderr;
    err.childPid = child.pid;
    err.codexRuntime = runtime;
    throw err;
  }

  if (terminal.kind === "launch_timeout" || terminal.kind === "max_runtime") {
    const isLaunch = terminal.kind === "launch_timeout";
    const limit = isLaunch ? timeoutPolicy.launchTimeoutMs : timeoutPolicy.maxRuntimeMs;
    const err = new Error(
      "Codex executor " + (isLaunch ? "launch" : "max runtime") +
      " deadline reached after " + limit + " ms; owned process tree termination verified"
    );
    err.code = isLaunch ? "EXECUTOR_LAUNCH_TIMEOUT" : "EXECUTOR_MAX_RUNTIME";
    err.stdout = stdout;
    err.stderr = stderr;
    err.childPid = child.pid;
    err.codexRuntime = runtime;
    err.timeoutPolicy = timeoutPolicy;
    err.termination = terminal.termination || null;
    throw err;
  }

  if (terminal.kind === "unknown") {
    const err = new Error("Codex executor lifecycle could not be reconciled: " + String(terminal.reason || "unknown lifecycle state"));
    err.code = "EXECUTOR_LIFECYCLE_UNKNOWN";
    err.stdout = stdout;
    err.stderr = stderr;
    err.childPid = child.pid;
    err.codexRuntime = runtime;
    err.termination = terminal.termination || null;
    throw err;
  }

  const exit = { code: terminal.code, signal: terminal.signal };

  let structuredResult = null;
  if (exit.code === 0) {
    if (!finalMessagePath || !fs.existsSync(finalMessagePath)) {
      const err = new Error("Codex final structured output file is missing");
      err.code = "EXECUTOR_OUTPUT_INVALID";
      err.stdout = stdout;
      err.stderr = stderr;
      err.childPid = child.pid;
      err.codexRuntime = runtime;
      throw err;
    }
    try {
      structuredResult = JSON.parse(fs.readFileSync(finalMessagePath, "utf8"));
    } catch (parseErr) {
      const err = new Error("Codex final output is not valid JSON: " + parseErr.message);
      err.code = "EXECUTOR_OUTPUT_INVALID";
      err.stdout = stdout;
      err.stderr = stderr;
      err.childPid = child.pid;
      err.codexRuntime = runtime;
      throw err;
    }
  }

  return {
    exitCode: exit.code === null ? 1 : exit.code,
    signal: exit.signal || null,
    stdout,
    stderr,
    childPid: child.pid,
    modelRequested: requestedModel,
    modelRoute,
    codexRuntime: runtime,
    structuredResult,
    commandEvidence: {
      node: process.execPath,
      codexSource: runtime.source,
      codexVersion: runtime.version,
      codexJs: runtime.codexJs,
      args: args.slice(1, -1),
      promptViaStdin: true,
      nonCodeStructuredMode: isNonCode,
      codeStructuredMode: !isNonCode,
      approveForMe: !isNonCode,
      outputSchemaPath: schemaPath,
      outputLastMessagePath: finalMessagePath,
      shell: false,
      windowsHide: true
    }
  };
}
