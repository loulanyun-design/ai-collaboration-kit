import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPolicyIdentityMatches, loadPolicyIdentity } from "./policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ROOT_RULES = path.join(ROOT, "AGENTS.md");
const ROOT_POLICY = path.join(HERE, "policies", "root-policy-v1.json");
const REGISTRY = path.join(HERE, "projects.json");
const CURRENT_TEMPLATE = path.join(HERE, "templates", "CURRENT_TEMPLATE.md");
const RESULT_TEMPLATE = path.join(HERE, "templates", "RESULT_TEMPLATE.md");

function fail(message, code = 1) {
  console.error("[handoff] ERROR:", message);
  process.exit(code);
}

function nowIso() {
  return new Date().toISOString();
}

function norm(p) {
  return path.resolve(p).replace(/\//g, "\\").toLowerCase();
}

function parseArgs(argv) {
  const args = [...argv];
  let project = "";
  const idx = args.indexOf("--project");
  if (idx >= 0) {
    project = args[idx + 1] || "";
    args.splice(idx, 2);
  }
  return { project, command: args[0] || "status", rest: args.slice(1) };
}

function readRegistry() {
  if (!fs.existsSync(REGISTRY)) fail("missing registry: " + REGISTRY);
  const data = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  if (!Array.isArray(data.projects)) fail("registry.projects must be an array");
  return data.projects;
}

function resolveProject(selector) {
  if (!selector) fail("missing --project <project id or path>");
  const projects = readRegistry();
  const normalizedSelector = norm(selector);
  const hit = projects.find((p) =>
    p.id === selector ||
    norm(p.path) === normalizedSelector
  );
  if (!hit) fail("project is not explicitly enrolled: " + selector);
  if (hit.enabled !== true) fail("project is registered but disabled: " + hit.id);
  const projectRoot = path.resolve(hit.path);
  const projectRules = path.resolve(projectRoot, hit.project_rules || "AGENTS.md");
  const handoffDir = path.resolve(projectRoot, hit.handoff_dir || path.join("work", "handoffs"));
  const policyManifest = path.resolve(projectRoot, hit.policy_manifest || "COLLAB_POLICY.json");
  const policyRelative = path.relative(projectRoot, policyManifest);
  if (policyRelative === ".." || policyRelative.startsWith(".." + path.sep) || path.isAbsolute(policyRelative)) {
    fail("project policy_manifest escapes registered project");
  }
  return {
    id: hit.id,
    root: projectRoot,
    rules: projectRules,
    policyManifest,
    handoffDir,
    current: path.join(handoffDir, "current.md"),
    result: path.join(handoffDir, "RESULT.md"),
    lock: path.join(handoffDir, ".handoff.lock.json"),
  };
}

function git(args, cwd, allowFail = false) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (r.status !== 0 && !allowFail) {
    fail("git " + args.join(" ") + " failed:\n" + (r.stderr || r.stdout || ""));
  }
  return { ok: r.status === 0, out: String(r.stdout || "").trim(), err: String(r.stderr || "").trim() };
}

function parseFrontMatter(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) fail("handoff file is missing front matter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) fail("handoff front matter is not closed");
  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const meta = {};
  const order = [];
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx < 0) fail("invalid front matter line: " + line);
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    meta[key] = value;
    order.push(key);
  }
  return { meta, order, body };
}

function serializeFrontMatter(doc) {
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
  return "---\n" + lines.join("\n") + "\n---\n" + doc.body.replace(/^\n+/, "");
}

function readDoc(file) {
  if (!fs.existsSync(file)) fail("missing file: " + file);
  return parseFrontMatter(fs.readFileSync(file, "utf8"));
}

function writeDoc(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeFrontMatter(doc), "utf8");
}

function readText(file) {
  if (!fs.existsSync(file)) fail("missing file: " + file);
  return fs.readFileSync(file, "utf8");
}

function sha(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function fileHash(file) {
  return sha(readText(file).replace(/\r\n/g, "\n"));
}

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

function meaningful(text) {
  return String(text || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*[-*]\s*(?:\[[ xX]\])?\s*$/gm, "")
    .replace(/^\s*(Codex may:|Codex may NOT:)\s*$/gmi, "")
    .trim().length >= 3;
}

function boolString(value, key) {
  const v = String(value || "").toLowerCase();
  if (v !== "true" && v !== "false") fail(key + " must be true or false");
  return v;
}

function slug(text) {
  const ascii = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ascii || "task";
}

function generatedTaskId(task) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  return stamp + "-" + slug(task);
}

