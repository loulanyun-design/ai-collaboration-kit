import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const POLICY_SCHEMA_VERSION = 1;

const RESTRICTION_KEYS = new Set([
  "forbid_recursive_delegation",
  "require_single_writer",
  "require_task_side_effect_flags",
  "require_code_worktree",
  "require_code_allowlist",
  "require_code_commit",
  "require_structured_result",
  "require_chatgpt_business_acceptance",
  "forbid_unknown_auto_retry",
  "forbid_unknown_lock_autoclear",
  "require_explicit_user_for_merge",
  "require_explicit_user_for_push",
  "require_explicit_user_for_deploy",
  "require_explicit_user_for_publish",
  "require_explicit_user_for_external_upload",
  "require_explicit_user_for_production_write",
]);

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("policy JSON contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("policy JSON contains an unsupported value");
  }
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
  return out;
}

export function canonicalPolicyJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function within(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

function readManifest(manifestPath, expectedId, baseDir) {
  if (!manifestPath || !fs.existsSync(manifestPath)) throw new Error("missing policy manifest: " + manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("policy manifest must be an object");
  const allowed = new Set(["schema_version", "policy_id", "normative_files", "restrictions"]);
  for (const key of Object.keys(manifest)) if (!allowed.has(key)) throw new Error("unknown policy manifest field: " + key);
  if (manifest.schema_version !== POLICY_SCHEMA_VERSION) throw new Error("unknown policy schema version: " + manifest.schema_version);
  if (manifest.policy_id !== expectedId) throw new Error("policy_id mismatch: expected " + expectedId);
  if (!Array.isArray(manifest.normative_files) || manifest.normative_files.length === 0) {
    throw new Error("policy normative_files must be a non-empty array");
  }
  if (!manifest.restrictions || typeof manifest.restrictions !== "object" || Array.isArray(manifest.restrictions)) {
    throw new Error("policy restrictions must be an object");
  }
  for (const [key, value] of Object.entries(manifest.restrictions)) {
    if (!RESTRICTION_KEYS.has(key)) throw new Error("unknown policy restriction: " + key);
    if (typeof value !== "boolean") throw new Error("policy restriction must be boolean: " + key);
  }

  const files = [...manifest.normative_files].sort();
  if (new Set(files).size !== files.length) throw new Error("policy normative_files contains duplicates");
  const contents = [];
  for (const relative of files) {
    if (typeof relative !== "string" || !relative.trim() || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new Error("unsafe normative policy path: " + String(relative));
    }
    const file = path.resolve(baseDir, relative);
    if (!within(baseDir, file)) throw new Error("normative policy path escapes policy root: " + relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("missing normative policy file: " + file);
    const realBase = fs.realpathSync(baseDir);
    const realFile = fs.realpathSync(file);
    if (!within(realBase, realFile)) throw new Error("normative policy symlink escapes policy root: " + relative);
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    contents.push(relative.replace(/\\/g, "/") + "\n" + text);
  }

  const canonicalManifest = { ...manifest, normative_files: files };
  return {
    manifest,
    manifestHash: sha(canonicalPolicyJson(canonicalManifest)),
    normativeDigest: sha(contents.join("\n\u0000\n")),
  };
}

export function loadPolicyIdentity({ rootDir, projectDir, rootManifestPath, projectManifestPath, projectId }) {
  if (!within(rootDir, rootManifestPath)) throw new Error("root policy manifest escapes collaboration root");
  if (!within(projectDir, projectManifestPath)) throw new Error("project policy manifest escapes registered project");
  for (const [baseDir, manifestPath, label] of [
    [rootDir, rootManifestPath, "root"],
    [projectDir, projectManifestPath, "project"],
  ]) {
    if (!fs.existsSync(manifestPath)) throw new Error("missing policy manifest: " + manifestPath);
    const realBase = fs.realpathSync(baseDir);
    const realManifest = fs.realpathSync(manifestPath);
    if (!within(realBase, realManifest)) throw new Error(label + " policy manifest symlink escapes policy root");
  }
  const root = readManifest(rootManifestPath, "root", path.dirname(rootManifestPath));
  const project = readManifest(projectManifestPath, projectId, path.dirname(projectManifestPath));
  const effectiveRestrictions = { ...root.manifest.restrictions };
  for (const [key, value] of Object.entries(project.manifest.restrictions)) {
    if (root.manifest.restrictions[key] === true && value === false) {
      throw new Error("project policy cannot weaken root restriction: " + key);
    }
    if (value) effectiveRestrictions[key] = true;
  }
  const identity = {
    policy_schema_version: String(POLICY_SCHEMA_VERSION),
    root_policy_manifest_hash: root.manifestHash,
    root_normative_digest: root.normativeDigest,
    project_policy_manifest_hash: project.manifestHash,
    project_normative_digest: project.normativeDigest,
  };
  identity.effective_policy_hash = sha(canonicalPolicyJson({
    schema_version: POLICY_SCHEMA_VERSION,
    root_manifest_hash: identity.root_policy_manifest_hash,
    root_normative_digest: identity.root_normative_digest,
    project_manifest_hash: identity.project_policy_manifest_hash,
    project_normative_digest: identity.project_normative_digest,
    effective_restrictions: effectiveRestrictions,
  }));
  return identity;
}

export function assertPolicyIdentityMatches(meta, currentIdentity) {
  for (const [key, expected] of Object.entries(currentIdentity)) {
    if (String(meta[key] || "") !== expected) throw new Error("policy identity mismatch: " + key);
  }
  return currentIdentity;
}
