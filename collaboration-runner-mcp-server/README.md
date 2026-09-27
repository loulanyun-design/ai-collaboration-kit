# Collaboration Runner MCP Server

A thin MCP transport for the sibling Collaboration Runner. It exposes only five structured actions: `runner_preflight`, `runner_submit`, `runner_status`, `runner_result`, and `runner_resume`.

The public kit defaults to local-only development mode via `scripts/start-runner-mcp-local.ps1`. For remote access, configure your own HTTPS/authentication boundary; see `../docs/REMOTE_MCP.md`.
