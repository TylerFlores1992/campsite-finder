# Bring the bots back when nothing is running.
#
# WHY THIS EXISTS, AND WHY IT CANNOT LIVE ON THE SERVER.
#
# Every remote lever we have - `bot_commands`, `restart-rc`, the "Update now" flag - rides a
# POLLER RUNNING ON THIS BOX. When all the pollers are dead there is nothing left to receive
# a command, so the one situation that most needs a remote fix is the one situation in which
# no remote fix can arrive. That is not a gap to be filled with a better button; it is
# structural, and it has now bitten twice:
#
#   2026-08-11  the RC hold runner died at 09:36 and took the diagnostics queue with it.
#   2026-08-14  an update stopped every process to move the checkout and never brought them
#               back. The box sat dark for 45 minutes with three holds queued for 08:00, and
#               the only way in was a person at the keyboard.
#
# A Windows Scheduled Task is run by WINDOWS, not by our code, so it survives everything
# short of the machine being off. That is the whole idea. `auto-update.ps1` already proves
# the mechanism fires reliably on this box; this is the same trick pointed at a different
# job.
#
# WHAT IT DOES NOT DO: reboot. In all three outages so far Windows was fine and only our
# processes had died - and a reboot ENDS THE RC SESSION, because the access token lives in
# the Chromium it would close. It is a bigger hammer than any observed failure needs, and it
# is only safe at all if the bots start themselves at login.
#
# THEY DO - owner-confirmed 2026-08-14. Not verified from this repo, and the ROUTE is unknown
# (shell:startup, a Run key, or a logon-triggered task); it is machine-local config nothing
# here creates, so it can vanish with no commit and no symptom until the night it is needed.
#
# So a LAST-RESORT reboot tier is now defensible - processes dead, start-all failed
# repeatedly, nothing left to try. It is still NOT the fix for 2026-08-12, when the box was
# wedged badly enough that RustDesk could not connect: A SCHEDULED TASK CANNOT FIRE ON A
# WINDOWS THAT IS NOT SCHEDULING, so the tier would never have run. That case is the Chromium
# memory leak, not this file. Any tier must sit behind repeated start-all failures, must carry
# the updater's release check (a reboot ends the RC session however it is triggered), and the
# assertion in update-guard.test.mts banning Restart-Computer must be NARROWED to that branch
# rather than deleted.
#
# PURE ASCII. Windows PowerShell 5.1 reads a .ps1 without a BOM as Windows-1252, where an em
# dash's third byte is a curly quote - which PowerShell accepts as a string delimiter. One
# smart quote in a message took all four supervised processes down on 2026-08-11, and the
# parse error surfaced six lines from the cause. `worker/update-guard.test.mts` enforces this
# across the directory.
$ErrorActionPreference = 'Stop'
Set-Location -Path (Split-Path -Parent $PSScriptRoot)

function Write-Line($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [watchdog] $msg"
  # CONSOLE FIRST, FILE SECOND. Every supervisor and stop path appends to restarts.log, and
  # Windows file locking makes all but one writer fail while it is held - contention peaks
  # during a stop, which is exactly when anyone reads it. A line that reaches the console is
  # worth more than one that is retried into a locked file and lost.
  Write-Host $line
  for ($i = 0; $i -lt 5; $i++) {
    try {
      Add-Content -Path "logs\restarts.log" -Value $line -Encoding UTF8 -ErrorAction Stop
      break
    } catch {
      Start-Sleep -Milliseconds (40 * ($i + 1))
    }
  }
}

# The four long-running payloads, checked ONE BY ONE.
#
# THIS WAS "IS ANYTHING RUNNING?" AND THAT IS THE HOUSE FAILURE (fixed 2026-08-14, hours
# after it shipped). The rec.gov bot and the RC pair are different processes; `autocart.bot`
# stayed green through the RC runner's death on 08-07 and again on 08-11 for exactly this
# reason. A watchdog counting the union would have read the very outage it was written for -
# bot.mjs alive, keep-warm and hold runner dead, three holds queued for 08:00 - as HEALTHY,
# and exited silently every five minutes all night.
#
# Matched on the command line, the same way stop-all.ps1 decides what is ours - never on
# image name, which would sweep in the browser of whoever is sitting at this machine.
$PAYLOADS = @{
  'bot'            = 'bot\.mjs'
  'broker'         = 'broker\.mjs'
  'rc-keepwarm'    = 'rc-keepwarm\.mjs'
  'rc-hold-runner' = 'rc-hold-runner\.mjs'
}

# A SUPERVISOR IS NOT ITS PAYLOAD, AND ITS COMMAND LINE CONTAINS THE PAYLOAD'S NAME
# (2026-08-14). supervise.ps1 is launched as
#     powershell -File ...\supervise.ps1 -Name rc-keepwarm -Command "node rc-keepwarm.mjs"
# so the string `rc-keepwarm.mjs` appears in the SUPERVISOR's own command line. Matching it
# there means a supervisor whose payload never started - or died and was never brought back -
# reads as a running payload.
#
# That is not hypothetical. restart-rc.ps1 was launching these supervisors with an unquoted
# -Command, so the payload was a bare `node` REPL while the supervisor's command line still
# carried `rc-keepwarm.mjs` in full. This watchdog would have reported the RC pair UP for as
# long as that lasted, which is the same failure as the union count it replaced: healthy by
# construction, in the one outage it exists for.
$SUPERVISOR = 'supervise\.ps1'

