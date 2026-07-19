# CampHawk — Dev Setup

How to work on this project from any machine.

## Prerequisites

- **Node.js 20+** and **git**
- A GitHub login (to push) — `gh auth login` or a personal access token
- Optional, only for deploying the pieces below: the **Vercel CLI** and **Fly CLI**

## 1. Get the code

```bash
git clone https://github.com/TylerFlores1992/campsite-finder.git
cd campsite-finder
npm install
```

## 2. Get the secrets (`.env.local`)

The app needs environment variables that are **not** in the repo (Supabase, Clerk,
Stripe, Mapbox, Resend, Twilio, the auto-cart token, etc.). Two ways to get them:

- **Pull from Vercel (recommended):**
  ```bash
  npm i -g vercel
  vercel login
  vercel link            # choose the campsite-finder project
  vercel env pull .env.local
  ```
- **Or copy** an existing `.env.local` from a machine that has one (via USB or a
  password-manager secure note — never email/Slack it; it contains live secrets).

> Note: `.env.local` intentionally uses **Stripe TEST** keys for local dev, while
> Vercel Production uses LIVE keys. If you `vercel env pull`, double-check you're
> not running live Stripe against a local server.

## 3. Run it

```bash
npm run dev          # http://localhost:3000
```

Only the Next.js website runs locally. The background worker and the auto-cart bot
run elsewhere (see Deploy).

## Deploy — three separate targets

| Piece | Lives on | How to deploy |
|-------|----------|----------------|
| **Website** (Next.js) | Vercel | **Auto-deploys on every `git push` to `master`.** Nothing else to do. |
| **Alert worker** (`worker/poller.ts`) | Fly.io app `campsite-finder-worker` | `flyctl deploy --config worker/fly.toml --dockerfile worker/Dockerfile --remote-only` (needs Fly login). Only needed when you change `worker/` or `src/lib` it uses. |
| **Auto-cart bot** (`scripts/auto-cart-bot/`) | The mini PC only | `git push`, then run `mini-pc/update.bat` on the mini PC (via RustDesk). It can't run anywhere else — it drives a real logged-in recreation.gov browser. |

## Repo layout (orientation)

```
src/app/            Next.js routes + API routes (search, stripe, auto-cart/*, webhooks/*)
src/lib/            Core logic
  availability/     per-source availability checks (recgov, reservecalifornia, reserveamerica)
  sources/          catalog sync per platform (ridb, reservecalifornia [+UseDirect states], reserveamerica)
  notifications/    email + SMS dispatch
  db/               Supabase client + migrations/
src/components/     UI (SearchBar, map, WatchesPanel, AutoCartToggle, SubscribeGate, …)
worker/             Fly.io cancellation poller (poller.ts)
scripts/auto-cart-bot/  Mini-PC Playwright bot + remote sign-in broker
```

## Working from another device — quickest paths

- **Just keep directing changes (like via Claude Code):** clone the repo on the
  device and open the folder in the Claude Code desktop app (or use claude.ai/code /
  GitHub Codespaces — no local setup). Chat history and Claude's memory do **not**
  sync across devices, so read `docs/CONTEXT.md` for the full picture.
- **Run/poke at the site yourself:** Path in sections 1–3 above.

See `docs/CONTEXT.md` for architecture and the decisions/gotchas behind the code.
