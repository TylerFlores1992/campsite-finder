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
`scripts/auto-cart-bot/rc-probe.mjs` answered all three open questions:
- **Unattended login works, HEADFUL ONLY.** Every headless attempt failed at the Okta
  email step; every headful one passed first try. The production bot needs a real
  display. Never read a headless failure as "RC blocked us".
- **The bot CARTS**, verified by reading the cart back and matching `LockedShoppingCart`'s
  `(placeId, facilityId)` — Leo Carrillo site 006, 08/27→08/28. `cart is already added`
  on a re-run is proof the hold survived, not a failure.
- **The cart KEY cannot hand it over.** A second session on the SAME account (different
  token, fresh profile) reads that cart as 0 entries — it is bound to the SESSION.
- **Therefore carting is HARMFUL without a hand-off**: the hold locks the unit, so it
  takes the site off the market and denies it to the person we alerted.
- **PATH B IS VALIDATED (2026-08-07)** — bot holds, releases on demand, the user's OWN
  session takes it. `remove/cartentry` returned in **97ms** and a different session
  re-carted **2544ms** later, confirmed by reading that session's cart back. **No cooldown
  on a released unit.** ~2.5s is the whole exposure window, and it is dominated by the two
  precart round trips, not the release. No credential moves and the bot needs ONE account,
  not one per user — which is why this beats the session-transfer path.
- **What remains — CORRECTED 2026-08-08.** This used to list "the keep-warm, a release API,
  and the recapture in the extension / app webview". Three of those four shipped on
  2026-08-07 and the entry was never updated: the keep-warm is `rc-keepwarm.mjs`, the
  release API is `POST /api/rc-holds/claim` → `claiming` → the runner's 1s fast lane →
  `released`, and the desktop **extension already recaptures** (`extension/`, MV3;
  `rc-inject.js` grabs the live `accesstoken` from RC's own calls in the MAIN world,
  `content-rc.js` reads the `#camphawk-rc` fragment and precarts).
  **The one genuinely missing piece is recapture ON MOBILE** — and the claim link is
  tapped on a phone at 8am, so it is the case that matters most. iOS Safari and Chrome
  Android cannot run the extension, and the app opens external links in the system
  browser, so nothing consumes the fragment there. Doing it properly needs an in-app
  webview we can inject into (a native plugin → rebuild → new review), so it is
  **native-side work, not a web deploy**.
  Mitigated web-side 2026-08-08 instead of waiting for that: the hand-off lands on the
  exact **loop** (`bookingUrlFor` now routes through `lib/booking-url`, so `/park/720`
  became `/park/720/715`), and the claim screen **orders the steps so the navigating
  happens BEFORE the release** — open RC, find the site, then hand over — rather than
  starting the clock and only then sending the user off to search.
- **The precart payload is solved** — `{extraId, extraValue}`, lowerCamel; see the same
  doc. That contract is reusable by whichever hand-off we pick.

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

### The first 8am hold FAILED — and the recovery worked (2026-08-07)
Offered 05:26, tapped 06:00, site released at 08:00 exactly as predicted (the poller saw
it and sent a normal `available` alert at 08:00:10) — and **the mini-PC runner never
picked it up**. Not a cart, not a `failed`, no error: `updated_at` unchanged since the
tap. The rec.gov bot carted two sites that afternoon, so the box was up and networked;
the RC runner specifically was dead, and `autocart.bot` stayed green throughout because
that is a different process.
- **Three fixes shipped the same day, all verified in production:**
  `worker/expire-holds.ts` (hourly on Fly — the old cleanup lived in the hold feed, which
  only runs when the runner polls, i.e. a watchdog wired to the thing it watches) marked
  the hold `failed` at 20:59 and sent a `hold_missed` alert on all three channels, **SMS
  confirmed delivered by the carrier receipt**; migration 045 `rc_runner_heartbeat` +
  the `autocart.rc_runner` health check, which FAILS only when the beat is stale AND a
  hold is due; and `findRCHeldUnit` now takes a flex spec (six of nine live RC watches
  are flexible and could never have been offered a hold at all).
