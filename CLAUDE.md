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
  `v2/Pricing.tsx` and `v2/SubscribeCta.tsx` follow the same rule. None renders a price
  in the native app. `unknown` (a failed status lookup) is treated as "don't nag",
  never as "not subscribed" — that rule is why a Clerk blip can't tell a paying
  subscriber to subscribe.
- **A subscriber is never sold to.** `v2/PricingSection.tsx` returns a "here's what you
  can do" block for `subscribed`, not the launch-pricing pitch — a paying customer
  reading "$2.50 a month, subscribe now and keep your rate" reads it as a billing
  failure.
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

## Feature E — FULLY STOPPED 2026-07-30 (display *and* collection)
"This site had an opening on ~X% of recent checks for a stay this far out." Four parts,
all gated behind a 20-sample **honesty threshold** (numbers hidden until honest).
**Nothing is displayed and nothing is being recorded** — it cost ~15,700 Vercel function
invocations a day (327 UseDirect probe targets via `/api/rc-proxy`) to feed a signal no
user could see. **THREE switches, all must flip to bring it back:**
1. `PROBE_ENABLED = "true"` in `worker/fly.toml` (needs a worker deploy; the poller logs
   `probe roster OFF` at startup while it's false),
2. `UPDATE probe_targets SET active = true` — all 502 rows are `false`; this one alone
   restarts accrual with no deploy, which is why switch 1 exists (a re-run of
   `seed-probe-targets.ts` sets `active = true` and would otherwise restart it silently),
3. `SHOW_LIKELIHOOD = true` in `src/components/v2/likelihood.ts` for the UI.
Accrual needs weeks of lead time before the buckets are honest again — turn it on well
before you plan to show anything. The 137k observations collected so far are untouched.
- **Recorder + probe roster** in `worker/poller.ts` → `availability_observations`
  (migration 020) + `probe_targets` (021). Roster = 502 rows, now all inactive
  (150 rec.gov + 120 ReserveCalifornia + ~207 across 9 other UseDirect states + 25
  GoingToCamp; seeded 2026-07-25). Seed/broaden with
  `scripts/seed-probe-targets.ts --source=<src>` (`NODE_USE_ENV_PROXY=1` for UseDirect
  **and GoingToCamp** sources — both route through the agent proxy; the seed's
  `isOpenInRange` supports all three families).
- **Aggregation** `src/lib/likelihood.ts` (`getOpeningRate`, `campgroundBuckets`,
  `getHeadlines`). **Readout/sanity-check:** `scripts/likelihood-readout.mts`.
- **UI:** card badge, detail-page ladder (`/api/likelihood`), per-watch odds — all share
  the aggregation + gate, all behind `SHOW_LIKELIHOOD`.

## `/api/rc-proxy` takes a BATCH (2026-07-30)
It forwarded one RDR request per invocation on the hot path of a 15s poller —
~63,000 Vercel invocations/day for 16 watches, the biggest line in the usage bill.
Now `{base, requests:[…]}` → `{results:[…]}` in order, each with its own
`{ok,status,data,upstreamStatus,detail}`; one bad item never fails the other N-1.
Coalescing is client-side in `reservecalifornia/client.ts` (40ms window per RDR base,
deduped on method+path+body, below the retry loop so retries just rejoin a batch).
Both wire shapes stay live in both directions because Vercel and Fly deploy from the
same push. **Upstream load is unchanged and must stay that way** — the proxy paces a
batch at `FANOUT = 2`; don't raise it. Details in `docs/CONTEXT.md`.

## Alerting — the claim (read this before touching the poller)
The decision "may we alert for this?" is `worker/claim.ts`, keyed on
**(watch_id, site_key)** in `watch_site_alerts` (migration 026), 1-hour window.
- It was one timestamp per WATCH until 2026-07-30, so the first site to open silenced
  every other site on that watch for an hour — and because the auto-cart lane shares
  the claim, the second site was never CARTED either, not merely un-announced.
- Sources with no site id (ReserveAmerica, GoingToCamp, TN/SC) collapse onto a `'*'`
  sentinel and keep the old per-watch behaviour, which is correct for them.
- `claim.ts` is separate from `poller.ts` because importing the poller STARTS it —
  that's what made the most consequential code in the repo untestable.

## Tests exist now — `npm test`
`node:test` via tsx, no framework dependency. `*.test.mts` under `worker/`: the
alerting claim, the admin cost arithmetic, canary thresholds. **They hit the real DB
on purpose** (the claim's correctness lives inside one `INSERT .. ON CONFLICT ..
WHERE`; a mock would test a fake). The fixture watch is dated 2020 so the poller's
`end_date > CURRENT_DATE` filter can never see it. Before trusting a regression test,
break the code and watch it fail — that's how the claim suite was validated.

## Reservation-provider resilience (2026-07-30)
Both rec.gov and UseDirect now have a throttle breaker; **UseDirect had nothing** until
this date, which is how every RC fetch could fail every 15s indefinitely.
- **RC's API is flaky** — 20 identical calls returned nineteen 200s and one 500. Retry
  (`UD_ATTEMPTS`) is the fix; there was none.
- **A 403 from these WAFs means "slow down", not "never"** — one Virginia sync got 403
  on 83 calls and 200 on 193, same address, same run. Retried with an 8x longer backoff.
- **Fly cannot reach the California RDR host at all** (three attempts, all timeouts).
  That is why `/api/rc-proxy` exists — don't "simplify" it away.
- `/api/rc-proxy` now returns the real `upstreamStatus`; it used to collapse everything
  to a bare 502 and the worker discarded the body, so the one identifying fact reached
  neither log.

## Deploy (recap — details in SETUP.md)
- **Website → Vercel**, auto-deploys on push to `master`.
- **Worker → Fly** `campsite-finder-worker`, via the **`worker-deploy.yml` GitHub
  Action** (2026-07-28). Auto-fires on a `master` push touching `worker/**` or the
  `src/lib` dirs the worker imports, and is dispatchable by hand or by an agent. It
  restarts the machines that were running pre-deploy and **fails unless a fresh
  heartbeat lands** — the old "deploy looks fine, alerting is dead" trap. Needs repo
  secret `FLY_API_TOKEN`. The build-image-locally workaround in SETUP.md is now only
  the fallback for when the Action itself is broken. Roster/data-only changes need no
  deploy at all (the poller reads `probe_targets` live).
- **Non-secret worker tunables** live in `worker/fly.toml [env]`.

## Web-session gotchas (this environment)
- **Node `fetch` needs `NODE_USE_ENV_PROXY=1`** to reach Supabase / reservation portals.
- **The credentials are process env vars — THERE IS NO `.env` FILE.** `grep`ping `.env*`
  finds nothing and looks exactly like "no credentials here". It isn't; check
  `printenv`. Cost a wrong "I can't build here" call on 2026-07-29 with Clerk, Stripe,
  Supabase and Mapbox all present. They are the **LIVE** keys.
- **Chromium can't reach Mapbox either** (`ERR_CONNECTION_RESET` — same TLS reset that
  blocks browsing the live site). `NODE_USE_ENV_PROXY=1` does NOT help: it affects
  Node's fetch, not the browser. So any full-page screenshot renders maps as a blank
  grey box, and rec.gov CDN photos likewise — capture those on a real device.
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
  layout.** Doing so **500s every page at request time**, while `/api/*` (no root layout)
  stays up. (This was long attributed to **Cache Components / `dynamicIO`**; that flag is
  **not** enabled — `next.config.ts` sets no such option. The mechanism is unconfirmed;
  the outage is not.) It cost a full prod outage 2026-07-24 (the
  native-app UA detection was done this way; moved to a client `useSyncExternalStore` in
  `src/lib/native/context.tsx`). Corollary: **`next build` passing is NOT enough** for
  layout/rendering changes — dynamic segments aren't executed at build, so the throw only
  surfaces at runtime. Smoke-test a real page after deploying (`curl -sI camphawk.app/`).

## Open / next session

### iOS is SUBMITTED (2026-07-30) — build 5, awaiting review
Release is set to **manual**, so approval does NOT put it live; you flip it. Privacy
label published, age rating 4+, content rights yes, **availability United States only**,
screenshots in all three size boxes (6.9" / 6.5" / 13" iPad — the iPad set is required
because the Capacitor build declares iPad support). Everything Apple asked for is in
`docs/APP-STORE.md`; §2 is the review-notes text to paste into any Resolution Center
reply. The rejection to argue rather than code around is **3.1.3(b)** — the app has no
purchase mechanism at all, which is the whole defence.

### DO THIS THE MOMENT THE APP IS LIVE
**Turn on store link-out:** set `NATIVE_LINKOUT = true` in
`src/components/v2/nativeSubscribe.tsx`. It sends non-subscribers in the app to
camphawk.app to subscribe, and it is built and wired into all five surfaces — just dark.
**Web-side, so a push to `master` reaches already-installed apps — no rebuild, no new
review.** Smoke-test a real page after (`curl -sI camphawk.app/`).

**Precondition:** app availability restricted to the **United States**. **DONE on Apple
(2026-07-30); NOT done on Play** — do it before an Android release, not after. Both
stores' anti-steering carve-outs (Apple 3.1.1 post-*Epic* contempt ruling; Play
post-Ninth-Circuit) are **US-storefront only**, and showing this UI to a non-US
storefront is a review failure that can reportedly cost the entitlement. Device locale
is NOT a storefront check. Full reasoning in `docs/CONTEXT.md` → store-billing.

### Mobile app — everything below needs `npm install && npx cap sync` + a REBUILD
Shipped 2026-07-27, all native-side, so **a web deploy does not deliver them**:
launch URL now `/search` (not `/`, the only page with checkout) · Android back button
(default was *exit the app from any screen*) · external links → system browser
(`@capacitor/browser`, newly added) · push permission asked after a watch exists, not on
first load · offline handling (`errorPath` shell + in-app banner).
The **pricing fixes are already live** in installed apps — those were web-side.

### Verified since / still unverified
**Verified 2026-07-29–30:** account deletion end-to-end (Stripe `canceled`, row gone,
Clerk empty, re-signup works), watch creation (18 active across two reservation
systems), Stripe checkout (demo account `trialing`, card attached), and
`GET /api/manage/<token>` returning the watch on production.

**Still unverified — click through signed in:** the settings writes (phone save,
auto-cart toggle), the campsite mute list on `/manage/<token>`, and the admin menu item
for the owner. Revert of the whole swap is `git revert a029c27` if something is badly
wrong.

### Known, not urgent
- **`campgrounds.photos`: RIDB ingest FIXED and backfilled 2026-07-27.** Cause:
  TWO bugs, both silent. (1) RIDB serves media from a separate
  `/facilities/<id>/media` endpoint, which the sync never called, so `facility.MEDIA`
  was always undefined. (2) The filter demanded `MediaType === 'Photo'`; RIDB labels
  them **`'Image'`**, so even once fetched, every record was discarded — a filter
  yields `[]`, never an error, so nothing alarmed. `syncFacility` now fetches media
  (non-fatal on failure) and `mediaToPhotos` (one helper, three callers) matches
  case-insensitively. Roughly 40% of facilities genuinely have no media in RIDB, so
  a complete backfill fills ~60% of rows, not all of them. **To fill the existing
  rows:** the backfill RAN 2026-07-27 — **3,775 of 4,469 filled, 25,570 photos, 6.8 per
  campground**; the other 694 have no media in RIDB at all. The one-shot admin panel was
  removed once it was done. If it's ever needed again (it shouldn't be — the sync now
  fetches media for every facility it touches):
  `RIDB_API_KEY=... npx tsx scripts/backfill-ridb-photos.ts`, safe to re-run and
  interrupt, only touches empty rows. The photo strip, `og:image` and JSON-LD `image` already
  consume the column, so they light up with no UI change.
  The other 3,544 rows (UseDirect / GoingToCamp / ReserveAmerica / state portals) are
  still empty and were NOT investigated — each portal needs its own look.
- **Feature E's frozen dataset** is 137k observations across 511 campgrounds (accrual
  stopped 2026-07-30). It clusters at 14-20 and 45-51 days out, so the **4-7 day bucket
  is empty** — the window a "tonight/this weekend" searcher cares about. If accrual is
  ever restarted, broaden `PROBE_LEAD_DAYS` at the same time or the ladder ships with
  holes. (The 25 Virginia targets were also 403ing from ~2026-07-30 00:40 — moot now,
  and no user watch was ever affected.)
- **Costs tab**: the "$0.00 providers" note is resolved — 6 rows, none at zero, after a
  dedupe (Vercel/Claude/Apple/Cloudflare each had 2-3 copies inflating fixed costs to
  ~$149/mo against a real ~$50). It now also tracks **one-time costs** and **lifetime
  spend**, the latter needing a `started_at` per row (defaults to the date of entry).
  **A cancelled service accrues forever** — `ended_at` was deliberately dropped in
  migration 030, so deleting the row is the only way to stop it, which also erases its
  history. Details in `docs/CONTEXT.md`.
- **The admin banner used to cry wolf daily.** Canary staleness thresholds now live in
  `src/lib/health-thresholds.ts` — they were in three places and disagreed with
  `worker/fly.toml`. If you change the cadence there, change it there too.
- **Search Console**: submitted, ~7,387 URLs. Expect "Discovered - currently not
  indexed" for weeks; that's the normal queue, not a fault.
