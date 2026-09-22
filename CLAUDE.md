@AGENTS.md
@docs/LANES.md

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
- **The admin link lives in the account menu** (`V2Nav`), not `/settings`, and not as a
  button in the header. `V2Nav` is a client component, so it gets the boolean from
  `GET /api/admin/status` (Clerk-authed, `lib/admin` stays `server-only`) — never a
  client-side email check.
  It spent a while as a standalone shield beside the avatar, on the argument that the
  owner opens it constantly. **Put back in the menu on both viewports 2026-08-08**: two
  32px buttons take up most of the width the header artwork's "FIND YOUR NEXT ADVENTURE"
  tagline occupies, so the collapsed mobile header could not be made to look right with
  both there. One tap for the one person who visits `/admin` beats a crowded header for
  everyone. Same on desktop deliberately — a control that moves with window width is
  harder to find than one that never moves.

## SEO (added 2026-07-27, live since the swap lifted the layout `noindex`)
Server-rendered campground pages + per-page metadata (`lib/seo.ts`), JSON-LD
(`lib/jsonld.ts`), 46 state landing pages, 3 accommodation-type hubs + 69 per-state
children (`lib/siteTypeHubs.ts`), dynamic sitemap (**7,066 URLs**, read 2026-09-03). Guard
with `NODE_USE_ENV_PROXY=1 npx tsx scripts/seo-check.mts`. Search Console is connected.

> **MARKETING AND GROWTH LIVE IN `docs/GROWTH.md` — START THERE, NOT HERE.** This file is
> about the poller and the RC flow; that one carries the user/subscriber numbers, the
> Search Console baseline and its three-way reading rule, the competitive picture
> (**recreation.gov has shipped its own free cancellation alerts** since July 2024), and
> what is open. `docs/GROWTH-LISTINGS.md` is the outreach packet beside it.
>
> **A CANCELLATION RETARGET WAS TRIED AND FALSIFIED IN A DAY (2026-08-25).** Titles were
> moved from "camping availability" onto "Cancellations"; a Search Console filter for
> `cancel` returns NO DATA across 1,000 rows, and 23 of the top 25 queries by impressions
> carry a camping/campground token. Reverted, with the guards in
> `src/lib/seo-retarget.test.mts` INVERTED so reinstating it fails a test. The full account
> is in the header of `src/lib/seo.ts`. **Do not re-run it.**
>
> **THE AXIS IS OBSCURITY, NOT SOURCE.** The pages that reach page one are a Juneau Forest
> Service cabin (7.5), a Clear Lake cabin colony (8.6) and an Afton wall tent (8.9) — while
> everything with real volume sits at 44-87. We win where we are the only result specific
> enough, which is why the accommodation-type hubs exist and why the national-park hub
> (`/camping/hardest-to-book`) is flagged unvalidated rather than repeated.

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
- **"NOTHING IS BEING RECORDED" IS WRONG, AND HAS BEEN SINCE THE DAY IT WAS WRITTEN.**
  The three switches stop the **probe roster** — the expensive half, 502 targets and the
  ~15,700 Vercel invocations/day. They have never touched `recordObservations()`
  (`worker/poller.ts`, called **unconditionally** at the end of every cycle), which writes an
  `availability_observations` row per active watch, throttled to one per (campground,
  arrival, nights) per hour. Measured 2026-08-22: **425 rows in 24h across 13 campgrounds**,
  newest 19:18 PT, against `probe_targets` 0 of 502 active. The roster really is off; the
  watch-driven recorder never was.
- **THERE IS NOTHING TO FIX HERE, WHICH IS WHY IT SURVIVED.** It makes **zero extra network
  calls** — it persists what the poller already fetched for alerting — and self-prunes at
  `OBSERVATION_RETENTION_DAYS` (90d). None of the cost that caused the 07-30 stop applies to
  it. Only the SENTENCE was too broad.
- **DO NOT READ FRESH ROWS AS THE ROSTER HAVING RESTARTED.** `scripts/likelihood-readout.mts`
  showing recent observations is the ordinary state. Check `probe_targets.active` and
  `PROBE_ENABLED` before concluding anything; a re-run of `seed-probe-targets.ts` is still
  the thing that could restart accrual silently.
- **IT WAS FOUND INDEPENDENTLY THREE TIMES — 2026-08-15, 2026-08-22 and again the same
  evening — because nobody folded it in.** Two docs PRs (#51, #156) sat open carrying it,
  each written by someone who had just rediscovered it from scratch. That is the cost the
  one-writer rule in `docs/LANES.md` exists to prevent, arriving from the other direction:
  not a finding lost in a merge, but a correction that never landed, so the file kept
  teaching the same wrong thing to the next reader. **Fold a correction or close it as
  wrong; leaving it open is choosing to re-derive it.**
- **If the watch-driven recorder should ALSO stop, it needs its own gate — none exists.**
  That is a decision nobody has taken, not an oversight to quietly fix.

## `/api/rc-proxy` takes a BATCH (2026-07-30)
It forwarded one RDR request per invocation on the hot path of a 15s poller —
~63,000 Vercel invocations/day for 16 watches, the biggest line in the usage bill.
Now `{base, requests:[…]}` → `{results:[…]}` in order, each with its own
`{ok,status,data,upstreamStatus,detail}`; one bad item never fails the other N-1.
Coalescing is client-side in `reservecalifornia/client.ts` (40ms window per RDR base,
deduped on method+path+body, below the retry loop so retries just rejoin a batch).
Both wire shapes stay live in both directions because Vercel and Fly deploy from the
same push. The proxy paces a batch at `FANOUT = 2`; **don't raise it**.
- **THE PROXY HAD NO UPSTREAM TIMEOUT AT ALL, and that was the whole 502 story
  (2026-08-09).** `forward()`'s fetch carried no `signal`, so one slow RDR request held its
  fanout lane open indefinitely and the CALLER's flat 30s batch deadline
  (`UD_TIMEOUT_MS * 2`) fired instead — **and an abort fails every request in the batch, so
  all N retried together.** Eleven consecutive batches timed out in one sample, `batch(4)`
  and `batch(2)` alike, and every RC call in the log was succeeding on attempt 2 or 3 and
  never on attempt 1: ~2.5x the invocations, which is what Vercel's 502 **and**
  CPU-duration anomalies were both reporting. Nothing cancels the function when the caller
  gives up, so the lambda kept running and billing with nobody to answer.
  **Vercel attributed the 5xx to "upstream 403 errors" and there were ZERO 403s** — do not
  trust that attribution; it was reporting our own aborts.
  Fixed with `RC_PROXY_UPSTREAM_TIMEOUT_MS` (12s). **12, not 15:** the proxy runs
  `ceil(n / FANOUT)` rounds IN SERIES inside the caller's flat 30s, so at 15s a batch of 4
  needed exactly 30s and had zero margin — which is why `batch(4)` sat permanently on the
  edge. A timed-out request now fails as ONE item, which is the contract the route already
  claimed ("one bad item never fails the other N-1") and that a hang was quietly violating.
  `worker/rc-proxy-timeout.test.mts` guards both the missing signal and the arithmetic.
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
- **One definition, SIX enforcers**: `lib/auth.hasAutocartEntitlement`, the toggle
  API (403 on enable, off always allowed), the bot roster feed (keepalive slots are
  the scarce resource), the poller's `isAutocartLane` (lapsed premium fails open
  to normal alerts), and — for RC day-before holds (2026-08-07) — the poller's offer
  (no entitlement, no "Hold it for me" button) **and** the `hold` action itself. The
  action check is not a duplicate: an email link is durable, so a lapsed subscriber can
  tap one sent while they were paying. Entitlement is checked where it would be spent. UI: `Pricing.tsx` two-plan cards (web only), `AutoCartSettings`
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

## RC login now hits a reCAPTCHA (2026-08-07) — the binding constraint
An image challenge ("select all images with bicycles") appeared on
`signin.reservecalifornia.com`'s Okta page for the probe's browser. **This is what all
the earlier login failures were**: the Next button reported `visible=true enabled=true`
and every click still timed out, because the challenge's overlay was swallowing pointer
events. Retrying harder can never work.
- **It also invalidates two earlier calls.** "Headless vs headful" was correlation, not
  cause; and the 12-hour CloudFront 403 looks much less coincidental next to an escalating
  anti-bot posture toward the same address.
- **Unattended RC login is therefore NOT available.** Earlier the same day it was (no MFA,
  no CAPTCHA), so this is an escalation — most plausibly from repeated fresh-profile
  logins, which is exactly what `--handoff`/`--release` do by design.
- **The design that survives this:** a human signs in ONCE, "Keep me signed in" is ticked,
  and the bot never lets the session lapse — the same keep-warm loop rec.gov already has.
  A bot that can re-login on demand is off the table; a bot that never needs to isn't.
- `rc-probe.mjs` now DETECTS the challenge and waits up to 5 minutes for a human to solve
  it (headful only) instead of burning three retries on an unclickable button.

