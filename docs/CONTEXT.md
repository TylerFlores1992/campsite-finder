# CampHawk — Architecture & Context

The "why" behind the code, so a new machine (or a new you) can pick it up fast.
No secrets here — only names of things. Secrets live in `.env.local` / Vercel / Fly.

## What it is

CampHawk (**camphawk.app**) watches booked campgrounds and alerts you within seconds
of a cancellation, so you can grab the spot. Search is free for everyone; a
subscription turns on watching + instant email/SMS alerts + (rec.gov only) auto-cart.
Watches can be a fixed stay or **flexible** — "any N nights in this window,
optionally weekends" (see "Flexible dates" under the core flow).

> **Roadmap status (from the A–E "what's worth building" list) — ALL SHIPPED
> (2026-07-22).** A (alert-health canary), B (verified UseDirect/GoingToCamp
> deep-links), C (flexible dates), D (smarter notifications: one-tap stop/reopen,
> site-specific mute, dead-man's switch), and E (cancellation-likelihood signal) are
> all live. See "Cancellation-likelihood (feature E)" under the core flow for how E
> works and what's left to broaden.

## Stack

- **Next.js (App Router)** on **Vercel** — website + API routes.
- **Supabase** (Postgres + PostGIS) — data. Accessed server-side via the service role
  through `exec_select` / `exec_dml` RPCs (see `src/lib/db/`). RLS is on for all app
  tables (deny-all; service role bypasses).
- **Clerk** — auth (production instance on camphawk.app).
- **Stripe** — subscriptions ($2.50/mo, $20/yr). Live in prod; test keys locally.
- **Fly.io** — the always-on cancellation poller (`worker/poller.ts`, app
  `campsite-finder-worker`). It also serves one HTTP endpoint
  (`worker/http-server.ts`) that the website calls for GoingToCamp availability,
  because Vercel's IPs are WAF-blocked from that source.
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

- **GoingToCamp / Camis** — `source='goingtocamp'`, ids `gtc-<ST>-<resourceLocationId>`
  (ids are negative, e.g. `gtc-WA--2147483647`). Washington, Michigan, Wisconsin,
  Mississippi. Clean JSON API; see `src/lib/sources/goingtocamp/`. Alert-only.

- **TN/SC State Parks (ColdFusion portal)** — `source='tnsc'`, ids `tnsc-<ST>-<key>`
  (TN keys on parkId, `tnsc-TN-25`; SC keys on slug, `tnsc-SC-aiken`). Tennessee
  live (shipped 2026-07-20); **South Carolina live (shipped 2026-07-22)**. Same
  ColdFusion backend + WAF direction, but two different front-ends: TN is a batched
  JSON availability API, SC is an HTML park-grid filter (see the TN+SC note below).
  See `src/lib/sources/tnsc/`. Alert-only, and the worker reaches both **through a
  Vercel proxy** (`/api/tnsc-availability`) because the portal's WAF blocks Fly.

State-park coverage spans **33 states** across those platforms, plus federal
Recreation.gov nationwide. All non-rec.gov sources are **alert-only** (their carts are
session-bound and don't sync to a phone). Adding a source = availability adapter +
catalog sync + wire into search/worker/notifications + update coverage copy.

> **Adding a state to an existing source REQUIRES a Fly worker deploy, not just a
> push.** The worker imports `RA_CONTRACTS` / `USEDIRECT_PROVIDERS` /
> `GOINGTOCAMP_PROVIDERS` directly, so on a stale worker the new state's watches hit
> a registry lookup that returns `undefined` and silently `return false` — searchable
> on the website, but **never alerting, with no error anywhere**. This nearly shipped
> with Delaware. Verify after deploy with `scripts/e2e-gtc-alert.mts` (below).

> **The 18 still-uncovered states each need a NEW adapter — don't re-probe them.** As
> of 2026-07-19 every uncovered state was probed against UseDirect and ReserveAmerica
> and none hit: all guessed `*.reserveamerica.com` subdomains fail DNS (Colorado's
> resolves but its park directory is empty — it migrated off), and none of their
> reservation SPAs (cpwshop, tnstateparks, camping.nj.gov,
> parkreservations.maryland.gov, alapark, mdwfp, arkansasstateparks,
> southcarolinaparks…) reference an `*rdr*` host in their bundles. Four of the states
> that pass then turned out to be GoingToCamp (below); the rest need new adapters,
> not registry entries.
>
> **GoingToCamp (Camis) — SHIPPED 2026-07-19. 362 campgrounds across 4 states.**
> **Do NOT identify this platform by domain name.** Two of its four US tenants use
> vanity domains, which is why an earlier pass misfiled them as "Aspira":
>
> | State | Host | Locations | w/ coords |
> |-------|------|-----------|-----------|
> | WA | `washington.goingtocamp.com` | 167 | 136 |
> | MI | `midnrreservations.com` | 148 | 15 |
> | WI | `wisconsin.goingtocamp.com` | 64 | 0 |
> | MS | `reserve.mdwfp.com` | 21 | 0 |
>
> The reliable test is the API itself: `GET /api/resourcelocation` returning a JSON
> array. Every other uncovered state was swept with it — no further hits, so this is
> all 4. (The rest of the platform is Canadian: Manitoba, Nova Scotia, Yukon, Long
> Point.) MA/ME/SD/ND/VT are *not* on it.
>
> - **Catalog:** `GET /api/resourcelocation` → `localizedValues[].fullName`, address,
>   website, and `gpsCoordinates` as a `"lat, lng"` **string** (not numeric fields).
>   Only WA is well-covered; **WI and MS have zero coords and MI only 15**, so most
>   rows are geocoded — from the **full street address**, never the park name (see
>   the coordinates note below). `GET /api/resourcecategory` gives site types
>   (Campsite, Cabin, Yurt, Group Camp, Day Use Facility…) to filter day-use rows.
> - **Availability — the working call:**
>   ```
>   GET /api/availability/resourcelocation
>       ?resourceLocationId=<id>&bookingCategoryId=0&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
>   ```
>   → `[{ mapId, mapAvailabilities, resourceAvailabilities: { <resourceId>: [{ availability, remainingQuota }] } }]`
>
>   It must carry a **full browser User-Agent**, and it works from residential and
>   Fly but **not from Vercel** — see the reachability table further down, which is
>   the authoritative version. (An earlier draft of this section claimed the WAF was
>   "POST-only" and that GET "is fine from a datacenter IP". Both were wrong.)
> - **It is whole-stay, not per-night — which is exactly what we want.** The
>   per-resource array stays length 1 no matter how many nights the range spans
>   (verified at 1/2/3/5/7 nights): the API evaluates the entire `[start, end)` range
>   and returns one verdict per site. That matches CampHawk's "one site, all
>   consecutive nights" rule **natively** — no per-night set intersection like RA.
>   Day-use-only parks correctly return `[]` (e.g. Anderson Lake).
> - **The `availability` enum — decoded from the app's own source, and `0` means
>   AVAILABLE.** Not a bitmask; a plain enum (found in the lazy chunks; the app's test
>   is literally `resourceAvailabilities[id].every(s => s.availability === Available)`):
>   ```
>   0 Available   1 Unavailable  2 NotOperating  3 NonReservable
>   4 Closed      5 Invalid      6 InvalidBookingCategory
>   7 PartiallyAvailable         8 Held
>   ```
>   **Do not invert this.** An earlier guess here had `7` as the available value —
>   backwards, and it would have alerted on `PartiallyAvailable` (only part of the
>   requested range is free, i.e. NOT bookable for the whole stay) while missing every
>   real opening. Consistent with observation: +150d out returns `2` everywhere
>   (outside booking window), +3d returns all-nonzero (booked solid), +45d shows a mix.
>   **`8 = Held` is the cancelled-but-not-yet-released state** — the same opportunity
>   as ReserveCalifornia's `Lock` field, so coming-soon alerts are possible here too.
> - **Reading the source requires a real browser.** Plain `curl` of the site HTML
>   returns the *Azure WAF challenge page*, not the app (the `/api/*` endpoints are
>   unaffected). Load it in the browser pane, then fetch the chunks from inside the
>   page — that's how the enum above was recovered.
>
> - **`bookingCategoryId` matters — pass `0` (Nightly).** These tenants sell day-use
>   and rentals through the same API (Mississippi lists Museum Entry, Golf Cart,
>   Kayak, Birthday Party and Fireworks Show as bookable resources), so querying
>   across all categories would let a kayak rental fire a campground alert. The
>   app's enum: `Nightly=0, DayUse=1, FixedLength=2, PartialSeasonal=3, Rental=4,
>   BackCountry=5`. Note `Nightly` spans campsites AND lodging (cabins, cottages,
>   motel rooms), so a cabin opening can satisfy a watch — deliberate, narrow by
>   resource category if that ever needs changing.
> - **Coordinates come from geocoding the FULL street address**, not the park name.
>   Only WA ships `gpsCoordinates` reliably (136/167); MI has 15, WI and MS none.
>   A complete address ("4235 State Park Rd, Sardis, Mississippi 38666") geocodes
>   unambiguously, unlike RA's name-only attempt that put Allegany in NYC. Rows with
>   neither coords nor a street address are skipped rather than guessed, and every
>   result is bbox-checked against its state before insert.
>
> Synced live: **WA 145, MI 144, WI 54, MS 19 = 362 campgrounds, 0 outside their
> state bbox.** Sync via `npx tsx scripts/run-sync-gtc.ts [WA|MI|WI|MS]`, and
> automatically on the Fly worker (`gtcSyncIfDue`, hourly check / 22h staleness).
>
> **WAF reachability — measured, and it is the INVERSE of UseDirect. Don't build a
> proxy here.**
>
> | From | Reaches Camis? |
> |------|----------------|
> | Residential | yes |
> | **Fly worker** | **yes** — startup probe reads 167 WA locations |
> | **Vercel** | **no** — 403 even with correct headers |
>
> Two separate WAF behaviours, easy to confuse (I conflated them once and drew the
> wrong conclusion):
> - **User-Agent is load-bearing.** A request without a realistic *full* browser UA
>   gets 403 **from any IP, including residential**. `Mozilla/5.0`, `curl/8.5.0`
>   and a bare `fetch()` with no UA all 403; the full Chrome UA string returns 200.
>   A first Fly test used a bare fetch and "proved" Fly was blocked — it wasn't.
>   **When testing this WAF, always send the full UA, or the result is meaningless.**
> - **IP reputation is separate**, and only Vercel fails it.
>
> Consequences, all deliberate:
> - The **worker polls Camis directly** — no proxy, unlike RC. Alerting works.
> - **Vercel asks Fly for search availability.** The worker exposes
>   `POST /gtc/availability` (`worker/http-server.ts`) — shared-secret header, POST
>   only, no DB access, returns booleans and nothing else. The search route batches
>   every GTC campground into one call (`lib/availability/goingtocamp-remote.ts`)
>   and falls back to the direct adapter when `GTC_AVAILABILITY_URL` is unset
>   (local dev on a residential IP). Results cache 90s, which also keeps us under
>   the WAF's burst threshold when a user pans the map. Verified live: Olympia WA
>   returns 45 GTC campgrounds, 0 unknown, 23 available.
> - The **search-path adapter throws** instead of returning `false` on a transport
>   error. `Promise.allSettled` renders a rejection — and a `null` from the worker —
>   as *unknown*; only an explicit `false` renders "Booked — watch it". Returning
>   `false` on failure would stamp that badge on all 362 GTC campgrounds even when
>   sites are free.
>
> **`worker/fly.toml`'s autostop settings are load-bearing.** The app gained an
> `[http_service]` for the endpoint above, and it must not change how the poller
> runs: `auto_stop_machines = "off"` (the poller runs continuously and must never
> be stopped for being idle) and `auto_start_machines = false` (starting the
> standby machine would double the Camis request rate for no benefit). The worker
> app also needed public IPs allocated — it had none as a pure background service.
>
> > **Consequence: a `flyctl deploy` leaves the poller STOPPED. Always start it
> > manually afterward.** The rolling deploy stops each machine to swap the image,
> > and `auto_start_machines = false` means nothing brings it back — flyctl even
> > prints "Machine … reached stopped state" and calls that "a good state", so the
> > deploy *looks* successful while alerting is dead. Observed 2026-07-20: ~60s of
> > downtime before it was caught. After every deploy:
> >
> > ```
> > flyctl status --config worker/fly.toml            # expect one started, one stopped
> > flyctl machine start <primary-id> --config worker/fly.toml
> > flyctl logs --config worker/fly.toml --no-tail    # expect a [poller] heartbeat
> > ```
> >
> > **Start ONE machine only.** There are two; the second is a standby, and starting
> > it doubles the Camis request rate for no benefit (that's the whole reason
> > `auto_start_machines` is false). The primary is whichever ID the pre-deploy logs
> > show heartbeating.
>
> > **A THIRD worker failure mode: "started but network-wedged" → `restart`, not
> > `start`. Now self-healing (2026-07-22).** Distinct from the two above (a *stopped*
> > machine after deploy, and a *hung cycle*): the machine shows `STATE=started`, the
> > Node process is alive and its event loop is running, but the microVM's **egress
> > has wedged** — *every* outbound fetch times out, including Supabase. Signature in
> > the logs: `[RecGov availability] … timeout` **and** `[poller] cycle failed: DB
> > query error: TypeError: fetch failed` (the DB, not just a provider). Because the
> > heartbeat/canary writes are themselves DB calls, they throw too, so every
> > `worker_heartbeat`/`alert_canary` row **freezes at the last moment egress worked**
> > and `/api/health/status` pages `down` with the heartbeat stale and ALL five
> > `detect:*` failing at once — the tell that it's worker-side, not a provider
> > outage (five different backends, two proxy directions, don't fail together). The
> > manual fix is **`flyctl machine restart <primary-id>`** (a `start` is a no-op — it's
> > already "started"); the reboot re-establishes networking. Observed once: ~30 min
> > of silent dead alerting before the pager caught it.
> >
> > **Self-heal (so a human isn't the recovery path):** the poller now runs a
> > **watchdog** (`worker/liveness.ts` + `WATCHDOG_STALE_MS`, default 4 min) that
> > `process.exit(1)`s when no heartbeat has landed in the DB for that long; Fly's
> > `on-failure` restart policy then reboots the VM, same effect as the manual
> > restart. Liveness is marked ONLY on a *successful* `beat()` DB write, so a wedge
> > (write throws) correctly goes stale. `/health` on the worker now reports **503**
> > once stale (was an unconditional `{ok:true}` that stayed green through the wedge),
> > wired to a Fly `[[http_service.checks]]` for visibility — but the watchdog, not
> > the Fly check, is the actual trigger. Threshold is set *below* the route's 5-min
> > `WORKER_STALE` page and *above* the worst legit slow cycle (~2 min under a heavy
> > catalog-sync burst), so it self-heals before paging without false-tripping. **A
> > standing rec.gov `429` / GoingToCamp-timeout throttle on the Fly egress IP is a
> > SEPARATE, external thing** — clean provider-side rate-limits, not a wedge; a
> > restart may or may not clear them (the standby shares the region's IP reputation —
> > a **same-region failover does NOT escape a rec.gov throttle; verified 2026-07-22**,
> > both sjc machines 429'd identically), and they usually age out on their own.
> >
> > **A THIRD mode the watchdog is BLIND to — the timeout cascade (observed
> > 2026-07-22, issue #14).** When rec.gov degrades from fast `429`s to slow **10s
> > timeouts**, the hanging connections exhaust the outbound socket pool / starve the
> > event loop, so *every* provider (RA, RC, GoingToCamp) and the `:8080` health server
> > start timing out too (health check **flaps** passing↔failing). But the Supabase
> > `beat()` write still succeeds, so **the heartbeat stays FRESH and the watchdog never
> > fires** — `/api/health/status` shows `worker.heartbeat: ok` with ALL `detect:*`
> > **timing out** (distinct from the full wedge, where the heartbeat freezes too).
> > Alerting is silently dead; only a manual **`flyctl machine restart`** clears it (the
> > fresh process drains the backlog, rec.gov drops back to fast 429s). Durable fix is
> > tracked in **issue #14**: shorter rec.gov timeout, cap concurrent rec.gov in-flight,
> > trip the breaker on timeouts (not just 429s), and key the watchdog off a recent
> > *successful external fetch* rather than just the heartbeat.
>
> **The "Aspira six" — surveyed 2026-07-19, and MI/MS turned out to be Camis.**
> CO/MI/TN/WV/KS/MS do *not* share a backend. After reclassifying MI+MS into
> GoingToCamp above, what actually remains here is small:
> - **TENNESSEE SHIPPED 2026-07-20 — 39 camping parks, live and alerting** (e2e:
>   real opening → email + SMS, verified). **SOUTH CAROLINA SHIPPED 2026-07-22 — 34
>   camping parks (of 50), live and e2e-verified** (real Aiken opening → email + SMS
>   both `sent`, worker deployed with the SC provider; `variant:'html-grid'`, recon in
>   the SC note below).
>   **TN + SC = same stack, but NOT one drop-in adapter — TN has a clean JSON
>   API, SC is an HTML park-grid filter (recon 2026-07-20/22).** Both are
>   Apache + ColdFusion at `reserve.<state>parks.com` (`cfid`/`cftoken`,
>   `CF_CLIENT_TSP_LV` vs `CF_CLIENT_SCP_LV` — differs only by the 3-letter state
>   prefix), same "Reservations | <State> State Parks" title, both behind an AWS ALB.
>   **The `foreupsoftware.com` links on the page are GOLF tee-times only** (`class="btn
>   resBtn golf"`), not camping — a red herring; camping books through the portal.
>
>   **TN is a GoingToCamp-shaped adapter, not an RA one:**
>   - **Catalog** — one GET of the portal landing embeds a JS array
>     `{ name, city, url:'/slug', parkId, lat, lng }` for every park (**coords
>     included — no geocoding**), plus card `data-*` attrs: `data-product`
>     (`"camping,cabins,shelters,programs"` — filter to camping), `data-maxrv`,
>     `data-amp20/30/50`, `data-sewer` for RV/hookup filters.
>   - **Availability — batched JSON, whole-stay native.** GET landing → scrape
>     `#csrfToken` (+ session cookie), then ONE
>     `POST /library/ajax/landingPageAvailability.html` with
>     `fromDate=MM/DD/YYYY & toDate=MM/DD/YYYY & csrfToken` returns
>     `[{ accountKey, templates:[{templateKey, available, total}] }]` for **all parks
>     at once**. **`accountKey === parkId`** (the app stores by accountKey and reads by
>     parkID — same id space), so no join table. `available > 0` on a camping
>     `templateKey` = opening. Range-evaluated in one call → maps to the whole-stay
>     rule natively, like GTC, no per-night intersection.
>   - **Whole-stay: CONFIRMED (residential, 2026-07-20).** The one batched POST at
>     1/3/5 nights from the same start returned shrinking totals (2140 → 1742 → 1686
>     available sites across all parks), the signature of whole-consecutive-stay
>     evaluation. So the adapter does NOT intersect per-night, like GTC. Also: 50 of
>     63 parks appear in the availability response — the other 13 are day-use/no-camping
>     parks that correctly drop out (matches the `data-product` camping filter).
>   - **templateKey legend: DECODED (2026-07-20)** from the app's `templateMap`:
>     `1 = Camping`, `2 = Cabins`, and `4` is present in availability data but NOT in
>     the app's badge map (unlabeled, tiny counts) — deliberately EXCLUDED. The
>     adapter's `CAMPING_TEMPLATE_KEYS = {1, 2}` counts camping + cabins as a hit,
>     mirroring GTC's lodging-inclusive `Nightly`; narrow to `{1}` for campsites-only.
>   - **Reachability: MEASURED 2026-07-20, and it is the SAME direction as UseDirect
>     (Fly blocked, Vercel fine) — the REVERSE of GoingToCamp.** The Fly worker gets
>     `403 on landing` from the portal's WAF (intermittent, and even "successful"
>     landings return empty), while **Vercel and residential reach it fine** (the prod
>     `/api/search` returns real `hasAvailability` for TN parks). The AWS-ALB "should
>     be fine from a datacenter" prior was WRONG — don't trust ALB-vs-Azure to predict
>     WAF IP policy; measure it.
>   - **So the worker routes TN availability through a Vercel proxy**, exactly like
>     UseDirect's `/api/rc-proxy`: `src/app/api/tnsc-availability` does the whole
>     CSRF handshake + batched POST from a Vercel IP and returns parsed rows; the
>     client (`fetchAvailabilityBatch`) calls it when **`TNSC_AVAILABILITY_URL`** is
>     set (Fly worker only) and calls the portal directly otherwise (Vercel routes,
>     residential, the sync). It does the WHOLE batch, not per-request like rc-proxy,
>     because the portal's CSRF token + cookie are session-bound to one IP. Set
>     `TNSC_AVAILABILITY_URL=https://camphawk.app/api/tnsc-availability` on the Fly
>     worker (auth: the shared `SYNC_SECRET`, which the worker already carries).
>   - **GOTCHA that cost real time: a new `SYNC_SECRET`-protected `/api/*` route
>     404s silently until it's in the Clerk middleware allowlist.** `src/middleware.ts`
>     runs `clerkMiddleware` on every `/api/*` (matcher `/(api|trpc)(.*)`), and
>     `auth.protect()` returns **404** (not 401) for any route not in `isPublicRoute`.
>     The proxy route built and deployed fine but 404'd the worker for this reason —
>     the fix was adding `/api/tnsc-availability` next to `/api/rc-proxy` in that list.
>     The route does its own secret check, so this is safe. **Any future worker→Vercel
>     proxy route must be added there too**, or it fails exactly this way: builds green,
>     serves 404, no error anywhere.
>   - **SC RECONNED + SHIPPED 2026-07-22 — and it is NOT TN's JSON path.** The shared
>     ColdFusion backend was the only thing that carried over; SC's front-end is a
>     different shape (`variant:'html-grid'` in `providers.ts`), so it gets its own
>     catalog + availability branch in `client.ts`:
>     - **No parkId, no coords, no address.** The landing renders `.parkGridItem`
>       cards keyed by a **slug** (`data-action="aiken"`) with a display name and
>       `data-camping/lodging/day-use/maxrv/…` flags — nothing else. So SC campgrounds
>       key on the slug (`tnsc-SC-aiken`), and the id parser + availability batch were
>       generalized from `number` parkId to a **string key** to hold both (TN's numeric
>       id still parses, `tnsc-([A-Z]{2})-(.+)`).
>     - **Availability is an HTML grid filter, not JSON.** `POST /library/ajax/getStateWide.html`
>       with `CSRFToken`, `checkin`/`checkout` (padded MM/DD/YYYY), `productKey=4`
>       (camping; 5=lodging, 6=day-use), `stage=2` returns the re-rendered grid
>       containing ONLY parks with a bookable camping site for the whole stay. So a
>       park's **presence == an opening** — a park-level boolean, no per-site count
>       (`availableSites` is a sentinel `1`). Whole-stay (the set shrinks with the
>       range: 33 parks +3d vs 32 +150d, 2026-07-22). **The token is required** — no
>       `CSRFToken` → empty grid.
>     - **camping-only, deliberately.** SC's `productKey=5` "Lodging" bundles lodge
>       rooms + villas with camper cabins (hotel-like), broader than TN's single
>       `Cabins` template, so we don't let it fire a campground alert. `SC_CAMPING_PRODUCT_KEY`
>       in `providers.ts`; set `'4,5'` to include lodging.
>     - **Coords are a CURATED table** (`SC_PARK_COORDS` in `providers.ts`), NOT
>       geocoded. Name-geocoding was tried first and is worthless here: Mapbox has no
>       POI for these parks and collapses `"<name> State Park, South Carolina"` onto a
>       "State Park" **neighborhood in Columbia** — only 5 of 43 resolved, ~20 stacked
>       on that one wrong point (inside the state bbox, so the bbox reject can't catch
>       it). The table is sourced from OpenStreetMap park/protected_area geometries
>       (+ one street-address hit for H. Cooper Black), each verified in the SC bbox.
>       A camping park missing from the table is skipped + logged (fail-loud). So SC
>       needs **no Mapbox token** to sync, unlike an earlier draft of this note.
>     - Reachability is the SAME as TN (Fly blocked, Vercel fine), so SC reuses the
>       existing `/api/tnsc-availability` proxy unchanged — the proxy route keys on
>       `state`, and the wire row now carries `key` instead of `parkId`.
>     - **Still no scheduled sync** (like TN): refresh with `npx tsx scripts/run-sync-tnsc.ts SC`
>       from a residential IP, then **deploy the Fly worker** so it picks up SC watches.
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
> **Bottom line: GoingToCamp (2026-07-19), Tennessee (2026-07-20), and South Carolina
> (2026-07-22) are DONE. What's left is thin and expensive.** SC was the last cheap-ish
> add (it reused TN's backend + proxy). What remains is CO / LA / WV at 1 state each
> (and WV is lodging-only, so really 2), and **each needs a brand-new adapter** — none
> shares an existing backend. Nothing remaining has GoingToCamp's ratio of
> states-to-effort; weigh a new adapter against other work rather than assuming
> coverage is the priority.
>
> **Survey lesson worth keeping: fingerprint by API behaviour, not by domain or
> bundle.** Domain names misled (MI/MS are Camis on vanity hosts), and so did shared
> asset hashes (the "identical chunks" that looked like a private Aspira product were
> just the Camis app). A single `GET /api/resourcelocation` settled it. Also: don't
> match `/edirect/i` — it hits the word "**r**edirect" on every page on the web.

> **Known gap — UseDirect unit catalogs.** For some UseDirect providers (currently
> Florida, Ohio, Illinois, Virginia) the per-facility unit sync comes back empty:
> the `/search/grid` POST that enumerates units hits intermittent CloudFront `403`s
> under the sync's concurrent load. The campground rows still sync (fully searchable
> and watchable) — only the unit-level filter data (site type, RV length) is missing,
> and it accretes over successive nightly worker syncs. Not a code bug; a rate-limit.

> **Reading `sync_log`: a non-null `error` does NOT mean the sync failed.** Every
> sync writes that column when *any single facility* had a problem, so a run that
> imported 478 campgrounds with 478 unit-catalog 403s looks identical to a total
> outage if you only check `error IS NOT NULL`. The admin panel did exactly that and
> showed 20 of 33 sources red while all 33 had synced. **The signal that matters is
> `facilities_synced = 0`**; anything above zero with errors is a partial. Typical
> benign causes: UseDirect grid 403s (above), and parks skipped for missing coords in
> ReserveAmerica/GoingToCamp. `metadata.totalErrors` carries the count.

## The core flow

1. **Search** (`src/app/api/search`) — radius + dates + filters; branches on `source`
   to the right availability adapter.
2. **Watches** — a subscriber watches a booked campground for their dates.
3. **Poller** (`worker/poller.ts`, on Fly, ~15s) — checks every active watch. On an
   opening it dispatches notifications. Branches by source; uses an atomic claim on
   `notification_sent_at` (1-hour re-notify window) so it never double-alerts.
4. **Notifications** (`src/lib/notifications/`) — email (Resend) + SMS (Twilio).

### Flexible dates (feature C — SHIPPED 2026-07-22)

A watch or search can ask for **"any N consecutive nights within [start, end]"**
instead of one fixed stay, optionally **weekends-only** (the run must include a
Saturday night). The columns are `watches.flex_nights` (run length; NULL = a legacy
fixed whole-stay watch, unchanged) and `watches.flex_days` (`'weekend'` | NULL),
added by migration `019`. `flex_nights` NULL everywhere means nothing about existing
watches changed.

`src/lib/availability/flex.ts` is the whole matcher, and it has **two shapes because
the sources split two ways** (the same split as everything else — see the sources
section):

- **Full-grid sources (rec.gov, ReserveCalifornia)** already return every open night,
  so `findQualifyingRun(openNights, nights, days)` scans that set directly for the
  first qualifying run. Near-free and exact — no extra upstream calls.
- **Whole-stay sources (GoingToCamp, ReserveAmerica, TN/SC)** answer one date range at
  a time, so `flexCandidateStays(window, nights, days, cap=40)` enumerates the
  candidate arrival→checkout ranges to probe, **capped at 40**. A wide window +
  short run would otherwise fan out into hundreds of upstream calls per cycle; the cap
  means we check the first 40 candidates this cycle, which is fine because the poller
  re-runs every ~15s. In the poller this is wrapped by `probeFlexStay(watch, probe)`,
  which fixed watches fall through (one probe of their one stay).

> **The alert reports the MATCHED run, not the window.** For a flexible watch the
> poller computes `matchStart`/`matchEnd` from the run it found and uses those for the
> alert dates, the `#camphawk`/`#camphawk-rc` fragments, and every deep link — never
> the watch's whole `[start_date, end_date]`. A "your Sat–Sun is open" alert that
> deep-linked to the 7-day window would be a lie the booking page wouldn't honor.

> **Flexible rec.gov watches deliberately SKIP Campflare** (`api/watches` gates it on
> `!isFlex`). Campflare monitors one fixed range per arrival and can't express a
> window or a weekend constraint, so a Campflare match could fire a wrong-dates alert.
> The 15s Fly poller enforces the flex spec precisely and is the sole source for flex
> watches — same latency as our ReserveCalifornia watches, slightly slower than
> Campflare's push for *fixed* rec.gov watches. That was the tradeoff to avoid wrong
> alerts; revisit with weekend-aware Campflare ranges if the latency ever matters.

> **Search flex is intentionally looser than watch flex.** `/api/search?flexNights=N`
> just shortens the required run to "any N consecutive nights in the window" (the
> grid-source `hasXInRange` checks already express exactly that); it does **not**
> apply the weekend constraint in the annotation, since search is discovery and the
> watch is what enforces the precise spec. UI is a "Flexible dates" checkbox in
> `SearchBar` (nights + weekends), threaded through `page` → `CampgroundCard` →
> `WatchButton` so a watch created from flexible results inherits the spec.

### Alert-health canary (feature A — SHIPPED, monitoring)

`worker/canary.ts` runs inside the poller (the real production vantage point, so it
exercises the same proxy paths as live alerting) and stamps the `alert_canary` table
(migration `016`). `/api/health/status` reads those rows and turns them into
`ok` / `degraded` (200) / `down` (503) for an external uptime monitor to page on.
Two layers, both using the **throwing** fetch functions — never the error-swallowing
`find*Open` helpers, which return null on a transport failure and would let a dead
source path pass the canary:

1. **detect:<source>** — one real availability/catalog fetch per source succeeded.
   Cheap (no send), so it runs every `CANARY_DETECT_INTERVAL_MS` (120s).
2. **delivery:email / delivery:sms** — Resend/Twilio actually **accepted** a synthetic
   send to `CANARY_EMAIL` / `CANARY_PHONE` (proves the last mile, not just detection).

> **The SMS delivery canary is the highest-value one, not disposable.** SMS is both
> the primary channel users act on and the one that fails *silently* (A2P suspension,
> Twilio balance, carrier filtering); email via Resend rarely breaks and fails loudly.
> An email-only canary literally cannot detect a Twilio outage. So keep the SMS leg —
> it's cheap to run infrequently. Pinned to **daily** (`CANARY_DELIVERY_INTERVAL_MS`
> in `worker/fly.toml`), which still catches an outage well within a useful window at
> ~1/4 the 6h-default cost.

