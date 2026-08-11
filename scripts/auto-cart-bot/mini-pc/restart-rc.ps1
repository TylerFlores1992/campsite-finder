# Restart ONLY the two ReserveCalifornia processes.
#
# WHY THIS EXISTS (2026-08-11). The RC hold runner died at 09:36 PT. The keep-warm came back
# by itself; the runner did not, and nothing could restart it without a person at the
# keyboard. Every diagnostic in the box's allowlist could TELL you that. None could fix it.
#
# -- WHAT IT DELIBERATELY DOES NOT TOUCH ---------------------------------------------------
# The rec.gov bot, the broker, and cloudflared. The bot in particular is usually the process
# that received this command - stop-all.ps1 would kill the caller mid-command, and the reply
# would never be sent. That is not a detail: an operation that destroys the channel that
# asked for it can never report whether it worked.
#
# -- ASCII ONLY ----------------------------------------------------------------------------
# Windows PowerShell 5.1 reads a BOM-less .ps1 as Windows-1252. An em dash is E2 80 94, byte
# 0x94 is a curly right double quote, and PowerShell ACCEPTS curly quotes as string
# delimiters - so one em dash inside a string closes it mid-line and the parse cascades into
# an error six lines away. That took all four supervised processes down on 2026-08-11.
# worker/update-guard.test.mts fails on any non-ASCII byte in this directory.
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }

function Write-Line($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Output $line
  Add-Content -Path "logs\restarts.log" -Value $line -Encoding UTF8
}

# The RC pair and their supervisors, and NOTHING else. Matched on the command line, never on
# the image name: taskkill /IM node.exe would take the rec.gov bot down with it, and
# /IM chrome.exe closes the browser of whoever is sitting at this machine.
$RC = 'rc-keepwarm\.mjs|rc-hold-runner\.mjs|supervise\.ps1 -Name "?(rc-keepwarm|rc-hold-runner)'
# Playwright's Chromium on the RC profile. A force-killed parent leaves the browser holding
# the real Chrome lock on the user-data-dir, which deleting our own lock file does not touch
# - and the restarted keep-warm then meets a profile it cannot open.
$RC_BROWSER = '--user-data-dir=[^"]*\.rc-bot-profile'

function Get-Matching($pattern) {
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern -and $_.ProcessId -ne $PID }
}

Write-Line "restart-rc: stopping the ReserveCalifornia processes (rec.gov bot untouched)"
foreach ($p in @(Get-Matching $RC) + @(Get-Matching $RC_BROWSER)) {
  Write-Line ("  stopping pid {0} ({1})" -f $p.ProcessId, $p.Name)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# A force kill never runs the profile lock's release, so the file survives and the restarted
# keep-warm reads it as another process holding the profile - then waits 60s and gives up,
# every pass, for ever.
Remove-Item ".rc-bot-profile\.camphawk-profile-lock" -Force -ErrorAction SilentlyContinue
Remove-Item ".rc-bot-profile\.camphawk-profile-wanted" -Force -ErrorAction SilentlyContinue

# Chromium takes a moment to actually go. RE-CHECK rather than trust the kill: starting a
# second keep-warm on a profile the first still holds corrupts the session this exists to
# protect, which is worse than not restarting at all.
Start-Sleep -Seconds 3
$left = @(Get-Matching $RC) + @(Get-Matching $RC_BROWSER)
if ($left.Count -gt 0) {
  foreach ($p in $left) { Write-Line ("  STILL RUNNING: pid {0} ({1})" -f $p.ProcessId, $p.Name) }
  Write-Line "restart-rc: ABORTED - something would not stop. Nothing was launched."
  exit 1
}

# SUPERVISED, not bare. rc-login.bat used to relaunch this pair unsupervised, which quietly
# downgraded the two processes it was fixing: the keep-warm's wedge watchdog EXITS on
# purpose expecting a restart, and unsupervised that is a ten-hour silence (2026-08-10).
Start-Process -FilePath "powershell" -ArgumentList @(
  "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "$PSScriptRoot\supervise.ps1",
  "-Name", "rc-keepwarm", "-Command", "node rc-keepwarm.mjs")
Start-Process -FilePath "powershell" -ArgumentList @(
  "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "$PSScriptRoot\supervise.ps1",
  "-Name", "rc-hold-runner", "-Command", "node rc-hold-runner.mjs")

Write-Line "restart-rc: relaunched rc-keepwarm and rc-hold-runner, both supervised"
Write-Line "restart-rc: the RC session is GONE until maybeAutoLogin runs before the next release"
exit 0
