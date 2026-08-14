# Stop the ReserveCalifornia pair and free the Chromium profile. Nothing else.
#
# WHY IT IS ITS OWN FILE (2026-08-14). Three callers needed this - rc-login.bat,
# rc-test-login.bat and restart-rc.ps1 - and each carried its own copy. Two of the three were
# INLINE POWERSHELL INSIDE A .bat, and that is a language boundary this repo has now been
# bitten by twice:
#
#   powershell -NoProfile -Command ^
#     "... -match '--user-data-dir=[^\"]*\.rc-bot-profile' ... | ForEach-Object { ... }"
#
# `\"` is PowerShell's escape. CMD HAS NO BACKSLASH ESCAPE, so that quote CLOSED the string,
# everything after it was unquoted, and the next `|` became a cmd PIPE - cmd then tried to run
# `ForEach-Object` as a program and said so:
#
#   'ForEach-Object' is not recognized as an internal or external command
#
# So rc-login.bat's kill step had never run, on any invocation, since it was written. The
# script printed "Closing anything holding the RC profile", closed nothing, and went on to
# open a second Chromium on a profile the first still held - the exact corruption every
# comment in that file warns about. Same family as the WINDOWTITLE filter that matched
# nothing: a step that fails at the one thing it exists to do, silently.
#
# The fix is not better quoting. It is HAVING NO QUOTING TO GET WRONG: the batch files call
# this with -File, which passes no code through cmd at all.
#
# -- WHAT IT DELIBERATELY DOES NOT TOUCH ---------------------------------------------------
# The rec.gov bot, the broker, cloudflared. A ReserveCalifornia sign-in has no business
# stopping those, and stop-all.ps1 is the script for when you do mean to.
#
# -- ASCII ONLY ----------------------------------------------------------------------------
# Windows PowerShell 5.1 reads a BOM-less .ps1 as Windows-1252. An em dash is E2 80 94, byte
# 0x94 is a curly right double quote, and PowerShell ACCEPTS curly quotes as string
# delimiters - so one em dash inside a string closes it mid-line and the parse cascades into
# an error six lines away. That took all four supervised processes down on 2026-08-11.
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }

# Retried, and CONSOLE FIRST. Every supervisor and stop path appends to restarts.log, and
# Windows file locking makes all but one writer fail while it is held - contention peaks
# during a stop, which is exactly when anyone reads it.
function Write-Line($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Output $line
  for ($i = 0; $i -lt 5; $i++) {
    try {
      Add-Content -Path "logs\restarts.log" -Value $line -Encoding UTF8 -ErrorAction Stop
      break
    } catch {
      Start-Sleep -Milliseconds (40 * ($i + 1))
    }
  }
}

# The RC pair and their supervisors, and NOTHING else. Matched on the command line, never on
# the image name: taskkill /IM node.exe would take the rec.gov bot down with it, and
# /IM chrome.exe closes the browser of whoever is sitting at this machine.
#
# The supervisor's own command line contains the payload name, so this takes it down with the
# child - which it must, or the supervisor restarts the process we are replacing, five
# seconds into the sign-in.
$RC = 'rc-keepwarm\.mjs|rc-hold-runner\.mjs|supervise\.ps1 -Name "?(rc-keepwarm|rc-hold-runner)'
# Playwright's Chromium on the RC profile. A force-killed parent leaves the browser holding
# the real Chrome lock on the user-data-dir, which deleting our own lock file does not touch
# - and the next keep-warm then meets a profile it cannot open.
#
# `\S*`, NOT `[^"]*` - THE PATTERN USED TO MISS EVERY CHILD PROCESS (2026-08-14).
# Playwright launches the PARENT with the path unquoted; Chrome then re-quotes it for its own
# renderer/GPU/utility children:
#     parent:  --user-data-dir=C:\...\.rc-bot-profile
#     child:   --user-data-dir="C:\...\.rc-bot-profile"
# `[^"]*` cannot cross that opening quote, so it matched the parent and NOTHING else - every
# stop killed the parent and left the children alive, still holding the real Chrome lock on
# the user-data-dir that deleting our own lock file does not touch.
# `kill-chrome` had it right with `\S*` the whole time, which is why that lever worked when
# this one did not - a difference invisible in either file, decided by one character.
#
# THIS IS A REAL BUG AND IT IS *NOT* KNOWN TO BE THE BLANK-PAGE CAUSE. I wrote exactly that
# claim here an hour after finding it, on the strength of "seven chrome.exe on one profile,
# two of them unquoted, so two instances". Then `kill-chrome` cleared all seven, the keep-warm
# reopened ONE browser, and the shape came back IDENTICAL - two unquoted plus five quoted. So
# seven processes and two unquoted entries are simply what a single healthy Chromium looks
# like (the parent plus a helper), the orphan-pile reading was wrong, and RC was blank again
# on a browser seconds old. Fix the kill because it is broken; do not let it inherit a
# diagnosis it never earned. The blank page is still open - see rc-diag.mjs.
$RC_BROWSER = '--user-data-dir=\S*\.rc-bot-profile'

function Get-Matching($pattern) {
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern -and $_.ProcessId -ne $PID }
}

Write-Line "stop-rc: stopping the ReserveCalifornia processes (rec.gov bot untouched)"
foreach ($p in @(Get-Matching $RC) + @(Get-Matching $RC_BROWSER)) {
  Write-Line ("  stopping pid {0} ({1})" -f $p.ProcessId, $p.Name)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# A force kill never runs the profile lock's release, so the file survives and the next
# keep-warm reads it as another process holding the profile - then waits 60s and gives up,
# every pass, for ever.
Remove-Item ".rc-bot-profile\.camphawk-profile-lock" -Force -ErrorAction SilentlyContinue
Remove-Item ".rc-bot-profile\.camphawk-profile-wanted" -Force -ErrorAction SilentlyContinue

# Chromium takes a moment to actually go. RE-CHECK rather than trust the kill, and report the
# survivors by pid: starting a second browser on a profile the first still holds corrupts the
# session this exists to protect, which is worse than not stopping at all.
Start-Sleep -Seconds 3
$left = @(Get-Matching $RC) + @(Get-Matching $RC_BROWSER)
if ($left.Count -gt 0) {
  foreach ($p in $left) { Write-Line ("  STILL RUNNING: pid {0} ({1})" -f $p.ProcessId, $p.Name) }
  Write-Line "stop-rc: FAILED - something would not stop. Callers must not launch anything."
  exit 1
}

Write-Line "stop-rc: the RC profile is free"
exit 0
