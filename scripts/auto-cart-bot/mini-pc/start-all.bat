@echo off
REM Full auto-start: Cloudflare tunnel + bot + broker (three windows).
REM Put a shortcut to this file in shell:startup for launch-on-boot.
cd /d "%~dp0.."
start "Cloudflare tunnel" cmd /k "cloudflared tunnel run camphawk-broker"
start "CampHawk bot"      cmd /k "npm start"
start "CampHawk broker"   cmd /k "npm run broker"
echo Launched tunnel + bot + broker.
