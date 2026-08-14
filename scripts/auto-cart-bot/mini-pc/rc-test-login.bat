@echo off
REM Prove the bot can sign itself in - NOW, not at 07:45 on the morning it matters.
REM
REM Run this once after rc-save-password.bat, and any time you change your RC password.
REM It does the real thing: drops the current token so RC treats the browser as signed
REM out, then runs the exact same sign-in the bot would run 15 minutes before a hold.
REM
REM YOU DO NOT NEED TO LOG OUT OF RC FIRST, and you should NOT sign out through RC's own
REM menu. This clears the stored TOKEN and leaves cookies alone on purpose: the DT cookie
REM on signin.reservecalifornia.com is what tells Okta this is a machine it has seen
REM before. Signing in without it is what a fresh profile looks like, and repeated
REM fresh-profile logins are what got this house's IP blocked for twelve hours on
REM 2026-08-06 and put a CAPTCHA in front of this browser on 08-07.
REM
REM IF IT FAILS you will be left signed OUT, and the script says so loudly. Run
REM rc-login.bat straight afterwards - do not walk away from a failed test.
REM
REM A browser window will open and drive itself. Leave it alone; it closes on its own.
setlocal
cd /d "%~dp0.."

echo(
echo === Making the RC profile available ===
REM Same reasoning as rc-login.bat, and the same file does it now: two Chromium on one
REM user-data-dir corrupt the profile. Kill by COMMAND LINE - powershell -NoExit retitles its
REM own console, so a WINDOWTITLE filter matches nothing and silently leaves the old
REM processes running. Never taskkill /IM node.exe here, which would take the rec.gov bot and
REM the broker down too.
REM
REM This was inline PowerShell until 2026-08-14. It happened to work HERE and not in
REM rc-login.bat, because only that copy carried the Chromium arm whose `[^\"]` closed the
REM cmd string - so a line that looks identical was fine in one file and silently dead in
REM the other. That is the argument for having none of it in a .bat: -File passes no code
REM through cmd.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-rc.ps1"
if errorlevel 1 goto :busy

echo(
echo === Testing the unattended sign-in ===
echo (this takes up to two minutes - the window driving itself is expected)
REM Tee'd through PowerShell so the run is BOTH live on screen and saved to a file.
REM "email entered, then the window closed" was an accurate report and still not enough to
REM act on - three different faults produce exactly that, and the console had already gone.
REM `exit $LASTEXITCODE` matters: without it PowerShell returns its own status and the
REM PASSED/FAILED branch below reads the wrong outcome.
if not exist "logs" mkdir "logs"
powershell -NoProfile -Command "node rc-keepwarm.mjs --test-login 2>&1 | Tee-Object -FilePath logs\rc-test-login.log; exit $LASTEXITCODE"
set RESULT=%errorlevel%

echo(
echo === Relaunching the RC processes ===
REM UNDER THE SUPERVISOR, like start-all.bat and rc-login.bat. These were bare
REM `powershell -NoExit` windows until 2026-08-14 - the same downgrade that was fixed in
REM rc-login.bat on 08-11 and left standing here, which is what a second copy always costs.
REM The keep-warm's wedge watchdog EXITS on purpose expecting a restart; unsupervised, that
REM is the ten-hour silence of 2026-08-10.
start "CampHawk RC keep-warm" powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0supervise.ps1" -Name "rc-keepwarm"   -Command "node rc-keepwarm.mjs"
start "CampHawk RC holds"     powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0supervise.ps1" -Name "rc-hold-runner" -Command "node rc-hold-runner.mjs"
timeout /t 2 /nobreak >nul

if not "%RESULT%"=="0" goto :fail
echo(
echo === PASSED. The bot can sign itself in. ===
echo Nothing to do in the morning. It will do this again about 15 minutes before
echo each hold releases, and you are signed in right now either way.
echo(
echo Two new windows should have opened. If either shows a red "cannot access the
echo file ... because it is being used by another process" error, an old copy is
echo still running - run mini-pc\update.bat to clear it.
echo(
echo Done. You can close this window.
pause
exit /b 0

:busy
echo(
echo *** Something is still holding the RC profile. Nothing was tested. ***
echo(
echo stop-rc.ps1 named the surviving process ids above. You are still signed in -
echo this stopped BEFORE dropping the token, so nothing was lost.
echo(
echo Run mini-pc\stop-all.ps1, then mini-pc\start-all.bat, then this again.
pause
exit /b 1

:fail
echo(
echo *** FAILED - AND YOU ARE NOW SIGNED OUT OF RC. ***
echo(
echo Read the reason printed above, then:
echo   - "check the password"  =^> re-run mini-pc\rc-save-password.bat. The password is
echo     hidden as you type, so a typo leaves no trace.
echo   - "CAPTCHA"             =^> nothing to fix in software. Sign in by hand.
echo   - anything else         =^> send these two files, they say exactly which step:
echo         logs\rc-test-login.log
echo         logs\rc-test-login-failed.png
echo(
echo EITHER WAY, RUN mini-pc\rc-login.bat NOW to sign back in. Do not leave this.
echo Alerts are unaffected - the poller detects from Fly, not from this box. It is
echo only the 8am auto-hold that needs the RC session.
pause
exit /b 1
