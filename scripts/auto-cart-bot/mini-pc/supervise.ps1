# Keep one bot process alive.
#
# -- WHY THIS EXISTS --------------------------------------------------------------------
# Nothing restarted a dead process. `start-all.bat` opened `powershell -NoExit` windows,
# so a crashed or exited process left a window sitting there with an error in it and the
# job simply stopped being done - until a human noticed, which on 2026-08-10 took ten
# hours and cost a campsite.
#
# It also completes the keep-warm watchdog shipped the same day. That watchdog deliberately
# EXITS when its loop wedges, so the Chromium profile is released for the hold runner -
# but with nothing to restart it, "released the profile and died" left the RC session
# unattended until morning. Supervised, the same wedge becomes: exit, restart, auto-login
# re-establishes the session, and the 08:00 cart still fires. That is the difference
# between self-healing and merely failing tidily.
#
# -- WHAT IT DELIBERATELY DOES NOT DO ---------------------------------------------------
# It does not restart forever at full speed. A process that dies instantly and is
# restarted instantly is a busy loop that looks like a running service - and would spend
# the RC login budget, or hammer a provider, while every dashboard stayed green. After
# CrashLoopCount failures inside CrashLoopWindowMin it stops and says so loudly, because a
# thing that cannot run is better off visibly stopped than invisibly thrashing.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Command,
  [string]$LogFile = "",
  [int]$MinBackoffSec = 5,
  [int]$MaxBackoffSec = 300,
  [int]$CrashLoopCount = 5,
  [int]$CrashLoopWindowMin = 10
)

$ErrorActionPreference = "Continue"

# READ THE CHILD'S OUTPUT AS UTF-8. Node always writes UTF-8; a Windows console defaults to
# the OEM code page (437 here), so PowerShell decodes those bytes wrong and every em dash
# in a log line arrives as "TCo". That is cosmetic on screen and NOT cosmetic in
# logs\rc-keepwarm.log, which is what gets read at 07:40 and after a failure - the 08-10
# post-mortem was done by reading exactly these files.
#
# This is the same UTF-8-vs-Windows-codepage mismatch that broke this script's own parsing
# on 2026-08-11, arriving through the other door: there it was PowerShell READING a .ps1
# as Windows-1252, here it is PowerShell reading a child's stdout as cp437.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }
if ([string]::IsNullOrWhiteSpace($LogFile)) {
  $LogFile = "logs\$($Name -replace '[^a-zA-Z0-9]+','-').log"
}
$restartLog = "logs\restarts.log"

# THE SHARED LOG IS CONTENDED, AND LOSING LINES TO IT IS NOT ACCEPTABLE (2026-08-11).
# Every supervisor appends to one restarts.log, so when several start or restart at the
# same instant Windows file locking makes all but one fail with "the process cannot access
# the file ... because it is being used by another process". Observed on all five at once
# after an update.
#
# It is not fatal - $ErrorActionPreference is Continue, so the supervisor carried on and the
# children ran. What it costs is the RECORD: lines go missing from restarts.log exactly when
# several processes are restarting, which is the only time anyone reads it. A post-mortem
# tool that drops writes under load is the same failure as a watchdog wired to the thing it
# watches.
#
# Retry briefly, then give up SILENTLY rather than printing a wall of red that buries the
# real message. The console line is written first and unconditionally, so the information is
# never lost even when the file write is.
#
# -Encoding UTF8 to match the per-process log below. Without it this file takes the shell's
# default, and a log the post-mortem depends on becomes mojibake - the same mismatch that
# put "TCo" where every em dash should have been.
function Write-Line($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [supervise:$Name] $msg"
  Write-Host $line
  for ($i = 0; $i -lt 5; $i++) {
    try {
      Add-Content -Path $restartLog -Value $line -Encoding UTF8 -ErrorAction Stop
      return
    } catch {
      Start-Sleep -Milliseconds (40 * ($i + 1))
    }
  }
}

Write-Line "starting: $Command"
$backoff = $MinBackoffSec
# Timestamps of recent exits, for the crash-loop check. Only the window is kept.
$recent = New-Object System.Collections.ArrayList

while ($true) {
  $started = Get-Date
  # `cmd /c` so the whole command string (node + args + our own pipes) runs as written,
  # and its stdout/stderr are mirrored to the per-process log the same way start-all.bat
  # did - a cart outcome has to survive a window close, which is how 08-07 was diagnosed
  # at all.
  # NOT Tee-Object: in Windows PowerShell 5.1 it writes UTF-16LE, so every one of these
  # logs is a Unicode file that `findstr` refuses to search properly ("input file is in
  # Unicode format") - which is exactly what happened while diagnosing a silent update on
  # 2026-08-11. These files are the post-mortem record; a record you cannot grep is half a
  # record. Write-Host keeps the live console, Add-Content -Encoding UTF8 keeps the file
  # searchable by ordinary tools.
  & cmd /c "$Command" 2>&1 | ForEach-Object {
    Write-Host $_
    Add-Content -Path $LogFile -Value $_ -Encoding UTF8
  }
  $code = $LASTEXITCODE
  $ranFor = (New-TimeSpan -Start $started -End (Get-Date)).TotalSeconds

  Write-Line ("exited code=$code after {0:N0}s" -f $ranFor)

  # A process that stayed up for a good while and then exited is not looping - reset, so a
  # nightly hiccup never accumulates into a false crash-loop trip days later.
  if ($ranFor -ge ($CrashLoopWindowMin * 60)) {
    $recent.Clear()
    $backoff = $MinBackoffSec
  }

  [void]$recent.Add((Get-Date))
  $cutoff = (Get-Date).AddMinutes(-$CrashLoopWindowMin)
  $keep = @($recent | Where-Object { $_ -gt $cutoff })
  $recent.Clear()
  foreach ($t in $keep) { [void]$recent.Add($t) }

  if ($recent.Count -ge $CrashLoopCount) {
    Write-Line "STOPPING - $($recent.Count) exits in $CrashLoopWindowMin min. This is a crash loop, not a blip."
    Write-Line "  Nothing will restart $Name until someone looks. Check $LogFile."
    # Non-zero so a Scheduled Task wrapper records a failure rather than a clean finish.
    exit 1
  }

  Write-Line "restarting in ${backoff}s (attempt $($recent.Count) in the last $CrashLoopWindowMin min)"
  Start-Sleep -Seconds $backoff
  # Exponential, capped. Fast enough that a one-off crash costs a poll or two; slow enough
  # that a persistently broken process is not hammering RC or rec.gov.
  $backoff = [Math]::Min($backoff * 2, $MaxBackoffSec)
}