> **The delivery canary self-throttles across restarts, and MUST — the poller calls
> it once on every boot.** That immediate call exists so it fires soon after first
> setup, but without a guard every deploy/restart would send a real SMS. It cost the
> operator a burst of texts on 2026-07-22 (several worker deploys in one afternoon,
> one text each). `runDeliveryCanary` now checks the last real delivery attempt in
> `alert_canary` and skips if one ran within ~90% of the interval, so N reboots inside
> one interval send once. The scheduled interval tick is always older than the
> interval, so it still proceeds. Detection's immediate boot run is fine — it sends
> nothing. (A single canary phone that is also a real user's number is fine; if you
> ever want canary and real alerts to look different, point `CANARY_PHONE` elsewhere.)

### Cancellation-likelihood (feature E — SHIPPED 2026-07-22)

"This site had a bookable opening on ~X% of recent checks for a stay this far out."
The product already polls availability constantly; E stops throwing that observation
away and turns it into a differentiator. Four parts, split so the number is only ever
shown once it's **honest**:

1. **Recorder** (`worker/poller.ts`, `recordObservations`) — every cycle already knows
   whether each watched window has a whole-stay opening; it now appends that to
   `availability_observations` (migration `020`): one row = (campground, arrival,
   nights, `lead_days`, `had_opening`) at a point in time. **Self-throttled to ≤1 row
   per window per `OBSERVATION_INTERVAL_MS` (1h)** — 15s detection granularity would
   write millions of near-dup rows/day. Best-effort: every failure is swallowed so it
   can never touch alerting, and it degrades to a no-op if migration 020 isn't applied.
   A 90-day retention prune runs every 6h.
