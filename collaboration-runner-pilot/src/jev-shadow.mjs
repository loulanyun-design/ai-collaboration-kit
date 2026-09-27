import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JOBS_ROOT,
  RUNTIME_ROOT,
  atomicWriteJson,
  nowIso,
  readJson,
  sha256,
  updateJob
} from "./lib.mjs";
import { runJevChoiceWithFallback } from "./jev.mjs";

export const JEV_SHADOW_KINDS = Object.freeze(["skill", "progress", "completion"]);
export const JEV_SHADOW_CONFIG = path.join(RUNTIME_ROOT, "jev-shadow", "config.json");

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  kinds: {
    skill: true,
    progress: true,
    completion: true
  },
  minConfidence: 0.01,
  timeoutMs: 8000,
  maxSkills: 40
});

function clip(value, max = 2200) {
  const text = String(value || "").trim();
  return text.length <= max ? text : text.slice(0, max) + "\n[truncated]";
}

function extractSection(body, heading, max = 2200) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const wanted = "## " + heading;
  let active = false;
  const out = [];
  for (const line of lines) {
    if (line.trim() === wanted) {
      active = true;
      continue;
    }
    if (active && /^##\s+/.test(line)) break;
    if (active) out.push(line);
  }
  return clip(out.join("\n"), max);
}

function normalizedConfig(value = {}) {
  const kinds = value.kinds && typeof value.kinds === "object" ? value.kinds : {};
  const minConfidence = Number(value.minConfidence ?? DEFAULT_CONFIG.minConfidence);
  const timeoutMs = Number(value.timeoutMs ?? DEFAULT_CONFIG.timeoutMs);
  const maxSkills = Number(value.maxSkills ?? DEFAULT_CONFIG.maxSkills);
  return {
    enabled: value.enabled === true,
    kinds: {
      skill: kinds.skill !== false,
      progress: kinds.progress !== false,
      completion: kinds.completion !== false
    },
    minConfidence: Number.isFinite(minConfidence) && minConfidence > 0 && minConfidence <= 1
      ? minConfidence
      : DEFAULT_CONFIG.minConfidence,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 30000
      ? Math.round(timeoutMs)
      : DEFAULT_CONFIG.timeoutMs,
    maxSkills: Number.isFinite(maxSkills) && maxSkills >= 1 && maxSkills <= 80
      ? Math.round(maxSkills)
      : DEFAULT_CONFIG.maxSkills
  };
}

export function readJevShadowConfig() {
  if (!fs.existsSync(JEV_SHADOW_CONFIG)) return normalizedConfig();
  try {
    return normalizedConfig(readJson(JEV_SHADOW_CONFIG));
  } catch {
    return normalizedConfig();
  }
}

export function writeJevShadowConfig(patch = {}) {
  const current = readJevShadowConfig();
  const next = normalizedConfig({
    ...current,
    ...patch,
    kinds: {
      ...current.kinds,
      ...(patch.kinds || {})
    }
  });
  fs.mkdirSync(path.dirname(JEV_SHADOW_CONFIG), { recursive: true });
  atomicWriteJson(JEV_SHADOW_CONFIG, {
    ...next,
    updatedAt: nowIso()
  });
  return next;
}

function parseSkillFrontMatter(text, fallbackName) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n/);
  const head = match ? match[1] : normalized.slice(0, 3000);
  let name = fallbackName;
  let description = "";
  for (const line of head.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key === "name" && value) name = value;
    if (key === "description" && value) description = value;
  }
  return { name: String(name || fallbackName), description: clip(description, 360) };
}

export function discoverSkillCatalog({
  env = process.env,
  home = os.homedir(),
  maxSkills = DEFAULT_CONFIG.maxSkills,
  taskText = ""
} = {}) {
  const root = env.JEV_SHADOW_SKILLS_ROOT
    ? path.resolve(env.JEV_SHADOW_SKILLS_ROOT)
    : path.join(env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex"), "skills");
  if (!fs.existsSync(root)) return [];

  const task = String(taskText || "").toLowerCase();
  const entries = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const skillFile = path.join(root, dirent.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    try {
      const parsed = parseSkillFrontMatter(fs.readFileSync(skillFile, "utf8"), dirent.name);
      const hay = (parsed.name + " " + parsed.description).toLowerCase();
      const nameTokens = parsed.name.toLowerCase().split(/[-_\s/]+/).filter((x) => x.length >= 3);
      let score = task.includes(parsed.name.toLowerCase()) ? 100 : 0;
      for (const token of nameTokens) if (task.includes(token)) score += 8;
      const taskTokens = task.split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 3);
      for (const token of taskTokens.slice(0, 40)) if (hay.includes(token)) score += 1;
      entries.push({ ...parsed, path: skillFile, score });
    } catch {}
  }

  entries.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return entries.slice(0, Math.max(1, Math.min(Number(maxSkills) || DEFAULT_CONFIG.maxSkills, 80)));
}

