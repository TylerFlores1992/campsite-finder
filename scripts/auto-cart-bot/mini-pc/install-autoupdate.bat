@echo off
REM Register the nightly self-update as a Windows Scheduled Task. Run ONCE, as admin.
REM
REM After this, the box takes new bot code by itself and you stop running update.bat for
REM routine changes. The task fires hourly and almost always does nothing: update-guard.mjs
REM refuses outside 02:00-05:00 PT, refuses within 6 hours of a real release, and refuses
REM outright if it cannot reach CampHawk to find out. Hourly-and-usually-refusing is
REM deliberate — a single fixed time that happens to land on a bad night simply misses the
REM update, whereas several chances inside the quiet window will take it.
REM
REM WHAT IT DOES NOT REPLACE. `update.bat` stays, for when you want a change NOW. And it
REM still ends the RC session, so it still wants rc-login.bat after — see the note there.
setlocal
set TASK=CampHawk auto-update
set SCRIPT=%~dp0auto-update.ps1

net session >nul 2>&1
if errorlevel 1 (
  echo(
  echo *** Run this as Administrator — right-click, "Run as administrator". ***
  echo     Registering a Scheduled Task needs it; nothing else here does.
  pause
  exit /b 1
)

REM EVERY 5 MINUTES, not hourly. The task is now the FALLBACK: the primary path is the
REM "Update the mini-PC now" button on the admin page, which the hold runner sees on its
REM next 15-second poll. A frequent, almost-always-refusing check is cheap (the guard exits
REM in under a second) and means a requested update lands in minutes rather than at 2am.
schtasks /Create /TN "%TASK%" /SC MINUTE /MO 5 /RL HIGHEST /F ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%SCRIPT%\""
if errorlevel 1 (
  echo(
  echo *** Could not register the task. Nothing was changed. ***
  pause
  exit /b 1
)

echo(
echo Registered "%TASK%" — every 5 minutes, and it refuses unless:
echo   * you asked for it on the admin page, OR the Pacific hour is 02:00-05:00,
echo   * AND no hold releases within 6 hours,
echo   * AND CampHawk is reachable to confirm both.
echo(
echo The RELEASE check is never lifted by asking. An update ends the RC session, and
echo doing that minutes before a cart would lose the site.
echo(
echo It rolls back on its own if the new code does not check in within 4 minutes.
echo Log: scripts\auto-cart-bot\logs\auto-update.log
echo(
echo To see it:      schtasks /Query /TN "%TASK%"
echo To remove it:   schtasks /Delete /TN "%TASK%" /F
echo To test it now: powershell -ExecutionPolicy Bypass -File "%SCRIPT%" -Force
echo   (-Force skips the guards — it WILL end the RC session, so log in after.)
echo(
pause
