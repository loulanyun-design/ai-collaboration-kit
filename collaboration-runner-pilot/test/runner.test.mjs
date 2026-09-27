import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalPolicyJson,
  readDoc,
  registerCandidateArtifact,
  writeDoc,
  resolveProjectEntry
} from "../src/lib.mjs";
import {
  childEnvironment,
  ISOLATED_CODEX_VERSION,
  resolveCodexRuntime
} from "../src/executors/codex.mjs";
import { MODEL_POLICY, modelForRoute, timeoutForRoute, timeoutPolicyForRoute } from "../src/model-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PILOT = path.resolve(HERE, "..");
const FIXTURE_ROOT = path.join(PILOT, "test-tmp", "runner-fixture-" + process.pid);
const FIXTURE_PROJECT = path.join(FIXTURE_ROOT, "collaboration-runner-pilot");
const HANDOFF = path.join(FIXTURE_ROOT, "collaboration", "handoff.mjs");
const CURRENT = path.join(FIXTURE_PROJECT, "work", "handoffs", "current.md");
const RESULT = path.join(FIXTURE_PROJECT, "work", "handoffs", "RESULT.md");
const HANDOFF_LOCK = path.join(FIXTURE_PROJECT, "work", "handoffs", ".handoff.lock.json");
const RUNNER = path.join(PILOT, "src", "runner.mjs");
const PROJECT_ID = "collaboration-runner-pilot";

const TEST_ENV = { ...process.env, NODE_ENV: "test", COLLAB_RUNNER_TEST_ROOT: FIXTURE_ROOT, COLLAB_RUNNER_CHILD: "0" };

function findCollaborationDir(start) {
  let dir = path.resolve(start);
  while (true) {
    const candidate = path.join(dir, "collaboration");
    if (fs.existsSync(path.join(candidate, "handoff.mjs"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("could not locate collaboration/handoff.mjs from " + start);
    dir = parent;
  }
}

function setupFixture() {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIXTURE_ROOT, "collaboration", "templates"), { recursive: true });
  fs.mkdirSync(path.dirname(CURRENT), { recursive: true });
  const collaboration = findCollaborationDir(PILOT);
  fs.copyFileSync(path.join(collaboration, "handoff.mjs"), HANDOFF);
  fs.copyFileSync(path.join(collaboration, "policy.mjs"), path.join(FIXTURE_ROOT, "collaboration", "policy.mjs"));
  fs.mkdirSync(path.join(FIXTURE_ROOT, "collaboration", "policies"), { recursive: true });
  fs.copyFileSync(path.join(collaboration, "policies", "root-policy-v1.json"), path.join(FIXTURE_ROOT, "collaboration", "policies", "root-policy-v1.json"));
  fs.copyFileSync(path.join(collaboration, "policies", "root-policy-v1.md"), path.join(FIXTURE_ROOT, "collaboration", "policies", "root-policy-v1.md"));
  for (const name of ["CURRENT_TEMPLATE.md", "RESULT_TEMPLATE.md"]) {
    fs.copyFileSync(path.join(collaboration, "templates", name), path.join(FIXTURE_ROOT, "collaboration", "templates", name));
  }
  fs.writeFileSync(path.join(FIXTURE_ROOT, "AGENTS.md"), "# fixture root rules\n");
  fs.writeFileSync(path.join(FIXTURE_PROJECT, "AGENTS.md"), "# fixture project rules\n");
  fs.copyFileSync(path.join(PILOT, "COLLAB_POLICY.json"), path.join(FIXTURE_PROJECT, "COLLAB_POLICY.json"));
  fs.copyFileSync(path.join(PILOT, "COLLAB_POLICY.md"), path.join(FIXTURE_PROJECT, "COLLAB_POLICY.md"));
  fs.writeFileSync(path.join(FIXTURE_ROOT, "collaboration", "projects.json"), JSON.stringify({ projects: [{ id: PROJECT_ID, path: FIXTURE_PROJECT, enabled: true, project_rules: "AGENTS.md", handoff_dir: "work\\handoffs" }] }, null, 2));
}

function execNode(script, args = [], expectOk = true) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: PILOT,
    encoding: "utf8",
    shell: false,
    windowsHide: true
    , env: TEST_ENV
  });
  if (expectOk && r.status !== 0) {
    throw new Error("command failed: " + [script, ...args].join(" ") + "\n" + r.stderr + "\n" + r.stdout);
  }
  return r;
}

function handoff(args, expectOk = true) {
  return execNode(HANDOFF, ["--project", PROJECT_ID, ...args], expectOk);
}

function runner(args, expectOk = true) {
  return execNode(RUNNER, args, expectOk);
}

