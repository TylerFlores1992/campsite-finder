@echo off
REM The ONE human step for ReserveCalifornia. Double-click it.
REM
REM RC started serving a reCAPTCHA on sign-in (2026-08-07), so the bot cannot log itself
REM in — a person has to, once, and then the keep-warm loop never lets the session lapse.
REM Run this whenever rc-keepwarm reports "RC SESSION IS DEAD".
REM
REM It cd's to the bot folder itself. Typing `node rc-keepwarm.mjs --login` into a fresh
REM PowerShell window lands in C:\Users\<you> and fails with MODULE_NOT_FOUND, which
REM reads like a broken install rather than a wrong directory.
setlocal
cd /d "%~dp0.."

echo(
echo === Closing anything holding the RC profile ===
REM Two Chromium instances on one user-data-dir do not fail cleanly, they corrupt the
REM session — the exact thing we are here to restore. The lock file cannot survive a
REM hard kill, so clear it too: a stale one blocks the RC processes for 10 minutes.
taskkill /FI "WINDOWTITLE eq CampHawk RC keep-warm*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq CampHawk RC holds*"     /T /F >nul 2>&1
del /q ".rc-bot-profile\.camphawk-profile-lock" >nul 2>&1
timeout /t 2 /nobreak >nul

echo(
echo === Opening ReserveCalifornia ===
echo Sign in, TICK "Keep me signed in", and solve the CAPTCHA if one appears.
echo The window closes by itself once the session is confirmed.
echo(
node rc-keepwarm.mjs --login
if errorlevel 1 goto :fail

echo(
echo === Signed in. Relaunching the RC processes ===
start "CampHawk RC keep-warm" powershell -NoExit -Command "node rc-keepwarm.mjs 2>&1 | Tee-Object -FilePath logs\rc-keepwarm.log -Append"
start "CampHawk RC holds"     powershell -NoExit -Command "node rc-hold-runner.mjs 2>&1 | Tee-Object -FilePath logs\rc-holds.log -Append"
echo Done. You can close this window.
pause
exit /b 0

:fail
echo(
echo *** No session was confirmed. Nothing was relaunched. ***
echo *** Re-run this when you have a moment — RC auto-cart is off until you do.  ***
echo *** Alerts are unaffected: the poller detects from Fly, not from this box.  ***
pause
exit /b 1
