#requires -Version 5.1
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ServerRoot = Join-Path $RepoRoot 'collaboration-runner-mcp-server'
$RunnerRoot = Join-Path $RepoRoot 'collaboration-runner-pilot'

$env:COLLAB_RUNNER_ROOT = $RunnerRoot
$env:COLLAB_RUNNER_MCP_HOST = '127.0.0.1'
$env:COLLAB_RUNNER_MCP_PORT = '7678'
$env:COLLAB_RUNNER_MCP_AUTH_MODE = 'none'
$env:COLLAB_RUNNER_MCP_PUBLIC_BASE_URL = 'http://127.0.0.1:7678'
$env:COLLAB_RUNNER_MCP_PUBLIC_RESOURCE_PATH = '/mcp/runner'

Set-Location -LiteralPath $ServerRoot
node (Join-Path $ServerRoot 'src\server.mjs')
