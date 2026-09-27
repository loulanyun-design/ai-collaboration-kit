import fs from "node:fs";
import path from "node:path";
import { readDoc, writeDoc, nowIso } from "../lib.mjs";

function fillResult(resultPath, job, deliverablePath) {
  const doc = readDoc(resultPath);
  doc.meta.project_id = job.projectId;
  doc.meta.task_id = job.taskId;
  doc.meta.handoff_revision = job.revision;
  doc.meta.task_type = job.taskType;
  doc.meta.status = "DRAFT";
  doc.meta.owner = "Codex";
  doc.meta.next_owner = "";
  doc.meta.updated_at = nowIso();
  doc.body = [
    "# Codex Result",
    "",
    "## Root Cause / Completion Basis",
    "",
    "Fake executor completed the delegated pilot task without calling an AI model.",
    "",
    "## Evidence",
    "",
    "- Fake executor mode: success",
    "- Matching task_id/revision recorded by the executor.",
    "",
    "## Changes",
    "",
    "- Files: no product code changes.",
    "- Summary: pilot-only fake execution.",
    "",
    "## Deliverables",
    "",
    "- " + deliverablePath,
    "",
    "## Acceptance Evidence",
    "",
    "- Deliverable exists and contains task_id " + job.taskId + ".",
    "",
    "## Tests",
    "",
    "### Targeted",
    "- Fake execution path completed.",
    "",
    "### Regression",
    "- No unrelated project files modified by the fake executor.",
    "",
    "### Safety / non-regression",
    "- No model, network service, merge, push, or real business system was used.",
    "",
    "## Remaining Risks / Unknowns",
    "",
    "- This result validates only the fake executor path.",
    "",
    "## Scope Check",
    "",
    "- Unrelated business rules changed: NO",
    "- Formal branch modified directly: NO",
    "- Validation weakened to make tests pass: NO",
    "- Side-effect policy exceeded: NO",
    "- Unrelated files modified: NO",
    "",
    "## Handoff Back",
    "",
    "- Next owner: ChatGPT",
    "- ChatGPT should verify:",
    "  1. Runner external state reaches SUCCEEDED only after handoff REVIEW.",
    "  2. task_id/revision match.",
    ""
  ].join("\n");
  writeDoc(resultPath, doc);
}

export async function runFakeExecutor(ctx) {
  const mode = ctx.mode || "success";
  if (!["success", "fail", "timeout", "pseudo_success", "crash", "quota"].includes(mode)) {
    throw new Error("unsupported fake mode: " + mode);
  }

  if (mode === "fail") {
    throw new Error("fake executor requested failure");
  }

  if (mode === "timeout") {
    await new Promise(() => {});
    return { exitCode: 0, stdout: "fake timeout unexpectedly returned", stderr: "" };
  }

  if (mode === "crash") {
    process.exit(97);
  }

  if (mode === "quota") {
    const err = new Error("fake executor quota pause");
    err.code = "EXECUTOR_QUOTA";
    throw err;
  }

  if (mode === "pseudo_success") {
    return { exitCode: 0, stdout: "fake process exited 0 without a valid RESULT", stderr: "" };
  }

  const deliverableDir = path.join(ctx.project.root, "deliverables");
  fs.mkdirSync(deliverableDir, { recursive: true });
  const deliverablePath = path.join(deliverableDir, "fake-" + ctx.job.taskId + ".txt");
  fs.writeFileSync(
    deliverablePath,
    "fake executor deliverable\n" +
      "task_id=" + ctx.job.taskId + "\n" +
      "revision=" + ctx.job.revision + "\n",
    "utf8"
  );
  fillResult(ctx.project.result, ctx.job, deliverablePath);
  return { exitCode: 0, stdout: "fake success\n" + deliverablePath, stderr: "" };
}
