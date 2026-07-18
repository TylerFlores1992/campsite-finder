@echo off
REM Full auto-start: Cloudflare tunnel + bot + broker (three windows).
REM Put a shortcut to this file in shell:startup for launch-on-boot.
cd /d "%~dp0.."
if not exist logs mkdir logs
REM Bot + broker output is mirrored to logs\*.log (console still shows too) so cart
REM outcomes survive a window close/reboot — handy for diagnosing a missed cart.
start "Cloudflare tunnel" cmd /k "cloudflared tunnel run camphawk-broker"
start "CampHawk bot"      powershell -NoExit -Command "npm start 2>&1 | Tee-Object -FilePath logs\bot.log -Append"
start "CampHawk broker"   powershell -NoExit -Command "npm run broker 2>&1 | Tee-Object -FilePath logs\broker.log -Append"
echo Launched tunnel + bot + broker. Logs in scripts\auto-cart-bot\logs\.
