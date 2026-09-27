import fs from "node:fs";
import path from "node:path";
import {
  allowedNonCodeDeliverablePaths,
  allowedNonCodeReadRoots
} from "../noncode.mjs";
import {
  fileHash,
  isWithin,
  normalizePath,
  pathKey
} from "../lib.mjs";

const MAX_FILES = 8;
const MAX_BYTES = 64 * 1024;
const ALLOWED_EXTS = new Set([
  ".md", ".txt", ".csv", ".json", ".yml", ".yaml", ".toml",
  ".html", ".htm", ".xml", ".js", ".ts", ".mjs", ".cjs", ".py"
]);
const SENSITIVE = /(?:^|[\\/._-])(password|passwd|credential|credentials|secret|secrets|token|tokens|api[-_]?key|cookie|cookies|session|sessions)(?:[\\/._-]|$)/i;

function section(body, heading) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === "## " + heading);
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
    .filter(Boolean);
}

export function isDeterministicLocalCopyTask(current) {
  return Boolean(section(current && current.body, "Deterministic Local Copy Sources"));
}

export function localCopyPlan(current, project) {
  const sourceRoots = allowedNonCodeReadRoots(current, project);
  const targets = allowedNonCodeDeliverablePaths(current, project);
  const values = bulletValues(section(current.body, "Deterministic Local Copy Sources"));

  if (!values.length) throw new Error("deterministic local copy sources are missing");
  if (values.length > MAX_FILES) throw new Error("deterministic local copy supports at most " + MAX_FILES + " files per handoff");
  if (values.length !== targets.length) throw new Error("deterministic local copy source/deliverable count mismatch");

  const sourceById = new Map();
  for (const value of values) {
    const match = value.match(/^(d\d+)\s*->\s*(.+)$/);
    if (!match) throw new Error("local copy source must use 'dN -> absolute-source-path'");
    const id = match[1];
    if (sourceById.has(id)) throw new Error("duplicate local copy source id: " + id);
    const raw = match[2].replace(/^\x60|\x60$/g, "").trim();
    if (!(path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw))) {
      throw new Error("local copy source must be absolute: " + raw);
    }
    const source = normalizePath(raw);
    if (SENSITIVE.test(source) || /(^|[\\/])\.private([\\/]|$)/i.test(source)) {
      throw new Error("local copy source is sensitive or private: " + raw);
    }
    const insideApprovedRoot = sourceRoots.some((root) =>
      isWithin(root, source) || pathKey(root) === pathKey(source)
    );
    if (!insideApprovedRoot) throw new Error("local copy source is outside declared read-only roots: " + raw);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error("local copy source is missing or not a file: " + raw);
    }
    const ext = path.extname(source).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) throw new Error("local copy source extension is not allowed: " + ext);
    const stat = fs.statSync(source);
    if (stat.size <= 0 || stat.size > MAX_BYTES) {
      throw new Error("local copy source must be 1.." + MAX_BYTES + " bytes: " + raw);
    }
    sourceById.set(id, source);
  }

  const plan = [];
  for (let i = 0; i < targets.length; i++) {
    const id = "d" + (i + 1);
    const source = sourceById.get(id);
    if (!source) throw new Error("missing local copy source mapping for " + id);
    const target = targets[i];
    const relativeTarget = path.relative(project.root, target).replace(/\\/g, "/");
    if (!relativeTarget.split("/").some((part) => part.toLowerCase() === "legacy")) {
      throw new Error("deterministic local copy target must be under a legacy path: " + relativeTarget);
    }

    const buffer = fs.readFileSync(source);
    const content = buffer.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(buffer)) {
      throw new Error("local copy source is not lossless UTF-8 text: " + source);
    }
    const sourceHash = fileHash(source);

    if (fs.existsSync(target)) {
      if (!fs.statSync(target).isFile()) throw new Error("local copy target exists and is not a file: " + relativeTarget);
      if (fileHash(target) !== sourceHash) {
        throw new Error("local copy target exists with different content: " + relativeTarget);
      }
    }

    plan.push({ id, source, target, relativeTarget, sourceHash, content, bytes: buffer.length });
  }

  return plan;
}

export function runLocalCopyExecutor(ctx) {
  const plan = localCopyPlan(ctx.current, ctx.project);
  const structuredResult = {
    task_id: ctx.job.taskId,
    handoff_revision: ctx.job.revision,
    completion_basis: "Deterministic no-model local copy prepared from frozen handoff mappings and approved read-only source roots.",
    evidence: plan.map((item) =>
      item.id + ": source=" + item.source + "; sha256=" + item.sourceHash + "; bytes=" + item.bytes
    ),
    criterion_evidence: [],
    deliverables: plan.map((item) => ({ id: item.id, content: item.content })),
    acceptance_evidence: plan.map((item) =>
      item.id + ": exact source bytes loaded as lossless UTF-8; target overwrite guard passed"
    ),
    tests: {
      targeted: ["Validated every source path, target path, size, UTF-8 round-trip, and pre-existing-target hash."],
      regression: ["No target outside a legacy path is permitted; differing existing targets are rejected."],
      safety: ["No model, shell, network, remote service, WeChat, Git, upload, or external write is used by the local-copy executor."]
    },
    retrieval_evidence: plan.map((item) => ({
      source_id: item.id,
      timestamp: "",
      location: item.source,
      summary: "Exact local source selected for deterministic legacy copy; sha256=" + item.sourceHash,
      evidence_type: "tool_observation",
      searched_scope: "Explicit Deterministic Local Copy Sources mapping only",
      excluded_scope: "All files not explicitly mapped in the frozen handoff",
      truncated: false
    })),
    remaining_risks: [],
    scope_check: {
      unrelated_business_rules_changed: false,
      formal_branch_modified_directly: false,
      validation_weakened: false,
      side_effect_policy_exceeded: false,
      unrelated_files_modified: false
    }
  };

  return Promise.resolve({
    stdout: "deterministic local copy prepared " + plan.length + " file(s)\n",
    stderr: "",
    exitCode: 0,
    signal: null,
    childPid: null,
    modelRequested: "none",
    codexRuntime: null,
    structuredResult,
    localCopyPlan: plan.map(({ id, source, target, relativeTarget, sourceHash, bytes }) => ({
      id, source, target, relativeTarget, sourceHash, bytes
    }))
  });
}

export function verifyLocalCopyMaterialization(plan) {
  if (!Array.isArray(plan) || !plan.length) throw new Error("local copy verification plan is empty");
  for (const item of plan) {
    if (!fs.existsSync(item.target)) throw new Error("local copy target missing after materialization: " + item.relativeTarget);
    const targetHash = fileHash(item.target);
    if (targetHash !== item.sourceHash) {
      throw new Error("local copy target hash mismatch after materialization: " + item.relativeTarget);
    }
  }
  return plan.map((item) => ({
    id: item.id,
    relativeTarget: item.relativeTarget,
    sha256: item.sourceHash,
    bytes: item.bytes
  }));
}
