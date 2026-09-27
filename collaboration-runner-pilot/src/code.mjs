import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  isWithin,
  criterionEvidenceSchema,
  normalizePath,
  nowIso,
  readDoc,
  writeDoc,
  validateCriterionEvidence
} from "./lib.mjs";

function section(body, heading) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const target = "## " + heading;
  const start = lines.findIndex((line) => line.trim() === target);
  if (start < 0) return "";
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

function bulletValues(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .map((line) => line.replace(/^\x60|\x60$/g, "").trim())
    .filter(Boolean);
}

function normalizeRelative(value) {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  if (!raw || path.posix.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error("code allowlist path must be relative: " + value);
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("code allowlist path escapes worktree: " + value);
  }
  return normalized;
}

export function allowedCodePaths(current) {
  const values = bulletValues(section(current.body, "Code Allowlist"));
  if (values.length === 0) {
    throw new Error("code task requires a non-empty ## Code Allowlist section");
  }
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const rel = normalizeRelative(value);
    if (seen.has(rel.toLowerCase())) throw new Error("duplicate code allowlist path: " + rel);
    seen.add(rel.toLowerCase());
    out.push(rel);
  }
  return out;
}

export function buildCodeSchema(ctx) {
  const allowed = allowedCodePaths(ctx.current);
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      task_id: { type: "string", enum: [ctx.job.taskId] },
      handoff_revision: { type: "string", enum: [ctx.job.revision] },
      completion_basis: { type: "string", minLength: 1, maxLength: 8000 },
      evidence: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: { type: "string", minLength: 1, maxLength: 4000 }
      },
      criterion_evidence: criterionEvidenceSchema(ctx.current),
      changed_files: {
        type: "array",
        minItems: allowed.length,
        maxItems: allowed.length,
        items: { type: "string", enum: allowed }
      },
      tests: {
        type: "object",
        additionalProperties: false,
        properties: {
          targeted: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: 2000 }
          },
          regression: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: 2000 }
          },
          safety: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: { type: "string", minLength: 1, maxLength: 2000 }
          }
        },
        required: ["targeted", "regression", "safety"]
      },
      remaining_risks: {
        type: "array",
        maxItems: 16,
        items: { type: "string", minLength: 1, maxLength: 2000 }
      },
      scope_check: {
        type: "object",
        additionalProperties: false,
        properties: {
          unrelated_business_rules_changed: { type: "boolean", enum: [false] },
          formal_branch_modified_directly: { type: "boolean", enum: [false] },
          validation_weakened: { type: "boolean", enum: [false] },
          side_effect_policy_exceeded: { type: "boolean", enum: [false] },
          unrelated_files_modified: { type: "boolean", enum: [false] }
        },
        required: [
          "unrelated_business_rules_changed",
          "formal_branch_modified_directly",
          "validation_weakened",
          "side_effect_policy_exceeded",
          "unrelated_files_modified"
        ]
      }
    },
    required: [
      "task_id",
      "handoff_revision",
      "completion_basis",
      "evidence",
      "criterion_evidence",
      "changed_files",
      "tests",
      "remaining_risks",
      "scope_check"
    ]
  };
}

export function buildCodePrompt(ctx) {
  const rootRules = fs.readFileSync(ctx.rootRules, "utf8");
  const projectRules = fs.readFileSync(ctx.project.rules, "utf8");
  const currentText = fs.readFileSync(ctx.project.current, "utf8");
  const allowed = allowedCodePaths(ctx.current);

  return [
    "You are executing one already-claimed CODE collaboration task.",
    "",
    "All collaboration rules and handoff context are embedded below.",
    "Do not use the formal project working tree. Work only inside the current working directory, which is the already-created delegated Git worktree.",
    "Do not launch Codex, runner, MCP, browser automation, another agent, or any recursive delegation.",
    "Do not merge or push.",
    "",
    "Task identity:",
    "- project_id: " + ctx.job.projectId,
    "- task_id: " + ctx.job.taskId,
    "- handoff_revision: " + ctx.job.revision,
    "- model requested by parent: " + String(ctx.job.modelRequested || "unknown"),
    "",
    "Machine-enforced code allowlist:",
    allowed.map((p) => "- " + p).join("\n"),
    "",
    "You MUST:",
    "- Modify only the allowlisted files in this worktree.",
    "- Run the targeted/regression/safety checks required by CURRENT HANDOFF.",
    "- Commit the completed work in this worktree.",
    "- Leave the worktree clean after the commit.",
    "- Return only the JSON object required by the output schema.",
    "- Report only tests you actually ran.",
    "",
    "You MUST NOT:",
    "- Write RESULT.md yourself.",
    "- Write any file in the formal project working tree.",
    "- Change existing files outside the allowlist.",
    "- Use a fallback model.",
    "",
    "ROOT RULES:",
    "<<<ROOT_RULES",
    rootRules,
    "ROOT_RULES",
    "",
    "PROJECT RULES:",
    "<<<PROJECT_RULES",
    projectRules,
    "PROJECT_RULES",
    "",
    "CURRENT HANDOFF:",
    "<<<CURRENT_HANDOFF",
    currentText,
    "CURRENT_HANDOFF",
    "",
    "The parent worker will independently verify the actual Git commit, clean status, and changed-file allowlist, then generate RESULT.md."
  ].join("\n");
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  if (r.status !== 0) {
    throw new Error("git " + args.join(" ") + " failed: " + String(r.stderr || r.stdout || "").trim());
  }
  return String(r.stdout || "").trim();
}

