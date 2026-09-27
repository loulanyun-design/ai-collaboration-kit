import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  allowedCodePaths,
  buildCodeSchema,
  materializeCodeResult,
  validateCodeStructuredResult
} from "../src/code.mjs";
import { acceptanceContract, criterionEvidenceSchema, readDoc, validateCriterionEvidence } from "../src/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PILOT = path.resolve(HERE, "..");

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  if (r.status !== 0) {
    throw new Error(cmd + " " + args.join(" ") + " failed:\n" + (r.stderr || r.stdout || ""));
  }
  return String(r.stdout || "").trim();
}

function currentDoc(worktree, base) {
  return {
    meta: {
      codex_worktree: worktree,
      base_commit: base,
      branch: "codex/test-code"
    },
    body: [
      "# Current Handoff",
      "",
      "## Code Allowlist",
      "",
      "- src/astra-code-smoke.mjs",
      "- test/astra-code-smoke.test.mjs",
      ""
    ].join("\n")
  };
}

test("code schema and parent materialization enforce Git allowlist", () => {
  const tmp = path.join(PILOT, "test-tmp", "code-materialize-" + process.pid + "-" + Date.now());
  const formal = path.join(tmp, "project");
  const worktrees = path.join(tmp, "worktrees");
  const wt = path.join(worktrees, "code-wt");

  fs.mkdirSync(formal, { recursive: true });
  run("git", ["init", "-b", "main"], formal);
  run("git", ["config", "user.name", "runner-test"], formal);
  run("git", ["config", "user.email", "runner-test@example.invalid"], formal);
  fs.writeFileSync(path.join(formal, "package.json"), '{"type":"module"}\n', "utf8");
  run("git", ["add", "package.json"], formal);
  run("git", ["commit", "-m", "base"], formal);
  const base = run("git", ["rev-parse", "HEAD"], formal);

  fs.mkdirSync(worktrees, { recursive: true });
  run("git", ["worktree", "add", "-b", "codex/test-code", wt, base], formal);
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  fs.mkdirSync(path.join(wt, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(wt, "src", "astra-code-smoke.mjs"),
    'export function formatCodeSmokeIdentity(taskId, revision) { return "task_id=" + taskId + "\\nrevision=" + revision; }\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(wt, "test", "astra-code-smoke.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; import { formatCodeSmokeIdentity } from "../src/astra-code-smoke.mjs"; test("identity",()=>assert.equal(formatCodeSmokeIdentity("t","1"),"task_id=t\\nrevision=1"));\n',
    "utf8"
  );
  run("git", ["add", "src/astra-code-smoke.mjs", "test/astra-code-smoke.test.mjs"], wt);
  run("git", ["commit", "-m", "test: validate Astra6 code worktree"], wt);

  const resultPath = path.join(formal, "work", "handoffs", "RESULT.md");
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(
    resultPath,
    [
      "---",
      "handoff_version: 3",
      "project_id:",
      "task_id:",
      "task_type:",
      "status: DRAFT",
      "owner: Codex",
      "branch:",
      "base_commit:",
      "result_commit:",
      "next_owner:",
      "updated_at:",
      "---",
      "# Codex Result",
      ""
    ].join("\n"),
    "utf8"
  );

  const current = currentDoc(wt, base);
  assert.deepEqual(allowedCodePaths(current), [
    "src/astra-code-smoke.mjs",
    "test/astra-code-smoke.test.mjs"
  ]);

  const job = {
    projectId: "fixture",
    taskId: "task-code-1",
    revision: "1",
    taskType: "code"
  };
  const schema = buildCodeSchema({ job, current });
  assert.deepEqual(schema.properties.changed_files.items.enum, [
    "src/astra-code-smoke.mjs",
    "test/astra-code-smoke.test.mjs"
  ]);
  assert.equal("uniqueItems" in schema.properties.changed_files, false);
  assert.deepEqual(schema.properties.task_id.enum, ["task-code-1"]);
  assert.deepEqual(schema.properties.handoff_revision.enum, ["1"]);

  const structured = {
    task_id: "task-code-1",
    handoff_revision: "1",
    completion_basis: "Created the allowlisted smoke helper and test, ran checks, and committed.",
    evidence: ["worktree commit created"],
    changed_files: [
      "src/astra-code-smoke.mjs",
      "test/astra-code-smoke.test.mjs"
    ],
    tests: {
      targeted: ["node --test test/astra-code-smoke.test.mjs passed"],
      regression: ["npm test passed"],
      safety: ["git status clean after commit"]
    },
    remaining_risks: [],
    scope_check: {
      unrelated_business_rules_changed: false,
      formal_branch_modified_directly: false,
      validation_weakened: false,
      side_effect_policy_exceeded: false,
      unrelated_files_modified: false
    }
  };

  assert.throws(
    () => materializeCodeResult({
      job,
      project: { root: formal, result: resultPath },
      current,
      structured: {
        ...structured,
        changed_files: [
          "src/astra-code-smoke.mjs",
          "src/astra-code-smoke.mjs"
        ]
      },
      codexRuntime: { source: "isolated", version: "0.155.1" }
    }),
    /changed_files do not match actual Git diff/
  );

  const out = materializeCodeResult({
    job,
    project: { root: formal, result: resultPath },
    current,
    structured,
    codexRuntime: { source: "isolated", version: "0.155.1" }
  });

  assert.match(out.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(out.changedFiles.sort(), structured.changed_files.slice().sort());
  const result = readDoc(resultPath);
  assert.equal(result.meta.task_id, "task-code-1");
  assert.equal(result.meta.handoff_revision, "1");
  assert.equal(result.meta.result_commit, out.commit);

  assert.throws(
    () => allowedCodePaths({
      meta: {},
      body: "# Current Handoff\n\n## Code Allowlist\n\n- ../escape.js\n"
    }),
    /escapes worktree/
  );

  run("git", ["worktree", "remove", wt, "--force"], formal);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("acceptance criteria coverage and capability gates are deterministic", () => {
  const current = { body: "## Acceptance Capabilities\n\n- UI_REQUIRED\n- UI_INTERACTION\n- SCRIPT_E2E\n\n## Acceptance Criteria\n\n- C1: rendered\n- C2: interacted\n" };
  assert.deepEqual(acceptanceContract(current).criteria.map((item) => item.id), ["C1", "C2"]);
  const criterionSchema = criterionEvidenceSchema(current);
  assert.deepEqual(criterionSchema.items.properties.criterion_id.enum, ["C1", "C2"]);
  const evidenceItemSchema = criterionSchema.items.properties.evidence.items;
  assert.deepEqual(evidenceItemSchema.required, ["type", "reference", "scenario", "executed"]);
  assert.deepEqual(evidenceItemSchema.properties.scenario.type, ["string", "null"]);
  assert.deepEqual(evidenceItemSchema.properties.executed.type, ["boolean", "null"]);
  const valid = { criterion_evidence: [
    { criterion_id: "C1", evidence: [{ type: "render", reference: "render log", scenario: null, executed: null }, { type: "screenshot", reference: "shot.png", scenario: null, executed: null }, { type: "executed_test", reference: "exit 0", scenario: "final scene", executed: true }] },
    { criterion_id: "C2", evidence: [{ type: "interaction", reference: "click trace", scenario: null, executed: null }] }
  ] };
  assert.doesNotThrow(() => validateCriterionEvidence(current, valid));
  assert.throws(() => validateCriterionEvidence(current, { criterion_evidence: valid.criterion_evidence.slice(0, 1) }), /exactly cover/);
  assert.throws(() => validateCriterionEvidence(current, { criterion_evidence: valid.criterion_evidence.map((item) => ({ ...item, evidence: item.evidence.filter((e) => e.type !== "screenshot") })) }), /screenshot/);
  assert.throws(() => acceptanceContract({ body: "## Acceptance Criteria\n\n- C1: one\n- C1: two\n" }), /duplicate/);
  assert.throws(() => acceptanceContract({ body: "## Acceptance Criteria\n\n- missing id\n" }), /ID: description/);
  assert.deepEqual(acceptanceContract({ body: "# ordinary task\n" }), { capabilities: [], criteria: [] });
});

test("recovery code structured results require the complete safe shape", () => {
  const valid = {
    task_id: "t", handoff_revision: "1", completion_basis: "done", evidence: ["evidence ok"], criterion_evidence: [], changed_files: ["a"],
    tests: { targeted: ["targeted ok"], regression: ["regression ok"], safety: ["safety ok"] }, remaining_risks: [],
    scope_check: { unrelated_business_rules_changed: false, formal_branch_modified_directly: false, validation_weakened: false, side_effect_policy_exceeded: false, unrelated_files_modified: false }
  };
  assert.equal(validateCodeStructuredResult(valid), valid);
  assert.throws(() => validateCodeStructuredResult({ ...valid, prompt: "free form" }), /invalid fields/);
  assert.throws(() => validateCodeStructuredResult({ ...valid, evidence: [] }), /invalid item count/);
  assert.throws(() => validateCodeStructuredResult({ ...valid, tests: { ...valid.tests, regression: [] } }), /invalid item count/);
  assert.throws(() => validateCodeStructuredResult({ ...valid, scope_check: { ...valid.scope_check, validation_weakened: true } }), /only false/);
});