function fillReadyTask(name, type = "non_code", policySchemaVersion = "") {
  handoff(["new", name, "--type", type]);
  const doc = readDoc(CURRENT);
  doc.body = [
    "# Current Handoff",
    "",
    "## Goal",
    "",
    "Validate runner behavior for " + name + ".",
    "",
    "## State Machine / Intended Flow",
    "",
    "DRAFT -> READY -> IN_PROGRESS -> executor -> REVIEW or BLOCKED.",
    "",
    "## Confirmed Facts",
    "",
    "- This is an isolated pilot test.",
    "- All real-system side effects remain disabled.",
    "",
    "## Unknowns to Diagnose",
    "",
    "- Whether this runner test case follows the expected state transition.",
    "",
    "## Evidence References",
    "",
    "- Logs: runner job logs only.",
    "- Relevant files / sources: pilot handoff files.",
    "",
    "## Delegated Scope",
    "",
    "Codex may:",
    "- inspect: pilot handoff state",
    "- modify / produce: pilot-only deliverables and RESULT.md",
    "- add tests / evidence: runner test evidence",
    "",
    "Codex may NOT:",
    "- touch clinic/fund production data",
    "- merge/push",
    "",
    "## Codex Technical Acceptance",
    "",
    "- [ ] Test case reaches the expected runner state.",
    "- [ ] RESULT/lock behavior matches the case.",
    "",
    "## ChatGPT Business Acceptance",
    "",
    "- [ ] No out-of-scope project data is touched.",
    "",
    "## Deliverables",
    "",
    "- Pilot-only fake deliverable and RESULT.md.",
    "",
    "## Side-effect Notes",
    "",
    "No real-system write, bulk write, final submit, Git push, or external upload.",
    "",
    "## Stop Conditions",
    "",
    "- Stop on unexpected scope or identity mismatch.",
    ""
  ].join("\n");
  writeDoc(CURRENT, doc);
  handoff(policySchemaVersion ? ["prepare", "--policy-schema-version", policySchemaVersion] : ["prepare"]);
  return readDoc(CURRENT);
}

function fillReadyRecoveryTask(name) {
  if (!fs.existsSync(path.join(FIXTURE_PROJECT, ".git"))) {
    spawnSync("git", ["init", "-b", "main"], { cwd: FIXTURE_PROJECT });
    spawnSync("git", ["config", "user.name", "runner-test"], { cwd: FIXTURE_PROJECT });
    spawnSync("git", ["config", "user.email", "runner-test@example.invalid"], { cwd: FIXTURE_PROJECT });
    fs.writeFileSync(path.join(FIXTURE_PROJECT, ".gitignore"), "work/\nrecovery-result.json\n");
    fs.writeFileSync(path.join(FIXTURE_PROJECT, "fixture.txt"), "base\n");
    spawnSync("git", ["add", "."], { cwd: FIXTURE_PROJECT });
    spawnSync("git", ["commit", "-m", "fixture base"], { cwd: FIXTURE_PROJECT });
  }
  handoff(["new", name, "--type", "code"]);
  const doc = readDoc(CURRENT);
  doc.body = [
    "# Current Handoff", "", "## Goal", "", "Recover committed fixture work.", "",
    "## State Machine / Intended Flow", "", "READY -> IN_PROGRESS -> REVIEW.", "",
    "## Confirmed Facts", "", "- The fixture worktree has a local commit.", "",
    "## Unknowns to Diagnose", "", "- Whether recovery validates it.", "",
    "## Evidence References", "", "- Local fixture commit.", "",
    "## Acceptance Criteria", "", "- R1: recovery succeeds safely", "",
    "## Code Allowlist", "", "- recovered.txt", "",
    "## Delegated Scope", "", "- Validate the fixture only.", "",
    "## Codex Technical Acceptance", "", "- [ ] Recovery is verified.", "",
    "## ChatGPT Business Acceptance", "", "- [ ] No external effects.", "",
    "## Deliverables", "", "- One fixture commit.", "",
    "## Side-effect Notes", "", "No external side effects.", "",
    "## Stop Conditions", "", "- Stop on validation failure.", ""
  ].join("\n");
  doc.meta.codex_worktree = path.join(FIXTURE_ROOT, "worktrees", "r");
  doc.meta.branch = "codex/recovery-fixture";
  writeDoc(CURRENT, doc);
  handoff(["prepare"]);
  const ready = readDoc(CURRENT);
  const wt = String(ready.meta.codex_worktree);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  spawnSync("git", ["worktree", "add", "-b", String(ready.meta.branch), wt, String(ready.meta.base_commit)], { cwd: FIXTURE_PROJECT });
  fs.writeFileSync(path.join(wt, "recovered.txt"), name + "\n");
  spawnSync("git", ["add", "recovered.txt"], { cwd: wt });
  spawnSync("git", ["-c", "user.name=runner-test", "-c", "user.email=runner-test@example.invalid", "commit", "-m", "fixture recovery result"], { cwd: wt });
  return ready;
}

