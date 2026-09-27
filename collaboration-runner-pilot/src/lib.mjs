import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
export const PILOT_ROOT = path.resolve(path.dirname(THIS_FILE), "..");
const TEST_ROOT = process.env.NODE_ENV === "test" && process.env.COLLAB_RUNNER_TEST_ROOT
  ? path.resolve(process.env.COLLAB_RUNNER_TEST_ROOT)
  : null;
if (TEST_ROOT && !TEST_ROOT.startsWith(path.join(PILOT_ROOT, "test-tmp") + path.sep)) {
  throw new Error("COLLAB_RUNNER_TEST_ROOT must be inside pilot test-tmp");
}
export const COLLAB_ROOT = TEST_ROOT || path.resolve(PILOT_ROOT, "..");
export const REGISTRY_PATH = path.join(COLLAB_ROOT, "collaboration", "projects.json");
export const HANDOFF_ENGINE = path.join(COLLAB_ROOT, "collaboration", "handoff.mjs");
export const ROOT_RULES = path.join(COLLAB_ROOT, "AGENTS.md");
export const POLICY_MODULE_PATH = fs.existsSync(path.join(PILOT_ROOT, "..", "collaboration", "policy.mjs"))
  ? path.join(PILOT_ROOT, "..", "collaboration", "policy.mjs")
  : path.join(PILOT_ROOT, "collaboration", "policy.mjs");
export const RUNTIME_ROOT = TEST_ROOT ? path.join(TEST_ROOT, ".runtime") : path.join(PILOT_ROOT, ".runtime");
export const JOBS_ROOT = path.join(RUNTIME_ROOT, "jobs");
export const ALLOWED_ROOT = COLLAB_ROOT;
export const LOG_LIMIT = 128 * 1024;

const policyModuleUrl = pathToFileURL(POLICY_MODULE_PATH).href;
export const { assertPolicyIdentityMatches, canonicalPolicyJson, loadPolicyIdentity } = await import(policyModuleUrl);

const MUTABLE_SPEC_FIELDS = new Set(["status", "owner", "updated_at", "spec_hash"]);

export function ensureRuntime() {
  fs.mkdirSync(JOBS_ROOT, { recursive: true });
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function normalizePath(p) {
  return path.resolve(String(p || ""));
}

export function pathKey(p) {
  return normalizePath(p).replace(/\//g, "\\").toLowerCase();
}

export function isWithin(parent, child) {
  const p = pathKey(parent).replace(/\\+$/, "");
  const c = pathKey(child);
  return c === p || c.startsWith(p + "\\");
}

export function realPathIfExists(p) {
  const resolved = normalizePath(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch (err) {
    if (err && err.code === "ENOENT") return resolved;
    throw err;
  }
}

export function assertRealPathWithin(parent, child, label = "path") {
  const realParent = realPathIfExists(parent);
  const resolvedChild = normalizePath(child);
  let probe = resolvedChild;
  const suffix = [];

  while (!fs.existsSync(probe)) {
    const next = path.dirname(probe);
    if (next === probe) break;
    suffix.unshift(path.basename(probe));
    probe = next;
  }

  const realProbe = realPathIfExists(probe);
  const realChild = suffix.length ? path.join(realProbe, ...suffix) : realProbe;
  if (!isWithin(realParent, realChild)) {
    throw new Error(label + " escapes allowed real filesystem root");
  }
  return resolvedChild;
}

export function assertSafeId(value, label) {
  const v = String(value || "");
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(v)) {
    throw new Error(label + " contains unsupported characters");
  }
  return v;
}

export function parseFrontMatter(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error("handoff file is missing front matter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("handoff front matter is not closed");
  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const meta = {};
  const order = [];
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx < 0) throw new Error("invalid front matter line: " + line);
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    meta[key] = value;
    order.push(key);
  }
  return { meta, order, body };
}

export function serializeFrontMatter(doc) {
  const seen = new Set();
  const lines = [];
  for (const key of doc.order || []) {
    if (!(key in doc.meta)) continue;
    seen.add(key);
    lines.push(key + ": " + String(doc.meta[key] ?? ""));
  }
  for (const [key, value] of Object.entries(doc.meta)) {
    if (seen.has(key)) continue;
    lines.push(key + ": " + String(value ?? ""));
  }
  return "---\n" + lines.join("\n") + "\n---\n" + String(doc.body || "").replace(/^\n+/, "");
}

export function readDoc(file) {
  if (!fs.existsSync(file)) throw new Error("missing file: " + file);
  return parseFrontMatter(fs.readFileSync(file, "utf8"));
}

export function writeDoc(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeFrontMatter(doc), "utf8");
}

