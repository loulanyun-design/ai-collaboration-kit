#requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Registry = Join-Path $Root 'collaboration\projects.json'
$Sample = Join-Path $Root 'examples\sample-project'

$registryObject = @{
  version = 1
  note = 'Generated locally by setup.ps1. Only explicitly listed projects are enrolled.'
  projects = @(
    @{
      id = 'sample-project'
      path = $Sample
      enabled = $true
      project_rules = 'AGENTS.md'
      handoff_dir = 'work\handoffs'
    }
  )
}

$registryObject | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Registry -Encoding UTF8

Push-Location (Join-Path $Root 'collaboration-runner-mcp-server')
try {
  npm ci
  npm test
} finally {
  Pop-Location
}

Push-Location (Join-Path $Root 'collaboration-runner-pilot')
try {
  npm test
} finally {
  Pop-Location
}

Write-Host 'Setup complete.'
Write-Host ('Registry: ' + $Registry)
Write-Host 'Next: .\scripts\start-runner-mcp-local.ps1'
