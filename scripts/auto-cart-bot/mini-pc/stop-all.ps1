# Stop every CampHawk process on this box - and PROVE they stopped.
#
# -- WHY THIS IS ITS OWN SCRIPT ---------------------------------------------------------
# Three places need to stop everything (update.bat, auto-update.ps1, start-all.bat) and
# all three had their own version. They disagreed, and each disagreement was a leak:
#
#   * update.bat killed by WINDOW TITLE. PowerShell retitles its own console at startup,
#     so `taskkill /FI "WINDOWTITLE eq CampHawk bot*"` matched NOTHING - the same bug
#     already found and fixed in rc-login.bat on 2026-08-08 and never fixed here. It got
#     away with it because `taskkill /IM node.exe /F` killed the payload anyway. Once
#     supervisors existed that stopped being true: the supervisor is powershell.exe, it
#     survived, and it RESTARTED the child that had just been killed. Five stale windows,
#     five new ones, two copies of every process.
#   * auto-update.ps1 never stopped cloudflared, and start-all.bat always launches a new
#     tunnel - one duplicate window per update, accumulating forever.
#   * auto-update.ps1's child pattern missed `bot.mjs` entirely. Stop-Process does not
#     kill a process TREE on Windows, so killing the `cmd /c "npm start"` shim left the
#     rec.gov bot's node process running under a supervisor that was already gone.
#   * Nothing killed an orphaned Chromium. Playwright's browser outlives a force-killed
#     parent and holds the real Chrome lock on the user-data-dir; deleting our own lock
#     file does not touch it, and the restarted keep-warm then meets a profile that is
#     occupied by a process nobody is watching.
#
# -- KILL BY COMMAND LINE, AND NEVER BY IMAGE NAME --------------------------------------
# `taskkill /IM chrome.exe /F` was in update.bat. This machine is used and screen-shared
# by a person - that closes THEIR browser. Every match here is scoped to a command line
# that names our own scripts or our own profile directories.
#
# -- AND IT VERIFIES --------------------------------------------------------------------
# Exits non-zero if anything is still standing. Callers must not launch on a failure:
# starting on top of survivors is precisely how the box ended up with ten windows.
[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = "Continue"
$botDir = Split-Path -Parent $PSScriptRoot
Set-Location $botDir
if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }

function Write-Line($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [stop-all] $msg"
  if (-not $Quiet) { Write-Host $line }
  Add-Content -Path "logs\restarts.log" -Value $line
}

# The supervisors, killed FIRST and alone. If a child died while its supervisor was still
# alive, the supervisor would helpfully restart it - which is the whole "it just adds
# another five" symptom.
$SUPERVISORS = 'supervise\.ps1'

# Every long-running payload. `bot\.mjs` and `broker\.mjs` are named directly rather than
# relying on the `npm start` / `npm run broker` shims, because killing a shim does not
# kill what it spawned.
$CHILDREN = 'supervise\.ps1|bot\.mjs|broker\.mjs|rc-keepwarm\.mjs|rc-hold-runner\.mjs|npm start|npm run broker|cloudflared'

# Playwright's Chromium, matched on OUR profile directories so a person's own browser on
# this machine is never in scope.
$BROWSERS = '--user-data-dir=[^"]*(\.rc-bot-profile|auto-cart-bot)'

function Stop-Matching($pattern, $label) {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern -and $_.ProcessId -ne $PID })
  foreach ($p in $procs) {
    Write-Line "  stopping $($p.Name) pid $($p.ProcessId) ($label)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  return $procs.Count
}

function Count-Matching($pattern) {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern -and $_.ProcessId -ne $PID }).Count
}

$before = (Count-Matching $CHILDREN) + (Count-Matching $BROWSERS)
if ($before -eq 0) { Write-Line "nothing running."; exit 0 }

Write-Line "stopping $before process(es)."
[void](Stop-Matching $SUPERVISORS "supervisor")
Start-Sleep -Seconds 1
[void](Stop-Matching $CHILDREN "payload")
[void](Stop-Matching $BROWSERS "orphaned Chromium")

# A force kill never runs the profile lock's release, so the file survives and reads as
# HELD for ten minutes - during which the relaunched RC processes skip their passes. An
# update at 07:55 would silently cost the 8am cart. Everything is down at this point, so
# clearing is safe by construction.
Remove-Item ".rc-bot-profile\.camphawk-profile-lock" -Force -ErrorAction SilentlyContinue
Remove-Item ".rc-bot-profile\.camphawk-profile-wanted" -Force -ErrorAction SilentlyContinue
Remove-Item "profiles\*\.camphawk-profile-lock" -Force -ErrorAction SilentlyContinue

# Chromium in particular takes a moment to actually go. Re-check rather than trust the
# kill: "I sent the signal" is not "it stopped", and the difference is a duplicate.
$left = 0
foreach ($i in 1..10) {
  Start-Sleep -Milliseconds 500
  $left = (Count-Matching $CHILDREN) + (Count-Matching $BROWSERS)
  if ($left -eq 0) { break }
}

if ($left -eq 0) { Write-Line "all stopped."; exit 0 }

Write-Line "*** $left process(es) SURVIVED. Not safe to relaunch on top of them. ***"
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match $CHILDREN -or $_.CommandLine -match $BROWSERS) -and $_.ProcessId -ne $PID } |
  ForEach-Object { Write-Line "  still up: pid $($_.ProcessId) $($_.Name) :: $($_.CommandLine)" }
exit 1