2. **Probe roster** (`probeRosterIfDue`, `probe_targets` migration `021`) — the recorder
   only sees campgrounds someone watches, so a curated roster of **high-demand** sites
   is probed hourly at fixed lead-times (`PROBE_LEAD_DAYS=14,45`, snapped to the next
   Saturday → weekend demand) for a 2-night stay, writing the same rows. "High demand"
   is set by `scripts/seed-probe-targets.ts`, which demand-scans a broad sample and
   keeps the ones **booked solid** on a peak weekend (a site that's always open has no
   cancellation signal). Seeded for **rec.gov (150) + ReserveCalifornia (120)** so far
   — CA state parks are the highest-demand, highest-cancellation sites (the scan found
   ~75% booked solid). The poller's probe path is source-agnostic, so broadening is
   pure seeding: `seed-probe-targets.ts --source=<source>` (rec.gov is datacenter-clean;
   UseDirect routes through the agent proxy, so add `NODE_USE_ENV_PROXY=1`).
3. **Aggregation** (`src/lib/likelihood.ts`, server-only) — reads the time series into
   an opening rate, **always bucketed on `lead_days`** (`LEAD_BUCKETS`: a site 3 days
   out vs 45 days out is a different game — never blend them) over a trailing window,
   gated on a **minimum sample count** (`enough`). `getOpeningRate` (one lead-window,
   for a per-watch number later), `campgroundBuckets` (the full ladder, detail page),
   `getHeadlines(ids)` (one batched query for a whole search page → each campground's
   best-sampled `enough` bucket, absent when none qualify).
