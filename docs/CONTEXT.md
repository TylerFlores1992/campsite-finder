# CampHawk — Architecture & Context

The "why" behind the code, so a new machine (or a new you) can pick it up fast.
No secrets here — only names of things. Secrets live in `.env.local` / Vercel / Fly.

## What it is

CampHawk (**camphawk.app**) watches booked campgrounds and alerts you within seconds
of a cancellation, so you can grab the spot. Search is free for everyone; a
subscription turns on watching + instant email/SMS alerts + (rec.gov only) auto-cart.

## Stack

- **Next.js (App Router)** on **Vercel** — website + API routes.
- **Supabase** (Postgres + PostGIS) — data. Accessed server-side via the service role
  through `exec_select` / `exec_dml` RPCs (see `src/lib/db/`). RLS is on for all app
  tables (deny-all; service role bypasses).
- **Clerk** — auth (production instance on camphawk.app).
- **Stripe** — subscriptions ($2.50/mo, $20/yr). Live in prod; test keys locally.
- **Fly.io** — the always-on cancellation poller (`worker/poller.ts`, app
  `campsite-finder-worker`).
- **Resend** (email) + **Twilio** (SMS, A2P-approved) — alerts.
- **Mapbox** — geocoding + maps.
- A **mini PC** (Windows, always-on, residential IP) — hosts the auto-cart bot.

## Reservation sources (how availability is checked)

Each source has an adapter in `src/lib/availability/` and a catalog sync in
`src/lib/sources/`. A campground row's `source` column selects the path.

- **Recreation.gov (federal)** — `source='ridb'`. Nightly RIDB sync (national,
  activity=9). The only source that supports **auto-cart** (cart is tied to your
  rec.gov account, so it syncs to your phone).
- **UseDirect / US eDirect platform** — one integration, many states via a provider
  registry (`src/lib/sources/reservecalifornia/providers.ts`): California
  (ReserveCalifornia), Arizona, Florida, Minnesota, Missouri, Nevada, Ohio, Wyoming,
  Illinois, Virginia. Clean JSON API. Also detects "coming soon" held cancellations
  (the `Lock` field) for a heads-up alert. Adding a state is ~one registry entry:
  find its RDR base by grepping the state's reserve-SPA JS bundle for a
  `*rdr*.usedirect.com` or `*rdr*.recreation-management.tylerapp.com` host, then
  verify `<base>/fd/places` returns 200 JSON.
- **ReserveAmerica (Aspira)** — New York, Texas, Oregon, Utah, North Carolina,
  Kentucky, Iowa, Indiana, Georgia, Nebraska, Pennsylvania, New Hampshire, Montana,
  Rhode Island, New Mexico, Alaska, Connecticut, Delaware (more addable). No JSON API;
  availability is scraped from server-rendered HTML. Catalog paginates 25/page (watch
  for that). Coords come from each park's detail-page Open Graph meta.

