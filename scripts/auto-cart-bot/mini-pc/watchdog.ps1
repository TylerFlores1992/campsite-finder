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
# is only safe at all if the bots start themselves at login, which is not something this
# script can assume. If that is ever established, a reboot tier belongs here and not before.
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

# The four long-running payloads. Matched on the command line, the same way stop-all.ps1
# decides what is ours - never on image name, which would sweep in the browser of whoever is
# sitting at this machine.
$PAYLOADS = 'bot\.mjs|broker\.mjs|rc-keepwarm\.mjs|rc-hold-runner\.mjs'

function Count-Ours {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $PAYLOADS -and $_.ProcessId -ne $PID }).Count
}

$running = Count-Ours
if ($running -gt 0) {
  # THE ORDINARY CASE, AND IT MUST BE SILENT. This fires every few minutes forever; a line
  # per run would bury the restarts.log entries that matter under thousands that do not.
  exit 0
}

# NOTHING IS RUNNING. Before restarting, find out whether that is because an update is
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
    Write-Line "nothing running, but auto-update.ps1 is alive and its start time is unreadable - standing down"
    exit 0
  }
  $age = [int]((Get-Date) - $oldest).TotalMinutes
  if ($age -lt $UPDATE_DEAD_AFTER_MIN) {
    Write-Line "nothing running, but an update has been going $age min - that is normal, standing down"
    exit 0
  }
  Write-Line "an update has been going $age min with nothing running - treating it as DEAD and recovering"
}

Write-Line "NOTHING IS RUNNING - starting everything (start-all.bat stops first, so no duplicates)"
try {
  # start-all.bat calls stop-all first by design, which is what makes a duplicate structurally
  # impossible rather than merely unlikely. Never launch the payloads directly from here.
  & "$PSScriptRoot\start-all.bat" | Out-Null
} catch {
  Write-Line "start-all.bat threw: $($_.Exception.Message)"
  exit 1
}

Start-Sleep -Seconds 20
$after = Count-Ours
if ($after -gt 0) {
  Write-Line "recovered - $after of our processes are up"
  exit 0
}

# SAY SO LOUDLY AND DO NOT LOOP. The task fires again in a few minutes and will try again;
# what must not happen is this exiting 0 on a failure, because then the only record of a
# box that cannot be restarted is a log nobody reads.
Write-Line "START FAILED - still nothing running after start-all.bat. A human is needed."
exit 1
