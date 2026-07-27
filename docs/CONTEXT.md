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
>
> **FRONT-END REWRITE SHIPPED 2026-07-27.** The whole UI was rebuilt on a new
> design system and swapped over the live routes; the old pages and components are
> deleted. See "The front end" below for the route map and what changed. If you are
> reading old commentary elsewhere in this file that mentions `SearchBar`,
> `WatchesPanel`, `SubscribeGate`, `CampgroundCard` or `/v2`, it predates the swap —
> those files are gone.

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
- **Resend** (email) + **Twilio** (SMS, A2P-approved) + **FCM** (native push, HTTP v1;
  relays to APNs for iOS) — the three alert channels.
- **Mapbox** — geocoding + maps.
- A **mini PC** (Windows, always-on, residential IP) — hosts the auto-cart bot.
- **Capacitor** — the iOS/Android app is a thin native shell around the live site
  (`server.url = camphawk.app`), so the whole Next stack runs unchanged and web deploys
  reach the app instantly. Only push + the store-billing flag are native. Firebase
  project `campapp-39c4b`. See "Native mobile app" below and `docs/SETUP.md` for the
  build; `ios/`/`android/` are generated locally and git-ignored.

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
> > fresh process drains the backlog, rec.gov drops back to fast 429s).
> >
> > **Partially mitigated 2026-07-22 (commit `dfd4541`) — two of the four issue-#14
> > items shipped:** (1) the six per-source fetch phases now run **concurrently**
> > (`Promise.all` in `worker/poller.ts cycle()`) instead of sequentially, so a
> > slow/throttled rec.gov phase no longer head-of-line-blocks RC/RA/GTC/TN-SC —
> > cycle time is `max(phase)`, not `sum(phase)`, and the other sources keep detecting
> > at full speed. (2) A process-local **rec.gov throttle breaker** in
> > `src/lib/availability/recgov.ts` OPENs after `RECGOV_BREAKER_TRIP` (default 3)
> > consecutive throttle failures — counting **both 429 AND timeout** (issue-#14 item
> > "trip the breaker on timeouts") — and short-circuits `getAvailabilityFromRecGov`
> > to empty (no network, no 10s stall) for `RECGOV_BREAKER_COOLDOWN_MS` (default 60s),
> > with a half-open probe that closes it on the next success. Empty during cooldown is
> > the same result the storm already produced, so detection loses nothing; the cycle
> > stays fast and we stop feeding the ban. Per-process state, so it only trips in the
> > throttled Fly worker, never Vercel search on its own IP.
> >
> > **The last two issue-#14 items SHIPPED 2026-07-24 — the cascade is now bounded and
> > self-healing:** (1) the rec.gov request timeout is no longer a hardcoded 10s — it's
> > `RECGOV_TIMEOUT_MS` (default **5s**), so a hung socket lives half as long and the
> > breaker (which counts timeouts) opens far sooner, keeping the socket pool from
> > starving. Env-tunable so it can be relaxed if legit responses ever need longer.
> > (2) The self-heal watchdog now has a **second trip keyed off external egress**, not
> > just the heartbeat: `markExternalFetchOk()` (`worker/liveness.ts`) is stamped
> > whenever ANY detection-canary source succeeds, and the poller reboots the VM if no
> > external fetch has landed for `WATCHDOG_EXTERNAL_STALE_MS` (default **6 min**)
> > **even while the heartbeat is fresh** — exactly the cascade's signature. Because it
> > stays fresh as long as *one* source is reachable, a rec.gov-only throttle does NOT
> > trip it (a reboot wouldn't clear an IP throttle anyway); only an all-sources-down
> > stretch does. The worker's `/health` now 503s on this too (reports
> > `externalFetchAgeMs`), so the Fly check + uptime monitor see the cascade the fresh
> > heartbeat used to hide.
> >
> > **The FLAPPING wedge (observed 2026-07-24) needed a second trip.** A recurrence in
> > `sjc` degraded egress so ~all detects timed out at 25s, but the *occasional* source
> > succeeding kept `msSinceExternalFetchOk` under the 6-min staleness bar, so the
> > staleness watchdog above never fired — a human had to `flyctl machine restart`. Fix:
> > a **failure-rate** trip alongside staleness. Every detect-canary outcome (pass AND
> > fail) is now recorded (`markExternalFetchResult`), and the watchdog also reboots when,
> > over `WATCHDOG_EXTERNAL_WINDOW_MS` (5 min), there were ≥ `WATCHDOG_EXTERNAL_MIN_ATTEMPTS`
> > (6) probes and ≥ `WATCHDOG_EXTERNAL_MAX_FAIL_RATIO` (0.8) of them failed
> > (`externalFetchWedged` in `worker/liveness.ts`). The 80%-of-≥6 bar clears a rec.gov
> > throttle + one flaky source (≤40% fail) but trips on a worker-wide wedge — now
> > automatic, no human restart.
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

## The front end

Rewritten and swapped over the live routes on 2026-07-27. Presentation only — no
data layer, API contract or bot logic changed in the rewrite.

### Route map

Everything under `src/app/(app)/` is a **route group**: it supplies the shared
chrome (nav, brand backdrop, footer) without adding a path segment.

