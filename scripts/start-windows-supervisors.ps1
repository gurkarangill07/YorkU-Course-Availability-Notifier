$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SupervisorDir = Join-Path $RootDir "logs\supervisors"
New-Item -ItemType Directory -Force -Path $SupervisorDir | Out-Null

function Get-LiveProcess {
  param([string]$PidPath)

  if (-not (Test-Path $PidPath)) {
    return $null
  }

  $rawPid = (Get-Content $PidPath -Raw).Trim()
  if (-not $rawPid) {
    return $null
  }

  $parsedPid = 0
  if (-not [int]::TryParse($rawPid, [ref]$parsedPid)) {
    return $null
  }

  return Get-Process -Id $parsedPid -ErrorAction SilentlyContinue
}

function Start-Supervisor {
  param(
    [string]$Name,
    [string]$Target
  )

  $pidPath = Join-Path $SupervisorDir "$Name-supervisor.pid"
  $existing = Get-LiveProcess -PidPath $pidPath
  if ($existing) {
    Write-Output "$Name supervisor already running (pid=$($existing.Id))."
    return
  }

  Remove-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue
  Start-Process `
    -FilePath "powershell" `
    -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      (Join-Path $PSScriptRoot "windows-process-supervisor.ps1"),
      "-Name",
      $Name,
      "-Target",
      $Target
    ) `
    -WorkingDirectory $RootDir | Out-Null

  Start-Sleep -Seconds 1
  $started = Get-LiveProcess -PidPath $pidPath
  if ($started) {
    Write-Output "Started $Name supervisor (pid=$($started.Id))."
  } else {
    Write-Output "Started $Name supervisor."
  }
}

Start-Supervisor -Name "api" -Target "src/apiServer.js"
Start-Supervisor -Name "worker" -Target "src/worker.js"
Write-Output "Supervisor state dir: $SupervisorDir"