4. **UI** — search attaches a `likelihood` headline to each result (best-effort, never
   fails a search); `CampgroundCard` shows a positive-framed pill ("Frequent openings"
   / "Opens up sometimes" / "Rarely opens up") with a precise-% tooltip. The detail
   page's "How often it opens up" card (`/api/likelihood`, public) renders the per-lead
   ladder, a "still learning" note while buckets are thin, and **hides entirely** for a
   site with no history.

> **The honesty gate is the whole point — don't lower it to make the UI look alive.**
> `minSamples` (default 20) is why nothing showed the day E launched: at 1 sample per
> bucket per hour, roster sites cross the gate in ~a day, and only then does a badge or
> bar appear. Showing a rate off 3 samples would be worse than showing nothing.

> **Sanity-check with the readout, not by eyeballing prod.**
> `NODE_USE_ENV_PROXY=1 npx tsx scripts/likelihood-readout.mts` prints corpus size,
> accrual/hr, `lead_days`/nights/source spread, and per-bucket + per-campground rates.
> Healthy launch-day signature: ~300 rows/hr (150 targets × 2 leads), leads clustering
> at **17** (14→next Sat) and **45**, nights=2, ~9% overall open rate (believable for a
> booked-solid roster; 0% would mean the demand scan picked sites that never open).

