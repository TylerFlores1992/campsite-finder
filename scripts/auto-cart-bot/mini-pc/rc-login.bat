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
REM
REM KILL BY COMMAND LINE, NOT BY WINDOW TITLE. This used `taskkill /FI "WINDOWTITLE eq
REM CampHawk RC keep-warm*"`, which matched NOTHING: start-all.bat launches these through
REM `powershell -NoExit`, and PowerShell retitles its own console on startup, so the title
REM the `start` command set is gone by the time taskkill looks. The old processes survived
REM every run of this script.
REM
REM It failed SILENTLY at the only step that matters, and then failed loudly somewhere
REM harmless: the relaunched windows died on `Tee-Object` because the survivors still held
REM logs\rc-*.log open. A file-lock error is what you saw; a stale process is what it meant.
REM Observed 2026-08-08. `update.bat` never hit this because it also runs
REM `taskkill /IM node.exe /F`, which ignores titles — but THIS script must not do that,
REM since it would take the rec.gov bot and the broker down with it.
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'rc-keepwarm\.mjs|rc-hold-runner\.mjs' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
del /q ".rc-bot-profile\.camphawk-profile-lock" >nul 2>&1
timeout /t 3 /nobreak >nul

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
echo(
REM Say what a FAILED relaunch looks like. The failure mode here is a window that opens,
REM prints a red file-lock error and then just sits there — which reads as "a window
REM opened", i.e. success, unless you know otherwise.
echo TWO new windows should have opened, both printing log lines within a minute.
echo If either shows a red "cannot access the file ... because it is being used by
echo another process" error, an old copy is still running: run mini-pc\update.bat,
echo which force-kills every node process and relaunches all five cleanly. Your
echo sign-in survives that — it lives in .rc-bot-profile\, which nothing deletes.
echo(
echo Then confirm from anywhere:  curl -s https://camphawk.app/api/health/status
echo   autocart.rc_session should read ok within ~20 minutes (one keep-warm pass).
echo(
echo TIRED OF RUNNING THIS? Run mini-pc\rc-save-password.bat once. It stores your
echo RC password encrypted on this machine (DPAPI, this Windows account only) and
echo the bot then signs itself in about 15 minutes before each hold. This script
echo stays as the fallback for when it cannot - a CAPTCHA, or a changed password.
echo(
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
