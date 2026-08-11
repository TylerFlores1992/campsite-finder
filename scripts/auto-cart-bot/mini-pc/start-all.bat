@echo off
REM Full auto-start: Cloudflare tunnel + bot + broker + the two RC processes.
REM Put a shortcut to this file in shell:startup for launch-on-boot.
REM
REM EVERY BOT PROCESS RUNS UNDER supervise.ps1 (2026-08-10). Before that these were bare
REM `powershell -NoExit` windows, so a process that died left a window with an error in it
REM and its job simply stopped being done — on 08-10 that went unnoticed for ten hours and
REM cost a campsite. The supervisor restarts on exit with backoff, and gives up loudly on a
REM crash loop rather than thrashing while every dashboard stays green.
REM
REM It is also what completes the keep-warm's own watchdog: that deliberately EXITS when
REM its loop wedges, to free the Chromium profile for the hold runner. Unsupervised, "freed
REM the profile and died" left the RC session unattended until morning. Supervised, the
REM same wedge is: exit, restart, auto-login re-establishes the session, 08:00 still fires.
cd /d "%~dp0.."
if not exist logs mkdir logs

REM ── STOP BEFORE STARTING (2026-08-11) ─────────────────────────────────────────────────
REM This is what makes "it just opened another five windows" structurally impossible. These
REM windows are `powershell -NoExit`, so a dead process leaves its console behind — which
REM means "is there a window?" was never evidence that anything was running, and starting
REM again simply stacked a second set on top of the first. Two Chromium on one user-data-dir
REM do not fail cleanly, they corrupt the session.
REM
REM At boot there is nothing to stop and this returns in well under a second. stop-all also
REM clears the profile locks a hard kill leaves behind, which used to be done here.
REM
REM RUNNING THIS WHILE EVERYTHING IS HEALTHY WILL END THE RC SESSION — the access token
REM lives in the Chromium being stopped. maybeAutoLogin restores it before the next
REM release; that is the accepted cost of never running two copies.
echo(
echo === Making sure nothing is already running ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1"
if errorlevel 1 goto :stuck

REM The tunnel is cloudflared's own long-running process with its own reconnect logic, so
REM it is left alone — wrapping it would supervise a thing that already supervises itself.
REM It IS stopped by stop-all though: it is relaunched here on every update, and nothing
REM stopping it is how a second tunnel window appeared after every one of them.
start "Cloudflare tunnel" cmd /k "cloudflared tunnel run camphawk-broker"

start "CampHawk bot"      powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0supervise.ps1" -Name "bot"    -Command "npm start"
start "CampHawk broker"   powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0supervise.ps1" -Name "broker" -Command "npm run broker"

REM ReserveCalifornia. Two processes, and the split is deliberate: keep-warm OWNS the
REM session and is the only thing that ever touches login, while the hold runner only
REM drives the session it is given.
REM
REM A dead session is no longer automatically a human errand — `maybeAutoLogin` signs in
REM ~15 min before a real release and succeeded unattended for the first time on
REM 2026-08-10. `mini-pc\rc-login.bat` remains the fallback for a CAPTCHA or a changed
REM password, and the 07:30 pre-flight will say which.
start "CampHawk RC keep-warm" powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0supervise.ps1" -Name "rc-keepwarm"   -Command "node rc-keepwarm.mjs"
start "CampHawk RC holds"     powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0supervise.ps1" -Name "rc-hold-runner" -Command "node rc-hold-runner.mjs"

echo Launched tunnel + bot + broker + RC keep-warm + RC holds, all supervised.
echo FIVE windows, and only five. Logs in scripts\auto-cart-bot\logs\ ; restarts in
echo logs\restarts.log
exit /b 0

:stuck
echo(
echo *** Something is still running and would not stop. NOTHING was launched. ***
echo *** Starting on top of survivors is what put ten windows on this box.    ***
echo *** The surviving process ids are listed above and in logs\restarts.log. ***
exit /b 1
