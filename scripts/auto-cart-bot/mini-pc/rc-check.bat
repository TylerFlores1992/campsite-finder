@echo off
REM "Is RC auto-cart actually working?" — double-click, read two answers.
REM
REM Both halves have to be true and they fail independently: the feed can be reachable
REM while the RC session is dead, and vice versa. Checking one and assuming the other is
REM how a hold sits unclaimed at 8am.
setlocal
cd /d "%~dp0.."

echo(
echo === 1. Can we reach CampHawk, and is the token accepted? ===
node rc-hold-runner.mjs --once

echo(
echo === 2. Is the ReserveCalifornia session alive? ===
REM Exits 1 for a dead session. It takes the profile lock, so if the keep-warm loop is
REM mid-pass this reports "profile busy" — which is NOT a dead session; run it again.
node rc-keepwarm.mjs --once
if errorlevel 1 (
  echo(
  echo *** RC session is DEAD. Run mini-pc\rc-login.bat — one human sign-in. ***
  echo *** Until then nothing can be carted at 8am.                          ***
)

echo(
pause
