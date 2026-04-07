param(
  [Parameter(Mandatory = $true)]
  [string]$Name,

  [Parameter(Mandatory = $true)]
  [string]$Target
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $RootDir "logs"
$SupervisorDir = Join-Path $LogDir "supervisors"
$StatePath = Join-Path $SupervisorDir "$Name-state.json"
$PidPath = Join-Path $SupervisorDir "$Name-supervisor.pid"
$OutLog = Join-Path $SupervisorDir "$Name.out.log"
$ErrLog = Join-Path $SupervisorDir "$Name.err.log"
$HealthPath = Join-Path $LogDir "worker-health.json"
$MetricsPath = Join-Path $LogDir "worker-metrics.prom"

function Get-EnvInt {
  param(
    [string]$Name,
    [int]$Fallback
  )

  $rawValue = [System.Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($rawValue)) {
    return $Fallback
  }

  $parsedValue = 0
  if ([int]::TryParse($rawValue, [ref]$parsedValue)) {
    return $parsedValue
  }

  return $Fallback
}

$BaseSleepSeconds = [Math]::Max(1, (Get-EnvInt -Name "MONITOR_SUPERVISOR_RESTART_SECONDS" -Fallback 5))
$WindowSeconds = [Math]::Max(1, (Get-EnvInt -Name "MONITOR_SUPERVISOR_CRASH_LOOP_WINDOW_SECONDS" -Fallback 600))
$MaxRestarts = [Math]::Max(1, (Get-EnvInt -Name "MONITOR_SUPERVISOR_CRASH_LOOP_MAX_RESTARTS" -Fallback 5))
$MaxSleepSeconds = [Math]::Max(1, (Get-EnvInt -Name "MONITOR_SUPERVISOR_MAX_RESTART_SECONDS" -Fallback 300))

New-Item -ItemType Directory -Force -Path $SupervisorDir | Out-Null

function Load-EnvFile {
  param([string]$EnvFilePath)

  if (-not (Test-Path $EnvFilePath)) {
    return
  }

  Get-Content $EnvFilePath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) {
      return
    }

    $idx = $line.IndexOf("=")
    if ($idx -lt 1) {
      return
    }

    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
}

function Write-State {
  param(
    [string]$LastStartAt,
    [string]$LastExitAt,
    [Nullable[int]]$LastExitCode,
    [int]$RestartCountInWindow,
    [string]$WindowStartedAt,
    [int]$NextRestartDelaySeconds,
    [bool]$CrashLoopActive,
    [Nullable[int]]$ChildPid
  )

  $payload = [ordered]@{
    name = $Name
    supervisorPid = $PID
    childPid = $ChildPid
    target = $Target
    lastStartAt = $LastStartAt
    lastExitAt = $LastExitAt
    lastExitCode = $LastExitCode
    restartCountInWindow = $RestartCountInWindow
    windowStartedAt = $WindowStartedAt
    windowSeconds = $WindowSeconds
    nextRestartDelaySeconds = $NextRestartDelaySeconds
    crashLoopActive = $CrashLoopActive
  } | ConvertTo-Json -Depth 4

  $tmpPath = "$StatePath.$PID.tmp"
  Set-Content -LiteralPath $tmpPath -Value $payload -NoNewline
  Move-Item -LiteralPath $tmpPath -Destination $StatePath -Force
}

function Test-WorkerDisabledExit {
  param([int]$ExitCode)

  if ($Name -ne "worker" -or $ExitCode -ne 0 -or -not (Test-Path $HealthPath)) {
    return $false
  }

  try {
    $health = Get-Content $HealthPath -Raw | ConvertFrom-Json
    return $health.state -eq "disabled"
  } catch {
    return $false
  }
}

Set-Content -LiteralPath $PidPath -Value $PID -NoNewline

$windowStartedAt = $null
$restartCountInWindow = 0
$nextRestartDelaySeconds = $BaseSleepSeconds

while ($true) {
  Load-EnvFile (Join-Path $RootDir ".env.local")

  if ($Name -eq "worker") {
    [System.Environment]::SetEnvironmentVariable("WORKER_HEALTH_PATH", $HealthPath, "Process")
    [System.Environment]::SetEnvironmentVariable("WORKER_METRICS_PATH", $MetricsPath, "Process")
  }

  $lastStartAt = (Get-Date).ToUniversalTime().ToString("s") + "Z"
  Add-Content -LiteralPath $OutLog -Value "[$lastStartAt] starting $Name"

  $proc = Start-Process `
    -FilePath "node" `
    -ArgumentList @($Target) `
    -WorkingDirectory $RootDir `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -PassThru

  $windowStartedAtIso = if ($windowStartedAt) { $windowStartedAt.ToString("s") + "Z" } else { "" }
  Write-State `
    -LastStartAt $lastStartAt `
    -LastExitAt "" `
    -LastExitCode $null `
    -RestartCountInWindow $restartCountInWindow `
    -WindowStartedAt $windowStartedAtIso `
    -NextRestartDelaySeconds $nextRestartDelaySeconds `
    -CrashLoopActive $false `
    -ChildPid $proc.Id

  $proc.WaitForExit()

  $lastExitAt = (Get-Date).ToUniversalTime()
  $lastExitAtIso = $lastExitAt.ToString("s") + "Z"
  $exitCode = $proc.ExitCode

  if (Test-WorkerDisabledExit -ExitCode $exitCode) {
    $windowStartedAt = $null
    $restartCountInWindow = 0
    $nextRestartDelaySeconds = $BaseSleepSeconds
    Write-State `
      -LastStartAt $lastStartAt `
      -LastExitAt $lastExitAtIso `
      -LastExitCode $exitCode `
      -RestartCountInWindow $restartCountInWindow `
      -WindowStartedAt "" `
      -NextRestartDelaySeconds $nextRestartDelaySeconds `
      -CrashLoopActive $false `
      -ChildPid $null
    Add-Content -LiteralPath $OutLog -Value "[$lastExitAtIso] $Name exited in disabled state; restarting in ${nextRestartDelaySeconds}s"
    Start-Sleep -Seconds $nextRestartDelaySeconds
    continue
  }

  if (-not $windowStartedAt -or (($lastExitAt - $windowStartedAt).TotalSeconds -gt $WindowSeconds)) {
    $windowStartedAt = $lastExitAt
    $restartCountInWindow = 0
  }

  $restartCountInWindow += 1
  $nextRestartDelaySeconds = $BaseSleepSeconds
  $crashLoopActive = $false

  if ($restartCountInWindow -gt $MaxRestarts) {
    $overflowCount = $restartCountInWindow - $MaxRestarts
    $nextRestartDelaySeconds = [Math]::Min($MaxSleepSeconds, $BaseSleepSeconds * [Math]::Pow(2, $overflowCount))
    $crashLoopActive = $true
  }

  Write-State `
    -LastStartAt $lastStartAt `
    -LastExitAt $lastExitAtIso `
    -LastExitCode $exitCode `
    -RestartCountInWindow $restartCountInWindow `
    -WindowStartedAt ($windowStartedAt.ToString("s") + "Z") `
    -NextRestartDelaySeconds ([int]$nextRestartDelaySeconds) `
    -CrashLoopActive $crashLoopActive `
    -ChildPid $null

  Add-Content -LiteralPath $OutLog -Value "[$lastExitAtIso] $Name exited with code $exitCode; restarting in ${nextRestartDelaySeconds}s (restartCountInWindow=$restartCountInWindow, crashLoopActive=$crashLoopActive)"
  Start-Sleep -Seconds ([int]$nextRestartDelaySeconds)
}
