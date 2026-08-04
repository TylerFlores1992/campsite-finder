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
same push. The proxy paces a batch at `FANOUT = 2`; **don't raise it**.
- **The nightly catalog sync opts OUT** (`coalesce: false`). "Upstream load is
  unchanged" counted requests and missed per-IP RATE — one batch is N requests from a
  single Vercel lambda IP, and these WAFs meter per IP. The sync is a few hundred calls
  a day (~200 invocations of 63,000): nothing to gain, a real way to lose.
- **The sync also WAITS OUT an open breaker** (`UD_SYNC_BREAKER_WAIT_MS`, 5 min/run);
  the poller still fails fast. Illinois lost all 282 campgrounds on 2026-07-30 because
  the sync burned a 60s cooldown in 34 seconds. Details in `docs/CONTEXT.md`.
- **VALIDATED end-to-end 2026-07-31 23:47:** Illinois 282/7,068 sites/5 errors (from
  281 errors/0 sites), Virginia 193/3,181/7, Ohio 9,324/0 — best-ever numbers across
  the board. But the thorough sync (50+ min of full grids vs 22 min fail-fast) THRASHED
  the 256MB machine — three watchdog kills before any run reached Illinois, with
  `oom_killed=false` every time (thrash stalls everything >252s; it looks like "egress
  wedged", it's memory). **The worker is 512MB now** (`[[vm]]` in fly.toml — ONE block;
  a second one added without noticing the first would have silently re-shrunk it on the
  next deploy). MemAvailable during a full sync: ~270MB.

## Auto-Cart tier + lead-time tiering (2026-08-01)
Auto-cart is now the paid **Auto-Cart plan** — $10/mo, $50/yr; base stays $2.50/$20
alerts-only. Priced to undercut Campsite Tonight ($29.99/mo, $59.99/yr on the App
Store) while our measured detection→cart is ~12s vs their documented "up to every
minute".
- **Entitlement** = active/trialing AND (`subscriptions.tier = 'autocart'` OR
  `grandfathered`), OR `users.is_beta`. Migration 032 added both columns and set
  `grandfathered = true` on every pre-tier row — the "keep your rate" promise kept
  literally; the webhook NEVER writes grandfathered, so renewals can't strip it.
  Tier is derived from the Stripe price id on every webhook event (unknown → 'base':
  fails loud as "paying but treated as base", never silent free premium).
- **One definition, four enforcers**: `lib/auth.hasAutocartEntitlement`, the toggle
  API (403 on enable, off always allowed), the bot roster feed (keepalive slots are
  the scarce resource), and the poller's `isAutocartLane` (lapsed premium fails open
  to normal alerts). UI: `Pricing.tsx` two-plan cards (web only), `AutoCartSettings`
  upgrade gate — two-step confirm for live-sub upgrades via **`/api/stripe/plan`**
  (in-place price swap, prorated — a second checkout would double-bill), checkout for
  non-subscribers. Native shows no prices anywhere (store rule).
- **Stripe price mapping is by env id** (`src/lib/stripe-plans.ts`): the live key is
  RESTRICTED (no product read/write — verified), so prices can't be created or looked
  up by API. `STRIPE_PRICE_ID_AUTOCART_MONTHLY`/`_YEARLY` on Vercel — **both set
  2026-08-01 (owner created the prices in the dashboard), so the plan is LIVE.** If
  either var ever disappears, `autocartPlanConfigured()` goes false and the plan
  quietly de-lists (signed-in cards hide, checkout 503s). The signed-out marketing
  sentence is deliberately NOT gated on it — signed-out visitors never fetch
  subscription status, so a gate there hides the plan from the homepage's main
  audience forever.
- **Lead-time tiering** (`worker/lead-time.ts` + poller): a campground-month whose
  first wanted night is >14 days out (`RECGOV_HOT_LEAD_DAYS`) rides a 60s scheduler
  cache (`RECGOV_COLD_MAX_AGE_MS`) instead of fresh-every-15s — ~1 req/min instead of
  4 — per (watch, MONTH), so a long watch's far months go cold individually.
  Auto-cart-lane pairs are always hot. Heartbeat prints `N recgov (H hot/C cold)`.
  Justified by Feature E's frozen data (89% of ≥7-day-out openings survive an hour).
  A sub-15s hot lane is possible with the freed budget but needs the full-day 429
  profile before being promised anywhere.