export function fileHash(file) {
  return sha256(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
}

const RUNNER_BUILD_FILES = Object.freeze([
  "src/lib.mjs",
  "src/model-policy.mjs",
  "src/process-lifecycle.mjs",
  "src/executors/codex.mjs",
  "src/runner.mjs",
  "src/worker.mjs"
]);

export function runnerBuildIdentity() {
  const parts = RUNNER_BUILD_FILES.map((relative) => {
    const file = path.join(PILOT_ROOT, relative);
    return relative + ":" + fileHash(file);
  });
  parts.push("collaboration/policy.mjs:" + fileHash(POLICY_MODULE_PATH));
  return sha256(parts.join("\n"));
}

export function specHash(doc) {
  const meta = {};
  for (const key of Object.keys(doc.meta).sort()) {
    if (MUTABLE_SPEC_FIELDS.has(key)) continue;
    meta[key] = String(doc.meta[key] ?? "");
  }
  const payload = JSON.stringify(meta) + "\n" + String(doc.body || "").replace(/\r\n/g, "\n").trim();
  return sha256(payload);
}

export function readRegistry() {
  const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  if (!Array.isArray(data.projects)) throw new Error("registry.projects must be an array");
  return data.projects;
}

export function resolveProjectEntry(hit) {
  if (!hit || typeof hit !== "object") throw new Error("invalid registry entry");
  if (hit.enabled !== true) throw new Error("project is registered but disabled: " + String(hit.id || ""));
  assertSafeId(hit.id, "project id");

  const root = normalizePath(hit.path);
  if (!isWithin(ALLOWED_ROOT, root) || pathKey(root) === pathKey(ALLOWED_ROOT)) {
    throw new Error("registered project path is outside allowed root");
  }

  const rules = normalizePath(path.join(root, hit.project_rules || "AGENTS.md"));
  const policyManifest = normalizePath(path.join(root, hit.policy_manifest || "COLLAB_POLICY.json"));
  const handoffDir = normalizePath(path.join(root, hit.handoff_dir || "work\\handoffs"));
  const current = path.join(handoffDir, "current.md");
  const result = path.join(handoffDir, "RESULT.md");
  const lock = path.join(handoffDir, ".handoff.lock.json");

  for (const pair of Object.entries({ rules, policyManifest, handoffDir, current, result, lock })) {
    const label = pair[0];
    const p = pair[1];
    if (!isWithin(root, p)) throw new Error(label + " path escapes registered project");
  }

  return { id: hit.id, root, rules, policyManifest, handoffDir, current, result, lock };
}

function policyIdentityForProject(P) {
  return loadPolicyIdentity({
    rootDir: COLLAB_ROOT,
    projectDir: P.root,
    rootManifestPath: path.join(COLLAB_ROOT, "collaboration", "policies", "root-policy-v1.json"),
    projectManifestPath: P.policyManifest,
    projectId: P.id,
  });
}

export function resolveRegisteredProject(projectId) {
  assertSafeId(projectId, "project id");
  const hit = readRegistry().find((p) => p.id === projectId);
  if (!hit) throw new Error("project is not explicitly registered: " + projectId);
  return resolveProjectEntry(hit);
}

export function validateReadyProject(projectId, options = {}) {
  const allowExistingJob = options.allowExistingJob !== false;
  const P = resolveRegisteredProject(projectId);
  if (!fs.existsSync(ROOT_RULES)) throw new Error("missing root rules");
  if (!fs.existsSync(P.rules)) throw new Error("missing project rules");
  if (!fs.existsSync(P.current)) throw new Error("missing current handoff");

  const doc = readDoc(P.current);
  const taskId = assertSafeId(doc.meta.task_id, "task_id");
  const revision = String(doc.meta.handoff_revision || "");
  if (!/^[1-9][0-9]*$/.test(revision)) throw new Error("handoff_revision must be a positive integer");
  const taskType = String(doc.meta.task_type || "");
  if (!["code", "non_code"].includes(taskType)) throw new Error("unsupported task_type");
  if (String(doc.meta.project_id || "") !== P.id) throw new Error("current handoff project_id mismatch");
  const hasPolicySchemaVersion = Object.prototype.hasOwnProperty.call(doc.meta, "policy_schema_version");
  const policySchemaVersion = String(doc.meta.policy_schema_version || "");
  if (hasPolicySchemaVersion && policySchemaVersion !== "1") throw new Error("unknown policy_schema_version: " + policySchemaVersion);

  const identity = { projectId: P.id, taskId, revision };
  const job = findJob(identity);
  if (job && allowExistingJob) {
    return { P, doc, identity, job, duplicate: true };
  }

  const blockingJob = findBlockingProjectJob(P.id, identity);
  if (blockingJob) {
    throw new Error(
      "unreconciled project job blocks new writer: job=" + blockingJob.jobId +
      " state=" + blockingJob.observedState +
      " task=" + blockingJob.taskId +
      " revision=" + blockingJob.revision
    );
  }

  if (String(doc.meta.status || "") !== "READY") throw new Error("handoff is not READY");
  if (String(doc.meta.owner || "") !== "Codex") throw new Error("READY handoff owner must be Codex");
  if (fs.existsSync(P.lock)) throw new Error("project handoff lock already exists");

  const expectedSpec = specHash(doc);
  if (!doc.meta.spec_hash || expectedSpec !== doc.meta.spec_hash) throw new Error("handoff spec hash mismatch");
  let policyIdentity = null;
  if (policySchemaVersion === "1") {
    policyIdentity = policyIdentityForProject(P);
    assertPolicyIdentityMatches(doc.meta, policyIdentity);
  } else {
    if (!doc.meta.root_rules_hash || fileHash(ROOT_RULES) !== doc.meta.root_rules_hash) {
      throw new Error("root rules hash mismatch");
    }
    if (!doc.meta.project_rules_hash || fileHash(P.rules) !== doc.meta.project_rules_hash) {
      throw new Error("project rules hash mismatch");
    }
  }

  if (taskType === "code") {
    if (!/^[0-9a-f]{40}$/i.test(String(doc.meta.base_commit || ""))) {
      throw new Error("code task base_commit is invalid");
    }
    const wt = normalizePath(doc.meta.codex_worktree || "");
    const allowedWt = path.join(ALLOWED_ROOT, "worktrees");
    if (!isWithin(allowedWt, wt)) throw new Error("code task worktree path escapes allowed worktree root");
    assertRealPathWithin(allowedWt, wt, "code task worktree path");
    const branch = String(doc.meta.branch || "");
    if (!branch || branch.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
      throw new Error("code task branch is invalid");
    }
  }

  return { P, doc, identity, job: null, duplicate: false, policyIdentity };
}

export function jobKey(identity) {
  return sha256(identity.projectId + "\n" + identity.taskId + "\n" + identity.revision).slice(0, 32);
}

export function jobDirFor(identity) {
  return path.join(JOBS_ROOT, jobKey(identity));
}

export function jobFileFor(identity) {
  return path.join(jobDirFor(identity), "job.json");
}

export function findJob(identity) {
  ensureRuntime();
  const file = jobFileFor(identity);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

export function findBlockingProjectJob(projectId, currentIdentity = null) {
  ensureRuntime();
  if (!fs.existsSync(JOBS_ROOT)) return null;

  for (const name of fs.readdirSync(JOBS_ROOT)) {
    const file = path.join(JOBS_ROOT, name, "job.json");
    if (!fs.existsSync(file)) continue;

    let job;
    try { job = readJson(file); } catch { continue; }
    if (String(job.projectId || "") !== String(projectId || "")) continue;

    if (
      currentIdentity &&
      String(job.taskId || "") === String(currentIdentity.taskId || "") &&
      String(job.revision || "") === String(currentIdentity.revision || "")
    ) {
      continue;
    }

    const fence = String(job.writerFence || "");
    // Legacy jobs created before the writer-fence schema are intentionally not
    // promoted into blocking records. P0 adoption requires a one-time process
    // audit before enabling this code in the formal Runner.
    if (!["active", "uncertain"].includes(fence)) continue;

    const state = observedState(job);
    return {
      jobId: job.jobId || name,
      taskId: job.taskId || null,
      revision: job.revision || null,
      state: job.state || null,
      observedState: state,
      writerFence: fence,
      workerPid: job.workerPid || null,
      childPid: job.childPid || null
    };
  }
  return null;
}

export function createJobAtomic(identity, initial) {
  ensureRuntime();
  const dir = jobDirFor(identity);
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if (err && err.code === "EEXIST") return { created: false, dir, job: waitForJobFile(identity) };
    throw err;
  }

  const lockFile = path.join(dir, "launch.lock");
  const fd = fs.openSync(lockFile, "wx");
  fs.writeFileSync(fd, JSON.stringify({ identity, createdAt: nowIso(), pid: process.pid }) + "\n", "utf8");
  fs.closeSync(fd);

  const job = {
    ...initial,
    jobId: path.basename(dir),
    projectId: identity.projectId,
    taskId: identity.taskId,
    revision: identity.revision,
    state: "QUEUED",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    jobDir: dir,
    jobFile: path.join(dir, "job.json"),
    workerLog: path.join(dir, "worker.log"),
    executorStdout: path.join(dir, "executor.stdout.log"),
    executorStderr: path.join(dir, "executor.stderr.log")
  };
  atomicWriteJson(job.jobFile, job);
  return { created: true, dir, job };
}

function waitForJobFile(identity) {
  const file = jobFileFor(identity);
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    if (fs.existsSync(file)) return readJson(file);
  }
  return {
    projectId: identity.projectId,
    taskId: identity.taskId,
    revision: identity.revision,
    state: "QUEUED",
    diagnostic: "submission lock exists but job record is not yet visible",
    jobFile: file
  };
}