| Route | File | Notes |
| --- | --- | --- |
| `/` | `(app)/page.tsx` | Marketing home. **Server-rendered** — carries the site `<h1>`, indexable. Only the pricing controls are client-side. |
| `/search` | `(app)/search/page.tsx` | Explore: location + dates + filters + map. The free funnel. |
| `/watches` | `(app)/watches/` | Watch list, quota, outage banner, alert history. |
| `/new` | `(app)/new/` | The only place a watch is created. |
| `/settings` | `(app)/settings/` | Alerts (SMS), auto-cart, subscription, account, admin link. |
| `/campground/<id>` | `(app)/campground/[id]/` | **Server-rendered** detail + per-page metadata + JSON-LD. |
| `/manage/<token>` | `(app)/manage/[token]/` | Token-authorised per-watch manage. `manageLink()` has always emitted this path, so links already in the wild land here. |
| `/camping`, `/camping/<state>` | `app/camping/` | SEO landing pages. **Outside** the group — own breadcrumb chrome. |

Outside the group and deliberately without app chrome: `/terms`, `/privacy`,
`/connect`, `/admin`, `/sign-in`, `/sign-up`, `/w/<token>`, `/b/<token>`,
`/auto-cart`, `/sms-opt-in`.

### Design system

`--ch-*` tokens in `src/app/globals.css`, in a second `@theme` block that is purely
ADDITIVE — it was written that way so the rewrite could run beside the old UI
without touching it. Fonts are Bitter (display) + Nunito Sans (body). Primitives
live in `src/components/ui/`, screens in `src/components/v2/`.

> **The stock Tailwind colour overrides are GONE (2026-07-27).** `globals.css` used
> to redefine `--color-green-*` / `--color-gray-*` / `--color-amber-*` /
> `--color-blue-*` so the pre-rewrite UI picked up the brand palette. The 13 files
> still on those scales (sign-in, sign-up, terms, privacy, sms-opt-in, auto-cart,
> `/w/<token>`, error, not-found, `Logo`, `SmsOptIn`, `BetaTesters`,
> `AdminAutoRefresh`) were converted to `ch-*` tokens and the overrides deleted, so
> `--ch-*` is now the only palette. **Consequence: a new `bg-green-600` resolves to
> STOCK Tailwind green, not CampHawk green** — use a `ch-*` token.

### Things that will bite you

- **A route not in `isPublicRoute` (`src/middleware.ts`) 404s**, because Clerk's
  `auth.protect()` returns 404 rather than 401. `/search`, `/watches`, `/settings`
  and `/new` are all listed. `/new` is listed **deliberately**: the New watch screen
  handles its own 401 with a message that keeps the campground, dates and filters
  already entered, and letting middleware intercept would throw that away.
- **`robots` is set per page, not in the layout.** The layout carried a `noindex`
  during the dark launch and removing it is what made the campground SEO work count.
  `/` and `/search` are indexable; `/watches`, `/settings`, `/new` are not; and
  `/manage/<token>` is `noindex, nocache` because **the URL contains the token that
  authorises managing the watch** — a token in the index is a token anyone can use.
- **Watch creation is gated in exactly one component**, `v2/WatchCta.tsx`, backed by
  `v2/useSubscription.ts`. A failed status lookup is tracked as `unknown` and stays
  neutral rather than telling a paying subscriber to subscribe. Same rule in
  `v2/Pricing.tsx`. Both render no price in the native app.
- **Provider descriptions are HTML** — 4,469 of the 8,013 catalog rows. Render them
  through `v2/richText.tsx`, which parses to blocks and emits text. Never
  `dangerouslySetInnerHTML`: it is untrusted third-party markup.
- **Campground `photos` is `[]` on every row.** The photo strip, `og:image` and
  JSON-LD `image` therefore never render. That's an ingest bug, not a UI one.

## SEO

Added 2026-07-27, and mostly inert until the route swap lifted the layout `noindex`.

- **Campground pages are server-rendered** with `generateMetadata` per campground.
  Before this they were client components fetching in `useEffect`, so a crawler got a
  loading skeleton and all 8,013 shared the root layout's title.
- **`src/lib/seo.ts`** builds titles, descriptions and canonicals. Titles shorten by
  dropping PARTS (place, then qualifier) rather than clamping the end — a plain clamp
  truncated long names into *identical* strings, reintroducing the duplication the
  file exists to fix.
- **`src/lib/jsonld.ts`** — `Campground`, `BreadcrumbList`, `Organization`. Every
  field is omitted when absent, and there is deliberately no `aggregateRating` or
  `priceRange`: we have neither and inventing them earns a manual action. No
  `FAQPage` either — Google restricted those rich results to government and health
  sites in 2023.
- **`/camping/<state>`** landing pages (47 states, min 5 campgrounds each — below
  that a page is a doorway page, which is a penalty). They also give the 7,000
  campground pages an internal-linking parent; the only link into `/camping` is in
  the signed-out footer, so don't delete it.
- **Sitemap** is dynamic (~7,387 URLs) and degrades to the three static pages if the
  DB query fails, because a sitemap that 500s teaches Google to stop asking.
- **`npx tsx scripts/seo-check.mts`** (needs `NODE_USE_ENV_PROXY=1`) guards the three
  failure modes that break nothing visible: the page silently reverting to
  client-rendered, titles colliding, and structured data claiming things we don't have.

