import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_DRAIN_MS = 750;
const DEFAULT_LIVENESS_GRACE_MS = 800;
const DEFAULT_FORCE_WAIT_MS = 2500;
const DEFAULT_POLL_MS = 75;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function powershellPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function taskkillPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "taskkill.exe");
}

function runPowerShell(script, timeoutMs = 4000) {
  const r = spawnSync(
    powershellPath(),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, shell: false, timeout: timeoutMs }
  );
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || ""),
    error: r.error ? String(r.error.message || r.error) : null
  };
}

function normalizeProcessRows(value) {
  if (!value) return [];
  const rows = Array.isArray(value) ? value : [value];
  return rows.map((row) => ({
    pid: Number(row.ProcessId),
    parentPid: Number(row.ParentProcessId),
    creationDate: row.CreationDate ? String(row.CreationDate) : null
  })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

function windowsProcessSnapshot() {
  const r = runPowerShell(
    "Get-CimInstance Win32_Process | " +
    "Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress"
  );
  if (!r.ok) {
    return { ok: false, rows: [], error: r.stderr || r.error || "process snapshot failed" };
  }
  try {
    return { ok: true, rows: normalizeProcessRows(JSON.parse(r.stdout || "null")), error: null };
  } catch (err) {
    return { ok: false, rows: [], error: "invalid process snapshot JSON: " + err.message };
  }
}

export function captureProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== "win32") {
    return { pid, parentPid: null, creationDate: null, source: "pid" };
  }
  const r = runPowerShell(
    "$p=Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + "\"; " +
    "if($p){$p | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress}"
  );
  if (!r.ok || !String(r.stdout || "").trim()) return null;
  try {
    const rows = normalizeProcessRows(JSON.parse(r.stdout));
    return rows[0] ? { ...rows[0], source: "cim" } : null;
  } catch {
    return null;
  }
}

function sameIdentity(expected, actual) {
  if (!expected || !actual || expected.pid !== actual.pid) return false;
  if (expected.creationDate && actual.creationDate) {
    return expected.creationDate === actual.creationDate;
  }
  return true;
}

export function inspectProcessIdentity(identity) {
  if (!identity || !Number.isInteger(Number(identity.pid)) || Number(identity.pid) <= 0) {
    return {
      trusted: false,
      safeAbsent: false,
      rootMatches: false,
      rootPresent: false,
      pidReused: false,
      descendants: [],
      reason: "missing process identity"
    };
  }

  const pid = Number(identity.pid);
  if (process.platform !== "win32") {
    const alive = processIsAlive(pid);
    return {
      trusted: true,
      safeAbsent: !alive,
      rootMatches: alive,
      rootPresent: alive,
      pidReused: false,
      descendants: [],
      reason: alive ? null : "process is absent"
    };
  }

  if (identity.source !== "cim" || !identity.creationDate) {
    return {
      trusted: false,
      safeAbsent: false,
      rootMatches: false,
      rootPresent: false,
      pidReused: false,
      descendants: [],
      reason: "trusted Windows CIM identity with creation time is required"
    };
  }

  const snapshot = windowsProcessSnapshot();
  if (!snapshot.ok) {
    return {
      trusted: true,
      safeAbsent: false,
      rootMatches: false,
      rootPresent: false,
      pidReused: false,
      descendants: [],
      reason: snapshot.error || "process snapshot failed"
    };
  }

  const current = snapshot.rows.find((row) => row.pid === pid) || null;
  const rootMatches = current ? sameIdentity(identity, current) : false;
  const descendants = descendantsOf(snapshot.rows, pid);

  return {
    trusted: true,
    safeAbsent: !rootMatches && !descendants.length,
    rootMatches,
    rootPresent: Boolean(current),
    pidReused: Boolean(current && !rootMatches),
    descendants,
    reason: rootMatches
      ? null
      : (descendants.length
        ? "process root is absent or changed but descendant candidates remain"
        : (current ? "PID is currently owned by a different process identity" : "process tree is absent"))
  };
}

