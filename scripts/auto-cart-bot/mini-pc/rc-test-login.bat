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
REM Same reasoning as rc-login.bat: two Chromium on one user-data-dir corrupt the profile.
REM Kill by COMMAND LINE - powershell -NoExit retitles its own console, so a WINDOWTITLE
REM filter matches nothing and silently leaves the old processes running. And never
REM taskkill /IM node.exe here, which would take the rec.gov bot and the broker down too.
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'rc-keepwarm\.mjs|rc-hold-runner\.mjs' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
del /q ".rc-bot-profile\.camphawk-profile-lock" >nul 2>&1
timeout /t 3 /nobreak >nul

echo(
echo === Testing the unattended sign-in ===
node rc-keepwarm.mjs --test-login
set RESULT=%errorlevel%

echo(
echo === Relaunching the RC processes ===
start "CampHawk RC keep-warm" powershell -NoExit -Command "node rc-keepwarm.mjs 2>&1 | Tee-Object -FilePath logs\rc-keepwarm.log -Append"
start "CampHawk RC holds"     powershell -NoExit -Command "node rc-hold-runner.mjs 2>&1 | Tee-Object -FilePath logs\rc-holds.log -Append"
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

:fail
echo(
echo *** FAILED - AND YOU ARE NOW SIGNED OUT OF RC. ***
echo(
echo Read the reason printed above, then:
echo   - "check the password"  =^> re-run mini-pc\rc-save-password.bat. The password is
echo     hidden as you type, so a typo leaves no trace. This is the likely one.
echo   - "CAPTCHA"             =^> nothing to fix in software. Sign in by hand.
echo(
echo EITHER WAY, RUN mini-pc\rc-login.bat NOW to sign back in. Do not leave this.
echo Alerts are unaffected - the poller detects from Fly, not from this box. It is
echo only the 8am auto-hold that needs the RC session.
pause
exit /b 1
