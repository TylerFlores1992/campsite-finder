@echo off
REM Store your ReserveCalifornia password on THIS machine, encrypted. Double-click it.
REM You run this ONCE. After that the bot signs itself in ~15 minutes before a hold
REM needs a session, and you stop having to run rc-login.bat every morning.
REM
REM WHAT IT DOES NOT DO: it does not open a browser, it does not touch the RC profile
REM lock, and it does not stop anything. Nothing has to be shut down to run this, so it
REM is safe at any time — including 07:55, unlike update.bat.
REM
REM WHERE THE PASSWORD GOES: .rc-bot-profile\.camphawk-creds, encrypted with Windows
REM DPAPI at CurrentUser scope. Only this Windows account on this machine can decrypt it;
REM copied to another box it is a meaningless blob. It is never sent to CampHawk, never
REM written to a log, and never printed back. Same store the rec.gov bot already uses.
REM
REM It cd's to the bot folder itself, because typing the node command into a fresh
REM PowerShell window lands in C:\Users\<you> and fails with MODULE_NOT_FOUND, which
REM reads like a broken install rather than a wrong directory.
setlocal
cd /d "%~dp0.."

echo(
echo === Storing your ReserveCalifornia login ===
echo Type your RC email, press Enter, then your RC password and press Enter.
echo The password will NOT appear as you type. That is deliberate - this machine
echo gets screen-shared, and an echoed password is a password on a recording.
echo(
node rc-keepwarm.mjs --save-login
if errorlevel 1 goto :fail

echo(
echo === Saved. Now restart the RC processes so they pick it up ===
echo Run mini-pc\update.bat (or leave it - they will read the store on their
echo next launch either way; update.bat just makes it immediate).
echo(
echo To check it is working, watch the "CampHawk RC keep-warm" window before your
echo next 8am hold. About 15 minutes out it should print:
echo     hold releases in 15m and the session will not cover it - signing in ONCE
echo followed by "signed in unattended". If it instead says it could not sign in,
echo it will NOT try again - run mini-pc\rc-login.bat and sign in by hand.
echo(
echo To remove the stored password later: delete .rc-bot-profile\.camphawk-creds
echo(
echo Done. You can close this window.
pause
exit /b 0

:fail
echo(
echo *** Nothing was saved. Both the email and the password are required. ***
echo *** Re-run this and try again. Until it is stored, RC auto-cart still ***
echo *** needs mini-pc\rc-login.bat by hand before each hold.              ***
pause
exit /b 1
