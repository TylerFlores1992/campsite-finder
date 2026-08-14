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

# Retried, for the same reason as stop-all.ps1: the shared log is contended and drops
# writes exactly when several processes are stopping. Console first, so the line survives
# even when the file write does not.
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

# THE STOP LIVES IN stop-rc.ps1, and this file must not grow its own copy back. Three
# callers needed it and each carried one; two of the three were inline PowerShell in a .bat,
# and one of those had been failing on a cmd quoting bug since the day it was written
# without anybody noticing (2026-08-14 - see the header of stop-rc.ps1). Two copies are two
# chances to fix one and forget the other, and the forgotten copy is by definition the one
# running when the other is dead. Same rule as control-channel.mjs.
#
# It stops the RC pair, their supervisors and the Chromium on the RC profile; it clears the
# profile lock; and it RE-CHECKS, exiting non-zero with the surviving pids named. A non-zero
# here MUST abort: starting a second keep-warm on a profile the first still holds corrupts
# the session this exists to protect, which is worse than not restarting at all.
& "$PSScriptRoot\stop-rc.ps1"
if ($LASTEXITCODE -ne 0) {
  Write-Line "restart-rc: ABORTED - something would not stop. Nothing was launched."
  exit 1
}

# SUPERVISED, not bare. rc-login.bat used to relaunch this pair unsupervised, which quietly
# downgraded the two processes it was fixing: the keep-warm's wedge watchdog EXITS on
# purpose expecting a restart, and unsupervised that is a ten-hour silence (2026-08-10).
#
# -- ONE STRING, WITH ITS OWN QUOTES - NEVER AN ARRAY (2026-08-14) -------------------------
# This was `Start-Process -ArgumentList @("-Command", "node rc-keepwarm.mjs")`.
# Start-Process JOINS AN ARRAY WITH SPACES AND QUOTES NOTHING, so the child powershell was
# handed
#     -Command node rc-keepwarm.mjs
# and bound -Command to `node` alone, with the script name left over. supervise.ps1 then ran
# `cmd /c "node"` - the Node REPL. It starts, prints its banner and SITS THERE FOR EVER.
#
# THAT IS WHY NOTHING NOTICED. A REPL never exits, so the supervisor never restarts it and
# never writes a line: restarts.log simply goes quiet, which is exactly what a healthy box
# looks like. Four separate safeguards were defeated by this one quoting bug - the
# supervisor (nothing to restart), restarts.log (nothing to say), watchdog.ps1 (it matched
# the string `rc-keepwarm.mjs` in THIS command line and read the outage as healthy), and
# `autocart.rc_runner` (the heartbeat was kept green by update-guard's 5-minute tick).
#
# MEASURED, from this box's own restarts.log. supervise.ps1 logs `starting: $Command`, and
# the two callers disagreed about what it got:
#     21:46:47 [supervise:rc-keepwarm] starting: node rc-keepwarm.mjs   <- start-all.bat
#     21:48:48 [supervise:rc-keepwarm] starting: node                   <- this file
# The RC pair were idle REPLs from 21:48 until a human intervened, with two holds queued for
# the next 08:00 release.
#
# start-all.bat has always been right because cmd passes its quotes through verbatim.
# Building the whole command line here as ONE already-quoted string is the same thing done
# on purpose, and it does not depend on how any PowerShell version chooses to join an array.
# The -File path is quoted too: it is not needed today, but a profile path with a space in
# it would break the same way and just as silently.
function Start-Supervised($name, $command) {
  # No backtick line-continuation anywhere in this file: it only continues a line when it is
  # the LAST character before the newline, so one trailing space silently ends the statement
  # and the parse error surfaces well below the cause. Invisible in every editor.
  $fmt = '-NoExit -ExecutionPolicy Bypass -File "{0}\supervise.ps1" -Name {1} -Command "{2}"'
  Start-Process -FilePath "powershell" -ArgumentList ($fmt -f $PSScriptRoot, $name, $command)
}
Start-Supervised "rc-keepwarm"    "node rc-keepwarm.mjs"
Start-Supervised "rc-hold-runner" "node rc-hold-runner.mjs"

Write-Line "restart-rc: relaunched rc-keepwarm and rc-hold-runner, both supervised"
Write-Line "restart-rc: the RC session is GONE until maybeAutoLogin runs before the next release"
exit 0
