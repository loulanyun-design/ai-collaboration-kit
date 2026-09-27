import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  criterionEvidenceSchema,
  fileHash,
  sha256,
  isWithin,
  normalizePath,
  nowIso,
  pathKey,
  readDoc,
  writeDoc,
  registerCandidateArtifact,
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

export function allowedNonCodeReadRoots(current, project) {
  const values = bulletValues(section(current.body, "Read-only Source Roots"));
  const collaborationRoot = normalizePath(path.dirname(project.root));
  const approvedRoots = [collaborationRoot];
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";
  if (userProfile) {
    approvedRoots.push(normalizePath(path.join(userProfile, "Documents", "Codex")));
  }
  approvedRoots.push(
    normalizePath("D:\\个人文件\\澄真医美\\2021年终嘉年华\\大众点评阿里健康\\公众号"),
    normalizePath("C:\\Users\\78457\\Documents\\医院自查")
  );
  const out = [];
  const seen = new Set();

  for (const value of values) {
    if (!(path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value))) {
      throw new Error("read-only source root must be absolute: " + value);
    }
    const candidate = normalizePath(value);
    const approved = approvedRoots.some((root) =>
      isWithin(root, candidate) || pathKey(candidate) === pathKey(root)
    );
    if (!approved) {
      throw new Error("read-only source root is outside approved research roots: " + value);
    }
    if (/(^|[\\/])\.private([\\/]|$)/i.test(candidate)) {
      throw new Error("read-only source root may not include .private: " + value);
    }

    const key = pathKey(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(candidate);
    }
  }

  return out;
}


const READ_ONLY_SKIP_DIRS = new Set([
  ".git", "node_modules", ".runtime", "worktrees", ".private", ".tools",
  ".cache", "dist", "build"
]);

const READ_ONLY_TEXT_EXTS = new Set([
  ".md", ".txt", ".csv", ".json", ".yml", ".yaml", ".toml",
  ".html", ".htm", ".xml", ".js", ".ts", ".mjs", ".cjs", ".py"
]);