export function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function updateJob(jobOrFile, patch) {
  const file = typeof jobOrFile === "string" ? jobOrFile : jobOrFile.jobFile;
  const current = readJson(file);
  const next = { ...current, ...patch, updatedAt: nowIso() };
  atomicWriteJson(file, next);
  return next;
}

export function finalizeStage(jobOrFile, phase, nextAction, extra = {}) {
  const recordedAt = nowIso();
  return updateJob(jobOrFile, {
    ...extra,
    phase,
    lastActivityAt: recordedAt,
    nextAction,
    checkpoint: { phase, recordedAt, nextAction, ...extra }
  });
}

function normalizedFailureMessage(message) {
  return String(message || "").toLowerCase()
    .replace(/[a-f0-9]{32,64}/g, "<id>")
    .replace(/\b\d{4}-\d\d-\d\dt[^\s]+/g, "<time>")
    .replace(/\b\d+\b/g, "<n>").replace(/\s+/g, " ").trim().slice(0, 2000);
}

export function recordFailure(jobOrFile, kind, message) {
  const file = typeof jobOrFile === "string" ? jobOrFile : jobOrFile.jobFile;
  const current = readJson(file);
  const signature = sha256(String(kind) + "\n" + normalizedFailureMessage(message));
  let previousCount = 0;
  if (fs.existsSync(JOBS_ROOT)) {
    for (const name of fs.readdirSync(JOBS_ROOT)) {
      const candidate = path.join(JOBS_ROOT, name, "job.json");
      if (pathKey(candidate) === pathKey(file) || !fs.existsSync(candidate)) continue;
      try {
        const old = readJson(candidate);
        if (old.projectId === current.projectId && old.taskId === current.taskId &&
            old.failureLedger && old.failureLedger.signature === signature) {
          previousCount = Math.max(previousCount, Number(old.failureLedger.consecutiveCount || 0));
        }
      } catch {}
    }
  }
  const existing = current.failureLedger;
  const count = existing && existing.signature === signature
    ? Number(existing.consecutiveCount || 1)
    : previousCount + 1;
  return updateJob(file, {
    failureLedger: { signature, consecutiveCount: count, kind, recordedAt: nowIso() },
    escalationGate: count >= 2,
    nextAction: count >= 2 ? "ESCALATE_ASTRA" : "SELF_REPAIR"
  });
}