function baseState({ job, current }) {
  return {
    project_id: job.projectId || current?.meta?.project_id || null,
    task_id: job.taskId || current?.meta?.task_id || null,
    handoff_revision: job.revision || current?.meta?.handoff_revision || null,
    task_type: job.taskType || current?.meta?.task_type || null,
    goal: extractSection(current?.body, "Goal"),
    intended_flow: extractSection(current?.body, "State Machine / Intended Flow", 1600),
    technical_acceptance: extractSection(current?.body, "Codex Technical Acceptance", 1800),
    business_acceptance: extractSection(current?.body, "ChatGPT Business Acceptance", 1800),
    stop_conditions: extractSection(current?.body, "Stop Conditions", 1200)
  };
}

function structuredEvidence(executorResult) {
  const structured = executorResult && executorResult.structuredResult;
  if (!structured || typeof structured !== "object") return null;
  return {
    completion_basis: clip(structured.completion_basis, 1600),
    evidence: Array.isArray(structured.evidence)
      ? structured.evidence.slice(0, 12).map((x) => clip(x, 400))
      : [],
    changed_files: Array.isArray(structured.changed_files)
      ? structured.changed_files.slice(0, 40)
      : [],
    tests: structured.tests || null,
    remaining_risks: Array.isArray(structured.remaining_risks)
      ? structured.remaining_risks.slice(0, 12).map((x) => clip(x, 400))
      : []
  };
}

function resultEvidence(resultDoc) {
  if (!resultDoc) return null;
  return {
    status: resultDoc.meta?.status || null,
    next_owner: resultDoc.meta?.next_owner || null,
    completion_basis: extractSection(resultDoc.body, "Root Cause / Completion Basis", 1800),
    acceptance_evidence: extractSection(resultDoc.body, "Acceptance Evidence", 2200),
    tests: extractSection(resultDoc.body, "Tests", 1800),
    remaining_risks: extractSection(resultDoc.body, "Remaining Risks / Unknowns", 1600),
    scope_check: extractSection(resultDoc.body, "Scope Check", 1200)
  };
}

export function buildJevShadowQuestion(kind, {
  job,
  current,
  executorResult = null,
  resultDoc = null,
  skillCatalog = null,
  config = readJevShadowConfig()
}) {
  if (!JEV_SHADOW_KINDS.includes(kind)) throw new Error("unsupported Jev shadow kind: " + kind);
  const common = baseState({ job, current });

  if (kind === "skill") {
    const taskText = [
      common.project_id,
      common.goal,
      common.intended_flow,
      common.technical_acceptance
    ].filter(Boolean).join("\n");
    const skills = skillCatalog || discoverSkillCatalog({
      taskText,
      maxSkills: config.maxSkills
    });
    const criteria = {
      NONE: "No listed skill materially improves this task; ordinary project instructions and tools are sufficient."
    };
    for (const item of skills) {
      if (!/^[A-Za-z0-9._-]{1,120}$/.test(item.name) || item.name === "NONE") continue;
      criteria[item.name] = item.description || ("Use the " + item.name + " skill when it directly matches the task.");
    }
    if (Object.keys(criteria).length < 2) {
      criteria.GENERIC_PROJECT_RULES = "No specific installed skill is available; rely on the project rules and normal tools.";
    }
    return {
      instructions: "Select the single primary installed skill that would be most useful to load first for this task. Do not select a skill merely because it is available. This is advisory shadow routing only.",
      criteria,
      state: JSON.stringify({
        ...common,
        skill_candidates: skills.map((x) => ({ name: x.name, description: x.description }))
      }),
      metadata: { candidateCount: skills.length }
    };
  }

  if (kind === "progress") {
    return {
      instructions: "Classify whether the executor made meaningful progress toward the stated task before reaching its observed terminal state. Judge evidence, not optimism.",
      criteria: {
        ADVANCING: "There is concrete evidence of meaningful progress toward the goal, even if the task later failed or needs more work.",
        STALLED: "The executor spent effort but did not materially advance the task, repeated the same state, or got stuck.",
        OFF_TRACK: "The executor materially worked outside the delegated goal, acceptance criteria, or intended flow.",
        INSUFFICIENT_EVIDENCE: "The available bounded evidence is not enough to distinguish advancing, stalled, or off-track."
      },
      state: JSON.stringify({
        ...common,
        runner_terminal: {
          state: job.state || null,
          phase: job.phase || null,
          failure_kind: job.failureKind || null,
          failure_message: clip(job.failureMessage, 1200),
          executor_exit_code: job.executorExitCode ?? null,
          result_materialized: job.structuredResultMaterialized === true
        },
        structured_executor_evidence: structuredEvidence(executorResult),
        result_evidence: resultEvidence(resultDoc)
      }),
      metadata: {}
    };
  }

  return {
    instructions: "Classify whether the delegated task appears complete against the stated acceptance criteria using only the bounded evidence. Do not treat process exit or a RESULT file by itself as proof of completion.",
    criteria: {
      COMPLETE: "The evidence supports that the delegated goal and stated acceptance criteria were completed within scope.",
      INCOMPLETE: "The evidence shows material required work or acceptance criteria remain unfinished.",
      NEEDS_REVIEW: "The task may be technically complete but a human-owned business acceptance, approval, or judgment is still necessary.",
      INSUFFICIENT_EVIDENCE: "The bounded evidence is insufficient to determine completion."
    },
    state: JSON.stringify({
      ...common,
      runner_terminal: {
        state: job.state || null,
        handoff_state: job.handoffState || null,
        phase: job.phase || null,
        failure_kind: job.failureKind || null
      },
      structured_executor_evidence: structuredEvidence(executorResult),
      result_evidence: resultEvidence(resultDoc)
    }),
    metadata: {}
  };
}

