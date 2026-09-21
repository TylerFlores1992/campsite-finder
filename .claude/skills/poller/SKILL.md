---
name: poller
description: The availability poller on Fly — the alerting claim and why we alert on the TRANSITION not the state, sharding and rec.gov rate capacity, the single fetch lane and its measured budget, lead-time tiering, and the rules that keep `unknown` from being read as "fully booked". Use when working on or diagnosing `worker/poller.ts`, `worker/claim.ts`, `worker/shard.ts`, `worker/recgov-scheduler.ts`, `worker/watch-key.ts`, `worker/held-cadence.ts`, `worker/expire-watches.ts`, duplicate or missing alerts, rec.gov 429s, `poller.shards` / `poller.capacity`, or a watch that stopped being checked.
---

# The poller — detection and alerting

One Node process per machine on Fly (`campsite-finder-worker`), `POLL_INTERVAL_MS = 15000`.
It loads active watches, asks each reservation provider what is free, and decides whether that
is worth telling somebody about. **The decision — not the fetch — is where a wrong answer costs
a user a campsite.**

## IMPORTING `poller.ts` STARTS THE POLLER

That is a side effect of the module, so **nothing inside `poller.ts` can be exercised by a
test.** Every consequential decision has therefore been EXTRACTED into its own module, and each
extraction exists because a bug shipped that a test could have caught:

| module | decision |
|---|---|
| `worker/claim.ts` | may we alert for this (watch, site)? |
| `worker/hold-claim.ts` | may we announce this coming-soon release? |
| `worker/hold-line.ts` | who gets the campsite when two users want it |
| `worker/held-cadence.ts` | is this release newsworthy, and how often do we re-check a held site |
| `worker/watch-key.ts` | what identifies a poller row |
| `worker/lead-time.ts` | hot or cold |

**If you are about to put a decision in `poller.ts`, extract it instead.** The same rule holds
one machine over: `scripts/auto-cart-bot/rc-hold-runner.mjs` starts on import too, which is why
`cart-burst.mjs` and `session-coverage.mjs` are separate.

## THE ALERTING CLAIM — `worker/claim.ts`

Keyed on **`(watch_id, site_key)`** in `watch_site_alerts` (migration 026). It was one
timestamp per WATCH until 2026-07-30, so the first site to open silenced every other site on
that watch for an hour — **and because the auto-cart lane shares the claim, the second site was
never CARTED either, not merely un-announced.**

**WE ALERT ON THE TRANSITION, NOT THE STATE (migration 039).** The one-hour
`RENOTIFY_WINDOW` used to be the whole rule, and nothing recorded whether the site had been
open that whole time — so a site that simply never closed re-alerted every hour for ever. One
Silver Lake opening sent **16 identical alerts in a day.** A re-alert now needs BOTH the hour
AND a `CONTINUOUS_GAP` (10 minutes) of not having seen the site.

> **CALL `claimNotification` ON EVERY CYCLE THE SITE IS OPEN, not only when you mean to
> alert.** It doubles as the observation: `last_seen_open_at` is stamped unconditionally while
> `last_alert_at` moves only when we win. **A skipped cycle looks exactly like the site
> vanishing**, and ten minutes of that is a duplicate alert.

- **Ten minutes is sized in one direction.** Our own blind spots — an open rec.gov breaker, a
  budget-denied refresh, a worker redeploy — look exactly like a site disappearing, and ten
  minutes clears all of them. Going HIGHER only delays a genuine re-open, which is the cheaper
  mistake. **Do not lower it.**
- **`NULL` `last_seen_open_at` (pre-039 rows) means "we don't know" and does NOT suppress.**
- **ONE "still open" nudge at 6h** (migration 040). Transition-only alerting removed the hourly
  repeat and with it the accidental *retry* it gave a first alert that never landed.
  `nudged_at` buys back exactly one follow-up, and **it resets to NULL on a genuine re-open** —
  without that reset it would latch for the life of the pair and every later stay would silently
  lose its follow-up.
- **`claimNotification` returns `{won, reason}`** and `reason: 'nudge'` becomes
  `kind: 'still_open'`, **worded differently in email/SMS/push on purpose**: a follow-up that
  reads like a fresh alert is indistinguishable from the bug above.
- Sources with no site id (ReserveAmerica, GoingToCamp, TN/SC) collapse onto the
  `WHOLE_CAMPGROUND_SITE_KEY` sentinel `'*'` and keep the old per-watch behaviour, which is the
  honest reading of what they tell us.
- **`siteKeyFor` namespaces by campground ONLY for a multi-campground watch.** That sentinel is
  per-watch, so a park watch's divisions would otherwise collapse onto `(watch_id, '*')` — the
  026 bug one level up. Namespacing unconditionally would rewrite every stored key and re-alert
  every currently-open site once on deploy.

