# CampHawk personal auto-cart bot

Watches CampHawk for openings on **your** watches and automatically adds the
site to **your own** recreation.gov cart — running on your machine, in your
logged-in browser, on your IP. It stops at the cart; **you review and pay.**

- **recreation.gov** → fully automatic (selects your dates, clicks *Add to Cart*).
  rec.gov's cart is tied to your account, so it syncs to your phone — you can finish
  checkout from anywhere.
- **ReserveCalifornia** → the bot just logs a note. RC's cart is session/client-bound
  (it wouldn't sync to your phone), so auto-carting it on your desktop is pointless
  when you're away. Instead, CampHawk's email/text alert links straight to the RC
  booking page — tap it on your phone and finish there.

> **Heads up:** this automates *your own account* for personal use. recreation.gov's
> terms discourage automated access — this tool behaves like a normal human session
> (your login, your IP, gentle polling) and does not try to evade anything. Use at
> your own discretion.

---

## One-time setup

Requires **Node 18+**.

**1. Set the shared secret in CampHawk (Vercel).**
Pick a long random string. In Vercel → your project → Settings → Environment
Variables (Production), add:

```
AUTOCART_TOKEN = <that long random string>
```
Redeploy so it takes effect.

**2. Install the bot.**
```bash
cd scripts/auto-cart-bot
npm install
npx playwright install chromium
cp .env.example .env
```
Edit `.env` and paste the **same** `AUTOCART_TOKEN` you set in Vercel.

**3. Sign in once (saves your session).**
```bash
npm run login
```
A browser opens to recreation.gov (and ReserveCalifornia). Log in to whichever you
use, then return to the terminal and press **Enter**. Your session is saved to
`chrome-profile/` and reused every run — you won't need to log in again unless the
site logs you out.

---

## Run it
```bash
npm start
```
Leave the terminal **and** the browser window open. When one of your watched sites
opens up, the bot:

1. hears about it from CampHawk (within your poll interval),
2. opens the site in a new tab, picks your dates, and clicks **Add to Cart**,
3. leaves the tab open — you just review and **check out**.

Stop anytime with **Ctrl+C**.

### Keeping it always-on
For true "set and forget," run it on a machine that stays awake (an old laptop, a
mini-PC, or a Raspberry Pi). The browser must be able to open (headed), so use a
machine with a display or a virtual one.

---

## Config (`.env`)
| Var | Default | Meaning |
|-----|---------|---------|
| `CAMPHAWK_URL` | `https://camphawk.app` | Your CampHawk site |
| `AUTOCART_TOKEN` | — | Must match the value in Vercel |
| `POLL_MS` | `20000` | How often to check for openings (ms) |
| `WINDOW_MIN` | `15` | How far back to consider an opening "fresh" (min) |

## Notes & limits
- The bot acts on openings CampHawk already detects for your watches, so set up your
  watches in the app first.
- recreation.gov is a React app with no stable public DOM; selectors are best-effort
  with fallbacks (ported from the CampHawk browser extension). If the site changes and
  a cart misses, the tab is left open so you can finish manually.
- It never stores or sees your recreation.gov / ReserveCalifornia password — those live
  only in your local browser profile.