- **The full-day 429 profile is RECORDING since 2026-08-01 04:30 UTC**
  (`worker/rate-profile.ts` → `recgov_rate_profile`, migration 033): every worker
  rec.gov fetch outcome in 5-min buckets, rec.gov's behaviour (ok/429/timeout/error)
  separated from ours (denied/breaker_skipped). Readout:
  `NODE_USE_ENV_PROXY=1 npx tsx scripts/recgov-429-profile.mts` — refuses a verdict
  until all 24 UTC hours have data. Retention 14d.
- **FIRST FULL READOUT 2026-08-02, and it killed the sub-15s-on-one-IP idea.**
  24/24 hours, 294 buckets, one 10-min hole at 18:40 Aug 1 (a worker redeploy — the
  counters are in-memory and flush every 5 min, so a restart drops the partial
  bucket). At a steady **13.3 req/min the IP was throttled in EVERY hour**: 429s
  0.02–0.42/min, 0.2–3.2% of attempts, **worst 3.2% at 15:00 UTC** (8am PT, the
  booking-window peak), zero timeouts all day, and **our own budget denied almost
  nothing** — so the budget was never the constraint and there was no headroom to
  take. This contradicts the earlier clean-IP probe (160 sequential requests at
  16/min, zero 429s): a burst probe and sustained production traffic are not the
  same measurement, and production is the real one.
  **Conclusion: keep 15s, do NOT raise `RECGOV_BUDGET_PER_MIN`, buy speed with
  machines.** Acted on the same day — see `SHARD_COUNT = 2` above.

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
- **The auto-cart lane has a SECOND gate: one cart per (watch, site), forever**
  (`worker/carted-history.ts`, index in migration 036). The claim's 1-hour window
  re-fires for an opening that stays open, and the bot's own guard is a 20-minute
  TTL, so a site sat in one user's cart being re-carted **five times in five hours**
  (Silver Lake 84611, 2026-08-02). Already-carted sites now fall through to a normal
  alert. Keyed on `watch_id`, so a new watch for the same campground starts over
  for free; a FAILED attempt doesn't block a retry; fail-OPEN on a read error.

## rec.gov 429s — four fixes in one loop (2026-07-30)
The breaker was flapping six times in thirteen minutes, so rec.gov watches went
unchecked ~40% of the time and the "Recreation.gov isn't responding" banner flapped
with it. All four causes were ours:
1. **The half-open probe was a comment, not code** — the gate reopened for EVERYONE
   after the cooldown, so all four concurrent fetches re-tripped it. Now exactly one
   caller crosses (`enterRecgovGate`).
2. **Flat 60s cooldown** → doubles per failed probe to `RECGOV_BREAKER_MAX_COOLDOWN_MS`
   (8 min), reset by a success.
3. **Bursted, not paced** — `pMap(4)` fired all four at once then idled 14s.
   `RECGOV_SPREAD_MS` (half the interval) trickles them; costs ~2s of detection latency.
4. **The UA announced a bot** (`CampsiteFinder/1.0`) under a comment claiming to mimic
   a browser. `recgovHeaders` now sends real Chrome headers, like UseDirect already did.
The `detect:ridb` canary also reported OUR backoff as "API likely down" and walked 16
campgrounds into a live rate limit; it now names the state and stops early.
`worker/recgov-breaker.test.mts` drives the real state machine (a 1ms timeout counts as
a throttle, so it takes the 429 path without needing rec.gov to cooperate).