- **WHY THE RUNNER STOPPED: the mechanism is now known, the instance is not (2026-08-08).**
  `runPass()` has three paths that do the whole job and change NOTHING — the Chromium
  profile lock is held (60s wait, and a crashed process leaves a stale lock file), the RC
  session is dead (no token in localStorage), or `launchPersistentContext` throws. In all
  three the hold stays `requested`, `updated_at` never moves, no `failed` row is written,
  **and `autocart.rc_runner` stays GREEN** — because that heartbeat is stamped by the FEED
  POLL, which only proves the runner can reach camphawk.app. That is exactly the observed
  signature, and given RC's reCAPTCHA escalation the same day and a session hand-signed-in
  nine hours earlier, "session dead" is the leading candidate. It cannot be confirmed
  retroactively: nothing recorded it.
- **So the fix is to make all three self-reporting (migration 046).** `rc-keepwarm.mjs`
  already asks RC a question only an authenticated session can answer, every 20 minutes,
  and threw the answer away into a console on the mini-PC — it now POSTs it, so a dead
  session is a **`autocart.rc_session` warning the evening before** rather than a
  post-mortem at 08:00:10. And a skipped pass stamps `last_attempt_note` on the affected
  holds **without moving status** (they must retry) and **without touching `updated_at`**
  (that means "the hold changed"; conflating them destroys the "unchanged since the tap"
  tell). `worker/rc-holds.test.mts` fails against both mistakes — verified by making them.
- **`unknown` is never reported as dead.** A busy profile, a 403 from RC's edge and a
  network blip all mean "we could not tell"; writing those as `false` would send the owner
  to do a human sign-in over a healthy session. Keep-warm posts nothing in that case and
  the server sees the last verdict go stale, which is the honest reading. Same rule as
  `hasAvailabilityInRange` returning null.
- **It caught a dead session 90 SECONDS after going live** (2026-08-08 ~04:57 UTC), ten
  hours before the release, with one hold ahead of it — while `autocart.rc_runner` sat
  green at `last poll 9s ago`, because the runner was healthy and never was the problem.
  The whole thesis, observed live within minutes of shipping. One `rc-login.bat` later:
  `load/shoppingcart → HTTP 200`, everything green. **It proves the failure mode is real
  and recurs; it does NOT prove it is what killed the 08-07 hold** — nothing recorded that
  day's session state and nothing ever will. From here there is a continuous record.
- **`rc-login.bat` was killing by WINDOW TITLE, which matched nothing** (found the same
  night). `start-all.bat` launches these through `powershell -NoExit`, and PowerShell
  retitles its own console, so every run of the script left the old keep-warm and hold
  runner ALIVE — the processes it opens by announcing "Closing anything holding the RC
  profile". It failed silently at the only step that mattered, then loudly somewhere
  harmless (the relaunched windows died on `Tee-Object`, since the survivors held the logs
  open). Two Chromium on one user-data-dir corrupt the session it exists to restore, so
  **the profile lock is what stood between this and real damage.** Kills by command line
  now — deliberately NOT `taskkill /IM node.exe /F`, which is why `update.bat` was immune
  but would take the rec.gov bot down here. And `update.bat` said "Three new windows"
  long after there were five.
- **This needs a mini-PC update to take effect** — `update.bat`, run by a human. Until
  then `autocart.rc_session` reads "never reported" (a warn, so the banner is amber), which
  is correct: unknown is not healthy. **Done 2026-08-08; live and green.**

### Twilio A2P ticket #28871693 is OPEN (filed 2026-08-07 14:28 PT, P3)
Asks two things: apply the sample/description/message-flow edit to the approved campaign
(no "Edit Campaign" link exists — that surfaces on FAILED campaigns, and API edits are
Private Beta), and confirm whether Twilio or the carrier filtered four 30007 SIDs.
**The reply decides the work:** carrier → do the edit; Twilio-side → the edit would not
have fixed it, so do NOT re-trigger vetting on a campaign that is currently delivering.
Full text, replacement copy and the Console path in `docs/a2p-campaign.md`; samples are
generated from the dispatcher by `scripts/a2p-samples.mts`.
**Not urgent:** all twelve recorded 30007s are from 2026-08-05, before the
`camphawk.app/b/<token>` link came out of SMS. None since.

