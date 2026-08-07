@echo off
REM Full auto-start: Cloudflare tunnel + bot + broker + the two RC processes.
REM Put a shortcut to this file in shell:startup for launch-on-boot.
cd /d "%~dp0.."
if not exist logs mkdir logs
REM Bot + broker output is mirrored to logs\*.log (console still shows too) so cart
REM outcomes survive a window close/reboot — handy for diagnosing a missed cart.
start "Cloudflare tunnel" cmd /k "cloudflared tunnel run camphawk-broker"
start "CampHawk bot"      powershell -NoExit -Command "npm start 2>&1 | Tee-Object -FilePath logs\bot.log -Append"
start "CampHawk broker"   powershell -NoExit -Command "npm run broker 2>&1 | Tee-Object -FilePath logs\broker.log -Append"
REM ReserveCalifornia. Two processes, and the split is deliberate: keep-warm OWNS the
REM session and is the only thing that ever touches login, while the hold runner only
REM drives the session it is given. RC started serving a reCAPTCHA on sign-in
REM (2026-08-07), so a bot that can re-login is off the table — one that never needs to
REM is not. If keep-warm ever prints "RC SESSION IS DEAD", run `node rc-keepwarm.mjs
REM --login` once, by hand, and tick "Keep me signed in".
start "CampHawk RC keep-warm"  powershell -NoExit -Command "node rc-keepwarm.mjs 2>&1 | Tee-Object -FilePath logs\rc-keepwarm.log -Append"
start "CampHawk RC holds"      powershell -NoExit -Command "node rc-hold-runner.mjs 2>&1 | Tee-Object -FilePath logs\rc-holds.log -Append"
echo Launched tunnel + bot + broker + RC keep-warm + RC holds. Logs in scripts\auto-cart-bot\logs\.