function parseJsonOutput(r) {
  return JSON.parse(String(r.stdout || "").trim());
}

function spawnRunner(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...args], {
      cwd: PILOT,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
      , env: TEST_ENV
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitJob(jobId, wanted, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = runner(["status", "--job", jobId]);
    last = parseJsonOutput(r);
    // Failure state and its ledger are persisted in two atomic updates. Wait for
    // the complete externally observable failure record before asserting it.
    const ledgerPending = new Set(["executor_error", "timeout", "nonzero_exit", "structured_materialization"])
      .has(last.failureKind) && !last.failureLedger;
    if (wanted.includes(last.observedState) && !ledgerPending) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for " + wanted.join("/") + "; last=" + JSON.stringify(last));
}

function finishReviewIfNeeded() {
  const s = handoff(["status"]);
  if (/status:\s+REVIEW/.test(s.stdout)) handoff(["done"]);
}

test("runner fake acceptance matrix", { concurrency: false }, async () => {
  setupFixture();
  assert.equal(modelForRoute("retrieval"), MODEL_POLICY.retrieval);
  assert.equal(modelForRoute("execution"), MODEL_POLICY.execution);
  assert.equal(modelForRoute("escalation"), "gpt-6-astra");
  assert.ok(timeoutForRoute("escalation") > timeoutForRoute("execution"));
  assert.equal(timeoutPolicyForRoute("execution").maxRuntimeMs, 30 * 60 * 1000);
  assert.equal(timeoutPolicyForRoute("execution").launchTimeoutMs, 90000);
  assert.equal(timeoutPolicyForRoute("execution").idleObservationMs, 300000);
  assert.throws(() => modelForRoute("unknown-tier"), /unsupported model route/);
  try {
    const runtime = resolveCodexRuntime();
    assert.ok(runtime.version);
  } catch (err) {
    assert.match(String(err.message), /Pinned isolated Codex CLI|version mismatch/);
  }
  const envProbe = childEnvironment({
    APPDATA: "C:\\Users\\probe\\AppData\\Roaming",
    PATH: [
      "C:\\Users\\probe\\AppData\\Roaming\\npm",
      "C:\\Program Files\\nodejs"
    ].join(path.delimiter)
  });
  assert.equal(envProbe.COLLAB_RUNNER_CHILD, "1");
  assert.doesNotMatch(envProbe.PATH.toLowerCase(), /appdata\\roaming\\npm/);

  const codexSource = fs.readFileSync(path.join(PILOT, "src", "executors", "codex.mjs"), "utf8");
  assert.doesNotMatch(codexSource, /dangerously-bypass-approvals-and-sandbox/);
  assert.doesNotMatch(codexSource, /danger-full-access/);
  assert.match(codexSource, /args\.push\("--approve-for-me"\)/);
  assert.equal((codexSource.match(/args\.push\("--approve-for-me"/g) || []).length, 1);
  assert.match(codexSource, /args\.push\("--skip-git-repo-check", "-s", "read-only"\)/);
  const nonCodeSource = fs.readFileSync(path.join(PILOT, "src", "noncode.mjs"), "utf8");
  assert.match(nonCodeSource, /"\.py"/);
  assert.doesNotMatch(codexSource, /"workspace-write"/);
  assert.match(codexSource, /waitForChildTerminal/);
  assert.match(codexSource, /appendBounded/);
  const lifecycleSource = fs.readFileSync(path.join(PILOT, "src", "process-lifecycle.mjs"), "utf8");
  assert.match(lifecycleSource, /setInterval/);
  assert.match(lifecycleSource, /taskkill\.exe/);
  assert.match(lifecycleSource, /\/T/);
  assert.match(lifecycleSource, /\/F/);
  const workerSource = fs.readFileSync(path.join(PILOT, "src", "worker.mjs"), "utf8");
  assert.match(workerSource, /workerHeartbeatAt/);
  assert.match(workerSource, /executorHeartbeatAt/);
  assert.match(workerSource, /executor_reconciling/);

  assert.throws(
    () => resolveProjectEntry({
      id: "escape-fixture",
      path: "C:\\Windows",
      enabled: true,
      project_rules: "AGENTS.md",
      handoff_dir: "work\\handoffs"
    }),
    /outside allowed root/
  );
  assert.throws(
    () => resolveProjectEntry({
      id: PROJECT_ID,
      path: FIXTURE_PROJECT,
      enabled: true,
      project_rules: "AGENTS.md",
      policy_manifest: "..\\outside.json",
      handoff_dir: "work\\handoffs"
    }),
    /policyManifest path escapes registered project/
  );

  let r = runner(["submit", "--project", "definitely-not-registered", "--executor", "fake"], false);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not explicitly registered/);

  r = runner(["submit", "--project", PROJECT_ID, "--command", "echo should-not-run"], false);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unsupported option/);

  const recursion = spawnSync(process.execPath, [RUNNER, "submit", "--project", PROJECT_ID], {
    cwd: PILOT,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: { ...TEST_ENV, COLLAB_RUNNER_CHILD: "1" }
  });
  assert.notEqual(recursion.status, 0);
  assert.match(recursion.stderr, /recursive submit is forbidden/);

  handoff(["new", "not-ready-case", "--type", "non_code"]);
  const notReadyPreflight = parseJsonOutput(runner(["preflight", "--project", PROJECT_ID]));
  assert.equal(notReadyPreflight.ok, true);
  assert.equal(notReadyPreflight.preflightStatus, "NOT_READY");
  assert.equal(notReadyPreflight.readyForNewLaunch, false);
  assert.equal(notReadyPreflight.diagnostic, "handoff is not READY");
  r = runner(["submit", "--project", PROJECT_ID, "--executor", "fake"], false);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not READY/);
  handoff(["new", "malformed-preflight-case", "--type", "non_code"]);
  const malformedDoc = readDoc(CURRENT);
  malformedDoc.meta.task_id = "";
  writeDoc(CURRENT, malformedDoc);
  const malformedPreflight = parseJsonOutput(runner(["preflight", "--project", PROJECT_ID]));
  assert.equal(malformedPreflight.ok, true);
  assert.equal(malformedPreflight.preflightStatus, "INVALID_HANDOFF");
  assert.equal(malformedPreflight.blockReason, "HANDOFF_INVALID");
  assert.match(malformedPreflight.diagnostic, /task_id/);

  fillReadyTask("spec-change-case");
  let doc = readDoc(CURRENT);
  doc.body += "\n\nChanged after prepare.\n";
  writeDoc(CURRENT, doc);
  r = runner(["submit", "--project", PROJECT_ID, "--executor", "fake"], false);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /spec hash mismatch/);

  fillReadyTask("success-and-duplicate");
  const readyPreflight = parseJsonOutput(runner(["preflight", "--project", PROJECT_ID]));
  assert.equal(readyPreflight.ok, true);
  assert.equal(readyPreflight.readyForNewLaunch, true);
  assert.equal(readyPreflight.duplicateSubmission, false);
  assert.ok(readyPreflight.runnerBuildIdentity);

  r = runner(["submit", "--project", PROJECT_ID, "--executor", "fake", "--fake-mode", "success"]);
  const first = parseJsonOutput(r);
  assert.equal(first.runnerBuildIdentity, readyPreflight.runnerBuildIdentity);
  assert.equal(first.launched, true);
  const success = await waitJob(first.jobId, ["SUCCEEDED"]);
  assert.equal(success.handoff.status, "REVIEW");
  assert.equal(success.phase, "completed");
  assert.equal(success.nextAction, "CHATGPT_LOCAL_REVIEW");
  assert.equal(success.autoContinue, true);
  assert.equal(success.requiresUserInput, false);
  assert.equal(success.mustReturnCheckpoint, false);
  assert.equal(success.continuationDecision.decision, "AUTO_CONTINUE");
  assert.equal(success.continuationDecision.source, "deterministic");
  assert.equal(success.continuationDecision.reason, "local_review_no_new_side_effects");
  assert.equal(success.checkpoint.externalJobStarted, false);
  const resume = parseJsonOutput(runner(["resume", "--project", PROJECT_ID]));
  assert.equal(resume.taskId, success.taskId);
  assert.equal(resume.job.phase, "completed");
  assert.equal(resume.job.autoContinue, true);
  assert.equal(resume.continuation.decision, "AUTO_CONTINUE");
  assert.equal(resume.continuation.nextAction, "CHATGPT_LOCAL_REVIEW");
  assert.equal(resume.continuation.requiresUserInput, false);
  assert.equal(resume.continuation.mustReturnCheckpoint, false);
  assert.equal(resume.result.matchingIdentity, true);
  assert.equal(resume.connectorHealth, "unknown_not_asserted");
  const unavailableRetry = parseJsonOutput(runner(["resume", "--project", PROJECT_ID, "--unavailable-count", "1"]));
  assert.equal(unavailableRetry.continuation.decision, "AUTO_CONTINUE");
  assert.equal(unavailableRetry.continuation.nextAction, "RETRY_SAME_STEP");
  assert.equal(unavailableRetry.continuation.mustReturnCheckpoint, false);
  const unavailableCheckpoint = parseJsonOutput(runner(["resume", "--project", PROJECT_ID, "--unavailable-count", "2"]));
  assert.equal(unavailableCheckpoint.continuation.workflowBlocked, true);
  assert.equal(unavailableCheckpoint.continuation.mustReturnCheckpoint, true);
  assert.equal(unavailableCheckpoint.continuation.nextAction, "RETURN_CHECKPOINT_WITH_FAILURE_EVIDENCE");
  handoff(["done"]);
  const completedResume = parseJsonOutput(runner(["resume", "--project", PROJECT_ID]));
  assert.equal(completedResume.handoff.status, "DONE");
  assert.equal(completedResume.continuation.mustReturnCheckpoint, true);
  assert.equal(completedResume.continuation.requiresUserInput, false);
  assert.equal(completedResume.continuation.nextAction, "RETURN_CHECKPOINT");
  assert.equal(completedResume.job.mustReturnCheckpoint, true);
  const artifactStatus = parseJsonOutput(runner(["artifact-status", "--project", PROJECT_ID]));
  assert.deepEqual(artifactStatus.manifest.current, {});
  const artifactFile = path.join(FIXTURE_PROJECT, "deliverables", "approved.txt");
  fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
  fs.writeFileSync(artifactFile, "approved candidate\n", "utf8");
  const fixtureProject = resolveProjectEntry({ id: PROJECT_ID, path: FIXTURE_PROJECT, enabled: true, project_rules: "AGENTS.md", handoff_dir: "work\\handoffs" });
  const candidate = registerCandidateArtifact(fixtureProject, { logical_id: "approved_asset", version: "v1", relative_path: "deliverables/approved.txt", source_task: success.taskId, source_revision: success.revision });
  const approval = parseJsonOutput(runner(["artifact-approve", "--project", PROJECT_ID, "--logical-id", candidate.logical_id, "--version", candidate.version, "--relative-path", candidate.relative_path, "--content-hash", candidate.content_hash, "--approval-ref", "user-confirmation-1"]));
  assert.equal(approval.approved.status, "approved");
  assert.equal(approval.current.version, "v1");

  const duplicatePreflight = parseJsonOutput(runner(["preflight", "--project", PROJECT_ID]));
  assert.equal(duplicatePreflight.readyForNewLaunch, false);
  assert.equal(duplicatePreflight.duplicateSubmission, true);
  assert.equal(duplicatePreflight.existingJob.jobId, first.jobId);
  assert.equal(duplicatePreflight.runnerBuildIdentity, first.runnerBuildIdentity);

  const duplicate = parseJsonOutput(
    runner(["submit", "--project", PROJECT_ID, "--executor", "fake", "--fake-mode", "success"])
  );
  assert.equal(duplicate.jobId, first.jobId);
  assert.equal(duplicate.duplicateSubmission, true);
  assert.equal(duplicate.launched, false);
  finishReviewIfNeeded();

  handoff(["new", "snapshot-overwrite-probe", "--type", "non_code"]);
  const historicalResult = runner(["result", "--job", first.jobId]);
  assert.match(historicalResult.stdout, /"resultSource": "job_snapshot"/);
  assert.match(historicalResult.stdout, /success-and-duplicate/);

  fillReadyTask("concurrent-submit-case");
  const submitArgs = ["submit", "--project", PROJECT_ID, "--executor", "fake", "--fake-mode", "success"];
  const pair = await Promise.all([spawnRunner(submitArgs), spawnRunner(submitArgs)]);
  assert.equal(pair[0].code, 0);
  assert.equal(pair[1].code, 0);
  const a = JSON.parse(pair[0].stdout);
  const b = JSON.parse(pair[1].stdout);
  assert.equal(a.jobId, b.jobId);
  assert.equal([a.launched, b.launched].filter(Boolean).length, 1);
  await waitJob(a.jobId, ["SUCCEEDED"]);
  finishReviewIfNeeded();

  fillReadyTask("failure-case");
  const failJob = parseJsonOutput(
    runner(["submit", "--project", PROJECT_ID, "--executor", "fake", "--fake-mode", "fail"])
  );
  const failed = await waitJob(failJob.jobId, ["FAILED"]);
  assert.equal(failed.failureKind, "executor_error");
  assert.equal(failed.failureLedger.consecutiveCount, 1);
  assert.ok(failed.failureLedger.signature);
  assert.equal(failed.nextAction, "SELF_REPAIR");
  assert.equal(failed.escalationGate, false);
  assert.equal(failed.handoffState, "BLOCKED");
  assert.equal(failed.handoff.status, "BLOCKED");

  handoff(["prepare"]);
  const failAgainJob = parseJsonOutput(
    runner(["submit", "--project", PROJECT_ID, "--executor", "fake", "--fake-mode", "fail"])
  );
  const failedAgain = await waitJob(failAgainJob.jobId, ["FAILED"]);
  assert.equal(failedAgain.failureLedger.consecutiveCount, 2);
  assert.equal(failedAgain.failureLedger.signature, failed.failureLedger.signature);
  assert.equal(failedAgain.escalationGate, true);
  assert.equal(failedAgain.nextAction, "ESCALATE_ASTRA");

  fillReadyTask("timeout-case");
  const timeoutJob = parseJsonOutput(
    runner([
      "submit", "--project", PROJECT_ID, "--executor", "fake",
      "--fake-mode", "timeout", "--timeout-ms", "600"
    ])
  );
  const timed = await waitJob(timeoutJob.jobId, ["TIMED_OUT"], 6000);
  assert.equal(timed.failureKind, "executor_max_runtime");
  assert.equal(timed.primaryFailureKind, "EXECUTOR_MAX_RUNTIME");
  assert.equal(timed.layer, "executor");
  assert.equal(timed.executorLaunchState, "PROCESS_STARTED");
  assert.equal(timed.handoffState, "BLOCKED");
  assert.equal(timed.handoff.status, "BLOCKED");
  assert.equal(timed.nextAction, "CHATGPT_LOCAL_DIAGNOSIS");
  const timedResume = parseJsonOutput(runner(["resume", "--project", PROJECT_ID]));
  assert.equal(timedResume.continuation.decision, "BLOCKED");
  assert.equal(timedResume.continuation.workflowBlocked, true);
  assert.equal(timedResume.continuation.requiresUserInput, false);
  assert.equal(timedResume.continuation.mustReturnCheckpoint, false);
  assert.equal(timedResume.continuation.nextAction, "CHATGPT_LOCAL_DIAGNOSIS");
  const timedCheckpoint = parseJsonOutput(runner(["resume", "--project", PROJECT_ID, "--diagnosis-complete", "true"]));
  assert.equal(timedCheckpoint.continuation.mustReturnCheckpoint, true);
  assert.equal(timedCheckpoint.continuation.requiresUserInput, false);
  assert.equal(timedCheckpoint.continuation.nextAction, "RETURN_CHECKPOINT_WITH_FAILURE_EVIDENCE");

  fillReadyTask("quota-pause-case");
  const quotaJob = parseJsonOutput(
    runner(["submit", "--project", PROJECT_ID, "--executor", "fake", "--fake-mode", "quota"])
  );
  const quota = await waitJob(quotaJob.jobId, ["PAUSED_QUOTA"], 6000);
  assert.equal(quota.failureKind, "quota");
  assert.equal(quota.handoffState, "BLOCKED");
  assert.equal(quota.handoff.status, "BLOCKED");
  assert.equal(quota.checkpoint.phase, "quota_paused");
  assert.equal(quota.checkpoint.taskId, quota.taskId);
  assert.match(quota.checkpoint.resumeRule, /new handoff revision/);

  fillReadyTask("pseudo-success-case");
  const pseudoJob = parseJsonOutput(
    runner(["submit", "--project", PROJECT_ID, "--executor", "fake", "--fake-mode", "pseudo_success"])
  );
  const pseudo = await waitJob(pseudoJob.jobId, ["FAILED"]);
  assert.equal(pseudo.failureKind, "pseudo_success");
  assert.equal(pseudo.handoffState, "BLOCKED");
  assert.equal(pseudo.handoff.status, "BLOCKED");

  fillReadyTask("orphan-lock-diagnostic");
  const crashJob = parseJsonOutput(
    runner(["submit", "--project", PROJECT_ID, "--executor", "fake", "--fake-mode", "crash"])
  );
  const orphan = await waitJob(crashJob.jobId, ["UNKNOWN"], 6000);
  assert.match(orphan.diagnostic, /completion is unconfirmed/);
  assert.match(orphan.diagnostic, /not auto-retried/);
  assert.equal(orphan.terminationConfidence, "UNKNOWN");
  assert.ok(orphan.projectLock);
  assert.equal(orphan.projectLock.task_id, orphan.taskId);
  const orphanResume = parseJsonOutput(runner(["resume", "--project", PROJECT_ID]));
  assert.equal(orphanResume.continuation.decision, "BLOCKED");
  assert.equal(orphanResume.continuation.workflowBlocked, true);
  assert.equal(orphanResume.continuation.requiresUserInput, false);
  assert.equal(orphanResume.continuation.nextAction, "RECONCILE_PROCESS_OWNERSHIP");

  handoff(["block", "--reason", "intentional smoke crash cleanup after orphan diagnostic"]);
  const afterCleanup = parseJsonOutput(runner(["status", "--job", crashJob.jobId]));
  assert.equal(afterCleanup.observedState, "UNKNOWN");
  assert.equal(afterCleanup.projectLock, null);

  handoff(["prepare"]);
  const blockedByUnknown = runner(
    ["submit", "--project", PROJECT_ID, "--executor", "fake", "--fake-mode", "success"],
    false
  );
  assert.notEqual(blockedByUnknown.status, 0);
  assert.match(blockedByUnknown.stderr, /unreconciled project job blocks new writer/);
  assert.match(blockedByUnknown.stderr, /state=UNKNOWN/);
});

