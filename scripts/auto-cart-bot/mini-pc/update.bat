@echo off
REM One-click update for the mini PC: stop everything, pull latest code, relaunch.
REM Double-click this after a CampHawk code change. (Local files — .env, profiles,
REM logs, carted/handled.json — are git-ignored, so `git pull` won't touch them.)
REM
REM STOPPING IS DELEGATED TO stop-all.ps1 (2026-08-11). This script used to kill by window
REM title, which matched NOTHING — PowerShell retitles its own console, the same bug found
REM in rc-login.bat on 08-08. It survived on `taskkill /IM node.exe /F` until supervisors
REM shipped; after that the supervisors lived through it and RESTARTED the children, so an
REM update left five stale windows and opened five more. stop-all kills by command line
REM and verifies, and nothing is relaunched unless it reports everything down.
setlocal
cd /d "%~dp0.."

echo(
echo === Stopping bot, broker, tunnel, RC processes and any bot Chromium ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1"
if errorlevel 1 goto :stuck

echo(
echo === Pulling latest code ===
git pull || goto :fail

echo(
echo === Installing dependencies (quick if nothing changed) ===
call npm install || goto :fail

echo(
echo === Relaunching tunnel + bot + broker + the two RC processes ===
call "%~dp0start-all.bat"

echo(
REM FIVE, not three. This said "Three new windows" from before the RC pair existed, which
REM is the worst kind of stale: someone counting windows to check the update worked would
REM see three, tick the box, and never notice the two RC processes had failed to start —
REM and the RC ones are exactly the pair whose silent absence cost a hold on 2026-08-07.
echo === Update complete. FIVE windows should be open, and ONLY five: ===
echo     Cloudflare tunnel, CampHawk bot, CampHawk broker,
echo     CampHawk RC keep-warm, CampHawk RC holds.
echo If you cannot see all five, something failed to start — do not assume it is fine.
echo If you can see TEN, stop-all did not do its job — say so, do not just close them.
echo(
REM THIS SCRIPT ENDS THE RC SESSION. Stopping the RC processes takes Chromium down with
REM them, and the RC access token IS the session — it lives in the running browser, not in
REM the profile. Measured 2026-08-10: a sign-in at 16:15 read "no token at all - signed
REM out; okta session GONE (404)" eight minutes later, straight after an update.
REM
REM So the order is UPDATE FIRST, THEN LOG IN. Doing it the other way throws away the
REM sign-in you just made, and the loss is silent until the next 8am.
echo(
echo *** THIS ENDED THE RC SESSION. ***
echo     You do NOT have to fix that by hand — maybeAutoLogin signs itself back in
echo     about 15 minutes before the next real release. Run mini-pc\rc-login.bat only
echo     if you want the session back sooner, or if the 07:30 pre-flight complains.
echo You can close this window.
pause
exit /b 0

:stuck
echo(
echo *** Something would not stop. NOTHING was updated or relaunched — on purpose. ***
echo *** Launching on top of survivors is what put ten windows on this box.        ***
echo *** The surviving process ids are listed above and in logs\restarts.log.      ***
pause
exit /b 1

:fail
echo(
echo *** Update FAILED above. Nothing was relaunched. Read the error, fix it, ***
echo *** then run mini-pc\start-all.bat manually to bring the bot back up.     ***
pause
exit /b 1