const MUTABLE_SPEC_FIELDS = new Set([
  "status", "owner", "updated_at", "spec_hash"
]);

function specHash(doc) {
  const meta = {};
  for (const key of Object.keys(doc.meta).sort()) {
    if (MUTABLE_SPEC_FIELDS.has(key)) continue;
    meta[key] = String(doc.meta[key] ?? "");
  }
  const payload = JSON.stringify(meta) + "\n" + doc.body.replace(/\r\n/g, "\n").trim();
  return sha(payload);
}

function lockData(P) {
  if (!fs.existsSync(P.lock)) return null;
  try {
    return JSON.parse(fs.readFileSync(P.lock, "utf8"));
  } catch {
    fail("invalid lock JSON: " + P.lock);
  }
}

function ensureNoLock(P) {
  const lock = lockData(P);
  if (lock) fail("project handoff lock is already held by task " + lock.task_id);
}

function writeLock(P, data) {
  fs.writeFileSync(P.lock, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function releaseLock(P) {
  if (fs.existsSync(P.lock)) fs.unlinkSync(P.lock);
}

function validateProjectFiles(P) {
  if (!fs.existsSync(ROOT_RULES)) fail("missing root rules: " + ROOT_RULES);
  if (!fs.existsSync(P.rules)) fail("missing project rules: " + P.rules);
  if (!fs.existsSync(P.current)) fail("missing project current handoff: " + P.current);
}

function policyIdentity(P) {
  return loadPolicyIdentity({
    rootDir: ROOT,
    projectDir: P.root,
    rootManifestPath: ROOT_POLICY,
    projectManifestPath: P.policyManifest,
    projectId: P.id,
  });
}

function validatePolicySchema(doc) {
  const version = String(doc.meta.policy_schema_version || "");
  if (Object.prototype.hasOwnProperty.call(doc.meta, "policy_schema_version") && version !== "1") {
    fail("unknown policy_schema_version: " + version);
  }
  return Object.prototype.hasOwnProperty.call(doc.meta, "policy_schema_version") ? version : "";
}

function validateRequiredSections(doc) {
  for (const heading of [
    "Goal",
    "State Machine / Intended Flow",
    "Confirmed Facts",
    "Delegated Scope",
    "Codex Technical Acceptance",
    "ChatGPT Business Acceptance",
  ]) {
    if (!meaningful(section(doc.body, heading))) {
      fail("required section is empty or placeholder: " + heading);
    }
  }
  if (doc.meta.task_type === "non_code" && !meaningful(section(doc.body, "Deliverables"))) {
    fail("non_code task requires Deliverables");
  }
}

function validateMetaForPrepare(doc, P) {
  if (!String(doc.meta.task || "").trim()) fail("task is required");
  if (!["code", "non_code"].includes(doc.meta.task_type)) fail("task_type must be code or non_code");
  for (const key of [
    "allow_real_system_write",
    "allow_bulk_write",
    "allow_final_submit",
    "allow_git_push",
    "allow_external_upload",
  ]) {
    doc.meta[key] = boolString(doc.meta[key], key);
  }
  doc.meta.project_id = P.id;
  doc.meta.project_root = P.root;
  doc.meta.project_rules = P.rules;
  doc.meta.handoff_dir = P.handoffDir;
}

function resultSkeleton(doc, P) {
  const result = parseFrontMatter(readText(RESULT_TEMPLATE));
  result.meta.project_id = P.id;
  result.meta.task_id = doc.meta.task_id;
  result.meta.task_type = doc.meta.task_type;
  result.meta.status = "DRAFT";
  result.meta.owner = "Codex";
  result.meta.branch = doc.meta.branch || "";
  result.meta.base_commit = doc.meta.base_commit || "";
  result.meta.result_commit = "";
  result.meta.next_owner = "";
  result.meta.updated_at = nowIso();
  return result;
}

function printStatus(P, doc = readDoc(P.current)) {
  const m = doc.meta;
  console.log("project_id:", P.id);
  console.log("task_id:", m.task_id || "(empty)");
  console.log("task:", m.task || "(empty)");
  console.log("task_type:", m.task_type || "(empty)");
  console.log("revision:", m.handoff_revision || "(empty)");
  console.log("owner:", m.owner || "(empty)");
  console.log("status:", m.status || "(empty)");
  console.log("base_commit:", m.base_commit || "(n/a)");
  console.log("branch:", m.branch || "(n/a)");
  console.log("worktree:", m.codex_worktree || "(n/a)");
  console.log("spec_hash:", m.spec_hash || "(empty)");
  console.log("root_rules:", ROOT_RULES);
  console.log("project_rules:", P.rules);
  console.log("current:", P.current);
  console.log("result:", P.result);
  const lock = lockData(P);
  console.log("lock:", lock ? "HELD by " + lock.task_id : "free");
}

function commandContext(P) {
  validateProjectFiles(P);
  const blocks = [
    ["ROOT RULES", ROOT_RULES],
    ["PROJECT RULES", P.rules],
    ["CURRENT HANDOFF", P.current],
  ];
  for (const [label, file] of blocks) {
    console.log("\n===== " + label + " =====");
    console.log("PATH: " + file);
    console.log(readText(file));
  }
}

function commandNew(P, args) {
  if (fs.existsSync(P.current)) {
    const existing = readDoc(P.current);
    if (["IN_PROGRESS", "REVIEW"].includes(existing.meta.status)) {
      fail("cannot replace current handoff while status is " + existing.meta.status);
    }
  }
  ensureNoLock(P);
  const taskParts = [];
  let taskType = "code";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type") {
      taskType = args[i + 1] || "";
      i += 1;
      continue;
    }
    taskParts.push(args[i]);
  }
  const task = taskParts.join(" ").trim();
  if (!task) fail('usage: new "task name" [--type code|non_code]');
  if (!["code", "non_code"].includes(taskType)) fail("--type must be code or non_code");
  const doc = parseFrontMatter(readText(CURRENT_TEMPLATE));
  doc.meta.project_id = P.id;
  doc.meta.task = task;
  doc.meta.task_type = taskType;
  doc.meta.task_id = generatedTaskId(task);
  doc.meta.created_at = nowIso();
  doc.meta.updated_at = doc.meta.created_at;
  doc.meta.owner = "ChatGPT";
  doc.meta.status = "DRAFT";
  doc.meta.project_root = P.root;
  doc.meta.project_rules = P.rules;
  doc.meta.handoff_dir = P.handoffDir;
  writeDoc(P.current, doc);
  if (fs.existsSync(P.result)) fs.unlinkSync(P.result);
  console.log("[handoff] created DRAFT:", doc.meta.task_id);
}