test("recover-code succeeds without a model and blocks malformed recovery", { concurrency: false }, () => {
  setupFixture();
  let ready = fillReadyRecoveryTask("recovery-success");
  const resultFile = path.join(FIXTURE_PROJECT, "recovery-result.json");
  const structured = {
    task_id: ready.meta.task_id, handoff_revision: String(ready.meta.handoff_revision), completion_basis: "validated existing commit",
    evidence: ["local QA"], criterion_evidence: [{ criterion_id: "R1", evidence: [{ type: "inspection", reference: "commit", scenario: "recovery", executed: true }] }],
    changed_files: ["recovered.txt"], tests: { targeted: ["fixture"], regression: ["fixture regression"], safety: ["clean worktree"] }, remaining_risks: [],
    scope_check: { unrelated_business_rules_changed: false, formal_branch_modified_directly: false, validation_weakened: false, side_effect_policy_exceeded: false, unrelated_files_modified: false }
  };
  fs.writeFileSync(resultFile, JSON.stringify(structured));
  let r = runner(["recover-code", "--project", PROJECT_ID, "--structured-result", resultFile]);
  const succeeded = parseJsonOutput(r);
  assert.equal(succeeded.state, "SUCCEEDED");
  assert.equal(succeeded.executor, "recovery");
  assert.equal(succeeded.modelRequested, "none");
  assert.equal(succeeded.noModel, true);
  assert.equal(succeeded.nextAction, "CHATGPT_LOCAL_REVIEW");
  assert.equal(succeeded.autoContinue, true);
  assert.equal(succeeded.requiresUserInput, false);
  assert.equal(succeeded.continuationDecision.decision, "AUTO_CONTINUE");
  assert.equal(readDoc(CURRENT).meta.status, "REVIEW");

  setupFixture();
  ready = fillReadyRecoveryTask("recovery-malformed");
  const historical = path.join(FIXTURE_ROOT, ".runtime", "jobs", "historical", "job.json");
  fs.mkdirSync(path.dirname(historical), { recursive: true });
  fs.writeFileSync(historical, JSON.stringify({ state: "UNKNOWN", marker: "unchanged" }));
  fs.writeFileSync(resultFile, JSON.stringify({ task_id: ready.meta.task_id }));
  r = runner(["recover-code", "--project", PROJECT_ID, "--structured-result", resultFile], false);
  assert.notEqual(r.status, 0);
  assert.equal(readDoc(CURRENT).meta.status, "BLOCKED");
  assert.deepEqual(JSON.parse(fs.readFileSync(historical, "utf8")), { state: "UNKNOWN", marker: "unchanged" });

  const child = spawnSync(process.execPath, [RUNNER, "recover-code", "--project", PROJECT_ID, "--structured-result", resultFile], { cwd: PILOT, encoding: "utf8", env: { ...TEST_ENV, COLLAB_RUNNER_CHILD: "1" } });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /recursive recover-code is forbidden/);

  const recoverySource = fs.readFileSync(path.join(PILOT, "src", "recovery.mjs"), "utf8");
  assert.doesNotMatch(recoverySource, /runCodexExecutor|resolveCodexRuntime|decideContinuation|probeJev|playwright|chrom(e|ium)/i);

  setupFixture();
  fillReadyTask("recovery-noncode", "non_code");
  fs.writeFileSync(resultFile, JSON.stringify(structured));
  r = runner(["recover-code", "--project", PROJECT_ID, "--structured-result", resultFile], false);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires a code handoff/);

  setupFixture();
  ready = fillReadyRecoveryTask("recovery-locked");
  fs.writeFileSync(resultFile, JSON.stringify({ ...structured, task_id: ready.meta.task_id, handoff_revision: String(ready.meta.handoff_revision) }));
  fs.writeFileSync(HANDOFF_LOCK, JSON.stringify({ task_id: ready.meta.task_id }));
  r = runner(["recover-code", "--project", PROJECT_ID, "--structured-result", resultFile], false);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lock already exists/);
  assert.equal(readDoc(CURRENT).meta.status, "READY");

  setupFixture();
  ready = fillReadyRecoveryTask("recovery-path-escape");
  const escapeFile = path.join(path.dirname(FIXTURE_ROOT), "recovery-escape-" + process.pid + ".json");
  fs.writeFileSync(escapeFile, JSON.stringify({ ...structured, task_id: ready.meta.task_id, handoff_revision: String(ready.meta.handoff_revision) }));
  try {
    r = runner(["recover-code", "--project", PROJECT_ID, "--structured-result", escapeFile], false);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /escapes allowed roots/);
    assert.equal(readDoc(CURRENT).meta.status, "READY");
  } finally {
    fs.rmSync(escapeFile, { force: true });
  }

  setupFixture();
  handoff(["new", "recovery-not-ready", "--type", "code"]);
  fs.writeFileSync(resultFile, JSON.stringify(structured));
  r = runner(["recover-code", "--project", PROJECT_ID, "--structured-result", resultFile], false);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not READY/);
});