`worker/claim.test.mts` **hits the real DB on purpose** — the correctness lives inside one
`INSERT .. ON CONFLICT .. WHERE`, and a mock would test a fake. It was validated by restoring
the bug and watching it fail.

## A POLLER ROW IS A `(WATCH, CAMPGROUND)` — `worker/watch-key.ts`

Migration 070 made `loadWatches` emit one row per (watch, campground) through a
`CROSS JOIN LATERAL`, so **every row of a park watch carries the same `w.id`.** Anything keyed
on the watch id alone was correct when a watch WAS a campground and is silently wrong now.

Two faults it fixes, and the second is the one that bites later:

1. **The result maps overwrote each other** — `rcResults`, `rcHeld`, `raResults`, `gtcResults`,
   `tnscResults` were written from a fan-out over rows and read back per row, so the **last
   division to finish won and every row then read the survivor.** That is how one campsite came
   to be alerted under the wrong campground, with a booking link pointing at a facility the site
   is not in.
2. **`DueTracker` skipped divisions** — it stamps `last[id] = now` for the first row it admits,
   so siblings are tested in the same call against a `prev` of now. Inside the hot window the
   interval is 0 and `0 >= 0` lets them through **by luck**; past `HOT_LEAD_DAYS` the interval is
   60s and they are refused, on that cycle and every cycle after. **A park watch for a stay a
   month away silently loses its siblings, and nothing reports it.**

`DueTracker.due` now REQUIRES `campground_id`, which turns a silent collision into a compile
error at every call site — the fix cannot be half-applied.

## SHARDING — `worker/shard.ts`, and the ORDER MATTERS

`SHARD_COUNT = 3` (`worker/fly.toml` `[env]`, 2→3 on 2026-09-04). Campgrounds are divided by an
FNV-1a hash of the campground id; each machine **leases** a free index from `poller_shards`
(migration 031) with one atomic `INSERT .. ON CONFLICT .. WHERE`, the same shape as the alerting
claim. A holder renews (`LEASE_MS` 45s, renewed at a third of that); an expired lease is takeable,
so a dead machine self-heals.

- **CLONE FIRST, THEN RAISE THE COUNT.** Raising it first leaves the new shard **unheld and half
  the campgrounds polled by nobody** — the silent-blindness case. The reverse transient (machines
  still at the old count) is harmless: everyone polls everything, the claim dedupes the alerts,
  and each IP stays at its normal rate. `min_machines_running` tracks `SHARD_COUNT`; **raise both
  together.**
- **SHARD BY CAMPGROUND, never by watch or campground-month** — all watches for a campground must
  share a machine or the dedup that makes this scale is lost.
- **At `SHARD_COUNT = 1` `ownsCampground` short-circuits to true WITHOUT consulting the lease**,
  so a DB hiccup can never stop the only poller.
- **`poller.shards` in `/api/health/status` FAILS on an unheld shard** — those campgrounds are
  polled by nobody while everything else reports green.

**WHY MACHINES AND NOT A BIGGER BUDGET.** rec.gov's rate limit is **per egress IP**. The full-day
429 profile settled it: at a steady **13.3 req/min a single IP was throttled in EVERY hour of the
day** (0.2–3.2% of attempts, worst 3.2% at 15:00 UTC), while **our own budget denied almost
nothing**. There was no headroom to take. **Capacity on rec.gov is bought with ADDRESSES.**

**WHEN TO ADD ONE IS A GAUGE, NOT VIGILANCE.** `poller.capacity` counts distinct rec.gov
campground-months across active watches against machines × `RECGOV_MONTHS_PER_MACHINE` (4, in
`src/lib/health-thresholds.ts`). **AT capacity warns, OVER fails, and nothing else goes red for
it** — over capacity is not an outage, every watch just gets slower, silently, which is the worst
shape a degradation can take for a product whose whole value is detection latency.

## ONE REC.GOV FETCH LANE — `worker/recgov-scheduler.ts`

There were two uncoordinated loops (the main 15s cycle and a 6s auto-cart cycle) with no shared
state, producing ~26–36 req/min including **one campground URL fetched ten times a minute**.
Every call site goes through the scheduler now, so the rate is enforced in one place and can be
reasoned about. Three mechanisms:

1. **single-flight** — concurrent callers for the same (campground, month) share one request;
2. **short-TTL cache** — the caller states `maxAgeMs`, so nobody re-fetches what somebody just
   fetched;
3. **token bucket** — `RECGOV_BUDGET_PER_MIN`, **15, MEASURED**: a clean Fly IP took 160 strictly
   sequential requests at 16/min with zero 429s.