function xmlDecode(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function zipEntries(buffer) {
  const entries = [];
  let eocd = -1;
  for (let i = Math.max(0, buffer.length - 0x10000 - 22); i <= buffer.length - 22; i++) {
    if (buffer.readUInt32LE(i) === 0x06054b50) eocd = i;
  }
  if (eocd < 0) return entries;

  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  let p = cdOffset;

  for (let i = 0; i < count && p + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function unzipEntry(buffer, wantedName) {
  const entry = zipEntries(buffer).find((e) => e.name === wantedName);
  if (!entry) return "";
  const p = entry.localOffset;
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== 0x04034b50) return "";
  const nameLen = buffer.readUInt16LE(p + 26);
  const extraLen = buffer.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  try {
    if (entry.method === 0) return data.toString("utf8");
    if (entry.method === 8) return zlib.inflateRawSync(data).toString("utf8");
  } catch {}
  return "";
}

function officePreview(file, ext, maxChars) {
  const stat = fs.statSync(file);
  if (stat.size > 25 * 1024 * 1024) return "[office file too large for preview]";
  const buffer = fs.readFileSync(file);

  if (ext === ".docx") {
    const xml = unzipEntry(buffer, "word/document.xml");
    if (!xml) return "[docx text unavailable]";
    return xmlDecode(
      xml
        .replace(/<w:tab\b[^>]*\/>/g, "\t")
        .replace(/<w:br\b[^>]*\/>/g, "\n")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<[^>]+>/g, "")
    ).replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
  }

  if (ext === ".xlsx") {
    const shared = unzipEntry(buffer, "xl/sharedStrings.xml");
    const workbook = unzipEntry(buffer, "xl/workbook.xml");
    const chunks = [];
    if (workbook) {
      const names = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((m) => xmlDecode(m[1]));
      if (names.length) chunks.push("Sheets: " + names.join(", "));
    }
    if (shared) {
      const strings = [...shared.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
        .map((m) => xmlDecode(m[1]))
        .filter(Boolean);
      if (strings.length) chunks.push(strings.join("\n"));
    }
    return (chunks.join("\n") || "[xlsx text unavailable]").slice(0, maxChars);
  }

  return "";
}

function safeTextPreview(file, maxChars) {
  const ext = path.extname(file).toLowerCase();
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return "";
    if (READ_ONLY_TEXT_EXTS.has(ext)) {
      if (stat.size > 8 * 1024 * 1024) return "[text file too large for preview]";
      return fs.readFileSync(file, "utf8").slice(0, maxChars);
    }
    if (ext === ".docx" || ext === ".xlsx") {
      return officePreview(file, ext, maxChars);
    }
  } catch (err) {
    return "[preview error: " + String(err && err.message ? err.message : err) + "]";
  }
  return "";
}

export function readOnlySearchTerms(current) {
  return bulletValues(section(current.body, "Read-only Search Terms"))
    .map((v) => v.trim())
    .filter(Boolean);
}

export function buildReadOnlyEvidenceBundle(current, project, options = {}) {
  const roots = allowedNonCodeReadRoots(current, project);
  const explicitTerms = readOnlySearchTerms(current);
  const references = bulletValues(section(current.body, "Evidence References"));
  const terms = explicitTerms.length ? explicitTerms : references
    .flatMap((value) => value.replace(/^[^:]+:\s*/, "").split(/[;,]/))
    .map((value) => value.trim().replace(/^\x60|\x60$/g, ""))
    .filter((value) => value.length >= 3 && value.length <= 240);
  if (!roots.length || !terms.length) {
    return { text: "", roots, terms, scanned: 0, hits: 0, truncated: false };
  }

  const maxFiles = Number(options.maxFiles || 30000);
  const maxHits = Number(options.maxHits || 180);
  const maxPreviewChars = Number(options.maxPreviewChars || 9000);
  const maxTotalChars = Number(options.maxTotalChars || 280000);
  const sensitive = /(?:^|[\\\/._-])(password|passwd|credential|credentials|secret|secrets|token|tokens|api[-_]?key|cookie|cookies|session|sessions)(?:[\\\/._-]|$)/i;

  const lowerTerms = terms.map((t) => t.toLowerCase());
  const lines = [];
  let scanned = 0;
  let hits = 0;
  let chars = 0;
  let truncated = false;

  const append = (s) => {
    const value = String(s);
    if (chars + value.length > maxTotalChars) {
      truncated = true;
      return false;
    }
    lines.push(value);
    chars += value.length;
    return true;
  };

  for (const root of roots) {
    append("\n=== ROOT: " + root + " ===");
    if (!fs.existsSync(root)) {
      append("\n[missing root]");
      continue;
    }
    const stack = [root];

    while (stack.length && scanned < maxFiles && hits < maxHits && !truncated) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        append("\n[read error] " + dir + ": " + String(err && err.message ? err.message : err));
        continue;
      }

      for (const entry of entries) {
        if (scanned >= maxFiles || hits >= maxHits || truncated) break;
        const full = path.join(dir, entry.name);
        const lowerName = entry.name.toLowerCase();

        if (entry.isDirectory()) {
          if (READ_ONLY_SKIP_DIRS.has(lowerName) || sensitive.test(full)) continue;
          stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        scanned += 1;
        if (sensitive.test(full)) continue;

        const lowerFull = full.toLowerCase();
        const pathMatched = lowerTerms.some((term) => lowerFull.includes(term));

        let preview = "";
        let contentMatched = false;
        const ext = path.extname(full).toLowerCase();
        if (pathMatched || READ_ONLY_TEXT_EXTS.has(ext) || ext === ".docx" || ext === ".xlsx") {
          preview = safeTextPreview(full, maxPreviewChars);
          if (!pathMatched && preview) {
            const lowerPreview = preview.toLowerCase();
            contentMatched = lowerTerms.some((term) => lowerPreview.includes(term));
          }
        }

        if (!pathMatched && !contentMatched) continue;

        hits += 1;
        if (!append("\n--- HIT " + hits + " ---\nPath: " + full)) break;
        append("\nMatched by: " + (pathMatched ? "path" : "content"));

        try {
          const stat = fs.statSync(full);
          append("\nSize: " + stat.size + " bytes");
          append("\nModified: " + stat.mtime.toISOString());
        } catch {}

        if (preview) append("\nPreview:\n" + preview);
        else append("\nPreview: [metadata only]");
      }
    }
  }

  if (scanned >= maxFiles || hits >= maxHits) truncated = true;
  append("\n\n=== SUMMARY ===\nScanned files: " + scanned + "\nMatched files: " + hits + "\nTruncated: " + truncated);
  return { text: lines.join(""), roots, terms, scanned, hits, truncated };
}

