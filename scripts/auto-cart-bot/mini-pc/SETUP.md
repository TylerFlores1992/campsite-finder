# Mini-PC setup (GMKtec, Windows) — CampHawk auto-cart 24/7

Follow top to bottom on the mini PC. Assumes Windows. ~30 min. Values you'll need:
- **AUTOCART_TOKEN**: `19c756c6ba6a7da67b487a645c73073ea3558a4463f8a04d29d381b90570e747`
- **Hostname for remote sign-in**: `broker.camphawk.app`
- GitHub repo: `TylerFlores1992/campsite-finder`

---

## 1. Install prerequisites
Open **PowerShell** and install with winget (or download each manually):
```powershell
winget install OpenJS.NodeJS.LTS      # Node 18+
winget install Git.Git                 # git
winget install Cloudflare.cloudflared  # tunnel (for remote sign-in)
```
Close and reopen PowerShell so PATH updates. Verify:
```powershell
node -v ; git --version ; cloudflared --version
```

## 2. Get the code
```powershell
cd $HOME
git clone https://github.com/TylerFlores1992/campsite-finder.git
cd campsite-finder\scripts\auto-cart-bot
npm install
npx playwright install chromium
```

## 3. Configure `.env`
```powershell
Copy-Item .env.example .env
notepad .env
```
Set these (leave the rest default):
```
CAMPHAWK_URL=https://camphawk.app
AUTOCART_TOKEN=19c756c6ba6a7da67b487a645c73073ea3558a4463f8a04d29d381b90570e747
POLL_MS=5000
WINDOW_MIN=15
LOGIN_MODE=remote
BROKER_PORT=8787
```
`LOGIN_MODE=remote` means sign-ins happen through the web (broker), not local windows.

## 4. Cloudflare Tunnel (permanent hostname for remote sign-in)
One-time, creates `broker.camphawk.app`:
```powershell
cloudflared tunnel login                 # opens browser → pick the camphawk.app zone
cloudflared tunnel create camphawk-broker # creates the tunnel + credentials file
cloudflared tunnel route dns camphawk-broker broker.camphawk.app
```
Create a config file at `C:\Users\<you>\.cloudflared\config.yml`:
```yaml
tunnel: camphawk-broker
credentials-file: C:\Users\<you>\.cloudflared\<TUNNEL-UUID>.json
ingress:
  - hostname: broker.camphawk.app
    service: http://localhost:8787
  - service: http_status:404
```
(The UUID is printed by `tunnel create` and is the json filename in that folder.)
Run it once to test, then we'll make it auto-start in step 7:
```powershell
cloudflared tunnel run camphawk-broker
```

## 5. Point CampHawk at the broker
In **Vercel** (CampHawk project → Settings → Environment Variables, Production):
```
BROKER_WS_URL = wss://broker.camphawk.app
```
Redeploy (Deployments → ⋯ → Redeploy). Now the app's "Sign into recreation.gov
now" button and `/connect` will reach this mini PC.

## 6. First run + test
In one PowerShell window:
```powershell
cd $HOME\campsite-finder\scripts\auto-cart-bot
npm start          # the watcher (adds openings to carts)
```
In a second window:
```powershell
cd $HOME\campsite-finder\scripts\auto-cart-bot
npm run broker     # the remote sign-in service
```
(Or just run `mini-pc\start.bat`, which launches both.)

Test the whole thing from your **laptop or phone**: go to camphawk.app → Watches →
Auto-cart modal → **Sign into recreation.gov now**. Sign in; within ~10s it should
say connected. That's the remote flow working against the real mini PC.

## 7. Auto-start on boot (so it survives reboots/power blips)
Make all three (bot, broker, tunnel) start when the machine powers on:
1. Press `Win+R`, type `shell:startup`, Enter — opens the Startup folder.
2. Copy a shortcut to `mini-pc\start-all.bat` into that folder.
The machine will launch everything on login. Set the mini PC to **auto-login** and
never sleep (Settings → Power → Screen/Sleep = Never; and disable "require sign-in").

## Notes / troubleshooting
- Logs: bot/broker print to their windows. For headless debugging of the sign-in
  window, set `BROKER_HEADLESS=0` in `.env` to watch the real browser.
- If a friend's sign-in fails, their auto-cart toggle flips itself back OFF — they
  just toggle it on again to retry.
- To update the bot later: `git pull` in the repo, then restart the windows.
- Full feature background is in `../README.md` → "Remote sign-in".
