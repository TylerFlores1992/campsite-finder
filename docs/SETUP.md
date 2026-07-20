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

> One behavioural difference locally: `GTC_AVAILABILITY_URL` is set on Vercel
> production only, so local search calls GoingToCamp **directly** instead of via the
> worker. That works from a home connection (the block is on Vercel's IPs, not
> datacenter IPs generally) — so GoingToCamp availability can look fine locally and
> still need the worker path in production.

## Deploy — three separate targets

| Piece | Lives on | How to deploy |
|-------|----------|----------------|
| **Website** (Next.js) | Vercel | **Auto-deploys on every `git push` to `master`.** Nothing else to do. |
| **Alert worker** (`worker/poller.ts`) | Fly.io app `campsite-finder-worker` | `flyctl deploy --config worker/fly.toml --dockerfile worker/Dockerfile --remote-only` (needs Fly login). Only needed when you change `worker/` or `src/lib` it uses — **including adding a ReserveAmerica contract or GoingToCamp tenant**, since the worker imports those registries and a stale worker silently never alerts for the new state. Also serves `POST /gtc/availability` for the website's search page. |
| **Auto-cart bot** (`scripts/auto-cart-bot/`) | The mini PC only | `git push`, then run `mini-pc/update.bat` on the mini PC (via RustDesk). It can't run anywhere else — it drives a real logged-in recreation.gov browser. |

## Catalog syncs (which campgrounds exist)

Availability is checked live per watch; the **catalog** (which campgrounds/units
exist) is populated by these syncs. Data is national and shared, so you rarely run
these by hand — but here's how each source refreshes:

| Source | Runs | Manual re-sync |
|--------|------|----------------|
| **RIDB** (rec.gov, federal) | Nightly GitHub Action (`.github/workflows/nightly-sync.yml`) | `npx tsx scripts/run-sync.ts ALL` |
| **ReserveAmerica** (state parks) | Same nightly Action (added step) | `npx tsx scripts/run-sync-ra.ts` (all contracts), or `npx tsx scripts/run-sync-ra.ts DE` for one state — use the single-state form when adding one, a full run re-scrapes ~18 states |
| **GoingToCamp** (WA/MI/WI/MS) | On the **Fly worker** hourly (`gtcSyncIfDue` in `worker/poller.ts`, fires at 22h staleness) — NOT in the GitHub Action, because the Camis WAF blocks Vercel and the worker throttles itself | `npx tsx scripts/run-sync-gtc.ts` (all), or `... run-sync-gtc.ts WA` for one state. Needs `NEXT_PUBLIC_MAPBOX_TOKEN` — most rows are geocoded from their full street address. |
| **UseDirect** (state parks) | On the **Fly worker** hourly (`rcSyncIfDue` in `worker/poller.ts`) — NOT in the GitHub Action, because some RDR hosts WAF-block datacenter IPs and it routes through the `/api/rc-proxy` on Vercel | `npx tsx scripts/run-sync-ud.ts` (run from a **residential IP** — it forces direct, no proxy) |

Adding a state to an **existing** platform is usually a one-line registry entry —
`RA_CONTRACTS` (`src/lib/sources/reserveamerica/client.ts`), `USEDIRECT_PROVIDERS`
(`src/lib/sources/reservecalifornia/providers.ts`), or `GOINGTOCAMP_PROVIDERS`
(`src/lib/sources/goingtocamp/providers.ts`) — plus a sync run and the coverage copy
(`src/app/layout.tsx` metadata, SubscribeGate).

**Then deploy the Fly worker.** The worker imports those registries, so a push alone
leaves it stale and the new state's watches never alert — silently, with no error.
Confirm with `scripts/e2e-gtc-alert.mts` (it sends a real email/SMS; see
`docs/CONTEXT.md`). As of 2026-07-19 there are **no cheap registry adds left** — every
remaining state needs a new adapter. See `docs/CONTEXT.md` before going hunting.

## Repo layout (orientation)

```
src/app/            Next.js routes + API routes (search, stripe, auto-cart/*, webhooks/*)
                    api/rc-proxy    Vercel-side proxy for UseDirect (Fly is WAF-blocked there)
src/lib/            Core logic
  availability/     per-source availability checks (recgov, reservecalifornia,
                    reserveamerica, goingtocamp [+ goingtocamp-remote: asks the worker])
  sources/          catalog sync per platform (ridb, reservecalifornia [+UseDirect states],
                    reserveamerica, goingtocamp)
  notifications/    email + SMS dispatch
  db/               Supabase client + migrations/
src/components/     UI (SearchBar, map, WatchesPanel, AutoCartToggle, SubscribeGate, …)
worker/             Fly.io cancellation poller (poller.ts)
                    http-server.ts  POST /gtc/availability, for the Vercel search page
scripts/auto-cart-bot/  Mini-PC Playwright bot + remote sign-in broker
scripts/            run-sync*.ts catalog syncs; e2e-gtc-alert.mts (live alert test —
                    SENDS REAL EMAIL/SMS)
```

> **Proxy directions are opposite for the two WAF'd sources — don't copy one to the
> other.** UseDirect: Fly is blocked, Vercel is fine, so the worker calls out through
> `/api/rc-proxy` on Vercel. GoingToCamp: **Vercel** is blocked, Fly is fine, so the
> website calls in to the worker's `/gtc/availability`. See `docs/CONTEXT.md`.

## Working from another device — quickest paths

- **Just keep directing changes (like via Claude Code):** clone the repo on the
  device and open the folder in the Claude Code desktop app (or use claude.ai/code /
  GitHub Codespaces — no local setup). Chat history and Claude's memory do **not**
  sync across devices, so read `docs/CONTEXT.md` for the full picture.
- **Run/poke at the site yourself:** Path in sections 1–3 above.

See `docs/CONTEXT.md` for architecture and the decisions/gotchas behind the code.
