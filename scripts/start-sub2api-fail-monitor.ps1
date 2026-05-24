$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$nodeArgs = @("bin/auto-relogin.js", "run")

$process = Start-Process -FilePath "node" `
  -ArgumentList $nodeArgs `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -PassThru

Write-Host "Started unified auto-relogin program. PID: $($process.Id)"
Write-Host "Log: $(Join-Path $root 'data/sub2api-fail-monitor.log')"