## Empty ≠ booked (2026-07-31) — and rec.gov is NOT moving to Vercel
`hasAvailabilityInRange` returned a flat boolean, so a throttled or breaker-short-
circuited rec.gov read (empty campsites) was indistinguishable from "every site is
booked" — and `/api/search` rendered live, bookable campgrounds as **fully booked**.
Demonstrated on production: 15 Moab campgrounds all showed booked while rec.gov, asked
directly, reported 5 of 6 sites free at the first one. It now returns **`boolean | null`**
(`null` = never found out); `CampgroundAvailability.unknown` carries the flag. The
search route already mapped nullish → "unknown", so it needed no change. The RC client
has thrown rather than returned empty for exactly this reason all along, and its comment
names the rec.gov breaker as the counter-example that got it wrong.
- **Same bug, two more places:** the Feature E probe recorder would have logged unknown
  as `hadOpening: false`, and `seed-probe-targets.ts` counted unknown as "booked solid =
  high demand". Both now skip.
- **Routing the poller's rec.gov traffic through Vercel was investigated and REJECTED.**
  The premise ("Vercel isn't rate-limited by rec.gov") is false — driving ~1,000 req/min
  through `/api/search` tripped the breaker on Vercel within one round. Vercel's rec.gov
  lane is *shared with the search page*, so moving the worker onto it would couple
  alerting and search into one failure domain that today are separate. Don't revisit
  without new evidence.

## `npm run typecheck` — `tsc` alone does NOT cover the worker
The root `tsconfig.json` **excludes `worker` and `scripts`**, so the poller — the most
consequential code in the repo — was typechecked by nothing. Found by widening one
return type: `tsc` and `next build` both passed clean while `worker/poller.ts` had a hard
type error at the call site, and it would have shipped. `tsconfig.worker.json` covers
`worker/` + `scripts/`; **`npm run typecheck` runs both configs.** Same family as the
"`next build` passing is NOT enough" rule below.

## One rec.gov fetch lane — `worker/recgov-scheduler.ts` (2026-07-31)
There were TWO uncoordinated rec.gov fetch loops: the main cycle (15s) and
`autocartCycle` (**every 6s**, unpaced, and excluded from the main cycle so genuinely
additive). Real rate was ~26-36/min — including one campground URL fetched **10x a
minute** — and it was not observable from any single place, which is why every estimate
this session was wrong, including the one that moved the worker to another region for
nothing. All three worker call sites now go through the scheduler:
- **single-flight** (concurrent callers for the same campground-month share one request),
- **short-TTL cache** (caller states `maxAgeMs`; auto-cart asks for fresh, main cycle
  rides on whatever auto-cart just fetched),
- **token-bucket budget** `RECGOV_BUDGET_PER_MIN` (15, measured — a clean IP took 160
  sequential requests at 16/min with zero 429s). LOW callers stop at
  `RECGOV_BUDGET_LOW_RESERVE`; HIGH (auto-cart, reconciler) may spend to zero.
A denied refresh returns the **previous** value marked `stale`, or `unknown` if there
never was one — never a fabricated empty, which downstream reads as "fully booked".
Budget is printed on every heartbeat. Growth now degrades detection latency instead of
slamming the breaker shut.
- **FOUR call sites, not three.** `worker/canary.ts` was missed on the first pass — the
  exact bug the scheduler exists to prevent. It goes through with `maxAgeMs: 0` (a
  canary served from cache proves nothing) at HIGH priority.
- **An open rec.gov breaker costs no budget** — it short-circuits without a network
  call, so spending a token on it buys nothing; the last real reading is served instead.
- **An `unknown` never overwrites a real cached reading.** A failed read is the absence
  of a reading, not a newer one.
- **The auto-cart lane's own detection loop is GONE (2026-07-31).** It ran every 6s
  doing IDENTICAL detection to the main cycle with a different ending — queue a job
  rather than send an alert — at 10 rec.gov req/min per campground-month against the
  main cycle's 4. That 2.5x tax applied to every auto-cart campground and consumed two
  thirds of the whole budget for ONE of five watches. The main cycle now detects for
  every watch and branches on `isAutocartLane` after the claim; `autocartCycle` is
  reconciliation only and makes no bulk rec.gov requests. Auto-cart detection is 15s
  instead of a nominal 6s (which the saturated budget was not delivering anyway).
