# AI Collaboration Kit

A local-first collaboration workflow for ChatGPT, DevSpace-style local tooling, a guarded Runner, Codex CLI, Jev-style continuation decisions, and MCP transport.

This is a curated public edition. It intentionally excludes private projects, credentials, runtime logs, handoff history, personal hostnames, and machine-specific secrets.

## Included

- Collaboration policy + handoff engine
- Guarded Collaboration Runner
- Thin Runner MCP server exposing only: runner_preflight, runner_submit, runner_status, runner_result, runner_resume
- Optional DevSpace integration examples
- Safe sample project

## Safety defaults

- loopback-only services
- no embedded tokens, passwords, OAuth secrets, Tailscale hostnames, or private project data
- no automatic project discovery
- no recursive delegation
- no automatic merge, push, deploy, publish, upload, final submit, or production writes
- no arbitrary shell or arbitrary prompt exposed through Runner MCP

## Quick start

Requirements: Windows 10/11, PowerShell 5.1+, Node.js 20+ recommended, and Git. Codex CLI and DevSpace are optional depending on the workflow you want.

After cloning/downloading:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup.ps1
```

Create a sample handoff:

```powershell
node .\collaboration\handoff.mjs --project sample-project new demo-task --type non_code
```

Then start the local-only Runner MCP development endpoint:

```powershell
.\scripts\start-runner-mcp-local.ps1
```

For remote ChatGPT access, do not expose development no-auth mode. See `docs/REMOTE_MCP.md`.

## Layout

```text
collaboration/                   shared handoff/state tooling
collaboration-runner-pilot/      guarded Runner / Codex layer
collaboration-runner-mcp-server/ thin MCP transport
scripts/devspace/                optional DevSpace examples
examples/sample-project/         safe sample project
docs/                            architecture and deployment notes
```

DevSpace itself is an external dependency and is not redistributed here.

## License

MIT. See `LICENSE`.
