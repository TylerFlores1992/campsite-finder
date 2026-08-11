# Pull the latest bot code and restart, unattended - but only when it is safe.
#
# -- WHY IT IS GUARDED RATHER THAN JUST SCHEDULED ---------------------------------------
# An update force-kills every node process, which closes the Chromium the RC access token
# lives in. Measured 2026-08-10: a hand sign-in at 16:15:06Z read "no token at all -
# signed out" at 16:23:08Z, straight after an update. So an unattended update is a way to
# destroy the session, and a naively scheduled one destroys it at the same time every day.
#
# The decision is NOT made here. `update-guard.mjs` owns it, in JavaScript, because it is
# the part that can lose a campsite and PowerShell is the part nothing can test. It checks
# a quiet window AND the real next release, and refuses when it cannot reach the feed -
# unknown is not safe. See worker/update-guard.test.mts.
#
# -- AND WHY IT ROLLS BACK --------------------------------------------------------------
# The failure this must not have is a silent one: pull a broken commit at 03:00, restart
# into it, and find out at 08:00. After restarting it waits for the processes to check in
# with the server. No check-in means the new code cannot do the job, and it goes back to
# the commit that could.
[CmdletBinding()]
param([switch]$Force)

# CONTINUE, NOT STOP - and this is not a style choice.
#
# In Windows PowerShell 5.1, `2>&1` on a NATIVE command turns each stderr line into an
# ErrorRecord, and under `Stop` the first one is a TERMINATING error. `node` writes to
# stderr routinely (experimental-feature warnings, deprecations), so
# `$guardOut = & node update-guard.mjs 2>&1` killed this script on its first real line -
# before any report, every single run. Observed 2026-08-11: the runner logged the hand-off
# at 03:37:27 and the server heard nothing at all, on a box carrying the newest code.
#
# `Stop` was buying nothing here anyway: every native call below checks $LASTEXITCODE
# explicitly, which is the honest way to read a native exit status.
$ErrorActionPreference = "Continue"
$botDir = Split-Path -Parent $PSScriptRoot
Set-Location $botDir
if (-not (Test-Path "logs")) { New-Item -ItemType Directory -Path "logs" | Out-Null }
$log = "logs\auto-update.log"
if (-not $env:CAMPHAWK_URL) { $env:CAMPHAWK_URL = "https://camphawk.app" }

function Write-Line($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [auto-update] $msg"
  Write-Host $line
  Add-Content -Path $log -Value $line
}

