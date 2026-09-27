import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  allowedNonCodeDeliverablePaths,
  allowedNonCodeReadRoots,
  buildReadOnlyEvidenceBundle,
  buildNonCodePrompt,
  buildNonCodeSchema,
  materializeNonCodeResult
} from "../src/noncode.mjs";
import { approveArtifact, readArtifactManifest, readDoc } from "../src/lib.mjs";

const TMP = path.join(os.tmpdir(), "collaboration-runner-noncode-" + process.pid);
const PROJECT = path.join(TMP, "project");
const RESULT = path.join(PROJECT, "work", "handoffs", "RESULT.md");
const OUT = path.join(PROJECT, "deliverables", "sample.txt");
const SOURCE = path.join(TMP, "source-project");

function reset() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(RESULT), { recursive: true });
  fs.writeFileSync(
    RESULT,
    [
      "---",
      "handoff_version: 3",
      "project_id: fixture",
      "task_id:",
      "task_type: non_code",
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
}

test("structured non-code output is path constrained and materialized by parent", () => {
  reset();

  const project = {
    id: "fixture",
    root: PROJECT,
    rules: path.join(PROJECT, "AGENTS.md"),
    current: path.join(PROJECT, "work", "handoffs", "current.md"),
    result: RESULT
  };

  const current = {
    meta: {
      task_id: "fixture-task",
      handoff_revision: "2",
      task_type: "non_code"
    },
    body: [
      "# Current Handoff",
      "",
      "## Read-only Source Roots",
      "",
      "- " + SOURCE,
      "",
      "## Read-only Search Terms",
      "",
      "- needle",
      "",
      "## Deliverables",
      "",
      "- " + OUT,
      "- " + RESULT,
      ""
    ].join("\n")
  };

  const job = {
    projectId: "fixture",
    taskId: "fixture-task",
    revision: "2",
    taskType: "non_code",
    modelRequested: "gpt-5.6-sol"
  };

  const readRoots = allowedNonCodeReadRoots(current, project);
  assert.deepEqual(readRoots, [path.resolve(SOURCE)]);

  const paths = allowedNonCodeDeliverablePaths(current, project);
  assert.deepEqual(paths, [path.resolve(OUT)]);

  fs.mkdirSync(SOURCE, { recursive: true });
  fs.writeFileSync(path.join(SOURCE, "generic-note.md"), "needle evidence content\n", "utf8");
  fs.mkdirSync(path.join(SOURCE, ".private"), { recursive: true });
  fs.writeFileSync(path.join(SOURCE, ".private", "needle-secret.txt"), "must not appear\n", "utf8");
  fs.writeFileSync(path.join(PROJECT, "AGENTS.md"), "# fixture\n", "utf8");
  fs.writeFileSync(project.current, "---\n---\n" + current.body, "utf8");
  const bundle = buildReadOnlyEvidenceBundle(current, project);
  assert.equal(bundle.hits, 1);
  assert.match(bundle.text, /generic-note\.md/);
  assert.match(bundle.text, /Matched by: content/);
  assert.match(bundle.text, /needle evidence content/);
  assert.doesNotMatch(bundle.text, /must not appear/);

  const fallbackCurrent = {
    ...current,
    body: current.body.replace(
      /## Read-only Search Terms[\s\S]*?## Deliverables/,
      "## Evidence References\n\n- Relevant files: generic-note.md\n\n## Deliverables"
    )
  };
  const fallbackBundle = buildReadOnlyEvidenceBundle(fallbackCurrent, project);
  assert.equal(fallbackBundle.hits, 1);
  assert.match(fallbackBundle.text, /generic-note\.md/);

  const prompt = buildNonCodePrompt({
    current,
    project,
    job,
    rootRules: path.join(PROJECT, "AGENTS.md")
  });
  assert.match(prompt, /parent runner has already performed the permitted read-only local discovery/i);
  assert.match(prompt, /Allowed read-only source roots:/);
  assert.match(prompt, /READ_ONLY_EVIDENCE_BUNDLE/);
  assert.match(prompt, /needle evidence content/);
  assert.ok(prompt.includes(path.resolve(SOURCE)));

  const schema = buildNonCodeSchema({ current, project, job });
  assert.deepEqual(schema.properties.task_id.enum, ["fixture-task"]);
  assert.deepEqual(schema.properties.handoff_revision.enum, ["2"]);
  assert.deepEqual(
    schema.properties.deliverables.items.properties.id.enum,
    ["d1"]
  );
  assert.equal(
    schema.properties.deliverables.items.properties.content.minLength,
    1
  );

  const structured = {
    task_id: "fixture-task",
    handoff_revision: "2",
    completion_basis: "Generated the requested isolated fixture.",
    evidence: ["Task identity matched the embedded handoff."],
    deliverables: [{ id: "d1", content: "task_id=fixture-task\n" }],
    acceptance_evidence: ["Deliverable content contains fixture-task."],
    tests: {
      targeted: ["Structured output matched the schema."],
      regression: ["No unrelated fixture file changed."],
      safety: ["Only the allowlisted path was materialized."]
    },
    retrieval_evidence: [],
    remaining_risks: [],
    scope_check: {
      unrelated_business_rules_changed: false,
      formal_branch_modified_directly: false,
      validation_weakened: false,
      side_effect_policy_exceeded: false,
      unrelated_files_modified: false
    }
  };

  const materialized = materializeNonCodeResult({
    job,
    project,
    current,
    structured,
    codexRuntime: { source: "isolated", version: "0.155.1" }
  });

  assert.deepEqual(materialized.deliverablePaths, [path.resolve(OUT)]);
  assert.equal(fs.readFileSync(OUT, "utf8"), "task_id=fixture-task\n");

  const result = readDoc(RESULT);
  assert.equal(result.meta.task_id, "fixture-task");
  assert.equal(result.meta.handoff_revision, "2");
  assert.equal(result.meta.status, "DRAFT");
  assert.match(result.body, /isolated 0\.155\.1/);
  assert.match(result.body, /model: gpt-5\.6-sol/);
  assert.doesNotMatch(result.body, /model: gpt-6-astra/);
  assert.match(result.body, /Acceptance Evidence/);

  const mapped = {
    ...current,
    body: [
      "# Current Handoff",
      "",
      "## Deliverables",
      "",
      "- architecture_review -> `deliverables/ASTRA_COLLABORATION_ARCHITECTURE_REVIEW.md`",
      ""
    ].join("\n")
  };
  assert.deepEqual(
    allowedNonCodeDeliverablePaths(mapped, project),
    [path.resolve(PROJECT, "deliverables", "ASTRA_COLLABORATION_ARCHITECTURE_REVIEW.md")]
  );

  const mappedPaths = allowedNonCodeDeliverablePaths(mapped, project);
  fs.mkdirSync(path.dirname(mappedPaths[0]), { recursive: true });
  fs.writeFileSync(mappedPaths[0], "candidate\n", "utf8");
  const mappedJob = { ...job, revision: "3", taskId: "artifact-task" };
  materializeNonCodeResult({
    job: mappedJob, project, current: mapped,
    structured: { ...structured, task_id: "artifact-task", handoff_revision: "3", deliverables: [{ id: "d1", content: "candidate\n" }] },
    codexRuntime: null
  });
  let manifest = readArtifactManifest(project);
  assert.equal(manifest.artifacts[0].status, "candidate");
  assert.deepEqual(manifest.current, {});
  const candidate = manifest.artifacts[0];
  assert.match(candidate.version, /^r3-[a-f0-9]{12}-[a-f0-9]{12}$/);
  assert.throws(() => approveArtifact(project, { logical_id: "architecture_review", version: candidate.version, relative_path: "wrong.md", content_hash: candidate.content_hash, approval_ref: "user-1" }), /path\/hash mismatch/);
  approveArtifact(project, { logical_id: candidate.logical_id, version: candidate.version, relative_path: candidate.relative_path, content_hash: candidate.content_hash, approval_ref: "user-1" });
  manifest = readArtifactManifest(project);
  assert.equal(manifest.artifacts[0].status, "approved");
  assert.equal(manifest.current.architecture_review.version, candidate.version);

  const escaped = {
    ...current,
    body: [
      "# Current Handoff",
      "",
      "## Deliverables",
      "",
      "- " + path.resolve(PROJECT, "..", "escape.txt"),
      ""
    ].join("\n")
  };
  assert.throws(
    () => allowedNonCodeDeliverablePaths(escaped, project),
    /escapes project root/
  );

  const readEscape = {
    ...current,
    body: [
      "# Current Handoff",
      "",
      "## Read-only Source Roots",
      "",
      "- " + path.resolve(TMP, "..", "outside"),
      "",
      "## Deliverables",
      "",
      "- " + OUT,
      ""
    ].join("\n")
  };
  assert.throws(
    () => allowedNonCodeReadRoots(readEscape, project),
    /outside approved research roots/
  );

  const privateRead = {
    ...current,
    body: [
      "# Current Handoff",
      "",
      "## Read-only Source Roots",
      "",
      "- " + path.join(TMP, ".private"),
      "",
      "## Deliverables",
      "",
      "- " + OUT,
      ""
    ].join("\n")
  };
  assert.throws(
    () => allowedNonCodeReadRoots(privateRead, project),
    /may not include \.private/
  );

  const wrong = { ...structured, handoff_revision: "3" };
  assert.throws(
    () => materializeNonCodeResult({
      job,
      project,
      current,
      structured: wrong,
      codexRuntime: { source: "isolated", version: "0.155.1" }
    }),
    /revision mismatch/
  );
});
