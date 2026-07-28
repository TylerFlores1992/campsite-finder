@AGENTS.md

# CampHawk — project memory (orientation for a fresh session)

**What it is:** camphawk.app — watches booked campgrounds and alerts subscribers within
seconds of a cancellation (email + SMS, and rec.gov auto-cart). Search is free; watching
+ alerts are paid. Fixed **or flexible** date watches ("any N nights in a window").

**Deep detail lives in `docs/CONTEXT.md` (architecture, gotchas, env vars) and
`docs/SETUP.md` (dev + deploy). Read those before non-trivial work.** This file is just
the fast map.

## Front-end rewrite — SHIPPED + SWAPPED LIVE (2026-07-27)
The whole UI was rebuilt on the `--ch-*` design system and swapped over the real routes.
The old pages and 14 orphaned components are **deleted**; `/v2` no longer exists.
- **Routes** live in `src/app/(app)/` — a route group giving nav/backdrop/footer without
  a path segment: `/` (marketing, server-rendered) · `/search` (Explore) · `/watches` ·
  `/new` · `/settings` · `/campground/<id>` (server-rendered) · `/manage/<token>`.
  `/camping` + `/camping/<state>` are SEO landing pages outside the group.
- **Primitives** `src/components/ui/`, **screens** `src/components/v2/`.
- **Watch creation is gated in ONE component** (`v2/WatchCta.tsx` + `useSubscription`);
  `v2/Pricing.tsx` follows the same rule. Neither renders a price in the native app.
- **`robots` is per page, not in the layout.** `/` and `/search` index; `/watches`,
  `/settings`, `/new` don't; `/manage/<token>` is `noindex, nocache` — the URL contains
  the token that authorises the watch.
- **The stock Tailwind colour overrides are DELETED (2026-07-27).** The last 13 files
  on `bg-green-600`/`text-gray-*` were converted, so `--ch-*` is the only palette —
  a new `bg-green-600` now renders STOCK Tailwind green. Use a `ch-*` token.
- **The admin link lives in the account menu** (`V2Nav`), not `/settings`. `V2Nav` is a
  client component, so it gets the boolean from `GET /api/admin/status` (Clerk-authed,
  `lib/admin` stays `server-only`) — never a client-side email check.

## SEO (added 2026-07-27, live since the swap lifted the layout `noindex`)
Server-rendered campground pages + per-page metadata (`lib/seo.ts`), JSON-LD
(`lib/jsonld.ts`), 47 state landing pages, dynamic sitemap (~7,387 URLs). Guard with
`NODE_USE_ENV_PROXY=1 npx tsx scripts/seo-check.mts`. Search Console is connected.