function descendantsOf(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.parentPid)) byParent.set(row.parentPid, []);
    byParent.get(row.parentPid).push(row);
  }
  const out = [];
  const queue = [...(byParent.get(rootPid) || [])];
  const seen = new Set();
  while (queue.length) {
    const row = queue.shift();
    if (!row || seen.has(row.pid)) continue;
    seen.add(row.pid);
    out.push(row);
    queue.push(...(byParent.get(row.pid) || []));
  }
  return out;
}

function terminateExactTree(pid, force = true) {
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  const r = spawnSync(
    taskkillPath(),
    args,
    { encoding: "utf8", windowsHide: true, shell: false, timeout: 5000 }
  );
  return {
    pid,
    force,
    status: r.status,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || ""),
    error: r.error ? String(r.error.message || r.error) : null
  };
}

function mergeTargets(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const row of group || []) {
      const key = row.pid + "|" + String(row.creationDate || "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

async function waitForTargetsGone(targets, rootPid, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const snap = windowsProcessSnapshot();
    last = snap;
    if (!snap.ok) return { ok: false, reason: snap.error, snapshot: snap };

    const remaining = targets.filter((target) => {
      const current = snap.rows.find((row) => row.pid === target.pid);
      return current && sameIdentity(target, current);
    });
    const rooted = descendantsOf(snap.rows, rootPid);
    if (!remaining.length && !rooted.length) {
      return { ok: true, remaining: [], snapshot: snap };
    }
    await sleep(pollMs);
  }
  return {
    ok: false,
    reason: "owned process tree still present after force-wait deadline",
    snapshot: last
  };
}

export async function terminateOwnedProcessTree({
  child,
  identity,
  gracefulMs = 250,
  forceWaitMs = DEFAULT_FORCE_WAIT_MS,
  pollMs = DEFAULT_POLL_MS
}) {
  const pid = Number(child && child.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { verifiedGone: false, ownershipUncertain: true, reason: "missing child pid" };
  }

  if (process.platform !== "win32") {
    try {
      if (processIsAlive(pid)) child.kill();
    } catch {}
    if (gracefulMs > 0) await sleep(gracefulMs);
    if (processIsAlive(pid)) {
      try { child.kill("SIGKILL"); } catch {}
    }
    const deadline = Date.now() + forceWaitMs;
    while (Date.now() < deadline && processIsAlive(pid)) await sleep(pollMs);
    return {
      verifiedGone: !processIsAlive(pid),
      ownershipUncertain: false,
      reason: processIsAlive(pid) ? "process still alive after SIGKILL" : null,
      targets: [{ pid, creationDate: null }]
    };
  }

  const before = windowsProcessSnapshot();
  if (!before.ok) {
    return {
      verifiedGone: false,
      ownershipUncertain: true,
      reason: "cannot snapshot Windows process tree before termination: " + before.error
    };
  }

  if (!identity || identity.source !== "cim" || !identity.creationDate) {
    return {
      verifiedGone: false,
      ownershipUncertain: true,
      reason: "trusted Windows process identity with creation time is required before termination"
    };
  }

  const beforeRoot = before.rows.find((row) => row.pid === pid) || null;
  if (beforeRoot && !sameIdentity(identity, beforeRoot)) {
    return {
      verifiedGone: false,
      ownershipUncertain: true,
      reason: "root PID identity changed before reconciliation"
    };
  }

  const beforeDescendants = descendantsOf(before.rows, pid);
  const initialTargets = mergeTargets(beforeDescendants, beforeRoot ? [beforeRoot] : []);

  if (!beforeRoot) {
    return {
      verifiedGone: false,
      ownershipUncertain: true,
      reason: "root process was already absent before reconciliation; descendants were not terminated because ownership cannot be proven",
      targets: initialTargets,
      killEvidence: []
    };
  }

  const gracefulEvidence = [terminateExactTree(beforeRoot.pid, false)];
  if (gracefulMs > 0) await sleep(gracefulMs);

  const after = windowsProcessSnapshot();
  if (!after.ok) {
    return {
      verifiedGone: false,
      ownershipUncertain: true,
      reason: "cannot snapshot Windows process tree after graceful termination: " + after.error,
      targets: initialTargets,
      gracefulEvidence
    };
  }

  const afterRoot = after.rows.find((row) => row.pid === pid) || null;
  if (afterRoot && identity && !sameIdentity(identity, afterRoot)) {
    return {
      verifiedGone: false,
      ownershipUncertain: true,
      reason: "root PID identity changed during reconciliation",
      targets: initialTargets,
      gracefulEvidence
    };
  }

  const afterDescendants = descendantsOf(after.rows, pid);
  const targets = mergeTargets(
    initialTargets,
    afterDescendants,
    afterRoot ? [afterRoot] : []
  );
  const remaining = targets.filter((target) => {
    const current = after.rows.find((row) => row.pid === target.pid);
    return current && sameIdentity(target, current);
  });

  if (!remaining.length && !afterDescendants.length && !afterRoot) {
    return {
      verifiedGone: true,
      ownershipUncertain: false,
      reason: null,
      targets,
      gracefulEvidence,
      killEvidence: []
    };
  }

  const killEvidence = [];
  const killed = new Set();
  const forceRoots = afterRoot
    ? [afterRoot]
    : afterDescendants.filter((row) => row.parentPid === pid);
  const candidates = forceRoots.length ? forceRoots : remaining;
  for (const target of candidates) {
    const current = after.rows.find((row) => row.pid === target.pid);
    if (!current || !sameIdentity(target, current) || killed.has(target.pid)) continue;
    killed.add(target.pid);
    killEvidence.push(terminateExactTree(target.pid, true));
  }
  for (const target of remaining) {
    const current = after.rows.find((row) => row.pid === target.pid);
    if (!current || !sameIdentity(target, current) || killed.has(target.pid)) continue;
    killed.add(target.pid);
    killEvidence.push(terminateExactTree(target.pid, true));
  }

  const verified = await waitForTargetsGone(targets, pid, forceWaitMs, pollMs);
  return {
    verifiedGone: verified.ok,
    ownershipUncertain: !verified.ok,
    reason: verified.ok ? null : verified.reason,
    targets,
    gracefulEvidence,
    killEvidence
  };
}

function destroyPipes(child) {
  for (const stream of [child && child.stdin, child && child.stdout, child && child.stderr]) {
    try {
      if (stream && !stream.destroyed) stream.destroy();
    } catch {}
  }
}

export async function waitForChildTerminal({
  child,
  timeoutMs,
  launchTimeoutMs = null,
  idleObservationMs = null,
  identity = null,
  drainMs = DEFAULT_DRAIN_MS,
  livenessGraceMs = DEFAULT_LIVENESS_GRACE_MS,
  heartbeatMs = 15000,
  isProtocolStarted = () => true,
  getLastProgressAt = () => null,
  onHeartbeat = null,
  onIdleObservation = null,
  onExit = null,
  onReconciling = null,
  onLivenessLost = null,
  terminateTree = terminateOwnedProcessTree
}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error("waitForChildTerminal requires a spawned child");
  }

  return await new Promise((resolve) => {
    let settled = false;
    let deadlineReached = false;
    let exitInfo = null;
    let closeInfo = null;
    let drainTimer = null;
    let livenessTimer = null;
    let launchTimer = null;
    let maxRuntimeTimer = null;
    let lastIdleReportFor = null;

    const cleanup = () => {
      if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
      if (launchTimer) clearTimeout(launchTimer);
      clearInterval(heartbeatTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (livenessTimer) clearTimeout(livenessTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onChildExit);
      child.removeListener("close", onChildClose);
    };

    const settle = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const settleExitedAfterDrain = () => {
      if (settled || deadlineReached || !exitInfo) return;
      destroyPipes(child);
      settle({
        kind: "exit",
        code: exitInfo.code,
        signal: exitInfo.signal,
        closeObserved: Boolean(closeInfo),
        drainTimedOut: !closeInfo
      });
    };

    const reconcileDeadline = async (kind, reason) => {
      if (settled || deadlineReached || exitInfo || closeInfo) return;
      if (child.exitCode !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
        exitInfo = { code: child.exitCode, signal: child.signalCode || null, at: new Date().toISOString() };
        clearInterval(heartbeatTimer);
        if (onExit) onExit({ code: exitInfo.code, signal: exitInfo.signal, pid: child.pid });
        drainTimer = setTimeout(settleExitedAfterDrain, drainMs);
        if (drainTimer.unref) drainTimer.unref();
        return;
      }

      deadlineReached = true;
      clearInterval(heartbeatTimer);
      if (launchTimer) clearTimeout(launchTimer);
      if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
      if (onReconciling) onReconciling({ pid: child.pid, reason });

      let termination;
      try {
        termination = await terminateTree({ child, identity });
      } catch (err) {
        termination = {
          verifiedGone: false,
          ownershipUncertain: true,
          reason: String(err && err.message ? err.message : err)
        };
      }

      destroyPipes(child);
      if (termination && termination.verifiedGone) {
        settle({ kind, reason, termination });
      } else {
        settle({
          kind: "unknown",
          reason: termination && termination.reason
            ? termination.reason
            : "process tree termination could not be verified",
          trigger: kind,
          ownershipUncertain: true,
          termination: termination || null
        });
      }
    };

    const onError = (err) => {
      if (deadlineReached) return;
      settle({ kind: "error", error: err });
    };

    const onChildExit = (code, signal) => {
      exitInfo = { code, signal, at: new Date().toISOString() };
      clearInterval(heartbeatTimer);
      if (deadlineReached || settled) return;
      if (onExit) onExit({ code, signal, pid: child.pid });
      drainTimer = setTimeout(settleExitedAfterDrain, drainMs);
      if (drainTimer.unref) drainTimer.unref();
    };

    const onChildClose = (code, signal) => {
      closeInfo = { code, signal, at: new Date().toISOString() };
      if (deadlineReached || settled) return;
      if (!exitInfo) exitInfo = { code, signal, at: closeInfo.at };
      settle({
        kind: "exit",
        code: exitInfo.code,
        signal: exitInfo.signal,
        closeObserved: true,
        drainTimedOut: false
      });
    };

    child.once("error", onError);
    child.once("exit", onChildExit);
    child.once("close", onChildClose);

    const heartbeatTimer = setInterval(() => {
      if (settled || deadlineReached || exitInfo) return;
      const alive = processIsAlive(child.pid);
      if (alive) {
        if (onHeartbeat) onHeartbeat({ pid: child.pid });

        if (idleObservationMs && onIdleObservation && isProtocolStarted()) {
          const progressAt = getLastProgressAt();
          const progressMs = progressAt ? new Date(progressAt).getTime() : NaN;
          if (Number.isFinite(progressMs)) {
            const idleForMs = Date.now() - progressMs;
            if (idleForMs >= idleObservationMs) {
              const key = String(progressAt);
              if (lastIdleReportFor !== key) {
                lastIdleReportFor = key;
                onIdleObservation({ pid: child.pid, idleForMs, lastProgressAt: progressAt });
              }
            }
          }
        }
        return;
      }

      clearInterval(heartbeatTimer);
      if (onLivenessLost) onLivenessLost({ pid: child.pid });
      livenessTimer = setTimeout(async () => {
        if (settled || deadlineReached || exitInfo || closeInfo) return;
        let termination;
        try {
          termination = await terminateTree({ child, identity, gracefulMs: 0 });
        } catch (err) {
          termination = {
            verifiedGone: false,
            ownershipUncertain: true,
            reason: String(err && err.message ? err.message : err)
          };
        }
        if (settled || deadlineReached || exitInfo || closeInfo) return;
        destroyPipes(child);
        settle({
          kind: "unknown",
          reason: "child PID disappeared without exit/close event",
          ownershipUncertain: true,
          termination
        });
      }, livenessGraceMs);
      if (livenessTimer.unref) livenessTimer.unref();
    }, Math.max(50, heartbeatMs));
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    if (Number.isFinite(Number(launchTimeoutMs)) && Number(launchTimeoutMs) > 0) {
      launchTimer = setTimeout(() => {
        if (settled || deadlineReached || exitInfo || closeInfo || isProtocolStarted()) return;
        void reconcileDeadline("launch_timeout", "launch_timeout");
      }, Number(launchTimeoutMs));
      if (launchTimer.unref) launchTimer.unref();
    }

    maxRuntimeTimer = setTimeout(() => {
      void reconcileDeadline("max_runtime", "max_runtime");
    }, timeoutMs);
    if (maxRuntimeTimer.unref) maxRuntimeTimer.unref();
  });
}
