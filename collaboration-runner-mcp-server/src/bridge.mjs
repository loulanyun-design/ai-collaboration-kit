import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_RUNNER_ROOT = "D:\\MCP-Test\\collaboration-runner-pilot";
const PROJECT_ID_RE = /^[A-Za-z0-9._-]+$/;
const JOB_ID_RE = /^[0-9a-f]{32}$/;

export function runnerRoot() {
  return path.resolve(process.env.COLLAB_RUNNER_ROOT || DEFAULT_RUNNER_ROOT);
}

export function runnerScript() {
  return path.join(runnerRoot(), "src", "runner.mjs");
}

export function assertProjectId(value) {
  const project = String(value || "");
  if (!PROJECT_ID_RE.test(project)) {
    throw new Error("project must match [A-Za-z0-9._-]+");
  }
  return project;
}

export function assertJobId(value) {
  const job = String(value || "");
  if (!JOB_ID_RE.test(job)) {
    throw new Error("job must be a 32-character lowercase hex id");
  }
  return job;
}

export function assertModelRoute(value) {
  if (value === undefined || value === null || value === "") return null;
  const route = String(value);
  if (!["retrieval", "execution", "escalation"].includes(route)) {
    throw new Error("model_route must be retrieval, execution, or escalation");
  }
  return route;
}

export function parseRunnerJson(text) {
  const source = String(text || "").trim();
  if (!source) throw new Error("runner returned empty stdout");
  try {
    return JSON.parse(source);
  } catch (err) {
    throw new Error("runner returned non-JSON output: " + err.message);
  }
}

export function parseRunnerResult(text) {
  const marker = "\n--- RESULT.md ---\n";
  const source = String(text || "");
  const index = source.indexOf(marker);
  if (index < 0) {
    throw new Error("runner result output is missing RESULT marker");
  }
  return {
    job: parseRunnerJson(source.slice(0, index)),
    resultMarkdown: source.slice(index + marker.length)
  };
}

export async function runRunnerCli(argv, { timeoutMs = 60000 } = {}) {
  const script = runnerScript();
  if (!fs.existsSync(script)) throw new Error("runner entry not found: " + script);

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...argv], {
      cwd: runnerRoot(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        COLLAB_RUNNER_MCP: "1"
      }
    });

    let stdout = "";
    let stderr = "";
    const maxBytes = 2 * 1024 * 1024;

    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxBytes) {
        throw new Error("runner output exceeded 2 MiB safety limit");
      }
      return next;
    };

    let settled = false;
    let timer = null;
    let terminationTimer = null;
    let timeoutError = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (terminationTimer) clearTimeout(terminationTimer);
      fn(value);
    };

    child.stdout.on("data", (chunk) => {
      try { stdout = append(stdout, chunk); }
      catch (err) {
        child.kill();
        finish(reject, err);
      }
    });
    child.stderr.on("data", (chunk) => {
      try { stderr = append(stderr, chunk); }
      catch (err) {
        child.kill();
        finish(reject, err);
      }
    });
    child.on("error", (err) => finish(reject, err));
    child.on("close", (code) => {
      if (timeoutError) {
        finish(reject, timeoutError);
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || ("exit " + code);
        finish(reject, new Error(detail));
        return;
      }
      finish(resolve, { stdout, stderr, code });
    });

    timer = setTimeout(() => {
      const err = new Error("runner CLI timed out after " + timeoutMs + "ms");
      err.code = "RUNNER_CLI_TIMEOUT";
      err.timeoutMs = timeoutMs;
      err.stdout = stdout;
      err.stderr = stderr;
      err.childPid = child.pid;
      timeoutError = err;

      try { child.kill(); } catch {}
      // Prefer the real close event so the short-lived CLI process does not
      // linger after the transport has already reported an ambiguous outcome.
      terminationTimer = setTimeout(() => {
        finish(reject, err);
      }, 2000);
      terminationTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function preflight(projectValue, { timeoutMs = 30000 } = {}) {
  const project = assertProjectId(projectValue);
  const out = await runRunnerCli(["preflight", "--project", project], { timeoutMs });
  return parseRunnerJson(out.stdout);
}

export async function submit({ project: projectValue, model_route }, { timeoutMs = 60000 } = {}) {
  const project = assertProjectId(projectValue);
  const route = assertModelRoute(model_route);
  const args = ["submit", "--project", project];
  if (route) args.push("--model-route", route);

  try {
    const out = await runRunnerCli(args, { timeoutMs });
    return parseRunnerJson(out.stdout);
  } catch (err) {
    if (err && err.code === "RUNNER_CLI_TIMEOUT") {
      return {
        ok: false,
        projectId: project,
        primaryFailureKind: "SUBMISSION_OUTCOME_UNKNOWN",
        executorLaunchState: "UNKNOWN",
        readyForNewLaunch: false,
        nextAction: "RECONCILE_EXISTING_JOB",
        diagnostic: "Runner submit response deadline expired. Query runner_resume/status for the same project identity before any new submit.",
        cliTimeoutMs: err.timeoutMs || timeoutMs
      };
    }
    throw err;
  }
}

export async function status({ project: projectValue, job: jobValue } = {}) {
  const args = ["status"];
  if (jobValue) {
    args.push("--job", assertJobId(jobValue));
  } else {
    args.push("--project", assertProjectId(projectValue));
  }
  const out = await runRunnerCli(args, { timeoutMs: 30000 });
  return parseRunnerJson(out.stdout);
}

export async function result({ project: projectValue, job: jobValue } = {}) {
  const args = ["result"];
  if (jobValue) {
    args.push("--job", assertJobId(jobValue));
  } else {
    args.push("--project", assertProjectId(projectValue));
  }
  const out = await runRunnerCli(args, { timeoutMs: 30000 });
  return parseRunnerResult(out.stdout);
}

export async function resume({ project: projectValue, diagnosis_complete, unavailable_count }) {
  const project = assertProjectId(projectValue);
  const args = ["resume", "--project", project];
  if (diagnosis_complete !== undefined) {
    if (typeof diagnosis_complete !== "boolean") throw new Error("diagnosis_complete must be boolean");
    args.push("--diagnosis-complete", String(diagnosis_complete));
  }
  if (unavailable_count !== undefined) {
    if (!Number.isInteger(unavailable_count) || unavailable_count < 0 || unavailable_count > 2) {
      throw new Error("unavailable_count must be an integer from 0 to 2");
    }
    args.push("--unavailable-count", String(unavailable_count));
  }
  const out = await runRunnerCli(args, { timeoutMs: 60000 });
  return parseRunnerJson(out.stdout);
}