State-park coverage spans **28 states** across those two platforms, plus federal
Recreation.gov nationwide. All non-rec.gov sources are **alert-only** (their carts are
session-bound and don't sync to a phone). Adding a source = availability adapter +
catalog sync + wire into search/worker/notifications + update coverage copy.

> **The remaining 22 states need a THIRD platform — don't re-probe them.** As of
> 2026-07-19 every uncovered state was probed against both integrations and none hit:
> all guessed `*.reserveamerica.com` subdomains fail DNS (Colorado's resolves but its
> park directory is empty — it migrated off), and none of their reservation SPAs
> (cpwshop, tnstateparks, camping.nj.gov, parkreservations.maryland.gov, alapark,
> mdwfp, arkansasstateparks, southcarolinaparks…) reference an `*rdr*` host in their
> bundles. Growing past 28 states means a new adapter, not another registry entry.
>
> **GoingToCamp (Camis) — surveyed 2026-07-19, only worth ~2 states.** Tenants are
> `<name>.goingtocamp.com`, but of the US ones only **Washington (167 locations) and
> Wisconsin (64)** exist — the rest of the platform is Canadian (Manitoba, Nova
> Scotia, Yukon, Long Point). MA/ME/SD/ND/VT are *not* on it.
> - Catalog side is easy: `GET /api/resourcelocation` returns clean JSON with
>   `localizedValues[].fullName`, address, website, and `gpsCoordinates` as a
>   `"lat, lng"` **string** (not numeric fields). Coverage is uneven — WA has coords
>   for 136/167, **WI has none**, so WI would need name geocoding like RA does.
>   `GET /api/resourcecategory` gives the site types (Campsite, Cabin, Yurt, Group
>   Camp, Day Use Facility…), so day-use rows can be filtered out.
> - Availability side is the hard part and is **unproven**: `/api/availability/*`
>   endpoints exist but GET without params is a 400, and **POST is blocked by Azure
>   WAF (403) from datacenter IPs** — the same class of problem as the UseDirect
>   CloudFront 403s, so it would likely need the `/api/rc-proxy` treatment or a
>   residential path. Cracking the request shape means reading the Angular bundle.
>
> Verdict: ~2 states (WA is a genuinely big camping state; WI is messier), with the
> availability half carrying real WAF risk.
>
> **The "Aspira six" are really FOUR different platforms — surveyed 2026-07-19.**
> CO/MI/TN/WV/KS/MS do *not* share a backend, so there is no 6-state unlock:
> - **TN + SC = one product** (best cluster). Identical stack: Apache + ColdFusion
>   (`cfid`/`cftoken` cookies, `CF_CLIENT_TSP_LV` vs `CF_CLIENT_SCP_LV` — differs only
>   by state), same "Reservations | <State> State Parks" title. Active Network.
> - **MI + MS = one product.** Proven identical: both serve the *same
>   content-hashed bundles* (`chunk-DXUNNUAM.js`, `chunk-C5FZKBQ3.js`,
>   `chunk-RWNUTB4V.js`), same 42-tag skeleton, same `/api/csp-violation`. Michigan is
>   a big camping state, so this cluster is worth more than its state count suggests.
> - **CO = bespoke.** "Colorado Parks and Wildlife IPAWS", ASP.NET, Active Network
>   (`actv_kuid_*` cookie), and behind a queue-it gate. Hostile; 1 state.
> - **WV = not a campground system at all.** `wvstateparks.com` is a WordPress
>   brochure site; real booking is `reservations.wvstateparks.com`, which runs
>   **Inntopia** (a resort/lodging platform — cabins and lodges, not campsites).
> - **LA = bespoke** ASP.NET at `reservations.gooutdoorslouisiana.com`. KS did not
>   resolve at `reserve.ksoutdoors.com`.
>
> None of these expose a JSON API from their bundles (unlike UseDirect/GoingToCamp) —
> they'd be HTML-scrape integrations in the ReserveAmerica mold.
>
> **Bottom line: no remaining integration unlocks more than 2 states.** Ranked by
> value-for-effort: GoingToCamp (WA+WI, catalog API already proven, availability is
> the risk) → MI+MS (one app, Michigan is a big camping market) → TN+SC (ColdFusion
> scrape, reuses RA-style expertise) → CO/LA/WV (1 state each or lodging-only).

> **Known gap — UseDirect unit catalogs.** For some UseDirect providers (currently
> Florida, Ohio, Illinois, Virginia) the per-facility unit sync comes back empty:
> the `/search/grid` POST that enumerates units hits intermittent CloudFront `403`s
> under the sync's concurrent load. The campground rows still sync (fully searchable
> and watchable) — only the unit-level filter data (site type, RV length) is missing,
> and it accretes over successive nightly worker syncs. Not a code bug; a rate-limit.

## The core flow

1. **Search** (`src/app/api/search`) — radius + dates + filters; branches on `source`
   to the right availability adapter.
2. **Watches** — a subscriber watches a booked campground for their dates.
3. **Poller** (`worker/poller.ts`, on Fly, ~15s) — checks every active watch. On an
   opening it dispatches notifications. Branches by source; uses an atomic claim on
   `notification_sent_at` (1-hour re-notify window) so it never double-alerts.
4. **Notifications** (`src/lib/notifications/`) — email (Resend) + SMS (Twilio).

