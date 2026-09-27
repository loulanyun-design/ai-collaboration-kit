import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { appendBounded } from "../src/lib.mjs";
import {
  captureProcessIdentity,
  processIsAlive,
  terminateOwnedProcessTree,
  waitForChildTerminal
} from "../src/process-lifecycle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PILOT = path.resolve(HERE, "..");
const TMP = path.join(PILOT, "test-tmp", "executor-lifecycle-" + process.pid);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnNode(source) {
  return spawn(process.execPath, ["-e", source], {
    cwd: PILOT,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function exactKill(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(exe, ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 5000
    });
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

function descendantPid(text) {
  const m = String(text || "").match(/DESC=(\d+)/);
  return m ? Number(m[1]) : null;
}

test("exit without close is bounded even while inherited-like pipes stay open", { concurrency: false }, async () => {
  const sleeper = spawnNode('setInterval(()=>{},1000)');
  const child = new EventEmitter();
  child.pid = sleeper.pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (...args) => sleeper.kill(...args);

  const started = Date.now();
  setTimeout(() => child.emit("exit", 0, null), 120);
  const result = await waitForChildTerminal({
    child,
    timeoutMs: 2500,
    drainMs: 250,
    heartbeatMs: 50
  });
  const elapsed = Date.now() - started;

  try {
    assert.equal(result.kind, "exit");
    assert.equal(result.code, 0);
    assert.equal(result.closeObserved, false);
    assert.equal(result.drainTimedOut, true);
    assert.ok(elapsed < 1500, "exit should be bounded by drain timeout, elapsed=" + elapsed);
    assert.equal(processIsAlive(sleeper.pid), true, "open descendant-like process should not block terminalization");
  } finally {
    exactKill(sleeper.pid);
  }
});

test("timeout terminates the owned Windows process tree and preserves partial logs", { concurrency: false }, async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const stdoutFile = path.join(TMP, "timeout.stdout.log");
  const stderrFile = path.join(TMP, "timeout.stderr.log");
  fs.writeFileSync(stdoutFile, "", "utf8");
  fs.writeFileSync(stderrFile, "", "utf8");

  const script = [
    'const {spawn}=require("node:child_process");',
    'const c=spawn(process.execPath,["-e","process.stdout.write(\\\"CHILD_OUT\\\\n\\\");process.stderr.write(\\\"CHILD_ERR\\\\n\\\");setInterval(()=>{},1000)"],{stdio:["ignore",process.stdout,process.stderr]});',
    'console.log("DESC="+c.pid);',
    'console.log("ROOT_OUT");',
    'console.error("ROOT_ERR");',
    'setInterval(()=>{},1000);'
  ].join("");

  const child = spawnNode(script);
  const identity = captureProcessIdentity(child.pid);
  let stdout = "";
  let stderr = "";
  let heartbeatCount = 0;
  let reconciled = false;
  let exitCallbackCount = 0;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    appendBounded(stdoutFile, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    appendBounded(stderrFile, chunk);
  });

  const result = await waitForChildTerminal({
    child,
    identity,
    timeoutMs: 450,
    drainMs: 150,
    heartbeatMs: 50,
    onHeartbeat: () => { heartbeatCount += 1; },
    onExit: () => { exitCallbackCount += 1; },
    onReconciling: () => { reconciled = true; }
  });

  const desc = descendantPid(stdout);
  const countAtTerminal = heartbeatCount;
  await delay(180);

  try {
    assert.equal(result.kind, "max_runtime");
    assert.equal(result.termination.verifiedGone, true);
    assert.equal(reconciled, true);
    assert.equal(exitCallbackCount, 0, "timeout-triggered exit must not overwrite reconciliation phase");
    assert.equal(processIsAlive(child.pid), false);
    if (process.platform === "win32" && desc) {
      assert.equal(processIsAlive(desc), false, "descendant should be terminated with the owned tree");
    }
    assert.equal(heartbeatCount, countAtTerminal, "executor heartbeat must stop after deadline/terminalization");
    assert.match(fs.readFileSync(stdoutFile, "utf8"), /ROOT_OUT/);
    assert.match(fs.readFileSync(stderrFile, "utf8"), /ROOT_ERR/);
  } finally {
    if (processIsAlive(child.pid)) exactKill(child.pid);
    if (desc && processIsAlive(desc)) exactKill(desc);
  }
});

test("deadline observes an already-exited child as exit, not timeout", { concurrency: false }, async () => {
  const sleeper = spawnNode('setInterval(()=>{},1000)');
  const child = new EventEmitter();
  child.pid = sleeper.pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (...args) => sleeper.kill(...args);
  child.exitCode = null;
  child.signalCode = null;

  setTimeout(() => { child.exitCode = 0; }, 120);
  const result = await waitForChildTerminal({
    child,
    timeoutMs: 200,
    drainMs: 120,
    heartbeatMs: 40
  });

  try {
    assert.equal(result.kind, "exit");
    assert.equal(result.code, 0);
    assert.equal(result.drainTimedOut, true);
  } finally {
    exactKill(sleeper.pid);
  }
});

test("missing trusted Windows identity never kills a live process", { concurrency: false, skip: process.platform !== "win32" }, async () => {
  const child = spawnNode('setInterval(()=>{},1000)');
  try {
    const result = await terminateOwnedProcessTree({
      child,
      identity: null,
      gracefulMs: 0,
      forceWaitMs: 250
    });
    assert.equal(result.verifiedGone, false);
    assert.equal(result.ownershipUncertain, true);
    assert.match(result.reason, /trusted Windows process identity/);
    assert.equal(processIsAlive(child.pid), true);
  } finally {
    exactKill(child.pid);
  }
});

test("launch timeout is distinct from max runtime", { concurrency: false }, async () => {
  const child = spawnNode('setInterval(()=>{},1000)');
  const identity = captureProcessIdentity(child.pid);
  const result = await waitForChildTerminal({
    child,
    identity,
    timeoutMs: 1200,
    launchTimeoutMs: 180,
    heartbeatMs: 50,
    isProtocolStarted: () => false
  });
  assert.equal(result.kind, "launch_timeout");
  assert.equal(result.termination.verifiedGone, true);
  assert.equal(processIsAlive(child.pid), false);
});

test("idle observation is diagnostic and does not kill a legal silent executor", { concurrency: false }, async () => {
  const sleeper = spawnNode('setInterval(()=>{},1000)');
  const child = new EventEmitter();
  child.pid = sleeper.pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (...args) => sleeper.kill(...args);
  child.exitCode = null;
  child.signalCode = null;

  const progressAt = new Date().toISOString();
  let idleObserved = 0;
  setTimeout(() => child.emit("exit", 0, null), 320);

  const result = await waitForChildTerminal({
    child,
    timeoutMs: 1200,
    launchTimeoutMs: 300,
    idleObservationMs: 100,
    heartbeatMs: 50,
    drainMs: 100,
    isProtocolStarted: () => true,
    getLastProgressAt: () => progressAt,
    onIdleObservation: () => { idleObserved += 1; }
  });

  try {
    assert.equal(result.kind, "exit");
    assert.equal(result.code, 0);
    assert.ok(idleObserved >= 1);
    assert.equal(processIsAlive(sleeper.pid), true, "idle observation must not kill the executor");
  } finally {
    exactKill(sleeper.pid);
  }
});

test("missing root before Windows reconciliation is ownership-uncertain", { concurrency: false, skip: process.platform !== "win32" }, async () => {
  const child = spawnNode('setInterval(()=>{},1000)');
  const identity = captureProcessIdentity(child.pid);
  exactKill(child.pid);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && processIsAlive(child.pid)) await delay(50);
  const result = await terminateOwnedProcessTree({ child, identity, gracefulMs: 0, forceWaitMs: 500 });
  assert.equal(result.verifiedGone, false);
  assert.equal(result.ownershipUncertain, true);
  assert.match(result.reason, /root process was already absent/);
});

test("unverifiable timeout termination becomes UNKNOWN and heartbeat stays stopped", { concurrency: false }, async () => {
  const child = spawnNode('console.log("READY");setInterval(()=>{},1000)');
  let heartbeatCount = 0;
  let reconciled = false;

  const result = await waitForChildTerminal({
    child,
    timeoutMs: 220,
    drainMs: 100,
    heartbeatMs: 50,
    onHeartbeat: () => { heartbeatCount += 1; },
    onReconciling: () => { reconciled = true; },
    terminateTree: async () => ({
      verifiedGone: false,
      ownershipUncertain: true,
      reason: "fixture cannot verify owned tree"
    })
  });

  const countAtTerminal = heartbeatCount;
  await delay(160);

  try {
    assert.equal(result.kind, "unknown");
    assert.equal(result.ownershipUncertain, true);
    assert.match(result.reason, /cannot verify owned tree/);
    assert.equal(reconciled, true);
    assert.equal(heartbeatCount, countAtTerminal);
  } finally {
    const identity = captureProcessIdentity(child.pid);
    await terminateOwnedProcessTree({ child, identity, gracefulMs: 0, forceWaitMs: 2000 });
    if (processIsAlive(child.pid)) exactKill(child.pid);
  }
});

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
