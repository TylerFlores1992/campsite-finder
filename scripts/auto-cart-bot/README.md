# CampHawk personal auto-cart bot (multi-account)

Runs on one always-on machine and, whenever a watched site opens up for an
**enrolled** CampHawk user, adds it to **that user's own** recreation.gov cart —
each in their own logged-in browser profile. It stops at the cart; the user
checks out (their cart syncs to their phone, so they can finish anywhere).

- **recreation.gov** → fully automatic (dates + *Add to Cart*), account-tied so it
  reaches their phone.
- **ReserveCalifornia** → the bot just logs a note. RC's cart is session-bound and
  wouldn't sync to a phone; the CampHawk email/text alert links to the RC page to
  finish on mobile instead.

**No passwords are ever stored.** Each person signs into their *own* browser profile
once; only the resulting session lives on the machine.

> **Heads up:** this automates each person's *own* account for personal use.
> recreation.gov's terms discourage automated access — the bot behaves like a normal
> human session (their login, this machine's IP, gentle polling) and evades nothing.
> Running friends' accounts means you're custodian of their sessions — a trust call.

---

## How enrollment works
1. A user (you or a friend) opens the CampHawk app → **Watches** panel → flips
   **"Auto-cart openings"** ON. That adds them to the bot's roster.
2. On the bot machine, you run a one-time **login** for that person so their session
   is saved (they type their own rec.gov password — you never see it).
3. From then on, the bot auto-carts their openings. Adding another friend = they
   toggle it on + one login. No code or config changes.

---

## One-time setup (the machine)
Requires **Node 18+**.

**1. Master token in Vercel.** Set `AUTOCART_TOKEN` (a long random string) in your
CampHawk Vercel project (Production) and redeploy. This one token lets the bot pull
every enrolled user's feed.

**2. Install.**
```bash
cd scripts/auto-cart-bot
npm install
npx playwright install chromium     # on a Pi see "Raspberry Pi" below
cp .env.example .env                 # paste the same AUTOCART_TOKEN
```

**3. Sign each enrolled person in (once each).**
```bash
npm run login                 # lists enrolled users, pick one
# or target one directly:
npm run login -- friend@example.com
```
A browser opens to recreation.gov — that person signs in, then you press **Enter**.
Their session is saved to `profiles/<their-id>/` and reused every run.

---

## Run it
```bash
npm start
```
Leave it running. When any enrolled user's watched site opens, the bot carts it in
their profile and leaves the tab ready for them to check out. Stop with **Ctrl+C**.

If someone has an opening but hasn't logged in yet, the bot prints the exact
`npm run login` command for them and skips (no crash).

---

## Config (`.env`)
| Var | Default | Meaning |
|-----|---------|---------|
| `CAMPHAWK_URL` | `https://camphawk.app` | Your CampHawk site |
| `AUTOCART_TOKEN` | — | Master token; must match Vercel |
| `POLL_MS` | `20000` | How often to check (ms) |
| `WINDOW_MIN` | `15` | How far back an opening counts as fresh (min) |
| `CHROME_CHANNEL` | — | Set to `chromium` to use the system browser (Raspberry Pi) |

## Raspberry Pi notes
- Playwright's bundled Chromium is flaky on ARM. Instead: `sudo apt install chromium`
  and set `CHROME_CHANNEL=chromium` in `.env`.
- On a screenless Pi, run under a virtual display: `xvfb-run npm start`. Do the
  one-time logins with a monitor or over VNC.
- Use an 8GB Pi if running several accounts (≈0.5–1 GB of RAM per open browser).

## Notes
- The bot only acts on openings CampHawk already detects for each user's watches — so
  they set up their watches in the app first.
- rec.gov is a React app with no stable public DOM; selectors are best-effort with
  fallbacks (ported from the CampHawk browser extension). On a miss, the tab is left
  open to finish manually.
- Passwords are never stored or seen — only each person's local browser session.
