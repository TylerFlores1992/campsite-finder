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
- **Stripe** — subscriptions, two plans since 2026-08-01: **Alerts** ($2.50/mo, $20/yr)
  and **Auto-Cart** ($10/mo, $50/yr). Live in prod; test keys locally. See
  "Subscription plans & the Auto-Cart tier" below for how tier/entitlement work.
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

State-park coverage spans **34 states** across those platforms, plus federal
Recreation.gov nationwide. (Counted from the registries 2026-07-27: UseDirect 10 +
ReserveAmerica 18 + GoingToCamp 4 + TN/SC 2, no overlaps. `COVERAGE.stateParkStates`
in `src/lib/coverage.ts` already said 34; this line said 33 and was the stale one —
it predates SC shipping. **`coverage.ts` is the number the UI renders, so it is the
one to trust.**) All non-rec.gov sources are **alert-only** (their carts are
session-bound and don't sync to a phone). Adding a source = availability adapter +
catalog sync + wire into search/worker/notifications + update coverage copy +
**a row in `src/lib/data-sources.ts`** (below).

> **EVERY SOURCE MUST BE CITED, AND THAT IS A STORE-POLICY REQUIREMENT, not a nicety.**
> Google Play **rejected the Android listing on 2026-08-03** under the Misleading
> Claims policy — *"Missing Source Link for Government Information"*. An app that
> surfaces government information must cite a clear, official, **functional** source
> for it in the store description AND carry an **easy-to-see** disclaimer that it does
> not represent a government entity.
>
> - **`src/lib/data-sources.ts` is the one list** — 14 sources, matching the 14
>   distinct `campgrounds.source` values, together covering all 8,013 rows. It also
>   holds `AFFILIATION_DISCLAIMER`, in one place so the page and both store listings
>   cannot drift into saying different things.
> - It renders at **`/sources`** (public, in `isPublicRoute`, in the sitemap) and is
>   **linked from the app footer**, so the citation is reachable from inside the native
>   app — it's a webview, so this needed no rebuild and no new AAB.
> - **Adding a sync adapter without adding it there ships government data with no cited
>   source again.** Same change, not a follow-up.
> - A **dead link is the exact violation**. All 19 URLs were fetched and returned 200
>   on 2026-08-03; re-check before any resubmission.
> - Two things were wrong, and only one was named. The disclaimer text already existed
>   — Google quoted it back approvingly — but it was the LAST paragraph of the
>   description. **Buried is not "easy to see".** It now opens the description and
>   closes it.
> - **Do NOT appeal** a rejection of this kind: that path is only for developers
>   holding written proof of government affiliation or authorization, we declare the
>   opposite in both the description and Play's **Government apps** declaration, and it
>   burns 7+ days. The two declarations must keep agreeing.
> - **The App Store listing carries the same block since 2026-08-04**
>   (`docs/appstore-description.txt`). Apple never raised it — this is pre-emptive, on
>   the reasoning that the exposure is the same shape and the fix is text-only. Mind the
>   timing: a version *In Review* cannot have its Description edited without pulling it
>   from review, and Description needs a new build to change (Promotional Text does not).
> - Listing text: `docs/play-full-description.txt`. Full write-up: `docs/PLAY-STORE.md`.

### A park with no coordinates used to be DELETED (fixed 2026-08-04)

`campgrounds.location` is NOT NULL, so a park whose portal ships no coordinates was
silently dropped by its sync — absent from search, unwatchable, and visible only as a
line in `sync_log.error`. That was **35 parks**: 16 ReserveAmerica across 11 contracts
and 19 GoingToCamp. `src/lib/sources/geocode.ts` is the shared ladder that recovered 22
of them, and every guard in it was written against a measured wrong answer.

**The ladder, in order.** Portal coordinates → geocode the STREET ADDRESS (Mapbox) →
geocode the NAME (OpenStreetMap). Each rung is tried only when the one above yields
nothing, and a park that falls off the bottom is skipped **and logged**, never guessed.

| | RA | GTC |
| --- | --- | --- |
| recovered | 10 of 16 | 12 of 19 |
| still skipped | 6 | 2 |

> **`0.0, -0.0` is a coordinate, and it parses.** ReserveAmerica publishes it for parks
> it has no location for (Clough State Park, NH). The old code survived only by
> ACCIDENT: those pages also omit the Open Graph meta it read, so its regex failed and
> returned null. Reading the schema.org `itemprop` block as a second source removed the
> accident and made the check mandatory — hence `isRealCoord`, not a null test. Null
> Island is in the Gulf of Guinea; nothing else about the row would have looked wrong.

> **NEVER NAME-GEOCODE WITH MAPBOX. The rule stands, and was re-measured twice.**
> "Clough State Park, New Hampshire" returns the NEW HAMPSHIRE STATE CENTROID — a
> confident pin ~40 miles out. Asked for the 16 GoingToCamp names with `types=poi`,
> Mapbox returned **zero** results. Not bad ones: none. (Original measurement, SC
> portal 2026-07-22: 5 of 43 resolved, ~20 stacked on one wrong point.)
>
> **OpenStreetMap is a different proposition** and is the bottom rung: it holds the
> actual park and protected-area geometries, and is where `SC_PARK_COORDS` was sourced
> by hand in July — this automates a lookup already trusted here. Nominatim asks for
> ≤1 request/second and an identifying User-Agent; calls are serialised and it runs for
> ~19 locations a night.

**Three guards, each from a real wrong answer:**
- **A PO box is a mailbox, not a place.** Glen Island lists "PO Box 993, Bolton
  Landing" (Lake George, ~-73.65). Mapbox returned western New York on one call and
  Moorestown **NEW JERSEY** on another. The first is inside the New York box.
- **Compare POSITION, not city names.** Mapbox labels "5800 W. Sprague Road, Martell
  NE" as *Crete* — the postal city, correct and not a string match, and rejecting it
  lost a real park. So when the returned city differs, the TOWN is geocoded and the
  address must land within `MAX_CITY_DISTANCE_KM` (60). Martell passes at ~0km;
  Bolton Landing against Moorestown is ~400km and fails.
- **The state box, now for all 50 states.** It lived in the GoingToCamp sync with the
  four states that source needed; ReserveAmerica spans 18 contracts, so every other
  state fell through the unknown-state escape hatch unchecked. It earns its keep: "Big
  Eddy, Washington" → a covered bridge in Washington COUNTY, **VERMONT**; "Riverside
  HQ, Washington" → Riverside, Washington County, **IOWA**.

> **Widening the non-campground filter was FORCED by fixing the geocoding**, and this
> is the part worth remembering. HQs, visitor and interpretive centres, front desks and
> depots were excluded only BY ACCIDENT — they carry no coordinates, so they failed as
> errors. Once name-geocoding could resolve them, accident stopped being enough:
> "Riverside HQ" resolves to the TOWN of Riverside, ~100 miles from Riverside State
> Park, and would have entered the catalog as a bookable campground. `NON_CAMPGROUND`
> in `goingtocamp/sync.ts` now names them. Checked against all four live feeds: it
> excludes exactly 6 WA facility entries and **zero** real campgrounds in MI/WI/MS.
> **A fix that makes a previously-failing path succeed can promote junk that was only
> ever filtered by its own failure.**

**Still skipped, correctly** — fail loud beats a guessed position. RA: three publish no
address at all (Lake George Islands Day Use, Illinois River Forks, Clough) and three
only a PO box (Glen Island, Wildcat Hills, Wood-Tikchik). GTC: Kettle Moraine's
**Northern** Unit and Menominee River SRA are not in OpenStreetMap under those names —
note the Southern Unit is, which is why the pair looks inconsistent in the log.

**One honest limitation:** Blackfoot River Corridor geocodes to 3201 Spurgin Road,
Missoula — the managing FWP office, not the river. That is what the portal publishes and
there is no general way to tell an administrative address from a site address.

Tests: `worker/geocode.test.mts` (pure, no network or credentials — the only suite in
the repo that needs neither).

> **THE RESERVEAMERICA HALF SHIPPED AS A NO-OP, for a full day (found 2026-08-04).**
> The first post-fix nightly run recovered NOTHING: 872 facilities, unchanged, and all
> 16 parks logged `geocode failed`. The code was fine — `.github/workflows/nightly-sync.yml`
> never passed **`NEXT_PUBLIC_MAPBOX_TOKEN`** to the ReserveAmerica step, and
> `geocodeAddress` returns null the instant the token is missing.
>
> The tell was that the SAME code worked elsewhere the same night: GoingToCamp runs on
> the Fly worker, which has the token as a secret, and its catalog went 362 → **374**
> (+12: WA +5, WI +5, MI +2) exactly as measured in the sandbox. Same commit, two
> environments, one missing a variable nothing checked for.
>
> `geocodeAddress` now WARNS ONCE per process when the token is absent, because a
> missing token used to return null identically to "Mapbox found nothing" — an entire
> environment with no geocoding at all logged the same `geocode failed` as a genuinely
> unresolvable address. **An environment problem that is indistinguishable from a data
> problem will be read as a data problem.**

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
> > manually afterward.**
> >
> > **Automated 2026-07-28 — deploy through the `worker-deploy.yml` GitHub Action and
> > this is handled for you.** It records which machines were `started` *before* the
> > deploy, restarts exactly those (never the standby), and then fails the run unless a
> > fresh `worker_heartbeat` lands within 4 minutes. The rule below is still the truth
> > about what `flyctl deploy` does — it just no longer depends on a human remembering
> > it. Everything after this paragraph applies to a by-hand deploy.
> >
> > The rolling deploy stops each machine to swap the image,
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
> > **THE HALF-OPEN PROBE WAS A COMMENT, NOT CODE, UNTIL 2026-07-30.** The paragraph
> > above described the intent; the implementation reopened the gate for EVERYONE once
> > the deadline passed, so all four of the poller's concurrent fetches hit a
> > still-throttled rec.gov at once, three 429'd, and it slammed shut again. Six
> > OPEN/CLOSED cycles in thirteen minutes — rec.gov watches unchecked ~40% of the time,
> > and the user-visible "Recreation.gov isn't responding" banner flapping with it.
> > Fixed together with three other things, all in the same failure loop:
> > 1. **Real half-open** — exactly ONE caller crosses as a probe (`enterRecgovGate`);
> >    the rest keep short-circuiting until it resolves. One request cannot re-trip a
> >    limit that needs three.
> > 2. **Escalating cooldown** — each failed probe doubles it (60s → 120s → …) up to
> >    `RECGOV_BREAKER_MAX_COOLDOWN_MS` (8 min), reset by a success. It was a flat 60s,
> >    so we walked back into the same rate limit every minute forever.
> > 3. **Paced, not bursted** (`RECGOV_SPREAD_MS`, half the poll interval) — `pMap(4)`
> >    fired all four campground-months simultaneously then idled for 14s. Same average
> >    rate presented as a burst, which is exactly what a token bucket rejects; the
> >    identical mistake once tripped rec.gov via the feature-E roster. Costs a couple
> >    of seconds of average detection latency.
> > 4. **Browser headers** (`recgovHeaders`) — the UA was
> >    `Mozilla/5.0 (compatible; CampsiteFinder/1.0)` under a comment claiming to mimic
> >    a browser. It announced a bot, and it is the cheapest thing for a limiter to key
> >    on. Both header sets return the same 235 campsites against the live endpoint.
> >
> > Covered by `worker/recgov-breaker.test.mts`, which drives the real state machine
> > with a 1ms timeout (a timeout counts as a throttle, so it takes the 429 path without
> > needing rec.gov to cooperate). Every assertion was confirmed to FAIL against the
> > behaviour it guards before being trusted.
> >
> > **A fifth bug, in the escalation itself, shipped and was caught in production the
> > same evening** — worth knowing because the shape recurs. A failure recorded while
> > the breaker is open is NOT necessarily a failed recovery probe: it may be a request
> > that crossed a closed gate and was still in flight when the breaker tripped. At
> > 23:12:55 the poller's fourth paced fetch did exactly that and doubled 60s to 120s in
> > the same second it opened. `enterRecgovGate` now returns `isProbe`, and only a real
> > probe may escalate; a stale in-flight failure is counted and otherwise ignored.
> > **The first test written for this passed against the bug** — it began with the
> > breaker already open, so all five calls were denied at the gate, reached no network
> > and recorded nothing. Hence `__recgovBreakerReset()`: a concurrency test that does
> > not assert its starting state is a test of nothing.
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
> > **ONE fetch lane since 2026-07-31 — `worker/recgov-scheduler.ts`.** Every worker
> > rec.gov availability read goes through it (main cycle, auto-cart reconciler,
> > canary — the canary was missed on the first pass, which is exactly the bug the
> > scheduler exists to prevent). Three mechanisms: **single-flight** (concurrent
> > callers for one campground-month share a request), a **short-TTL cache** (callers
> > state `maxAgeMs`), and a **token-bucket budget** — `RECGOV_BUDGET_PER_MIN` (15,
> > measured: a clean IP took 160 sequential requests at 16/min with zero 429s),
> > burst `RECGOV_BUDGET_BURST` (4 — must be ≥ the per-cycle dispatch or the bucket
> > denies traffic that is already paced; 2 halved throughput in production), and a
> > low-priority reserve so the canary/reconciler always get through. A denied
> > refresh returns the PREVIOUS value marked `stale`, or `unknown` — never a
> > fabricated empty, which downstream reads as "fully booked". An `unknown` never
> > overwrites a cached real reading, and an open-breaker skip costs no budget.
> > **The breaker gate must be `recgovBreakerCoolingDown`, not `recgovBreakerOpen`**
> > — the latter stays true until a success only the skipped call could produce,
> > which deadlocked rec.gov detection for 20 minutes on 2026-07-31.
> >
> > **The auto-cart lane's own detection loop is GONE (2026-07-31).** It duplicated
> > the main cycle's detection every 6s at 10 req/min per campground-month vs the
> > main cycle's 4 — two thirds of the whole budget for one watch. The main cycle
> > now detects for every watch and branches on `isAutocartLane` after the claim;
> > `autocartCycle` is reconciliation only. Measured after the merge: 429s
> > 0.58→~0.1/min, breaker openings → 0, blind time ~40% → 0%.
> >
> > **Lead-time tiering (2026-08-01, `worker/lead-time.ts`).** A campground-month
> > whose first wanted night is more than `RECGOV_HOT_LEAD_DAYS` (14) out rides the
> > cache for `RECGOV_COLD_MAX_AGE_MS` (60s) instead of demanding freshness every
> > 15s — ~1 req/min instead of 4. Computed per (watch, MONTH), so a long watch's
> > far months go cold individually; auto-cart-lane pairs are always hot. Justified
> > by the frozen feature-E data: 89% of openings ≥7 days out survive an hour. The
> > heartbeat prints `N recgov (H hot/C cold)` plus served/denied and budget level.
> >
> > **Scaling is by machine, not by tuning** — rec.gov's limit is per egress IP
> > (measured per-address, NOT per-/24). `worker/shard.ts` divides campgrounds
> > across machines by FNV-1a hash with a DB lease per shard (`poller_shards`,
> > migration 031, same INSERT..ON CONFLICT..WHERE shape as the alerting claim).
> > **Shipped dark at `SHARD_COUNT = 1`** (2026-07-31), where `ownsCampground`
> > short-circuits true without consulting the lease — a DB hiccup must never stop the
> > only poller. **NOW LIVE AT 2** (2026-08-02; see the sharding note further down for
> > the live machine ids and why). Scale = `flyctl machine clone` FIRST, then raise
> > `SHARD_COUNT` and `min_machines_running` in `worker/fly.toml` together.
> > Shard by CAMPGROUND, never by watch or campground-month, or the dedup is lost.
> > `/api/health/status` watches both ends: `poller.shards` FAILS on an unheld shard
> > (campgrounds polled by NOBODY while everything else is green), and
> > `poller.capacity` compares distinct rec.gov campground-months across active
> > watches to machines × `RECGOV_MONTHS_PER_MACHINE` (4, `lib/health-thresholds.ts`)
> > — warn AT capacity, fail OVER it, because over-capacity breaks the 15s promise
> > while every other check stays green. The user-facing **watch cap is 6**
> > (`src/lib/limits.ts`, one constant feeding the server 409 and all copy), chosen
> > because 6 watches ≈ one machine's capacity.
> >
> > **The full-day 429 profile records continuously** (`worker/rate-profile.ts` →
> > `recgov_rate_profile`, migration 033, since 2026-08-01): every fetch outcome in
> > 5-min buckets, rec.gov's behaviour (ok/429/timeout/error) separated from ours
> > (denied/breaker_skipped). Readout `scripts/recgov-429-profile.mts` refuses a
> > verdict until all 24 UTC hours have data.
> >
> > **FIRST FULL READOUT, 2026-08-02 — it killed the sub-15s-on-one-IP idea.** 24/24
> > hours, 294 buckets. At a steady **13.3 req/min the IP was throttled in EVERY
> > hour**: 429s 0.02–0.42/min, 0.2–3.2% of attempts, worst **3.2% at 15:00 UTC**
> > (8am PT, the booking peak), **zero timeouts all day**, and **our own budget denied
> > almost nothing** — so the budget was never the constraint and there was no headroom
> > to take by raising it. This CONTRADICTS the earlier clean-IP probe (160 sequential
> > requests at 16/min, zero 429s): a burst probe and sustained production traffic are
> > different measurements, and production is the real one. Conclusion: keep 15s, do
> > NOT raise `RECGOV_BUDGET_PER_MIN`, buy speed with machines.
> > One 10-min hole at 18:40 Aug 1 — a worker redeploy; counters are in-memory and
> > flush every 5 min, so a restart drops the partial bucket. Not a broken flush.
> > *(Gotcha for anyone re-checking: detect bucket gaps in SQL with `LAG()`. A JS
> > `Date.parse` on the `+00` offset returns NaN, so every comparison is false and the
> > check silently reports "no gaps" — that mistake was made once already.)*
> >
> > **SHARDING WENT LIVE AT `SHARD_COUNT = 2` the same day.** Two machines in iad
> > (`84ed237b2d1e48` shard 0, `8ee952b7671278` shard 1), each with its own egress IP
> > and its own 15/min budget — ~30/min across the pair without either going faster
> > than the rate already measured as survivable. Verified live: `9/14 watches (shard
> > 0/2)` and `5/14 (shard 1/2)`, `poller.shards` 2/2, `poller.capacity` 3/8. The two
> > stopped `sjc` machines were destroyed on 2026-08-02 (they ran the same image, so
> > they were no rollback path; the real rollback is `git revert` + redeploy).
> > **CLONE FIRST, THEN RAISE THE COUNT** — raising it first leaves the new shard
> > unheld and half the campgrounds unpolled, the silent-blindness case. The reverse
> > transient (all machines still at `SHARD_COUNT=1`) is harmless: everyone polls
> > everything, the claim dedupes, each IP stays at its normal rate.
> > `min_machines_running` tracks `SHARD_COUNT`; raise both together.
> >
> > **CONFIRMED FIXED — first post-claim run, 2026-08-04 16:45–18:50 UTC:** 14 sources,
> > **exactly ONE run each**, no 45-second-apart pairs, and the chain is contiguous (each
> > source starts as the previous finishes) — one machine, start to end. `sync_claims`
> > was EMPTY afterwards, so the claim released cleanly. Errors collapsed, which is what
> > confirms the doubling was the cause rather than a coincidence:
> >
> > | source | 08-03 (doubled) | 08-04 (claimed) |
> > | --- | --- | --- |
> > | ohiostateparks | 311 | **15** |
> > | minnesotastateparks | 80 and 140 | **5** |
> > | illinoisstateparks | 139 and 42 | **9** |
> > | virginiastateparks | 80 and 10 | **18** |
> > | floridastateparks | 24 | **0** |
> >
> > **SHARDING DOUBLED THE NIGHTLY CATALOG SYNC, and nothing noticed for two days**
> > (fixed 2026-08-04, `worker/sync-claim.ts`, migration 037). `ownsCampground` shards
> > the POLLING; `rcSyncIfDue` and `gtcSyncIfDue` were never shard-aware, so BOTH
> > machines ran the whole sync. Their only guard was an in-process boolean, which
> > cannot see the other machine — both read `sync_log`, both see "due", both start.
> >
> > Measured on 08-03: two identical UseDirect chains 45 seconds apart through the same
> > states in the same order, every error `RC proxy /search/grid → 502 upstream 403`.
> > Ohio 311, Minnesota 80 and 140, Illinois 139 and 42, Virginia 80 and 10 — against
> > Minnesota's ZERO every night from 07-17 to 08-02. It bites because UseDirect syncs
> > route through `/api/rc-proxy` on **Vercel**, so both workers exit from the SAME
> > Vercel IPs and these WAFs meter per IP. Exactly what `coalesce: false` on the
> > nightly sync already exists to prevent. Cost: 252 of 478 Ohio campgrounds left with
> > no campsite rows (other UseDirect states run 2-10%).
> >
> > **THAT LAST SENTENCE WAS WRONG, and it is the second time the same mistake was
> > made in this file.** Ohio is still 252 of 478 after a clean 15-error run — the
> > number did not move, so it was never measuring the 403s. Sampling says why:
> > "Grand Lake St. Marys — Bayview Marina", "Nagy's Subdivision", "Guilford Lake —
> > Whinnery". Ohio's portal lists marinas, lakefront lease lots and subdivisions
> > alongside campgrounds, and those have no campsites to sync. Exactly the shape of
> > the rec.gov "675 empty campgrounds" error. **A count that does not move between a
> > broken run and a clean one was never measuring the breakage** — check that a
> > number RESPONDS to the bug before quoting it as the bug's cost.
> >
> > **A CLAIM, not a shard index.** Pinning the sync to shard 0 is one line, but a
> > machine 0 that is down means the catalog silently stops refreshing — and a stale
> > catalog is invisible until someone searches for a campground that should be there.
> > Same `INSERT .. ON CONFLICT .. WHERE` shape as the alerting claim and the shard
> > lease. The holder RENEWS while it works (`SYNC_CLAIM_MS`, 10 min, renewed at a
> > third) so a 50-minute sync cannot have its claim expire underneath it, and an
> > expired claim is takeable so a crash frees it in minutes rather than never.
> > `withSyncClaim` releases on the way out **including when the sync throws**.
> > Tests: `worker/sync-claim.test.mts`.
> >
> > **TWO-MACHINE READOUT, 2026-08-03 — the split helped, but far less than the
> > arithmetic promised, and the answer is still "keep 15s".** 24h of post-split
> > buckets only (`bucket_start >= 2026-08-02 06:00`), 297 per machine, **no gaps on
> > either** (the 23:27 worker deploy cost ~1 request, not the 10-minute hole the
> > Aug 1 redeploy did).
> >
> > | | shard 0 `84ed237b…` | shard 1 `8ee952b7…` |
> > | --- | --- | --- |
> > | req/min | 5.2 | 4.4 |
> > | throttled | 0.89% | 1.2% |
> > | hours with ≥1 429 | 18/24 | 20/24 |
> > | worst hour | 2.6% (04:00) | **4.17% (17:00)**, 4.07% (20:00) |
> >
> > Same machine before vs after: **12.3 req/min → 5.2, but 1.32% throttled → 0.89%.**
> > A 58% rate cut bought a 33% throttle cut — **sub-linear**, and three things say
> > the per-IP rate is not the dominant variable:
> > 1. **The NEW IP is the WORSE one.** Shard 1 runs slower and throttles more, with
> >    peak hours (4.17%) worse than ANY hour of the single-IP baseline (3.2%). A
> >    fresh address at a third of the old rate should have been clean.
> > 2. **Neither IP is ever clean** — 18/24 and 20/24 hours carry a 429. There is no
> >    quiet window to hide a faster lane in.
> > 3. **Our budget is idle** — 3.1–3.4 of 15 on every heartbeat, 0.01 denials/min
> >    against 140 pre-split. Confirms again the ceiling is upstream.
> >
> > Likely mechanism: rec.gov meters something COARSER than one IP. Both machines are
> > Fly iad and two of three Fly machines were already measured sharing a /24. If so,
> > cloning within one region buys less than machines × budget suggests — a thing to
> > test with a machine in a different region before buying more iad capacity.
> >
> > **Why a sub-15s hot lane still loses, and it is NOT the budget.** Per hot
> > campground-month: **4 req/min at 15s, 6 at 10s, 8 at 7.5s**. Today's 3
> > campground-months at 10s would put shard 0 at 7/min and shard 1 at 6 — both inside
> > the 15/min budget. What breaks is CAPACITY: `RECGOV_MONTHS_PER_MACHINE` is 4
> > because 4 × 4 = 16 ≈ the budget, and at 10s that becomes 4 × 6 = 24, so
> > **per-machine capacity halves from 4 campground-months to 2**. At 3/8 utilisation
> > that is spending the growth headroom the second machine just bought to buy five
> > seconds, into IPs that already throttle in ~80% of hours.
> >
> > *(The readout script aggregates ALL machines together, so a naive run mixes pre-
> > and post-split data and understates per-IP rates. Query `recgov_rate_profile` by
> > `machine_id` directly for a per-machine breakdown, and restrict the window.)*
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
>     >
>     > **The agent proxy also reaches it — so a web session CAN run the catalog sync
>     > (verified 2026-08-04).** `curl` got 200 + the real page title from both hosts,
>     > and `NODE_USE_ENV_PROXY=1 npx tsx scripts/run-sync-tnsc.ts TN|SC` completed the
>     > whole CSRF handshake + batched POST for both states — TN 39 parks, SC 34, zero
>     > errors, ~9s each. **This does NOT soften the Fly finding**: Fly is still blocked
>     > and the worker still needs `/api/tnsc-availability`. The agent proxy is its own
>     > egress, same as it is for the UseDirect and GoingToCamp seeds. The rule is
>     > "Fly blocked, Vercel fine, agent proxy fine" — not "datacenter IPs are blocked",
>     > which is how SETUP.md and the script's own header comment had it, and which is
>     > what stopped anyone trying for two weeks. **Without the flag Node's fetch skips
>     > the proxy and the WAF answers 403** — indistinguishable from a hard IP block,
>     > and the likely origin of the wrong generalisation.
>     >
>     > **GITHUB ACTIONS RUNNERS ARE BLOCKED — tested 2026-08-04, don't re-try it.**
>     > The obvious next move after the above was "then schedule it in the nightly
>     > Action alongside RIDB and ReserveAmerica". A step was written and dispatched
>     > (run `30878585899`, `only: tnsc`): **both states returned 0 parks / 1 error in
>     > 0.6s and 0.3s** — an instant refusal, the same answer ReserveCalifornia's WAF
>     > gives runner IPs, which is why THAT sync isn't in the Action either. The step
>     > was removed; the workflow carries the result as a comment.
>     >
>     > **The lesson is the one this file keeps re-learning: one egress passing tells
>     > you nothing about another.** "Agent proxy reaches it" did not generalise to
>     > GitHub's ranges any more than "Vercel reaches it" generalised to Fly. Four
>     > egresses are now measured against this portal — **residential ✓, agent proxy ✓,
>     > Vercel ✓, Fly ✗, GitHub runners ✗** — and the only one of those that can run on
>     > a schedule AND reach the portal is **Vercel**. So the remaining option for a
>     > scheduled TN/SC catalog sync is a **Vercel Cron hitting a sync route**, reusing
>     > the egress `/api/tnsc-availability` already proves works.
>     >
>     > **BUILT 2026-08-04 — `crons` in `vercel.json` → `GET /api/cron/sync-tnsc`,
>     > daily 09:30 UTC** (30 min after the nightly Action, so they don't overlap).
>     > `maxDuration = 120`: the sync measures ~16s for both states and the Next default
>     > is BELOW that, so it would have timed out mid-sync every night. Auth takes either
>     > `Authorization: Bearer <CRON_SECRET>` (the only header Vercel Cron can send) or
>     > the usual `x-sync-secret: <SYNC_SECRET>` for a by-hand run, and **fails closed** —
>     > an unset secret makes the route unreachable rather than open, which matters
>     > because this route writes the catalog and an open one would let anyone drive our
>     > Vercel IP at the portal, the surest way to lose the last working egress. Zero
>     > parks returns **500**, not an empty 200, for the same reason the script exits 1:
>     > a blocked landing here can be 200-but-empty, and a green cron over a rotting
>     > catalog is this repo's most expensive recurring failure shape.
>     >
>     > **BOTH GATES CLEARED 2026-08-04 — the schedule is LIVE.** `CRON_SECRET` is set
>     > on Vercel **Production only** (type `sensitive`, 32 random bytes), and the cron
>     > is registered on the live deployment: `/api/cron/sync-tnsc`, `30 9 * * *`.
>     >
>     > **THE GOTCHA THAT COST A ROUND: setting the variable is not enough — Vercel
>     > bakes env vars into a deployment at build time.** Immediately after the write,
>     > production still 401'd the CORRECT bearer, because the running deployment
>     > predated the variable. **A redeploy is mandatory** for any new secret to reach
>     > the running site, and "I set it and it still 401s" looks exactly like a wrong
>     > value. `crons` also only registers on a production deploy from `master` —
>     > `vercel.json` disables deploys for `claude/*`, so it does nothing on a branch.
>     >
>     > **Verified on production after the redeploy:** the real cron call returned
>     > `{"ok":true,"facilitiesSynced":73,"errorCount":0}` in 10.4s (TN 39 + SC 34), and
>     > three bad-credential shapes — no header, wrong bearer, secret as a query param —
>     > all 401. `catalog.syncs` went `2 stale (>48h)` → **`0 stale`**, and
>     > `/api/health/status` is green overall.
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
>     - **Still no scheduled sync** (like TN): refresh with
>       `NODE_USE_ENV_PROXY=1 npx tsx scripts/run-sync-tnsc.ts SC` from a residential IP
>       or a web session (see the TN/SC reachability note below), then **deploy the Fly
>       worker** so it picks up SC watches.
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

## WebRezPro / `secure.webrez.com` — investigated 2026-08-05, DECIDED AGAINST

Prompted by a request to add **Big Sur Campground & Cabins** (`bigsurcamp.com`), whose
Reservations button goes to `secure.webrez.com/hotel/3590`. Recorded so nobody spends a
day rediscovering it.

**Both of the obvious objections were wrong, and the real blocker was somewhere else.**

- *"A hotel booking engine can't model campsites."* **False.** The booking page embeds
  `global_points_on_image_hash_array`, mapping **87 individual sites** at Big Sur to map
  coordinates and human site numbers (`004`, `065-A`, …) across 24 unit types. Those
  point ids are the same `inventory_id`s the availability response returns, so joining
  them gives true per-site, per-night availability. Per-site watches and site-mute would
  work.
- *"It's one campground, so no leverage."* **Half wrong.** `secure.webrez.com` is the
  multi-tenant booking host for **WebRezPro**, a PMS by World Web Technologies (Calgary),
  advertising *"More than 2,000 properties worldwide"* with campgrounds/RV parks as a
  named vertical. It is a family, like UseDirect.
- The API is *technically cleaner than rec.gov's*:
  `GET secure.webrez.com/Bookings105/activity-edit.html?table=hotels&listing_id=<id>&mode=ajax&command=website_availability_calendar_html_29&hotel_id=<id>&merchant_id=<id>&location_id=-1&language=english&date_start=YYYYMMDD`
  returns pure JSON with **no cookies, no session, no CSRF, no auth**. (Traps: despite
  `_html_` in the command name it is JSON; `date_from` is silently ignored — the param
  is `date_start`; the window is a fixed 14 days.)

**Why we are not building it:**

1. **`robots.txt` is a blanket prohibition.** In full:
   `User-agent: Googlebot / Allow: / · User-agent: * / Disallow: /`. Every other source
   in this catalog is a government or public-agency portal with a public-data defence.
   This is a private vendor's commercial booking engine run for private businesses, and
   the page carries no terms at all — so robots.txt *is* the stated position. Polling it
   every 15s from one Fly egress IP is a different risk category from anything the
   project currently carries.
2. **The leverage isn't actually there.** WebRezPro is primarily a hotel/inn/B&B PMS;
   campgrounds are one of ~10 verticals. Eleven campground tenants were found by hand
   (ids 1202–4018, four of them Canadian and therefore out of scope for a US-only app).
   The estimate of **~50-150 US campgrounds is INFERRED from the id range and vertical
   mix — the vendor publishes no campground count.** Against UseDirect's 9 states that
   is one to two orders of magnitude less leverage.
3. **There is no discovery path that isn't itself the violation.** No public directory,
   no catalog endpoint; `secure.webrez.com/` is a staff sign-in. Finding the properties
   means enumerating ~4,000 ids against that robots.txt.
4. **Payload economics are bad** — ~500 KB per property per request (234 KB of it an
   unused `html` blob that `return_html=0` does not suppress), i.e. ~2 MB/min per
   campground at the 15s cadence.
5. **Cloudflare Turnstile is already wired into the platform**, currently only on guest
   sign-in modals. The vendor has the switch and an obvious reason to flip it.

**The one legitimate path** if private campgrounds ever become strategic: WebRezPro runs
a formal integration-partner programme (150+ partners). That would give sanctioned
access, a real property catalog and probably a lighter payload — a business-development
conversation, not an engineering spike. Until then the honest answer to "can you watch
this private campground?" is **no, and it's a policy limit rather than a technical one**.

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
| `/pricing` | `(app)/pricing/page.tsx` | Dedicated plans page (2026-08-01). Mounts the SAME `PricingSection` as `/` — one source of pricing truth. Indexed, in the sitemap, and in `isPublicRoute` (it 404'd on prod for its entire signed-out audience until added). The `/#pricing` anchor on the home page also still works. |
| `/watches` | `(app)/watches/` | Watch list, quota, outage banner, alert history. |
| `/new` | `(app)/new/` | The only place a watch is created. |
| `/welcome` | `(app)/welcome/` | Post-signup setup step (2026-08-01): email-alert opt-in, optional phone + SMS consent, and the Recreation.gov sign-in for an entitled Auto-Cart subscriber. Clerk lands new accounts here; Stripe's checkout `success_url` returns here too. In `isPublicRoute` with its own signed-out state — see below. `noindex`. |
| `/settings` | `(app)/settings/` | Alerts (SMS), auto-cart, subscription, account, admin link. |
| `/campground/<id>` | `(app)/campground/[id]/` | **Server-rendered** detail + per-page metadata + JSON-LD. |
| `/manage/<token>` | `(app)/manage/[token]/` | Token-authorised per-watch manage. `manageLink()` has always emitted this path, so links already in the wild land here. |
| `/camping`, `/camping/<state>` | `app/camping/` | SEO landing pages. **Outside** the group — own breadcrumb chrome. |
| `/sources` | `app/sources/page.tsx` | Where the campground data comes from — 14 official sources, each with its link, disclaimer first. **Outside** the group. Required by Google Play (see "Reservation sources"); linked from the app footer so it is reachable inside the native app. In `isPublicRoute` — a reviewer opens it signed out. |

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
  `auth.protect()` returns 404 rather than 401. `/search`, `/watches`, `/settings`,
  `/new`, `/pricing` and `/welcome` are all listed (`/pricing` was caught 404ing on production
  minutes after it shipped — the trap works on PAGES exactly as it does on `/api/*`). `/new` is listed **deliberately**: the New watch screen
  handles its own 401 with a message that keeps the campground, dates and filters
  already entered, and letting middleware intercept would throw that away.
  **`/support` is listed too** (added 2026-07-28): it's the App Store Support URL, so
  Apple fetches it unauthenticated and a 404 there fails review. It carries **no
  prices** — it's reachable from inside the webview, which makes it a pricing surface
  whether or not it looks like one. **`/sources` is listed for the same reason**
  (2026-08-03): it is the source citation Google Play's Misleading Claims policy
  requires, a reviewer opens it signed out, and a 404 would fail the very check it
  exists to pass. It carries no prices either.
  **`/welcome` is listed for a subtler reason** (2026-08-01): Clerk redirects a
  brand-new account there the instant it exists, and if the session cookie is not yet
  readable by middleware on that first request, `auth.protect()` answers 404 — a new
  user's very first impression being a dead page. The component renders its own
  create-account / sign-in block instead of assuming a session.
- **AN EARLY `return` INSIDE A `Promise.all(map(...))` CALLBACK SKIPS EVERYTHING BELOW
  IT.** `/api/watches` computed a per-watch likelihood and bailed with
  `if (lead < 0) return` for a stay already underway — which returned from the whole
  callback, skipping the manage-token mint that followed. `WatchCard` renders a
  DISABLED Manage button when `manage_token` is missing, so **the moment a trip
  started the user lost the only way to open, pause or delete that watch**. Found
  2026-08-01 on a real device: a Jul 31–Aug 2 watch had Manage greyed out while its
  Aug 14–16 sibling worked. Keep early exits inside the block that owns them.
- **The account quota must count what the POLLER runs, not every `active` row.** The
  watch cap counted active watches regardless of date, while the list and
  `loadWatches` both require `end_date > CURRENT_DATE`. An account showed "4 of 6
  watches running" and was refused a fifth, with three expired rows invisible and
  therefore undeletable (measured: 7 counted, 4 shown). Cap and list now share one
  predicate — change both together.
- **A scroll handler that resizes a `sticky` element is a feedback loop.** The mobile
  header band collapses on scroll, and because it sits in normal flow, collapsing it
  shortens the document by 85px — moving the scroll position the decision reads. One
  threshold made it oscillate visibly whenever you stopped near the trigger. It now
  uses two thresholds with a dead band wider than the height change, plus a lock for
  the duration of the animation. Reported from a real device; not reproducible in the
  component harness.
- **`env(safe-area-inset-top)` must ADD to a fixed height, not be padded into it**, and
  `position: absolute` resolves against the padding box so it ignores the inset
  entirely. The header had both bugs: with border-box the inset came out of the 131px
  (so the artwork lost a third of its height under the status bar), and the account
  avatar sat beside the system clock because `top-3` measured from the element's very
  top. Any new fixed-height element behind the notch needs both halves.
- **`robots` is set per page, not in the layout.** The layout carried a `noindex`
  during the dark launch and removing it is what made the campground SEO work count.
  `/` and `/search` are indexable; `/watches`, `/settings`, `/new` are not; and
  `/manage/<token>` is `noindex, nocache` because **the URL contains the token that
  authorises managing the watch** — a token in the index is a token anyone can use.
- **Watch creation is gated in exactly one component**, `v2/WatchCta.tsx`, backed by
  `v2/useSubscription.ts`. A failed status lookup is tracked as `unknown` and stays
  neutral rather than telling a paying subscriber to subscribe. Same rule in
  `v2/Pricing.tsx`.
  > **That gates the CONTROL, which is not the same as gating the PRICE**, and reading
  > it as the same shipped a live leak — see the store-billing section below. A price
  > printed in the *server component around* a gated widget is still a price in the
  > app. The native-gated surfaces are `v2/PricingSection.tsx` (the whole pricing
  > block — mounted on BOTH `/` and `/pricing`), `Pricing` (the two plan cards inside
  > it), `WatchCta`, `Explore`, `Settings`, `NewWatch`, and since 2026-08-01
  > `PricingLink` (the plans/upgrade block at the foot of the three app tabs) and
  > `AutoCartSettings` (its upgrade gate carries "$10/mo" on the web). Adding another
  > means gating it there too, not relying on this one. Audit with
  > `grep -rn '\$[0-9]\|/api/stripe' src/components/ 'src/app/(app)/'`.
  > **`v2/SubscribeCta.tsx` (added 2026-07-28) follows the same rule** and exists because
  > `/new` and the Explore guest box were dead ends: a visitor with no account, and a
  > signed-in user with no subscription, both saw an explanation and no button. Its
  > `useAccountGate()` returns `loading | ready | signedOut | needsSub`, and **`ready`
  > deliberately includes `unknown`** — the same "never tell a paying subscriber to
  > subscribe" rule as above. In the native app it renders Sign in / Create account or
  > `subscribeSentence()`, **never a price**.
- **`/api/subscription/status` now calls `syncUser(userId)` first** (2026-07-28). Without
  it, a user whose row had never been written read as "no subscription" — which is how
  every beta tester came to see "Start free trial" (see the admin/beta section). The
  probe is also the thing you reach for when diagnosing that class of bug, so it needs
  to provision before it answers, not after.
- **Provider descriptions are HTML** — 4,469 of the 8,013 catalog rows. Render them
  through `v2/richText.tsx`, which parses to blocks and emits text. Never
  `dangerouslySetInnerHTML`: it is untrusted third-party markup.
> **CONFIRMED FIXED — first post-fix nightly run, 2026-08-04 11:15 UTC:**
> **116,476 campsites, ZERO errors, 21.7 min.** That is one campsite *above* the
> best-ever clean baseline (116,475 on 07-24..27) against 105,713/1,028 errors the day
> before. The run is ~4 minutes longer than the old clean runs, which is the expected
> price of concurrency 8 plus retries — duration was never the pass criterion.
> Photos held at **3,775 of 4,469**, unchanged across a real write, so the
> `keepExistingPhotos` guard works.
>
> *(A note on GitHub's scheduler: this workflow's `0 9 * * *` cron consistently fires
> 1.5–3.5 hours late — observed starts 10:26, 10:27, 11:15, 11:22, 12:13 UTC. Anything
> checking its results must confirm a row for TODAY exists first, or it reports on
> yesterday's run and calls it a result.)*
>
> **THE MEDIA FETCH IS WHAT STARTED THE rec.gov 429s** (fixed 2026-08-04). Calling a
> second endpoint for every facility doubled the sync's request count the day it
> shipped, and `sync_log` dates the regression exactly: runs on **07-24..27 fetched all
> 116,475 campsites with ZERO errors** in 16-18 minutes; from **07-28** they went
> bimodal — ~105k campsites and ~1,000 errors on a good night, ~43k and ~6,200 on a bad
> one. **The bad runs are the FAST ones** (6 minutes against 18), which is the tell: the
> sync was not doing less work slowly, it was giving up early.
>
> **What the 429s cost was CAMPSITES, not campgrounds.** An earlier reading of this
> blamed them for the 675 rec.gov campgrounds with no campsite rows; that was wrong.
> 675 is the STEADY STATE — identical before the fix and after the clean 116,476-row
> run — because those facilities publish no CAMPSITE records in RIDB at all (sampled:
> Beavertail, Bad Medicine, Chukar Park, Starr Springs — real campgrounds, typically
> first-come-first-served with nothing reservable). A count that does not move between
> a broken run and a clean one was never measuring the breakage.
>
> Three changes, smallest lever first:
> - **Skip the media call for facilities that already have photos** — 3,775 of 4,469, so
>   nightly media calls drop to ~700. Campsites are the product; photos are decoration.
>   Rows WITHOUT photos are still asked every night, so a facility that gains one later
>   still picks it up.
> - **Retry with backoff** (`RIDB_ATTEMPTS`), honouring `Retry-After`, with JITTER —
>   without it every worker throttled in the same instant retries in the same instant
>   and rebuilds the burst. UseDirect got this on 2026-07-30 under "a 403 from these
>   WAFs means slow down, not never"; RIDB never did, so one 429 was a PERMANENT loss of
>   that facility's campsites.
> - **Concurrency 15 → 8** (`RIDB_CONCURRENCY`).
>
> **The skip nearly did something worse than the bug.** With no MEDIA the transform
> yields `photos: []`, and `photos = EXCLUDED.photos` would have erased 3,775 rows on
> the first run — silently, because an empty array is not an error. The first fix for
> that was a NULL param with `COALESCE`, and the test caught that **`campgrounds.photos`
> is NOT NULL**: the proposed INSERT tuple is rejected before the ON CONFLICT branch
> runs, so it would have failed every facility that HAS photos. It is an explicit flag
> (`keepExistingPhotos` → `CASE WHEN`) now. `worker/ridb-photos.test.mts` guards it, and
> distinguishes "we did not ask" from "we asked and RIDB has none" — collapsing those
> would freeze a stale photo set forever once media was withdrawn.

- **Campground `photos`: RIDB fixed 2026-07-27; the other 3,544 rows are still empty.**
  3,775 of 4,469 RIDB rows now carry photos (25,570 images, 6.8 per campground); the
  other 694 have no media in RIDB at all. Everything non-RIDB (UseDirect, GoingToCamp,
  ReserveAmerica, the state portals) is still `[]` and was never investigated — each
  portal needs its own look. The photo strip, `og:image` and JSON-LD `image` all read
  this column directly, so they light up per row with no UI change.
  > **Two silent bugs, and the second is the instructive one.** (1) RIDB serves media
  > from a **separate `/facilities/<id>/media` endpoint** — the facility search never
  > populates `MEDIA`, not even with `full=true` — and the sync never called it, so
  > `facility.MEDIA` was always `undefined`. (2) Even once fetched, the filter demanded
  > `MediaType === 'Photo'`; **RIDB labels every one of them `'Image'`**, verified
  > against the live API. An exact match on a vocabulary you don't control fails as an
  > empty array, never an error — so a first backfill run reported *1,880 processed, 0
  > photos, 0 failures* and nothing anywhere alarmed. `mediaToPhotos` in
  > `sources/ridb/transform.ts` is now the single definition (sync + backfill script
  > both call it) and matches a set case-insensitively, falling back to the URL
  > extension when `MediaType` is absent.

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
   opening it dispatches notifications. Branches by source; uses an atomic claim
   (`worker/claim.ts`) so it never double-alerts. The claim is **per (watch, SITE)**
   with a 1-hour window — see "Per-site alert cooldown" below; it was per watch until
   2026-07-30, which silently swallowed openings. All rec.gov reads go through ONE
   budgeted fetch lane (`worker/recgov-scheduler.ts`) with lead-time tiering — see
   the rec.gov entry under "Reservation sources" for the budget, sharding and
   capacity model.
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

1. **detect:<source>** — one real availability fetch per source succeeded. Cheap (no
   send), so it runs every `CANARY_DETECT_INTERVAL_MS` (120s).

   > **A CANARY MUST PROBE THE ENDPOINT ALERTING USES, NOT A NEIGHBOURING ONE.**
   > `detect:reservecalifornia` probed `/fd/unittypes` and `detect:goingtocamp` probed
   > the locations list — both CATALOG endpoints, neither on the path an alert depends
   > on. So on 2026-07-30, while RC's `/search/grid` was dropping ~40% of requests and
   > every RC watch went unchecked cycle after cycle, that canary sat green reporting
   > "146 unit types", because the catalog endpoint was genuinely fine. A canary on a
   > neighbouring endpoint is worse than none: it actively vouches for a path it never
   > touched. Both now call what the poller calls — `fetchGrid` for RC (asserting units
   > came back, since a 0-unit grid means the path is broken) and
   > `hasGoingToCampAvailabilityInRange` for GTC. Fixed 2026-07-30.
   >
   > This mattered more than the count suggests: **all active watches sit on two
   > sources**, so the most load-bearing detection canary was the mis-aimed one.
2. **delivery:email / delivery:sms** — Resend/Twilio actually **accepted** a synthetic
   send to `CANARY_EMAIL` / `CANARY_PHONE` (proves the last mile, not just detection).
3. **delivery:push** — the FCM service account still mints an access token
   (`verifyPushCredential` in `src/lib/notifications/push.ts`). No synthetic send (there's
   no canary device), but this catches the push last mile failing silently if
   `FCM_SERVICE_ACCOUNT` is removed/malformed or the key is revoked. Skipped (warn, not
   page) until FCM is configured, like the other two. Also listed in the `/api/health/status`
   delivery loop, so it pages the same way.
4. **poller.shards / poller.capacity** (in `/api/health/status` directly, not canary
   rows — added 2026-07-31/08-01). `poller.shards` FAILS on an unheld shard index:
   those campgrounds are polled by NOBODY while every other check stays green.
   `poller.capacity` compares distinct rec.gov campground-months across active
   watches to machines × `RECGOV_MONTHS_PER_MACHINE` — warn AT capacity ("clone a
   machine now"), fail OVER it, because over-capacity merely makes everything
   slower, which no other check would ever notice. Details in the rec.gov
   fetch-lane block under "Reservation sources". The user-facing outage banner in
   `WatchesList` reads only `detect:*` fails, so neither of these can leak a wrong
   banner to users.

> **STALENESS THRESHOLDS LIVE IN ONE FILE: `src/lib/health-thresholds.ts`.** They were
> in three, and they disagreed. `worker/fly.toml` runs the delivery canary every 24h;
> `/api/health/status` hardcoded 7h; and `AdminTabs.canaryLevel` hardcoded its own 7h
> with a comment claiming "delivery canaries run hourly". So for ~17 hours out of every
> 24 the admin banner announced "3 things need attention — delivery:email is failing,
> delivery:push is failing and delivery:sms is failing" about three canaries whose last
> recorded result was SUCCESS. A dashboard that cries wolf daily trains its only reader
> to ignore it, which is worse than not having one. Plain constants, not env reads: the
> worker's config is invisible to Vercel, and a value resolving differently on the
> server and in the client bundle is how the drift started. **Change the cadence in
> `worker/fly.toml`, change it there too.**
>
> **Two tiers for DELIVERY only.** Late (`>1.15x` interval) is a warning; stopped
> (`>3x`) is a red banner — with a single threshold you must choose between crying wolf
> daily and never reporting a canary that quietly died. **Detection gets no second
> tier: stale IS dead.** Writing one showed it would make the banner LESS sensitive
> than `/api/health/status`, which fails outright on a stale detect canary, about the
> canaries that matter most — detection stopping means openings are never noticed at
> all.

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
   > **THE ROSTER IS OFF as of 2026-07-30 — accrual has STOPPED.** 502 targets × 2 lead
   > windows is ~24,000 probes/day, and the **327 UseDirect ones each cost a Vercel
   > function invocation** through `/api/rc-proxy` (~15,700/day — on par with the entire
   > watch poller) to feed a signal `SHOW_LIKELIHOOD` keeps hidden from every user.
   > Two switches, both must flip to resume: `PROBE_ENABLED` in `worker/fly.toml`
   > (default `false`; the poller logs `probe roster OFF` at startup) **and**
   > `probe_targets.active`, set `false` on all 502 rows so accrual stopped the same
   > hour with no deploy. Both exist on purpose — the flag is what stops a re-run of
   > `seed-probe-targets.ts`, which sets `active = true`, from silently restarting it.
   > The 137k observations already collected are untouched.
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

> **⏸ AS OF 2026-07-30 THE WHOLE FEATURE IS PAUSED — display AND collection.** The
> paragraph below describes the display pause; the roster stop is above (`PROBE_ENABLED`
> + `probe_targets.active`). Restarting means flipping BOTH, and the roster needs weeks
> of lead time to refill buckets — so turn accrual back on well before you plan to show
> anything.
>
> **⏸ THE DISPLAY IS PAUSED (2026-07-23) — data collection was NOT, until now.** All three UI
> surfaces (per-watch "% chance for your dates" on the watch card, result-card badge,
> and the detail-page "How often it opens up" ladder) are hidden for now: with limited
> history too many read a discouraging **0% / "rarely opens up"**, which lands as "no
> hope" rather than "not enough data yet". The recorder/aggregation/APIs are untouched
> and still accruing, so restoring is cheap.
>
> **Post-rewrite this is ONE switch: `SHOW_LIKELIHOOD` in
> `src/components/v2/likelihood.ts`** (2026-07-27). It used to be a flag in
> `campground/[id]/page.tsx` plus two commented-out blocks you had to grep `is hidden`
> to find — the rewrite consolidated all three surfaces onto the single constant, which
> `v2/ResultCard.tsx` and `v2/WatchCard.tsx` both import. Flip it once the buckets are
> dense; `/api/likelihood` needs no change.
>
> **Check the 4-7 day bucket before flipping it.** The roster probes at leads of 14 and
> 45 days, so the short-lead bucket a "this weekend" searcher cares about is EMPTY —
> turn the display on today and the ladder ships with a hole in the most-viewed row.
> Widen `PROBE_LEAD_DAYS` and let it accrue first.

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
  > **`dispatchPush` used to record status `'sent'` unconditionally**, discarding
  > `sendPush`'s result — so an unconfigured FCM (`{sent:0}`, logging a line nobody
  > reads) or a batch where every token was dead both landed in `notifications` as a
  > delivered push. Fixed 2026-08-01 after it cost a debugging session: a device sat with
  > nothing on its lock screen while the table asserted success. The row now carries the
  > true outcome and every dispatch prints `N/M token(s) accepted`. Same family as the
  > green build that emitted an unsigned APK — the expensive failure is the one that
  > reports success.
  > **STILL OPEN: there is no `notificationReceived` listener.** `NativeBridge` handles
  > `tokenReceived` and `notificationActionPerformed` (tap) only. On Android, a push
  > arriving while the app is in the FOREGROUND is handed to the app instead of drawn by
  > the system, and nothing listens — so an open app shows nothing. That is a real gap
  > for someone actively hunting a campsite. Fixing it properly needs
  > `@capacitor/local-notifications` (a native plugin, so `npm install` + `cap sync` +
  > a REBUILD); an in-app banner would be web-side and instant.
  > **Android push delivery is UNVERIFIED end-to-end.** On 2026-08-01 a real device
  > registered a token, FCM accepted every message with zero errors, the `delivery:push`
  > canary was green, notification permission was granted, DND was off and the app was
  > backgrounded — and no notification appeared. iOS push was verified on real hardware
  > (see `docs/APP-STORE.md`); Android has never been. Next step is a direct send to a
  > known token, reading FCM's raw per-token response.
- **Store-billing: Stripe stays web-only** (Apple/Google forbid selling a digital sub
  outside their IAP). The app shows no price/buy button — a non-subscriber sees "manage
  at camphawk.app". Enforced by a native flag: Capacitor appends `CampHawkApp` to the
  webview UA, and `NativeAppProvider` (`src/lib/native/context.tsx`) reads it
  **client-side** (`useSyncExternalStore`) and gates `v2/Pricing.tsx` / `v2/WatchCta.tsx`.
  > **The flag is read CLIENT-side, and MUST stay that way.** The first version read the
  > UA in the root layout via `await headers()` for a flash-free server render, and it
  > **500'd every page in production** (2026-07-24 outage; `/api/*` stayed up because it
  > has no root layout, and `next build` stayed green because dynamic segments don't run
  > at build).
  >
  > **Correction, 2026-07-27: this was previously attributed to Cache Components
  > (`dynamicIO`). That flag is NOT enabled — `next.config.ts` sets no such option, it
  > only wraps the config in `withSentryConfig`.** The mechanism was never actually
  > root-caused; what is established is the empirical result above. The prohibition
  > stands on that evidence, not on the explanation — so don't go checking the flag,
  > find it off, and conclude the rule is obsolete.
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
- **Steering out to camphawk.app is BUILT BUT OFF** — `NATIVE_LINKOUT = false` in
  `src/components/v2/nativeSubscribe.tsx` is the single switch (2026-07-27). Both stores
  were forced to drop anti-steering, **in the US only**: Apple guideline 3.1.1 (updated
  May 2025 for the *Epic v. Apple* contempt ruling — no entitlement needed on the US
  storefront) and Google Play (Ninth Circuit upheld the *Epic v. Google* injunction
  Sept 2025; terms run to Nov 2027). **Outside the US the ban still stands, and shipping
  this UI to a non-US storefront is a review failure that can reportedly cost the
  entitlement.** Device locale is NOT a storefront check. Flip the switch only once app
  availability is restricted to the United States in App Store Connect and Play Console.
  **iOS side of that precondition is DONE (2026-07-30): App Store availability is set to
  United States only, price free.** So on iOS this is now purely a decision to flip, and
  the natural moment is when the approved version is manually released. Play Console has
  **not** been restricted yet — do that before an Android release, not after.
  Wired into all five non-subscriber surfaces (`PricingSection`, `WatchCta`, `Explore`,
  `Settings`, `NewWatch`), never shown to an active subscriber. Because the switch lives
  in web code and the app is a webview, turning it off is a push to master, **not an app
  release** — which matters while the law is still moving.
  - The link carries **`data-native-external="true"`**, which `NativeBridge` honours by
    forcing the system browser. Without it the tap would navigate the shell to our own
    marketing page, which renders the native variant with nothing to buy. `?from=app`
    makes the funnel measurable.
- **A UA-marker check is only as current as the installed binary.** `appendUserAgent` is
  compiled into the app, so a build made before that config shipped detects as *web* and
  every gate above silently fails. Diagnostic: if the app shows the **buy buttons**, not
  just the price, the UA marker is missing and the binary needs rebuilding — gating
  changes on the web won't reach it.
- **Back button + external links (`NativeBridge.tsx`, added 2026-07-27):**
  - **Android back.** Capacitor's default with no `backButton` listener is to **exit the
    app on any back press, from any screen** — two taps into a campground, back closes
    the app. Now: go back if there's history; else return to `/search`; only a back press
    on `/search` exits. iOS has no hardware back, so it's Android-gated.
  - **Off-origin links go to the system browser** via `@capacitor/browser`, delegated from
    a capture-phase document listener so it catches links mounted at any time. Booking
    links opened *inside* the shell trap the user with no way back — and that's the
    conversion path the whole product exists to complete. A checkout URL rendered in-app
    also reads as in-app purchasing to a reviewer. **camphawk.app and Clerk hosts are
    excluded** — sending auth to the system browser would strand the session outside the app.
  - **Same-origin `target="_blank"` is taken over too.** A webview has no tabs, so `_blank`
    opens an empty popup or nothing at all; the Terms/Privacy links in the SMS consent
    block are written that way and are consent copy the user must be able to read.
- **Push permission is asked LATE, on purpose (2026-07-27).** It used to prompt on the
  first signed-in load — the worst moment, because the user has no watches and no idea
  what we'd notify them about, so the honest answer is no. On iOS that answer is
  effectively **permanent** (the system dialog is one-shot), and push is the product.
  Now: if permission is already granted we just register the token; if it's still
  `prompt` we ask either when a watch is created (`NewWatch` dispatches the
  `camphawk:watch-created` window event, a no-op on web) or on load if the user already
  has watches. The `/api/watches` check runs at most once per install — after either
  answer the state is no longer `prompt`.
- **Offline has two paths, and they're different problems (2026-07-27).**
  - **Cold start, no network:** `server.errorPath: 'index.html'` serves the bundled
    `native/shell/index.html` instead of Chrome's dinosaur / a bare WebKit error string.
    That page must stay **fully self-contained** — no font, image or stylesheet fetch —
    since it renders precisely when fetches fail.
  - **Connection drops after the site has loaded:** `NativeOffline.tsx`, a bottom banner
    mounted in the root layout. Deliberately **not** a takeover: whatever the user had
    on screen still works, and blanking it to announce the network destroys the only
    thing that still functions. Both surfaces say the same reassuring, true thing —
    watching runs on our servers, so nothing was missed.
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
- **Android: rebuilt and signed 2026-07-28, still untested on hardware.** Codemagic now
  produces a **signed** release APK off current `master`, so it carries
  `@capacitor-firebase/messaging` and the branded icon. Getting there took four failed
  builds — see the `codemagic.yaml` notes: this billing plan can schedule **no Linux
  instance at all** (`mac_mini_m2` is the one that works), Capacitor 7 needs **JDK 21**,
  and `android_signing` fetches the keystore but does **not** make Gradle use it, so a
  green build happily shipped an unsigned APK until an explicit verify step was added.
- **iOS: SUBMITTED for App Store review 2026-07-30**, build 5, release set to
  **manual** so approval does not go live. Privacy label published, US-only availability,
  screenshots in all three size boxes. Everything Apple asked for is recorded in
  `docs/APP-STORE.md`; the likely rejection to argue rather than code around is
  **3.1.3(b)**, and the reply is the review notes in §2 of that file.
- **LEFT:** **Google Play** identity verification (ID upload) + **device verification
  (needs a real Android device — emulator fails Play Integrity)**, which is the only
  thing now blocking Android. On iOS going live, flip `NATIVE_LINKOUT` (below).

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

## Account deletion (added 2026-07-28)

`/settings` → **Delete account** (`v2/DeleteAccount.tsx`) → `POST /api/user/delete`.
Built because **Apple guideline 5.1.1(v)** requires an app offering account creation
to offer deletion from inside the app, and there was no deletion path at all — a
certain App Store rejection. Clerk-authed, so it is deliberately NOT in
`isPublicRoute`.

> **THE ORDER IS LOAD-BEARING, and getting it wrong bills a deleted customer.**
> Cancel Stripe → delete the Clerk user → delete our row. Every user-owned table is
> `ON DELETE CASCADE` from `users`, so deleting that row takes `subscriptions` with
> it — **and the `stripe_subscription_id` along with it.** Delete first and the
> subscription keeps charging someone whose account no longer exists, with no record
> left to find it by. That was the live state of things before this route existed:
> the `user.deleted` webhook has always removed the data and has **never** touched
> billing, so enabling Clerk's built-in "delete account" toggle alone would have
> shipped exactly that bug.
>
> If Stripe fails, the route aborts and deletes **nothing** — a user who keeps their
> account is recoverable; a deleted account still being charged is not.

- **Cancellation is IMMEDIATE** (`subscriptions.cancel`), not at period end, and the
  remainder of the paid period is **not refunded**. Cancel-at-period-end would leave
  a live subscription attached to a user who no longer exists. The UI states this in
  bold *before* the button is pressed — that sentence is not decoration, it's what
  stops a chargeback and it's what a reviewer looks for.
- **The row is deleted directly as well as by the webhook.** Both are idempotent.
  Waiting on Svix delivery would mean the data is still there if someone checks
  immediately after deleting, which is exactly what a reviewer does.
- **Two-step confirm, not a typed confirmation.** Apple wants deletion genuinely
  reachable; a "type DELETE to continue" gate reads as obstruction. It is also its
  own `/settings` section rather than buried inside "Account", so a reviewer finds it.
- **Verified end-to-end 2026-07-29** on a throwaway account with a real subscription —
  Stripe showed `canceled`, the `users` row was gone, Clerk had zero accounts, and the
  admin counts moved 12 → 11 and 2 → 1. Re-signup with the same email works afterwards.
  This could not be tested from a sandbox before, because the route destroys the account
  it runs on; treat the same way if the order ever changes.

## Free-trial eligibility is checked in STRIPE, not our DB (2026-07-30)

`/api/stripe/checkout` decides whether to attach `trial_period_days: 7`. It used to
ask "does this `user_id` have a `subscriptions` row?" — and `user_id` is exactly what
account deletion destroys. Deletion cascades `subscriptions` away and Clerk issues a
fresh id on re-signup, so **the one row proving "already had a trial" is the one thing
guaranteed to be gone.**

Not hypothetical: one address drew two 7-day trials seventeen minutes apart, leaving
two Stripe customers, one `canceled` and one `trialing`, with identical trial dates.

Stripe is the source of truth now. We cancel the SUBSCRIPTION on delete but never the
CUSTOMER, so a prior trial stays visible keyed by email rather than by an id we throw
away. **`status: 'all'` is essential** — the giveaway subscription is normally
`canceled` by the time someone tries again, which the default listing hides.

- **This stores nothing new on our side.** The data is already Stripe's as our
  processor, so *"deleting your account deletes your data"* stays true — which matters
  because that sentence is in the App Store review notes and on `/privacy`. A local
  "prior trials" ledger would have contradicted it.
- **On a Stripe error it ALLOWS the trial.** Denying a genuine first-time subscriber
  because Stripe blipped is worse than the alternative, and exploiting the gap needs a
  delete-and-resignup timed to a Stripe outage.
- Checkout also **reuses an existing customer** instead of passing `customer_email`,
  which minted a new one per checkout — the reason that address had two.

## Subscription plans & the Auto-Cart tier (2026-08-01)

Two plans: **Alerts** ($2.50/mo, $20/yr — the original subscription) and **Auto-Cart**
($10/mo, $50/yr — everything in Alerts plus the auto-cart lane). Priced against
Campsite Tonight ($29.99/mo, $59.99/yr on the App Store at the time). The 7-day
first-timer trial applies to either plan.

- **Schema** (migration 032): `subscriptions.tier` (`'base' | 'autocart'`) and
  `subscriptions.grandfathered`. Every row that existed at apply time got
  `grandfathered = true` — pre-tier subscribers were sold "auto-cart included" under
  the keep-your-rate promise, and they keep exactly that for as long as that
  subscription runs. **The webhook never writes `grandfathered`**, so a renewal event
  (whose price maps to 'base') cannot strip it. A grandfathered subscriber who cancels
  and resubscribes gets a new row, born `grandfathered = false` — the promise is
  scoped to the subscription, which is how the copy words it.
- **Tier is DERIVED from the Stripe price id on every webhook event**
  (`src/lib/stripe-plans.ts` maps `STRIPE_PRICE_ID_AUTOCART_MONTHLY/_YEARLY`; anything
  else → 'base'). An unknown price failing to 'base' is deliberate: "paying premium,
  treated as base" surfaces as a complaint; "free premium" never surfaces at all.
  Prices are referenced **by env id, not looked up by API** — the live Stripe key is a
  RESTRICTED key with no product/price read or write (verified: `prices.retrieve`
  403s), so the prices were created in the dashboard by hand. If either env var
  disappears, `autocartPlanConfigured()` goes false and the plan quietly de-lists
  (signed-in cards hide, checkout 503s); the signed-out marketing copy is deliberately
  NOT gated on it (signed-out visitors never fetch subscription status).
- **Entitlement** = active/trialing AND (`tier = 'autocart'` OR `grandfathered`), OR
  `users.is_beta`. One definition (`lib/auth.hasAutocartEntitlement`, an EXISTS —
  never "latest row", which depends on ordering trivia), enforced in FOUR places:
  the toggle API (`POST /api/user/autocart` 403s on enable; **off is always
  allowed**), the bot roster feed (an unentitled user drops out entirely — the
  per-user session keepalive is the mini-PC's scarce resource), and the poller's
  `isAutocartLane` (a lapsed premium user keeps `autocart_enabled = true` in
  settings, so the flag alone would keep swallowing their openings into a lane the
  bot no longer serves — they fail open to normal alerts).
- **Upgrades for existing subscribers go through `POST /api/stripe/plan`** — an
  in-place price swap on the live subscription, prorated. NEVER a second checkout:
  that mints a second subscription next to the first and double-bills. Every upgrade
  surface (AutoCartSettings' two-step confirm, the homepage subscribed block, the
  PricingLink nudge) routes to `/settings` for exactly this reason; `/pricing`'s
  checkout buttons are for non-subscribers.
- **Webhook robustness**: checkout now stamps `clerk_user_id` into
  `subscription_data.metadata` (the SESSION metadata alone never reaches
  `customer.subscription.*` events), and the webhook falls back to matching by
  `stripe_subscription_id` for legacy subscriptions whose events carry no user id —
  without that fallback, a pre-2026-08-01 subscriber's cancellation or plan change
  never landed in our table.
- `/api/subscription/status` returns `autocart` (entitlement) and
  `autocartPlanAvailable` (env configured) alongside `active`/`everSubscribed`;
  `v2/useSubscription.ts` exposes all four.

## Sign-up onboarding — the welcome step (migration 034, 2026-08-01)

Everything an account needs is asked once, immediately after it's created: email-alert
opt-in, an optional phone number with SMS consent, and — for someone already entitled —
the one-time Recreation.gov sign-in for auto-cart.

- **WHY IT IS A SEPARATE STEP AND NOT FIELDS ON THE SIGN-UP FORM.** Clerk's `<SignUp/>`
  is a prebuilt widget and takes no arbitrary fields. Adding a phone box inside it would
  mean abandoning Clerk's hosted flow and with it the password rules, bot protection and
  email verification. So `AuthPanel` sets `forceRedirectUrl` to `/welcome`, and the
  original destination rides along as `?next=` — `forceRedirectUrl` OVERRIDES Clerk's own
  `redirect_url` handling, so without that the user is stranded away from whatever they
  were doing. Sign-IN is untouched; an existing account has already answered.
- **Stripe's checkout `success_url` returns to `/welcome` too**, so a fresh Auto-Cart
  subscriber gets the Recreation.gov sign-in immediately rather than discovering it in
  Settings later. The auto-cart block renders only when entitled AND not yet connected —
  showing "set up auto-cart" to someone who hasn't bought it is an ad dressed as a setup
  step.
- **Schema** (034): `users.email_alerts_opt_in` (default true, backfilled true so no
  existing subscriber silently loses alerts), `users.sms_consent_at` (per-subscriber
  consent evidence, backfilled from `created_at` for numbers already on file), and
  `users.onboarded_at` so the step is shown once whether finished OR skipped.
  `getUserEmail` in `lib/notifications` returns null when the user opted out, so the
  choice actually suppresses alert email — canary and transactional mail don't route
  through it, so an opt-out can't blind the alert-health canary.

> **THE A2P POSITION CHANGED HERE, AND THE PUBLIC PAGE HAD TO CHANGE WITH IT.**
> `/sms-opt-in` — the page carrier and campaign reviewers read — previously stated the
> phone number and SMS consent were "**not** part of sign-up". Putting the form on the
> welcome step made that false, so the page now describes both locations honestly.
>
> The substance is unchanged and load-bearing: `/welcome` renders the SAME `SmsAlerts`
> component as `/settings` and `/sms-opt-in`, so the approved consent script has exactly
> one source and cannot drift; the consent box is unchecked; saving a number is a
> separate deliberate action; and **Skip is always available** — no field on the step
> gates account creation, which is what "consent is not a condition of purchase" has to
> mean in the flow and not just in the sentence.
>
> **If it ever becomes required, the A2P campaign description must change first.** The
> registered description with Twilio should also be updated to match this flow.

## RLS (migration 027, 2026-07-30)

`action_tokens` and `alert_canary` had none. **No policies were created, deliberately:**
RLS with zero policies denies anon and authenticated outright while `service_role` has
`BYPASSRLS`, and every reader goes through the server-side admin client. A permissive
policy added "so it keeps working" would undo the point.

Supabase's advisor overstates the severity — it assumes a published anon key, and this
project has none (`src/lib/db/client.ts` is the only `createClient` call, no anon JWT
reaches the browser bundle, PostgREST 401s without a key). Worth closing anyway: the
day someone adds a browser Supabase client, both tables become world-readable AND
world-writable with no further mistake. **`action_tokens` is the one that matters** —
those tokens ARE the authorisation for `/manage/<token>` and every one-tap
stop/reopen link, which carry no other credential.

> **`spatial_ref_sys` is deliberately left alone** and will keep appearing in the
> advisor's list. It is PostGIS's own coordinate-system reference data — public
> standards, no user content, owned by the extension, and `ALTER TABLE` needs
> superuser. Expected and accepted, not an outstanding item.

## UseDirect / RDR resilience (2026-07-30)

`src/lib/sources/reservecalifornia/client.ts` backs ReserveCalifornia, Arizona,
Virginia and the other UseDirect states. rec.gov had a throttle breaker for months;
**this client had nothing** — no retry, no backoff, no timeout, no detection. That is
how every RC fetch could fail on every 15-second cycle indefinitely, taking 10 of 15
active watches with it, while the identical request answered 200 from another IP.

**What was actually wrong, measured rather than guessed:**

- **ReserveCalifornia's RDR API is simply flaky.** 20 identical requests — same body,
  same headers, seconds apart, one machine — returned nineteen 200s and one 500.
  Facility 767 for the same dates returned 200 twice then 500 on the third try. It is
  not our IP, not the date range, not our User-Agent. **RETRY is the fix**, and there
  was none: every blip was a watch silently not checked that cycle.
- **A 403 from these WAFs means "slow down", not "never".** Virginia's catalog sync
  got 403 on 83 grid calls and 200 on 193 others, in ONE run from ONE address; a hard
  IP block fails all of them. 30 back-to-back grid calls from an unthrottled address
  returned 200 thirty times, so it is a per-IP burst limit expressed as 403 rather
  than 429.

**What the client does now:**

- **Retry** (`UD_ATTEMPTS`, 3) with jittered backoff — `UD_RETRY_BASE_MS` (250ms), and
  **8x that for a 403**, because a rate limit needs real time where a flaky 500 needs
  only another go. Measured effect in production: 12 retries absorbed against 1 hard
  failure in one ~2-minute window, where it had been ~4 hard failures per 15s cycle.
- **A per-PROVIDER breaker** (`UD_BREAKER_TRIP` 4, `UD_BREAKER_COOLDOWN_MS` 60s), keyed
  on `provider.source` — California, Arizona and Virginia are different hosts behind
  different WAFs, so a CA throttle must not blind AZ.
- **`UD_TIMEOUT_MS`** (15s). There was no timeout at all, which made this client a
  candidate to cause the "timeout cascade" documented for rec.gov.
- **Breaker outcomes are recorded once per logical call**, after retries are exhausted
  — never per attempt, or ordinary flakiness would walk the breaker toward opening.

> **IT THROWS RATHER THAN RETURNING EMPTY** — the deliberate difference from the
> rec.gov breaker, whose callers read empty as "unknown". An empty RC grid is
> indistinguishable from "fully booked", and this client also backs the user-facing
> search page, so short-circuiting to empty would render a live campground unavailable
> and could swallow a real opening.

> **Only genuine back-off signals trip it: 429, 403, any 5xx, timeouts.** The 5xx rule
> started as `>= 502` on the theory that a 500 might be our own bad request — wrong,
> and the live logs said so within one poll cycle, since RC's actual failure IS a bare
> 500. Everything else in the 4xx range is our request being wrong; retrying cannot fix
> it and it must never open the breaker.

**`/api/rc-proxy` reports the real upstream status.** It collapses every non-ok
upstream into a flat 502, and used to put the status only in a string; the worker then
logged its own 502 and discarded the body. The one fact identifying the cause reached
neither side's logs. It now returns `upstreamStatus` plus a slice of the upstream body
AND `console.error`s it, which lands in Vercel's runtime logs where the worker cannot
reach. The worker appends that body to the error it throws.

## Empty is not "booked" (2026-07-31)

`getAvailabilityFromRecGov` returns empty campsites for three different situations:
rec.gov said there is nothing, rec.gov refused us (429), and our own breaker
short-circuited without asking. `hasAvailabilityInRange` collapsed all three into
`false`, and `/api/search` renders `false` as **fully booked**. So during a throttle the
search page confidently told users that live, bookable campgrounds were full.

Demonstrated on production while load-testing this: 15 Moab campgrounds all reported
booked for a Tuesday night in November, while rec.gov asked directly from another IP
reported 5 of 6 sites free at the first one.

- `CampgroundAvailability.unknown?: boolean` marks a read we never actually got.
- `hasAvailabilityInRange` returns **`boolean | null`**. Finding availability is positive
  proof and stands even if another month failed; NOT finding it only means something
  when every month was actually read.
- `/api/search` already mapped a nullish check to "unknown" (it does this for the
  GoingToCamp worker path), so the search page needed no change — it renders unknown.
- **The same bug lived in two more places** and is fixed in both: the feature-E probe
  recorder would have stored unknown as `hadOpening: false`, poisoning the likelihood
  buckets with throttle noise; and `scripts/seed-probe-targets.ts` counted unknown as
  "booked solid = high demand", which would seed probe targets on the strength of a rate
  limit. Its own `catch` comment already said "transport error → don't treat as demand".

> **The ReserveCalifornia client has always refused to do this** — it throws rather than
> returning empty, and the comment explaining why explicitly names the rec.gov breaker as
> the counter-example that gets it wrong. The rule was written down and simply never
> applied to rec.gov. When adding a provider: an empty result and an unknown result must
> not share a representation.

### Routing rec.gov through Vercel: investigated and REJECTED (2026-07-31)

The idea was to give the Fly worker's rec.gov calls a Vercel egress the way
`/api/rc-proxy` does for UseDirect, since the breaker only ever tripped on Fly. **The
premise is false.** Driving ~1,000 requests/minute at rec.gov through the public
`/api/search` endpoint tripped the breaker on Vercel inside one round (round 1: 79 of 258
campgrounds available; rounds 2 and 3: 0 of 258). Vercel is not immune, just less loaded.

Two reasons not to do it, beyond that:
- **It couples two failure domains that are currently separate.** Vercel's rec.gov lane
  is shared with the search page. Today a throttled Fly worker degrades alerting only;
  merging the lanes means one rate limit degrades search *and* alerting together.
- The failure is silent and wrong rather than loud — see "Empty is not booked" above,
  which is exactly what the load test surfaced on the live site.

Don't revisit without new evidence. The remaining honest options are a different egress
IP for the worker (a same-region Fly failover was already tried on 2026-07-22 and did
**not** escape the throttle) or accepting a lower rec.gov poll rate.

**`/api/rc-proxy` TAKES A BATCH** (2026-07-30). It forwarded exactly one RDR request
per invocation while sitting on the hot path of a 15-second poller: 11 RC fetches a
cycle is ~63,000 Vercel function invocations a day for 16 watches — the largest single
line in the usage bill, and most of the 1.44M invocations on the Jul-25 cycle.

- **Wire shape:** `{ base, requests: [{path, method, body}, …] }` → `{ results: […] }`
  in request order, each `{ok, status, data, error, upstreamStatus, detail}`. A
  disallowed path or a failed upstream is THAT ITEM's result, so one bad request cannot
  fail the other N-1, and the response is **200 even when items failed** — a 502 would
  tell the caller nothing about which one.
- **The single-request shape still works, in both directions.** Vercel and Fly deploy
  from the same push and can land either way round, so the proxy still understands a
  bare `path`, and the client (`sendProxyBatch`) latches to singles for the life of the
  process if the proxy answers a batch with **400** — exactly how the pre-batch handler
  rejects it, since it looks for a top-level `path`. Only 400 latches; a 500 is an
  ordinary failure the retry loop owns.
- **Coalescing is client-side**, in `reservecalifornia/client.ts`: requests landing
  within `UD_BATCH_WINDOW_MS` (40ms) for the same RDR base go up together, **deduped on
  method+path+body** — two subscribers watching the same campground for the same dates
  send byte-identical grid POSTs every cycle. It sits below `rdrFetch`'s retry loop, so
  a retry just joins the next batch and the breaker sees what it always saw. Batch size
  is bounded by the CALLER's fanout, not the window: the poller runs RC watches through
  `pMap(4)`, so a cycle costs **3 invocations instead of 11**. A queue of one is sent as
  a single — same cost, wider compatibility.
- **THE CATALOG SYNC OPTS OUT** (`coalesce: false`, 2026-07-30). "Upstream load is
  unchanged" counted REQUESTS and missed per-IP RATE: N separate invocations can be
  spread across N Vercel lambdas, but one batch is N requests from a single lambda IP,
  and these WAFs meter per IP. Batching pays for itself only on the poller's hot path
  (63,000 invocations/day); the nightly sync is a few hundred calls once a day — ~200
  invocations saved out of 63,000 — while being exactly the shape that makes
  concentration dangerous. Nothing to gain, a real way to lose. The poller and the
  search page still coalesce.
- **Do not "optimise" FANOUT upward** — the proxy paces a batch at `FANOUT = 2`, lower
  than the 4 the poller runs. Batching must not become a way to hit these WAFs harder.

**Requests present as the providers' own booking site** (`rdrRequestHeaders` in
`providers.ts`) — full Chrome UA, `Accept-Language`, `sec-ch-*`, and Origin/Referer
derived PER PROVIDER from its `parkUrl`, so Virginia gets `reservevaparks.com` and not
a hardcoded Californian pair. An unknown host gets the headers with no Origin/Referer,
since a mismatched pair is worse than none. Previously it announced itself as
`Mozilla/5.0 (compatible; CampsiteFinder/1.0)`, which is trivially filterable. This did
NOT fix the 403s on its own — it was aimed at a wrong diagnosis — but presenting like
the real client is correct regardless.

**The UseDirect catalog sync runs its grid pass at concurrency 2** (was 5,
`UD_SYNC_CONCURRENCY`). Five in flight across a few hundred facilities is a sustained
burst from one address, which is what provokes the limit. A facility whose grid call
fails syncs ZERO campsites, so going fast cost campsite-level detail — site types,
hookups — on real campgrounds.

> **The sync WAITS OUT an open breaker; the poller does not** (`breakerWait`,
> 2026-07-30). Failing fast is right for the poller — it retries in 15 seconds — and
> catastrophic for the sync, which has hundreds of facilities queued behind it.
> Illinois' 2026-07-30 run is the proof: four consecutive 403s opened the breaker for
> 60s, and the sync then tore through its remaining 278 facilities in **34 seconds**,
> each throwing instantly against a cooldown nobody was waiting for. 282 campgrounds,
> **0 campsites**. Now the sync sleeps out the cooldown (jittered, so piled-up waiters
> don't resume in lockstep) against a per-run budget, `UD_SYNC_BREAKER_WAIT_MS`
> (default 5 min). The budget is charged per WAITER, not per cooldown, so at
> concurrency 2 it buys two or three 60s waits — conservative on purpose. Past the
> budget it fails fast again, so a host that is genuinely blocking costs +5 minutes,
> not cooldown × facilities (2.3 hours for Illinois). The run logs how much it spent
> and says `BUDGET EXHAUSTED` when the tail failed fast.
>
> Nothing is lost when a grid call fails — campsites are upserted, never deleted. The
> cost is stale campsite detail (site types, hookups) for that facility, not a missing
> campground.

> **Fly CANNOT reach the California RDR host at all** — three attempts, all
> `TimeoutError`, from the worker's own egress. Virginia 403s Fly too. This is why
> `/api/rc-proxy` exists and why "just call it directly from the worker" is not an
> option; tested 2026-07-30, not assumed.

## Per-site alert cooldown (migration 026, 2026-07-30)

The claim that decides "may we alert for this?" lives in **`worker/claim.ts`**, keyed
on **(watch_id, site_key)** in `watch_site_alerts`, with a 1-hour window.

It used to be one timestamp per watch (`watches.notification_sent_at`), and that was
wrong in a way nobody could see. The FIRST site to open silenced every OTHER site on
that watch for an hour. Observed live: site 008 alerted at 23:17, site 015 opened
minutes later, the user heard about it at 00:19 — and went looking to find it still
sitting there open.

**The sharper half was auto-cart.** Both lanes share this claim, and the watch was
dropped from the candidate query outright rather than merely having its notification
suppressed — so no `autocart_jobs` row was ever queued for the second site. The
opening was not just un-announced, it was never carted.

- `site_key` is the provider's campsite id where one exists (rec.gov/RIDB,
  ReserveCalifornia units). **ReserveAmerica, GoingToCamp and TN/SC report
  campground-level availability with no site id**, so they collapse onto a `'*'`
  sentinel and keep exactly the old per-watch behaviour — correct for them, since "a
  site opened" is all those sources can tell us.
- **The candidate query no longer filters on `notification_sent_at` at all.** A watch
  that is never CHECKED cannot reveal that a different site opened, which is what made
  the second site invisible. Steady-state load is unchanged: the candidate set is now
  "every active watch", which is what it already was whenever nothing had alerted.
- `notification_sent_at` is still stamped, because `WatchCard` renders "last alerted"
  from it and the Campflare webhook still dedupes on it.
- Atomicity is one statement — INSERT .. ON CONFLICT .. WHERE — so two cycles racing
  the same pair cannot both win. `worker/claim.test.mts` pins that with 8 concurrent
  claims expecting exactly one winner.

## SMS delivery receipts (migration 038, 2026-08-05)

**`notifications.status = 'sent'` has never meant the text arrived.** It means Twilio's
API returned 2xx — we handed the message over. Carrier rejection, an unreachable
handset, A2P filtering and a landline all happen seconds to minutes later, and every
one of them left a row saying `sent` next to a phone that stayed quiet. The user hit
exactly this on 2026-08-05: email and push arrived for a Leo Carillo opening, the text
did not, and nothing in our own data could tell a dropped message from a slow one.

Migration 038 adds four nullable columns to `notifications`, with **no backfill** — a
pre-038 row genuinely has no delivery information and inventing `delivered` for it
would poison the first metric anyone computes:

| column | what it holds |
| --- | --- |
| `provider_id` | the Twilio Message SID (`SM…`) — the key the callback arrives with |
| `delivery_status` | Twilio's own vocabulary, verbatim: `queued`/`sending`/`sent`/`delivered`/`undelivered`/`failed` |
| `delivery_error` | Twilio error code + message (30003 unreachable handset, 30007 carrier violation, …) |
| `delivered_at` | when the terminal status landed |

**`status` and `delivery_status` are deliberately two columns.** `status` records what
WE did (handed it over, or didn't); `delivery_status` records what the CARRIER did.
Collapsing them destroys the only distinction that makes any of this useful.

### The pieces

- **`lib/notifications/sms.ts`** — `sendSms` now returns `{sid, status}` instead of
  reading the status code and discarding the body, and sends a `StatusCallback`. Its
  `status` is `queued`/`accepted`, essentially never `delivered`; **do not read it as
  delivery.** Parsing the body is best-effort inside a `try`: a message that SENT but
  whose body failed to parse is still sent, and throwing there would make the caller
  log `failed` and, worse, retry — the user gets a second copy of the alert.
- **`logNotification(..., providerId)`** — the SID is the join key. A row logged
  without it can never learn whether the text landed: the receipt comes back and
  matches nothing.
- **`/api/webhooks/twilio`** — records the outcome. Public (`/api/webhooks/(.*)` is
  already in `isPublicRoute`), 200-with-empty-body always (Twilio retries anything
  else and does not read the body).
- **`lib/notifications/twilio-signature.ts`** — extracted from the route *so it can be
  tested*, the same reason `worker/claim.ts` is not inside `poller.ts`: a Next route
  pulls in `next/server` and the `@/` alias, neither of which the tsx test runner
  resolves. It is the entire access control on a public endpoint that writes delivery
  history, and a signature check that always returns true looks identical from outside
  to one that works.

### Three things to get right, all of which fail silently

1. **The URL is part of the signed payload, and TWO senders pick it independently.**
   Twilio signs whatever the sender put in `StatusCallback`; the Fly worker and Vercel
   each read `NEXT_PUBLIC_APP_URL` from their own environment (the worker has none and
   falls back to `camphawk.app`; Vercel has one whose value the API won't return). If
   those strings ever differ by a `www.` or a trailing slash, verifying against only one
   rejects 100% of the other sender's receipts — forever, with nothing in the data but
   texts stuck on `pending`. So the route verifies against a **list**: the configured URL
   AND the URL the request actually arrived at (`x-forwarded-host`, because behind
   Vercel's proxy `req.url` can be an internal hostname). Not a weakening — every
   candidate is still checked against `TWILIO_AUTH_TOKEN`, so a forged Host buys nothing
   without the secret, and it is what Twilio's own helper libraries do.
2. **Fail CLOSED.** No header, wrong signature, or no `TWILIO_AUTH_TOKEN` → 403,
   nothing written. "Cannot verify" must never mean "accept": an unsigned POST claiming
   `MessageStatus=delivered` would otherwise let anyone paper over an outage in our own
   data. `timingSafeEqual` THROWS on a length mismatch, so the length check is required,
   not an optimisation — uncaught it turns a junk POST into a 500 on a route Twilio
   retries.
3. **A way-point never overwrites a terminal status.** Callbacks are unordered and
   retried; without the `NOT IN ('delivered',…)` guard a delivered message can end its
   life recorded as `sent`.

`twilio-signature.test.mts` asserts against **Twilio's published worked example**
(docs/usage/security), not against our own encoder — a test that signs with the
function it verifies with would pass just as happily if we had invented our own scheme.

### Reading the panel

Admin → System Health → **"Did the texts arrive?"**, 30-day window. Thresholds and the
verdict live in `lib/health-thresholds.ts` (`smsLevel`, `SMS_MIN_SAMPLE = 10`,
warn ≥3%, fail ≥10%).

- **`untracked`** is pre-038 rows. Shown as its own number, never folded into
  `delivered` — it only shrinks, and the denominator stays honest while it ages out.
- **All-pending-with-no-answers warns.** That is the shape of a broken callback URL,
  and the naive `delivered / answered` would be 0/0 = NaN, every comparison false, and
  the panel serene while measuring nothing.
- **A few "no open notification row to update" lines are normal**: the daily delivery
  canary sends without logging a row, and the first `queued` callback can beat our own
  INSERT (written just after `sendSms` returns). Self-healing — Twilio posts again for
  `sent` and `delivered`. A PERMANENT stream of them means the SID is not being saved
  at send time, which is the one way this feature dies quietly.

### What the receipts found on day one — alerts were 2 segments and 2 segments were filtered

Migration 038 shipped at 05:21 UTC on 2026-08-05 and had its answer by evening. Twilio's
Programmable Messaging log splits **perfectly on the segment column**:

| | segments | outcome |
| --- | --- | --- |
| delivery canary (no link) | 1 | **Delivered** |
| `carted` (one `recreation.gov/cart` link, ~133 chars) | 1 | **Delivered** |
| `available` (`Book:` + `Manage:`, ~186 chars) | 2 | **Undelivered · 30007** |
| `coming_soon` (`Manage:`, ~182 chars) | 2 | **Undelivered · 30007** |

Fifty rows, one exception, and that exception was a 1-segment message to a *different*
handset. 30007 is "message filtered — blocked by Twilio or a carrier".

This also explains the shape of the complaint exactly. **Silver Lake arrived and Leo
Carrillo never did** because Silver Lake is rec.gov and gets auto-carted — a short,
single-link text — while Leo Carrillo is ReserveCalifornia, which auto-cart does not
cover, so every text it can ever send is the long kind. And a single site flipped
mid-stream: Silver Lake 008 arrived at 04:29 as a cart text, then the
one-cart-per-(watch,site) gate made every later opening fall through to a normal alert,
and delivery stopped at 05:29 and never resumed.

**Other subscribers were affected too** — +1 805 404 7195, +1 805 368 8804 — so this was
not one handset being odd.

#### The fix, and the confound it does NOT resolve

The `Manage:` link is **removed from SMS** (`dispatchSms`). Alerts go from ~186 to
~127-137 characters — one segment. The link survives in the email footer and in the app;
a manage link inside a text nobody receives is worth less than no manage link in a text
that arrives. **`carted` is deliberately unchanged** — it is the control.

`fitOneSegment` in **`lib/notifications/sms-fit.ts`** keeps it there. It trims the
campground NAME until the body fits 160, never the dates and never the booking link
(those are what the reader acts on; a name is still useful truncated). If even a minimal
name won't fit it returns the FULL body rather than a mangled one. Two rules worth
keeping:

- **The trim marker is `.`, never `…`.** The ellipsis character is outside GSM-7, so it
  would either cost three characters after transliteration or tip the whole message into
  **UCS-2, where the budget collapses to 70** — turning the fix into the bug.
- **`SMS_ONE_SEGMENT = 160` assumes Twilio's Smart Encoding is ON.** The evidence says it
  is: the delivered cart texts contain an em dash in our source, arrived rendering a
  hyphen, and Twilio counted them as one segment. If it is ever switched off on the
  Messaging Service that constant is a lie and every alert silently returns to two
  segments.

#### The answer: it was the LINK DOMAIN, not the length

The one-segment change was deployed to both shards at 14:33 UTC and the next three texts
settled it:

| time (UTC) | message | segments (per Twilio) | result |
| --- | --- | --- | --- |
| 15:00:22 | `coming_soon`, no link | 1 | **Delivered** |
| 15:00:50 | `coming_soon`, no link | 1 | **Delivered** |
| 15:30:49 | `available`, `camphawk.app/b/<token>` | **1** | **Undelivered · 30007** |

A 127-character single-segment message was still filtered, and the same handset had
accepted a 1-segment `recreation.gov` link the day before. **Length was never the
cause.**

The campaign itself was fine — Approved, `SOLE_PROPRIETOR`/Starter, "Messages contain
embedded links: **Yes**". What was wrong sat in its **sample messages**, written
7/7/2026 and never touched:

```
#1  Camp Hawk: 🏕 [Campground Name] has availability for your watched dates: [MM/DD],
    [MM/DD]. Book now: https://www.recreation.gov/camping/campgrounds/[ID]. Reply STOP…
#2  Camp Hawk: 🏕 A campsite opened up at [Park Name] for [MM/DD]-[MM/DD]. Reserve it at
    https://www.reservecalifornia.com/park/[ID] before it's gone. Reply STOP…
```

Both link to the PROVIDER. Neither mentions `camphawk.app`. The `/b/<token>` shortlink
was added to the code later, so live traffic carried a link shape that appears nowhere
in the registration. Everything observed fits with nothing left over: a recreation.gov
link matches sample #1 and delivers, a linkless message has nothing to flag and
delivers, our own domain matches no sample and is filtered.

**Separate the observation from the explanation.** The correlation above is measured.
*Why* a carrier dislikes our link is inference, and a research pass over Twilio, TCR,
T-Mobile and CTIA sources pinned down which parts are actually documented:

- **Documented.** Twilio's campaign-troubleshooting page requires "a dedicated, branded
  short domain that belongs to your business. You cannot use the sort of
  randomly-shortened URL typically furnished by a free service like bit.ly or TinyUrl."
  T-Mobile's Code of Conduct v2.2 carries sections **"4.7 URL Cycling / Public URL
  Shorteners"**, **"4.8 URL Redirects/Forwarding"** and **"3.3 Use One Recognizable
  Domain Name"**. `/b/<token>` is a redirect that hides its destination — that fits.
- **NOT documented.** That a short opaque PATH on a domain you legitimately own is
  itself a filtering trigger. No Twilio, TCR, CTIA or carrier source says this. It is a
  plausible inference and nothing more; do not repeat it as fact.
- **Not a mechanism at all.** "Undeclared link domain" — there is no domain field to
  leave undeclared. Twilio's UsAppToPerson API exposes only the boolean
  **`HasEmbeddedLinks`** ("Indicates that this SMS campaign will send messages that
  contain links", ours correctly `true`) and **`MessageSamples`**. TCR's own schema has
  an `embeddedLinkSample`, but it is a sample, not an allow-list, and Twilio doesn't
  expose it.
- **30007 is deliberately ambiguous** between Twilio-side and carrier-side filtering
  ("by Twilio **or** by the carrier"). The only documented way to learn which is to send
  3+ Message SIDs to Twilio Support. That distinction matters: if it is Twilio's own
  policy filter, domain reputation is not the explanation at all.
- **The campaign's samples and `HasEmbeddedLinks` are NOT editable after approval.** An
  earlier note in this session said they were; that was wrong. Changing the registered
  link shape means registering a **new campaign**, which is a further reason the fix
  belongs in the code.

#### Sole Proprietor caps, for when this grows

The brand is `SOLE_PROPRIETOR` — the lowest tier, and its limits are real even though
none of them caused this:

| limit | value |
| --- | --- |
| daily volume | **1,000 SMS segments/day to T-Mobile** (~3,000 across US carriers) |
| AT&T rate | 15 messages/minute per campaign |
| phone numbers | **one** — a Sole Proprietor campaign can attach exactly one 10DLC number |
| campaigns | one per brand |

At today's volume (~10-20 texts/day) none of these bind. The one-number cap is the one
that bites first on growth, and moving off Sole Proprietor means a new brand and a new
campaign, not a settings change.

**The fix was to make the code match the registration, not to re-register.**
`dispatchSms` now sends `payload.bookingUrl` directly (fragment stripped) — 142-150
characters, still one segment, because a real booking URL is only 45-49 characters
against the shortlink's ~39. `mintBookingToken`/`bookLink` are gone from the SMS path;
`/b/<token>` stays live for links already sent, and email always used the full URL.

> **Do not reintroduce a `camphawk.app` link into an SMS** without first getting the
> domain onto the campaign. There is no unit test for this — the "Did the texts arrive?"
> panel is the regression detector, and it goes red within hours.

Two things left deliberately alone: the registered samples end with "Reply STOP to opt
out" and ours don't (the Messaging Service's Advanced Opt-Out handles STOP/HELP, and
adding 24 characters to every alert to match a sample is not worth doubling the segment
count); and the brand is the lowest-trust `SOLE_PROPRIETOR` tier with a blank trust
score and "Other carriers: None specified" — not implicated by any evidence here, but
the thing to look at first if filtering ever returns without a code change.

## Expired watches close themselves (2026-08-05)

`worker/expire-watches.ts`, hourly, under `withSyncClaim('expire-watches')`.

A finished watch stayed `active = true` forever. The poller and the watch cap both
filter it out (`end_date > CURRENT_DATE`) and the watches list hides it, so it was
never polled and consumed no slot — but it was still "active" to anything that
reasonably reads `WHERE active`. On the day this shipped: 5 dead against 13 live, 28%
noise. The sweep closed all 5 on the first run (`[poller] closed 5 watches whose dates
have passed`, one machine, 05:21:52 UTC) and the live 13 were untouched.

**THE PREDICATE MUST NEVER BE WIDER THAN THE POLLER'S FILTER.** The poller runs
`end_date > CURRENT_DATE`; the sweep closes exactly the complement,
`end_date <= CURRENT_DATE`. Wider by a day — a "grace period", a `+ 1` — and it
switches off watches the poller is still running: a silent alerting outage with no
error anywhere. Narrower is harmless (a few rows linger an extra hour). **If you change
the poller's filter, change this one in the same commit.**

Old rows carry a `campflare_sub_id` from the third-party alert service we no longer use
(no `CAMPFLARE_*` credentials exist anywhere). Nothing to cancel, so the sweep makes no
network call — bolting a call to a dead vendor onto a one-line UPDATE is a new failure
mode for nothing.

`expireFinishedWatches(onlyIds?)` takes an optional id list **only so the test can
drive the real predicate without closing every real user's finished watches as a side
effect of `npm test`** — the same device as `claimSyncJob(job, ttl, machineId)`.
Production passes nothing. `worker/expire-watches.test.mts` was verified by breaking
the predicate to `CURRENT_DATE + 1` and watching "never closes a watch the poller is
still running" fail.

## The admin dashboard never signals with colour alone (2026-08-05)

The owner of this dashboard is colour-blind. Green / ochre / red dots are three grey
dots to a deuteranope — on the one page whose entire job is "is anything broken?",
answered in the single channel they cannot read.

Every status now carries a distinct **icon shape** and a **word**; hue is the redundant
third channel, not the signal. One record, `LEVEL_MARK` in `AdminTabs.tsx`, plus a
`StatusMark` component. **Route any new status through them** — a bare `bg-ch-*` dot is
a regression, not a style choice. The previous version spelled "green dot / ochre dot /
red dot" out inline in three separate places, which is exactly how a page ends up
legible only to people who can separate those three hues.

- Shapes are chosen to differ in silhouette at 12px: round tick, triangle, round cross.
  The banner previously used **the same triangle for warn and fail** — the two states it
  exists to distinguish differed only in colour.
- `HealthRow` puts the icon on the left (where the dot was, so rows still align) and the
  word on the right beside the age: the shape survives a screenshot, the word survives a
  shape you don't recognise.
- Same rule applied outside System Health: **Failed alerts** says "above the 2% ceiling"
  rather than just turning red, and Costs → **Net / month** says "Losing money ·" rather
  than relying on red plus a leading minus sign.
- `StatusMark`'s `showWord` hides only the VISIBLE word — it is always present for
  screen readers.
- To eyeball it: `npx tsx scripts/screenshot-component.mts admin-health --wait=2500`.
  The preset fixture deliberately mixes ok/warn/fail in one view, and selects the tab by
  clicking it after mount rather than by adding an `initialTab` prop — a screenshot
  harness should not widen a component's production API.

## Tests — there are some now (`npm test`)

The repo had **no test framework, no test script and no test files** until 2026-07-30.
`npm test` runs **`node:test` via tsx**, so this adds no dependency.

Files are `*.test.mts` under `worker/`. What is covered, and why these first:

- **`worker/claim.test.mts`** — the alerting claim above. This is where a wrong answer
  costs a user a campsite, and it was the least testable code in the repo because
  importing `poller.ts` STARTS the poller. Extracting `claim.ts` is what made it
  reachable.
- **`worker/costs.test.mts`** — the admin cost arithmetic. A silent error there
  misstates net margin, the one figure on that tab anyone acts on.
- **`worker/health-thresholds.test.mts`** — canary staleness, pinning the "banner
  cries wolf daily" regression.
- **`worker/expire-watches.test.mts`** (2026-08-05) — the expired-watch sweep. The case
  that earns its keep is "never closes a watch the poller is still running": that
  failure produces no error, no log line and no user-visible signal, alerts just stop.
- **`src/lib/notifications/twilio-signature.test.mts`** (2026-08-05) — the delivery
  webhook's signature check, against Twilio's published example. Pure.
- **`src/lib/health-thresholds.test.mts`** (2026-08-05) — `smsLevel`, including the
  0/0 = NaN branch that would report perfect health from a broken callback URL. Pure.

> `npm test` globs `src/**/*.test.mts` as well as `worker/**` — a pure test does not
> have to live under `worker/` to run.

> **A rare interaction worth knowing before you chase it.** The DB-backed suites hang
> their fixtures off watches dated **2020**, and the hourly expired-watch sweep closes
> exactly that shape of row. If a sweep lands inside a test run (a sub-second job once
> an hour, against a ~12-second suite) a fixture can go `active = false` mid-test and
> `claim.test.mts` fails for a reason that is nowhere in its own code. Re-run before
> investigating.

> **These hit the REAL database, deliberately.** The claim's correctness lives entirely
> inside one `INSERT .. ON CONFLICT .. WHERE`, so a mocked client would test a fake
> rather than the thing that decides. Postgres is the unit. The fixture watch is dated
> **2020** — `claimNotification` needs only `active = true`, but the poller's candidate
> query needs `end_date > CURRENT_DATE`, so it is claimable by the test and invisible
> to production alerting. It is deleted on the way out.

> **Prove a regression test fails before trusting it.** The claim tests were validated
> by reverting `claim.ts` to the pre-026 per-watch logic: 4 of 9 failed, including the
> one that names the bug. A test that also passes on the broken version is decoration.

## ReserveCalifornia auto-cart — the key hand-off is DEAD; cart is session-bound (2026-08-05)

**Verdict first, because an earlier commit in this session overclaimed it as "plausible":
you cannot create an RC cart in one session and let another session claim it by key.**
Tested live — writing the same `shoppingCartKey` into localStorage: the ORIGINAL window
that made the cart showed it (trivial), but a fresh **incognito window on the same PC,
logged into the same account**, showed EMPTY, and so did the mini-PC. Same account, same
key, fresh session ⇒ empty. The cart is bound to the **session** (its Okta token and/or
the `AWSALBAPP-*` / `stickounet` load-balancer cookies), not to the key and not to the
customer. `CustomerId: 0` was a red herring.

So the "bot holds it, you claim it on your phone" design is dead as a **key** hand-off.
Three options survive, ranked by how I'd pursue them (deep-dive 2026-08-05):

1. **CART ON TAP — cart in the user's OWN session, never hand off (recommended).** The
   binding wall only exists because the carting session and the checkout session differ.
   Make them the SAME: the CampHawk surface that the user already controls does the cart.
   - Desktop: the browser extension already does this (`extension/content-rc.js` precart
     path) — tap the alert, it carts in your logged-in RC tab. Shipped.
   - Mobile: the native app holds a logged-in RC session in its webview; on tapping the
     alert the app fires the cart POST in that session, then shows checkout. No transfer,
     no session-binding problem. Needs: the native app (in store review), an in-app RC
     login persisted, and cart-on-foreground wired.
   - **NO-TAP variant (push-triggered cart) splits by platform.** A silent/data push
     could wake the app to cart with no human. **Android: feasible** — a high-priority
     FCM data message wakes the app (bypasses Doze) and it can cart, modulo OEM battery
     managers and refreshing the ~1h RC token first. **iOS: NOT reliable** — Apple forces
     `content-available` pushes to low priority, throttles/coalesces them (a few/hour, at
     the system's discretion, delayed in Low Power Mode), and **will not wake a
     force-quit app at all**. Apple's own guidance is not to use silent push for
     time-sensitive work, which a 15-min cancellation window is. So push-triggered
     auto-cart would work on Android and flake unpredictably on iOS — worst on the
     store the app leads with. The reliable-server version of "no tap" is not this; it
     is option 2/3 (the cart must run where it's reliable = the mini-PC = hand-off again).
   - Honest limit (tap variant): needs the user to TAP within the ~15-min hold. It is NOT
     the asleep-at-2am hold. But detection→alert is seconds and texts now arrive, so
     "tap the text, it's in your cart, pay" is the realistic differentiator.
2. **Full session clone** (server holds, phone resumes): bot logs in AS the user, carts,
   and transfers token + `AWSALBAPP`/`stickounet` cookies + key so the device becomes the
   bot's session. Only this reaches the truly-away case without spending money. Fragile:
   1-hour Okta token, cross-subdomain cookies, moving a live session. **One cheap datum
   would gauge feasibility** — in the working RC window, delete just the `AWSALBAPP-*`
   cookies and reload: cart gone ⇒ it's LB stickiness (lighter transfer), cart survives
   ⇒ it's the token (heavier). Not yet run.
3. **Bot completes checkout**: the only true hands-off 24/7 grab, but it SPENDS the user's
   money and must clear the Oct-2025 reCAPTCHA + Okta MFA. A different, riskier product.

Detail in `scripts/auto-cart-bot/reservecalifornia.mjs`.

The mechanism notes below are still accurate and worth keeping; they're just not
sufficient, because of the session-binding above.

RC's own web bundle is where these came from — so nobody re-derives them:

- **The cart is anonymous, keyed only by a `shoppingCartKey` GUID.** `CustomerId: 0` on
  every entry. `POST rdapi.reservecalifornia.com/api/webaccesscustomer/load/shoppingcart`
  with `{shoppingCartKey}` in the body returns that cart. Reading needs *a* valid Okta
  token (401 without) but not a *matching* one — any authenticated session can very
  likely read any cart by key.
- **`localStorage["shoppingCartKey"]` is the web app's sole source of truth.** Verified in
  the bundle: every cart op (`emptyCart`, `extendShoppingCartTimer`, checkout) reads the
  key from there; **nothing reads it from the URL**. That is why the `?shoppingCartKey=`
  URL test failed — not because the cart can't be adopted, but because RC ignores the URL
  and reads localStorage. Write that one value and the session adopts the cart.
- **The 15-minute hold is extendable** — the bundle exposes `extendShoppingCartTimer`
  ({shoppingCartKey}). A holder can keep a site well past 15 minutes.
- **reCAPTCHA + Okta MFA live only on cart/checkout** (added Oct 2025). They hit the BOT
  if it must log in and pre-cart; they do NOT block the hand-off, and the human solves
  the checkout reCAPTCHA.
- **No public source documents any of the customer/cart API** — every open-source RC bot
  is search-only. This is all from the live bundle + network trace.

**The design that follows** (bot holds, human claims — the "auto-cart without checkout"
the owner wanted): bot detects the opening (poller already does), creates the cart
server-side via `precartdata` under an RC session it holds, extends the timer, and
reports the `shoppingCartKey` on the `autocart_job`. The alert carries the key; on
desktop `extension/content-rc.js` writes `localStorage["shoppingCartKey"]` and reloads
(`#camphawk-rccart=<key>`, built 2026-08-05), on mobile the native app injects it into
its reservecalifornia.com webview. The human reviews and checks out. No payment
automation.

**THE ONE MAKE-OR-BREAK TEST, still unrun** (needs a real RC login, ~3 min, no bot):
in a browser logged into RC with a site in the cart, run in the console
`localStorage.setItem("shoppingCartKey","00000000-0000-0000-0000-000000000000");location.reload()`
→ cart should read EMPTY (proves the app follows localStorage), then set it back to the
real key and reload → the site should REAPPEAR (proves a written key is adopted). Then
repeat the "set to the real key" step in a *second* browser/incognito logged into RC to
prove cross-session adoption — that last one is the real question, because the bot
creates the cart under its token and the user reads under theirs.

**Two open risks after that:** whether `precartdata`/pre-cart trips reCAPTCHA for the bot
(needs a live authenticated attempt), and per-state `installationsidentity`/`storeid`
values (CA is `cali`/`111`; each of the other 9 UseDirect states needs its own captured
from a trace). Detail in `scripts/auto-cart-bot/reservecalifornia.mjs`.

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

| File | Surface | Carries the agreed phrasing? |
| --- | --- | --- |
| `src/app/connect/page.tsx` | the sign-in screen itself | yes |
| `src/components/v2/TrustPanel.tsx` | shown when auto-cart is toggled on in New watch | yes |
| `src/components/v2/AutoCartSettings.tsx` | the auto-cart block on `/settings` | yes |
| `src/app/auto-cart/page.tsx` | **public** marketing page | yes |

`src/components/AutoCartToggle.tsx` used to be on this list and **no longer exists** —
the 2026-07-27 rewrite deleted it. `v2/AutoCartSettings.tsx` replaced it and is the
fourth surface now.

> **All four aligned 2026-07-27.** `/auto-cart` and — despite its own header comment
> claiming otherwise — **two places in `/connect`'s own form** still said "the private
> machine that runs/holds *your* session", which is ambiguous about whose machine in the
> same way "your own CampHawk server" was. The `/connect` pair is the worse of the two:
> it sat directly on the checkbox where someone consents to storing a password. All now
> say **"a private machine we run"**. Grep `that runs your session` / `that holds your
> session` before shipping copy here — both should return nothing.
>
> **`/auto-cart` also described a UI that no longer exists** (fixed at the same time):
> "tap *Notify me*" and "open the *Watches* panel (the bell, top-right) and flip
> *Auto-cart openings*". None of those strings survive the rewrite — the real path is
> **Watch this campground** → **Settings → Auto-cart → Set up auto-cart** → a
> **Turn on/Turn off** switch. It's a public page and nothing type-checks marketing
> copy, so it drifted silently for a week.

> **This drifted once already (fixed 2026-07-27).** `/connect` said "your own
> CampHawk server" while `TrustPanel` said "a private machine we run" — a
> contradiction sitting on the exact screen where someone decides whether to hand
> over a password. Worse, `TrustPanel`'s password disclosure was gated behind a
> `savedLogin` prop that `NewWatch` never passed, so the honest block never
> rendered while the block above it told everyone "that's a session, not your
> password". The prop is gone and the disclosure is unconditional. If you edit one
> of the four files above, edit all four.

### Design: cart-outcome-gated alerts

- **Auto-cart is the paid Auto-Cart tier since 2026-08-01** — the lane requires
  entitlement (tier/grandfathered/beta; see "Subscription plans & the Auto-Cart
  tier"), checked in the poller's `isAutocartLane`, the toggle API and the roster
  feed. A lapsed subscription fails open to normal alerts.
- **The PER-WATCH toggle only started working on 2026-08-01 (migration 035).**
  `watches.auto_cart` has existed since migration 001 and had **never been written** —
  every production row was the `false` default. New watch showed a toggle (defaulting
  ON) whose value was never sent, the API never stored it, and `isAutocartLane` read
  only the account-level `users.autocart_enabled`. So switching it OFF carted the site
  anyway: confirmed when a watch created with the toggle off queued five cart jobs.
  **Two other features read that column and therefore never rendered for anyone** —
  the "Auto-cart" tag on a watch card, and the authexpired "Reconnect Recreation.gov"
  recovery state (`WatchCard:89`).
  Now wired end to end: `NewWatch` sends `autoCart`, the API stores it (defaulting
  TRUE when absent, so older clients keep today's behaviour — and `true` can never turn
  auto-cart ON for an account that isn't enrolled, connected and entitled), and
  `isAutocartLane` requires it. **Migration 035 backfilled `auto_cart = true` for
  exactly the active unexpired watches of `autocart_enabled` accounts** — the ones
  carting at the time — so the poller change altered no live behaviour. Without that
  backfill, honouring the column would have switched auto-cart off for everyone.
- On an opening for an entitled, enrolled watch the poller does **not** alert
  immediately — it writes a pending row to the `autocart_jobs` table (migration
  `014`). (Detection happens in the MAIN 15s cycle since 2026-07-31; the separate
  6s auto-cart detection loop is gone — it was 2.5x the request cost for identical
  information. `autocartCycle` is reconciliation only.)
- The **mini-PC bot** (`scripts/auto-cart-bot/bot.mjs`) polls a roster
  (`/api/auto-cart/roster`, master `AUTOCART_TOKEN`), carts the site in the user's own
  logged-in browser, and reports the outcome to `/api/auto-cart/result`.
- Outcome decides the alert:
  - **carted** → "✅ it's in your cart, check out" (email + SMS).
  - **not carted** → the poller re-verifies the site is still open ~35s later and
    sends a normal "still open — book it" alert, or stays **silent** if it's gone.
- `autocart_jobs` is also the permanent record of every cart attempt.
- **ONE cart per (watch, site), forever** (`worker/carted-history.ts`, index in
  migration 036). Before queueing a job the poller asks whether this watch has
  already had this exact site carted; if so it skips the lane and sends a **normal
  alert** instead. The site is not silenced — it just isn't carted twice.

> **Why this had to exist (2026-08-02): Silver Lake site 84611 was placed in one
> user's cart FIVE times, once an hour, for a single watch.** Two independent
> guards both let it through and neither was wrong on its own — the alerting claim
> (`watch_site_alerts`) has a **1-hour** window, so an opening that STAYS open
> re-claims every hour and queued a fresh job; the bot's own guard is a **20-minute**
> TTL (`CARTED_TTL_MS` in `bot.mjs`), sized for how long rec.gov holds a cart, so by
> then it has deliberately forgotten. Neither remembers across hours, and nothing was
> asking the permanent record. A cart the user already has is not a second
> opportunity — re-carting churns their cart and re-fires "it's in your cart".
>
> - **Keyed on `watch_id`**, which is what makes "a new watch for the same campground
>   starts over" true for free — a new watch is a new id with no history (and
>   deleting one cascades its jobs away).
> - **`cart_outcome` is checked alongside `resolution`**: a job the reconciler
>   resolved as `alerted` before the bot's late `carted` report landed still ended up
>   in the cart.
> - **A FAILED attempt does not block a retry** — `already-booked`, `cta-not-ready`
>   and friends mean we never got it, so the user is still owed a cart.
> - **Fail-OPEN on a read error** (cart it anyway): auto-cart is the paid feature, and
>   a duplicate cart is a much smaller failure than a missed one.
> - It lives in its own module for the same reason `claim.ts` does — importing
>   `poller.ts` starts the poller, so nothing inside it is testable.
>   `worker/carted-history.test.mts` (real DB) was verified to fail against both the
>   original bug and the per-watch-instead-of-per-site mis-key.

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
- `profile-lock.mjs` — **a cross-process lock on one user's Chromium profile dir**
  (added 2026-07-29). The bot and the broker are separate Node processes that compute
  the same `profiles/<userId>` path and both call `launchPersistentContext` on it;
  Chromium does not expect two instances on one user-data-dir and the result is not a
  clean error. Observed: at 00:19:01 the bot's keepalive reported "session kept warm"
  for an account while the broker — holding that same profile since 00:18:40 — was
  looking at a logged-OUT rec.gov and could not confirm a sign-in for 45s. One profile,
  two processes, opposite views. The bot's in-process `inUse` Set cannot see the broker
  at all. The lock is a JSON file in the profile dir, **advisory and allowed to go
  stale** (10 min): a crashed process locking someone out of auto-cart forever is worse
  than the race it prevents. The broker waits for it (a person is sitting in front of a
  page); `releaseProfileLockIfMine` exists so the error path can't strip another
  process's lock.
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
  > **AND IT HAPPENED AGAIN — the BROKER was the third path (fixed 2026-07-29).**
  > `broker.mjs` read `BROKER_HEADLESS` as `!/^(0|false|no|off)$/` on an unset value,
  > which is `true`, so remote sign-in ran **headless by default** while the bot
  > passed `headless: false` explicitly. The symptom is not a clean rejection: rec.gov
  > serves a **reCAPTCHA that cannot be satisfied** — "Additional Verification
  > Required" — and solving it just produces another one, because what failed the
  > check is the browser, not the answer. It took ~10 challenges to get one login
  > through. Now headed unless `BROKER_HEADLESS=1`, and both launches drop the two
  > loudest automation tells: `ignoreDefaultArgs: ['--enable-automation']` and
  > `--disable-blink-features=AutomationControlled`, which is what sets
  > `navigator.webdriver` — the first thing reCAPTCHA reads. **A boolean env default
  > is a real place this bug hides; read the negation twice.**
- **Never clear a login on a single login-state read.** The keepalive is the only
  thing that deletes a ready-marker outside a cart attempt, so a false "logged out"
  there costs the user a re-sign-in — discovered, painfully, on a *missed
  cancellation*. Two causes conspired: the headless launch above, and
  `recgovLoginState` sampling once at a fixed 3.5s delay, which catches rec.gov's SPA
  mid-hydration while it still shows the logged-out header. `recgovLoginState` now
  polls until the signal settles ('in' returns immediately, 'out' only if it holds),
  and the keepalive additionally requires a second confirming read before clearing.
  **'unknown' must never clear anything** — that's what it's for.
  > **Third cause, fixed 2026-07-29: a CAPTCHA was being treated as a bad password.**
  > When rec.gov serves "Additional Verification Required", the saved credentials are
  > *fine* — the browser got flagged. Purging them there makes the user re-enter a
  > password that was never wrong, and it happens exactly when they're already stuck in
  > a challenge loop. The broker now distinguishes the two and only clears on an actual
  > credential rejection.
- **Keepalives must not all fire at once.** Every enrolled profile waking together is
  both a load spike on one mini PC and a burst of near-simultaneous rec.gov sessions
  from one residential IP — the shape most likely to draw an anti-bot challenge. Two
  changes (2026-07-29): a profile **warmed within 75% of `KEEPALIVE_MS` is skipped**
  outright (tracked by a marker file, so a fresh sign-in doesn't trigger a redundant
  warm seconds later), and the ones that do run are **staggered 15–45s with jitter**.
  Related: the "every 1h" log line was computing `Math.round(30min / 1h)` and printing
  a rounded-to-zero interval, which made a working keepalive look mis-scheduled.
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

**Beta testers (`beta_emails`) — two bugs fixed 2026-07-28, both worth remembering.**

1. **The access check compared case-sensitively on one side only**, so a tester added as
   `Cam1234123@Gmail.com` (or signed up with different capitalisation) read as having **no
   subscription** and was shown "Start free trial". This affected every tester, not one.
   `src/lib/auth.ts` now does `LOWER(b.email) = LOWER($2)`. Any email comparison against
   user input needs both sides lowered — one side is the easy version of this bug.
2. **`query()` cannot run an `INSERT`, even one with `RETURNING`.** Reaching for it to
   get the inserted row back produced `syntax error at or near "INTO"`, surfacing in the
   UI as a bare "Could not add" — because `query()` goes through the `exec_select` RPC,
   which rejects anything that isn't a read. **`mutate()` already supports `RETURNING`**;
   that is the one to use. (This was my own regression, introduced while adding the
   invite email and caught only by trying it against the live DB.)

Adding a tester now sends a setup email (`src/lib/notifications/beta-invite.ts`) naming
the **exact address they must sign up with** — which is the failure mode above, made
self-service. It fires only on a genuinely new insert, so re-adding someone doesn't
re-mail them.

**A status banner sits above the tabs**, derived from the same worker/canary/sync data
System Health shows. It exists because "is anything broken right now" is the question
the page is opened for, and it used to be behind a tab. It names the failing thing
rather than counting problems, and it **aggregates sync warnings** — they are many (one
per state per provider) and a partial sync is routine, so listing them produced a banner
naming fifteen sources every morning. Canaries are still named individually; they're few
and each is distinct.

**Cost tracking (Costs tab):** two kinds of cost, summarized against MRR for a monthly net.
- **Fixed line items** — editable, DB-backed in `cost_items` (**migrations 024 + 025**), maintained
  by hand since these providers (Vercel/Fly/Supabase/Clerk/Twilio number/…) have no simple
  billing API. CRUD via `/api/admin/costs` (admin-gated); UI is
  `src/components/admin/CostsPanel.tsx` (explicit Edit/Remove per row). Seeded with the
  known providers at $0 for the operator to fill in.
  > **Migration 025 stores what's ON THE INVOICE.** `monthly_cents` was **renamed** to
  > `amount_cents` and a `billing_period` (`'monthly' | 'yearly'`) added, so an annual
  > plan is entered as the figure you're actually charged and the monthly view is
  > derived (`monthlyCents()` in `src/lib/costs.ts`). Renamed rather than kept
  > alongside: two columns for the same money fails **silently** — a yearly row whose
  > `monthly_cents` wasn't re-derived would overstate costs 12x in the one number
  > (net margin) nobody would double-check. Anything summing costs must go through
  > `monthlyCents()` / `yearlyCents()`, never raw `amount_cents`.
  > **`'one_time'` is a third billing period (migration 028)** — hardware, a developer
  > enrolment, a domain transfer. It is EXCLUDED from the monthly and yearly totals
  > rather than amortised: amortising needs a purchase date and a chosen lifetime the
  > table doesn't store, and a guessed lifetime moves net margin silently. It gets its
  > own "Spent to date" subtotal, and its own TABLE — "Per month" is meaningless for
  > something paid once, and `monthlyCents()` returns 0 for it, so a shared table
  > printed a confident "$0.00" beside a real purchase.
- **Lifetime spend** — "what has this cost, ever": recurring accrued from each item's
  start date, plus one-time at face value, plus usage over ALL time. Needs
  `started_at` (**migrations 029 + 030**), which defaults to `CURRENT_DATE` on insert.
  Billing counts **in advance**, so a plan started today counts once, not zero — these
  are prepaid subscriptions and reporting one you've already paid for as free is wrong
  on day one.
  > **029 added `ended_at` and 030 removed it, at the owner's request.** The trade-off
  > is real and recorded here rather than lost: **nothing now stops a CANCELLED service
  > accruing forever.** Deleting the row stops it but also erases what it historically
  > cost. If "I cancelled Twilio in March" ever needs to be true in the lifetime figure,
  > `ended_at` is what has to come back.
  > **029 refused to backfill `started_at` from `created_at`** — "when the row was
  > added" is not "when the money started" — and that was right under its own rule, but
  > left all 18 rows unknown behind a permanent warning. **030 defines the date AS the
  > date of entry**, so `created_at` stopped being a proxy and became the answer, and
  > the backfill is correct.
  > **The admin page's cost query was broken for days**: it still selected
  > `monthly_cents`, renamed away by 025, so it threw "column does not exist" every
  > render and `safe()` swallowed it to `[]`. An empty list is indistinguishable from
  > "no cost items", which is exactly why nobody noticed. Fixed 2026-07-30.
- **Usage costs** — computed live from `notifications` (SMS/email/push sent this month) ×
  per-unit rates in `src/lib/costs.ts` (`USAGE_RATES`, env-overridable). SMS is the only
  real variable cost; email/push default to $0 (plan/free). The Costs tab ALSO queries an
  unscoped all-time count for lifetime spend — don't confuse the two.

## Environment variables (names only — values in `.env.local` / Vercel / Fly)

GoingToCamp search (`GTC_AVAILABILITY_URL` on Vercel → the Fly worker endpoint;
authenticated with `SYNC_SECRET`, which the worker app now also carries),
TN/SC availability (`TNSC_AVAILABILITY_URL` on the **Fly worker** → the Vercel
`/api/tnsc-availability` route — the OPPOSITE direction from GTC, because the
portal blocks Fly and allows Vercel; also `SYNC_SECRET`-authenticated),
Supabase (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`), Clerk
(`NEXT_PUBLIC_CLERK_*`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`), Stripe
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_MONTHLY/_YEARLY`
for the Alerts plan and `STRIPE_PRICE_ID_AUTOCART_MONTHLY/_YEARLY` for the
Auto-Cart plan — all four on Vercel; if an Auto-Cart one goes missing the plan
de-lists rather than erroring, see the tier section),
Vercel Cron (`CRON_SECRET`, Production only — the bearer token Vercel Cron sends as
`Authorization: Bearer <CRON_SECRET>`, the ONLY header a cron can carry, which is why
`/api/cron/*` accepts it as well as the usual `x-sync-secret`). **SET AND VERIFIED
2026-08-04.** If it is ever unset the cron 401s every night — deliberately loud rather
than an open sync endpoint, but the TN/SC catalog then silently stops refreshing.
**Adding or changing it requires a REDEPLOY**: Vercel bakes env vars into a deployment,
so the running site keeps 401ing the correct value until you redeploy. To run the sync
by hand, use `x-sync-secret: <SYNC_SECRET>` instead — same route, no need to know this
one. See the TN/SC row in `docs/SETUP.md`.
Resend (`RESEND_API_KEY`, `EMAIL_FROM`), Twilio (`TWILIO_*`), Mapbox
(`NEXT_PUBLIC_MAPBOX_TOKEN`), RIDB (`RIDB_API_KEY`), auto-cart
(`AUTOCART_TOKEN`, `BROKER_WS_URL`), `NEXT_PUBLIC_APP_URL`, `SYNC_SECRET`.
`TWILIO_AUTH_TOKEN` gained a **second** job on 2026-08-05: it verifies the delivery
receipts arriving at `/api/webhooks/twilio`. It must be present **on Vercel** for that
(the worker only needs it to send). Unset there → every callback 403s and every text
sits `pending` forever, which the admin panel reports as "No delivery receipts yet".
`NEXT_PUBLIC_APP_URL` likewise now has to match on **both** Vercel and Fly: the worker
builds the `StatusCallback` URL from it and Vercel signs against the same string, so a
mismatch rejects 100% of receipts. Both default to `https://camphawk.app`, so leaving
them unset is safe; setting only one is not.
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
in-code defaults — override only to tune): **`PROBE_ENABLED`** — the roster master
switch, `"false"` in `worker/fly.toml` since 2026-07-30 and `false` by default in code;
nothing below runs while it is off, and `probe_targets.active` is the second switch;
`OBSERVATION_INTERVAL_MS` (per-window
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
429/timeout failures that OPEN the breaker, 3), `RECGOV_BREAKER_COOLDOWN_MS`
(short-circuit-to-empty window before a half-open probe, 60s — **doubles on each failed
probe**), `RECGOV_BREAKER_MAX_COOLDOWN_MS` (ceiling on that escalation, 8 min) and
`RECGOV_SPREAD_MS` (how much of a cycle the rec.gov fetches trickle across so they
don't burst, default half of `POLL_INTERVAL_MS`); the UseDirect/RDR
equivalents `UD_ATTEMPTS` (retries per call, 3), `UD_RETRY_BASE_MS` (backoff base,
250ms — x8 on a 403), `UD_BREAKER_TRIP` (4), `UD_BREAKER_COOLDOWN_MS` (60s),
`UD_TIMEOUT_MS` (15s), `UD_SYNC_CONCURRENCY` (grid fan-out during the catalog sync,
2 — was 5, which provoked the WAF), `UD_BATCH_WINDOW_MS` (40ms — how long proxied
RDR requests wait to be coalesced into one `/api/rc-proxy` invocation; raising it
batches more at the cost of alert latency on every cycle) and `UD_SYNC_BREAKER_WAIT_MS`
(5 min — how long ONE catalog-sync run will sleep out breaker cooldowns before it goes
back to failing fast); `RECGOV_CONCURRENCY`
(per-provider fanout bound within a phase — note the six per-source phases now run
concurrently as of `dfd4541`, so this bounds each provider, not the whole cycle);
`AUTOCART_SESSION_STALE_MS` (how recently the bot must have stamped
`autocart_verified_at` for the poller to use the auto-cart lane — default 45m ≈ one
30m keepalive + a missed one; stale/NULL fails open to normal alerts). The bot-side
keepalive cadence itself is `KEEPALIVE_MS` (default 30m), set in the mini-PC's own
`.env`, not on Fly.
rec.gov fetch-lane + scaling tunables (Fly worker, non-secret; the load-bearing ones
are pinned in `worker/fly.toml [env]`): the scheduler budget `RECGOV_BUDGET_PER_MIN`
(15 — measured against the per-IP 429 floor, don't just raise it),
`RECGOV_BUDGET_BURST` (4 — must stay ≥ the per-cycle dispatch or the bucket denies
already-paced traffic) and `RECGOV_BUDGET_LOW_RESERVE` (0.5); lead-time tiering
`RECGOV_HOT_LEAD_DAYS` (14) and `RECGOV_COLD_MAX_AGE_MS` (60s); sharding
`SHARD_COUNT` (**2 since 2026-08-02** — the SAME value on every machine; raising it
is how capacity grows, and `min_machines_running` must move with it. CLONE THE
MACHINE FIRST, THEN RAISE THE COUNT — see the rec.gov fetch-lane block) and
`SHARD_LEASE_MS` (45s); the 429
profile recorder `RECGOV_PROFILE_FLUSH_MS` (5 min buckets) and
`RECGOV_PROFILE_RETENTION_DAYS` (14); the nightly-catalog-sync claim `SYNC_CLAIM_MS`
(10 min — deliberately far SHORTER than a 50-minute sync, because the holder renews
while it works; a TTL sized to the longest run would strand the catalog for that long
after a crash); the RIDB catalog sync's `RIDB_CONCURRENCY` (8, was a hard-coded 15),
`RIDB_ATTEMPTS` (4) and `RIDB_BACKOFF_MS` (2000); `AUTOCART_POLL_INTERVAL_MS` (6s — the
RECONCILER cadence only; auto-cart detection lives in the main 15s cycle).
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
SETUP.md); the Fly worker deploys via the **`worker-deploy.yml` GitHub Action** — which
restarts the machine and verifies the heartbeat, because a by-hand `flyctl` deploy leaves
it stopped and alerting silently dead (see the autostop note above); the mini-PC bot
updates via `git push` + `update.bat` on the box.
