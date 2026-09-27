import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PILOT_ROOT = path.resolve(HERE, "..");
const TARGET = path.join(PILOT_ROOT, ".tools", "codex");
const PACKAGE = "@openai/codex";
const VERSION = "0.155.1";
const npmCli =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

if (!fs.existsSync(npmCli)) {
  console.error("npm CLI entry was not found:", npmCli);
  process.exit(4);
}

fs.mkdirSync(TARGET, { recursive: true });

const install = spawnSync(
  process.execPath,
  [npmCli, "install", "--prefix", TARGET, PACKAGE + "@" + VERSION, "--no-audit", "--no-fund"],
  {
    cwd: PILOT_ROOT,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: "inherit"
  }
);

if (install.error) {
  console.error("Failed to start npm CLI:", install.error.message);
}

if (install.status !== 0) {
  process.exit(install.status ?? 1);
}

const codexJs = path.join(TARGET, "node_modules", "@openai", "codex", "bin", "codex.js");
if (!fs.existsSync(codexJs)) {
  console.error("Installed package but Codex JS entry was not found:", codexJs);
  process.exit(2);
}

const version = spawnSync(process.execPath, [codexJs, "--version"], {
  cwd: PILOT_ROOT,
  encoding: "utf8",
  shell: false,
  windowsHide: true
});

if (version.status !== 0) {
  process.stderr.write(version.stderr || "");
  process.exit(version.status ?? 3);
}

process.stdout.write("isolated_codex_path=" + codexJs + "\n");
process.stdout.write("isolated_codex_version=" + String(version.stdout || "").trim() + "\n");