## Auto-cart (rec.gov only) — the interesting part

Goal: when a watched rec.gov site opens for an enrolled user, add it to their cart
automatically, and only ever tell them "it's in your cart" when it **verifiably** is
(no false hope).

### Design: cart-outcome-gated alerts

- The poller runs auto-cart-eligible rec.gov watches on a **tighter lane** and, on an
  opening, does **not** alert immediately — it writes a pending row to the
  `autocart_jobs` table (migration `014`).
- The **mini-PC bot** (`scripts/auto-cart-bot/bot.mjs`) polls a roster
  (`/api/auto-cart/roster`, master `AUTOCART_TOKEN`), carts the site in the user's own
  logged-in browser, and reports the outcome to `/api/auto-cart/result`.
- Outcome decides the alert:
  - **carted** → "✅ it's in your cart, check out" (email + SMS).
  - **not carted** → the poller re-verifies the site is still open ~35s later and
    sends a normal "still open — book it" alert, or stays **silent** if it's gone.
    This also covers a bot that's offline — a re-verify decides, never a false carted.
- `autocart_jobs` is also the permanent record of every cart attempt.

### The mini-PC bot

- `bot.mjs` — watches the roster, carts openings, reports outcomes; a **keepalive**
  loads an authenticated rec.gov page every few hours so the session never dies from
  idle.
- `broker.mjs` — a websocket server (exposed via a Cloudflare tunnel at
  broker.camphawk.app) that lets a user do the one-time rec.gov sign-in remotely from
  any device (streams the login page via CDP). No passwords ever touch our servers.
- `recgov.mjs` — the actual add-to-cart, using **real Playwright mouse clicks**.
- `session.mjs` — reliable login detection.
- Enrollment/connection state: `users.autocart_enabled` + `users.autocart_connected`.
  The Watches toggle shows "paused — reconnect" when enabled but not connected.

### Hard-won gotchas (these cost real debugging time)

- **Must run HEADED.** rec.gov has an anti-bot gate (a `gate_a` token). Headless
  Chromium gets flagged (`{ok:false, error:"abnormal activity"}`); a real headed
  browser on the residential mini PC passes. A browser window flashes on the mini PC
  per cart — expected.
- **Date picker = react-aria RANGE calendar of `role="button"` divs.** Synthetic
  dispatched events do NOT complete the range (only the check-in anchor sticks →
  0-night payload → 400). Use **Playwright real mouse clicks** (`page.mouse`).
- **Login detection must use `/account/profile`, not the campsite page.** The campsite
  page keeps a hidden "Sign Up or Log In" button in the DOM even when logged in, which
  false-reports "logged out."
- **Don't hand-roll session persistence.** The persistent Playwright profile holds the
  rec.gov session across launches on its own. An earlier save/restore attempt
  corrupted the profile — removed.
- **Never claim `carted` without verifying** the cart page actually shows the item.
- rec.gov enforces booking rules (e.g. weekend minimum stay: Fri+Sat together). A
  rule violation returns 400 — the bot correctly falls back to a normal alert.

## Environment variables (names only — values in `.env.local` / Vercel / Fly)

Supabase (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), Clerk
(`NEXT_PUBLIC_CLERK_*`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`), Stripe
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_MONTHLY/_YEARLY`),
Resend (`RESEND_API_KEY`, `EMAIL_FROM`), Twilio (`TWILIO_*`), Mapbox
(`NEXT_PUBLIC_MAPBOX_TOKEN`), RIDB (`RIDB_API_KEY`), auto-cart
(`AUTOCART_TOKEN`, `BROKER_WS_URL`), `NEXT_PUBLIC_APP_URL`, `SYNC_SECRET`.
The mini-PC bot has its own `.env` (`AUTOCART_TOKEN`, `LOGIN_MODE=remote`,
`BROKER_PORT`, `POLL_MS`).

## Deploy targets

See `docs/SETUP.md`. Short version: website auto-deploys on `git push`; the Fly worker
deploys via `flyctl`; the mini-PC bot updates via `git push` + `update.bat` on the box.