> **Remaining to broaden (not blockers):** roster covers rec.gov + ReserveCalifornia;
> other UseDirect states and GoingToCamp could be seeded next (GoingToCamp would need a
> reachable checker in the seed's `isOpenInRange`, since Camis blocks datacenter IPs).
> The signal still needs a few weeks of history before the longer-lead buckets are dense.
> (Per-watch odds, card badge, and detail ladder are all wired.)

### Booking links — how specific each provider lets us be

`src/lib/booking-url.ts` is the one place that turns campground + site + date into a
URL, shared by the alert dispatch and the detail-page availability calendar so a
link never gets more specific in one place than the other. **Only add a parameter
you have watched take effect** — a link that looks dated but silently lands on a
generic page is worse than an honest generic one, because the alert promises dates
the page doesn't honor.

- **Recreation.gov — site yes, date NO. Measured 2026-07-19; don't re-probe.**
  `/camping/campsites/<campsiteId>` is a real per-site page (rec.gov links to it
  itself). Dates are *not* deep-linkable, verified three ways: `/availability` and
  `?date=` are both stripped back to the bare campground URL; `?checkin=&checkout=`
  survive but never reach the calendar (the bundle maps those from
  `search.checkin_time` — they're the *search* route's params); and the site page
  has no date inputs at all.
- **ReserveAmerica — date yes.** `calarvdate=M/D/YYYY&sitepage=true`.
- **UseDirect / GoingToCamp — unverified, so no params.** Plain reservations URL.

> **The `#camphawk` fragments belong to the poller, not to `booking-url.ts`.** The
> poller emits `…/campsites/<id>#camphawk=<start>_<end>` and
> `…#camphawk-rc=<unitId>_<arrival>_<nights>_<sleepingUnitId>`, which the Chrome
> extension in `extension/` uses to autofill dates and add to cart. Fragments never
> reach the provider's server. Routing those two branches through `booking-url.ts`
> without carrying the fragment would silently strip the autofill.
>
> **They also do nothing on a phone** — extensions don't run in mobile Chrome, which
> is where SMS links get tapped. So for rec.gov the realistic ceiling is "lands on
> the right site, dates not filled in." That's the provider's limit, not a bug.

### Verifying a source actually alerts

"The code path matches the working one" is not verification — the registry-staleness
trap above produces exactly that illusion. `scripts/e2e-gtc-alert.mts` proves it for
real: it creates a watch on a campground that currently *has* availability, waits for
the poller, reports the notification rows, then deletes the watch and its
notifications. **It sends a real email and SMS**, so run it deliberately, never in CI.
Adapt it to another source by swapping the campground query and availability helper.

Two traps it documents, because the first run hit both:
- **Target a real account.** A seeded test user has no deliverable address, so
  dispatch runs and records nothing — which looks like a failure but isn't one.
- **Don't read `notifications` the moment `notification_sent_at` appears.** The
  poller claims that timestamp *before* dispatching, so an immediate read races the
  send and reports a false failure. Wait ~12s.

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
- `autocart_jobs` is also the permanent record of every cart attempt.

> **The lane is gated on a live-bot heartbeat (migration `015`), because the silent
> branch above silently swallowed a real cancellation.** A watch only enters this lane
> when the owner reads `autocart_connected = true` — but that flag goes stale (the
> keepalive is what flips it, and only every 90m). With a dead session still reading
> connected, a hot opening was queued, never carted, and the 35s re-verify found it
> gone → **no alert at all**, while a plain alerter (CampNab) texted the user. Observed
> 2026-07-21 on Silver Lake. Fix: the roster poll (~2s) stamps `autocart_bot_heartbeat`;
> the poller (`isBotOnline`) requires a fresh beat before routing an opening into this
> lane. A stale/absent beat drops those watches onto the **main cadence → immediate
> normal alert**. **Fail-OPEN by contract:** a missing row or a read error counts as
> offline, so we alert rather than swallow — losing auto-carting (everyone gets normal
> alerts) is the acceptable failure, a silent miss is not. So "a re-verify covers an
> offline bot" was wrong twice over: the 35s gamble loses hot sites, and the heartbeat —
> not the re-verify — is what now catches an offline bot.

### The mini-PC bot

- `bot.mjs` — watches the roster, carts openings, reports outcomes; a **keepalive**
  loads an authenticated rec.gov page every **90m** (was 4h — sessions were still
  expiring inside the 4h gap, which is also the window where `autocart_connected`
  reads stale and swallows an opening; see the heartbeat note above) so the session
  never dies from idle.
- `broker.mjs` — a websocket server (exposed via a Cloudflare tunnel at
  broker.camphawk.app) that lets a user do the one-time rec.gov sign-in remotely from
  any device (streams the login page via CDP). No passwords ever touch our servers.
- `recgov.mjs` — the actual add-to-cart, using **real Playwright mouse clicks**.
- `session.mjs` — reliable login detection.
- Enrollment/connection state: `users.autocart_enabled` + `users.autocart_connected`.
  The Watches toggle shows "paused — reconnect" when enabled but not connected.

### Hard-won gotchas (these cost real debugging time)

- **Must run HEADED — *everywhere* that touches rec.gov, not just the cart.** rec.gov
  has an anti-bot gate (a `gate_a` token). Headless Chromium gets flagged
  (`{ok:false, error:"abnormal activity"}`); a real headed browser on the residential
  mini PC passes. A browser window flashes on the mini PC per cart — expected.
  The revert that established this only flipped the *cart* call, leaving the session
  keepalive headless for months; it now runs headed too. If you add another rec.gov
  browser path, default it to headed.
- **Never clear a login on a single login-state read.** The keepalive is the only
  thing that deletes a ready-marker outside a cart attempt, so a false "logged out"
  there costs the user a re-sign-in — discovered, painfully, on a *missed
  cancellation*. Two causes conspired: the headless launch above, and
  `recgovLoginState` sampling once at a fixed 3.5s delay, which catches rec.gov's SPA
  mid-hydration while it still shows the logged-out header. `recgovLoginState` now
  polls until the signal settles ('in' returns immediately, 'out' only if it holds),
  and the keepalive additionally requires a second confirming read before clearing.
  **'unknown' must never clear anything** — that's what it's for.
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

GoingToCamp search (`GTC_AVAILABILITY_URL` on Vercel → the Fly worker endpoint;
authenticated with `SYNC_SECRET`, which the worker app now also carries),
TN/SC availability (`TNSC_AVAILABILITY_URL` on the **Fly worker** → the Vercel
`/api/tnsc-availability` route — the OPPOSITE direction from GTC, because the
portal blocks Fly and allows Vercel; also `SYNC_SECRET`-authenticated),
Supabase (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), Clerk
(`NEXT_PUBLIC_CLERK_*`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`), Stripe
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_MONTHLY/_YEARLY`),
Resend (`RESEND_API_KEY`, `EMAIL_FROM`), Twilio (`TWILIO_*`), Mapbox
(`NEXT_PUBLIC_MAPBOX_TOKEN`), RIDB (`RIDB_API_KEY`), auto-cart
(`AUTOCART_TOKEN`, `BROKER_WS_URL`), `NEXT_PUBLIC_APP_URL`, `SYNC_SECRET`.
Alert-health canary (on the **Fly worker**): `CANARY_EMAIL` / `CANARY_PHONE` —
the dedicated sink the delivery canary sends synthetic alerts to (unset = that
leg records "skipped", a warn not a page); `CANARY_DELIVERY_INTERVAL_MS` and
`CANARY_DETECT_INTERVAL_MS` — cadences, both non-secret and declared in
`worker/fly.toml [env]` (delivery defaults to 6h in code, pinned to 24h there).
Cancellation-likelihood (feature E, on the **Fly worker**, all non-secret with
in-code defaults — override only to tune): `OBSERVATION_INTERVAL_MS` (per-window
record throttle, 1h), `OBSERVATION_RETENTION_DAYS` (90), `PROBE_INTERVAL_MS`
(roster cadence, 1h), `PROBE_LEAD_DAYS` (`14,45`), `PROBE_NIGHTS` (2).
The mini-PC bot has its own `.env` (`AUTOCART_TOKEN`, `LOGIN_MODE=remote`,
`BROKER_PORT`, `POLL_MS`).

> **`NEXT_PUBLIC_*` vars are inlined at BUILD time, so a bad value lies dormant
> until someone triggers a build — and then looks like that day's code broke it.**
> This cost real debugging time on 2026-07-20: a third-party integration (v0) had
> written its own Clerk **development** keys into Vercel Production. Nothing changed
> until an unrelated push rebuilt the site, which baked in the dev publishable key
> and pointed camphawk.app at a Clerk dev instance — a *separate user table*. The
> symptoms pointed everywhere but the real cause: the account looked signed in
> (Clerk worked fine, just the wrong instance), the Admin button still showed
> (it's a client-side email check, no DB), the subscription read as never-subscribed,
> and every watch vanished — because the watches fetch is gated on `isSubscribed`,
> so one failed lookup hides them all. Only the Clerk handshake URL
> (`*.clerk.accounts.dev`, a dev hostname) revealed it.
>
> Lessons worth keeping:
> - **When auth or subscription state goes strange, check the Clerk hostname first.**
>   Production is the camphawk.app instance; anything `*.clerk.accounts.dev` with a
>   random animal name is a dev instance and its users are a different table.
> - **Ask what changed in the environment before theorizing about the code.** The
>   push that "caused" it only triggered a rebuild.
> - **`/api/subscription/status` is the fastest probe.** `active:false,
>   everSubscribed:false` on a known subscriber means wrong identity, not lost data.
> - **Live vs test keys must be checked in pairs.** Clerk failed loudly; Stripe would
>   not — a `sk_test_` key in Production accepts checkouts and takes no money.
> - The client masks failures: `r.ok ? await r.json() : { active: false }` renders a
>   500 identically to a genuine non-subscriber. Same shape as the `sync_log` trap.
> - **Direction matters — dev keys in the v0 *preview* are fine and in fact required.**
>   v0's preview crash-loops without Clerk keys (`<ClerkProvider>` and `clerkMiddleware`
>   both throw), so its env needs a matched dev-instance `pk_test_`/`sk_test_` pair —
>   see `docs/SETUP.md` ("Front-end changes via v0"). That's safe because it never
>   touches Production. The outage above was the *opposite* direction: dev keys landing
>   in Vercel **Production**. Keep the two apart and never let v0 sync env to prod.
>
> Vercel's env-var **"Last Updated"** column is how you find what an integration
> touched. Note `AUTOCART_TOKEN`, `SYNC_SECRET` and `GTC_AVAILABILITY_URL` are *our
> own* shared secrets, not vendor-issued — they must match the mini PC's `.env` and
> the Fly worker, so copy from those sides rather than generating fresh values.

## Deploy targets

See `docs/SETUP.md`. Short version: website auto-deploys on `git push`; the Fly worker
deploys via `flyctl` **and must then be started by hand** (see the autostop note
above — the deploy leaves it stopped and alerting silently dead); the mini-PC bot
updates via `git push` + `update.bat` on the box.