export function allowedNonCodeDeliverablePaths(current, project) {
  const values = bulletValues(section(current.body, "Deliverables"));
  const out = [];
  const seen = new Set();

  for (const value of values) {
    const mappingMatch = value.match(/^[A-Za-z0-9_.-]+\s*->\s*(.+)$/);
    const pathValue = (mappingMatch ? mappingMatch[1] : value)
      .replace(/^\x60|\x60$/g, "")
      .trim();

    let candidate;
    if (path.isAbsolute(pathValue) || /^[A-Za-z]:[\\/]/.test(pathValue)) {
      candidate = normalizePath(pathValue);
    } else if (
      pathValue.includes("\\") ||
      pathValue.includes("/") ||
      /\.[A-Za-z0-9]{1,10}$/.test(pathValue)
    ) {
      candidate = normalizePath(path.join(project.root, pathValue));
    } else {
      continue;
    }

    if (!isWithin(project.root, candidate)) {
      throw new Error("non-code deliverable escapes project root: " + pathValue);
    }
    if (pathKey(candidate) === pathKey(project.result)) continue;

    const key = pathKey(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(candidate);
    }
  }

  return out;
}

export function nonCodeArtifactMappings(current, project) {
  const values = bulletValues(section(current.body, "Deliverables"));
  const mappings = [];
  let pathIndex = 0;
  for (const value of values) {
    const match = value.match(/^([A-Za-z0-9_.-]+)\s*->\s*(.+)$/);
    const candidate = match ? match[2] : value;
    if (!(candidate.includes("\\") || candidate.includes("/") || /\.[A-Za-z0-9]{1,10}$/.test(candidate))) continue;
    if (pathKey(normalizePath(path.isAbsolute(candidate.replace(/^\x60|\x60$/g, "")) ? candidate.replace(/^\x60|\x60$/g, "") : path.join(project.root, candidate.replace(/^\x60|\x60$/g, "")))) === pathKey(project.result)) continue;
    pathIndex += 1;
    if (match) mappings.push({ deliverableId: "d" + pathIndex, logicalId: match[1] });
  }
  return mappings;
}