- **Measured outcome (2026-07-31, iad, 14-min windows).** rec.gov 429s 0.58/min →
  **0.14/min**; breaker openings 3 per 12 min → **0**; blind time ~40% → **0%**. The
  cost is visible in the logs: ~15-18 low-priority refreshes denied per minute, so
  demand is ~31/min against the 15/min budget. **The auto-cart lane's 6s cadence eats
  ~10 of the 15 for ONE campground**, leaving ~5/min for the other four, i.e. a ~53s
  effective refresh for non-auto-cart rec.gov watches. That is the live tradeoff — the
  three levers are auto-cart cadence, lead-time tiering of the main cycle, and the
  budget ceiling (already near the 429 floor, so don't just raise it).

## Catalog syncs — three fixes on 2026-08-04, one theme
**Growth and fixes both create failure modes that nothing was watching.**
- **Sharding doubled the nightly catalog sync.** `ownsCampground` shards POLLING;
  `rcSyncIfDue`/`gtcSyncIfDue` were never shard-aware, so BOTH machines ran the whole
  sync, guarded only by an in-process boolean. UseDirect syncs exit through the same
  **Vercel** IPs via `/api/rc-proxy`, and those WAFs meter per IP → 403 storms (Ohio
  311 errors; Minnesota 0 every night for a fortnight, then 80 and 140). Fixed with a
  DB claim (`worker/sync-claim.ts`, migration 037) — a claim, not shard 0, so a dead
  machine can't silently stop the catalog. Holder renews; expired claims are takeable.
- **The RIDB media fix started the rec.gov 429s.** It doubled the request count on
  07-27; from 07-28 runs went bimodal and **the bad runs are the FAST ones** (6 min vs
  18) — giving up early, not working slowly. Fixed by skipping media for the 3,775
  facilities that already have photos, `Retry-After`-aware retry with jitter
  (`RIDB_ATTEMPTS`), and concurrency 15 → 8. **That skip nearly erased 3,775 rows of
  photos** — `photos = EXCLUDED.photos` with an empty array is silent; and the first
  fix (NULL + COALESCE) would have failed every such facility because
  `campgrounds.photos` is NOT NULL. Explicit flag now, guarded by a test.
- **35 parks with no coordinates were being DELETED** (`location` is NOT NULL), 22
  recovered. Ladder in `src/lib/sources/geocode.ts`: portal coords → street address
  (Mapbox) → name (**OpenStreetMap only**). `0.0,-0.0` is a real published value, so
  the check is `isRealCoord` not a null test. **NEVER name-geocode with Mapbox** — it
  returns state centroids, and zero POIs for these names. Guards: PO boxes refused,
  distance-to-town not name-matching, 50-state box.
- **Fixing the geocoding FORCED widening the non-campground filter**: HQs, visitor
  centres and depots were excluded only because they had no coords. Once resolvable,
  "Riverside HQ" would have entered the catalog as a campground. **A fix that makes a
  failing path succeed can promote junk that was only ever filtered by its failure.**

## Sharding is LIVE at `SHARD_COUNT = 2` (2026-08-02)
Two machines in iad (`84ed237b2d1e48` shard 0, `8ee952b7671278` shard 1), each with
its own egress IP and its own 15/min budget — ~30/min across the pair. Live split
verified: `9/14 watches (shard 0/2)` and `5/14 watches (shard 1/2)`, `poller.shards`
2/2 held, `poller.capacity` 3/8.
- **Why a machine and not a bigger budget:** the full-day 429 profile (below) showed a
  single IP throttled in EVERY hour at a steady 13.3 req/min, while our own budget
  denied almost nothing. There was no headroom to take — rec.gov was already pushing
  back at today's rate. Capacity on rec.gov is bought with ADDRESSES.
- **CLONE FIRST, THEN RAISE THE COUNT.** Raising it first leaves the new shard unheld
  and half the campgrounds unpolled — the silent-blindness case. The reverse transient
  (both machines still at `SHARD_COUNT=1`) is harmless: everyone polls everything, the
  claim dedupes the alerts, each IP stays at its normal rate.
- `min_machines_running` tracks `SHARD_COUNT`; raise both together.

## Shard scaffolding — shipped dark at `SHARD_COUNT = 1` (2026-07-31)
rec.gov capacity is per egress IP (measured: 3 Fly machines, two sharing a /24, all
clean at ~16 req/min) ≈ **4 campground-months per machine at 15s**. `worker/shard.ts`
divides campgrounds across machines so capacity grows by cloning a machine.
- **At `SHARD_COUNT = 1` it is a deliberate no-op** — `ownsCampground` short-circuits to
  true WITHOUT consulting the lease, so a DB hiccup can never stop the only poller.
  Scaling later = raise `SHARD_COUNT` in `worker/fly.toml` + `flyctl machine clone`;
  each machine leases a free index by itself. No per-machine env, nothing to forget.
- **Shard by CAMPGROUND, never by watch or campground-month** — all watches for a
  campground must share a machine or the dedup that makes this scale is lost.
- **Lease, not config** (`poller_shards`, migration 031): one atomic
  `INSERT .. ON CONFLICT .. WHERE`, same shape as the alerting claim. A holder renews;
  an expired lease is takeable, so a dead machine self-heals.
- **`poller.shards` in `/api/health/status` FAILS on an unheld shard.** That is the
  silent-blindness case — those campgrounds are polled by nobody while everything else
  reports green.
- Tests: `worker/shard.test.mts` (pure hash: stability, range, even split, month
  independence) + `worker/shard-lease.test.mts` (real DB: mutual exclusion, renewal,
  expiry takeover, concurrent race). Both verified to fail against the bug they guard.
- **When to add a machine is now a gauge, not vigilance** (2026-08-01):
  `poller.capacity` in `/api/health/status` counts distinct rec.gov campground-months
  across active watches vs machines × `RECGOV_MONTHS_PER_MACHINE` (4, in
  `lib/health-thresholds.ts`). AT capacity = warn, OVER = fail; nothing else goes red
  for over-capacity — everything merely gets slower. Live at 3/4 on ship.
- **Watch cap is 6** (was 10; 2026-08-01), ONE constant in `src/lib/limits.ts` feeding
  the server 409 in `/api/watches` and all UI/pricing copy. Chosen because 6 watches
  ≈ what one shard machine can carry; accounts already above it keep their watches but
  can't add more until under.

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

### Play REJECTED 2026-08-03 — Misleading Claims, missing government source links
An app that shows government information must cite an official, functional source for it
**in the description** and carry an **easy-to-see** non-affiliation disclaimer. We had
neither URL (the named violation) nor a visible disclaimer — the wording existed but sat
in the last paragraph. Fixed listing-side only: **no code in the app changed, no new
AAB, no rebuild.**
- **`src/lib/data-sources.ts` is the canonical source list** (14 sources, 8,013
  campgrounds, all 19 URLs verified 200 on 2026-08-03), rendered at **`/sources`** and
  linked in the app footer so the citation is reachable from inside the app, not only
  from the listing. **Add a sync adapter → add it there in the same change**, or we ship
  government data with no cited source again. `/sources` is in `isPublicRoute` (a
  reviewer opens it signed out; `auth.protect()` 404s).
- New description in `docs/play-full-description.txt` (3,898/4,000 — paste the file,
  re-count after any edit). Disclaimer opens AND closes it.
- **Do NOT appeal.** That path is only for developers holding written proof of
  government authorization; we state the opposite, and it burns 7+ days.
- **The App Store listing got the same treatment 2026-08-04** (`docs/appstore-description.txt`,
  3,581/4,000, disclaimer top and bottom, all 19 URLs re-verified 200). Pre-emptive —
  Apple never raised it — but same shape of exposure and the fix is text-only.
  **Check the version state in App Store Connect first: a version *In Review* can't have
  its Description edited without pulling it from review**, and Description is not one of
  the fields editable without a new build (Promotional Text is).

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