### The 8am flow could never have worked — the cart fired BEFORE the release (2026-08-08)
The second hold (South Carlsbad `#41`) failed with RC's own words: *"The unit is not
available for the date(s) specified."* Exact times: **attempt 14:58:35 UTC, release
15:00:00 UTC.** It carted **85 seconds early**, and the site had not been released yet.
- **The feed serves a hold 90s early on purpose** so the browser is open and the token in
  hand when the site frees. The runner treated that as permission to submit. RC said no —
  correctly — the server called `markFailed`, and **`failed` is terminal**: `dueHolds`
  only ever returns `requested`, so the one and only attempt was guaranteed to be too
  early and there was never a second. **No session and no runner could have saved it.**
  Yesterday's dead runner hid this completely.
- **Three fixes.** `reportCartFailure` keeps a hold `requested` while its release window is
  still open, so the next pass retries — server-side, and alone it would have carted this
  one. The runner now **waits out the lead** before submitting (`msUntilRelease`, Pacific
  wall-clock parsed as UTC on both sides so the offset cancels; never `new Date()` on a
  zone-less string). And a due cart gets a **5s feed lane** like claims do — not 1s: the
  precart is a real POST from a residential IP RC's WAF has 403'd before.
  `worker/rc-holds.test.mts` fails against the terminal-failure bug, verified by restoring it.

### The RC keep-warm was never renewing anything (2026-08-08)
It opened a tab for **8 seconds every 20 minutes**. RC's SPA renews its Okta token on its
own timer somewhere inside the token's ~1h life, so the odds of that tab being open when
the renewal fires are **8s in 20min — under 1%**. It was not renewing the session; it was
observing it occasionally and reporting a token nothing had ever extended.
- **The measurement is what exposed it.** `session_since` / `session_live_since`
  (migration 047) record when the verdict CHANGED, not when it was last checked — the
  latter is overwritten on every 20-minute reconfirmation, so a session that died at 05:30
  and was probed at 13:40 read as "dead, 0 minutes ago". First real reading: **1h20m from
  sign-in to death**, about one access token.
- **THE "~8 HOUR SESSION CAP" I WROTE HERE WAS WRONG.** Two earlier figures (~9h, ~8.4h)
  were not measurements — nobody looked in between, so they bounded when we NOTICED. The
  first actual measurement falsified the hypothesis within hours of my writing it down.
  Do not reason from "when we noticed" again; that is what 047 exists to prevent.
- **The fix: the page stays open.** `warmResident()` holds the profile with RC loaded
  continuously; the 20-minute tick is now only a liveness check and measurement, not the
  keep-alive. A real user's browser stays open, and so does this one.
- **That needed the profile lock to grow PREEMPTION.** A permanent holder and a short-job
  holder cannot share a plain mutex — the runner would time out every time, at 08:00:00,
  on the one job that matters. The runner drops `.camphawk-profile-wanted`, the keep-warm
  sees it within a second, closes and releases; the runner works, clears the flag, the
  keep-warm reopens. Still exactly one Chromium on the profile. A stale request expires on
  its own — a requester that dies must not stand the keep-warm down forever.
- **Two ways a resident tab silently buys nothing**, both fixed: Chrome **throttles timers
  in background/occluded windows** (so the tab looks healthy and renews as little as the
  8-second visit did — launched with the three backgrounding flags disabled), and a
  **visible window gets closed** by anyone tidying up (it is headful because RC
  fingerprints headless Chromium; the loop now notices a dead context and reopens).
- **VERDICT IN, 2026-08-09: THERE IS NOTHING TO KEEP WARM.** The resident tab did not save
  it, and the silent-auth plan was built and then abandoned on the evidence. Three
  instruments agreed: the profile holds **no Okta session cookie at all** —
  `signin.reservecalifornia.com` carries only `DT` (device id), `ln` (remembered username),
  `luf_*` (last factor) and a `JSESSIONID` that dies with the browser. **No `sid`, no
  `idx`.** RC's own bundled `okta-auth-js` fires `authorize?prompt=none` on its autoRenew
  timer, finds nothing to authenticate against, fails, and **deletes the tokens** — which is
  precisely the log we captured. So `prompt=none` was never going to work for us either: the
  challenge does live on the credential form and not on a cookie exchange, but there is no
  cookie to exchange. **The access token IS the session, and it lasts ~60 minutes.**