export function buildNonCodeSchema(ctx) {
  const allowedPaths = allowedNonCodeDeliverablePaths(ctx.current, ctx.project);
  const deliverableIds = allowedPaths.map((_, index) => "d" + (index + 1));
  const deliverableItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      id: deliverableIds.length > 0
        ? { type: "string", enum: deliverableIds }
        : { type: "string", maxLength: 0 },
      content: { type: "string", minLength: 1, maxLength: 65536 }
    },
    required: ["id", "content"]
  };

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
      deliverables: {
        type: "array",
        minItems: allowedPaths.length,
        maxItems: allowedPaths.length,
        items: deliverableItem
      },
      acceptance_evidence: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: { type: "string", minLength: 1, maxLength: 4000 }
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
      retrieval_evidence: {
        type: "array",
        maxItems: 32,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            source_id: { type: "string", minLength: 1, maxLength: 1000 },
            timestamp: { type: "string", maxLength: 200 },
            location: { type: "string", minLength: 1, maxLength: 1000 },
            summary: { type: "string", minLength: 1, maxLength: 4000 },
            evidence_type: {
              type: "string",
              enum: ["user_decision", "assistant_proposal", "tool_observation", "historical_hypothesis", "other"]
            },
            searched_scope: { type: "string", minLength: 1, maxLength: 2000 },
            excluded_scope: { type: "string", maxLength: 2000 },
            truncated: { type: "boolean" }
          },
          required: [
            "source_id",
            "timestamp",
            "location",
            "summary",
            "evidence_type",
            "searched_scope",
            "excluded_scope",
            "truncated"
          ]
        }
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
      "deliverables",
      "acceptance_evidence",
      "tests",
      "retrieval_evidence",
      "remaining_risks",
      "scope_check"
    ]
  };
}

export function buildNonCodePrompt(ctx) {
  const rootRules = fs.readFileSync(ctx.rootRules, "utf8");
  const projectRules = fs.readFileSync(ctx.project.rules, "utf8");
  const currentText = fs.readFileSync(ctx.project.current, "utf8");
  const allowedPaths = allowedNonCodeDeliverablePaths(ctx.current, ctx.project);
  const readRoots = allowedNonCodeReadRoots(ctx.current, ctx.project);
  const evidenceBundle = buildReadOnlyEvidenceBundle(ctx.current, ctx.project);

  return [
    "You are executing one already-claimed NON-CODE collaboration task.",
    "",
    "IMPORTANT: Do not use shell, file, browser, network, MCP, agent, runner, Codex, or any other tool.",
    readRoots.length
      ? "The parent runner has already performed the permitted read-only local discovery and embedded the evidence bundle below."
      : "All required context is embedded below.",
    "Do not write files yourself. The parent worker will materialize only schema-approved deliverables.",
    "Return only the JSON object required by the output schema.",
    "",
    "Task identity:",
    "- project_id: " + ctx.job.projectId,
    "- task_id: " + ctx.job.taskId,
    "- handoff_revision: " + ctx.job.revision,
    "- model requested by parent: " + String(ctx.job.modelRequested || "unknown"),
    "",
    "Allowed deliverables (return the short ID, never the path):",
    allowedPaths.length
      ? allowedPaths.map((p, index) => "- d" + (index + 1) + " -> " + p).join("\n")
      : "- none",
    "",
    "Allowed read-only source roots:",
    readRoots.length ? readRoots.map((p) => "- " + p).join("\n") : "- none",
    "",
    "READ_ONLY_EVIDENCE_BUNDLE:",
    "<<<READ_ONLY_EVIDENCE",
    evidenceBundle.text || "[no local evidence bundle requested]",
    "READ_ONLY_EVIDENCE",
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
    "Execution requirements:",
    "- Follow the current handoff exactly.",
    "- Do not expand scope.",
    "- Put complete non-empty text contents for every required deliverable into the JSON deliverables array.",
    "- Use only the short deliverable IDs (d1, d2, ...); never echo a filesystem path in the deliverables array.",
    "- Report concrete evidence and tests in JSON.",
    "- For retrieval-only work, put each located item in retrieval_evidence with source_id, timestamp if known (otherwise empty string), location/range, shortest sufficient summary, evidence_type, searched_scope, excluded_scope, and truncated.",
    "- If nothing is located in the searched scope, return an empty retrieval_evidence array and say 'not located in this pass'; never convert absence into proof of non-existence.",
    readRoots.length
      ? "- Use the embedded READ_ONLY_EVIDENCE_BUNDLE as the only local-discovery evidence. If an item is absent from that bundle, report it as not located in this pass."
      : "- If the task cannot be completed from the embedded context alone, say so in completion_basis/remaining_risks but do not call tools.",
    "- Never claim that you directly opened files or ran local commands; the parent runner collected the evidence bundle.",
    "- Never claim a side effect that did not happen.",
    "- Do not mention or request a fallback model."
  ].join("\n");
}

