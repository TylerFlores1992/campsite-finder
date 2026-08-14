@echo off
REM Register the bot watchdog as a Windows Scheduled Task. Run ONCE, as admin.
REM
REM WHAT IT BUYS. Every remote lever we have rides a poller running on this box, so when all
REM the pollers die there is nothing left to receive a command - the one situation that most
REM needs a remote fix is the one in which no remote fix can arrive. This closes that, because
REM Windows runs the task, not our code.
REM
REM It has cost two outages already: the RC runner dying on 2026-08-11 and taking the
REM diagnostics queue with it, and an update on 2026-08-14 that stopped every process to move
REM the checkout and never brought them back - 45 minutes dark with three holds queued.
REM
REM Almost every run does nothing: if our processes are up it exits silently in under a
REM second. It only acts when NOTHING is running, and it stands down while a genuine update
REM is in flight - though not forever, because on 08-14 the updater itself was what died.
REM
REM IT DOES NOT REBOOT. In every outage so far Windows was fine and only our processes had
REM died, and a reboot would end the RC session for nothing. See the note in watchdog.ps1.
setlocal
set TASK=CampHawk watchdog
set SCRIPT=%~dp0watchdog.ps1

net session >nul 2>&1
if errorlevel 1 (
  echo(
  echo *** Run this as Administrator - right-click, "Run as administrator". ***
  echo     Registering a Scheduled Task needs it; nothing else here does.
  pause
  exit /b 1
)

REM EVERY 5 MINUTES. The same cadence as the auto-update task, for the same reason: the check
REM is nearly free when healthy, and five minutes is the most this box should ever spend dark
REM without something trying to fix it.
schtasks /Create /TN "%TASK%" /SC MINUTE /MO 5 /RL HIGHEST /F ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%SCRIPT%\""
if errorlevel 1 (
  echo(
  echo *** Could not register the task. Nothing was changed. ***
  pause
  exit /b 1
)

echo(
echo Registered "%TASK%" - every 5 minutes.
echo(
echo   It exits silently when the bots are running.
echo   It runs start-all.bat when NOTHING is running.
echo   It stands down while an update is in flight, but not past 15 minutes -
echo     on 2026-08-14 the updater is what died, still holding everything down.
echo(
echo Watch it work:  type logs\restarts.log
echo Remove it:      schtasks /Delete /TN "%TASK%" /F
echo(
pause