## The core flow

1. **Search** (`src/app/api/search`) — radius + dates + filters; branches on `source`
   to the right availability adapter.
2. **Watches** — a subscriber watches a booked campground for their dates.
3. **Poller** (`worker/poller.ts`, on Fly, ~15s) — checks every active watch. On an
   opening it dispatches notifications. Branches by source; uses an atomic claim on
   `notification_sent_at` (1-hour re-notify window) so it never double-alerts.
4. **Notifications** (`src/lib/notifications/`) — email (Resend) + SMS (Twilio) + native
   push (FCM). `dispatchNotifications` fans out to all three via `Promise.allSettled`;
   push goes to a user's registered devices (`push_tokens`, migration 023) and no-ops
   when `FCM_SERVICE_ACCOUNT` is unset. See "Native mobile app" below.

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
> watch is what enforces the precise spec. UI is the **Flexible** chip on `/search`,
> which reveals `ui/NightsPicker` (how many consecutive nights) alongside the date
> range (the window to hunt inside) — the same two controls the New watch screen
> mounts, so a watch created from flexible results inherits the spec.

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
3. **delivery:push** — the FCM service account still mints an access token
   (`verifyPushCredential` in `src/lib/notifications/push.ts`). No synthetic send (there's
   no canary device), but this catches the push last mile failing silently if
   `FCM_SERVICE_ACCOUNT` is removed/malformed or the key is revoked. Skipped (warn, not
   page) until FCM is configured, like the other two. Also listed in the `/api/health/status`
   delivery loop, so it pages the same way.

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
   cancellation signal). Seeded (2026-07-25) to **502 active**: rec.gov (150) +
   ReserveCalifornia (120) + ~207 across the 9 other UseDirect states (OH, MN, IL, VA,
   FL, MO, WY, NV, AZ; ~25 each) + GoingToCamp (25). The poller's probe path is
   source-agnostic, so broadening is pure seeding:
   `seed-probe-targets.ts --source=<source>` (rec.gov is datacenter-clean; **UseDirect
   AND GoingToCamp** route through the agent proxy, so add `NODE_USE_ENV_PROXY=1` —
   the seed's `isOpenInRange` now dispatches all three families, GTC via the direct
   Camis checker, which the agent proxy / Fly can reach even though Vercel IPs can't).
   > **The roster is PACED, not bursted (fixed 2026-07-26).** Firing all ~300 rec.gov
   > probes (150 targets × 2 leads) at once each hour from the single Fly IP tripped
   > rec.gov's **per-IP rate limit** → a `429` storm that starved the socket pool and
   > cascaded to GTC/RA timeouts (a real "down" incident; the breaker bounded it but
   > didn't prevent it). `probeRosterIfDue` now flattens targets×windows, **shuffles**
   > (so one source doesn't run back-to-back), and dispatches through `pacedForEach` at a
   > steady jittered rate spread over `PROBE_SPREAD_FRACTION` of the interval — a few
   > requests/min per source. Symptom that means "throttled again, widen the spread":
   > `429`/`timeout` on rec.gov + detect canaries timing out while the heartbeat stays
   > fresh (only the direct-from-Fly sources; RC/TNSC via the Vercel proxy stay green).
3. **Aggregation** (`src/lib/likelihood.ts`, server-only) — reads the time series into
   an opening rate, **always bucketed on `lead_days`** (`LEAD_BUCKETS`: a site 3 days
   out vs 45 days out is a different game — never blend them) over a trailing window,
   gated on a **minimum sample count** (`enough`). `getOpeningRate` (one lead-window,
   for a per-watch number later), `campgroundBuckets` (the full ladder, detail page),
   `getHeadlines(ids)` (one batched query for a whole search page → each campground's
   best-sampled `enough` bucket, absent when none qualify).
4. **UI** — search attaches a `likelihood` headline to each result (best-effort, never
   fails a search); the result card shows a positive-framed pill ("Frequent openings"
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
> Healthy signature: ~1,000 rows/hr (502 targets × 2 leads), leads clustering at **17**
> (14→next Sat) and **45**, nights=2, low-but-nonzero overall open rate (believable for
> a booked-solid roster; 0% would mean the demand scan picked sites that never open).

> **Broadened 2026-07-25:** roster now spans rec.gov + all 10 UseDirect states +
> GoingToCamp (the GTC checker was the one thing the seed lacked; added via the direct
> Camis checker, reachable from the agent proxy / Fly). Could broaden *further* — more
> targets per state, or GTC provinces — but coverage is national now. The signal still
> needs a few weeks of history before the longer-lead buckets are dense.

> **⏸ THE DISPLAY IS PAUSED (2026-07-23) — data collection is NOT.** All three UI
> surfaces (per-watch "% chance for your dates" on the watch card, result-card badge,
> and the detail-page "How often it opens up" ladder) are hidden for now: with limited
> history too many read a discouraging **0% / "rarely opens up"**, which lands as "no
> hope" rather than "not enough data yet". The recorder/aggregation/APIs are untouched
> and still accruing, so restoring is cheap — the detail ladder is behind a
> `SHOW_LIKELIHOOD: boolean` flag in `campground/[id]/page.tsx` (grep `SHOW_LIKELIHOOD`);
> the Watches-panel and card blocks were commented out (grep `is hidden`). Bring all
> three back together once the longer-lead buckets are dense.

### Per-watch manage page + alert action links (feature D, reworked 2026-07-23)

The old alert-SMS tail of two one-tap links (`Mute <site>: …  Stop: …`) is collapsed
into **one `Manage:` link** to a per-watch manage page. Email keeps the richer footer
(separate Mute/Stop links via `mintActionLinks`).

- **Page** `/manage/<token>` + **API** `/api/manage/<token>` — authorized by a stable
  `manage` `action_tokens` row (`manageUrlFor` / `resolveManageToken`), the same
  magic-link model as the `/w/` links, so a tapped SMS opens it with **no login**. Both
  routes are in `isPublicRoute`. GET returns the watch + its alert history (from the
  `notifications` table) + the campground's **full** site list (fetched client-side from
  the existing `/api/campgrounds/<id>/availability`, so it works for rec.gov AND
  ReserveCalifornia — RC returns `String(UnitId)` sites, same shape). POST does
  `stop` / `resume` / `mute` / `unmute` / `remove`, each scoped to the token's watch.
  The `manage_url` is also returned per watch by `/api/watches` for the Watches panel.
- **Muting a site turns off BOTH alerts AND auto-cart for that site — no separate
  control.** Both the alert path and the auto-cart-job path run through
  `availableDatesForWatch()` (rec.gov) / `findRCOpenUnit()` (RC), which skip
  `muted_site_ids`; the bot only carts poller-created `autocart_jobs`, so a muted site
  never produces a job and is never carted. (There is intentionally NO per-site
  auto-cart column — mute is the single lever.)
- **No campsite-map embed exists.** Providers don't expose per-site coordinates and
  RIDB stores no map media, so the manage page links out to the booking site's own
  campsite map (`recreation.gov/camping/campgrounds/<id>`) rather than drawing one.

### Booking links — how specific each provider lets us be

`src/lib/booking-url.ts` is the one place that turns campground + site + date into a
URL, shared by the alert dispatch and the detail-page availability calendar so a
link never gets more specific in one place than the other. **Only add a parameter
you have watched take effect** — a link that looks dated but silently lands on a
generic page is worse than an honest generic one, because the alert promises dates
the page doesn't honor.

> **The availability calendar is `src/components/AvailabilityCalendar.tsx`** (extracted
> from the detail page 2026-07-25 so it can be unit-tested / screenshotted — see the
> `avail-usedirect` preset in `scripts/screenshot-component.mts`). Tapping an open day
> reveals the **per-site picker for rec.gov AND UseDirect** (both return per-site
> availability; the gate is `source === 'ridb' || reservecalifornia || *stateparks`).
> rec.gov sites get their verified per-site deep link; UseDirect sites are listed by
> name but share the one park/facility link (RC has no per-unit deep link) — honest
> about what each provider allows, per the table below.

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

### Native mobile app (Capacitor + FCM push — backend SHIPPED 2026-07-24; Android app builds + runs on the emulator 2026-07-25)

The iOS/Android app is a **thin Capacitor shell** around the live site
(`capacitor.config.ts`, `server.url = https://camphawk.app`): the webview loads
production, so Clerk/Stripe/SSR run unchanged and a web deploy reaches the app instantly
with no store release. Only two things are actually native — **push** and the
**store-billing flag**. The native projects (`ios/`, `android/`) are generated locally
with `npx cap add` and are git-ignored; see `docs/SETUP.md` for the build + account
steps (Firebase project `campapp-39c4b`).

- **Push is a third alert channel** next to email/SMS, dispatched by the SAME
  `dispatchNotifications` (`src/lib/notifications/index.ts`) — no poller call sites
  changed. `src/lib/notifications/push.ts` sends via **FCM HTTP v1** (one integration
  for both platforms; FCM relays to APNs for iOS), minting an OAuth2 token from the
  service account with `jsonwebtoken` and caching it. Device tokens live in `push_tokens`
  (migration 023), registered by the app via `POST /api/user/push-token` (Clerk-authed;
  the webview carries the session cookie). Dead tokens are pruned on send. **No-ops when
  `FCM_SERVICE_ACCOUNT` is unset** (mirrors Twilio), so it's safe everywhere. The app-side
  bridge is `src/components/NativeBridge.tsx` (no-op on web; requests permission,
  registers the token, deep-links on notification tap). A `delivery:push` canary guards
  the credential (see feature A).
- **Store-billing: Stripe stays web-only** (Apple/Google forbid selling a digital sub
  outside their IAP). The app shows no price/buy button — a non-subscriber sees "manage
  at camphawk.app". Enforced by a native flag: Capacitor appends `CampHawkApp` to the
  webview UA, and `NativeAppProvider` (`src/lib/native/context.tsx`) reads it
  **client-side** (`useSyncExternalStore`) and gates `v2/Pricing.tsx` / `v2/WatchCta.tsx`.
  > **The flag is read CLIENT-side, and MUST stay that way.** The first version read the
  > UA in the root layout via `await headers()` for a flash-free server render — which
  > under this build's **Cache Components** model threw at request time and **500'd every
  > page in production** (2026-07-24 outage; `/api/*` stayed up because it has no root
  > layout, and `next build` stayed green because dynamic segments don't run at build).
  > **Never call `headers()`/`cookies()`/`connection()` in the root layout here.** The
  > only cost of client detection is a first-render flash of pricing UI *inside the
  > native app*; web users are never native, so nothing flips.
  >
  > **That flash is why the app opens on `/search`, not `/`** (`server.url =
  > https://camphawk.app/search`, 2026-07-27). `/` is the only page carrying Stripe
  > checkout, so it's the only page where the flash renders prices — one frame, but a
  > reviewer's screenshot is exactly one frame. Not landing there removes it without
  > delaying pricing for real web visitors, which is what a mounted-gate would cost.
  > `V2Nav`'s wordmark points at `/search` in native for the same reason (it was the
  > last route back onto `/`). Push deep-links are relative, so they're unaffected.
- **GATING THE CHECKOUT CONTROL IS NOT GATING THE PRICE.** Two real leaks, both found
  2026-07-27 after the app was seen showing prices:
  - **`/` (the marketing home).** `v2/Pricing.tsx` gated *itself* and swapped its buy
    buttons for "manage at camphawk.app" — but the buttons were the only gated part. The
    `$2.50 a month, or $20 a year` headline, the LAUNCH PRICING chip and the "keep the
    rate you signed up at" line sat in the **server component around it**, ungated, so
    the app rendered a complete pricing panel with the buttons quietly missing from the
    bottom. Fixed by moving the whole block into **`v2/PricingSection.tsx`**, a client
    component that gates the copy *and* the buttons. `/` stays statically rendered.
  - **`/new`.** The "needs a subscription" message is driven by the **server's answer to
    a submit**, so it renders however the user reached the page — `WatchCta` gating the
    entry points didn't cover it.
  What store review objects to is the **price and the steer to an outside purchase**, not
  the button. Any new copy naming a figure goes inside a `useIsNativeApp()` check. Audit
  with `grep -rn '\$[0-9]\|/api/stripe' src/components/ 'src/app/(app)/'` and confirm each
  hit is behind a native branch.
- **A UA-marker check is only as current as the installed binary.** `appendUserAgent` is
  compiled into the app, so a build made before that config shipped detects as *web* and
  every gate above silently fails. Diagnostic: if the app shows the **buy buttons**, not
  just the price, the UA marker is missing and the binary needs rebuilding — gating
  changes on the web won't reach it.
- **Native UI / webview gotchas (from the first Android build, 2026-07-25):**
  - **Edge-to-edge (Android 15+/API 35+):** the webview draws behind the status bar/notch,
    so the header would land in the non-tappable strip. Fixed on the **web** side with CSS
    safe-area insets — `viewportFit:'cover'` (`layout.tsx`) + `padding-top: calc(env(safe-area-inset-top)+…)`
    on `<header>` (`page.tsx`). `@capacitor/status-bar` (`overlaysWebView:false`, dark
    icons) is set too but can't override edge-to-edge alone — the CSS insets are the real
    fix. **NATIVE changes** (config/plugins) need `cap sync` + a rebuild; **WEB changes**
    reach the app on a reload.
  - **Social OAuth (Google) sign-in does NOT work in the webview** — Google blocks OAuth
    in embedded webviews; it bounces to the system browser and errors with a Clerk
    `authorization_invalid`. **FIXED 2026-07-26 by HIDING social sign-in in the native
    app** (email/password only): `AuthPanel` (`src/components/AuthPanel.tsx`) wraps Clerk's
    `<SignIn>`/`<SignUp>` and applies `.native-hide-social` (globals.css, targets Clerk's
    `cl-*` classes) when `useIsNativeApp()`. Web keeps every method. Bonus: this also avoids
    Apple's rule that offering *any* third-party login forces adding Sign in with Apple.
    (A future full-OAuth-through-system-browser is possible but unneeded now.)
  - **"Use my location" HUNG in the iOS webview (fixed 2026-07-26).** `navigator.geolocation`
    never resolves in WKWebView (no HTML5 geolocation, and no error either) — the button
    spun forever. Location lookups now go through **`@capacitor/geolocation`**
    (wrapped in `src/components/v2/geo.ts`)
    (`deviceCoords()`): native plugin on iOS/Android, browser API on web (unchanged there),
    IP fallback on denial. iOS needs the **`NSLocationWhenInUseUsageDescription`** Info.plist
    key (added in CI — `codemagic.yaml`) or iOS silently denies; Android perms come from the
    plugin's manifest merge. NATIVE dep, so it needs a rebuild to reach the app.
  - **iOS input-focus zoom (fixed 2026-07-26):** tapping a search field with font-size < 16px
    made iOS zoom in and never zoom back (results view stuck magnified). globals.css forces
    form controls to 16px on ≤640px screens; desktop keeps the smaller sizes. Web-side fix.
- **Branded icons + splash (added 2026-07-25):** source images live in `assets/`
  (`icon-only.png` opaque/no-alpha for iOS, `icon-foreground.png`/`icon-background.png`
  for Android adaptive, `splash.png`/`splash-dark.png`), generated from the hawk badge.
  `npm run cap:assets` (= `@capacitor/assets generate --assetPath assets`) expands them
  into `ios/`/`android/` **after `cap add`**. The already-shipped Android build predates
  this, so it still carries Capacitor's placeholder icon — a rebuild with `cap:assets`
  picks up the real one. See `assets/README.md` + `docs/SETUP.md`.
- **iOS: SHIPPED to TestFlight and push works end-to-end (2026-07-26), with NO Mac.**
  Built via **Codemagic** cloud CI (`codemagic.yaml`; full setup + gotchas in
  `docs/SETUP.md` → "iOS builds with NO Mac"). Verified on a real iPhone: app loads,
  email/password sign-in, search, and a **real push notification delivered** (fired via
  `scripts/e2e-gtc-alert.mts` → Fly worker → FCM → APNs). The push fix required switching
  the native bridge to `@capacitor-firebase/messaging` (FCM token, not APNs token) and
  uploading the APNs auth key to Firebase's **Production** slot (the Development-only trap;
  see SETUP.md). Apple Developer enrolled, App Store Connect app + API key done.
- **Android: still emulator-only** — the shipped emulator build predates the push-plugin
  switch, so it **needs a rebuild** with `@capacitor-firebase/messaging` (+ `cap:assets`
  for the branded icon). Register flow worked on the old plugin (1 token landed 2026-07-25).
- **LEFT:** rebuild Android with the new plugin; **Google Play** identity verification (ID
  upload) + **device verification (needs a real Android device — emulator fails Play
  Integrity)**; iOS public App Store submission (screenshots/metadata) when ready — the
  TestFlight track itself is done.

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

### Where the rec.gov credentials live — and how to describe it

**Facts, so the copy stops drifting:**

- **Saving the login is REQUIRED, not optional.** `/connect` disables its submit
  button unless "Save my login" is ticked, and labels it `(required)`. There is no
  session-only mode; every auto-cart user has credentials stored.
- They are stored **encrypted on the mini PC we run** — the always-on Windows box
  that holds the logged-in browser. They never reach Vercel or Supabase.
- Because they're saved, **the bot signs back in by itself** when a session drops.
  A dropped session is a few minutes of paused carting, not an errand for the user.
- `autocart_verified_at` going stale is a **bot-liveness signal, not a login
  lifetime** — `AUTOCART_SESSION_STALE_MS` is 45 minutes (see the fail-open note
  below). "Your sign-in expired" is the wrong thing to tell a user; the true
  framing is "reconnecting", and the manual `/connect` link is a fallback for when
  it doesn't recover.

**One phrasing, everywhere.** Say *"a private machine we run"* and *"never reaches
CampHawk's web servers or database"*. Do **not** say "your own CampHawk server"
(implies the user owns the hardware) or "never uploaded to CampHawk's cloud"
("cloud" sounds reassuring while committing to nothing). Four surfaces carry this
copy and must agree:

| File | Surface |
| --- | --- |
| `src/app/connect/page.tsx` | the sign-in screen itself |
| `src/components/v2/TrustPanel.tsx` | shown when auto-cart is toggled on in New watch |
| `src/components/AutoCartToggle.tsx` | old-UI toggle |
| `src/app/auto-cart/page.tsx` | **public** marketing page |

> **This drifted once already (fixed 2026-07-27).** `/connect` said "your own
> CampHawk server" while `TrustPanel` said "a private machine we run" — a
> contradiction sitting on the exact screen where someone decides whether to hand
> over a password. Worse, `TrustPanel`'s password disclosure was gated behind a
> `savedLogin` prop that `NewWatch` never passed, so the honest block never
> rendered while the block above it told everyone "that's a session, not your
> password". The prop is gone and the disclosure is unconditional. If you edit one
> of the four files above, edit all four.

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
>
> **Second fail-open layer — session freshness (`autocart_verified_at`, migration 022).**
> The heartbeat proves the *bot machine* is alive, but not that the *rec.gov session*
> is. A session can silently die between keepalives while `autocart_connected` still
> reads true, so an opening in that gap still gets swallowed. Fix: the bot stamps
> `users.autocart_verified_at = NOW()` on every sign-in and every keepalive "kept warm"
> (via `POST /api/auto-cart/enrollment` connected=true), and `isAutocartLane` requires
> that stamp to be within `AUTOCART_SESSION_STALE_MS` (default 45m ≈ one 30m keepalive
> + a missed one) on top of `autocart_connected`. A stale or NULL stamp fails open to
> the normal alert lane — same contract as the heartbeat. Shrinking the keepalive to
> 30m bounds the worst-case swallow window; this guard closes it to near-zero.
>
> **Session keeps dying despite the 30m keepalive → saved-login auto-relogin
> (BUILT 2026-07-23).** When the keepalive confirms the session died, the bot now
> re-logs-in on its own from the user's saved credentials instead of forcing a manual
> reconnect. How it's wired, and the guardrails:
> - **Opt-in** via a "Keep me signed in" checkbox on `/connect`; the credentials ride
>   the same encrypted WebSocket to the mini-PC, and `broker.mjs` persists them **only
>   after a confirmed login**.
> - **Encryption** (`credstore.mjs`): Windows **DPAPI, CurrentUser scope** (PowerShell
>   `ProtectedData`; plaintext piped over stdin, never a command line) — decryptable
>   only by the same Windows user on the same box, no key to manage. Non-Windows falls
>   back to AES-256-GCM with a 0600 key (weaker, dev only). Stored in the git-ignored
>   `profiles/<user>/` dir; **never sent to CampHawk servers**.
> - **Auto-relogin** (`recgov-login.mjs` `attemptLoginWithCreds`, shared with the
>   broker): opens the homepage → login modal → fills → waits for a confirmed 'in'.
> - **CAPTCHA/2FA/wrong-password fallback:** any failure → `connected=false` (so the
>   `autocart_verified_at` guard + `/api/health/status` surface it, never silent) and
>   the user is asked to reconnect. Failures are counted; after **2** consecutive fails
>   the saved login is **purged** (`deleteCreds`) to avoid hammering rec.gov / lockout.
> - **Staleness:** the same 30m keepalive that catches a dead session drives the
>   relogin, so a changed password / expired creds get detected and cleared, not left
>   silently broken.
> - **Risk note kept for the record:** a stored password is a reusable master key —
>   bigger blast radius than the scoped, expiring session cookie the profile already
>   holds — and likely against rec.gov ToS. It's owner-only and local-only, but that's
>   the trade being made.

### The mini-PC bot

- `bot.mjs` — watches the roster, carts openings, reports outcomes; a **keepalive**
  loads an authenticated rec.gov page every **30m** (`KEEPALIVE_MS`) so the session
  never dies from idle. Stepped down 4h → 90m → 30m as rec.gov's idle TTL kept
  proving shorter than the refresh gap: on 2026-07-22 a session kept warm at 21:04
  was found dead by the next keepalive at 22:35 (~90m later, confirmed-twice 'out'),
  so the idle TTL is under 90m; 30m refreshes inside any TTL ≳40m. The stale gap is
  also the window where `autocart_connected` reads stale and swallows an opening (see
  the heartbeat note above), so shrinking it shrinks that failure window too.
  **Separately, the mini-PC's Wi-Fi drops out periodically** (cloudflared logged
  DNS/adapter loss — `No DNS servers configured`, `unreachable network` — around
  10:00 and 03:55 UTC on 2026-07-22, both early-morning Pacific), the classic
  Windows Wi-Fi-adapter power-management / sleep signature. It knocks the bot AND the
  broker tunnel offline during those windows, so fix it at the OS: adapter Power
  Management "allow the computer to turn off this device" OFF, sleep = Never, or wire
  to ethernet.
- `broker.mjs` — a websocket server (exposed via a Cloudflare tunnel at
  broker.camphawk.app) that types the user's rec.gov credentials into the mini-PC's
  browser and can stream the live login page via CDP. No passwords ever touch our servers.
  > **`/connect` UX (reworked 2026-07-25):** the primary flow is the credential **form**
  > (native inputs → broker types them in). The live streamed window was clunky on
  > mobile, so it's now reserved for the one case the form can't clear on its own — a
  > **CAPTCHA/2FA challenge**, which the broker signals with a `manual` message. Ordinary
  > failures (wrong password, or the broker never answering) show a "check your
  > credentials and try again" message instead of dropping the user into the stream; the
  > old always-available "use the window instead" opt-in was removed. The broker's
  > streaming capability is unchanged — only the web client's use of it narrowed.
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

## Admin dashboard (`/admin`) + cost tracking

Owner-only, 404 for everyone else. **Redesigned into tabs 2026-07-26, rebuilt on the
ch-* system 2026-07-27.** `src/app/admin/page.tsx` is a server component that fetches
everything (users, subs, MRR via Stripe, watches, alerts, worker heartbeat, canary,
sync_log, cost items, usage) and hands it to a client shell
`src/components/admin/AdminTabs.tsx` — tabs **Overview · Users & Revenue · Engagement ·
System Health · Costs**.

**Who counts as an admin lives in one place: `src/lib/admin.ts`.** It was copy-pasted
into four (the page, `/api/admin/beta`, `/api/admin/costs`, and a hardcoded email in the
old homepage's client code), and one had already drifted — the homepage ignored
`ADMIN_EMAILS` entirely, so a second admin would have got the page but not the link to
it. The module imports `server-only`, so a client component importing it is a build
error rather than a silent leak of the roster into the JS bundle. Client components get
a boolean, never the list. **None of this is the boundary by itself** — `/admin` calls
`notFound()` (404, not 403, so the page's existence isn't revealed) and both API routes
reject before touching data. Hiding a link only tidies the UI.

**A status banner sits above the tabs**, derived from the same worker/canary/sync data
System Health shows. It exists because "is anything broken right now" is the question
the page is opened for, and it used to be behind a tab. It names the failing thing
rather than counting problems, and it **aggregates sync warnings** — they are many (one
per state per provider) and a partial sync is routine, so listing them produced a banner
naming fifteen sources every morning. Canaries are still named individually; they're few
and each is distinct.

**Cost tracking (Costs tab):** two kinds of cost, summarized against MRR for a monthly net.
- **Fixed line items** — editable, DB-backed in `cost_items` (**migration 024**), maintained
  by hand since these providers (Vercel/Fly/Supabase/Clerk/Twilio number/…) have no simple
  billing API. CRUD via `/api/admin/costs` (admin-gated); UI is
  `src/components/admin/CostsPanel.tsx` (inline auto-save). Seeded with the known providers
  at $0 for the operator to fill in.
- **Usage costs** — computed live from `notifications` (SMS/email/push sent this month) ×
  per-unit rates in `src/lib/costs.ts` (`USAGE_RATES`, env-overridable). SMS is the only
  real variable cost; email/push default to $0 (plan/free).

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
Native push (feature: mobile app — on **both** the Fly worker AND Vercel):
`FCM_SERVICE_ACCOUNT` — the full Firebase service-account JSON (Project Settings →
Service accounts → Generate new private key) as a single env string. The worker is the
main push dispatcher (`dispatchPush` in `src/lib/notifications/index.ts` via FCM HTTP
v1); Vercel also needs it for the webhook push path. Unset = push no-ops (logs, like an
unconfigured Twilio). Device tokens live in `push_tokens` (migration 023), registered
via `POST /api/user/push-token`. NOT `NEXT_PUBLIC` — it's a server secret.
Alert-health canary (on the **Fly worker**): `CANARY_EMAIL` / `CANARY_PHONE` —
the dedicated sink the delivery canary sends synthetic alerts to (unset = that
leg records "skipped", a warn not a page); `CANARY_DELIVERY_INTERVAL_MS` and
`CANARY_DETECT_INTERVAL_MS` — cadences, both non-secret and declared in
`worker/fly.toml [env]` (delivery defaults to 6h in code, pinned to 24h there).
Cancellation-likelihood (feature E, on the **Fly worker**, all non-secret with
in-code defaults — override only to tune): `OBSERVATION_INTERVAL_MS` (per-window
record throttle, 1h), `OBSERVATION_RETENTION_DAYS` (90), `PROBE_INTERVAL_MS`
(roster cadence, 1h), `PROBE_LEAD_DAYS` (`14,45`), `PROBE_NIGHTS` (2),
`PROBE_SPREAD_FRACTION` (0.6) and `PROBE_SPREAD_MAX_MS` (45m) — the roster no longer
bursts; probes are shuffled and **paced** (`pacedForEach`) evenly across
`min(interval×fraction, max)` so no source is hit faster than a few requests/min.
Worker resilience tunables (on the **Fly worker**, all non-secret with in-code
defaults): `WATCHDOG_STALE_MS` (self-heal `process.exit(1)` when no heartbeat lands
for this long, 4 min); `WATCHDOG_EXTERNAL_STALE_MS` (second self-heal trip — reboot
when no external provider fetch has succeeded for this long even while the heartbeat is
fresh, i.e. the timeout cascade; 6 min); the **failure-rate** trip that catches a
FLAPPING wedge — `WATCHDOG_EXTERNAL_WINDOW_MS` (rolling window, 5 min),
`WATCHDOG_EXTERNAL_MIN_ATTEMPTS` (min detect probes before it can trip, 6) and
`WATCHDOG_EXTERNAL_MAX_FAIL_RATIO` (reboot when this fraction of probes in the window
failed, 0.8); `RECGOV_TIMEOUT_MS` (per-request rec.gov fetch
timeout, 5s — shortened from 10s so a throttle storm can't starve the socket pool);
rec.gov throttle breaker `RECGOV_BREAKER_TRIP` (consecutive
429/timeout failures that OPEN the breaker, 3) and `RECGOV_BREAKER_COOLDOWN_MS`
(short-circuit-to-empty window before a half-open probe, 60s); `RECGOV_CONCURRENCY`
(per-provider fanout bound within a phase — note the six per-source phases now run
concurrently as of `dfd4541`, so this bounds each provider, not the whole cycle);
`AUTOCART_SESSION_STALE_MS` (how recently the bot must have stamped
`autocart_verified_at` for the poller to use the auto-cart lane — default 45m ≈ one
30m keepalive + a missed one; stale/NULL fails open to normal alerts). The bot-side
keepalive cadence itself is `KEEPALIVE_MS` (default 30m), set in the mini-PC's own
`.env`, not on Fly.
The mini-PC bot has its own `.env` (`AUTOCART_TOKEN`, `LOGIN_MODE=remote`,
`BROKER_PORT`, `POLL_MS`).
Admin cost tracking (optional, non-secret, on Vercel — in-code defaults, override only to
tune): `COST_PER_SMS_USD` (default 0.0115), `COST_PER_EMAIL_USD` (0), `COST_PER_PUSH_USD`
(0) — the per-unit usage rates the Costs tab multiplies against this-month send counts.
Fixed monthly costs are NOT env vars — they live in the editable `cost_items` table.

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

See `docs/SETUP.md`. Short version: website auto-deploys on `git push` to `master` and
`camphawk.app` auto-re-aliases to it (`autoAssignCustomDomains` on; **`vercel.json`
disables deploys for `claude/*` branches** so an agent branch pushing the same SHA can't
shadow the master Production build and strand the domain — root-caused 2026-07-25, see
SETUP.md); the Fly worker deploys via `flyctl` **and must then be started by hand** (see
the autostop note above — the deploy leaves it stopped and alerting silently dead); the
mini-PC bot updates via `git push` + `update.bat` on the box.