function listLines(items, fallback = "- None.") {
  if (!Array.isArray(items) || items.length === 0) return fallback;
  return items.map((item) => "- " + String(item)).join("\n");
}

export function materializeNonCodeResult({ job, project, current, structured, codexRuntime }) {
  if (!structured || typeof structured !== "object") {
    throw new Error("structured non-code result is missing");
  }
  if (String(structured.task_id || "") !== job.taskId) {
    throw new Error("structured result task_id mismatch");
  }
  if (String(structured.handoff_revision || "") !== job.revision) {
    throw new Error("structured result revision mismatch");
  }
  validateCriterionEvidence(current, structured);

  const allowedPaths = allowedNonCodeDeliverablePaths(current, project);
  const allowedById = new Map(
    allowedPaths.map((p, index) => ["d" + (index + 1), p])
  );
  const received = new Set();
  const deliverables = Array.isArray(structured.deliverables) ? structured.deliverables : [];

  if (deliverables.length !== allowedPaths.length) {
    throw new Error("structured deliverable count mismatch");
  }

  for (const item of deliverables) {
    const id = String(item.id || "");
    const target = allowedById.get(id);
    if (!target) {
      throw new Error("structured deliverable id is not allowed: " + id);
    }
    if (received.has(id)) throw new Error("duplicate structured deliverable id");
    received.add(id);

    const content = String(item.content ?? "");
    if (!content) throw new Error("structured deliverable content is empty");
    
    if (Buffer.byteLength(content, "utf8") > 65536) {
      throw new Error("structured deliverable exceeds 64KiB");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }

  for (const [id, allowedPath] of allowedById.entries()) {
    if (!received.has(id)) {
      throw new Error("required deliverable was not returned: " + id + " -> " + allowedPath);
    }
  }

  const artifactMappings = nonCodeArtifactMappings(current, project);
  for (const mapping of artifactMappings) {
    const target = allowedById.get(mapping.deliverableId);
    registerCandidateArtifact(project, {
      logical_id: mapping.logicalId,
      version: "r" + job.revision + "-" + sha256(job.taskId).slice(0, 12) + "-" + fileHash(target).slice(0, 12),
      relative_path: path.relative(project.root, target).replace(/\\/g, "/"),
      content_hash: fileHash(target),
      source_task: job.taskId,
      source_revision: job.revision
    });
  }

  const resultDoc = readDoc(project.result);
  resultDoc.meta.project_id = job.projectId;
  resultDoc.meta.task_id = job.taskId;
  resultDoc.meta.handoff_revision = job.revision;
  resultDoc.meta.task_type = job.taskType;
  resultDoc.meta.status = "DRAFT";
  resultDoc.meta.owner = "Codex";
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
    listLines(structured.evidence),
    "",
    "## Changes",
    "",
    "- Files: " + (allowedPaths.length ? allowedPaths.join("; ") : "none"),
    "- Summary: Non-code deliverables were materialized by the parent worker from schema-validated Codex output.",
    "",
    "## Deliverables",
    "",
    allowedPaths.length ? allowedPaths.map((p) => "- " + p).join("\n") : "- No file deliverable requested.",
    "",
    "## Acceptance Evidence",
    "",
    listLines(structured.acceptance_evidence),
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
    "  1. Deliverable content and task identity.",
    "  2. Runner SUCCEEDED and handoff REVIEW state.",
    ""
  ].join("\n");

  writeDoc(project.result, resultDoc);

  return {
    deliverablePaths: allowedPaths,
    resultPath: project.result
  };
}