- **Therefore: obtain a token shortly before the hold.** `rc-autologin.mjs` +
  `maybeAutoLogin` sign in ONCE, within `RC_AUTOLOGIN_LEAD_MIN` (15) of a real release,
  only when the current token genuinely will not cover it, **one attempt per release
  forever** (tracked by release time, so a failure can never become a loop), and a CAPTCHA
  is a full stop that wakes a human rather than a slower retry. The guards are the design:
  a login is the act that got the household IP blocked for 12h on 08-06 — but that was
  repeated logins **from fresh profiles**, and the `DT` cookie in the persistent profile is
  the thing that tells Okta this is a machine it has seen before. Every failure path reports
  so the 07:30 pre-flight and a push tell the owner to sign in themselves; **losing a hold
  because we did nothing is recoverable, losing the household IP is not.**
- **The password lives in `credstore.mjs` (DPAPI, CurrentUser), NOT in `.env`.** Two more
  lines beside `AUTOCART_TOKEN` was very nearly what shipped and would have been wrong: the
  file is git-ignored but readable by every process on the box, and this machine is
  routinely screen-shared. Saved once with `mini-pc\rc-save-password.bat` (echo muted for
  the same reason). `credentials()` is not exported, and `worker/rc-autologin.test.mts`
  asserts that plus every line the plaintext may appear on.
- **The first `--save-login` ECHOED THE PASSWORD** (reported 2026-08-09, fixed same day).
  It created a `readline` for the email prompt and left it OPEN while reading the password
  raw — and readline in terminal mode echoes every keypress itself. `setRawMode(true)`
  silences the TTY driver, not another library listening on the same stream. Reproduced
  under a pty before fixing, which also exposed a second bug: the old handler compared the
  whole CHUNK to `'\r'`, so a PASTED password (one buffer) fell through and was stored with
  a trailing carriage return. Hand-typed input was fine; pasted was silently wrong. It now
  asks twice, because a hidden field with no confirmation makes a typo undiscoverable until
  07:45, where it reports "check the password" — indistinguishable from a real change.
- **AN OKTA SESSION EXISTS NOW, AND THAT REOPENS A CLOSED QUESTION (2026-08-09 21:40 PT).**
  The first successful `--test-login` reported `okta=ALIVE (exp 2026-08-09T16:36:23)` — a
  200 from `/api/v1/sessions/me` with a **~12-hour expiry**. Every earlier reading was
  `okta=GONE(404)`, which is what "THERE IS NOTHING TO KEEP WARM" below was built on.
  **The likeliest cause is the tick-box:** the ported login calls `keepSignedIn()`, and the
  hand-rolled one never did — every previous session was established without "Keep me
  signed in", so of course Okta issued nothing persistent. The human `--login` path only
  *asks* a person to tick it.
  **Do not rewrite the conclusion below yet.** One reading is not a lifetime, and the thing
  that matters is not whether a session EXISTS but whether RC's `authorize?prompt=none`
  now succeeds against it — that was never testable before, because there was nothing to
  authenticate against. **The evidence arrives on its own:** watch `token exp in Xm;
  renewed=` on `autocart.rc_session` across the 20-minute passes. Climbing back toward
  ~60m ⇒ silent renewal works and the keep-warm becomes real again; counting to zero and
  dying ⇒ the access token is still the whole session and the auto-login stays the answer.
  Either way the 08:00 hold is now covered twice over: the Okta session outlives it
  (expires 09:36 PT) and `maybeAutoLogin` is the backstop.