function listLines(items, fallback = "- None.") {
  if (!Array.isArray(items) || items.length === 0) return fallback;
  return items.map((item) => "- " + String(item)).join("\n");
}

export function materializeCodeResult({ job, project, current, structured, codexRuntime }) {
  if (!structured || typeof structured !== "object") {
    throw new Error("structured code result is missing");
  }
  if (String(structured.task_id || "") !== job.taskId) {
    throw new Error("structured code result task_id mismatch");
  }
  if (String(structured.handoff_revision || "") !== job.revision) {
    throw new Error("structured code result revision mismatch");
  }
  validateCriterionEvidence(current, structured);

  const worktree = normalizePath(current.meta.codex_worktree || "");
  if (!worktree || !fs.existsSync(worktree)) throw new Error("code worktree is missing");
  if (!isWithin(path.join(project.root, "..", "worktrees"), worktree) &&
      !isWithin(path.join(path.dirname(project.root), "worktrees"), worktree)) {
    // The normal root-level worktree location is validated by prepare/claim.
    // This guard keeps materialization from inspecting arbitrary paths.
    const expectedRoot = normalizePath(path.join(path.dirname(project.root), "worktrees"));
    if (!isWithin(expectedRoot, worktree)) throw new Error("code worktree escapes expected root");
  }

  const status = git(["status", "--porcelain"], worktree);
  if (status) throw new Error("code worktree is not clean after executor commit");

  const head = git(["rev-parse", "HEAD"], worktree);
  const base = String(current.meta.base_commit || "");
  if (!head || head === base) throw new Error("code task produced no commit");

  const actual = git(["diff", "--name-only", base + ".." + head], worktree)
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/\\/g, "/"))
    .filter(Boolean);

  const allowed = allowedCodePaths(current);
  const actualSorted = [...actual].sort();
  const allowedSorted = [...allowed].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(allowedSorted)) {
    throw new Error("actual code changes do not match Code Allowlist: " + actualSorted.join(", "));
  }

  const reported = Array.isArray(structured.changed_files)
    ? structured.changed_files.map((s) => String(s).replace(/\\/g, "/")).sort()
    : [];
  if (JSON.stringify(reported) !== JSON.stringify(actualSorted)) {
    throw new Error("structured changed_files do not match actual Git diff");
  }

  const commitMessage = git(["log", "-1", "--pretty=%s"], worktree);
  const resultDoc = readDoc(project.result);
  resultDoc.meta.project_id = job.projectId;
  resultDoc.meta.task_id = job.taskId;
  resultDoc.meta.handoff_revision = job.revision;
  resultDoc.meta.task_type = job.taskType;
  resultDoc.meta.status = "DRAFT";
  resultDoc.meta.owner = "Codex";
  resultDoc.meta.branch = String(current.meta.branch || "");
  resultDoc.meta.base_commit = base;
  resultDoc.meta.result_commit = head;
  resultDoc.meta.next_owner = "";
  resultDoc.meta.updated_at = nowIso();

  const runtimeLine = codexRuntime
    ? "Codex runtime: " + codexRuntime.source + " " + codexRuntime.version + "; model: " + String(job.modelRequested || "unknown") + "."
    : "Codex runtime metadata unavailable.";

  resultDoc.body = [
    "# Codex Result",
    "",
    "## Root Cause / Completion Basis",
    "",
    String(structured.completion_basis || ""),
    "",
    "## Evidence",
    "",
    "- " + runtimeLine,
    "- Verified result commit: " + head,
    "- Verified commit message: " + commitMessage,
    "- Verified clean worktree after commit.",
    listLines(structured.evidence),
    "",
    "## Changes",
    "",
    actual.map((p) => "- " + p).join("\n"),
    "",
    "## Deliverables",
    "",
    "- commit " + head,
    "",
    "## Acceptance Evidence",
    "",
    "- Actual Git diff exactly matches the machine-enforced Code Allowlist.",
    "- Formal project branch was not merged or pushed by the executor.",
    listLines((structured.criterion_evidence || []).map((item) => item.criterion_id + ": " + item.evidence.map((e) => e.type + "=" + e.reference).join("; "))),
    "",
    "## Tests",
    "",
    "### Targeted",
    listLines(structured.tests && structured.tests.targeted),
    "",
    "### Regression",
    listLines(structured.tests && structured.tests.regression),
    "",
    "### Safety / non-regression",
    listLines(structured.tests && structured.tests.safety),
    "",
    "## Remaining Risks / Unknowns",
    "",
    listLines(structured.remaining_risks),
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
    "  1. Commit diff and tests.",
    "  2. Formal main remained unchanged and no merge/push occurred.",
    ""
  ].join("\n");

  writeDoc(project.result, resultDoc);
  return { commit: head, changedFiles: actual, resultPath: project.result };
}