test("policy v1 uses normative digests while legacy handoffs keep whole-file freeze", { concurrency: false }, () => {
  assert.equal(
    canonicalPolicyJson({ z: 1, nested: { b: true, a: false }, a: "first" }),
    canonicalPolicyJson({ a: "first", nested: { a: false, b: true }, z: 1 })
  );
  setupFixture();
  const ready = fillReadyTask("policy-v1-normative-freeze", "non_code", "1");
  assert.match(ready.meta.effective_policy_hash, /^[0-9a-f]{64}$/);
  assert.equal(ready.meta.policy_schema_version, "1");
  assert.equal(ready.meta.root_rules_hash, "");

  fs.appendFileSync(path.join(FIXTURE_ROOT, "AGENTS.md"), "\nNon-normative guidance wording changed.\n");
  fs.appendFileSync(path.join(FIXTURE_PROJECT, "AGENTS.md"), "\nProject explanation updated.\n");
  const preflight = parseJsonOutput(runner(["preflight", "--project", PROJECT_ID]));
  assert.equal(preflight.readyForNewLaunch, true);
  assert.equal(preflight.policyIdentity.effective_policy_hash, ready.meta.effective_policy_hash);

  const normativePath = path.join(FIXTURE_ROOT, "collaboration", "policies", "root-policy-v1.md");
  const normativeText = fs.readFileSync(normativePath, "utf8");
  fs.appendFileSync(normativePath, "\nNormative policy update probe.\n");
  const changedPolicy = parseJsonOutput(runner(["preflight", "--project", PROJECT_ID]));
  assert.equal(changedPolicy.preflightStatus, "INVALID_HANDOFF");
  assert.match(changedPolicy.diagnostic, /policy identity mismatch: root_normative_digest/);
  fs.writeFileSync(normativePath, normativeText);

  handoff(["claim"]);
  fs.appendFileSync(normativePath, "\nNew normative restriction.\n");
  const returned = handoff(["return"], false);
  assert.notEqual(returned.status, 0);
  assert.match(returned.stderr, /policy changed after prepare/);

  setupFixture();
  fillReadyTask("legacy-whole-file-freeze");
  fs.appendFileSync(path.join(FIXTURE_ROOT, "AGENTS.md"), "\nLegacy change.\n");
  const legacy = parseJsonOutput(runner(["preflight", "--project", PROJECT_ID]));
  assert.equal(legacy.preflightStatus, "INVALID_HANDOFF");
  assert.match(legacy.diagnostic, /root rules hash mismatch/);
});

