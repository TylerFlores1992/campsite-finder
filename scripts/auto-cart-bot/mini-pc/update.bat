@echo off
REM One-click update for the mini PC: stop everything, pull latest code, relaunch.
REM Double-click this after a CampHawk code change. (Local files — .env, profiles,
REM logs, carted/handled.json — are git-ignored, so `git pull` won't touch them.)
setlocal
cd /d "%~dp0.."

echo(
echo === Stopping bot, broker, tunnel, and the RC processes ===
taskkill /FI "WINDOWTITLE eq CampHawk bot*"     /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq CampHawk broker*"  /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq CampHawk RC keep-warm*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq CampHawk RC holds*"     /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Cloudflare tunnel*" /T /F >nul 2>&1
REM Dedicated bot host: node.exe is only the bot + broker, so clear any strays.
taskkill /IM node.exe /F >nul 2>&1
taskkill /IM cloudflared.exe /F >nul 2>&1
REM Also kill any Chromium the bot/broker left behind, so a stale browser can't
REM hold the profile or linger after an update.
taskkill /IM chrome.exe /F >nul 2>&1
taskkill /IM headless_shell.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

REM A hard kill never runs the lock's release, so the file survives and reads as HELD for
REM ten minutes — during which the relaunched RC processes refuse to open the profile and
REM skip their passes. An update at 07:55 would silently cost the 8am cart. Nothing is
REM running at this point, so clearing it is safe by construction.
del /q "profiles\*\.camphawk-profile-lock" >nul 2>&1
del /q ".rc-bot-profile\.camphawk-profile-lock" >nul 2>&1

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
echo === Update complete. FIVE new windows should have opened: ===
echo     Cloudflare tunnel, CampHawk bot, CampHawk broker,
echo     CampHawk RC keep-warm, CampHawk RC holds.
echo If you cannot see all five, something failed to start — do not assume it is fine.
echo(
echo Watch the "CampHawk RC keep-warm" window for one pass. If it says
echo "RC SESSION IS DEAD", run mini-pc\rc-login.bat once, by hand.
echo You can close this window.
pause
exit /b 0

:fail
echo(
echo *** Update FAILED above. Nothing was relaunched. Read the error, fix it, ***
echo *** then run mini-pc\start-all.bat manually to bring the bot back up.     ***
pause
exit /b 1
