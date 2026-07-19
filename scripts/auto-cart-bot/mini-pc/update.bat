@echo off
REM One-click update for the mini PC: stop everything, pull latest code, relaunch.
REM Double-click this after a CampHawk code change. (Local files — .env, profiles,
REM logs, carted/handled.json — are git-ignored, so `git pull` won't touch them.)
setlocal
cd /d "%~dp0.."

echo(
echo === Stopping bot, broker, and tunnel ===
taskkill /FI "WINDOWTITLE eq CampHawk bot*"     /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq CampHawk broker*"  /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Cloudflare tunnel*" /T /F >nul 2>&1
REM Dedicated bot host: node.exe is only the bot + broker, so clear any strays.
taskkill /IM node.exe /F >nul 2>&1
taskkill /IM cloudflared.exe /F >nul 2>&1
REM Also kill any Chromium the bot/broker left behind, so a stale browser can't
REM hold the profile or linger after an update.
taskkill /IM chrome.exe /F >nul 2>&1
taskkill /IM headless_shell.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo(
echo === Pulling latest code ===
git pull || goto :fail

echo(
echo === Installing dependencies (quick if nothing changed) ===
call npm install || goto :fail

echo(
echo === Relaunching tunnel + bot + broker ===
call "%~dp0start-all.bat"

echo(
echo === Update complete. Three new windows should have opened. ===
echo You can close this window.
pause
exit /b 0

:fail
echo(
echo *** Update FAILED above. Nothing was relaunched. Read the error, fix it, ***
echo *** then run mini-pc\start-all.bat manually to bring the bot back up.     ***
pause
exit /b 1
