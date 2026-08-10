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

schtasks /Create /TN "%TASK%" /SC HOURLY /RL HIGHEST /F ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%SCRIPT%\""
if errorlevel 1 (
  echo(
  echo *** Could not register the task. Nothing was changed. ***
  pause
  exit /b 1
)

echo(
echo Registered "%TASK%" — hourly, and it will refuse unless:
echo   * the Pacific hour is between 02:00 and 05:00,
echo   * no hold releases within 6 hours,
echo   * and CampHawk is reachable to confirm both.
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