export function boundedText(text, limit = LOG_LIMIT) {
  const s = String(text || "");
  if (Buffer.byteLength(s, "utf8") <= limit) return s;
  const buf = Buffer.from(s, "utf8");
  return "[truncated; tail retained]\n" + buf.subarray(buf.length - limit).toString("utf8");
}

export function writeBounded(file, text, limit = LOG_LIMIT) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, boundedText(text, limit), "utf8");
}

export function appendBounded(file, text, limit = LOG_LIMIT) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let old = "";
  try { old = fs.readFileSync(file, "utf8"); } catch {}
  fs.writeFileSync(file, boundedText(old + String(text || ""), limit), "utf8");
}

export function appendWorkerLog(jobFile, line) {
  let job;
  try { job = readJson(jobFile); } catch { return; }
  const file = job.workerLog;
  let old = "";
  try { old = fs.readFileSync(file, "utf8"); } catch {}
  writeBounded(file, old + "[" + nowIso() + "] " + line + "\n");
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function observedState(job) {
  if (["SUCCEEDED", "FAILED", "BLOCKED", "TIMED_OUT", "PAUSED_QUOTA", "UNKNOWN"].includes(job.state)) {
    return job.state;
  }
  if (["QUEUED", "RUNNING"].includes(job.state) && job.workerPid && !processAlive(job.workerPid)) {
    return "UNKNOWN";
  }
  return job.state;
}

export function parseCliArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v.startsWith("--")) {
      const key = v.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(v);
    }
  }
  return out;
}

