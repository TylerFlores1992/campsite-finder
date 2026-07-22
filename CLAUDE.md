@AGENTS.md

# CampHawk — project memory (orientation for a fresh session)

**What it is:** camphawk.app — watches booked campgrounds and alerts subscribers within
seconds of a cancellation (email + SMS, and rec.gov auto-cart). Search is free; watching
+ alerts are paid. Fixed **or flexible** date watches ("any N nights in a window").

**Deep detail lives in `docs/CONTEXT.md` (architecture, gotchas, env vars) and
`docs/SETUP.md` (dev + deploy). Read those before non-trivial work.** This file is just
the fast map.

## Roadmap A–E — ALL SHIPPED (2026-07-22)
A alert-health canary · B verified deep-links · C flexible dates · D smarter notifications
(one-tap stop/reopen, site-mute, dead-man's switch) · E cancellation-likelihood signal.

## Feature E (newest) — how it fits together
"This site had an opening on ~X% of recent checks for a stay this far out." Four parts,
all gated behind a 20-sample **honesty threshold** (numbers hidden until honest):
- **Recorder + probe roster** in `worker/poller.ts` → `availability_observations`
  (migration 020) + `probe_targets` (021). Roster = 270 active (150 rec.gov + 120
  ReserveCalifornia). Seed/broaden with `scripts/seed-probe-targets.ts --source=<src>`
  (`NODE_USE_ENV_PROXY=1` for UseDirect sources).
- **Aggregation** `src/lib/likelihood.ts` (`getOpeningRate`, `campgroundBuckets`,
  `getHeadlines`). **Readout/sanity-check:** `scripts/likelihood-readout.mts`.
- **UI:** card badge, detail-page ladder (`/api/likelihood`), per-watch odds in the
  Watches panel — all share the aggregation + gate, so they light up together as data
  matures (~a day of accrual per bucket).

## Deploy (recap — details in SETUP.md)
- **Website → Vercel**, auto-deploys on push to `master`.
- **Worker → Fly** `campsite-finder-worker`. From a web session `flyctl deploy` can't
  build (proxy blocks the builders); use the **build-image-locally + `flyctl deploy
  --image`** workaround in SETUP.md. Worker changes need this; roster/data-only changes
  don't (the poller reads `probe_targets` live).
- **Non-secret worker tunables** live in `worker/fly.toml [env]`.

## Web-session gotchas (this environment)
- **Node `fetch` needs `NODE_USE_ENV_PROXY=1`** to reach Supabase / reservation portals.
- **Live site can't be browsed** — the agent proxy resets headless-Chromium TLS. To
  eyeball UI, use `scripts/screenshot-component.mts <preset>` (isolated component render
  on localhost). Full authenticated pages aren't screenshottable here (needs real Clerk
  session + a `CLERK_SECRET_KEY` in the env; map also won't render). Never disable TLS
  verification or unset `HTTPS_PROXY`.
- **New public `/api/*` route 404s** until added to `isPublicRoute` in
  `src/middleware.ts` (Clerk's `auth.protect()` returns 404, not 401).

## Open / next session
- **Verify Feature E is accruing** (`scripts/likelihood-readout.mts`) and that the worker
  picked up the RC roster targets; confirm numbers look sane once buckets cross the gate.
- Roster could broaden to other UseDirect states / GoingToCamp (GTC needs a datacenter-
  reachable checker added to the seed's `isOpenInRange`).
