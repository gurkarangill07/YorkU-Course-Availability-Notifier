$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SupervisorDir = Join-Path $RootDir "logs\supervisors"

function Stop-ByPidFile {
  param([string]$Name)

  $pidPath = Join-Path $SupervisorDir "$Name-supervisor.pid"
  $statePath = Join-Path $SupervisorDir "$Name-state.json"

  if (Test-Path $statePath) {
    try {
      $state = Get-Content $statePath -Raw | ConvertFrom-Json
      if ($state.childPid) {
        Stop-Process -Id ([int]$state.childPid) -Force -ErrorAction SilentlyContinue
      }
    } catch {
      # Ignore malformed or missing state.
    }
  }

  if (Test-Path $pidPath) {
    $rawPid = (Get-Content $pidPath -Raw).Trim()
    $parsedPid = 0
    if ([int]::TryParse($rawPid, [ref]$parsedPid)) {
      Stop-Process -Id $parsedPid -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue
  }
}

Stop-ByPidFile -Name "api"
Stop-ByPidFile -Name "worker"
Write-Output "Stopped Windows supervisors."