export function validateTimeout(value, fallback = 180000) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 500 || n > 3600000) {
    throw new Error("timeout-ms must be 500..3600000");
  }
  return n;
}

export function resolveCurrentIdentity(projectId) {
  const P = resolveRegisteredProject(projectId);
  const doc = readDoc(P.current);
  return {
    projectId: P.id,
    taskId: assertSafeId(doc.meta.task_id, "task_id"),
    revision: String(doc.meta.handoff_revision || "")
  };
}

export function verifyResultAndReview(job) {
  const P = resolveRegisteredProject(job.projectId);
  const current = readDoc(P.current);
  const result = readDoc(P.result);
  const problems = [];
  if (String(current.meta.task_id) !== job.taskId) problems.push("current task_id mismatch");
  if (String(current.meta.handoff_revision) !== job.revision) problems.push("current revision mismatch");
  if (String(current.meta.status) !== "REVIEW") problems.push("handoff status is not REVIEW");
  if (String(result.meta.task_id) !== job.taskId) problems.push("RESULT task_id mismatch");
  if (String(result.meta.handoff_revision || "") !== job.revision) problems.push("RESULT revision mismatch");
  if (String(result.meta.status) !== "REVIEW") problems.push("RESULT status is not REVIEW");
  if (String(result.meta.next_owner || "") !== "ChatGPT") problems.push("RESULT next_owner is not ChatGPT");
  return { ok: problems.length === 0, problems, current, result, P };
}

export function setResultRevision(resultPath, revision) {
  const doc = readDoc(resultPath);
  doc.meta.handoff_revision = String(revision);
  writeDoc(resultPath, doc);
}

export function safeResultText(projectId) {
  const P = resolveRegisteredProject(projectId);
  if (!fs.existsSync(P.result)) return "";
  return fs.readFileSync(P.result, "utf8");
}

export function markdownSection(body, heading) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === "## " + heading);
  if (start < 0) return "";
  const out = [];
  for (let i = start + 1; i < lines.length && !/^##\s+/.test(lines[i]); i++) out.push(lines[i]);
  return out.join("\n").trim();
}

export function acceptanceContract(current) {
  const capabilityText = markdownSection(current.body, "Acceptance Capabilities");
  const capabilities = capabilityText.split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
  const allowed = new Set(["UI_REQUIRED", "UI_INTERACTION", "SCRIPT_E2E"]);
  for (const capability of capabilities) {
    if (!allowed.has(capability)) throw new Error("unsupported acceptance capability: " + capability);
  }
  if (new Set(capabilities).size !== capabilities.length) throw new Error("duplicate acceptance capability");

  const criteriaText = markdownSection(current.body, "Acceptance Criteria");
  const criteria = [];
  if (criteriaText) {
    for (const line of criteriaText.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)) {
      if (!/^[-*]\s+/.test(line)) throw new Error("acceptance criterion must be a bullet with a stable ID");
      const match = line.replace(/^[-*]\s+/, "").match(/^([A-Za-z][A-Za-z0-9_.-]*):\s+(.+)$/);
      if (!match) throw new Error("acceptance criterion must use 'ID: description'");
      criteria.push({ id: match[1], description: match[2] });
    }
  }
  const ids = criteria.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate acceptance criterion ID");
  return { capabilities, criteria };
}

export function criterionEvidenceSchema(current) {
  const ids = acceptanceContract(current).criteria.map((item) => item.id);
  return {
    type: "array", minItems: ids.length, maxItems: ids.length,
    items: {
      type: "object", additionalProperties: false,
      properties: {
        criterion_id: ids.length ? { type: "string", enum: ids } : { type: "string", maxLength: 0 },
        evidence: {
          type: "array", minItems: 1, maxItems: 16,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              type: { type: "string", enum: ["render", "screenshot", "interaction", "executed_test", "inspection", "document"] },
              reference: { type: "string", minLength: 1, maxLength: 2000 },
              scenario: { type: ["string", "null"], maxLength: 1000 },
              executed: { type: ["boolean", "null"] }
            }, required: ["type", "reference", "scenario", "executed"]
          }
        }
      }, required: ["criterion_id", "evidence"]
    }
  };
}

