$ErrorActionPreference = "Stop"

$taskName = "Sub2API Auto Relogin"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "Startup task not found: $taskName"
  return
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Removed startup task: $taskName"