test("policy v1 fails closed for unknown schema and root-policy weakening", { concurrency: false }, () => {
  setupFixture();
  const legacy = fillReadyTask("unknown-policy-version");
  legacy.meta.policy_schema_version = "99";
  writeDoc(CURRENT, legacy);
  const unknown = parseJsonOutput(runner(["preflight", "--project", PROJECT_ID]));
  assert.equal(unknown.preflightStatus, "INVALID_HANDOFF");
  assert.match(unknown.diagnostic, /unknown policy_schema_version/);

  setupFixture();
  fillReadyTask("policy-overlay-weakening", "non_code", "1");
  const overlayPath = path.join(FIXTURE_PROJECT, "COLLAB_POLICY.json");
  const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
  overlay.restrictions.forbid_recursive_delegation = false;
  fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));
  const weakened = parseJsonOutput(runner(["preflight", "--project", PROJECT_ID]));
  assert.equal(weakened.preflightStatus, "INVALID_HANDOFF");
  assert.match(weakened.diagnostic, /cannot weaken root restriction/);

  setupFixture();
  fillReadyTask("policy-manifest-missing", "non_code", "1");
  fs.rmSync(path.join(FIXTURE_PROJECT, "COLLAB_POLICY.json"));
  const missingManifest = parseJsonOutput(runner(["preflight", "--project", PROJECT_ID]));
  assert.equal(missingManifest.preflightStatus, "INVALID_HANDOFF");
  assert.match(missingManifest.diagnostic, /missing policy manifest/);
});