export function validateCriterionEvidence(current, structured) {
  const contract = acceptanceContract(current);
  const entries = Array.isArray(structured && structured.criterion_evidence) ? structured.criterion_evidence : [];
  const expected = contract.criteria.map((item) => item.id).sort();
  const actual = entries.map((item) => String(item && item.criterion_id || "")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("criterion evidence does not exactly cover acceptance criteria");
  const evidence = entries.flatMap((item) => Array.isArray(item.evidence) ? item.evidence : []);
  if (entries.some((item) => !Array.isArray(item.evidence) || item.evidence.length === 0)) throw new Error("criterion evidence entry is empty");
  const has = (type) => evidence.some((item) => item && item.type === type && String(item.reference || "").trim());
  if (contract.capabilities.includes("UI_REQUIRED") && (!has("render") || !has("screenshot"))) {
    throw new Error("UI_REQUIRED requires render and screenshot evidence");
  }
  if (contract.capabilities.includes("UI_INTERACTION") && !has("interaction")) {
    throw new Error("UI_INTERACTION requires interaction evidence");
  }
  if (contract.capabilities.includes("SCRIPT_E2E") && !evidence.some((item) => item && item.type === "executed_test" && item.executed === true && String(item.scenario || "").trim() && String(item.reference || "").trim())) {
    throw new Error("SCRIPT_E2E requires executed-test evidence tied to a scenario");
  }
  return contract;
}

export function artifactManifestPath(project) {
  return path.join(project.handoffDir || path.join(project.root, "work", "handoffs"), "artifacts.json");
}

export function readArtifactManifest(project) {
  const file = artifactManifestPath(project);
  if (!fs.existsSync(file)) return { version: 1, artifacts: [], current: {} };
  const manifest = readJson(file);
  if (manifest.version !== 1 || !Array.isArray(manifest.artifacts) || !manifest.current || typeof manifest.current !== "object") throw new Error("invalid artifact manifest");
  return manifest;
}

export function registerCandidateArtifact(project, artifact) {
  const relativePath = String(artifact.relative_path || "").replace(/\\/g, "/");
  const target = normalizePath(path.join(project.root, relativePath));
  if (!relativePath || path.isAbsolute(relativePath) || !isWithin(project.root, target) || !fs.existsSync(target)) throw new Error("artifact path is missing or escapes project root");
  const contentHash = fileHash(target);
  if (artifact.content_hash && artifact.content_hash !== contentHash) throw new Error("artifact content hash mismatch");
  const manifest = readArtifactManifest(project);
  const record = { logical_id: assertSafeId(artifact.logical_id, "logical_id"), version: assertSafeId(artifact.version, "artifact version"), relative_path: relativePath, content_hash: contentHash, status: "candidate", source_task: String(artifact.source_task), source_revision: String(artifact.source_revision), approval_ref: null };
  const key = record.logical_id + "\n" + record.version;
  if (manifest.artifacts.some((item) => item.logical_id + "\n" + item.version === key)) throw new Error("artifact logical ID/version already exists");
  manifest.artifacts.push(record);
  atomicWriteJson(artifactManifestPath(project), manifest);
  return record;
}

export function approveArtifact(project, request) {
  const manifest = readArtifactManifest(project);
  const item = manifest.artifacts.find((entry) => entry.logical_id === request.logical_id && entry.version === request.version);
  if (!item || item.status !== "candidate") throw new Error("matching candidate artifact not found");
  if (!request.approval_ref) throw new Error("approval_ref is required");
  if (item.relative_path !== String(request.relative_path || "").replace(/\\/g, "/") || item.content_hash !== request.content_hash) throw new Error("artifact path/hash mismatch");
  const target = normalizePath(path.join(project.root, item.relative_path));
  if (!isWithin(project.root, target) || !fs.existsSync(target) || fileHash(target) !== item.content_hash) throw new Error("artifact file no longer matches manifest");
  for (const old of manifest.artifacts) if (old.logical_id === item.logical_id && old.status === "approved") old.status = "superseded";
  item.status = "approved";
  item.approval_ref = String(request.approval_ref);
  manifest.current[item.logical_id] = { version: item.version, content_hash: item.content_hash, relative_path: item.relative_path };
  atomicWriteJson(artifactManifestPath(project), manifest);
  return item;
}