function commandPrepare(P, args = []) {
  ensureNoLock(P);
  validateProjectFiles(P);
  const doc = readDoc(P.current);
  if (!["DRAFT", "BLOCKED"].includes(doc.meta.status)) {
    fail("prepare requires DRAFT or BLOCKED, current status=" + doc.meta.status);
  }
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--policy-schema-version") {
      fail("prepare accepts only --policy-schema-version 1");
    }
    if (String(args[1]) !== "1") fail("unknown policy_schema_version: " + String(args[1]));
    if (doc.meta.policy_schema_version && String(doc.meta.policy_schema_version) !== "1") {
      fail("handoff policy_schema_version conflicts with prepare option");
    }
    doc.meta.policy_schema_version = "1";
  }
  validateMetaForPrepare(doc, P);
  validateRequiredSections(doc);

  if (!doc.meta.task_id) doc.meta.task_id = generatedTaskId(doc.meta.task);
  if (!doc.meta.created_at) doc.meta.created_at = nowIso();

  if (doc.meta.status === "BLOCKED") {
    const rev = Number(doc.meta.handoff_revision || "1");
    doc.meta.handoff_revision = String(Number.isFinite(rev) ? rev + 1 : 2);
  }

  if (validatePolicySchema(doc) === "1") {
    Object.assign(doc.meta, policyIdentity(P));
  } else {
    doc.meta.root_rules_hash = fileHash(ROOT_RULES);
    doc.meta.project_rules_hash = fileHash(P.rules);
  }

  if (doc.meta.task_type === "code") {
    const insideGit = git(["rev-parse", "--is-inside-work-tree"], P.root, true);
    if (!insideGit.ok || insideGit.out !== "true") fail("code task requires a Git project");
    const dirty = git(["status", "--porcelain"], P.root).out;
    if (dirty) fail("code task prepare requires clean formal workspace:\n" + dirty);
    doc.meta.base_commit = git(["rev-parse", "HEAD"], P.root).out;
    if (!doc.meta.branch) doc.meta.branch = "codex/" + slug(doc.meta.task_id);
    if (!doc.meta.codex_worktree) {
      doc.meta.codex_worktree = path.join(ROOT, "worktrees", P.id + "-codex-" + slug(doc.meta.task_id));
    }
  } else {
    doc.meta.base_commit = "";
    doc.meta.branch = "";
    doc.meta.codex_worktree = "";
  }

  doc.meta.owner = "Codex";
  doc.meta.status = "READY";
  doc.meta.updated_at = nowIso();
  doc.meta.spec_hash = "";
  doc.meta.spec_hash = specHash(doc);
  writeDoc(P.current, doc);
  console.log("[handoff] READY");
  printStatus(P, doc);
}

