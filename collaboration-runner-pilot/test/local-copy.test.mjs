import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readDoc, writeDoc } from "../src/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PILOT = path.resolve(HERE, "..");
const RUNNER = path.join(PILOT, "src", "runner.mjs");
const ROOT = path.join(PILOT, "test-tmp", "local-copy-" + process.pid);
const PROJECT = path.join(ROOT, "fixture-project");
const CURRENT = path.join(PROJECT, "work", "handoffs", "current.md");
const HANDOFF = path.join(ROOT, "collaboration", "handoff.mjs");
const ENV = { ...process.env, NODE_ENV: "test", COLLAB_RUNNER_TEST_ROOT: ROOT, COLLAB_RUNNER_CHILD: "0" };
const PROJECT_ID = "local-copy-fixture";

function sourceCollaborationDir() {
  let dir = PILOT;
  while (true) {
    const candidate = path.join(dir, "collaboration");
    if (fs.existsSync(path.join(candidate, "handoff.mjs"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("collaboration dir not found");
    dir = parent;
  }
}

function run(script, args, expectOk = true) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: PILOT,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: ENV
  });
  if (expectOk && r.status !== 0) throw new Error(r.stderr + "\n" + r.stdout);
  return r;
}

function handoff(args, expectOk = true) {
  return run(HANDOFF, ["--project", PROJECT_ID, ...args], expectOk);
}

function runner(args, expectOk = true) {
  return run(RUNNER, args, expectOk);
}

function setup() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "collaboration", "templates"), { recursive: true });
  fs.mkdirSync(path.dirname(CURRENT), { recursive: true });
  const collab = sourceCollaborationDir();
  fs.copyFileSync(path.join(collab, "handoff.mjs"), HANDOFF);
  fs.copyFileSync(path.join(collab, "policy.mjs"), path.join(ROOT, "collaboration", "policy.mjs"));
  for (const name of ["CURRENT_TEMPLATE.md", "RESULT_TEMPLATE.md"]) {
    fs.copyFileSync(path.join(collab, "templates", name), path.join(ROOT, "collaboration", "templates", name));
  }
  fs.writeFileSync(path.join(ROOT, "AGENTS.md"), "# root\n");
  fs.writeFileSync(path.join(PROJECT, "AGENTS.md"), "# project\n");
  fs.writeFileSync(path.join(ROOT, "collaboration", "projects.json"), JSON.stringify({
    projects: [{
      id: PROJECT_ID,
      path: PROJECT,
      enabled: true,
      project_rules: "AGENTS.md",
      handoff_dir: "work\\handoffs"
    }]
  }, null, 2));
}

function prepareCopyTask(source, destination = "scripts\\legacy\\copied.py") {
  handoff(["new", "deterministic-local-copy", "--type", "non_code"]);
  const doc = readDoc(CURRENT);
  doc.body = [
    "# Current Handoff", "",
    "## Goal", "", "Copy one frozen legacy text asset without a model.", "",
    "## State Machine / Intended Flow", "", "READY -> local_copy -> REVIEW.", "",
    "## Confirmed Facts", "", "- Source is a fixture file.", "",
    "## Read-only Source Roots", "", "- " + ROOT, "",
    "## Deterministic Local Copy Sources", "", "- d1 -> " + source, "",
    "## Delegated Scope", "", "- Copy only the declared source to the declared legacy deliverable.", "",
    "## Codex Technical Acceptance", "", "- [ ] Exact bytes are preserved.", "",
    "## ChatGPT Business Acceptance", "", "- [ ] Target hash equals source hash.", "",
    "## Deliverables", "", "- fixture-copy -> " + destination, "",
    "## Side-effect Notes", "", "No network, model, shell write, or external side effect.", "",
    "## Stop Conditions", "", "- Stop on path, hash, or overwrite mismatch.", ""
  ].join("\n");
  writeDoc(CURRENT, doc);
  handoff(["prepare"]);
}

async function waitJob(jobId, wanted, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = JSON.parse(runner(["status", "--job", jobId]).stdout);
    if (wanted.includes(last.observedState)) return last;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("timeout waiting for job: " + JSON.stringify(last));
}

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("runner auto-selects deterministic local-copy and verifies exact bytes", { concurrency: false }, async () => {
  setup();
  const sourceDir = path.join(ROOT, "source");
  fs.mkdirSync(sourceDir, { recursive: true });
  const source = path.join(sourceDir, "legacy.py");
  fs.writeFileSync(source, "import os\n# historical text only\nexample = \"sftp.put('local','remote')\"\n", "utf8");
  prepareCopyTask(source);

  const submitted = JSON.parse(runner(["submit", "--project", PROJECT_ID]).stdout);
  assert.equal(submitted.executor, "local_copy");
  assert.equal(submitted.modelRequested, "none");

  const terminal = await waitJob(submitted.jobId, ["SUCCEEDED", "FAILED", "BLOCKED"]);
  assert.equal(terminal.observedState, "SUCCEEDED");
  assert.equal(terminal.handoff.status, "REVIEW");
  assert.equal(terminal.executor, "local_copy");
  assert.equal(terminal.modelRequested, "none");
  assert.equal(terminal.localCopyVerification?.length, 1);

  const target = path.join(PROJECT, "scripts", "legacy", "copied.py");
  assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(source, "utf8"));
  assert.equal(sha(target), sha(source));
});

test("deterministic local-copy refuses a differing existing target", { concurrency: false }, async () => {
  setup();
  const sourceDir = path.join(ROOT, "source");
  fs.mkdirSync(sourceDir, { recursive: true });
  const source = path.join(sourceDir, "legacy.py");
  fs.writeFileSync(source, "source-content\n", "utf8");
  const target = path.join(PROJECT, "scripts", "legacy", "copied.py");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "different-existing-content\n", "utf8");
  prepareCopyTask(source);

  const submitted = JSON.parse(runner(["submit", "--project", PROJECT_ID]).stdout);
  const terminal = await waitJob(submitted.jobId, ["FAILED", "BLOCKED"]);
  assert.equal(terminal.observedState, "FAILED");
  assert.match(String(terminal.failureMessage), /different content/);
  assert.equal(fs.readFileSync(target, "utf8"), "different-existing-content\n");
  assert.equal(terminal.handoff.status, "BLOCKED");
});