- **`BURST = 4` and it is not a safety dial.** It was 2 on the theory that a small burst is
  inherently safer — measurably the wrong lever: the main cycle paces 4 campground-months over
  7.5s, so the 2nd and 4th requests of every cycle were refused. **8 served/min against 8
  denied/min, barely half the budget reaching the network**, while rec.gov was happy to serve it.
  The bucket does not create bursts; `pacedForEach` already spaces them. **If the working set per
  cycle grows past this, raise it or the budget silently under-delivers again.**
- **LOW callers stop at `LOW_PRIORITY_RESERVE`; HIGH (the canary, the auto-cart reconciler) may
  spend to zero.** Small but not zero: **a denied canary reads its own starvation as "rec.gov is
  down" and raises a false banner.**
- **A denied refresh returns the PREVIOUS value marked `stale`, or `unknown` if there never was
  one — never a fabricated empty**, which downstream reads as "fully booked".
- **An `unknown` never overwrites a real cached reading.** A failed read is the absence of a
  reading, not a newer one.
- **The breaker skip is `recgovBreakerCoolingDown`, NOT `recgovBreakerOpen`.** The latter stays
  true until a success closes the breaker, and the only thing that can produce that success is
  the half-open probe inside `getAvailabilityFromRecGov` — which never runs if we skip. **That
  deadlocked rec.gov detection for thirteen minutes in production.**
- **FOUR call sites, not three.** `worker/canary.ts` was missed on the first pass — the exact bug
  the scheduler exists to prevent. It goes through at HIGH with `maxAgeMs: 0`, because a canary
  served from cache proves nothing.

**DO NOT RAISE `RECGOV_BUDGET_PER_MIN`.** It is already near the measured 429 floor. The three
real levers are auto-cart cadence, lead-time tiering, and machines.

## LEAD-TIME TIERING — `worker/lead-time.ts`

A campground-month whose first wanted night is more than `RECGOV_HOT_LEAD_DAYS` (14) out rides a
`RECGOV_COLD_MAX_AGE_MS` (60s) cached reading instead of fresh-every-15s — ~1 req/min instead of
4 — **per (watch, MONTH)**, so a long watch's far months go cold individually. Auto-cart-lane
pairs are always hot. Justified by Feature E's frozen data: **89% of openings ≥7 days out survive
an hour.** The heartbeat prints `N recgov (H hot/C cold)`.

## `EMPTY ≠ BOOKED`

`hasAvailabilityInRange` returns **`boolean | null`** and `CampgroundAvailability.unknown`
carries the flag. It used to return a flat boolean, so a throttled or breaker-short-circuited
read was **indistinguishable from "every site is booked"** — and `/api/search` rendered live,
bookable campgrounds as fully booked. Demonstrated on production: 15 Moab campgrounds all showed
booked while rec.gov, asked directly, reported 5 of 6 sites free at the first one.

**Same bug, same shape, in three other places** — the Feature E recorder would have logged
unknown as `hadOpening: false`, and `seed-probe-targets.ts` counted unknown as "booked solid =
high demand". The RC client has thrown rather than returned empty for exactly this reason all
along.

> **`unknown` never rounds to a verdict.** That is the single most repeated rule in this repo,
> and it has the most expensive failure history: an absent reading read as a negative.

## ZONE-LESS PACIFIC WALL CLOCK

`rc_hold_requests.release_at` and UseDirect's `Lock` field carry **no time zone and are Pacific
wall clock**, while **Fly runs UTC**.

- **In SQL:** `AT TIME ZONE 'America/Los_Angeles'`. Every `release_at` call site does this; a bare
  `NOW()` is seven hours adrift and silently amputates the oldest seven hours of a window.
- **In JavaScript:** `pacificWallClockToUtcMs` in `worker/held-cadence.ts`. **Never
  `new Date(availableAt)`.**

**IT COST THREE WEEKS OF SILENT LOSS.** `holdIsNewsworthy` used a bare `new Date()`, so an 08:00
Pacific release was placed at 08:00 UTC — and with a one-hour lead floor, **the coming-soon window
shut at MIDNIGHT Pacific instead of 07:00.** Anyone adding a watch between midnight and the
release got no heads-up and no hold button, which is exactly when somebody sets up a watch for
tomorrow morning.

- **The conversion takes TWO passes**, because the offset depends on the answer: a single pass is
  an hour out whenever a DST transition falls in the gap. Twice a year, silently.
- **A zone-bearing string is passed through, not re-interpreted and not `NaN`.** A strict parser
  would switch off every coming-soon alert **silently** if UseDirect ever started sending an
  offset.