## ReserveCalifornia auto-cart — SETTLED 2026-08-06, and still OFF
**Full record: `docs/ARCHIVE-RC-AUTOCART.md`** (moved verbatim 2026-09-21).
**CONCLUSION:** `rc-probe.mjs` answered all three open questions. Unattended login works
**HEADFUL ONLY** — every headless attempt failed at Okta's email step, so **never read a
headless failure as "RC blocked us"**. The bot **carts**, verified by reading the cart back
and matching `LockedShoppingCart`'s `(placeId, facilityId)`; `cart is already added` on a
re-run is proof the hold survived, not a failure. **The cart KEY cannot hand it over** — a
second session on the same account reads that cart as 0 entries, because it is bound to the
SESSION. **Therefore carting is HARMFUL without a hand-off**: the hold locks the unit and
denies it to the person we alerted. **PATH B IS VALIDATED** — bot holds, releases on demand
(`remove/cartentry` in 97ms), the user's own session re-carts 2544ms later, no cooldown, ~2.5s
of exposure, one bot account rather than one per user. The precart payload is `{extraId,
extraValue}`, lowerCamel.
**STANDING PROHIBITIONS.** Never cart without a hand-off. Never invent a unit id —
`scripts/rc-test-hold.mts --find` is the only way to get one, and it needs DB access. Never
hand-write an RC URL: the shape is `/park/<placeId>/<facilityId>` and **`lib/booking-url` is
the ONE place allowed to build it** (`/Web/#!park/...` has been written from memory twice and
answered with RC's 404 both times). Mobile recapture is solved on both platforms.

## Alert copy — three bugs from one real text (2026-08-06)
A live alert read *"Leo Carrillo SP - Canyon Campground **(si.** Site **Unit 42573** open
**2026-09-04, 2026-09-05, 2026-09-06**"* and the owner read it as "the site opens Sep 4".
- **`Unit 42573` was RC's internal primary key.** The grid carries a human name
  (`Hook Up (E ) Campsite #L006`) which we were discarding — a number that appears
  nowhere on RC's own pages is unmatchable against the map or the listing.
  `rcSiteLabel()` in `worker/poller.ts` prefers the `#L006` token.
- **`formatStayDates()`** (`lib/notifications/dates.ts`) → `Sep 4-6`. Gaps stay visible
  (a range would promise a night that isn't free) and dates are parsed as STRINGS —
  `new Date('2026-09-04')` is midnight UTC and renders as Sep 3 in every US timezone.
- **"open **for** Sep 4-6"** — the preposition is load-bearing. The coming-soon text in
  the same thread uses "opens \<date\>" to mean a real release time, so both readings
  were live at once.
- **`fitOneSegment` drops a trailing parenthetical WHOLE** before cutting, then cuts on a
  word boundary. `(si.` was a blind mid-token cut. With the shorter dates the real Leo
  Carrillo alert now fits at 148 chars **with** its full name — 160 before.
- **"Coming soon" needs ≥1h lead** (`holdIsNewsworthy`) and dedupes on the release hour,
  not the exact instant. Two texts arrived a minute apart ("opens 8:15 AM", "opens
  8:16 AM"): RC's `Lock` was ~1 min ahead and creeping, which is a cart hold being
  extended, not the overnight release the code assumed. Suppressing these costs nothing —
  when the lock lapses the ordinary availability alert fires within a cycle.

## Alerting — the claim (read this before touching the poller)
The decision "may we alert for this?" is `worker/claim.ts`, keyed on
**(watch_id, site_key)** in `watch_site_alerts` (migration 026), 1-hour window.
- **We alert on the TRANSITION, not the state (migration 039, 2026-08-06).** The hour
  window was the whole rule, and nothing recorded whether the site had been open that
  whole time — so a site that simply never closed re-alerted every hour forever. One
  Silver Lake opening sent **16 identical alerts in a day**. `last_seen_open_at` is now
  stamped on EVERY cycle the site is open, and a re-alert needs BOTH the hour AND a
  `CONTINUOUS_GAP` (10 min) of not having seen it — i.e. it actually went away and came
  back. **Call `claimNotification` on every cycle the site is open, not only when you
  mean to alert**: it doubles as the observation, and a skipped cycle looks exactly like
  the site vanishing. `NULL` (pre-039 rows) means "we don't know" and does NOT suppress.
  `worker/claim.test.mts` fails against the bug (verified by restoring it).
- **ONE "still open" nudge at 6h (migration 040).** Transition-only alerting removed the
  hourly repeat — and with it the accidental *retry* it gave a first alert that never
  landed. `nudged_at` buys back exactly one follow-up while the site is still open, and
  is what makes it once rather than a slower drumbeat. It **resets to NULL on a genuine
  re-open**, so each opening gets its own; without that reset it would latch for the life
  of the pair and every later stay would silently lose its follow-up.
  `claimNotification` returns `{won, reason}` — `reason: 'nudge'` becomes
  `kind: 'still_open'`, which is worded differently in email/SMS/push **on purpose**: a
  follow-up that reads like a fresh alert is indistinguishable from the bug above.
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

## SMS delivery is MEASURED now, not assumed (2026-08-05)
`notifications.status = 'sent'` only ever meant **Twilio's API returned 2xx**. Carrier
rejection, an unreachable handset and A2P filtering all happen after that, so a dropped
text and a read text were the same row. Migration 038 adds `provider_id` (the Twilio
SID), `delivery_status` (Twilio's vocabulary, stored verbatim), `delivery_error`,
`delivered_at`.
- `sendSms` now **returns `{sid, status}`** instead of discarding the response body, and
  sends a `StatusCallback`. `status` here is `queued`/`accepted` — **never read it as
  delivery.** The real answer lands at **`/api/webhooks/twilio`**.
- **`status` and `delivery_status` are deliberately separate columns**: one records what
  WE did, one what the CARRIER did. Collapsing them destroys the only distinction that
  makes this useful.
- The webhook is PUBLIC (`/api/webhooks/(.*)` is already in `isPublicRoute`), so
  `lib/notifications/twilio-signature.ts` is the entire access control — fails CLOSED
  on a missing header or missing `TWILIO_AUTH_TOKEN`. It signs **the URL we gave
  Twilio**, not `req.url`: behind Vercel's proxy those differ and signing the wrong one
  rejects 100% of callbacks. Tested against Twilio's published example, so the test
  asserts the ALGORITHM, not that our encoder agrees with our decoder.
- A way-point never overwrites a terminal status (callbacks are unordered and retried).
- Admin: **"Did the texts arrive?"** panel + banner integration, thresholds and
  `smsLevel()` in `lib/health-thresholds.ts`. Guarded by `SMS_MIN_SAMPLE = 10` — 2 of 3
  dropped is 67% and means nothing. `untracked` (pre-038 rows) is shown, never assumed
  delivered. All-pending-with-no-answers **warns**: that's a broken callback URL, and a
  naive `delivered/answered` would be 0/0 = NaN and report perfect health.

## SMS: link ONLY to the provider, never to camphawk.app (2026-08-05) — SOLVED
Every alert text was filtered (30007) while auto-cart texts arrived. Cause: the A2P
10DLC campaign's **registered sample messages** (written 7/7/2026, never changed) link
to `recreation.gov/camping/campgrounds/[ID]` and `reservecalifornia.com/park/[ID]`.
Live traffic sent `camphawk.app/b/<token>`, which appears in NO sample. Evidence, same
handset, same segment count: recgov link → **Delivered**; no link → **Delivered**;
camphawk.app link → **Undelivered/30007**, 10 for 10. Campaign is Approved and
"embedded links" is declared **Yes**, so neither was the problem — the CODE had drifted
from the registration.
- **WHY the carrier dislikes it is INFERENCE.** Documented: T-Mobile's Code of Conduct
  §4.8 "URL Redirects/Forwarding" + §3.3 "Use One Recognizable Domain Name", and Twilio
  requires "a dedicated, branded short domain that belongs to your business". `/b/` is a
  destination-hiding redirect, which fits. **NOT documented anywhere:** that a short
  opaque PATH is itself a trigger — don't repeat that as fact. And there is **no
  "declared link domain"** to have gotten wrong: Twilio's campaign API has only the
  boolean `HasEmbeddedLinks` and `MessageSamples`.
- **ANSWERED 2026-08-14, AND THE INFERENCE ABOVE WAS WRONG.** Twilio's Carrier Partner
  found our URL was *"mistakenly classified as potential spam due to an error which
  affected the Carrier Partner's filtering mechanisms"* and has *"applied the necessary
  corrections in order to remediate the false positives."* **So the DOMAIN finding is
  confirmed by the party doing the filtering — and the MECHANISM is a bug on their side,
  not a policy we tripped.** Neither §4.8, nor the redirect shape, nor the stale samples
  explains what happened to us; all three were inference, correctly labelled as such, and
  all three are now unsupported as the cause. **Stop citing them as the reason.** The
  guard in `sendSms` is still there deliberately (an unverifiable assurance about
  invisible infrastructure, against a silent failure on the core alert path) — lifting it
  is a product decision. Full quote, the 08-14 four-variant test and its limits, in
  `docs/a2p-campaign.md`.
- **A SECOND LINK TEST RAN 2026-08-14 02:48 UTC: 4 of 4 DELIVERED**, including both
  camphawk.app shapes and the `/b/<token>` positive control that was filtered 13-for-13 on
  08-05. **A passing control means filtering was not being applied, so this run — like
  08-12's — CANNOT rank link shapes.** It licenses "nothing of ours was filtered that day".
- **AND IT FOUND A HOLE IN THE REGRESSION DETECTOR.** `camphawk-page` reads `delivered` at
  Twilio and `delivery_status = NULL` here: `sms-link-test.mts` INSERTs the row **after**
  `twilioSend` returns and the webhook matches on `provider_id`, so a callback landing in
  that window matches nothing and is dropped for ever (Twilio does not resend). **A lost
  receipt reads as "pending" — which the panel treats as a broken callback URL, not as a
  delivery failure.** Production is 104/104 since 08-06 (it inserts from Vercel, beside the
  DB, not from a remote script), so it has not bitten a real alert — but the ordering is
  the same. Fix is a per-message `StatusCallback` carrying our own row id, so matching
  never races a write. **NOT BUILT** — recorded rather than fixed, because the detector is
  the safety net for any decision to put the link back and should be trustworthy first.
- **CORRECTED 2026-08-07: campaign SAMPLES *are* editable after approval.** The earlier
  note here ("samples + `HasEmbeddedLinks` are NOT editable, you need a NEW campaign")
  was wrong and made the fix look far more expensive than it is. Twilio's rectifying-
  campaigns doc: an update `POST
  /v1/Services/<MG…>/Compliance/Usa2p/<CM…>` may be made against an approved campaign,
  and only the FOUR BOOLEANS (`has_embedded_links`, `has_embedded_phone`,
  `direct_lending`, `age_gated`) are frozen — "Value CANNOT CHANGE for an update call
  made after TCR approval". `description`, `message_flow` and `message_samples` can all
  change. All seven fields must be resent, with the booleans identical.
  **`HasEmbeddedLinks` is already `Yes` on our campaign, so nothing frozen blocks us** —
  putting `camphawk.app` into the samples is an in-place edit, not a re-registration.
  Three caveats before doing it: the edit path is **Private Beta** (Console "Edit
  Campaign" or API — confirm the account has it), an update **re-triggers vetting** on a
  campaign that is currently Approved, and since 2026-06-30 `PrivacyPolicyUrl` +
  `TermsAndConditionsUrl` are required on registration (camphawk.app/privacy and /terms
  are both live and public, verified 200).
- **30007 doesn't say whether TWILIO or the CARRIER filtered.** The only documented way
  to find out is 3+ Message SIDs to Twilio Support.
- **Sole Proprietor caps worth knowing before growth:** 1,000 SMS segments/day to
  T-Mobile (~3,000 across carriers), 15 msg/min AT&T, one campaign per brand, and
  **only ONE phone number attachable**.
- **`dispatchSms` now sends `payload.bookingUrl` directly** (fragment stripped). No
  more `mintBookingToken`/`bookLink` in SMS; `/b/<token>` stays live for already-sent
  links, and email always used the full URL. **Do not reintroduce a camphawk.app link
  in SMS without first registering the domain on the campaign.**
- **A first hypothesis — "2 segments get filtered" — was WRONG and the data looked
  identical.** Every 2-segment message also happened to carry a camphawk.app link, so
  both theories predicted all 50 rows. Dropping `Manage:` (1 segment, still our domain)
  is what separated them, and it was still filtered.
- **The delivery panel is now the regression detector.** Anyone who puts our domain
  back into an SMS turns "Did the texts arrive?" red within hours.
- The campaign is **SOLE_PROPRIETOR** (Starter), trust score blank, "Other carriers:
  None specified". Not implicated by the evidence, but it is the lowest-trust tier.

## Alert texts must stay in ONE segment (2026-08-05) — the length theory, disproved
Within a day, migration 038 answered "why don't the texts arrive?". Twilio's log split
perfectly on the **segment count**: every 1-segment message to our subscribers
**Delivered**, every 2-segment message **Undelivered / 30007 ("message filtered")** —
50 rows, one exception, and that one was a different handset. Auto-cart texts kept
arriving (~133 chars, one `recreation.gov` link); alerts did not (~186 chars, a `Book:`
AND a `Manage:` link). Leo Carrillo NEVER arrived because it's ReserveCalifornia, so it
can't be auto-carted and only ever sends the long kind.
- **The `Manage:` link is GONE from SMS.** Alerts are now ~127-137 chars, one segment.
  It survives in the email footer and the app. `carted` is UNCHANGED on purpose — it's
  the control.
- **`fitOneSegment` (`lib/notifications/sms-fit.ts`) trims the campground NAME** until
  the body fits 160; never the dates or the link. Unfittable → returns the full body
  (two segments that say something beat one that says nothing). Trim marker is `.`,
  never `…` — the ellipsis is outside GSM-7 and would tip the message into UCS-2 where
  the budget is **70**, turning the fix into the bug.
- **THE CORRELATION WAS CONFOUNDED, and length LOST.** Every 2-segment message also
  carried a `camphawk.app` link, so "too long" and "untrusted link domain" predicted the
  identical 50 rows. Dropping `Manage:` was the discriminator — 1 segment, still our
  domain — and Twilio's own log confirmed **1 segment, still Undelivered**. See the
  section above: it was the domain. The one-segment work is kept anyway (cheaper, and
  a 2-segment alert is still worse), but it fixed nothing on its own.
- **`SMS_ONE_SEGMENT = 160` assumes Twilio Smart Encoding is ON** (evidence: delivered
  cart texts contain an em dash in source, arrived as a hyphen, counted 1 segment).
  Turn it off on the Messaging Service and every alert silently goes back to two.

## Expired watches close themselves (2026-08-05)
`worker/expire-watches.ts`, hourly, under a `withSyncClaim('expire-watches')`.
**The predicate must never be wider than the poller's filter.** The poller runs
`end_date > CURRENT_DATE`; the sweep closes exactly the complement. Wider by a day and
it switches off watches the poller is still running — a silent alerting outage with no
error anywhere. Narrower is harmless. `worker/expire-watches.test.mts` fails against
exactly that bug (verified by making it).

## The admin dashboard never signals with colour alone (2026-08-05)
The owner is colour-blind; green/ochre/red dots are three grey dots to a deuteranope, on
the one page whose job is "is anything broken?". Every status now carries a distinct
**icon shape** and a **word** — `LEVEL_MARK` / `StatusMark` in `AdminTabs.tsx`, hue as
the redundant third channel. Shapes differ in silhouette at 12px (round tick, triangle,
round cross); the banner used a triangle for BOTH warn and fail, i.e. the two states it
exists to tell apart differed only in hue. **Route any new status through
`LEVEL_MARK`/`StatusMark`** — a bare `bg-ch-*` dot is a regression. Same rule applied to
"Failed alerts" (says "above the 2% ceiling") and Costs → Net/month (says "Losing money"
rather than relying on red and a minus sign). Preset `admin-health` in
`scripts/screenshot-component.mts` renders the tab with a warn and a fail in view.

## THE EGRESS-CASCADE WATCHDOG (issue #14) — DONE SINCE JULY, UNGUARDED UNTIL 2026-08-27
On 2026-07-22 a rec.gov-only throttle became a **full detection outage**: rec.gov shifted from
fast 429s to slow 10s timeouts, the hanging sockets starved the pool, and every OTHER source
began timing out too — while the **Supabase heartbeat kept succeeding**, so `msSinceAlive()`
stayed fresh and the liveness watchdog never fired. Alerting was silently dead and a human
typed `flyctl machine restart`.
- **ALL FIVE ITEMS ON #14 ARE RESOLVED, and the issue text predates the scheduler by nine
  days — audit the TREE, not the ticket.** (1) `RECGOV_TIMEOUT_MS` is **5000**, not 10s, with
  a comment citing #14. (2) The concurrency cap is the scheduler's token bucket plus
  single-flight, which is stronger than the semaphore the issue asked for. (3) Timeouts
  already count toward the breaker — `recordRecgovOutcome(isThrottleError(err), …)`.
  (4) `worker/liveness.ts` carries the external signal and the poller **exits 1** on it so Fly
  reboots. (5) Proxying rec.gov was investigated and REJECTED.
- **TWO EXTERNAL SIGNALS, AND THE SECOND IS THE ONE THAT MATTERS.** A 2026-07-24 outage had
  ~all detects timing out while an *occasional* success kept resetting the zero-success timer,
  so a staleness check alone never tripped and a human restarted it again. `msSinceExternalFetchOk()`
  catches a hard wedge; **`externalFetchWedged()` — a rolling failure RATIO — is the only thing
  that can see a FLAPPING one.** Do not "simplify" the pair back to one.
- **IT SHIPPED WITH NOTHING TESTING IT FOR FIVE WEEKS, and the exposed half is the WIRING.**
  `externalFetchWedged` can be perfect while `markExternalFetchResult(false)` quietly leaves
  `canary.ts` — the ratio then can never reach its threshold, every test of the pure function
  still passes, and the flapping watchdog is unreachable. Fifth instance of the
  fix-present-and-inert shape. `worker/egress-watchdog.test.mts` pins both outcomes recorded,
  both checks wired to an exit, `restart_policy` not `"no"` (an exit is worthless if Fly does
  not bring the VM back), and the thresholds bounded from both sides.
- **TWO DEFECTS IN THAT TEST ARE WORTH MORE THAN THE TEST.** (a) It was **order-dependent
  through module state** — ten failures over a 60s window returned FALSE because earlier tests
  had left eleven successes in the same window (real ratio 0.73). **A cache-busted dynamic
  import does NOT isolate it** — measured; tsx dedupes the module regardless of the query
  string. Fixed with a time barrier rather than a test-only reset export: production code
  should not grow a hatch to make a test easier to write. (b) The staleness assertion compared
  two values that were both ~0, so `0 >= 0` held and the mutation making a FAILURE reset the
  clock **survived**. Ageing the success first is what separates the cases.
- **WHAT IS STILL UNPROVEN: that any of it fires in anger.** The acceptance criterion is
  behavioural and nobody can stage a rec.gov cascade. The guards prove the mechanism is wired,
  not that the reboot has ever happened.

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
- **A REAL-DB TEST MUST SAY WHICH THING IT OBSERVED (2026-08-14).**
  `worker/sync-claim.test.mts` failed CI on `ba63dca`, a commit touching two `.md` files and a
  `.ps1`, twenty minutes after the identical code passed. `claimSyncJob` fails CLOSED on a DB
  error and returns `false` — correct, and it stays, because a doubled catalog sync is the bug
  that module exists to prevent — so a blip and "another machine holds it" are the same
  `false`, `withSyncClaim` returns without running the body, and a bare `assert.rejects`
  reported **`Missing expected rejection`**, which reads as *the release is broken*. Same shape
  as `claimBotCommands` returning `[]` for both "nobody asked" and "the query threw". The body
  now records that it RAN and that is asserted first, so the honest sentence is the one that
  fires. It still fails on a blip — a green that proved nothing is worse — but it names which
  of the two happened. **The fault was never in the claim; it was that the test could not say
  what it had actually observed.**

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
- **A `worker/*.test.mts` FIRES A WORKER DEPLOY AND RESTARTS BOTH POLLERS (2026-08-27).**
  `worker/**` is the FIRST entry in the workflow's `paths:` list, so "docs plus one test
  file" is a worker deploy — there is no test-file exemption. PR #204 asserted the opposite
  in its own body (*"No `src/lib`, so no worker deploy"*), and the handover repeated it;
  merging it deployed on `05ee4ff` and bounced both machines. **AND IT HAPPENED AGAIN ON
  2026-08-31**, from the other direction: a PR described as *"web-side — reaches installed apps
  on a push, no rebuild"* — true of the APP — carried one `worker/*.test.mts`, so the merge
  restarted both pollers. **"No rebuild" and "no worker deploy" are different claims and the
  first does not imply the second.** Harmless that night (nothing
  queued, the release 10h out, and the workflow fails unless a fresh heartbeat lands — it
  came back in ~3 min, 2/2 shards held). **`docs/LANES.md` already said this in as many
  words** and was right; the PR body was the thing that drifted. **A merge-scope claim is
  not evidence — read `paths:`.** Same family as `6006428` claiming a fix it never made.
- **THE DEPLOY GOES RED OVER A HEALTHY FLEET WHEN FLY *REPLACES* A MACHINE (issue #243,
  2026-08-31).** The workflow's post-deploy step restarts the machines that were running
  BEFORE the deploy, by id. Fly replaces rather than updates any machine that is unreachable
  at deploy time (`Skipped lease for unreachable machine 84ed237b2d1e48` → `Replacing … by new
  machine` → the new one is `891e737f632d58`), so the old id is gone, `select(.id == $id)`
  matches nothing, `$state` is the **empty string**, `"" != "started"` is true, and it tries
  to start a machine that does not exist: `failed to obtain lease: machine not found`.
  - **AN EMPTY STATE MEANS "GONE" AND IS READ AS "STOPPED".** The absent-reading-as-a-negative
    shape, for the umpteenth time in this file.
  - **THE DEPLOY ITSELF WAS COMPLETELY FINE.** Both machines rebuilt, both health checks
    passed, `poller.shards` 2/2 held, heartbeat 14s. **Verify the fleet before reading a red
    worker deploy as an outage** — `/api/health/status` is the authority, not the tick.
  - **IT IS THE INVERSE OF THE TRAP THAT WORKFLOW EXISTS FOR**, which is why it is worth
    fixing rather than tolerating: the deploy is built to fail when *alerting is dead behind a
    green deploy*, and this fails when *alerting is fine*. That is the cry-wolf failure fixed
    three times elsewhere here, and the cost is that the next genuinely red deploy gets
    skimmed. **Do not weaken the heartbeat check while fixing it** — that half worked.
- **Non-secret worker tunables** live in `worker/fly.toml [env]`.

## Web-session gotchas (this environment)
- **Node `fetch` needs `NODE_USE_ENV_PROXY=1`** to reach Supabase / reservation portals.
  - **THAT INCLUDES EVERY STAGE OF `npm run verify` — `npm test` AND `npm run build` — AND
    THE FAILURE IMPERSONATES AN EGRESS REVOCATION (2026-08-31).** The build reads the catalog
    while collecting page data, so it dies on `/camping/group-camping/[state]` with a raw SQL
    dump and `Failed to collect page data`, which reads as a broken page rather than a missing
    variable. Prefix the whole `verify`, not one stage of it. A bare `npm test` fails **190 of 1,522** — every real-DB suite
    at once — with `DB query error: Host not in allowlist: <project>.supabase.co. Add this
    host to your network egress settings to allow access.` **Nothing is wrong with egress.**
    `curl` reaches Supabase in the same second, and `$HTTPS_PROXY/__agentproxy/status` names
    only `vercel.com`; it is Node's fetch going direct because the variable is not set.
  - **THE MESSAGE IS THE TRAP, and it points at the one hazard this file tells you to check.**
    "Host not in allowlist … add this host to your network egress settings" reads as the
    documented mid-session revocation — which HAS happened (2026-08-23/24, three hosts, and it
    survived a session boundary) — so the natural response is to report blocked egress and
    stop. **The discriminator is one `curl` to the same host**: reachable there and refused in
    Node is the missing variable, refused in both is the real thing.
  - The suite passes 1,522 with the variable set. **Prefix it, or read 190 failures as a
    regression in whatever you just touched** — which is the more expensive misreading, since
    the failures land in `claim.test.mts` and the hold suites, i.e. the alerting code.
- **`GITHUB_TOKEN`/`GH_TOKEN` ARE SET AND ARE 14-CHARACTER PLACEHOLDERS (2026-08-23).** Direct
  `api.github.com` calls with them are answered *"GitHub access is not enabled for this session.
  An org admin must connect the Claude GitHub App"* — **GitHub works ONLY through the MCP tools.**
  - **THE VARIABLE BEING SET IS WHAT MAKES THIS A TRAP.** `env | grep GITHUB_TOKEN` finds it, so
    the natural check passes and the natural conclusion — "a token is available, I can poll the
    API" — is wrong. **Check `${#GITHUB_TOKEN}`, or just call it once and read the body.**
    Presence is not liveness; same family as `status = 'sent'` meaning only "Twilio returned 2xx".
  - **AND "JUST CALL IT ONCE" IS NOT ENOUGH EITHER — THE REFUSAL IS REPO-SCOPED (measured
    2026-08-24).** The line above says direct calls are answered with the refusal. That is true of
    the calls anyone actually needs and **false as a general statement**, which matters because
    the exception is the endpoint a person reaches for first:
    ```
    GET /user            200   <- the placeholder AUTHENTICATES; returns the real login
    GET /rate_limit      200
    GET /repos/...       403   "GitHub access is not enabled for this session"
    GET /repos/.../check-runs   403   <- the watchdog case
    ```
    **So the natural smoke test SUCCEEDS.** `curl -H "Authorization: Bearer $GITHUB_TOKEN"
    api.github.com/user` printing your own account is a **false positive**, and a positive result
    is a worse trap than the mere presence this entry was written about — it looks like proof.
    `${#GITHUB_TOKEN}` is still the honest check, and **anything repo-scoped goes through MCP.**
    The conclusion below is unchanged; only its mechanism is corrected. The CONNECT tunnel to
    `api.github.com` is **open** — it is authorization that is withheld, not the network.
  - **IT COST A WATCHDOG THAT COULD NOT SEE ITS TARGET.** A `Monitor` polling CI on that token
    parsed the refusal as `check_runs: undefined`, found nothing terminal, and stayed **silent** —
    on course to report `TIMEOUT` after twenty minutes, which reads as *CI is hanging* rather than
    *the instrument never had access*. A watcher blind to its subject is indistinguishable from
    one patiently waiting, which is this file's most-repeated shape. ~~**To wait on CI, poll the
    GitHub MCP tools; `curl` to a `/repos/` endpoint cannot work here**~~ — and per the correction
    above, do not conclude otherwise from `/user` answering.
  - **THE `/repos/` HALF IS FALSE AS OF 2026-09-10, AND THE REASON IS THAT THE REPO IS PUBLIC.**
    Measured, all four in one command: the repo reads `private: false, visibility: public`, and
    **UNAUTHENTICATED** `GET /repos/TylerFlores1992/campsite-finder/actions/runs?head_sha=…`
    returns **200 with real JSON** — `total_count`, run names, `status`, `conclusion`. So does
    `/actions/runs/<id>/jobs`. **The token is irrelevant here**: `${#GITHUB_TOKEN}` is still 14,
    and with or without it the answer is 200, because public reads need no auth at all.
    - **SO A CI WATCHDOG ON PLAIN `curl` IS BUILDABLE, which the entry above says it is not.**
      That matters because the 08-23 failure it describes — a watcher that could not see its
      subject and stayed silent — was caused by using the placeholder TOKEN, not by the endpoint.
      A `Monitor` polling this unauthenticated works, and one was run to green on this very PR.
      - **AND THE `head_sha` FILTER SILENTLY OMITS RUNS, WHICH IS HOW A WATCHDOG BUILT ON IT
        STAYS QUIET THROUGH A FAILURE (measured 2026-09-17).** It returns **200 with
        `total_count: 0`** for a sha whose runs demonstrably exist — three shas checked hours
        after the fact, two of them `total 0`, while `?branch=<name>` returned every one of
        them in the same second:
        ```
        ?head_sha=2824b06…  total 0   []            <- a run that FAILED at 06:27:40Z
        ?head_sha=55d5a3e…  total 2   [cancelled, cancelled]
        ?head_sha=0250fee…  total 0   []
        ?branch=claude/…    total 50  (all of the above)
        ```
        **It cost exactly the failure this bullet says was caused by the token.** A background
        watch pinned to `head_sha=2824b06` reported nothing for twenty minutes while that run
        failed; the red was found by hand. **So the endpoint half of the 08-23 story is not
        retired — it is narrower: the endpoint answers, and this FILTER is the blind one.**
        - **NOT LAG — those runs were hours old.** And it is not the 40-character trap either
          (full shas throughout, which is the other recorded way to get `total 0` here).
        - **THE MECHANISM IS NOT ESTABLISHED. Do not write one in.** No clean pattern separates
          the two that answered from the two that did not: both populations contain cancelled
          runs, and both shas were the remote branch head when their runs were created.
        - **BUILD IT ON `?branch=<name>` AND MATCH THE SHA IN THE RESULTS.** One request, no
          filter that can silently under-report, and it sees the `pull_request` twin as well —
          which is the pair that overlaps for 3-301 s on every push.
          - **AND POLL IT NO FASTER THAN ONCE A MINUTE: THE UNAUTHENTICATED LIMIT IS 60 AN
            HOUR (measured 2026-09-19).** A watcher on a 30-second poll asks 120 times an hour,
            so it exhausts the budget partway through a single CI run and **every request after
            that is a 403.** Observed on this very branch: `x-ratelimit-remaining` had fallen to
            48 within minutes and then to **0**, and the watcher's own output alternated a real
            reading with `no runs yet` — which is **the 403 being reported as an absence**, i.e.
            this file's most-repeated failure, committed inside the instrument built to avoid the
            `head_sha` version of it, by the person writing the entry about it. The reset is an
            hour out, so a blown budget costs the whole run you were watching.
          - **SO CHECK THE STATUS CODE AND REFUSE TO SPEAK ON A NON-200.** *"We could not
            look"* and *"the API answered and this sha has no runs"* are opposite facts and
            `(j.workflow_runs || [])` merges them silently. Print
            `x-ratelimit-remaining` beside the refusal — it is the one header that says which
            kind of 403 you have, and it costs nothing.
          - **AND THE AUTHENTICATED ROUTE HAS NO SUCH CEILING: `mcp__github__actions_list` with
            `workflow_runs_filter.branch`.** It returns the same twins and is what actually
            produced the verdict here once the unauthenticated budget was gone. **Use `curl` for
            a one-off reading and MCP for anything that POLLS** — the 09-10 finding that public
            reads need no auth is about a single request, not about a loop.

###### AND A FIFTH RED ON A DOCS-ONLY DIFF, WITH THE TWIN OVERLAP RULED OUT BY ARITHMETIC (2026-09-19)
`# fail 2` of 2290 on a diff of **two Markdown files**, and the same tree then passed
**2290/2290 locally in full** — not merely "the suite passes alone", which is the stronger form
of the second condition. The names are unreachable: the log's visible window is `ok 1..11` and
`ok 1461..2257`, so the **hidden range is 12..1460** and `not ok` appears **zero** times in
312,688 characters.
- **THE CI TWINS ARE ELIMINATED, AND BY ARITHMETIC RATHER THAN BY HOPE.** The `push` twin ran
  **02:40:33 → 02:41:01** and the `pull_request` twin started **02:40:49**, so they overlapped
  for **twelve seconds** — the bottom of the recorded 3-301 s range. `verify` spends that on
  checkout, `setup-node` and `npm ci` before it reaches jsx-spacing, let alone `npm test`, so
  the cancelled twin **cannot have written a fixture row.** Compute the overlap before reaching
  for this explanation; it is the first one to hand and it does not always fit.
- **THE OTHER NAMED WRITERS ARE OUT TOO.** No other workflow was `in_progress`, and the Nightly
  RIDB Sync last ran **09-18 13:15-14:37 UTC**, thirteen hours earlier.
- **WHAT IS LEFT IS THE TEST-VERSUS-PRODUCTION CLASS, AND IT CANNOT BE SERIALISED.** The poller
  runs `rankHoldLine` every cycle, `dueHolds` every 15 s from the box, and `rcSyncIfDue` /
  `gtcSyncIfDue` write `campgrounds` — and **every recorded-flaky assertion falls inside
  12..1460** (`hub totals…` at 481, `a state under the threshold gets null` at 480, the
  `dueHolds` pair at 1052/1070, the line-rank tests at 1060-1070), while the two ruled-out
  suites (`sync-claim`, `ridb-photos`) fall **outside** it. **Consistent, and not identifying** —
  do not promote it to a named test.
- **SO THE THIRD CONDITION IS MET AT THE CLASS AND NOT AT THE TEST, and the honest substitute is
  the local FULL-SUITE pass.** A re-run is legitimate here for the reason the file already
  gives: the diff cannot reach the code, the suite passes, and the mechanism's family is named.
        - **AND THE SHAPE, ONCE MORE: a filter returning `total 0` and a subject with no runs
          are the same reading.** `total_count: 0` from a 200 is an absence, and this file's
          most expensive recurring error is treating one as a negative.
        - **AND "THE PUSH RUN CARRIES THE VERDICT" IS FALSE — WHICH TWIN SURVIVES VARIES,
          MEASURED ON CONSECUTIVE SHAS OF ONE BRANCH, IN BOTH DIRECTIONS.** The concurrency
          group's key is `github.head_ref || github.ref_name`, which resolves to the same branch
          for both events, so the twins cancel **each other** and the winner is simply whichever
          started second:
          ```
          2824b06  push          completed  FAILURE      2824b06  pull_request  cancelled
          8e24174  push          cancelled                8e24174  pull_request  in_progress
          ```
          A watch that reads the `push` run reported `cancelled` as the verdict on `8e24174`
          while the real run was still going — **a false red, from the second version of the
          same watch.** The rule is **whichever twin is NOT cancelled**.
        - **BOTH TWINS CANCELLED IS ITS OWN READING AND MUST NOT RENDER AS PENDING.** It means a
          newer push superseded that sha before either run finished, so it will never get a
          verdict — i.e. you pushed again while your own CI was running, which `docs/LANES.md`
          already forbids and which a watch can now say out loud. Two of the four shas on this
          branch are in that state.
    - **WRITES ARE UNTESTED AND ALMOST CERTAINLY STILL REFUSED.** Public reads are the claim.
      Anything that mutates (a merge, a comment, a dispatch) needs auth and the token is a
      placeholder, so **the MCP tools remain the only write path.** Do not widen this to
      "GitHub works via curl".
    - **WHY IT CHANGED IS NOT ESTABLISHED — do not write one in.** The 08-24 reading of `403` is
      recorded as measured; either the repository's visibility changed since, or the policy did.
      Nobody looked, and the mechanism does not affect the rule.
  - **JOB LOGS ARE STILL UNREACHABLE — AND THE HOST THIS FILE NAMES IS NOT THE ONE BEING HIT.**
    `GET /actions/jobs/<id>/logs` answers 302 to a signed blob URL, and following it fails at the
    egress proxy: **`productionresultssa0.blob.core.windows.net:443 — connect_rejected`.** The
    entry below names `results-receiver.actions.githubusercontent.com`, which does not appear in
    the proxy's records at all. **So that entry's CONCLUSION holds and its host is stale** —
    which matters only if somebody ever goes to allowlist one, and then they would allowlist the
    wrong thing.
- **A RED CI'S FAILING TEST NAME CAN BE UNREACHABLE, AND IT WAS ON 2026-09-07.**
  `mcp__github__get_job_logs` caps at about **5,000 lines / 312 KB no matter what `tail_lines`
  says** — 6,000 and 30,000 returned byte-identical output. The `verify` job emits ~6 TAP lines
  per test across 1,950 tests, so the cap covers roughly the last 800 tests: the window opened
  at `ok 1121` and the one failure was below it. **`not ok` appeared ZERO times in everything
  the tool would return, over a job reporting `# fail 1`.**
  - **So "which test failed?" has no answer through the CI log here.** Do not read a zero count
    as "no failure" — that is the absent-reading-as-a-negative shape, handed to you by the
    tooling rather than by the code.
  - **REPRODUCE LOCALLY WITH THE OUTPUT IN A FILE INSTEAD**: `npm test > log 2>&1` then grep
    `^not ok`. That is the only route to the name, and it doubles as the pass-alone evidence a
    legitimate re-run needs.
  - **THE CAP CAN BE TURNED INTO A BOUND, AND THE ok NUMBERS ARE STABLE (2026-09-08).** Asking
    `get_job_logs` with `failed_only` + `run_id` and a large `tail_lines` exceeds the tool's
    token limit and is **saved to a file**, which can then be grepped — same ~312 KB cap, still
    **zero `not ok`**, so that route is closed too. What it does buy is the WINDOW: parse
    `ok (\d+)` out of it and the hidden range falls out (on 09-08: 1-11 and 1148-1944 visible,
    so the failure was in **12..1147**). **TAP numbers match between a local run and CI** —
    verified: four guards landed at `ok 1344/1351/1352/1353` in both — so those numbers map
    straight onto local test names, and you can check directly whether YOUR OWN new tests were
    inside the visible window and passed, which exonerates the diff without guessing.
  - **The signed `logs_url` from `get_workflow_run_logs_url` is 403 at the agent proxy**
    (`results-receiver.actions.githubusercontent.com` is not allowlisted), so the full archive
    is not reachable either.
    - **THE CONCLUSION HOLDS AND THE HOSTNAME IS STALE (checked 2026-09-10).** The per-JOB log
      endpoint 302s to **`productionresultssa0.blob.core.windows.net`**, which the proxy rejects
      with `connect_rejected`; `results-receiver…` does not appear in the proxy's records at all.
      Unauthenticated `/repos/…` JSON now answers 200 (see the GitHub-access entry above), so it
      is specifically the LOG BLOB that is blocked and not the API. **Quote the blob host if
      anyone ever goes to allowlist one** — the name above would send them at the wrong target.
  - The three conditions still decide whether a re-run is honest — the diff cannot touch the
    code, the suite passes alone, and the mechanism is named — and **the third can be satisfied
    without the test name**: on 09-07 the Nightly RIDB Sync spanned CI's entire test window,
    which is a named writer, and the re-run went green once it had finished. See
    `docs/LANES.md` → "A THIRD WRITER NO LANE STARTS".
- **The credentials are process env vars — THERE IS NO `.env` FILE.** `grep`ping `.env*`
  finds nothing and looks exactly like "no credentials here". It isn't; check
  `printenv`. Cost a wrong "I can't build here" call on 2026-07-29 with Clerk, Stripe,
  Supabase and Mapbox all present. They are the **LIVE** keys.
- **Chromium can't reach Mapbox either** (`ERR_CONNECTION_RESET` — same TLS reset that
  blocks browsing the live site). `NODE_USE_ENV_PROXY=1` does NOT help: it affects
  Node's fetch, not the browser.
  - **THE MECHANISM NAMED THERE IS WRONG FOR RC, AND THE CONCLUSION HOLDS (re-measured
    2026-09-17).** `curl https://www.reservecalifornia.com/` answers **200**, and headless
    Chromium in this container fails on the same URL with **`ERR_CERT_AUTHORITY_INVALID`** in
    342 ms — a TRUST failure, not a reset. The proxy CA *is* in the system store
    (`/etc/ssl/certs/ccr-agent-proxy.pem`, and all 154 bundle certs are in
    `ca-certificates.crt`), so this is Chromium's built-in verifier rather than a missing
    bundle. **Quote the error you got, not this line.**
  - **AND CHASING IT IS NOT WORTH IT — the payoff was never TLS-shaped.** The reason to want
    RC's real page locally is to drive the leak's actual workload instead of a synthetic wedge.
    It could not: **`js.arcgis.com` is 000**, so the WebGL map that makes RC's SPA what it is
    would not load; and the production wedge happens during an **Okta navigation**, which needs
    a real sign-in on the production RC account from an address whose anti-bot posture this file
    records at length. **The blocker is the authenticated trip, not the certificate**, so fixing
    the trust store buys a different page rather than the experiment. `scripts/leak-repro.mjs`'s
    synthetic wedge already drives the named code path (`blink::RejectedPromises::HandlerAdded`)
    and is as close as a container gets. So any full-page screenshot renders maps as a blank
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
- **A COLUMN ALIASED `t` SILENTLY COLLAPSES A `query()` RESULT TO A BARE ARRAY.**
  `exec_select` is `SELECT json_agg(t) FROM (%s) t`, so a caller's own column aliased `t`
  makes `json_agg(t)` resolve to that **column** rather than the row — the result is an array
  of that column's values and every field reads `undefined`, while the ROW COUNT looks right.
  `exec_dml`'s `RETURNING` path has the identical shape, which is the sharper exposure since
  that one writes. **The alias being `t` is everything; `AS` is irrelevant in both
  directions.** Guarded by a tree scan in `src/lib/sql-row-alias.test.mts`, which also asserts
  the trap is still live so it deletes itself if the wrapper is ever fixed.
- **`git checkout -- <file>` REVERTS TO HEAD AND DESTROYS UNCOMMITTED WORK — SEVEN RECORDED
  TIMES.** Mostly mid-mutation-run, where it deletes the fix under test and the next mutations
  then report `DID NOT APPLY` against a file that no longer contains the code they target —
  i.e. **the harness reports its own damage as a result about the guards.** The tell is
  `git status --short` after the run. **Commit before mutating**, and revert a mutation by
  EDIT, never by checkout.
- **NEVER READ AN EXIT CODE THROUGH A PIPE.** `npm run verify 2>&1 | tail -25` reports
  **`tail`'s** status, which is always 0 — *and* the tail cuts every `^not ok` line, so one
  command produces two independent false greens. `... > log 2>&1; echo "EXIT=$?"` has the same
  defect one step along (it reports `echo`'s status). Redirect to a file, then check `# fail`
  and `grep '^not ok'` in the log — never the wrapper's exit.
- **`sqlit` INTERPOLATES, IT DOES NOT BIND.** A plain object used to become the literal
  `'[object Object]'`, which Postgres rejected and a `.catch` swallowed — that switched off the
  memory series entirely for ten minutes with nothing reporting it. It **throws** on a plain
  object now; pass `JSON.stringify(x)` with an explicit `::jsonb` cast. It also means every SQL
  string carries real values spliced into it, so **never return a DB error message to a
  caller** — log it.
- **A BACKTICK IN A SQL COMMENT TERMINATES THE TEMPLATE LITERAL.** These queries are template
  literals, so a backtick inside a `--` comment ends the string and the parse error surfaces on
  an unrelated line well below the cause. `tsc` catches it; nothing else does. Same family:
  **a semicolon inside a SQL string literal breaks a naive `;` splitter**, which is how
  migrations are applied by hand.
- **`npm run verify` GATES ON TWO SOURCE SCANS THAT `tsc` AND THE SUITE CANNOT SEE.**
  `jsx-spacing` (an HTML entity in a JSX text node makes SWC drop that node's leading
  whitespace) and `us-spelling` (British spellings in user-visible copy; **comments are
  stripped on purpose** — this repo's comments are British by convention, and a guard that
  flagged them would produce four hundred hits and be deleted). Neither can fail a typecheck
  or a test, which is exactly why they are gates.

## The house failure shapes — stated once, so they are not re-derived

Nearly every expensive mistake in this repo is one of six. Most of the archives are the same
six wearing different clothes; if you catch yourself about to write one up as novel, check here.

1. **AN ABSENT READING TREATED AS A NEGATIVE.** The most-repeated failure by a distance.
   *"We could not look"* and *"we looked and there is nothing"* must never render the same.
   `status = 'sent'` meaning only "Twilio returned 2xx"; `total_count: 0` from a `?head_sha=`
   filter; `rc_mb` NULL vs `0`; `claimBotCommands` returning `[]` for both "nobody asked" and
   "the query threw"; an empty scan that could not read a command line. **`unknown` never
   rounds to a verdict** — not to "signed out", not to "fully booked", not to "dead session".
2. **FIX PRESENT AND INERT.** The change is in the diff, reviewed, merged — and unreachable.
   A guard inside the loop it guards against; a pure function nothing calls; `void 0 && f()`
   passing an `indexOf` anchor; `if (false)`. **Ask what would have to run for this to matter,
   and pin it structurally.** Nine-plus recorded instances.
3. **A GUARD ANCHORED ON THE WRONG THING.** ~30 recorded instances. A window measured in
   CHARACTERS or LINES is a guess about layout and breaks on a new comment (four times). An
   `indexOf` that misses returns **-1**, and `slice(-1)` then passes vacuously for ever — so
   assert the anchor was found. A regex matching the DECLARATION rather than the call site; a
   token that occurs twice; an alternation without a non-capturing group. **Mutation-test every
   guard, and assert the mutation actually APPLIED — a mutation that silently no-ops is a green
   proving nothing.**
4. **PRESENCE IS NOT LIVENESS.** `GITHUB_TOKEN` is set and is a placeholder; a demo-account
   field is populated and its password does not work; a token exists and expired six minutes
   ago; a scheduled task is registered and every report is 401'd. **Check the value works, not
   that the field is filled.**
5. **A TIDY STORY RECORDED AS FACT.** A plausible mechanism that fits every reading is the most
   convincing wrong answer available — especially when it is true, specific and
   self-implicating. RC's "duplicate facilities" (measured: zero overlap, it was our own
   result-map bug); "the rehearsal stopped the ramps" (falsified within the hour by its own
   discriminator); crediting a repair to the wrong mechanism (three times). **Label a candidate
   as a candidate, and write the discriminator down beside it.**
6. **TWO FACTS OF DIFFERENT AGES PRESENTED AS ONE RECORD.** `appliedNote` beside `appliedSha`;
   a stale `bot_commit` next to a live heartbeat (COALESCE preserving it); a health reading
   quoted minutes after it was taken. **A reading goes stale faster than a conclusion drawn from
   it — re-read before acting, and date a reading against the deploy that served it.**

**And one meta-shape, which is why this file exists:** a finding that lived in only one place
was re-derived from scratch three times. **`docs/LANES.md`: a finding deleted in a merge reads
precisely like a finding nobody ever wrote.** Fold a correction in or close it as wrong;
leaving it open is choosing to re-derive it. `ls docs/NOTES-*.md` at the start of a main-lane
session and diff its newest sections against this file — the fold-in obligation has no trigger
and two findings once sat stranded for six days.

## Where the detail lives — the router

This file was 20,414 lines and was injected into every turn of every session. On 2026-09-21
the evidence was moved into four archives. **Nothing was deleted** — `docs/PRUNE-LEDGER.md`
has one row per moved block and the reassembly proof.

**A router entry is not a filename.** Each one carries the CONCLUSION and the standing
prohibitions, so a reader who never opens the archive still cannot re-run a dead experiment.
Open the archive when you are about to CHANGE the thing, not to find out what it concluded.

### Domain knowledge lives in SKILLS now — the only genuine progressive disclosure here

Three skills sit beside the archives and carry the working knowledge for the subsystems most
likely to be CHANGED rather than merely read: `.claude/skills/poller/`,
`.claude/skills/rc-autocart/` and `.claude/skills/store-release/` — **912 lines, none of them
resident.** A skill is loaded when the task matches its one-line `description`, so nobody has
to invoke one; `/poller` and friends force it if a session is being stubborn. **Write the
`description` as a TRIGGER** — the file paths and the symptoms — not as a summary, because it
is the only part of the skill that is always in context and it is the whole matching surface.

**`@imports` DEFER NOTHING — they are INLINED.** Lines 1-2 of this file are `@AGENTS.md` and
`@docs/LANES.md`, and both arrive in full on every turn. So "split the big file into imports"
is the obvious first idea and saves **exactly zero** tokens. A skill's body is the only thing
in this repo that is genuinely fetched on demand.

**The resident block, measured 2026-09-21:** `CLAUDE.md` + `AGENTS.md` + `docs/LANES.md` =
**1,653 lines / 121,901 bytes**, against **1,623,625 bytes** before — a 13.3x reduction. The
four archives and the three skills are ~21,000 further lines that cost nothing at all until
something asks for them.

**DO NOT** move a subsystem's detail back into this file to make it findable — that is what the
router entries above are for, and resident text is paid for on every turn of every session
whether or not anybody reads it.

---

### The Chromium / RC memory leak — DIAGNOSED, CONTAINED, **NOT FIXED**
**Full record: `docs/CHROMIUM-LEAK.md`** (9,300 lines — the whole investigation, verbatim).

**CONCLUSION, established from Chromium's own source and reproduced locally with controls.**
The ~32 GiB is `base::SharedMemorySecurityPolicy::kTotalMappedSizeLimit` — a per-process
budget on total mapped shared memory, checked with `>=`, so the maximum pure-2 MiB population
is **16,383** against a measured 16,381-16,383 on six region walks. Therefore the sections are
`base::SharedMemoryMapping`s: only two callers charge that budget, so **stopping at exactly
that number IS the fingerprint of the code path** (far stronger than the 2 MiB size, which is
a coincidence). The trigger is the **Okta navigation** (a controlled comparison, not a
correlation). The mechanism is a 2 MiB mojo data pipe per RESPONSE, mapped on the IO thread,
drained by a **posted task** — so a main thread wedged in
`blink::RejectedPromises::HandlerAdded` (named from the binary, confirmed in source) cannot
stop the mapping, only the release. **Reproduced**: a microtask loop that issues fetches and
never yields climbs 12 → 800 mappings in 30s, with both single-variable controls flat.
The burst completes in **≤34 seconds** and the memory is **never touched**, which is exactly
why the RAM arm has sat out 15+ ramps: it watches the one resource that is not running out.
Damage is therefore hard-capped by Chromium at 32 GiB of COMMIT. **Contained, not cured.**

**There is no fix on our side of the allocation.** The pipe size is compile-time (no Finch
flag), the drain is Chromium's, and the wedge is RC's own promise loop. What we have is a
**cure for the DURATION**: probe the resident page with a *bounded* `page.evaluate` and after
three consecutive no-answers **close the page** (not reload — a reload on a wedged page hangs
past its own timeout). It has fired in production three times.

**DO NOT:**
- **Rebuild any of these — each was measured blind for a knowable reason.** The heap trail
  (`JSHeapUsedSize` excludes external memory); **Track A / the native sampling profiler**
  (1-74 MB attributed against 8-9 GB); the **RAM arm** (untouched commit never lowers free
  RAM); the **memory dump's ownership graph for a ramping renderer** (a wedged renderer
  contributes ZERO allocator dumps at every level — settled off-box with a control, so a
  longer timeout buys an empty dump sooner); a **rejection counter** on the page (the DOM
  event is dispatched from a posted task, so it is silent during the event it would measure).
- **Hunt a 2 MiB constant.** The exhaustive grep is clean; of three exact-size matches one is
  refuted by experiment, one by source (discardable is 4 MiB), and the third cannot produce the
  count. **An exact match on a round power of two is not a fingerprint.**
- **Say "the sections are NOT base shared memory."** That came from a VOID dump of a healthy
  replacement browser; the cap proves the opposite.
- **Build Track B** (replay the Okta trip over `ctx.request`) without the owner's word — it is
  surgery on the one path between a queued hold and a missed cart, and the renewal's trip is
  measured flat.
- **Lower `LOW_RAM_MB`** (killed a working repair on 08-19), **lower `MEM_DUMP_STALL_MS`**,
  **park the resident page** (refused by `checkAndReport`'s localStorage rule, which would
  silence `autocart.rc_session` and the phone alarm), or **enlarge the pagefile** (the limit
  tracks the burst; Windows already settled it).
- **Force a ramp out of impatience.** `restart-rc` is the cheap lever (no campsite, no
  password) but it resets the browser age the old-population ramps need; a test hold locks a
  real campsite and shuts the box's update window for 6h. Ramp gaps run **2.3h to 18.6h** and
  are a mixture of two populations with different cadences.

### The RC session, login and token renewal — same file, same narrative
**Full record: `docs/CHROMIUM-LEAK.md`** (the renewal is inseparable from the leak: its Okta
trip is the trigger).

**CONCLUSION.** RC issues **no refresh token**, so there is nothing to silently refresh with.
The access token IS the session, ~60 minutes. A plain page load is **not** the bootstrap — the
**CLICK** on RC's sign-in control is, and Okta answers it from the `idx` cookie with no
credential typed. `planRenewal` stands down while the token is alive at all, because renewing
a live token is what leaks and has never once worked; the renewal fails ~96% of the time and
the SPA silently re-mints instead, measured across a ten-hour overnight. Okta's reported
expiry is a **rolling** window **our own unconditional probe refreshes** — that probe is
load-bearing BY ACCIDENT and must not be "tidied up" to match the renewal's guard. Behind it
is an **absolute cap** we cannot bring forward: it did not reset across a password sign-in
(three corroborations).

**DO NOT:** make the unconditional Okta probe conditional; read `okta=GONE` between releases
as a fault (it is the ordinary state, and `maybeAutoLogin` at T−30 is the designed repair);
print `rc-login.bat` over a live-but-short session — **it force-kills the Chromium the token
lives in**, and doing so has been a false alarm at least twice; clear cookies to force a
sign-in (**losing `DT` makes a login look like a fresh profile, which cost the household IP
twelve hours**); reach for a CAPTCHA solver (one CAPTCHA is an event, not an escalation).

### The 08:00 RC hold flow — offers, the fairness line, carts, the hand-off
**Full record: `docs/ARCHIVE-RC-AUTOCART.md`** (4,600 lines).

**CONCLUSION.** `RC_HOLD_CAPACITY = RC_SITES_PER_CART (2, RC's, measured) × RC_MAX_CARTS (10,
measured: ten distinct carts holding twenty reservations on one session)` = **20**, and
`src/lib/limits.ts` is the authority — every "capacity is 2" sentence in the archive is
historical. Concurrent cart minting is safe (six simultaneous `NO_CART` precarts, six distinct
carts), so a release group carts **four at a time**. RC **releases EARLY** — measured twice,
one morning with all three facilities' flip brackets entirely before T — which is why the cart
burst opens its lane at **T−15s** and retries every 500ms. Facilities flip **atomically**. One
live hold per (release, unit) is enforced temporally, after the bot once carted one campsite
twice for two different users 14 seconds apart. The hand-off is proven end to end on both
platforms, and `cart read back: 1 entry` was corroborated by a human on RC's own cart page.

**DO NOT:** promise a cart in copy the evidence has not earned (a user who believes the site
is handled **stops watching** — that rule governs every claim-screen decision); shorten the
T−15s burst lead; add beta wording to SMS (the coming-soon body is 154 chars against a
160-char one-segment budget, and two segments is the shape that was Undelivered/30007 thirteen
times); widen `supportsRcHold` past ReserveCalifornia (the bot holds ONE account; an Ohio
watch would be offered a hold nothing on earth can perform); "fix" a stranded hold by
loosening a test assertion.

**RC'S `customerId` IS PERSISTED, SO "SIGNED IN" OUTLIVES THE SESSION BY WEEKS (2026-09-21).**
Two Carpinteria holds carted and **both hand-offs were declined** — *"The unit is not available
for the date(s) specified"* — and RC's grid now shows both units booked under fresh reservation
ids. `#R359`'s pre-release pass reported `rc-session { loggedIn: true }` **beside**
`session { storedToken: 'jwt', storedExpiresInSec: -1466016 }`: a token **seventeen days dead**
under RC's own "signed in", because its SPA boots `isLoggedIn` from
`!!localStorage.getItem("customerId")` and that key survives expiry. Since #249 `loggedIn` is
the ONLY thing that sets `rcCheck = 'verified'`, and `mayRelease` was `verified || signedIn` —
so the gate let the bot go, and the user then walked the **whole Okta sign-in after the release**
with the site back on the open market.
- **IT IS NOT THE 2026-08-21 FIX RECURRING.** That one reads `expiresInSec` off the **`token`**
  stage and still works. This pass emitted **no `token` stage at all** — the expiry rode the
  **`session`** stage, which nothing read. **One fact, two carriers, and the gate was wired to
  one of them.** `classifyRcAppSession` has read the field correctly since it was written and is
  called only by `/api/admin/rc-session-probe`, so the knowledge existed nowhere near the
  decision. Fixed in `lib/claim-gate` (`rcTokenLifeFromReport` + `mayReleaseHold`), guarded by
  `src/lib/claim-gate.test.mts`, five mutations, **one of which survived the first round**: the
  boundary test pinned the `session` branch only, so flipping the `token` branch's `> 0` to
  `>= 0` went unnoticed. **Two carriers need two boundaries pinned.**
- **`prevTokenExpiresInSec` IS THE TRAP AND IS DELIBERATELY NOT READ.** It is negative on every
  healthy silent re-mint (the `renewed` verdict), so reading it refuses the sessions that work.
  `#R359` had BOTH fields negative, so a test built from that row alone cannot tell which field
  the code reads — the guard carries a separate renewal row for exactly that.
**THE CART BURST STOPS WHEN IT WINS, AND WE HELD `#R359` FOR FIFTEEN MINUTES WHILE LOGGING
"COULD NOT HOLD" (2026-09-21, from the runner's own log).** The burst reported
`won: false, attempts: 13, lastOffsetMs: -487, reason: "RC said something else: HTTP 200"` —
it gave up **half a second before the release with 15 budget left.** It gave up because it
had just succeeded:

```
15:00:00  ✗ could not hold #R359: HTTP 200 (13 fast attempts ending T-0.5s … RC said something else: HTTP 200)
15:00:00  ✓ held #M450 — won it on attempt 14 at T+0.1s
15:00:24  ✗ could not hold #R359: cart is already added      <- and ~75 more, every ~12s
15:15:03  ✓ held #R359 — entry 9b6aa2dc-a923-4e91-953d-30163200bf7b
```

- **THE MECHANISM IS ONE `||`.** `rc-hold-runner.mjs` builds
  `why = result?.submitted?.v?.error || \`HTTP ${result?.submitted?.status}\``, and `verdict()`
  sets `error: res?.ErrorMessage || ''` — **a SUCCESSFUL submit has no ErrorMessage**, so `''`
  is falsy and `why` becomes the string `"HTTP 200"`. `isNotAvailable("HTTP 200")` is false, and
  `shouldRetryBurst` stops on anything it does not positively recognise. **The stop condition
  fires on the success case.** Shape #1 again: an absent reading (no error text) rendered as a
  positive fact ("RC said something else").
- **`cart is already added` IS RC SAYING WE HAVE IT**, and the runner logs it as `✗ could not
  hold`. The decision "did we get it?" is taken from `findCartEntry` ALONE, discarding two
  facts the same response carries: `submitted.v.isSuccess`, and that string. R359 was ours
  continuously from ~T−0.5s; the `✓ held` at 15:15:03 is the **read-back finally matching**,
  not the site becoming free.
  - **SO `carted_at` AND `T+904s` IN THE READOUT ARE A LABELLING ARTIFACT, NOT A LATE WIN.** Do
    not read a large `T+s` as "RC released late" or "it dropped from someone's cart" without
    checking the log for `already added` — and the ~75 retries were ~75 real precart
    round-trips against RC for a site we already had.
  - **WHY THE MATCHER MISSES IS NOT ESTABLISHED.** `findCartEntry` matches `(placeId,
    facilityId)` from the load response's `LockedShoppingCart`, falling back to
    `JSON.stringify(e).includes(unitId)` — and that fallback is the matcher the module's own
    header says does not work, because **RC's cart entries carry no unit field**. A null
    `locked` would explain it and nobody has confirmed one. **The robust answer is the
    guarantee the release path already uses**: a cart this run minted with `NO_CART` contains
    only what this run put there, so `listCartEntries` identifies it without matching anything.
- **`#M450`'S RELEASE GENUINELY HAPPENED** — `→ handed over #M450 (HTTP 200)` at 15:27:34 in
  the same log — so "the release silently failed" is **refuted**, and the hand-off decline is
  still one of: a competitor inside the window, RC not yet propagating our release, or a
  transient. The retry shipped 2026-09-21 covers the last two without needing to know which.

- **`#M450` IS NOT EXPLAINED BY ANY OF THIS AND IS STILL OPEN.** Its session was healthy
  (`storedExpiresInSec: 3482`), it was carted at **T+0.1s** by the burst, and its precart was
  declined anyway — claimed at **minute 27.5**, past the point where the screen already warns
  the site may be gone. Whether RC had dropped our entry or a competitor took it inside the
  exposure window **is not determinable from what we recorded**, and the two live figures for
  RC's cart lapse are a bundle-read **15 minutes** and a single observation of **45**.
- **THE LATE TEXT IS THE SAME BUG, AND THAT IS WHAT MAKES IT A PRODUCT DEFECT RATHER THAN A
  LOGGING ONE.** `notifyHeld` fires on `markCarted` returning `firstTime` — the TRANSITION, in
  `/api/auto-cart/rc-holds`. So the user was told at **15:15:03** because that is when the
  read-back finally matched, not because anything about the site changed. The contents fallback
  resolves the entry key on the first pass RC answers `already added` — **15:00:24, about
  fourteen and a half minutes sooner** — and the fixed burst verdict can resolve it at T−0.5s,
  i.e. at the release. **A mislabelled hold is a text that does not arrive.**

**AN UPDATE THE OWNER REQUESTED WAS REFUSED, AND THE RECORD READ AS APPLIED (2026-09-21).** The
box sat on `2069e36` for a day while `bot_update_requests` said:

```
appliedAt  2026-09-21 00:08:03      <- stamped
appliedSha 2069e360…                <- the sha it was ALREADY on
appliedNote [update-guard] SKIP - outside the quiet window (20:00 PT, allowed 2:00-5:00)
            node.exe : Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
            file src\win\async.c, line 94
```

- **`appliedAt` AND `appliedSha` ARE STAMPED ON A SKIP.** Only `appliedNote` says it did not
  happen, and `autocart.bot_version` reads the sha. That is shape #6 — two facts of different
  ages as one record — and this file already names `appliedNote` beside `appliedSha` as an
  instance. **Read the NOTE before believing the sha.**
- **AND THE REFUSAL ITSELF LOOKS WRONG.** `update-guard`'s window check is
  `if (!requested && (hour < windowStart || hour >= windowEnd))`, so a REQUESTED update is
  supposed to bypass the quiet window — yet a requested one was refused for being outside it.
  `requested` is read from the feed (`requested = j?.updateRequested === true`), so a guard
  that crashed or could not reach the feed leaves it false and the window check then applies.
  **The libuv assertion in the same note is the candidate and the mechanism is NOT
  established.** Do not write one in.
- **ON DEMAND IT WORKS, MEASURED THE SAME EVENING.** `requestBotUpdate` at 03:06:43 UTC →
  `appliedSha eeb9d05`, note `updated and verified`, at 03:07:06 — **23 seconds** — and
  `bot-ask git-status` confirmed `HEAD eeb9d05 on master`. So the path is sound and the 09-21
  refusal was not the ration or the window by design.
- **THE HOLD-PROXIMITY CHECK IS THE ONE `requested` DOES NOT BYPASS**, and that is deliberate:
  `if (hrs != null && hrs >= 0 && hrs < minHoursToRelease)` refuses within 6h of a release
  whatever asked. At 20:12 PT against an 08:00 release it passed with ~11h48m of margin.

**A SKIPPED REHEARSAL COUNTS AS A REHEARSAL, WHICH SUPPRESSES THE ONE THAT WOULD MATTER.**
Tonight's pair read `03:00 · skip  the session is live — a rehearsal would prove nothing`
(correct) then `03:07 · skip  rehearsed 0h ago` — and the thing it had "rehearsed 0h ago" was
that skip. So the update, which ENDS the RC session and replaces the code, was immediately
followed by the one rehearsal that would have been informative being declined on the strength
of a non-event. The last real PASS is 2026-09-21 03:01. **A skip is not a rehearsal**; the gap
should be measured from the last ATTEMPT that ran the body.

- **`released` IS REPORTED AS SUCCESS WHEN IT IS NOT.** Both rows read `released` with
  `claimed_at` NULL, and the state table calls that *"the bot let go; the user's own session has
  it"*. There is **no terminal state for "handed off and the user lost the race"**, so the
  readout renders two lost campsites as the happy path.

### The mini-PC — supervision, updates, the watchdog, remote control
**Full record: `docs/ARCHIVE-RC-AUTOCART.md`.**

**CONCLUSION.** Everything remote rides a poller ON the box, so when the pollers are dead
there is nothing left to receive a command — that is structural and has bitten three times.
`supervise.ps1` restarts payloads and stops loudly after 5 exits in 10 minutes; a Windows
Scheduled Task watchdog fires every 5 minutes and **restarts processes, never the PC**;
updates are on-demand via a claim on the roster feed, with the Scheduled Task as fallback.
**An update ENDS the RC session** (it closes the Chromium the token lives in), however it was
triggered. The nightly quiet window is **structurally shut on any night with an 08:00 hold** —
`windowStart 2 · windowEnd 5 · minHoursToRelease 6` leaves exactly one passing instant.

**DO NOT:** kill Chrome **by image name** (`taskkill /IM chrome.exe /F` closes the browser of
whoever is at the machine) — kill by `--user-data-dir`, and the pattern must match both the
unquoted parent and the quoted children; put `\"` inside a `powershell -Command` string in a
`.bat` (cmd has no backslash escape, and the next `|` becomes a cmd pipe — the kill in
`rc-login.bat` never ran once); write non-ASCII into a `.ps1` (PS 5.1 reads a BOM-less file as
Windows-1252 and an em dash closes a string); leave a trailing space after a backtick
continuation; trust `autocart.bot_version` to answer "did the update land?" (it COALESCEs, so
a stale sha sits beside a live heartbeat) — **`bot-ask git-status` is the authority**; read
`tail-log` with its 80-line default when `tail-log <name>:400` is free.

### The App Store, Play Store and in-app purchase
**Full record: `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`.** These files and both consoles are the
**SIDE lane's** (`docs/LANES.md`, the APP/STORE surface) — `docs/APP-STORE.md`,
`docs/PLAY-STORE.md`, `docs/STOREKIT-PLAN.md`.

**CONCLUSION.** Five Apple rejections, five distinct causes — none a recurrence: a demo
password nobody had tried; information needed; 3.1.1 with no IAP; **3.1.1 again with the fix
live in production and invisible to a SUBSCRIBER demo account**; 3.1.2 over a missing Terms
of Use link. **Apple IAP was DECIDED on 2026-08-24 and is not an open question** — 3.1.3(b)
restates the demand rather than excusing it, and at 15% the store nets MORE than Stripe on
every plan (Stripe's flat $0.30 is an effective 14.9% on $2.50). The Play chain is proven in
production end to end; the Apple chain is proven in sandbox.

**DO NOT:** submit without running `scripts/app-review-precheck.mts <sign-in-email>` **in the
same minute** — the demo account has silently become a subscriber twice, and a subscriber sees
no paywall, which IS the 08-22 rejection; clear `REVENUECAT_SANDBOX_USER_IDS` before
APPROVAL (the reviewer's own purchase would then unlock nothing); flip `NATIVE_LINKOUT` /
`LINKOUT_BY_STORE.android` while a non-US track is live (the anti-steering carve-outs are
US-storefront only); press **Remove** on a submission item (it cannot be added back); assume a
build number is a Codemagic run number — `PROJECT_BUILD_NUMBER` is project-wide, **match on
upload date**.

### Billing — Stripe, RevenueCat, subscriptions
**Full record: `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`.**

**CONCLUSION.** The admin status counts read OUR database and the MRR tile reads Stripe live
via a list that **EXCLUDES trialing** — two correct numbers about different things, and a
refund does not cancel a Stripe subscription. The RevenueCat webhook **401'd every event it
ever received** until 2026-09-14, and the write behind it was unrunnable (`ON CONFLICT` will
not infer a partial index). Cancellation is two independent Stripe fields: a non-null
`cancel_at` does **not** imply `cancel_at_period_end`, and the admin badge gates on the flag
alone — so the one real cancelling subscriber is still invisible.

**DO NOT:** delete a real Stripe subscription row to make a check pass; write `grandfathered`
from any webhook or reconcile (migration 032 set it once and renewals must not strip it);
treat absence from Stripe as cancellation (a 404, a timeout and a real deletion arrive as the
same `null`).

### Alerting, SMS and A2P
**Full record: `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`.** The live rules are in the head of
this file (`## Alerting — the claim`, `## SMS: link ONLY to the provider`, `## Alert texts
must stay in ONE segment`).

**CONCLUSION.** The 08-05 filtering was the **DOMAIN**, not the length — confirmed by Twilio's
Carrier Partner, who also said the classification was **a bug on their side**, so §4.8, the
redirect shape and the stale samples are all unsupported as the cause. Campaign samples ARE
editable after approval; only four booleans are frozen. Three sites at one park is one text.

**DO NOT:** reintroduce a `camphawk.app` link into SMS without registering the domain on the
campaign first — the delivery panel is the regression detector and will go red within hours;
merge notifications by changing what a claim KEY means (that is what sent 26 texts in an hour).

### CI, the test suite and real-DB concurrency
**Full record: `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`.**

**CONCLUSION.** `npm test` hits the **production database on purpose** and is a SERIAL
resource (`docs/LANES.md`). A red on a diff that cannot reach the code has four named
mechanisms: two concurrent runs; a **cancelled CI twin's litter** (one push fires both a
`push` and a `pull_request` run, overlapping **3-301 seconds**); the **Nightly RIDB Sync**,
a third writer no lane starts; and **test-versus-PRODUCTION** — the Fly poller runs the same
sweeps every 60s against the same rows, which serializing the lanes cannot prevent.

**A FIFTH, AND IT IS THE EASIEST TO TELL APART: the RUNNER'S NETWORK.** 2026-09-21, master at
`93e56d4`: **50 of 2,377** failed in one block, the only error in the log being
`DB mutate error: TypeError: fetch failed` on a Supabase INSERT. `client.ts` retries
DNS/`ECONNREFUSED`-class errors for reads AND writes, and `fetch failed` for **reads only** —
it may have executed — so a write hit by a blip is not retried, by design. **Dozens of
failures at once is this; ONE is the other four.** Every other mechanism was excluded by
arithmetic rather than argument: the previous run ended 3 minutes earlier (no overlap), the
Nightly Sync ran 14 hours before, and `git diff 07dcd41 93e56d4 -- worker/ src/ scripts/` was
**empty** — the code was byte-identical to a tree that had passed on master 20 minutes
earlier. The suite then passed **2,376/2,376 locally at the failing SHA**, and the re-run was
green. **Prove the diff cannot reach the code with a path-scoped `git diff`, not by reading
the file list.**

**DO NOT:** push again while your own CI is running (**a merge IS a test run**); read a
`get_job_logs` with zero `not ok` as "no failure" (it caps at ~5,000 lines — reproduce locally
with `npm test > log 2>&1` and grep `^not ok`); lower a fixture sweep's 10-minute age gate
(that reinstates issue #76); "fix" a real-DB flake by loosening an assertion that covers a
real bug.

**A SIXTH, AND IT IS THE ONLY ONE YOU CAUSE ON PURPOSE: YOUR OWN WORKER DEPLOY (2026-09-21).**
Merging `#385` — a tree that had passed **2,388/2,388 locally and green TWICE on CI** — went
**`# fail 1` of 2,388 on master**, and the two workflows the one push started were:

```
Deploy worker (push)  19:52:51 -> 19:56:59   success
Verify                19:52:50 -> 20:02:09   FAILURE
```

**The deploy ran entirely inside the test window, and a worker deploy RESTARTS ALL THREE
POLLERS** — which write the production database the suite is running against. This is the
test-versus-production class, but unlike the other four it is **self-inflicted, predictable and
schedulable**: any merge touching `worker-deploy.yml`'s `paths:` fires both workflows off the
same push, so the restart is GUARANTEED to land inside that run's test window.
- **BUT THE OVERLAP IS NOT THE FAILURE, AND THIS ENTRY SAID IT WAS FOR ABOUT AN HOUR.** As
  first written it read *"expect a red master Verify on any such merge"*. The very next merge
  (#386, `483601d`) reproduced the overlap exactly — Deploy 20:48:40→20:53:19 inside Verify
  20:48:40→20:58:29, all three pollers restarted — and **Verify passed**. So the overlap is
  guaranteed and the disturbance is a RACE: this is a candidate to CHECK before reading a red
  as a regression, never a prediction. Struck rather than deleted because it is a tidy story
  recorded as fact, by the session that had just written the shape-#5 warning two screens
  above, inside the entry documenting its own mechanism.
- **PROVED BY TREE HASH, NOT BY READING A FILE LIST.** `git rev-parse be34ac5^{tree}
  b6506d9^{tree}` returned the SAME hash (`47cb9653`), and `git diff be34ac5 b6506d9 -- worker/
  src/ scripts/ .github/` was empty. The squash commit is byte-identical to the branch head that
  had already gone green twice. That is the strongest available form of condition one — the
  tree that failed IS the tree that passed.
- **THE NAME WAS UNREACHABLE, EXACTLY AS THIS FILE PREDICTS.** `# fail 1`, `not ok` appears
  **zero** times in 281,003 characters, and the visible `ok` runs were **1-11 and 1641-2355**, so
  the failure sat in the hidden range **12..1640**. The window method works and still cannot
  name it; the local full-suite pass is the substitute.
- **THE DEPLOY ITSELF WAS GREEN AND THE FLEET WAS FINE** — `poller.shards` 3/3 held, heartbeat
  4s. So this is the cry-wolf shape once more: the red tick is on the workflow that was
  CORRECT, about a run it disturbed.

**A HANG MAKES EVERY ASSERTION IN ITS FILE SILENT, WHATEVER THE ORDER (2026-09-20).** A guard
whose subject can loop for ever cannot live in the same file as the loop. Two attempts, and
**the second is the finding**: (1) placed at the top of the termination test it never ran,
because a CEILING test two tests above already calls the ladder with `MAX_SAFE_INTEGER` — the
ordinary guard-after-the-thing shape, whose obvious repair is to move it up; (2) moved to the
**first test in the file** it still could not report, because **node:test buffers a file's
output until the file COMPLETES**, so a hang anywhere in it yields `TAP version 13` and not one
line more. Measured both with `--test` and by running the file directly. An assertion that
throws in test 1 is recorded and never printed. **So ordering is not the remedy and no position
inside a hanging file is one** — `worker/renewal-ladder-shape.test.mts` never calls the ladder,
so it cannot hang, and it fails in **1 second** naming the line where the in-file versions hung
for 60s asserting nothing.
- **AND IT IS WHY A MUTATION RUN MUST READ THE CLOCK, NOT ONLY THE EXIT CODE.** A hang under
  `timeout` exits 124, a non-zero exit like any other failure; a suite that "fails" in 60s and
  one that fails in 1s are different facts, and only the second is a guard.
- **TWO ASSERTIONS, BECAUSE NEITHER CATCHES THE OTHER'S MUTATION.** The loop may not be bounded
  by the gap it is doubling (doubling zero never reaches the cap), AND the step count may not be
  bounded by `failures` (which has no upper bound). Deleting `MAX_DOUBLINGS` leaves the header
  reading `n < steps` and sails past the first check — which is how that mutation survived a
  verification round.
- **THIS ENTRY WAS ITSELF STRANDED FOR A DAY AND NEARLY LOST.** It was written on 2026-09-20
  onto a branch whose PR never opened, so the 09-21 prune — which read master — could not carry
  it, and `git grep` on master found it nowhere. Recovered from the branch before restarting it.
  **`docs/LANES.md`'s rule is not only about the side lane's notes file**: an unmerged commit on
  your own lane's branch is the same hazard, and a prune is exactly when it bites.

### The web app, watches, Explore and SEO
**Full record: `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`.**

**CONCLUSION.** A cancellation **retarget was tried and falsified in a day** and the guards in
`src/lib/seo-retarget.test.mts` are INVERTED so reinstating it fails a test — **do not re-run
it.** The axis is OBSCURITY, not source. Site-type and pets filters were removed because the
data cannot carry them (showers is rec.gov-only; `pets_allowed` is 100% true off rec.gov);
per-site MUTING is what replaced them, and it is honoured by both RC finders. Every
`env(safe-area-inset-top)` fix is web-side and reaches installed apps on a push.

**DO NOT:** promise a filter the poller does not read (`watches.site_type` is written by the
UI and read by NOTHING in `worker/`, and `notify_sms`/`notify_email`/`notify_push` are dead
columns — the real gates are per-USER); add a number to the cancellation-timing copy (nothing
we or anyone else publishes licenses a probability).

### The session harness — child sessions, Routines, browser QA
**Full record: `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`.**

**CONCLUSION.** A spawned child **cannot push** unless `extra_allowed_tools` is passed at
creation — roughly $53 of finished work has been stranded in reclaimed containers — and no
tool can grant it afterwards. A child's arrival cost dominates (~12M cache-read tokens against
18k output), so **a big self-contained change is a better dispatch than a small one**, and
children share the parent's quota. `ListAgents` is machine-local, so an empty list is **not**
exclusive use of the database. A `Monitor` expires at 30 minutes by construction — use a
backgrounded bash task with a terminating condition for anything load-bearing.

**DO NOT:** prove a child's push grant on a `claude/**` branch (it fires `verify` against the
production DB — use `probe/...`); read a matching `cse_`/`session_` suffix as proof a Routine
woke the session you meant (it matches on every firing); treat a green Routine run as a
measurement taken — read the output.

### Archived handover blocks (2026-09-01 → 2026-09-11)
**Full record: `docs/ARCHIVE-OPEN-BLOCKS.md`**, newest first. Superseded state snapshots,
kept because several carry a reading that exists nowhere else. **Read them as history, not as
state** — anything still live was carried into the router entries above or the section below.

## Open / next session

**Start at `docs/NEXT-SESSION.md`.** This section is a short list of what is genuinely open on
2026-09-21. Everything older is in `docs/ARCHIVE-OPEN-BLOCKS.md` (the dated handover blocks,
newest first) or in the subject archives the router points at. **A dated block that is no
longer state was MOVED, not deleted** — see `docs/PRUNE-LEDGER.md`.

#### State, read rather than remembered
Read it, do not quote it. `git fetch origin master && git log --oneline origin/master -10`
for the tree; `/api/health/status` for the fleet (it is the authority, not a green deploy
tick); `npx tsx scripts/bot-ask.mts git-status` for the mini-PC's sha (**never**
`autocart.bot_version`); `ls docs/NOTES-*.md` for anything the side lane has not folded in.
Migration blocks: **main `077–079`, side `080+`** (`docs/LANES.md` is the authority).

#### Open, and each one is a decision rather than a task
- **The leak is diagnosed, contained and NOT fixed.** `base::SharedMemorySecurityPolicy`'s
  32 GiB cap is the ceiling, and the page-wedge cure has fired three times in production —
  which is a capability demonstrated, not a rate. **`docs/CHROMIUM-LEAK.md`, and read the
  router's DO-NOT list before building any instrument.**
- **The commit residual has no watcher.** Every arm reads free RAM or private bytes; the burst
  spends neither. Four options with their predicted readings are in the leak file under "THE
  RESIDUAL IS COMMIT, AND NOTHING WATCHES IT" — **option B (the pagefile) is OFF, measured.**
- **The cancellation badge cannot see the one cancelling subscriber.** The data is right; all
  four gates read `cancel_at_period_end` and Stripe reports a **dated** cancellation with the
  flag false. The repair is `COALESCE(cancel_at_period_end, false) OR cancel_at IS NOT NULL` in
  **one** definition rather than the four copies that exist. Deadline Oct 8, three weeks of
  margin, **NOT STARTED on the owner's instruction.**
- **#22 — `hold-fixture-invisibility` borrows a REAL user with a phone** and asserts
  `holdAtRisk` returns its numeric fixture. Give it its own inserted, phoneless user. Real-DB
  and in `worker/**`, so verifying it restarts all three pollers.
- **#26 — the request counter is attached to the RESIDENT page only**, so workers and every
  throwaway tab are invisible. `context.on('request')` closes two thirds of it. Bot-side; land
  it with something else bot-side, because an update ends the RC session.
- **`#M450`'s hand-off decline is unexplained.** Healthy session, won at T+0.1s, declined
  anyway at minute 27.5. Two candidates remain and the data cannot separate them: a competitor
  inside the exposure window, or RC not yet propagating our own release. The retry shipped
  2026-09-21 covers the second without settling which it was.
- **`released` has no terminal state for "handed off and the user LOST the race."** Both
  2026-09-21 rows read `released` with `claimed_at` NULL, which the state table calls the happy
  path. Two lost campsites render as success.
- **Why `findCartEntry` misses a cart RC says is ours is NOT established.** The contents
  fallback (#389) routes around it; the cause is still open, and a null `LockedShoppingCart` is
  an unconfirmed candidate rather than the answer.
- **`update-guard`'s `requested` bypass may not work.** A requested update was refused for
  being outside the quiet window, which `if (!requested && …)` says cannot happen; the libuv
  assertion in the same note is the candidate. On-demand works (measured, 23s), so this is a
  reliability question rather than a blocker.
- **A skipped rehearsal counts as a rehearsal**, which suppressed the one informative rehearsal
  after the 09-21 box update. Bot-side, one gap calculation.
- **The RC reconnect's NEXT step is unexplained.** #363 fixed the hidden-input timeout; the box
  now submits the email and rec.gov renders **no password input at all** (`0 match(es), 0
  visible`). That is a third state, not the old bug. **No mechanism is written in.**
- **Two docs carry stale instructions and are the SIDE lane's**: `docs/APP-STORE.md` §2d's
  sign-out steps and §5, and `docs/STOREKIT-PLAN.md` §4e's "gated on SBP" checklist. Named
  here rather than edited.

#### Waiting on somebody, not on work
- **App Store:** the console is the only record and no session can read it. Run
  `scripts/app-review-precheck.mts <sign-in-email>` **in the same minute as a submission** —
  the demo account has silently become a subscriber twice.
- **The browser-QA bridge session** answers from a cloud container rather than the Windows box;
  the owner action is `claude --chrome --remote-control "camphawk-qa"` on that machine.
- **A forced ramp is not available to a session** — `restart-rc` is refused by the harness
  classifier — so the leak's remaining production readings wait on a natural event.