function shadowLogPath(job) {
  return path.join(job.jobDir, "jev-shadow.jsonl");
}

function publicShadowResult(result) {
  return {
    choice: result.choice || null,
    accepted: result.accepted === true,
    source: result.source || null,
    reason: result.reason || null,
    confidence: result.confidence ?? null,
    minConfidence: result.minConfidence ?? null,
    model: result.model || null,
    provider: result.provider || null,
    probabilities: result.probabilities || null,
    usage: result.usage || null,
    error: result.error || null,
    httpStatus: result.httpStatus || null,
    exitCode: result.exitCode ?? null
  };
}

function recordShadowEvent(jobFile, kind, question, result) {
  const job = readJson(jobFile);
  const logPath = shadowLogPath(job);
  const event = {
    recordedAt: nowIso(),
    kind,
    taskId: job.taskId,
    revision: job.revision,
    stateHash: sha256(question.state),
    inputBytes: Buffer.byteLength(question.state, "utf8"),
    ...question.metadata,
    ...publicShadowResult(result)
  };
  fs.appendFileSync(logPath, JSON.stringify(event) + "\n", "utf8");

  const latest = {
    ...(job.jevShadowLatest && typeof job.jevShadowLatest === "object" ? job.jevShadowLatest : {}),
    [kind]: event
  };
  updateJob(jobFile, {
    jevShadowEnabled: true,
    jevShadowLog: logPath,
    jevShadowLatest: latest
  });
  return event;
}

export async function runJevShadowSet({
  jobFile,
  current,
  executorResult = null,
  resultDoc = null,
  config = readJevShadowConfig(),
  runner = runJevChoiceWithFallback,
  skillCatalog = null
}) {
  if (!config.enabled) return { enabled: false, events: [] };
  const job = readJson(jobFile);
  const enabledKinds = JEV_SHADOW_KINDS.filter((kind) => config.kinds[kind] !== false);
  const events = [];

  for (const kind of enabledKinds) {
    try {
      const question = buildJevShadowQuestion(kind, {
        job,
        current,
        executorResult,
        resultDoc,
        skillCatalog,
        config
      });
      const result = await runner({
        state: question.state,
        instructions: question.instructions,
        criteria: question.criteria,
        minConfidence: config.minConfidence,
        timeoutMs: config.timeoutMs
      });
      events.push(recordShadowEvent(jobFile, kind, question, result));
    } catch (err) {
      const question = {
        state: JSON.stringify(baseState({ job, current })),
        metadata: {}
      };
      events.push(recordShadowEvent(jobFile, kind, question, {
        choice: null,
        accepted: false,
        source: "shadow_error",
        reason: "shadow_exception",
        error: String(err && err.message ? err.message : err)
      }));
    }
  }

  return { enabled: true, events };
}

export function jevShadowStatus({ limit = 12 } = {}) {
  const config = readJevShadowConfig();
  const totals = {
    jobsWithShadow: 0,
    events: 0,
    byKind: Object.fromEntries(JEV_SHADOW_KINDS.map((kind) => [kind, 0])),
    accepted: 0,
    errors: 0
  };
  const recent = [];

  if (fs.existsSync(JOBS_ROOT)) {
    for (const name of fs.readdirSync(JOBS_ROOT)) {
      const jobFile = path.join(JOBS_ROOT, name, "job.json");
      const logFile = path.join(JOBS_ROOT, name, "jev-shadow.jsonl");
      if (!fs.existsSync(jobFile) || !fs.existsSync(logFile)) continue;
      totals.jobsWithShadow += 1;
      const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          totals.events += 1;
          if (event.kind in totals.byKind) totals.byKind[event.kind] += 1;
          if (event.accepted === true) totals.accepted += 1;
          if (event.error || event.reason === "shadow_exception") totals.errors += 1;
          recent.push({
            jobId: name,
            recordedAt: event.recordedAt,
            kind: event.kind,
            choice: event.choice,
            confidence: event.confidence,
            accepted: event.accepted,
            reason: event.reason
          });
        } catch {}
      }
    }
  }

  recent.sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)));
  return {
    config,
    configPath: JEV_SHADOW_CONFIG,
    totals,
    recent: recent.slice(0, Math.max(1, Math.min(Number(limit) || 12, 50)))
  };
}