- **`rc-autologin.mjs`'s sign-in is PORTED FROM `rc-probe.mjs`, and reinventing it cost two
  failed runs (2026-08-09).** The probe signed in unattended and carted on 08-06; the new
  module was then written from scratch, four hundred lines from a working implementation in
  the same directory, and hit the same walls the probe had already documented. **Before
  touching the login flow, read `rc-probe.mjs`'s `signIn()`.** The differences that mattered:
  **Enter BEFORE the button** (Okta disables Next mid-transaction, so a click reports
  success and does nothing — this file had it backwards); the email step is **flaky, not
  blocked**, so three rounds with a **reload** between, which clears a half-finished
  transaction; **"Keep me signed in"** was never ticked; **Okta's error banner**
  (`[role="alert"]`, `.okta-form-infobox-error`) was never read, so "check the password" was
  a guess from which timeout expired rather than RC's own words; the email was `fill()`ed
  and never read back; and a **DOM-click fallback** separates "Okta refused us" from
  "Playwright could not hit the button". Not ported: the probe's willingness to continue —
  one login per release still stands, and a wrong password or CAPTCHA stops dead.
- **`mini-pc\rc-test-login.bat` proves it works BEFORE the morning it matters.** It clears
  the localStorage token **only** — never cookies, and do not sign out via RC's own menu
  either: the `DT` cookie is the device identity, and losing it makes the login look like a
  fresh profile, which is the exact shape that got the IP blocked. Then it runs the real
  `attemptLogin`. **A failure leaves you signed OUT**, and the script says so and points at
  `rc-login.bat`.
- **A dead session with a hold <45 min out now RINGS THE PHONE** (`lib/notifications/voice.ts`,
  `holdAtRisk`). Not a louder push: iOS Critical Alerts needs an entitlement Apple grants to
  medical/public-safety apps, and Time Sensitive is a *native* entitlement that would cost
  the 1.0's review-queue position and still is not an alarm. **It calls TWICE, 45s apart,
  and the repeat is the MECHANISM not a retry** — iOS lets a second call from the same
  number within three minutes through Do Not Disturb. Each call rings 25s so the first has
  stopped before the second lands. **Scheduled with `after()` from `next/server` plus
  `maxDuration = 90`**: a bare `setTimeout` in a route handler is frozen with the invocation
  and silently never fires, while the first call still goes out and every log line reads as
  success. Test it from Admin → System Health → **"Ring my phone now"** — the one delivery
  canary that cannot run itself, and worth a button because a 21210 ("not voice-capable")
  is only knowable at call time. `AUTOCART_ALARM_PHONE` overrides the destination.

### A dead RC session is NOT "alerting is broken" (2026-08-08)
`autocart.rc_session` went in as a plain `fail`, so it turned `/api/health/status` 503 and
the 5-minute pager emailed **"CampHawk DOWN"** every 30 minutes for eight hours overnight.
**Not one alert was affected** — the poller detects and notifies from Fly. `Check.pages`
now marks the auto-cart family non-paging: still `fail`, still red on the admin page, still
read by the 07:30 pre-flight (which is the *right* pager for this — once, when a human can
act). A non-paging failure reads `degraded`, so nothing is hidden. The cost of crying wolf
is not the noise, it is that the next real page gets skimmed.

