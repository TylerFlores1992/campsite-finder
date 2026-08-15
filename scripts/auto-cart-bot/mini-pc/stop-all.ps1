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

# RETRY THE SHARED LOG. Every supervisor and every stop path appends to one restarts.log,
# and Windows file locking makes all but one writer fail while a file is held. Contention
# PEAKS during a stop - four supervisors are writing their own "exited code=" lines at the
# same moment - so this log drops exactly the lines that explain a stop, which is the only
# time anyone reads it.
#
# Observed 2026-08-11: a remote update reported "REFUSED - processes would not stop" and the
# log contained the opening "stopping 18 process(es)" and NOTHING else. The re-check ran and
# named every survivor; not one of those lines survived the write. Same defect fixed in
# supervise.ps1 hours earlier and left here.
#
# Console first and unconditionally, so the information is never lost even when the file
# write is. -Encoding UTF8 to match every other writer, or the post-mortem file is mojibake.
function Write-Line($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [stop-all] $msg"
  if (-not $Quiet) { Write-Host $line }
  for ($i = 0; $i -lt 5; $i++) {
    try {
      Add-Content -Path "logs\restarts.log" -Value $line -Encoding UTF8 -ErrorAction Stop
      break
    } catch {
      Start-Sleep -Milliseconds (40 * ($i + 1))
    }
  }
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
# `\S*`, NOT `[^"]*` - see stop-rc.ps1 for the full story. Chrome re-quotes --user-data-dir
# for its child processes, and `[^"]*` cannot cross the opening quote, so this matched the
# parent and left every child alive holding the profile lock. Orphans then accumulate and the
# next browser opens a locked profile and renders blank.
$BROWSERS = '--user-data-dir=\S*(\.rc-bot-profile|auto-cart-bot)'

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

# A PROCESS WE CANNOT SEE IS NOT A PROCESS THAT IS NOT THERE (2026-08-14).
#
# Every filter above is `$_.CommandLine -and $_.CommandLine -match ...`. An UNELEVATED WMI
# query cannot read CommandLine for a process in another security context - it returns
# $null - so `$_.CommandLine -and` silently DROPS it. A broker.mjs that had been started
# from an elevated prompt was therefore INVISIBLE to this script, not merely un-killable:
# it was left out of $before, out of every kill, and out of the re-check, and this script
# truthfully reported "all stopped." It was never wrong about what it saw. It could not see.
#
# The cost landed in a DIFFERENT process: the orphan held port 8787, every relaunched broker
# died in one second with EADDRINUSE, and supervise.ps1 gave up after five tries. So the
# symptom appeared where the cause was not, which is why it read as "the broker is broken".
#
# TWO CHECKS, and they are deliberately different in severity. They live in functions -
# ABOVE the early return - because that return is where they were needed and never ran; see
# the block below it.
$OUR_IMAGES = '^(node|chrome|cloudflared)\.exe$'
$BROKER_PORT = 8787

# 1. THE UNREADABLE PROCESSES ONLY WARN. A `node.exe` we cannot inspect may be somebody
#    else's - this machine belongs to a person - and failing on that would refuse every
#    launch for the rest of the box's life. Naming it is the whole value: the failure that
#    cost an evening was invisible, not ambiguous. Returns the count so the caller can say
#    "nothing VISIBLE" rather than "nothing running".
function Write-BlindNote {
  $blind = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { -not $_.CommandLine -and $_.Name -match $OUR_IMAGES -and $_.ProcessId -ne $PID })
  if ($blind.Count -gt 0) {
    Write-Line "  note: $($blind.Count) process(es) named like ours have an UNREADABLE command line."
    Write-Line "        WMI hides that from an unelevated session, so they MAY be ours, started"
    Write-Line "        elevated - this script can neither see nor stop those. Re-run from an"
    Write-Line "        elevated prompt if something will not die."
  }
  return $blind.Count
}

# 2. THE PORT IS PROOF, so it FAILS. Nothing else on this box binds the broker's port, so a
#    listener still there after the stop is ours by construction - no command line needed,
#    and no guessing from an image name, which this file forbids for good reason. This is the
#    one signal that turns an invisible orphan into a definite failure.
function Test-BrokerStillBound {
  $stillBound = @()
  try {
    $stillBound = @(Get-NetTCPConnection -LocalPort $BROKER_PORT -State Listen -ErrorAction SilentlyContinue)
  } catch { }
  if ($stillBound.Count -eq 0) { return $false }
  Write-Line "*** port $BROKER_PORT is STILL LISTENING (pid $($stillBound[0].OwningProcess)) after the stop. ***"
  Write-Line "    That is our broker and this script could not stop it - almost certainly"
  Write-Line "    started from an elevated prompt, which also hides its command line."
  Write-Line "    Relaunching now gives EADDRINUSE and a crash-loop, so this is a FAILURE."
  Write-Line "    Fix: elevated prompt, taskkill /PID $($stillBound[0].OwningProcess) /F"
  return $true
}

$before = (Count-Matching $CHILDREN) + (Count-Matching $BROWSERS)

# SEEING NOTHING IS THE STRONGEST EVIDENCE OF BLINDNESS, AND THIS PATH SKIPPED BOTH CHECKS
# THAT COULD SAY SO (2026-08-15).
#
# `if ($before -eq 0) { Write-Line "nothing running."; exit 0 }` returned before either check
# below had run. So on the one path where "I found nothing" is least trustworthy - a WHOLE
# elevated generation reads as zero, not just one process - the script printed the cheeriest
# sentence it has and exited 0.
#
# Measured, 2026-08-15 05:12 UTC. update.bat + start-all ran while the previous generation was
# running elevated. stop-all logged a bare "nothing running." TWICE, thirteen seconds apart,
# with the elevated broker holding port 8787 the whole time. start-all took the exit 0 as
# permission, launched a second generation on top, its broker crash-looped on EADDRINUSE, and
# the next stop-all killed that NEW generation - the only one it could see. The ELEVATED,
# PRE-UPDATE generation survived all of it and was still running four hours later, so the box
# went on executing `e6a7ebf` with its checkout on `c1bd875`. The update did not fail; it
# landed on disk and nothing ever restarted onto it.
#
# The port check alone would have stopped that dead: exit 1, start-all's :stuck branch, and
# the taskkill line printed for the human. That is why the check runs here FIRST and the
# reassuring sentence comes last.
if ($before -eq 0) {
  $blindCount = Write-BlindNote
  if (Test-BrokerStillBound) { exit 1 }
  # "nothing VISIBLE" is not "nothing running", and the difference is four hours of stale
  # code. Only the second sentence is allowed when the scan could actually see.
  if ($blindCount -gt 0) { Write-Line "nothing VISIBLE to stop - see the note above."; exit 0 }
  Write-Line "nothing running."
  exit 0
}

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

# Both checks again on the way out, from the same two functions the quiet path calls - one
# definition each, so a fix to either cannot reach one path and miss the other. That is the
# defect this file has already paid for twice in its siblings (rc-login.bat's kill, fixed in
# one copy and left standing in the second; the stop patterns that could not match Chrome's
# quoted children).
[void](Write-BlindNote)
if (Test-BrokerStillBound) { exit 1 }

if ($left -eq 0) { Write-Line "all stopped."; exit 0 }

Write-Line "*** $left process(es) SURVIVED. Not safe to relaunch on top of them. ***"
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match $CHILDREN -or $_.CommandLine -match $BROWSERS) -and $_.ProcessId -ne $PID } |
  ForEach-Object { Write-Line "  still up: pid $($_.ProcessId) $($_.Name) :: $($_.CommandLine)" }
exit 1
