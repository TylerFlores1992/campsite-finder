@echo off
REM Start the CampHawk bot + remote sign-in broker (two windows).
REM Run from anywhere; it cd's to the bot folder relative to this file.
cd /d "%~dp0.."
start "CampHawk bot"    cmd /k "npm start"
start "CampHawk broker" cmd /k "npm run broker"
echo Launched bot + broker. Close their windows to stop.