## Roadmap A–E — ALL SHIPPED (2026-07-22)
A alert-health canary · B verified deep-links · C flexible dates · D smarter notifications
(one-tap stop/reopen, site-mute, dead-man's switch) · E cancellation-likelihood signal.

## Feature E — how it fits together
"This site had an opening on ~X% of recent checks for a stay this far out." Four parts,
all gated behind a 20-sample **honesty threshold** (numbers hidden until honest):
- **Recorder + probe roster** in `worker/poller.ts` → `availability_observations`
  (migration 020) + `probe_targets` (021). Roster = 502 active (150 rec.gov + 120
  ReserveCalifornia + ~207 across 9 other UseDirect states + 25 GoingToCamp; seeded
  2026-07-25). Seed/broaden with `scripts/seed-probe-targets.ts --source=<src>`
  (`NODE_USE_ENV_PROXY=1` for UseDirect **and GoingToCamp** sources — both route
  through the agent proxy; the seed's `isOpenInRange` now supports all three families).
- **Aggregation** `src/lib/likelihood.ts` (`getOpeningRate`, `campgroundBuckets`,
  `getHeadlines`). **Readout/sanity-check:** `scripts/likelihood-readout.mts`.
- **UI:** card badge, detail-page ladder (`/api/likelihood`), per-watch odds — all share
  the aggregation + gate. **Currently OFF everywhere:** `SHOW_LIKELIHOOD = false` in
  `src/components/v2/likelihood.ts` is the single switch. Accrual continues regardless.

## Deploy (recap — details in SETUP.md)
- **Website → Vercel**, auto-deploys on push to `master`.
- **Worker → Fly** `campsite-finder-worker`. From a web session `flyctl deploy` can't
  build (proxy blocks the builders); use the **build-image-locally + `flyctl deploy
  --image`** workaround in SETUP.md. Worker changes need this; roster/data-only changes
  don't (the poller reads `probe_targets` live).
- **Non-secret worker tunables** live in `worker/fly.toml [env]`.

## Web-session gotchas (this environment)
- **Node `fetch` needs `NODE_USE_ENV_PROXY=1`** to reach Supabase / reservation portals.
- **Live site can't be browsed** — the agent proxy resets headless-Chromium TLS. `curl`
  against camphawk.app DOES work and is the way to verify a deploy. To eyeball UI, use
  `scripts/screenshot-component.mts <preset>` (isolated component render on localhost;
  set `window.__CH_SIGNED_IN = true` in the preset for signed-in UI). Never disable TLS
  verification or unset `HTTPS_PROXY`.
- **Rendering a whole PAGE needs real Clerk keys** — the root layout wraps everything in
  `ClerkProvider`, so without them every page 500s while `next build` still passes. A
  dummy key is rejected; and `NEXT_PUBLIC_*` is inlined at BUILD time, so you must
  rebuild after adding it. See SETUP.md.
- **New public `/api/*` route 404s** until added to `isPublicRoute` in
  `src/middleware.ts` (Clerk's `auth.protect()` returns 404, not 401).
- **NEVER call a request-time API (`headers()`/`cookies()`/`connection()`) in the ROOT
  layout.** This build runs **Cache Components** (dynamicIO) — a request-time API in the
  root layout without a Suspense boundary **throws at request time and 500s every page**,
  while `/api/*` (no root layout) stays up. It cost a full prod outage 2026-07-24 (the
  native-app UA detection was done this way; moved to a client `useSyncExternalStore` in
  `src/lib/native/context.tsx`). Corollary: **`next build` passing is NOT enough** for
  layout/rendering changes — dynamic segments aren't executed at build, so the throw only
  surfaces at runtime. Smoke-test a real page after deploying (`curl -sI camphawk.app/`).

## Open / next session

### DO THIS THE MOMENT THE APP IS LIVE
**Turn on store link-out:** set `NATIVE_LINKOUT = true` in
`src/components/v2/nativeSubscribe.tsx`. It sends non-subscribers in the app to
camphawk.app to subscribe, and it is built and wired into all five surfaces — just dark.

**Precondition, non-negotiable:** app availability must first be restricted to the
**United States** in App Store Connect **and** Play Console. Both stores' anti-steering
carve-outs (Apple 3.1.1 post-*Epic* contempt ruling; Play post-Ninth-Circuit) are
**US-storefront only**, and showing this UI to a non-US storefront is a review failure
that can reportedly cost the entitlement. Device locale is NOT a storefront check.
Full reasoning in `docs/CONTEXT.md` → store-billing, and in the file's own header.

### Mobile app — everything below needs `npm install && npx cap sync` + a REBUILD
Shipped 2026-07-27, all native-side, so **a web deploy does not deliver them**:
launch URL now `/search` (not `/`, the only page with checkout) · Android back button
(default was *exit the app from any screen*) · external links → system browser
(`@capacitor/browser`, newly added) · push permission asked after a watch exists, not on
first load · offline handling (`errorPath` shell + in-app banner).
The **pricing fixes are already live** in installed apps — those were web-side.

### Still unverified from the sandbox — click through signed in
Watch creation end-to-end, Stripe checkout, the settings writes (phone save, auto-cart
toggle), the campsite mute list on `/manage/<token>`, and the admin menu item for the
owner. Revert of the whole swap is `git revert a029c27` if something is badly wrong.

### Known, not urgent
- **`campgrounds.photos`: RIDB ingest FIXED 2026-07-27, backfill NOT YET RUN.** Cause:
  RIDB serves media from a separate `/facilities/<id>/media` endpoint, which the sync
  never called, so `facility.MEDIA` was always undefined and all 4,469 RIDB rows stored
  `[]`. `syncFacility` now fetches it (non-fatal on failure). **To fill the existing
  rows:** **Admin -> System Health -> Campground photos -> Run backfill** (works from a
  phone; runs on Vercel, where `RIDB_API_KEY` lives, in cursor-paged batches driven by
  the browser). CLI equivalent: `RIDB_API_KEY=... npx tsx scripts/backfill-ridb-photos.ts`.
  Safe to re-run and safe to interrupt; only touches empty rows. The photo strip, `og:image` and JSON-LD `image` already
  consume the column, so they light up with no UI change.
  The other 3,544 rows (UseDirect / GoingToCamp / ReserveAmerica / state portals) are
  still empty and were NOT investigated — each portal needs its own look.
- **Feature E has data** (81k observations, 510 campgrounds) but the probe roster
  clusters at 14-20 and 45-51 days out, so the **4-7 day bucket is empty** - the window
  a "tonight/this weekend" searcher cares about. Broaden the roster's lead spread before
  turning `SHOW_LIKELIHOOD` on, or the ladder ships with holes.
- **Costs tab**: six providers (Fly, Supabase, Clerk, Twilio, Mapbox, Mini PC) sit at
  $0.00 and almost certainly aren't free, so net margin currently flatters.
- **Search Console**: submitted, ~7,387 URLs. Expect "Discovered - currently not
  indexed" for weeks; that's the normal queue, not a fault.