function Report-Applied($sha, $note) {
  # CLEARS THE REQUEST, whether it worked or not. An update that failed and left the flag
  # pending would be retried on the runner's next 15-second poll - a rollback loop on the
  # machine holding the RC session. Same reasoning as one auto-login attempt per release.
  #
  # Defined up here, not beside its first success-path call: PowerShell runs top-down and a
  # function is not callable before its definition, so the early refusal below would have
  # died on "Report-Applied is not recognized" - leaving the request pending, which is the
  # retry loop this exists to prevent.
  try {
    $body = @{ updateApplied = $sha; note = $note } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$env:CAMPHAWK_URL/api/auto-cart/rc-holds" `
      -Headers @{ Authorization = "Bearer $env:AUTOCART_TOKEN"; "Content-Type" = "application/json" } `
      -Body $body -TimeoutSec 15 | Out-Null
  } catch { Write-Line "could not report the update: $($_.Exception.Message)" }
}

function Report-Attempt($note) {
  # applied_note WITHOUT applied_at: "here is what happened last time somebody tried",
  # never "it landed". See noteBotUpdateAttempt.
  try {
    $body = @{ updateAttempt = $note } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$env:CAMPHAWK_URL/api/auto-cart/rc-holds" `
      -Headers @{ Authorization = "Bearer $env:AUTOCART_TOKEN"; "Content-Type" = "application/json" } `
      -Body $body -TimeoutSec 15 | Out-Null
  } catch { Write-Line "could not report the attempt: $($_.Exception.Message)" }
}

function Stop-Everything {
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\stop-all.ps1" 2>&1 |
    Tee-Object -FilePath $log -Append
  return ($LASTEXITCODE -eq 0)
}

# SAY WE STARTED, BEFORE ANYTHING CAN GO WRONG. Diagnosing 2026-08-11 took three rounds
# because "the script died on line 1", "the guard refused" and "the runner never handed
# off" produced the identical silence server-side. From here, no report at all can only
# mean the script never launched, which is a different fault with a different fix.
Report-Attempt "started - checking the guard"

# -- 1. May we? ------------------------------------------------------------------------
$guardArgs = @("update-guard.mjs")
if ($Force) { $guardArgs += "--force" }
# stderr merged deliberately - the guard's verdict and any node warning both belong in the
# log - which is safe now that ErrorActionPreference is Continue. See the header.
$guardOut = & node @guardArgs 2>&1
$guardOut | Tee-Object -FilePath $log -Append
if ($LASTEXITCODE -ne 0) {
  Write-Line "skipping this run."
  # SAY SO SERVER-SIDE. A refusal used to live only in this log file, on a box nobody can
  # reach - so an on-demand update that sat pending looked identical to a box that had
  # never looked at the request. Reported as an ATTEMPT, which leaves the request pending
  # on purpose: the guard refuses for reasons that clear (a release passes, the feed comes
  # back), and the box must try again when they do.
  Report-Attempt (($guardOut | Out-String).Trim())
  exit 0
}

# -- 2. Is there anything to take? -----------------------------------------------------
$repoRoot = (& git rev-parse --show-toplevel) 2>$null
if (-not $repoRoot) { Write-Line "not a git checkout - nothing to update."; exit 0 }
Set-Location $repoRoot

$before = (& git rev-parse HEAD).Trim()
& git fetch --quiet origin master
$after = (& git rev-parse origin/master).Trim()
if ($before -eq $after) {
  Write-Line "already current at $($before.Substring(0,7))."
  # A REQUEST IS SATISFIED BY BEING CURRENT. Without this the flag stays pending after a
  # hand-update, the runner re-hands-off every retry interval forever, and each pass takes
  # the RC session down for nothing. "Get current" is the ask; we are current.
  Report-Applied $before "already current - nothing to pull"
  exit 0
}
Write-Line "updating $($before.Substring(0,7)) -> $($after.Substring(0,7))"

# -- 3. Stop, take, restart ------------------------------------------------------------
# Stopping is stop-all.ps1's job, and it kills the supervisors FIRST - otherwise they
# helpfully restart the children we are about to replace, and the box ends up running old
# code under a new commit.
#
# This block used to do its own killing and leaked three ways: it never stopped cloudflared
# (which start-all relaunches, so every update added a tunnel window), its pattern missed
# `bot.mjs` entirely, and it left orphaned Chromium holding the profile. stop-all also
# VERIFIES, and a non-zero exit means we must not touch the checkout - a half-stopped box
# updated underneath itself is worse than a stale one.
if (-not (Stop-Everything)) {
  Write-Line "could not stop everything - leaving the checkout alone."
  Report-Applied $before "REFUSED - processes would not stop"
  exit 1
}

& git reset --hard $after 2>&1 | Tee-Object -FilePath $log -Append
Set-Location $botDir
& npm ci --omit=dev 2>&1 | Tee-Object -FilePath $log -Append

Write-Line "relaunching"
& "$PSScriptRoot\start-all.bat"

# -- 4. Did it actually come back? -----------------------------------------------------
# THE POINT OF THE WHOLE SCRIPT. Restarting is not success; checking in is. The hold runner
# polls the feed every 15s and that poll stamps a server-side heartbeat, so a fresh beat is
# proof the new code can reach CampHawk and drive its own loop.
Write-Line "waiting up to 4 min for the hold runner to check in..."
$ok = $false
foreach ($i in 1..24) {
  Start-Sleep -Seconds 10
  try {
    $h = Invoke-RestMethod -Uri "https://camphawk.app/api/health/status" -TimeoutSec 15
    $runner = $h.checks | Where-Object { $_.name -eq "autocart.rc_runner" }
    if ($runner -and $runner.level -eq "ok") { $ok = $true; break }
  } catch { }
}

if ($ok) {
  Write-Line "OK - runner is checking in on $($after.Substring(0,7))."
  Report-Applied $after "updated and verified"
  exit 0
}

# -- 5. Roll back ----------------------------------------------------------------------
Write-Line "NO CHECK-IN after 4 min. Rolling back to $($before.Substring(0,7))."
# Stop BEFORE the checkout moves, here too - start-all.bat stops as well, but that happens
# after the reset, so relying on it would rewrite the working tree underneath live
# processes. Its own stop then finds nothing and returns immediately.
[void](Stop-Everything)
Set-Location $repoRoot
& git reset --hard $before 2>&1 | Tee-Object -FilePath $log -Append
Set-Location $botDir
& npm ci --omit=dev 2>&1 | Tee-Object -FilePath $log -Append
& "$PSScriptRoot\start-all.bat"
Report-Applied $before "NEW CODE DID NOT CHECK IN - rolled back"
Write-Line "rolled back. The RC session is gone either way - maybeAutoLogin will restore it"
Write-Line "  before the next release; mini-pc\rc-login.bat if you want it back sooner."
exit 1