### If a hold is queued: did the 8am cart fire? (the daily check)
The second attempt is queued: **South Carlsbad SB — Northern End, unit 45725 `#41`,
arrival 2026-09-13, releases 2026-08-08T08:00 PT**, status `requested`. (The first — Leo
Carrillo `#L108`, 2026-08-07 — FAILED; see the runner section above.) Verified green at
05:20 UTC on 08-08 across every link that broke last time: `autocart.rc_session` ok
(`load/shoppingcart → HTTP 200`), `autocart.rc_runner` polling, hand-off landing on
`/park/720/715`.

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts
```
It now prints the **RC session verdict first**, above the table and even when there are no
holds — a dead session with nothing queued is the cheapest moment to fix it, and the only
one with time to spare.
- `carted`/`claiming`/`released`/`claimed` → **it worked**; say which and how far it got.
- **`requested` with the release time already past → the ONE broken state.** Read
  `last_attempt_note`, which the readout prints per row: *"the runner TRIED 3m ago — RC
  session is dead"* and *"NOTHING has tried to act on this hold at all"* are different
  faults with different fixes, and before 2026-08-08 they were the same silence. It cannot
  be fixed from a web session — the bot is on the owner's mini-PC. Have them run
  `mini-pc\rc-check.bat`, or `mini-pc\rc-login.bat` if the session is the problem.
- `offered` → nobody tapped. Not a fault.

**Two Routines cover this daily** — delete both once the flow has proven itself:
- `trig_015nU7BciNU5GKimmgXjvAZG` — **07:30 PT pre-flight**, the one that can actually
  save a hold. Reads **both** `autocart.rc_session` and `autocart.rc_runner` from
  `/api/health/status` — they are different failures, and a green runner says nothing
  about the session (that gap is the whole 08-07 story). Deliberately needs no repo and no
  DB, just the public endpoint, so it cannot fail the way a clone-dependent check did on
  its first run.
- `trig_01KvxPSzmrwKHZ8CY3tDgbnj` — **08:15 PT outcome**, reads the hold readout and says
  what actually happened. This one is a post-mortem by construction; 08:00 has passed.
**Docs are current as of this session** — `docs/CONTEXT.md` and `docs/SETUP.md` were both
brought up to date with the hold flow, the reCAPTCHA/keep-warm design, the mini-PC's five
processes, migrations 039/040/043/044/**046**, the `rc-login.bat` window-title bug, and
the corrected A2P facts.

### iOS 1.0 IS SUBMITTED — "Waiting for Review", and DON'T PULL IT (2026-08-08)
Confirmed from App Store Connect: the version reads **Waiting for Review**, so it was
submitted and is genuinely queued. (This heading briefly said the opposite — I inferred
from §5's stale checklist that it had never gone in. The console is the source of truth;
§5's "Left, and only a human can do it" list was simply never ticked off.)
**Waiting for Review is the QUEUE, not the review.** The "median ~24h" figure people
quote is *In Review → decision*; time spent queued is not in it, and a first submission
from a brand-new team sits longest. Nine days is unusual, not broken, and there is
nothing to fix in the repo — the fixes are in the console.
- **The version banner is the whole decision: *"You can edit some information while your
  version is waiting for review. To submit a new build, you must remove this version from
  review."*** Metadata and **App Review Information (demo account + notes)** are editable
  IN PLACE, keeping the queue position. Only swapping the BUILD costs it.
- **The review notes are already correct — VERIFIED 2026-08-08.** *App Review
  Information* on the **version page** (not the app-level "General → App Review" nav
  item) has Sign-in required ticked, `tylerflores1992@yahoo.com` + a real password,
  contact details, and 1,992 characters of notes. **`docs/APP-STORE.md` §2 keeps
  `<fill in>` on purpose** (no secrets in git) — that placeholder is NOT the defect and
  has now been mistaken for one twice. Only the console field counts, and it is filled.
  So there is nothing left to fix here: the queue is the only thing between us and a
  decision.
- **Do NOT remove from review to attach a newer build.** The app is a webview on
  camphawk.app, so nearly everything shipped since is WEB-side and already reaches
  whatever build is attached. The iOS-native delta is the Capacitor 8 shell and the
  second location purpose string — and **ITMS-90683 is a warning email, not a rejection**
  ("a purpose string is still required" in *future* submissions). Both keys are already
  in `codemagic.yaml`, so the next build clears it whenever there is a next build.
- If it keeps sitting, the sanctioned nudge is Contact Us → App Review → status enquiry.
  **Expedited review is not warranted here** (it's for critical fixes / dated events) and
  you only get so many.
**The demo account is fine** (checked 2026-08-08): `tylerflores1992@yahoo.com` converted
from `trialing` to `active` on 08-05 rather than lapsing, still `grandfathered`, with 2
live watches — a reviewer sees a populated paid app.

**Release is AUTOMATIC — approval puts it LIVE with no human step** (read off the version
page 2026-08-08; this file said "manual, you flip it" for weeks and that was wrong). Left
that way on purpose: the app is a webview, so nothing has to happen between approval and
launch, and `NATIVE_LINKOUT` is a *post*-launch flip anyway. The consequence to plan for
is that **you may find out it shipped by seeing it on the App Store.** Privacy
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
(2026-07-30); NOT done on Play** — do it before an Android release, not after.

> **THE CLOSED TEST IS GLOBAL ON PURPOSE (2026-08-08), AND THAT IS NOT A CONTRADICTION —
> but it is a trap.** The paid tester service requires worldwide availability on the
> testing track plus the group `testers-community@googlegroups.com`. Play targets
> countries PER TRACK, so a global closed test and a US-only production release coexist
> fine. What must NOT happen is flipping `NATIVE_LINKOUT` while that global track is live:
> the anti-steering carve-outs are US-storefront only, and the link-out UI would then be
> shown to non-US testers — the exact review failure the precondition exists to prevent.
> The flag is `false` today, so nothing is exposed. **Read "flip it the moment the app is
> live" as "flip it once PRODUCTION is live and US-only"**, not while a global test runs. Both
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

### Play target API 36 — Capacitor 8 BUILT AND ON TESTFLIGHT (build 8, 2026-08-08)
Play requires apps to **target API 36 from 2026-08-31** for new uploads *and updates*
(extension to 2026-11-01 available in Console). Existing installs are unaffected; you
just can't ship an update. We were on 35 and nothing in the repo said so — `android/` is
git-ignored and regenerated each build, so the level came from
`@capacitor/android@7`'s default. **Capacitor is now `^8.5.0` (targetSdk 36, AGP 8.13.0,
same Java 21)**, with `firebase ^12.6.0` and **`node: 22` in BOTH codemagic workflows**
(`@capacitor/cli@8` needs node ≥22 or `npm ci` dies). The Android build now **asserts**
`targetSdkVersion >= 36` rather than trusting the default.
**Both stores share one dependency tree, so iOS went first — and it caught a real
break.** TestFlight build **8 is up (2026-08-08)**, after two failures worth knowing about:
- **Capacitor 8 defaults iOS to Swift Package Manager**, so `cap add ios` emits
  `App.xcodeproj` + `CapApp-SPM/` and **no `App.xcworkspace` and no Podfile**. The
  workflow's `--workspace App.xcworkspace` then died in **0.8s** — a duration that IS the
  diagnosis, since a real compile takes minutes. The upstream tell was the same: any step
  that genuinely runs `pod install` cannot finish in 1 second.
- **SPM then could not resolve our plugins at all.** It derives package identity from the
  last path segment, so `@capacitor/app` and `@capacitor-firebase/app` both claim `app`:
  *"Conflicting identity for app … Could not resolve package dependencies"*. Neither is
  droppable — the first supplies the Android back button and lifecycle events, the second
  initialises the native Firebase SDK from `GoogleService-Info.plist`, so removing it
  breaks push SILENTLY.
- **Fix: `npx cap add ios --packagemanager cocoapods`** (still first-class in v8).
  CocoaPods has no identity restriction — `CapacitorApp` vs `CapacitorFirebaseApp` — and
  it is the configuration that shipped build 5. **Do not "modernise" this to SPM** until
  upstream renames one of those packages.
- Android was never affected: it builds through Gradle. **`android-release` build 8 is
  GREEN (2026-08-08)** — `app-release.aab` (11.0 MB) + `app-release.apk`, **versionCode
  16** (Codemagic's `PROJECT_BUILD_NUMBER`, shared across workflows — NOT the API's
  per-workflow `index`, which read 8 and which I twice quoted as the build number),
  with "Assert the Play target API level" and "Verify the APK is actually signed" both
  passing. **The API-36 deadline is cleared as soon as that AAB is uploaded.**
  **PUBLISHED TO PLAY CLOSED TESTING (alpha) 2026-08-08, versionCode 18** — the API-36
  deadline is CLEARED. Every green `android-release` build now uploads itself: a Google
  Play service account is wired in via the `google_play` env group (setup + gotchas in
  `docs/PLAY-STORE.md` §0b). The 12-tester / 14-day closed-testing clock still has NOT
  started — that is the long pole, and no build shortens it.
Details in `docs/PLAY-STORE.md` §0a.

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