function formalDirtyExcludingCurrent(P) {
  const relCurrent = path.relative(P.root, P.current).split(path.sep).join("/");
  const commands = [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ];

  const dirtyPaths = new Set();
  for (const args of commands) {
    const out = git(args, P.root).out;
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      dirtyPaths.add(line.split(path.sep).join("/"));
    }
  }

  dirtyPaths.delete(relCurrent);
  return [...dirtyPaths].sort().join("\n");
}

function validateFrozenContext(P, doc, lock = null) {
  if (validatePolicySchema(doc) === "1") {
    try {
      assertPolicyIdentityMatches(doc.meta, policyIdentity(P));
    } catch (error) {
      fail("policy changed after prepare; create a new handoff revision: " + error.message);
    }
  } else {
    if (fileHash(ROOT_RULES) !== doc.meta.root_rules_hash) {
      fail("root rules changed after prepare; create a new handoff revision");
    }
    if (fileHash(P.rules) !== doc.meta.project_rules_hash) {
      fail("project rules changed after prepare; create a new handoff revision");
    }
  }
  const currentHash = specHash(doc);
  if (currentHash !== doc.meta.spec_hash) fail("handoff spec changed after prepare");
  if (lock && currentHash !== lock.spec_hash) fail("handoff spec changed while task was claimed");
}