export function validateCodeStructuredResult(structured) {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new Error("structured code result is missing");
  }
  const required = ["task_id", "handoff_revision", "completion_basis", "evidence", "criterion_evidence", "changed_files", "tests", "remaining_risks", "scope_check"];
  const actual = Object.keys(structured).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...required].sort())) {
    throw new Error("structured code result has invalid fields");
  }
  for (const key of ["task_id", "handoff_revision", "completion_basis"]) {
    if (typeof structured[key] !== "string" || !structured[key].trim()) {
      throw new Error("structured code result " + key + " is invalid");
    }
  }
  if (structured.completion_basis.length > 8000) {
    throw new Error("structured code result completion_basis is too long");
  }
  for (const key of ["evidence", "criterion_evidence", "changed_files", "remaining_risks"]) {
    if (!Array.isArray(structured[key])) {
      throw new Error("structured code result " + key + " must be an array");
    }
  }
  const validateStringList = (items, key, { min = 0, max = 16, itemMax = 2000 } = {}) => {
    if (items.length < min || items.length > max) {
      throw new Error("structured code result " + key + " has invalid item count");
    }
    if (items.some((item) => typeof item !== "string" || !item.trim() || item.length > itemMax)) {
      throw new Error("structured code result " + key + " entries are invalid");
    }
  };
  validateStringList(structured.evidence, "evidence", { min: 1, max: 32, itemMax: 4000 });
  validateStringList(structured.changed_files, "changed_files", { min: 1, max: 256, itemMax: 2000 });
  validateStringList(structured.remaining_risks, "remaining_risks", { min: 0, max: 16, itemMax: 2000 });

  if (!structured.tests || typeof structured.tests !== "object" || Array.isArray(structured.tests) ||
      JSON.stringify(Object.keys(structured.tests).sort()) !== JSON.stringify(["regression", "safety", "targeted"])) {
    throw new Error("structured code result tests are invalid");
  }
  for (const key of ["targeted", "regression", "safety"]) {
    if (!Array.isArray(structured.tests[key])) {
      throw new Error("structured code result tests." + key + " must be an array");
    }
    validateStringList(structured.tests[key], "tests." + key, { min: 1, max: 16, itemMax: 2000 });
  }

  const scopeKeys = ["formal_branch_modified_directly", "side_effect_policy_exceeded", "unrelated_business_rules_changed", "unrelated_files_modified", "validation_weakened"];
  if (!structured.scope_check || typeof structured.scope_check !== "object" || Array.isArray(structured.scope_check) ||
      JSON.stringify(Object.keys(structured.scope_check).sort()) !== JSON.stringify([...scopeKeys].sort()) ||
      scopeKeys.some((key) => structured.scope_check[key] !== false)) {
    throw new Error("structured code result scope_check must contain only false safety assertions");
  }
  return structured;
}