- **The defending comment named the right fact and drew the wrong conclusion** — *"treat it as
  wall-clock in the server's zone, which is what the formatter downstream already assumes"*. The
  formatter only DISPLAYS it. **A display convention is not a time-arithmetic convention.**

## EXPIRED WATCHES CLOSE THEMSELVES — `worker/expire-watches.ts`

Hourly, under a `withSyncClaim('expire-watches')`.

> **THE PREDICATE MUST NEVER BE WIDER THAN THE POLLER'S FILTER.** The poller runs
> `end_date > CURRENT_DATE`; the sweep closes exactly the complement. **Wider by a day and it
> switches off watches the poller is still running — a silent alerting outage with no error
> anywhere.** Narrower is harmless.

`worker/expire-watches.test.mts` fails against exactly that bug, verified by making it.

## THE EGRESS-CASCADE WATCHDOG — two signals, and the second is the one that matters

On 2026-07-22 a rec.gov-only throttle became a **full detection outage**: rec.gov shifted from
fast 429s to slow 10s timeouts, the hanging sockets starved the pool, and every OTHER source
began timing out too — **while the Supabase heartbeat kept succeeding**, so the liveness watchdog
never fired. Alerting was silently dead and a human typed `flyctl machine restart`.

- `msSinceExternalFetchOk()` catches a **hard wedge**.
- **`externalFetchWedged()` — a rolling failure RATIO — is the only thing that can see a FLAPPING
  one.** A 2026-07-24 outage had ~all detects timing out while an *occasional* success kept
  resetting the zero-success timer. **Do not "simplify" the pair back to one.**
- The poller **exits 1** on either, so Fly reboots the VM. `restart_policy` must not be `"no"` —
  an exit is worthless if Fly does not bring the VM back.
- **The exposed half is the WIRING**, not the predicate: `externalFetchWedged` can be perfect
  while `markExternalFetchResult(false)` quietly leaves `canary.ts`, and then the ratio can never
  reach its threshold while every unit test still passes.

## THINGS THAT LOOK LIKE POLLER BUGS AND ARE NOT

- **`autocart.rc_runner` reporting "N hold(s) due" during CI.** `dueHolds` is deliberately not
  filtered to real unit ids (the hold suites exist to test it), so any `npm test` run puts a
  sentinel inside the grace window for the length of the run. It cannot cart anything — the unit
  id is non-numeric.
- **A red `autocart.rc_session` within minutes of a merge.** A numeric test fixture
  (`cartedHold('0', 5)`) satisfies `REAL_UNIT`, so a merge's CI run can put a phantom release in
  front of the box for seconds. **Check whether a Verify run was in flight before treating it as
  a dead session.**
- **A real-DB suite failing on a diff that cannot reach it.** There is one production database and
  the poller writes to it continuously — `failMissedHolds` on a 60s timer, `rcSyncIfDue` writing
  `campgrounds`. That is **test-versus-production**, it needs no second test run, and serializing
  the lanes cannot prevent it. The three conditions for an honest re-run: the diff cannot touch
  the code, the suite passes alone, and the mechanism is named.

## DEPLOY

- **Worker → Fly via the `worker-deploy.yml` GitHub Action.** It restarts the machines that were
  running pre-deploy and **fails unless a fresh heartbeat lands** — the old "deploy looks fine,
  alerting is dead" trap.
- **`worker/**` IS THE FIRST ENTRY IN ITS `paths:` LIST, SO A `worker/*.test.mts` FIRES A WORKER
  DEPLOY AND RESTARTS EVERY POLLER.** There is no test-file exemption. Two PRs have asserted the
  opposite in their own bodies and both were wrong. **Read `paths:`; a merge-scope claim is not
  evidence.** "No rebuild" and "no worker deploy" are different claims.
- **A red worker deploy over a healthy fleet is a known false alarm** (issue #243): Fly *replaces*
  an unreachable machine, the old id is gone, the post-deploy step reads an empty state and reads
  it as "stopped". **`/api/health/status` is the authority, not the tick.**
- **`npm run typecheck` runs BOTH tsconfigs.** The root one excludes `worker/` and `scripts/`, so
  the poller was once typechecked by nothing — `tsc` and `next build` both passed clean over a
  hard type error at a poller call site.
- **Non-secret tunables live in `worker/fly.toml [env]`** and are the authority for
  `SHARD_COUNT`, `POLL_INTERVAL_MS`, the lead-time constants and `PROBE_ENABLED`.
- **`NODE_USE_ENV_PROXY=1` on every stage of `npm run verify`**, or 190 real-DB tests fail with
  `Host not in allowlist` — a message that impersonates an egress revocation. **The discriminator
  is one `curl` to the same host**: reachable there and refused in Node is the missing variable.