function commandClaim(P) {
  ensureNoLock(P);
  validateProjectFiles(P);
  const doc = readDoc(P.current);
  if (doc.meta.status !== "READY") fail("claim requires READY");
  if (doc.meta.owner !== "Codex") fail("claim requires owner=Codex");
  validateFrozenContext(P, doc);

  if (doc.meta.task_type === "code") {
    const dirty = formalDirtyExcludingCurrent(P);
    if (dirty) fail("formal workspace changed after prepare:\n" + dirty);
    const head = git(["rev-parse", "HEAD"], P.root).out;
    if (head !== doc.meta.base_commit) fail("formal HEAD moved after prepare");
    const wt = doc.meta.codex_worktree;
    const branch = doc.meta.branch;
    if (fs.existsSync(wt)) {
      const wtBranch = git(["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]).out;
      if (wtBranch !== branch) fail("existing worktree is on unexpected branch: " + wtBranch);
    } else {
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      const branchExists = git(["show-ref", "--verify", "--quiet", "refs/heads/" + branch], P.root, true).ok;
      if (branchExists) git(["worktree", "add", wt, branch], P.root);
      else git(["worktree", "add", "-b", branch, wt, doc.meta.base_commit], P.root);
    }
  }

  doc.meta.status = "IN_PROGRESS";
  doc.meta.owner = "Codex";
  doc.meta.updated_at = nowIso();
  writeDoc(P.current, doc);

  writeLock(P, {
    project_id: P.id,
    task_id: doc.meta.task_id,
    task_type: doc.meta.task_type,
    handoff_revision: doc.meta.handoff_revision,
    base_commit: doc.meta.base_commit,
    branch: doc.meta.branch,
    worktree: doc.meta.codex_worktree,
    spec_hash: doc.meta.spec_hash,
    claimed_at: nowIso(),
  });

  writeDoc(P.result, resultSkeleton(doc, P));
  console.log("[handoff] IN_PROGRESS");
  console.log("[handoff] task_type:", doc.meta.task_type);
  if (doc.meta.task_type === "code") console.log("[handoff] worktree:", doc.meta.codex_worktree);
  console.log("[handoff] shared current:", P.current);
  console.log("[handoff] shared result:", P.result);
}

function validateResultCommon(result) {
  if (!meaningful(section(result.body, "Root Cause / Completion Basis"))) {
    fail("RESULT.md Root Cause / Completion Basis is empty");
  }
  if (!meaningful(section(result.body, "Evidence"))) fail("RESULT.md Evidence is empty");
}

function commandReturn(P) {
  validateProjectFiles(P);
  const doc = readDoc(P.current);
  if (doc.meta.status !== "IN_PROGRESS") fail("return requires IN_PROGRESS");
  const lock = lockData(P);
  if (!lock) fail("project handoff lock is missing");
  if (lock.task_id !== doc.meta.task_id) fail("lock task_id mismatch");
  validateFrozenContext(P, doc, lock);

  if (!fs.existsSync(P.result)) fail("RESULT.md is missing");
  const result = readDoc(P.result);
  validateResultCommon(result);

  let resultCommit = "";
  if (doc.meta.task_type === "code") {
    const wt = doc.meta.codex_worktree;
    if (!fs.existsSync(wt)) fail("Codex worktree does not exist: " + wt);
    const dirty = git(["-C", wt, "status", "--porcelain"], P.root).out;
    if (dirty) fail("Codex worktree is not clean; commit/stash before return");
    resultCommit = git(["-C", wt, "rev-parse", "HEAD"], P.root).out;
    if (resultCommit === doc.meta.base_commit) fail("code task requires a result commit");
    if (!meaningful(section(result.body, "Changes"))) fail("code RESULT requires Changes");
    if (!meaningful(section(result.body, "Tests"))) fail("code RESULT requires Tests");
  } else {
    if (!meaningful(section(result.body, "Deliverables"))) fail("non_code RESULT requires Deliverables");
    if (!meaningful(section(result.body, "Acceptance Evidence"))) {
      fail("non_code RESULT requires Acceptance Evidence");
    }
  }

  result.meta.project_id = P.id;
  result.meta.task_id = doc.meta.task_id;
  result.meta.task_type = doc.meta.task_type;
  result.meta.status = "REVIEW";
  result.meta.owner = "Codex";
  result.meta.branch = doc.meta.branch || "";
  result.meta.base_commit = doc.meta.base_commit || "";
  result.meta.result_commit = resultCommit;
  result.meta.next_owner = "ChatGPT";
  result.meta.updated_at = nowIso();
  writeDoc(P.result, result);

  doc.meta.status = "REVIEW";
  doc.meta.owner = "ChatGPT";
  doc.meta.updated_at = nowIso();
  writeDoc(P.current, doc);
  releaseLock(P);
  console.log("[handoff] REVIEW");
  if (resultCommit) console.log("[handoff] result commit:", resultCommit);
}

function getOption(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? (args[idx + 1] || "") : "";
}

function commandBlock(P, args) {
  const doc = readDoc(P.current);
  if (!["READY", "IN_PROGRESS"].includes(doc.meta.status)) {
    fail("block requires READY or IN_PROGRESS");
  }
  const reason = getOption(args, "--reason").trim();
  if (!reason) fail('block requires --reason "..."');
  const result = fs.existsSync(P.result) ? readDoc(P.result) : resultSkeleton(doc, P);
  result.meta.status = "BLOCKED";
  result.meta.next_owner = "ChatGPT";
  result.meta.updated_at = nowIso();
  if (!result.body.includes("## Blocked Reason")) {
    result.body = result.body.trimEnd() + "\n\n## Blocked Reason\n\n" + reason + "\n";
  }
  writeDoc(P.result, result);
  doc.meta.status = "BLOCKED";
  doc.meta.owner = "ChatGPT";
  doc.meta.updated_at = nowIso();
  writeDoc(P.current, doc);
  releaseLock(P);
  console.log("[handoff] BLOCKED:", reason);
}

function commandDone(P) {
  const doc = readDoc(P.current);
  if (doc.meta.status !== "REVIEW") fail("done requires REVIEW");
  if (lockData(P)) fail("cannot mark DONE while project lock exists");
  doc.meta.status = "DONE";
  doc.meta.owner = "ChatGPT";
  doc.meta.updated_at = nowIso();
  writeDoc(P.current, doc);
  if (fs.existsSync(P.result)) {
    const result = readDoc(P.result);
    result.meta.status = "DONE";
    result.meta.next_owner = "";
    result.meta.updated_at = nowIso();
    writeDoc(P.result, result);
  }
  console.log("[handoff] DONE");
}

const { project, command, rest } = parseArgs(process.argv.slice(2));
const P = resolveProject(project);

switch (command) {
  case "context": commandContext(P); break;
  case "status": validateProjectFiles(P); printStatus(P); break;
  case "new": commandNew(P, rest); break;
  case "prepare": commandPrepare(P, rest); break;
  case "claim": commandClaim(P); break;
  case "return": commandReturn(P); break;
  case "block": commandBlock(P, rest); break;
  case "done": commandDone(P); break;
  default: fail("unknown command: " + command);
}
