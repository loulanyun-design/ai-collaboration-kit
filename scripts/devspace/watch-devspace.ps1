#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$TaskName = 'DevSpace Long-Term',
  [string]$LocalMcp = 'http://127.0.0.1:7677/mcp'
)

$ErrorActionPreference = 'Continue'
$StateRoot = Join-Path $env:LOCALAPPDATA 'ai-collaboration-kit'
$StateFile = Join-Path $StateRoot 'devspace-watchdog.json'
$LogFile = Join-Path $StateRoot 'devspace-watchdog.log'
New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null

function Log([string]$Message) {
  try { Add-Content -LiteralPath $LogFile -Value ('{0:o} {1}' -f [DateTime]::Now,$Message) -Encoding UTF8 } catch {}
}

function Test-Local {
  try {
    $response = Invoke-WebRequest -Uri $LocalMcp -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
    return ($response.StatusCode -eq 200 -or $response.StatusCode -eq 401)
  } catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { return $true }
    return $false
  }
}

$state = [pscustomobject]@{ ConsecutiveFailures = 0 }
try {
  if (Test-Path -LiteralPath $StateFile) {
    $saved = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    $state.ConsecutiveFailures = [int]$saved.ConsecutiveFailures
  }
} catch {}

if (Test-Local) {
  $state.ConsecutiveFailures = 0
} else {
  $state.ConsecutiveFailures++
  Log "local unhealthy consecutive=$($state.ConsecutiveFailures)"
  if ($state.ConsecutiveFailures -ge 2) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
      try {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName $TaskName
        Start-Sleep -Seconds 3
        if (Test-Local) {
          Log 'DevSpace restart verified'
          $state.ConsecutiveFailures = 0
        } else {
          Log 'DevSpace restart did not restore local health'
        }
      } catch { Log ('restart failed: ' + $_.Exception.Message) }
    } else {
      Log 'scheduled task missing; no restart attempted'
    }
  }
}

$state | ConvertTo-Json -Compress | Set-Content -LiteralPath $StateFile -Encoding UTF8
