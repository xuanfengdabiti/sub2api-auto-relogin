$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$lockPath = Join-Path $root "data/auto-relogin.lock"
$legacyLockPath = Join-Path $root "data/sub2api-fail-monitor.lock"

function Stop-LockedProcess($path) {
  if (-not (Test-Path $path)) {
    Write-Host "No lock file found: $path"
    return
  }

  $lock = Get-Content $path -Raw | ConvertFrom-Json
  if (-not $lock.pid) {
    Remove-Item -LiteralPath $path -Force
    Write-Host "Removed invalid lock file: $path"
    return
  }

  $process = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
  if (-not $process) {
    Remove-Item -LiteralPath $path -Force
    Write-Host "Process was not running; removed stale lock: $path"
    return
  }

  Stop-Process -Id $lock.pid
  Write-Host "Stopped process. PID: $($lock.pid)"
}

Stop-LockedProcess $lockPath
Stop-LockedProcess $legacyLockPath