function Get-Missing {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.ProcessId -ne $PID -and $_.CommandLine -notmatch $SUPERVISOR })
  $missing = @()
  foreach ($name in $PAYLOADS.Keys) {
    $pattern = $PAYLOADS[$name]
    if (-not ($procs | Where-Object { $_.CommandLine -match $pattern })) { $missing += $name }
  }
  # Sorted so the log line is stable run to run and two nights can be compared by eye.
  , ($missing | Sort-Object)
}

$missing = Get-Missing
if ($missing.Count -eq 0) {
  # THE ORDINARY CASE, AND IT MUST BE SILENT. This fires every few minutes forever; a line
  # per run would bury the restarts.log entries that matter under thousands that do not.
  exit 0
}

# SOMETHING IS MISSING. Before restarting, find out whether that is because an update is
# legitimately in flight - moving the git checkout out from under a restart is how one bad
# night becomes two.
#
# WITH A TIMEOUT, AND THE TIMEOUT IS THE POINT. On 2026-08-14 the updater DIED holding
# everything down: it stopped every process, logged "started - checking the guard", and never
# progressed. A naive "never touch it during an update" guard would have refused for the rest
# of the night, which is worse than having no watchdog at all - the guard would have been
# protecting the very thing that was broken. An update older than this is not in progress, it
# is dead, and the box gets recovered regardless.
$UPDATE_DEAD_AFTER_MIN = 15

$updater = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'auto-update\.ps1' -and $_.ProcessId -ne $PID })

if ($updater.Count -gt 0) {
  $oldest = $null
  foreach ($u in $updater) {
    $started = $null
    try { $started = $u.CreationDate } catch { }
    if ($started -and (-not $oldest -or $started -lt $oldest)) { $oldest = $started }
  }
  # An updater whose start time we cannot read is treated as RUNNING, not as dead. Killing a
  # live update to be safe is the one mistake here with no recovery.
  if (-not $oldest) {
    Write-Line "$($missing -join ', ') down, but auto-update.ps1 is alive and its start time is unreadable - standing down"
    exit 0
  }
  $age = [int]((Get-Date) - $oldest).TotalMinutes
  if ($age -lt $UPDATE_DEAD_AFTER_MIN) {
    Write-Line "$($missing -join ', ') down, but an update has been going $age min - that is normal, standing down"
    exit 0
  }
  Write-Line "an update has been going $age min with $($missing -join ', ') down - treating it as DEAD and recovering"
}

# WHICH LEVER, AND WHY IT IS NOT ALWAYS start-all.
#
# start-all.bat stops EVERYTHING first, which is what makes a duplicate structurally
# impossible - and which also closes the Chromium the RC access token lives in. Spending a
# live RC session to restart a dead broker is a bad trade at 03:00 and a terrible one at
# 07:50. So the blunt lever is only for a genuinely dark box.
$rcDown = @($missing | Where-Object { $_ -like 'rc-*' })
$otherDown = @($missing | Where-Object { $_ -notlike 'rc-*' })

if ($missing.Count -eq $PAYLOADS.Count) {
  Write-Line "NOTHING IS RUNNING - starting everything (start-all.bat stops first, so no duplicates)"
  try {
    & "$PSScriptRoot\start-all.bat" | Out-Null
  } catch {
    Write-Line "start-all.bat threw: $($_.Exception.Message)"
    exit 1
  }
} elseif ($rcDown.Count -gt 0) {
  # The RC pair specifically. restart-rc.ps1 is the targeted lever: it leaves the rec.gov
  # bot, the broker and the tunnel alone, and it costs no session that is not already gone -
  # if the keep-warm is dead, so is the token it was holding.
  Write-Line "$($rcDown -join ', ') down (rest of the box is up) - running restart-rc.ps1"
  try {
    & "$PSScriptRoot\restart-rc.ps1" | Out-Null
  } catch {
    Write-Line "restart-rc.ps1 threw: $($_.Exception.Message)"
    exit 1
  }
} else {
  # SAY IT, DO NOT FIX IT. The only lever that reaches these is start-all, and that would end
  # a live RC session for a process whose own supervisor is meant to restart it. This is a
  # deliberate hole, and a NAMED one - the version of this script that reported "healthy"
  # here is the bug being fixed. If it recurs, the fix is a per-payload relaunch, not a
  # blanket restart.
  Write-Line "$($otherDown -join ', ') down, but the RC pair is UP - not restarting: start-all would end a live RC session. A human is needed."
  exit 1
}

Start-Sleep -Seconds 20
$still = Get-Missing
if ($still.Count -eq 0) {
  Write-Line "recovered - all four payloads are up"
  exit 0
}

# SAY SO LOUDLY AND DO NOT LOOP. The task fires again in a few minutes and will try again;
# what must not happen is this exiting 0 on a failure, because then the only record of a
# box that cannot be restarted is a log nobody reads.
Write-Line "START FAILED - still down: $($still -join ', '). A human is needed."
exit 1
