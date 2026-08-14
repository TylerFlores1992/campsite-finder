@echo off
REM The ONE human step for ReserveCalifornia. Double-click it.
REM
REM RC started serving a reCAPTCHA on sign-in (2026-08-07), so the bot cannot log itself
REM in — a person has to, once, and then the keep-warm loop never lets the session lapse.
REM Run this whenever rc-keepwarm reports "RC SESSION IS DEAD".
REM
REM It cd's to the bot folder itself. Typing `node rc-keepwarm.mjs --login` into a fresh
REM PowerShell window lands in C:\Users\<you> and fails with MODULE_NOT_FOUND, which
REM reads like a broken install rather than a wrong directory.
setlocal
cd /d "%~dp0.."

echo(
echo === Closing anything holding the RC profile ===
REM Two Chromium instances on one user-data-dir do not fail cleanly, they corrupt the
REM session — the exact thing we are here to restore. The lock file cannot survive a
REM hard kill, so clear it too: a stale one blocks the RC processes for 10 minutes.
REM
REM KILL BY COMMAND LINE, NOT BY WINDOW TITLE. This used `taskkill /FI "WINDOWTITLE eq
REM CampHawk RC keep-warm*"`, which matched NOTHING: start-all.bat launches these through
REM `powershell -NoExit`, and PowerShell retitles its own console on startup, so the title
REM the `start` command set is gone by the time taskkill looks. The old processes survived
REM every run of this script.
REM
REM It failed SILENTLY at the only step that matters, and then failed loudly somewhere
REM harmless: the relaunched windows died on `Tee-Object` because the survivors still held
REM logs\rc-*.log open. A file-lock error is what you saw; a stale process is what it meant.
REM Observed 2026-08-08. `update.bat` masked the same bug for months by also running
REM `taskkill /IM node.exe /F`, which ignores titles — until supervisors shipped and lived
REM through it, at which point it started leaving five stale windows behind on every run.
REM Both scripts kill by command line now; update.bat via mini-pc\stop-all.ps1. THIS one
REM keeps its own narrower list on purpose — stop-all takes down the rec.gov bot and the
REM broker too, and a ReserveCalifornia sign-in has no business doing that.
REM The supervisor's own command line contains "rc-keepwarm.mjs", so this pattern takes the
REM supervisor down with the child — which it must, or the supervisor would restart the
REM process we are about to replace, five seconds into the sign-in.
REM
REM The Chromium match is scoped to .rc-bot-profile: Playwright's browser outlives a
REM force-killed parent and keeps the real Chrome lock on the user-data-dir, so deleting our
REM own lock file is not enough — and a blanket `taskkill /IM chrome.exe` would close the
REM browser of whoever is sitting at this machine.
REM
REM CALLED WITH -File, NOT -Command. This was inline PowerShell until 2026-08-14, and it had
REM NEVER RUN ONCE: the regex contained `\"`, which is PowerShell's escape and not cmd's, so
REM that quote CLOSED the string, everything after it was unquoted, and the very next `|`
REM became a cmd PIPE. Every invocation printed the heading above and then died with
REM   'ForEach-Object' is not recognized as an internal or external command
REM having killed nothing - and then opened a second Chromium on a profile the first still
REM held, which is the corruption every comment above warns about. The fix is not better
REM quoting, it is having no quoting to get wrong: -File passes no code through cmd at all.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-rc.ps1"
if errorlevel 1 goto :busy

echo(
echo === Opening ReserveCalifornia ===
echo Sign in, TICK "Keep me signed in", and solve the CAPTCHA if one appears.
echo The window closes by itself once the session is confirmed.
echo(
node rc-keepwarm.mjs --login
if errorlevel 1 goto :fail

echo(
echo === Signed in. Relaunching the RC processes ===
REM UNDER THE SUPERVISOR, like start-all.bat does. These were bare `powershell -NoExit`
REM windows until 2026-08-11, which meant a hand sign-in quietly downgraded exactly the two
REM processes it was fixing: whatever killed them next would not be restarted, and the
REM keep-warm's wedge watchdog EXITS on purpose, expecting something to bring it back.
start "CampHawk RC keep-warm" powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0supervise.ps1" -Name "rc-keepwarm"   -Command "node rc-keepwarm.mjs"
start "CampHawk RC holds"     powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0supervise.ps1" -Name "rc-hold-runner" -Command "node rc-hold-runner.mjs"
echo(
REM Say what a FAILED relaunch looks like. The failure mode here is a window that opens,
REM prints a red file-lock error and then just sits there — which reads as "a window
REM opened", i.e. success, unless you know otherwise.
echo TWO new windows should have opened, both printing log lines within a minute.
echo If you now have FOUR RC windows, or either shows a red "cannot access the file
echo ... because it is being used by another process" error, an old copy survived:
echo run mini-pc\stop-all.ps1 then mini-pc\start-all.bat, and then run THIS script
echo again — stopping everything ends the RC session.
REM CORRECTED 2026-08-10. This used to say the sign-in survives an update because it
REM "lives in .rc-bot-profile\, which nothing deletes". The PROFILE survives; the SESSION
REM does not. RC keeps no Okta session cookie in the profile (see the 2026-08-09 finding),
REM so the access token in the running browser is the whole session — and stopping the RC
REM processes closes that browser. Acting on the old wording cost a freshly-made session
REM eight minutes after it was created.
echo(
echo Then confirm from anywhere:  curl -s https://camphawk.app/api/health/status
echo   autocart.rc_session should read ok within ~20 minutes (one keep-warm pass).
echo(
echo TIRED OF RUNNING THIS? Run mini-pc\rc-save-password.bat once. It stores your
echo RC password encrypted on this machine (DPAPI, this Windows account only) and
echo the bot then signs itself in about 15 minutes before each hold. This script
echo stays as the fallback for when it cannot - a CAPTCHA, or a changed password.
echo(
echo Done. You can close this window.
pause
exit /b 0

:busy
echo(
echo *** Something is still holding the RC profile. Nothing was opened. ***
echo(
echo stop-rc.ps1 named the surviving process ids above. Two Chromium on one
echo user-data-dir corrupt the session this script exists to restore, so it
echo stops here rather than signing in on top of them.
echo(
echo Run mini-pc\stop-all.ps1, then mini-pc\start-all.bat, then this again.
pause
exit /b 1

:fail
echo(
echo *** No session was confirmed. Nothing was relaunched. ***
echo *** Re-run this when you have a moment — RC auto-cart is off until you do.  ***
echo *** Alerts are unaffected: the poller detects from Fly, not from this box.  ***
pause
exit /b 1
