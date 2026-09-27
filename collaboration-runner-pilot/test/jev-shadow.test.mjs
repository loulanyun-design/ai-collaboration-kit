import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildJevShadowQuestion,
  runJevShadowSet
} from "../src/jev-shadow.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PILOT = path.resolve(HERE, "..");

function currentDoc() {
  return {
    meta: {
      project_id: "pilot",
      task_id: "shadow-task",
      handoff_revision: "1",
      task_type: "code",
      status: "IN_PROGRESS"
    },
    body: [
      "# Current Handoff",
      "",
      "## Goal",
      "",
      "Automate a browser workflow safely.",
      "",
      "## State Machine / Intended Flow",
      "",
      "READY -> IN_PROGRESS -> REVIEW.",
      "",
      "## Codex Technical Acceptance",
      "",
      "- [ ] Browser automation is tested.",
      "",
      "## ChatGPT Business Acceptance",
      "",
      "- [ ] No production side effect.",
      "",
      "## Stop Conditions",
      "",
      "- Stop on scope expansion."
    ].join("\n")
  };
}

test("Jev shadow records three advisory decisions without changing terminal runner state", async () => {
  const root = path.join(PILOT, "test-tmp", "jev-shadow-unit-" + process.pid);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const jobFile = path.join(root, "job.json");
  const job = {
    jobId: "shadow-job",
    jobDir: root,
    jobFile,
    projectId: "pilot",
    taskId: "shadow-task",
    revision: "1",
    taskType: "code",
    state: "SUCCEEDED",
    phase: "completed",
    handoffState: "REVIEW",
    executorExitCode: 0
  };
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2) + "\n", "utf8");

  const skillCatalog = [
    { name: "playwright", description: "Automate a real browser." },
    { name: "pdf", description: "Work with PDF documents." }
  ];
  const asked = [];
  const runner = async (options) => {
    asked.push(options);
    if (/primary installed skill/i.test(options.instructions)) {
      return { choice: "playwright", accepted: true, source: "test", reason: "classified", confidence: 0.94 };
    }
    if (/meaningful progress/i.test(options.instructions)) {
      return { choice: "ADVANCING", accepted: true, source: "test", reason: "classified", confidence: 0.92 };
    }
    return { choice: "COMPLETE", accepted: true, source: "test", reason: "classified", confidence: 0.90 };
  };

  try {
    const current = currentDoc();
    const resultDoc = {
      meta: { status: "DRAFT", next_owner: "ChatGPT" },
      body: [
        "# Codex Result",
        "",
        "## Root Cause / Completion Basis",
        "",
        "The browser workflow was implemented and tested.",
        "",
        "## Acceptance Evidence",
        "",
        "- Browser test passed.",
        "",
        "## Tests",
        "",
        "- targeted: pass",
        "",
        "## Remaining Risks / Unknowns",
        "",
        "- None.",
        "",
        "## Scope Check",
        "",
        "- Side-effect policy exceeded: NO"
      ].join("\n")
    };

    const skillQuestion = buildJevShadowQuestion("skill", {
      job,
      current,
      resultDoc,
      skillCatalog,
      config: { maxSkills: 40 }
    });
    assert.ok(skillQuestion.criteria.playwright);
    assert.ok(skillQuestion.criteria.NONE);

    const output = await runJevShadowSet({
      jobFile,
      current,
      resultDoc,
      executorResult: {
        structuredResult: {
          completion_basis: "implemented",
          evidence: ["test passed"],
          changed_files: ["src/example.mjs"],
          tests: { targeted: ["pass"] },
          remaining_risks: []
        }
      },
      config: {
        enabled: true,
        kinds: { skill: true, progress: true, completion: true },
        minConfidence: 0.01,
        timeoutMs: 1000,
        maxSkills: 40
      },
      runner,
      skillCatalog
    });

    assert.equal(output.enabled, true);
    assert.equal(output.events.length, 3);
    assert.equal(asked.length, 3);
    assert.deepEqual(output.events.map((x) => x.kind), ["skill", "progress", "completion"]);
    assert.deepEqual(output.events.map((x) => x.choice), ["playwright", "ADVANCING", "COMPLETE"]);

    const after = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    assert.equal(after.state, "SUCCEEDED");
    assert.equal(after.phase, "completed");
    assert.equal(after.jevShadowEnabled, true);
    assert.equal(after.jevShadowLatest.skill.choice, "playwright");
    assert.equal(after.jevShadowLatest.progress.choice, "ADVANCING");
    assert.equal(after.jevShadowLatest.completion.choice, "COMPLETE");

    const logLines = fs.readFileSync(path.join(root, "jev-shadow.jsonl"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(logLines.length, 3);
    assert.ok(logLines.every((event) => event.stateHash && event.inputBytes > 0));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
