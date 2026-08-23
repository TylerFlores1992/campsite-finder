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

### MOBILE RECAPTURE IS SOLVED ON ANDROID — MEASURED 2026-08-09, not reasoned
The paragraph above says the missing piece is recapture on mobile. **It is no longer
missing on Android.** `cordova-plugin-inappbrowser` (v7.0.0 — the ONLY package of the
three unpacked that actually has `executeScript`; `@capacitor/inappbrowser` does not,
and I asserted otherwise from memory once) is in the Capacitor 8 Android build, and all
three questions were answered on a live emulator against production:
1. **RC's Okta signs in INSIDE the app's WebView.** Email + password accepted. A CAPTCHA
   appeared and was solved by hand. That is survivable here and fatal on the mini-PC — the
   difference is that a human is holding the phone, having just tapped "claim". Do not
   carry the bot's "a CAPTCHA is a full stop" rule onto this path; it is a different
   threat model.
2. **The session SURVIVES closing the webview**, and
3. **survives force-closing the whole app.** Android's `CookieManager` is process-wide and
   the InAppBrowser shares it with the main WebView. That was the expectation, and it was
   still tested, because "the keep-warm renews the session" and "a second session can adopt
   the cart" were both expectations of exactly this confidence and both measured FALSE.
**So the design is: sign into RC in the app ONCE, and the 8am claim is one tap with no
credentials in the critical path** — which is a better story than the desktop extension,
not a worse one. `ClaimFlow` already routes through `openRcHandoff`, so the plumbing
needed no change.
- **THE INJECTION REPORTS ON ITSELF NOW, and the chain is measured through the token.**
  `executeScript` returns nothing useful, so "threw on line 1", "ran and found no hold" and
  "carted" were the same silence — the family that gave us `status = 'sent'` meaning only
  "Twilio returned 2xx". The bundle served by `/api/rc-precart` now speaks back over the
  InAppBrowser `message` channel (`lib/rc-precart-script`, `RcReport`, rendered under the
  admin test). First live run, 2026-08-09: `injected` → Okta's `/oauth2/v1/authorize` →
  `/login/callback` → **`token captured · length: 939`**, i.e. it read a live RC access
  token inside the app's webview. Only the two RC cart POSTs remain unproven, and they
  report themselves via the status line on the next real hold.
  - **Prefer the raw `cordova_iab` global over `window.webkit.messageHandlers`** — the
    Android plugin aliases the latter in `onPageFinished` via an async
    `evaluateJavascript`, which races the `loadstop` injection and drops the first report.
  - **Status is OBSERVED off `#camphawk-rc-status`, not reimplemented**, so the diagnostic
    and the user's own screen cannot disagree and `content-rc.js` stays byte-identical for
    the extension.
  - **A fake unit id was deliberately NOT used to exercise the cart.** An invented id can
    collide with a real site and lock it, which is the "carting is harmful without a
    hand-off" rule.
  - **THE FIRST VERSION LEAKED AN OAUTH AUTHORIZATION CODE.** It reported `location.href`,
    and Okta signs in *inside this webview*, so mid-flow that is
    `/login/callback?code=…&state=…` — exchangeable for the session. The `scrub()` guarding
    these reports knew JWT shapes and sailed straight past it. **Don't collect a field you
    then have to filter**: URLs are `origin + pathname` now, which carried all the
    diagnostic value anyway.
  - `rc-inject.js` rebroadcasts the token on EVERY RC API call — ~40 identical lines in a
    quiet minute. Consecutive duplicates collapse to one plus a count; at 08:00:00 the
    flood would bury the cart's own status.
  - **`force-cache` was serving the precart STALE FOREVER** (spec behaviour). That silently
    defeats the route's short `max-age`, which is the one property making a broken precart
    a push to master rather than an app release. `cache: 'default'` now.
- **iOS PASSED THE SAME THREE TESTS, 2026-08-09, on TestFlight build 1.0 (21).** Okta
  signs in inside the WKWebView (`injected` → `/oauth2/v1/authorize` → `/login/callback` →
  `token captured · length: 939`, the identical chain and token length Android produced),
  and the session survived both closing the webview and force-closing the app. It was
  tested rather than assumed precisely because WKWebView has its own cookie store and its
  own ITP rules, so Android's process-wide `CookieManager` argument does not transfer —
  the expectation was right and the reason for it would not have been.
  - The plugin reaches iOS through `npx cap sync ios` with no extra wiring; what was
    missing was any check that it had. `codemagic.yaml` asserts it now, at
    `ios/capacitor-cordova-ios-plugins` — NOT `ios/App/…`, and the Podfile names the pod
    `CordovaPlugins`, so grepping it for "InAppBrowser" can never match. Both paths were
    written from memory first and failed a build where `cap sync` had just logged
    "Found 1 Cordova plugin for ios". Read `@capacitor/cli`, don't recall it.
  - **Never widen that assertion to `grep -r ios/`** — `ios/App/App/public` contains our
    own `cordova.InAppBrowser` probe, so it would pass with the plugin absent.
  - The report channel works on BOTH platforms unchanged. On iOS `cordova_iab` is not a
    global, so the reporter falls through to `window.webkit.messageHandlers.cordova_iab`,
    registered at configuration time (no race, unlike Android's `onPageFinished` alias).
    `CDVWKInAppBrowser.m`'s handler has two branches and only the SECOND is ours: a
    dictionary body is the `executeScript` callback path and needs an `InAppBrowser<N>`
    id; a **string** body is JSON-parsed into a `message` event. `JSON.stringify` is
    therefore correct on both, matching Android's `postMessage(String)`.
- **PROVEN 2026-08-13 12:31 PT — the two RC cart POSTs fire and RC accepts them**
  (`✓ Added to cart`, confirmed in RC's cart by eye; full trace under "THE CART POSTS NEVER
  FIRE" below).
  **IT WAS iOS** — established from the status bar in the owner's screenshot (carrier,
  centred clock, alarm glyph), not from the report channel. That is the platform whose own
  WKWebView cookie store and ITP rules are the reason the 08-09 sign-in tests were repeated
  there rather than inferred, so it is the more valuable of the two to have proven.
  **ANDROID IS NOW THE UNPROVEN ONE for the cart POSTs** (its 08-09 tests covered sign-in,
  persistence and token capture only).
  **`client_reports` STILL CARRIES NO PLATFORM**, and this was one edit away from being
  filed as "proven on Android" out of habit — the right answer arrived from a screenshot,
  which is luck, not instrumentation. **Put the platform in the report envelope**, or the
  next run's write-up is another coin toss.
- ~~**STILL UNPROVEN ON EITHER PLATFORM: the two RC cart POSTs.**~~ Sign-in, session
  persistence and token capture are measured; `load` + `submit` are not, because
  exercising them needs a genuine held unit and a fake id could lock a real site.
  **The next real hold now answers this by itself (migration 050).** `ClaimFlow` passes
  `onReport` into `openRcHandoff` and buffers to `POST /api/rc-holds/report`
  (`keepalive`, 1.5s debounce, never awaited — a diagnostic that can slow the thing it
  observes is not worth having), and `scripts/rc-holds-readout.mts` prints a **HAND-OFF**
  section. `✓ Added to cart` there is the proof; **"nothing reported" is the ordinary
  plain-browser case, not a failure.**
  - `recordClientReports` never moves `status` and never `updated_at` — it is an
    observation about the CLIENT, not a change to the hold, and conflating them would
    destroy the "unchanged since the tap" tell that exposed 2026-08-07. Same rule as
    `noteAttempt`. `worker/rc-client-reports.test.mts` fails against that mutation.
  - The verdict column is taken from an OUTCOME line (`status`/`banner`/`error`), not
    merely the last line — `token captured` as the final word would report a cart nobody
    ever saw succeed.
  - The report endpoint is authorised by hold id + manage token, i.e. **exactly the check
    that authorises releasing the site** — never weaker, or a stranger could write onto
    someone else's hold.
- **The claim screen still shows the MANUAL three-step copy to everyone**, including
  clients that would cart automatically — and its "I'm signed in and looking at the site"
  checkbox *gates the release button*, so an app user is blocked until they assert they
  did work we were about to do for them. Deliberately not flipped yet: promising "we're
  carting it for you" before the cart POSTs are proven is the failure `rc-handoff.test.mts`
  already guards against, and it is worse than the manual flow because the user stops
  watching. Prove the cart on a real hold, then branch the copy on capability.
- **THE TEST HARNESS IS WHERE THE TIME WENT, NOT THE QUESTION.** Three consecutive runs
  were lost to identity confusion, and all three looked like RC rejecting us:
  a hand-written RC URL that 404'd (see below), the admin page opened in **Chrome**
  instead of the app (the result line says which window you got — read it FIRST), and
  Android Studio's **Run** silently reinstalling the local debug variant (versionCode 1,
  targetSdk 35, no Cordova plugins) over the release APK (19/36). **Launch the installed
  build with `adb shell monkey -p app.camphawk.mobile …`, never ▶ Run**, and when its
  "the device already has a newer version" dialog appears, the newer version is the one
  you want — Cancel, not OK. `appBuild` in the diagnostics panel is the only fact that
  settles which binary is answering.
- **`/Web/#!park/<place>/<facility>` IS NOT A REAL RC URL** and has now been written from
  memory twice, both times answered with RC's branded 404, the second time burning a live
  test that needed a human, an emulator and a fresh build to set up. The real shape is
  `/park/<placeId>/<facilityId>` and the ONE place allowed to build it is
  `lib/booking-url`. `worker/rc-handoff.test.mts` fails on the invented shape now.
  Worse: the commit that claimed to fix this the first time (`6006428`, "it is now what
  builds the URL") **only changed the instructional copy** — the URL line was never
  touched. A commit message is not evidence that a change was made.

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

### CONCURRENT CART MINTING IS SAFE, MEASURED (2026-08-17) — and carting is parallel now
`--cart-ladder` proved one session holds ten carts and twenty reservations, but it minted
them strictly IN SEQUENCE. The production runner carted serially for the same reason, so at
`RC_HOLD_CAPACITY = 20` a release where every hold shares one `release_at` was twenty carts
back to back at roughly a second each — the twentieth site sitting un-carted for twenty
seconds after it freed, exposed to everyone else watching it, and the cost GROWING with the
product. `rc-probe.mjs --concurrent-mint` answered the precondition:
```
unit 45719 -> key 4f035e59...  submit: IsSuccess  key via submit   HTTP load 200 / submit 200
   [... six units, all identical ...]
cart 4f035e59... holds 1 entr(y/ies) -- ours is b7b09df1...
6 fired in 1.4s -> 6 submit(s) accepted, 6 minted key(s), 6 DISTINCT,
                   6 entr(y/ies) held, 6 identified as ours.
+ CONCURRENT MINTING IS SAFE.       released ... HTTP 200  (x6)
```
**They do not race.** Six simultaneous `NO_CART` precarts each got their own cart and each
cart accepted one reservation. Until that run the live failure was that the losers would be
refused in RC's own per-cart wording and read as an **account limit** rather than a race we
caused — the same misreading that kept `RC_MAX_CARTS` at 1 for a fortnight.
- **`CART_CONCURRENCY = 4`, NOT 20.** The probe demonstrated six; it demonstrated nothing
  about twenty, and the next ceiling is not RC's cart rules but the **WAF** in front of them
  — this address has eaten a 12-hour block once. `RC_CART_CONCURRENCY` overrides it.
- **PARALLEL WITHIN A RELEASE GROUP ONLY.** The lead is waited ONCE PER RELEASE now (it was
  waited per hold, where every wait after the first was already zero — pure serialisation
  gating nothing), groups run earliest first and each is AWAITED. Firing a later group early
  is 2026-08-08 exactly: a cart submitted 85s before its release was refused for a site RC
  had not let go of, and `failed` was terminal.
- **Parallelised through `page.evaluate`, which is what the probe measured.** The plan also
  said to move the precart to `ctx.request`; doing both at once would ship an unvalidated
  transport on the strength of a run that validated a different one. Transport unchanged.
- `worker/cart-parallel.test.mts`, six mutations (unawaited fan-out, bound raised past what
  was measured, `Promise.all` over the items, wait moved back inside the task, browser cart
  pointer read again, `release_at` parsed as a Date).

#### THE PROBE ITSELF LIED TWICE BEFORE IT ANSWERED, AND BOTH ARE THE HOUSE SHAPE
Two runs cost twelve locked campsites and produced no information. Worth keeping because
both defects were *inside the instrument written to avoid exactly this*.
- **RUN 1 — `0 site(s) actually held` over six SUCCESSFUL carts.** It called `findCartEntry`
  with `{ unitId }` alone, and that function's own header records that **RC's cart entries
  carry NO unit field at all** and that a matcher looking for one "reported an empty cart for
  a full one, twice". Third time. The cost was not the wrong verdict: `made[]` is populated
  from the match, so **nothing was released** and six real sites were left to lapse.
  - Fixed on `(placeId, facilityId)` from the load response's `LockedShoppingCart` — what
    the ladder always passed. **And release is now driven by the cart's CONTENTS**
    (`listCartEntries`), not by the match: a cart this run minted with `NO_CART` holds only
    what this run put there, which is a guarantee about how the cart was CREATED and cannot
    rot the way a matcher can. Never `empty/shoppingcart`.
- **RUN 2 — `x THEY RACE` over six requests that NEVER ARRIVED.** `key` fell back to
  `finalKey`, which is `localStorage['shoppingCartKey']` — the session's EXISTING pointer,
  which every request READS and none of them mints. **Six reads of one shared value are
  always one distinct key**, so ANY run whose submits fail reports a collision. A fake race
  by construction, and the most expensive misread available: it would have retired the
  parallel-cart plan on a run where nothing was asked of RC.
  - The tells were all in the output and none was printed: **0.1s** against 4.3s for the
    working run, and `status: 0` — which in `rc-cart.mjs` means **the fetch THREW**, with an
    empty body that parses as `(unparseable body)`. So "RC declined" and "RC was unreachable"
    were the identical line, with the reason sitting unread in `netError`.
  - Only a SUBMIT's key counts now; a thrown request says so; `HTTP 0` is explained where it
    is printed; and the verdict **refuses to speak** when no submit was accepted — `THE
    QUESTION WAS NEVER REACHED`, tested BEFORE the race arm, naming connectivity vs the unit
    ids. Same rule as `unknown` never rounding to `signed-out`.
- **I INVENTED SIX UNIT IDS AND PUT THEM IN A PASTE-READY BLOCK** (4728-4733), in the same
  message that said never to guess them. Nothing was locked only because every submit failed.
  **`scripts/rc-test-hold.mts --find --show 6` is the only way to get them**, and it must be
  run from a session with DB access — the mini-PC has no `@supabase/supabase-js` installed,
  so `--find` dies there with `MODULE_NOT_FOUND`.
- **`<` AND `>` ARE REDIRECTION IN cmd.** A paste block with `<the arrival date>` placeholders
  died on `The syntax of the command is incorrect.`, `RC_ARRIVAL` was never set, and the probe
  printed `Skipping --concurrent-mint` — which reads as the flag being unsupported. Use
  `set "VAR=value"` (the quotes also stop cmd swallowing a trailing space into the value) and
  echo the variables back before the run.

### RC AUTO-HOLD IS LABELLED BETA, AND THE ENTITLEMENT WAS NEVER THE GATE (2026-08-17)
Asked to "open up RC auto carting to beta testers". **Nothing had to be opened.**
`hasAutocartEntitlement` has been `is_beta OR (a live autocart/grandfathered subscription)`
since migration 032 and the poller's hold offer uses exactly that, so every beta tester with
an RC watch has been eligible the whole time (five accounts carry `is_beta`). Two things were
actually missing, and the second was reported by the owner mid-session.
- **NOTHING SAID BETA.** A tester met a button promising to take a real campsite off the
  market, in a feature whose full path has completed on ONE real morning (2026-08-16) plus
  synthetic runs. **The cost of a miss is not the failed cart — it is that a user who
  believes the site is handled STOPS WATCHING**, the rule the claim copy has been governed by
  since 2026-08-09. So the label arrives BEFORE the decision (confirm screen, above the
  promise, not under it) and it **names the remedy**: set an alarm anyway. A caveat with no
  instruction changes nobody's morning. One definition in `src/lib/autocart-beta.ts`.
- **NOT IN SMS, deliberately.** The coming-soon offer is 154 chars against a 160-char
  one-segment budget, already after `fitOneSegment` trims the name. Any beta wording spends
  more than that margin and tips it into TWO segments — the shape that was Undelivered/30007
  thirteen times on 08-05. **A label nobody receives, on an alert nobody receives, is strictly
  worse than no label.** Push takes the SHORT note, because a lock screen truncates the tail
  and would drop the caveat while keeping the promise.
- **"NO SIGN OF AUTO CART" (owner, on a Carpinteria watch) WAS CORRECT BEHAVIOUR AND A REAL
  GAP.** `supportsAutoCart` is `source === 'ridb'` — the watch-level toggle drives the
  **rec.gov** lane. **An RC hold is not a watch setting at all**: it is offered per release,
  the night before, and only a tap authorises it. So there was nothing on `/new` to find, and
  the only way to discover the feature was to receive an alert. `/new` now states it for a
  hold-capable source — **with no toggle**, because a switch would imply a standing consent
  this product deliberately does not take.
- **AND OPENING IT UP IS WHAT WOULD HAVE MADE A LATENT GAP FIRE.** `findRCHeldUnits` reads
  UseDirect's generic `Lock` field, so the coming-soon path covers **all ten portals** — while
  the bot signs in to ONE ReserveCalifornia account and `rc-cart.mjs` posts to
  reservecalifornia.com. An Ohio or Virginia watch could be offered a hold **nothing on earth
  can perform**. It has never fired (every live watch is `reservecalifornia` (16) or `ridb`
  (1), checked 2026-08-17) — and the first tester to watch an Ohio park is what turns it into
  a promise we break. `supportsRcHold` is narrower than `isUseDirectSource` on purpose, with
  **two enforcers**: the poller withholds the button and `/new` does not advertise it. Widen
  only when the bot holds an account for that portal.
- `worker/autocart-beta.test.mts`, five mutations. **One of them survived the first round and
  the reason is worth keeping**: the ordering assertion compared raw file indexes and matched
  the **import line**, which is above everything — so "the caveat precedes the promise" was
  true whatever the markup did. It measures inside the component body now. Sixth time a guard
  has needed re-doing because it anchored on the wrong thing.

### THE HOLD RUNNER WAS DOWN 2.5 HOURS AND THE WATCHDOG NEVER NOTICED (2026-08-17)
A test hold for the 08:00 release was never carted. **Nothing about RC was wrong** — this
was Windows process supervision, and it is the thing standing between this product and
running unattended.
```
07:46:31 PT  autocart.rc_runner   last poll 7822s ago (2h10m), no holds due   WARN
             autocart.rc_session  no token at all - signed out                 FAIL
08:0x        mini-pc\rc-login.bat  ->  session RESTORED (token 47m, okta ALIVE)
08:08:15 PT  autocart.rc_runner   last poll 9154s ago (2h32m), 1 hold due      FAIL
             TEST 4728            requested, last_attempt_note NULL, updated_at
                                  unchanged since the 06:38:54Z tap
```
- **THE GAP GREW BY EXACTLY THE WALL CLOCK** — 7822s to 9154s is 1332s over 22 minutes of
  elapsed time. So the runner did not poll ONCE in between, including after the sign-in.
- **`last_attempt_note` NULL IS THE DISCRIMINATOR AND IT WORKED.** The readout said
  *"NOTHING has tried to act on this hold at all"* rather than *"the runner TRIED"*. That
  distinction is migration 046 earning its keep — before 2026-08-08 both were the same
  silence and cost six hours of guessing.
- **`rc-login.bat` FIXED THE SESSION AND NOT THE RUNNER, and I said it would fix both.**
  That claim came from CLAUDE.md's note that the script relaunches the RC pair; the
  heartbeat says otherwise. **Whether it relaunches the runner at all is now an open
  question, not a fact** — do not repeat the claim without reading `restarts.log`.
- **A CAPTCHA IS NOT INVOLVED AND MUST NOT BE BLAMED.** The rehearsal PASSED on 08-16, the
  renewal re-mints from a token-less profile (`✓ renewed by authorize: none → 3580s`), and
  `rc-login.bat` restored the session this morning in one attempt. Reaching for a CAPTCHA
  solver here would be solving a problem the evidence says we do not have.
- **THE BOX IS REACHABLE THE WHOLE TIME.** `autocart.bot` beat 3s ago, so `bot.mjs` is alive
  and carrying the control channel — `list-processes`, `tail-log`, `restart-rc` and
  `git-status` all work. This is NOT the 08-11 dark box.
- **CANDIDATE CAUSES, NONE ESTABLISHED — do not write one in as fact.** (1) `supervise.ps1`
  hit its 5-exits-in-10-minutes stop-loudly rule and gave up, which is by design and leaves
  the runner dead for ever. (2) The watchdog's `Get-Missing` counts it present while it is
  not polling — the 08-15 elevation blindness, where an unelevated WMI query reads `$null`
  for a process in another security context and an elevated generation counts as HEALTHY.
  (3) The runner is alive but wedged, never reaching its poll.
- **THE WATCHDOG IS THE REAL DEFECT WHATEVER THE CAUSE.** It fires every 5 minutes for
  exactly this and produced nothing for 30 consecutive firings. A supervisor that is silent
  through the outage it exists for is the `status = 'sent'` shape one level up.
- **NO AVAILABILITY ALERT WAS OWED, AND THIS IS NOT A SECOND FAULT.** The watch covers
  2026-10-02→10-04; the hold's arrival is **2026-12-01**, which the poller does not watch —
  `rc-test-hold.mts` picks a far-future midweek date on purpose so a test cannot disturb a
  real booking, and that date is decoupled from the watch's range. And a synthetic hold has
  **no real RC lock behind it**: the 08:00:53 release is one the script invented, so nothing
  on RC's side was going to change at that instant. Expect silence; it is not a symptom.
- **UNIT 4728 IS ONE I INVENTED** (see the paste-block entry above) and was queued from that
  block. Whether it is a real San Miguel unit was never established, and the runner never
  tried, so it is still unknown. Re-derive ids with `rc-test-hold.mts --find`.

### THE WATCHDOG NEVER RAN — WINDOWS STOPPED SCHEDULING (2026-08-17, second pass)
The entry above lists three candidate causes for the 2.5-hour runner outage. **All three are
ruled out, and the answer is a fourth thing.**
```
04:24:04 PT  watchdog: "NOTHING IS RUNNING - starting everything"  <- its LAST line ever
             ...and it never logs "recovered" or "START FAILED" either
05:31:03     LAST EVER auto-update.log entry, after a flawless 5-minute cadence
05:35:56     runner's last feed poll        (rc_runner_heartbeat.beat_at)
05:36:31     [supervise:rc-hold-runner] exited code=-1073740791 after 4,340s
05:36:39     "restarting in 5s (attempt 1 in the last 10 min)"     <- then nothing, ever
05:39-08:55  rc-keepwarm exits and restarts FOUR times, normally
```
- **`supervise.ps1` gave up: OUT.** The rule needs 5 exits in 10 min and writes `STOPPING`;
  the log says `attempt 1` and there is no such line. **Alive but wedged: OUT** — there was
  no runner process and no supervisor for it. **The watchdog counted it present: OUT** —
  every branch after a non-empty `Get-Missing` writes a line BEFORE acting, and ~42 firings
  produced zero.
- **BOTH SCHEDULED TASKS WENT SILENT TOGETHER**, five minutes apart, and that is the finding.
  Two independent tasks stopping at once rules out a per-task hang and the `IgnoreNew`
  multiple-instance policy, which fit only one. **WHY is NOT established** —
  `install-watchdog.bat` registers with no `/RU` ("run only when user is logged on"), so a
  session change is one candidate among several. **Do not write one in as fact.**
- **THE BOX LOOKED PERFECTLY HEALTHY THROUGHOUT, and that is the trap.** Everything driven by
  a running PROCESS carried on: supervisors restarted the keep-warm four times, `bot.mjs`
  beat every 2s and answered `list-processes`/`tail-log`/`git-status`. Only the things driven
  by Task Scheduler stopped, and **nothing anywhere measured those.**
- **A SILENT WATCHDOG AND A HEALTHY BOX WRITE THE IDENTICAL LOG: NOTHING.** `watchdog.ps1` is
  deliberately quiet when healthy (correctly — a line per firing would bury `restarts.log`),
  so "ran and found nothing wrong" is indistinguishable from "never ran". **The outage was
  only diagnosable because the OTHER task happens to log every run**, which is luck, not
  instrumentation. Same shape as `status = 'sent'` meaning only "Twilio returned 2xx".
- **FIXED THREE WAYS, and only the first reaches production without the box updating:**
  1. **`worker/runner-watch.ts` rings the phone FROM FLY** when the beat is stale past
     `RUNNER_DEAD_MS` (15 min, three times `supervise.ps1`'s 300s backoff cap) AND a hold is
     within the 45-min lead. `alarmIfSessionUnusable` lives in the hold feed — fine for a
     dead SESSION, useless for a dead RUNNER, because the poll is what stopped. Same argument
     that moved `expire-holds.ts` to Fly, followed deliberately. Under a **sync claim**: two
     shards would place four calls. **The message names the RUNNER and never says
     `rc-login.bat`** — that remedy force-kills the Chromium the token lives in.
  2. **Migration 060 `bot_task_heartbeat` + `autocart.watchdog`.** Each task reports for
     itself, as its FIRST act, on the healthy path too. **Warn only, never paged**: a box that
     has not updated yet reports nothing, which is indistinguishable from a task that stopped.
     **CHECKED, NOT ASSUMED: `bot_update_requests.applied_at` is NOT already this signal** —
     it read 08-15 11:56Z while the task ran every 5 min until 05:31 PT on 08-17.
  3. **`bot.mjs` is a SECOND TRIGGER** for `watchdog.ps1` — it has stayed up through every RC
     outage there has been. It does **not** replace the task: only Windows can recover a box
     where every poller is dead. The script rate-limits ITSELF (timestamp file, 240s) so
     neither trigger has to know the other exists.
- **A PER-PAYLOAD RELAUNCH WAS BUILT AND BACKED OUT.** It would save the keep-warm's live
  session when only the runner is dead — but it breaks the invariant `update-guard.test.mts`
  pins, that only `start-all.bat` and `restart-rc.ps1` launch payloads because they own the
  stop-then-start order that makes a duplicate structurally impossible. **And it was not
  needed: the existing `restart-rc` branch WOULD have recovered this morning had the watchdog
  run at all.** The defect was the trigger, not the lever.
- `worker/runner-watch.test.mts` (8, verified against 5 mutations) and
  `worker/watchdog-recovery.test.mts` (6, against 4). **One guard survived its first
  mutation** — it matched `$MIN_GAP_SEC` anywhere, and renaming the ASSIGNMENT left the token
  in the comparison below it, so it passed against a watchdog with no gate. Seventh time a
  guard here has anchored on the wrong thing.

### THE KEEP-WARM WEDGES ~HOURLY IN THE NEAR-EXPIRY RENEWAL (2026-08-17) — STILL OPEN
Found in the same read, and it is a **bigger risk to the next 08:00 than the outage above.**
```
15:42:58 renewing the session - the token has 10m left (src=live)
15:55:58 x WEDGED - the keep-warm loop has not advanced in 13m.
```
It enters the near-expiry cell, never returns, `HUNG_MS` (12m) fires, it releases the profile
and exits 1, the supervisor restarts it, the session recovers via `authorize` from a
token-less profile — and ~50 minutes later the token is back to 10 minutes and it repeats.
**Four times on 08-17** (05:39, 06:53, 07:43, 08:55 PT), which is what every `code=1` in
`restarts.log` is.
- **A WEDGED KEEP-WARM HOLDS THE CHROMIUM PROFILE**, and the runner's preemption is
  COOPERATIVE — it drops `.camphawk-profile-wanted` and waits for a loop that is not
  advancing. **A wedge at 07:50 is an 08:00 cart that cannot happen**, which is 2026-08-10
  exactly.
- **Playwright's `page.evaluate` HAS NO TIMEOUT**, and `readLiveToken`, `dropStoredToken` and
  `restoreStoredToken` were bare evaluates — with `readLiveToken` the FIRST line of
  `renewSession`. Every other await on that path is bounded and they sum to ~4 minutes
  against an observed 13. All three now go through `evaluateWithin` (20s), and a timeout
  returns the ABSENT reading (`source: 'none'`, empty snapshot) rather than an error — the
  shape the callers already treat as "we could not tell".
- **THAT THIS IS THE HANG IS NOT PROVEN.** Nothing recorded which await it was, and a
  Playwright call failing to honour its own timeout against an unresponsive browser is still
  live. **Confirm from the box after the update:** a `renewing the session` line followed
  within ~20s by a result instead of a wedge settles it. If it still wedges, suspect the
  browser, not the code.
  - **ANSWERED THE SAME DAY, AND THE ARROW POINTS THE OTHER WAY.** The wedge is not the
    disease, it is the browser at 25 GB refusing to answer. See directly below: the four
    wedge times above (05:39, 06:53, 07:43, 08:55) match four memory-ramp recoveries
    (05:40:35, 06:55:00, 07:45:21, 08:57:35) to within two minutes. `evaluateWithin` is
    still right — it turns a hang into a fast failure — but it prevents nothing.

### THE CHROMIUM LEAK IS FULLY ATTRIBUTED (2026-08-17, third pass) — 20 RAMPS IN 5 DAYS
The sampler (migration 059) had never once recorded an event; it has now recorded twenty, and
the family that was guessed wrong twice is settled. **Every ramp is the `rc` family — the
keep-warm's own resident browser** — and `recgov` peaks at 0 MB in nineteen of the twenty.
```
last-healthy 11:06:19  rc 214MB pid144       RAM free 13,115MB   commit 11%
first-big    11:08:20  rc 3,057MB pid144     RAM free  9,776MB   commit 58%   <- SAME pid
             11:12:20  rc 13,773MB           RAM free  1,816MB   commit 77%
peak         11:18:29  rc 27,085MB pid144    RAM free    881MB   commit 99%
recovered    11:20:21  rc 163MB pid2956      RAM free 13,480MB   commit 10%
```
- **~2,400 MB/min, and it is REAL memory.** Free RAM goes 13,112 → 881 MB, so the commit is
  being TOUCHED, not reserved. That rules out a huge-but-untouched allocation and it rules
  out reading the metric wrong.
- **ONE PROCESS, and the same pid that was healthy two minutes earlier.** `max_mb` carries
  almost all of `rc_mb` (25,183 of 25,436 in one). It is the resident tab going bad, not a
  fleet of children accumulating.
- **EVERY ~70 MINUTES, TWENTY TIMES, ACROSS FIVE DAYS.** 08-16: 08:05, 09:17, 13:50, 15:03,
  16:09, 17:17, 18:31, 19:47, 21:32. 08-17: 00:41, 01:53, 02:57, 04:12, 05:26, 06:42, 07:31,
  08:43, 09:51, 11:08, 12:14. **This was never an occasional event** — every "not reproduced
  this session" reading in this file was a window that happened to miss one.
- **60 min of token + ~10 min of ramp = the 70-minute period.** The browser opens, mints a
  token, is flat for about an hour, the near-expiry renewal runs, it ramps, it dies, repeat.
- **THE RECYCLE SHIPPED THAT MORNING COULD NEVER HAVE FIRED.** `RC_MAX_FAMILY_MB` is checked
  in the resident loop's BODY, and the leak happens during a WEDGE — which is by definition
  that loop not advancing. On all twenty occasions control never reached the check. **A guard
  placed inside the thing it guards against is not a guard**, and this is the third instance
  of the shape here, after `expireStaleHolds` living in the feed only a live runner polls and
  `reclaimLapsedHolds` living inside `withRC`. The wedge watchdog's own comment had already
  written the rule down — *"the renew timer is the only code proven to still be executing,
  which makes it the only place a watchdog can live"* — and the recycle did not obey it.
- **THE FIX IS TWO LAYERS, AND THEY ARE DELIBERATELY DISTINGUISHABLE.**
  1. **Containment (certain).** A RAM-pressure arm inside the watchdog timer: stalled >60s
     **AND** `os.freemem()` under 4 GB → release the profile and exit, exactly as the wedge
     arm does. The timer now ticks every 10s rather than 2 min, because **the tick interval
     IS the overshoot** — at 2,400 MB/min a two-minute timer lets it gain 5 GB between looks.
     The profile lock keeps its own `RENEW_MS` cadence inside the faster timer.
  2. **Root-cause candidate (a hypothesis, labelled as one).** The three throttling-disable
     flags are removed. They were added 2026-08-08 to catch *"a timer inside RC's app"* —
     and this file's own later findings killed that premise twice over: okta-auth-js's
     autoRenew fails and **deletes** the tokens (08-09), and RC issues **no refresh token at
     all** (08-15). Nothing we rely on needs them, because `page.evaluate`/`page.goto` are
     devtools-driven and unthrottled. What they cost is every brake Chrome has on an occluded
     tab — and this tab spends hours occluded running an SPA in a permanent 401 state.
- **`os.freemem()` AND NOT THE POWERSHELL SCAN, deliberately.** `rcFamilyMb()` spawns a child
  process, and spawning is precisely what fails at 99% COMMIT — it is *how* `supervise.ps1`
  could not start a shell on 08-12 and *how* the Scheduled Tasks stopped on 08-17. An
  instrument that goes quiet as the emergency peaks reports the emergency as calm.
- **BOTH CONDITIONS, ALWAYS.** Low RAM alone is the owner using their own desktop PC; a stall
  alone is an unattended sign-in doing its job. Acting on either would be the cry-wolf failure
  this file has fixed three times, most expensively at 07:33 on 08-16.
- **WHAT THE FIX BUYS, STATED HONESTLY.** The RAM floor is crossed about three minutes into a
  ramp, at ~8-10 GB and ~68% COMMIT — comfortably below the ~90% where Windows stops
  scheduling tasks and the 99% where Node aborts. **So the box never goes dark again.** It
  does NOT stop the browser being recycled; that is what layer 2 is for, and it is unproven.
- **HOW TO READ THE NEXT FEW DAYS.** The two layers act at different points, so the memory
  series tells them apart: **no ramps at all ⇒ the flags were the cause**; **ramps that still
  appear but stop around 8-10 GB ⇒ the containment is what worked and the flags were not it.**
  Shipping them together is only acceptable because of that. Crediting a repair to the wrong
  mechanism has cost this file three times.
- **THE ALLOCATION SITE INSIDE THE PAGE IS STILL UNKNOWN — do not write one in.** Candidates
  not distinguished: a retry loop in RC's SPA against a token that expired 44 hours ago, our
  own `fetch` wrapper retaining `init` per pending request, or something in Chromium's
  handling of the occluded headful window. What would settle it is a `--remote-debugging-port`
  heap snapshot taken DURING a ramp, which needs somebody at the box in the ten-minute window.
- ~~**THE CONTAINMENT FIRED ON ITS FIRST RAMP, ~70 MINUTES AFTER THE BOX UPDATED, AND THE A/B
  ANSWERED ITSELF.**~~ **BOTH HALVES OF THAT WERE WRONG. IT WAS `update.bat`.** Struck rather
  than deleted, because this is the "crediting a repair to the wrong mechanism" failure the
  entry three bullets above warns about, committed within the hour by the person who wrote
  the warning.
  ```
  16:43:02  commit 15%  RAM free 8,502MB  rc 264MB   pid9544   <- healthy
  16:45:02  commit 53%  RAM free 6,178MB  rc 2,217MB pid16816  <- ramping
  16:47:03  commit 61%  RAM free 1,580MB  rc 7,016MB pid16816  <- 7 GB
  16:47:31  [stop-all] stopping chrome.exe pid 16816 (orphaned Chromium)   <- THE UPDATE
  16:47:41  commit 15%  RAM free 9,556MB  rc 208MB   pid7896
  ```
  **The memory series alone cannot tell a guard firing from a stop-all**, and I read the
  recovery as the guard. `restarts.log` settles it: keep-warm process starts are 15:54:19,
  15:58:52, **16:47:37**, 17:11:49 — so the browser that ramped was launched at 15:58 on
  `e5cf430`, which predates the containment. There is **no `✗ RUNAWAY` line anywhere in the
  log**, which is the tell that should have been checked first: the guard announces itself,
  and silence meant it had not run.
  - **THE CONTAINMENT HAS NEVER FIRED.** Nor has the age recycle. All three instruments are
    deployed and none is production-tested.
  - **THE FLAGS ARE STILL AN OPEN CANDIDATE.** That browser still had them. The A/B written
    up as settled has not been run, and the reading rule stands unchanged: **no ramps at all
    ⇒ the flags were the cause; ramps that appear but stop around 8-10 GB ⇒ the containment
    is what worked.**
  - **The calibration doubt about `os.freemem()` is therefore NOT resolved either** — nothing
    has compared it against the PowerShell figure in anger. The first genuine trip resolves
    it, because the `RUNAWAY` line prints the reading it saw.
- **CONFIRMED, AND IT IS THE ONE THING THAT SURVIVED: THE RAMP BEGINS AT THE NEAR-EXPIRY
  RENEWAL.** From the keep-warm's own log, against the same ramp:
  ```
  23:44:16 renewing the session — the token has 9m left (src=live)
           [ramp: 23:45:02 → 2,217 MB … 23:47:03 → 7,016 MB]
  23:47:37 keep-warm restarts
  ```
  `src=live` with 9 minutes left is the **near-expiry cell** — the one half of the 2x2 that
  has never been observed to succeed. So the ramp is not merely correlated with a browser's
  age; it starts in a specific, identified code path. That is direct support for the age
  recycle, which exists precisely to arrive at every renewal from the token-less cell instead.

### THREE INSTRUMENTS FOR THE UNCURED HALF (2026-08-17, fourth pass)
- **A BREADCRUMB, because four wedges could not say which await hung.** `mark()` in the
  resident loop plus an `onStep` callback threaded through `renewSession`, so the bail prints
  `Stalled in: renew:click-sign-in (312s in that step)` instead of "the loop has not advanced".
  **`mark()` deliberately does NOT touch `lastTick`** — a step beginning is not the loop
  advancing, and if it reset the clock, entering a step would postpone the very watchdog that
  exists to catch a step never finishing. That would have made the wedge detector WORSE while
  looking like an improvement; it is the first mutation the test suite checks.
- **HEAP FACTS OVER CDP when the guard trips** (`scripts/auto-cart-bot/rc-heap.mjs`).
  `Performance.getMetrics` + `Runtime.getHeapUsage` answer the one question that halves the
  candidate space: **is the JS heap most of the process, or almost none of it?** Huge ⇒
  JavaScript is retaining it (a retry loop, our own `fetch` wrapper holding `init`). Small
  against a 25 GB process ⇒ it is NOT JavaScript, which eliminates every current candidate at
  a stroke. The log line states that verdict rather than printing counters.
  - **NOT a heap snapshot at the peak.** A snapshot of a 25 GB heap is itself many GB, written
    to disk at the moment the box cannot spawn a process — the cure arriving as part of the
    disease. The full snapshot is opt-in (`RC_HEAP_SNAPSHOT=1`), hard-capped, and wired ONLY
    to the early 1,500 MB trip, where the file is ordinary and the growing objects are already
    present. The RAM arm never writes one.
  - **No `--remote-debugging-port`.** It would open a socket with full control of a browser
    holding a live RC session, on a machine that is routinely screen-shared, to buy a
    diagnostic. CDP rides Playwright's existing channel; if that turns out to be jammed when
    needed, it reports `no answer` and the port becomes a decision made on evidence.
  - Bounded at 3s per step and every failure is a null, so it can never delay the exit — the
    mistake `rcFamilyMb` would have made in this same arm.
- ~~**AN AGE RECYCLE AT 40 MINUTES**~~ — **BUILT, MEASURED, AND REMOVED THE SAME NIGHT.** The
  argument was that a recycled browser comes back token-less, i.e. in the half of the 2x2 that
  works. **The premise is false: localStorage survives a browser restart.** The first firing
  said so in two lines:
  ```
  02:36:27 ♻ recycling the browser at 40m old …
  02:36:32 RC loaded and STAYING OPEN — token source: live      <- NOT token-less
  02:58:44 renewing the session — the token has 10m left (src=live)   <- the same cell as ever
  03:00:24 ✗ RUNAWAY … Stalled in: renew:click-sign-in
  ```
  It changed neither the cell nor the timing and cost a browser restart every forty minutes —
  and restarts are not free: one of them turned the login rehearsal red the same night. Gone,
  with `worker/keepwarm-diagnosis.test.mts` pinning that it stays gone and why.
- **AND THE SAME DATA CLOSES THE "SHOULD THE RESIDENT TAB EXIST?" QUESTION — IT SHOULD.** The
  proposal was to park it on `about:blank` so the SPA ran seconds per minute instead of
  continuously. **The idle tab is measured innocent**: it sits at 200-330 MB for the best part
  of an hour and only ramps DURING the renewal, in every one of the twenty events. Parking
  would target the harmless part and add a page load per poll from an IP that has eaten a
  12-hour block. **Do not revisit without new evidence.**

### THE FIRST REAL FIRING, AND WHAT IT COST (2026-08-18)
```
02:36:27 ♻ recycling the browser at 40m old …                    <- age recycle: worked, useless
03:00:24 ✗ RUNAWAY — stalled 99s with only 3862 MB of free RAM (floor 4000 MB)
03:00:24   heap facts unavailable (newCDPSession: no answer in 3000ms)
03:00:24   Stalled in: renew:click-sign-in (58s in that step).
```
- **THE CONTAINMENT IS PROVEN, THIS TIME WITH ITS OWN LOG LINE.** Peak **5,688 MB / 71%
  COMMIT** against 27 GB / 99% untreated. The box stayed healthy throughout.
- **`os.freemem()` IS CALIBRATED.** The guard read **3,862 MB**; the PowerShell sampler read
  **3,726 MB** twenty seconds later — 3.5% apart. The doubt recorded when it shipped is closed.
- **THE BREADCRUMB NARROWED IT TO THE RENEWAL — and NOT to the click, however tempting.**
  `rc` went 280 MB → 5,688 MB between 02:58:24 and 03:00:25, which spans the reload, the token
  prime AND the click. `renew:click-sign-in` is where it was **caught**, not where it is proven
  to allocate. What IS established is that this is the renewal path and not the idle SPA.
- **THE HEAP FACTS FAILED, AND THE REASON IS FIXED.** Creating a CDP session needs the browser
  to negotiate a target attachment, which a browser eating the machine will not do.
  `attachHeapProbe` now opens the session **at launch while everything is healthy**, and the
  trip only SENDS a command down it. The old path survives as a fallback, and the shared
  session is never detached by a borrower — doing so would silently restore the bug on the
  second firing.
- **SECOND FIRING, 04:05:54 — THE CONTAINMENT HELD AGAIN AND THE CDP FAILURE MOVED.**
  ```
  04:03:52 renewing the session — the token has 10m left (src=live)
  04:05:54 ✗ RUNAWAY — stalled 121s with only 3669 MB of free RAM (floor 4000 MB)
  04:05:54   heap facts unavailable (Performance.getMetrics: no answer in 3000ms)
  04:05:54   Stalled in: renew:click-sign-in (80s in that step).
  ```
  Peak 4,866 MB / 51% COMMIT. **Attaching the probe at launch worked** — the failure is no
  longer `newCDPSession` — **and the browser will not answer a command down an EXISTING socket
  either.** Two firings, two different CDP failures, and together they close the question:
  **the reading cannot be taken at the trip at all**, and no timeout worth spending changes it.
  - **SO THE INSTRUMENT MOVED EARLIER: a heap TRAIL.** The watchdog tick samples
    `Performance.getMetrics` every 10s while the browser still answers and keeps the last
    dozen; the trip prints them with ages. A ramp goes 270 MB → 5 GB in two minutes, so the
    samples either side of the onset are exactly the ones that say whether the JS heap grew
    **with** the process or stayed flat while something outside it did. Same move as the memory
    sampler that started all this: a series replaces an observation that can only be taken at
    the worst possible moment.
  - **Fire-and-forget with an in-flight flag.** The timer must never await — its whole value is
    that it keeps running — and once the browser goes quiet every attempt costs its full
    timeout, so without the flag they pile up one per tick.
  - **An EMPTY trail is its own reading** and says so: "the browser answered no CDP call at
    all" and "the JS heap was flat" are different facts and a blank line would merge them.
  - **BOTH FIRINGS STALLED IN `renew:click-sign-in`, AND THAT STEP NAVIGATES TO OKTA.**
    `clickSignInControl` clicks RC's Log in control, which goes to
    `signin.reservecalifornia.com`. So the ramp coincides with loading OKTA'S page, not RC's
    SPA. **Recorded as a candidate, not a finding** — the memory rose across the reload, the
    prime and the click, so the navigation is where it was caught and not yet where it is
    proven to allocate. The trail is what will separate them.
- **THIRD FIRING, 05:09:57 — AND THE TRAIL ANSWERED THE QUESTION.**
  ```
  05:07:55 renewing the session — the token has 10m left (src=live)
  05:09:57 ✗ RUNAWAY — stalled 121s with only 3728 MB of free RAM (floor 4000 MB)
  05:09:57   heap facts unavailable (Performance.getMetrics: no answer in 3000ms)
  05:09:57   heap trail (newest first): 123s ago JS 16 MB / 1711 nodes · 133s ago JS 16 MB /
             1711 nodes · … twelve samples, byte-identical …
  05:09:57   Stalled in: renew:click-sign-in (81s in that step).
  ```
  **IT IS NOT THE JS HEAP.** Sixteen megabytes, flat, with a flat DOM, while the process reached
  **4,903 MB**. That eliminates the entire JavaScript-retention family in one reading — the
  retry loop, our own `fetch` wrapper holding `init` per pending request, an array nobody trims,
  DOM growth. Whatever allocates is OUTSIDE the JS heap.
  - **STATED PRECISELY, BECAUSE THE TRAIL SHOWS ITS OWN LIMIT.** All twelve samples are
    identical and the newest is **123s** old against a **121s** stall — so sampling stopped the
    instant the renewal began, and the during-ramp window is UNOBSERVED. What makes "not the JS
    heap" the strong reading anyway is V8's own ceiling: default max old space is ~4 GB and
    these ramps have peaked at **27 GB**. A 27 GB process cannot be mostly JS heap.
  - **The containment has now held THREE times** — 5,688 / 4,866 / 4,903 MB, never past 71%
    COMMIT. And all three stalled in `renew:click-sign-in`, which navigates to
    `signin.reservecalifornia.com`. **Still a candidate**: memory rose across the reload, the
    prime AND the click, so that is where it was caught, not where it is proven to allocate.
- **TWO INSTRUMENTS FOR THE NEXT ONE (migration 062).** The heap trail cannot answer either
  question, for one shared reason — it stops when CDP does.
  1. **A FREE-RAM TRAIL WITH THE STEP ATTACHED.** `os.freemem()` is a syscall, not a request to
     the browser, so it keeps answering through the whole event, and it is already read on every
     10s tick. Each reading carries the breadcrumb step, so the next trip prints e.g.
     `9080 MB @ renew:reload · 8900 @ renew:prime-after-reload · 4100→3700 @ renew:click-sign-in`
     — which is what separates the three steps, and they have different fixes. Consecutive
     identical steps collapse, **oldest→newest inside a group**: the first version overwrote as
     it walked and printed the OLDEST value against the NEWEST timestamp, reversing the
     direction of travel on the one line whose job is showing memory fall. Caught by rendering a
     fixture and reading it, which is the only way a formatting bug ever is.
  2. **THE CHROMIUM PROCESS TYPE.** `browser` / `renderer` / `gpu-process` / `utility` are four
     different investigations and the sampler recorded only the profile FAMILY. `--type=` sits
     on the command line it already reads for `--user-data-dir`. **The parent carries no `--type`
     at all**, so an absent flag identifies it as `browser` rather than defeating the check.
     `rc_by_type` keeps per-type totals as well, because the last three ramps put only 3,052 MB
     of 4,903 in the biggest process — naming only that describes under two thirds of the growth.
     - **The 2-min sampler can now catch a ramp at all**, which is new: it spawns PowerShell, and
       that used to fail as COMMIT passed ~95%. With the guard capping ramps near 60-70% it
       recorded the whole of this one.
     - **The parser stays backward compatible** and the type field goes BEFORE the directory: the
       directory is a path that may contain `|` and is joined from the remainder, so a field
       after it would be swallowed. A four-field line from a box that has not updated reads as
       "type not reported" rather than putting the path in the type slot and classifying every
       process as `other`.
     - The type is allow-listed on the way into the database — it crosses the network from the
       box and renders on the admin page — and an empty per-type map stores NULL, never `{}`.
- **AND THE PROCESS-TYPE CHANGE KILLED THE MEMORY SERIES FOR TEN MINUTES (2026-08-18).**
  `rc_by_type` is `jsonb`, and a plain JS object was handed to `mutate`. **`sqlit`
  INTERPOLATES rather than binds**, and its fallback is `String(val)` — so the object became
  the literal `'[object Object]'`, Postgres rejected it, the whole INSERT threw, and
  `recordMemorySample`'s `.catch` turned that into silence.
  - **THE COST WAS NOT THE MISSING COLUMN. NO SAMPLE WAS STORED AT ALL** — the instrument this
    entire investigation runs on, switched off by one unstringified argument, with nothing
    anywhere reporting it. Found only because a reading that should have arrived did not.
  - **DIAGNOSED FROM THE CLOCK, and the first two readings were both misread.** Samples stopped
    at 05:35:50 and `bot.mjs` restarted at **05:36:37**, so the NULLs read at 05:37 predated the
    new code entirely and proved nothing either way; then four minutes with no sample at all
    looked like the box, when the timing points at Vercel deploying the new route. **The box was
    never at fault.** `tail-log bot` showing a restart AFTER the samples is what separated them.
  - Fixed at the call site (`JSON.stringify` + `$15::jsonb`, verified by driving the real INSERT
    against the real table and reading it back) **and systemically: `sqlit` now THROWS on a plain
    object.** `[object Object]` is either a rejected statement or corrupt data written without
    complaint, and no caller can ever have wanted it — so throwing surfaces an existing bug
    rather than creating one. Arrays and Dates keep their real encodings; the refusal sits
    ABOVE the `String()` fallback or it could never run.
  - **A MUTATION SURVIVED AND THE REASON IS THE USUAL ONE.** The guard asserted the refusal's
    MESSAGE was present and correctly positioned, so `if (false)` left both true and passed
    against a `sqlit` that stringified objects exactly as before. Pin the comparison, not the
    branch it guards. **Twelfth time.**
### FOURTH FIRING, 2026-08-18 23:12 PT — BOTH INSTRUMENTS ANSWERED
The process type and the RAM trail landed together, and between them they name the family of
allocation and **correct a candidate this file carried for three firings.**
```
baseline  rc  264MB  {browser:42,  utility:24, renderer:103,  gpu-process:93, crashpad:2}
ramp      rc 2046MB  {browser:587, utility:28, renderer:1340, gpu-process:89, crashpad:2}
```
- **IT IS THE RENDERER *AND* THE BROWSER PROCESS.** Renderer **+1237 MB**, browser process
  **+545 MB**; GPU, utility and crashpad all FLAT. That rules the GPU family out entirely, and
  the pairing is the interesting part — the browser process is where Chromium's network stack
  lives when the network service is not in its own utility process, and utility did not move.
- **WITH THE JS HEAP FLAT AT 15 MB**, that gives: **non-JS memory, in the renderer and the
  browser process.** Network/IPC buffering is the leading CANDIDATE, and is labelled as one.
- **THE CLICK IS NOT THE TRIGGER — THE RAM TRAIL SAYS SO IN ONE LINE.**
  ```
     3s ago  6912→3946 MB free @ renew:click-sign-in      (x7)
    73s ago  8440→7253 MB free @ renew:prime-after-reload  (x4)
   113s ago  9060      MB free @ login rehearsal
  ```
  Read oldest-first: the machine was already shedding ~1,200 MB **during
  `renew:prime-after-reload`**, before the click ran at all. The click is simply the LONGEST
  step, which is why the stall landed there on all four firings — exactly the "caught, not
  proven" caveat the trail was built to settle. **The onset is the reload that follows
  `dropStoredToken`.** `renew:reload` never appears because it completes inside one 10s tick.

### STOP RENEWING AT NEAR-EXPIRY (2026-08-18) — BUILT, awaiting a box update
The step that leaks is a step that has never worked, so removing it may cost nothing.
- **Every ramp began in a NEAR-EXPIRY renewal** (`the token has 10m left (src=live)`):
  23:44, 02:58, 04:03, 05:07, 06:12 — five for five.
- **That cell has never once succeeded.** This file's own 2x2 already records it as "not
  observed to work" (`554s → none`, `-115s → none`), and on 08-18 not one attempt completed —
  the guard killed the browser every time.
- ~~**The TOKEN-LESS cell works and does not ramp**: `✓ renewed by authorize: none → 3580s`,
  observed repeatedly, with `cleared 0 storage key(s)` and no memory event after any of them.~~
  **FALSIFIED THE SAME DAY — see the section directly below.** It works and it ramps ~2.3 GB.
  Every "no memory event" reading behind that sentence was a 2-minute sampler missing a
  46-second allocation. **The stand-down is still right and it HALVES the leak; it does not
  cure it,** because the cell it moves to navigates to Okta as well.
- So: let the token lapse and renew from empty. The apparent cost — a few dead minutes per
  hour — is what we ALREADY have, because the near-expiry attempt fails anyway.
- **A WOBBLE, RECORDED SO IT IS NOT RE-DISCOVERED AS A REFUTATION.** Two near-expiry renewals
  on 08-18 (11:08, 11:38 UTC) show no ramp. Both read `· skipped: no Okta session to renew
  against` — they never ran. They neither support nor contradict.
- **BUILT.** `planRenewal` now stands down while the token is alive AT ALL (`key: 'alive'`)
  instead of acting under a 10-minute threshold. `RENEW_BEFORE_S` and the `renewBeforeS`
  parameter are GONE rather than left unused, so nobody wires the threshold back in by
  accident. `leftS == null` (no token, or one that will not decode) and `leftS <= 0` still act
  — refusing those is the ninety dead minutes of 2026-08-15.
- **THE COST, STATED HONESTLY:** the session is dead between expiry and the next attempt, at
  most one `RENEW_FLOOR_MS` (5 min). **That is not new.** The near-expiry attempt renewed
  nothing and took the browser with it, so that window was already dead — and cost several GB.
- **`maybeAutoLogin` IS UNTOUCHED.** It signs in at T−30 of a real release and is the thing
  between a queued hold and a missed cart. This schedule is the background repair; they stay
  separate, as they have since 2026-08-15.
- **THE OLD GUARD WAS INVERTED, NOT DELETED.** `worker/renewal-schedule.test.mts` asserted
  `go === true` at 5 minutes left; that assertion WAS the bug, so it now asserts the stand-down
  and says why. A second test pins the boundary as live-vs-dead (1s acts as alive, 0s acts as
  lapsed) so the threshold cannot creep back as "under a minute is basically expired".
  Four mutations, each verified to fail.
- ~~**HOW TO READ THE NEXT DAY.** If ramps stop entirely once the box updates, this was the
  cause. If they continue, the near-expiry path was merely where it was observed and the real
  trigger is the reload-with-clear itself — which the token-less renewal also performs, just
  with nothing to clear.~~ **ANSWERED IN NINETY MINUTES, AND BY NEITHER BRANCH.** The trigger
  is not the reload-with-clear either — two token-less renewals ran the identical clear and
  reload with no ramp at all. See below.

### A THREE-DAY-OLD TOKEN KEEPS COMING BACK (2026-08-19) — the session cannot exit the loop
Four consecutive renewals produced the same impossible pair:
```
✗ no fresher token (none → -267960s), got as far as: none
    cleared 0 storage key(s): (none — nothing was there to drop)
```
- **No token BEFORE, a 74-hour-dead one AFTER**, and the negative grows by ~700s per run —
  one fixed ancient expiry receding, i.e. the SAME corpse returning every time. Something
  restores it DURING the navigation.
- **This is why the session cannot recover.** Every renewal ends with the app holding a dead
  token, Okta reporting `ALIVE`, and nothing minting anything. `maybeAutoLogin` at T−30 is the
  only thing that can break the loop.
- **`dropStoredToken` COVERS LESS THAN ITS NAME SUGGESTS.** `localStorage` only, and within it
  only `ssoAccessToken`, `accessToken`, and keys starting `okta-`. It has never touched
  **sessionStorage**, **IndexedDB**, or a localStorage key under any other name. Cookies are
  excluded deliberately and must stay so — losing `DT` makes a sign-in look like a fresh
  profile, which cost the household IP twelve hours on 2026-08-06.
- The 2026-08-15 entry already named the candidates — *"IndexedDB, a cookie, or a key name
  nothing has looked for"* — and then nobody looked. `storage-census.mjs` looks.
- **VALUES ARE NEVER REPORTED: a key NAME, a character COUNT, and a locally-decoded `exp`.**
  Every value here is potentially the session, and this repo has published a credential twice
  by collecting a field it then had to filter — an OAuth code on 08-09, a password on 08-16.
  An age identifies the corpse and cannot be replayed.
- **It fires ONLY on the pathology** (`!renewed && after < 0`), because it reads every key name
  in both stores and doing that on every renewal is noise on the one log read at 07:30.
- ~~**NO `idb` FIELD.**~~ True when written and **superseded within the hour by the census's own
  first reading** — see directly below. The reasoning stands and is why the coverage arrived as
  a SECOND evaluate rather than by making one body async: an always-empty array would read as
  "we looked and found none", the zero-for-an-absent-reading mistake, twice made.
- `worker/storage-census.test.mts`, **six mutations, each verified applied** — the value
  reported, a failed read shown as empty stores, the `SURVIVES` flag dropped, sessionStorage
  treated as covered, clean stores reported as an all-clear, and the gate widened to every
  renewal.

#### IT ANSWERED ON ITS FIRST RUN: THE CORPSE IS NOT IN EITHER WEB STORE (2026-08-19 05:58)
```
05:57:54 renewing the session — the app holds no usable token (src=none)
05:58:52   ✗ no fresher token (none → -270366s), got as far as: none
05:58:52     cleared 0 storage key(s): (none — nothing was there to drop)
05:58:52     storage census: local 6 key(s), session 1 key(s) — NO token-shaped value in
             either store, so the stale token is coming from somewhere else
05:58:52    signin.reservecalifornia.com: DT, [opaque], luf_*, ln, luf_*, [opaque], idx, JSESSIONID
```
- **THE PATHOLOGY IS CONFIRMED AS ONE FIXED EXPIRY RECEDING, TO THE SECOND.** `-270133s` at
  05:54:59 and `-270366s` at 05:58:52 differ by **233s**, which is exactly the wall clock
  between them. So it is not a family of stale tokens — it is the SAME token, minted around
  2026-08-16 01:52 (the last one the box held before the session died), coming back every time.
- **AND IT IS NOT IN `localStorage` OR `sessionStorage`.** Six keys and one key respectively,
  none of them JWT-shaped. That eliminates the store `dropStoredToken` sweeps AND the store it
  has never touched, in one reading — which is the whole reason the census reports the count
  and the shape rather than just the names it knows about.
- **SO THE REMAINING CANDIDATES ARE INDEXEDDB, A COOKIE, OR THE SERVER**, and the census then
  declined to look at the first of those. **Fixed the same night (PR #134):** IndexedDB is
  enumerated through a SECOND evaluate — names, object stores and `count()`, **never a value**.
  `getAll()` would pull every row into a renderer already suspected of allocating gigabytes,
  which is `response.body()` and the multi-GB heap snapshot all over again.
- **`renewSession` ALSO REPORTS WHERE THE TOKEN WAS FOUND NOW**, and it is one field that was
  already being computed and thrown away. `primeToken` returns a `source`: **`live`** means the
  token came off RC's own outbound Authorization header — the SPA held it in memory, having
  restored it from somewhere the clear cannot see — while **`localStorage`** would mean the
  census simply ran too late and the store is the answer after all. Two different
  investigations, separated for free.
- **TWO EXISTING GUARDS BROKE OVER UNCHANGED BEHAVIOUR.** `storage-census.test.mts` pinned the
  inline `takeStorageCensus((fn, arg) => evaluateWithin(…))`, and hoisting that arrow into a
  `const` invalidated it; `keepwarm-recycle.test.mts` pinned `renewSession`'s ENTIRE return
  literal in order, so adding `afterSource` beside `visitedOkta` failed over a change that
  altered nothing. Both re-anchored on the property rather than the expression, and both
  verified still failing against the regression they exist for. **Seventeenth time.**

#### AND FOUR OKTA TRIPS IN NINETY MINUTES DID NOT RAMP — which does not fit
The first RAM-paired trace is a NEGATIVE, and it is the interesting kind:
```
05:58:52  network trace: 112 response(s), 8.7 MB declared (+30 with no content-length)
          · simple_banner.jpg 3.3 MB · index-*.js x2 1.9 MB · …
          · RAM 8837 → 8784 MB (−53) ⇒ this navigation did NOT ramp, so the byte count
            says nothing about the leak — wait for one that does
```
The memory sampler agrees independently: `rc` went 199 → 323 → 342 MB across it.
- **THE THREE-WAY VERDICT EARNED ITS KEEP IMMEDIATELY.** Without the RAM reading this would
  have printed *"buffering does NOT explain the ramp"* over a navigation that never ramped —
  which is the exact false elimination the 05:07 trace was one sentence away from being written
  up as. It refused instead.
- **AND IT CONTRADICTS "EVERY OKTA NAVIGATION COSTS ~2.3 GB".** Four token-less renewals
  between 05:43 and 05:58 all clicked through to Okta and **none of them ramped**; the hourly
  peak table reads 370 MB at 05:00 and 329 MB at 06:00 against 4,168 MB at 04:00.
- **TWO CANDIDATE EXPLANATIONS AND THE DATA CANNOT SEPARATE THEM — do not write one in.**
  (1) **The browser's AGE matters** and the post-Okta recycle, by keeping every browser young,
  has incidentally suppressed the ramp; the 08-18 19:10 counter-example (token-less, ONE trip,
  2,331 MB) was in a browser that had been alive about an hour, before that recycle reached the
  box. (2) **The CELL matters** — every ramp over 4 GB has been `src=live` (the two-trip case:
  the SPA's own `prompt=none` plus our click), and 04:00 today was `src=live` at −1m.
  **Both predict today's silence.** The discriminator is a token-less renewal in a browser that
  has been alive an hour, which the recycle now makes rare on purpose.
- **THE BOX HAS NOT BEEN PAST 71% COMMIT SINCE THE 25 GB ORPHAN**, and the orphan sweep has
  since shipped. Containment is holding; the cause is still open.

#### THE HAND SIGN-IN TOOK 17 SECONDS, AND THE LOGIN IS NOT BROKEN (2026-08-19 06:24 UTC)
Three days dead, and `rc-login.bat` fixed it on the first attempt with no CAPTCHA and no form
struggle:
```
06:24:23 Opening ReserveCalifornia for a ONE-TIME human sign-in.
06:24:40 ✓ Signed in. The keep-warm loop can take it from here.
06:24:40   token call: {"grantType":"authorization_code","usedPkce":true,…}
06:24:40   grant:      {"hasRefreshToken":false,"expiresIn":3600,…}
```
- **SO THE 08-18 "GOT HUNG UP AT PASSWORD" READING IS NOT A STANDING FAULT.** Whatever that
  was, the credentials work and Okta still remembers this device — the browser rendered
  **"Log in / Sign up"**, i.e. genuinely signed out, so this exercised the real sign-in rather
  than being answered silently. That is the `provedNothing` case avoided by luck of state.
- **`hasRefreshToken: false` AGAIN.** The script's own epilogue asks for these three lines
  because `hasRefreshToken` "decides whether the 8am hold can ever run without a human" — that
  question was **answered on 2026-08-15** and the answer is no, there is nothing to silently
  refresh with. **The prompt is older than the finding; do not re-open it on seeing that line.**
- **`autocart.rc_session` READ `fail` FOR ABOUT A MINUTE AFTERWARDS AND IT WAS AN ARTIFACT** —
  *"RC REJECTED the session … checked 0s ago"*, taken by a keep-warm that had just been
  relaunched by `rc-login.bat` and had not primed the token yet. It read `ok … token exp in
  60m; okta=ALIVE` on the next pass. **A health reading taken 0 seconds after a restart is not
  evidence**; the same family as the 08-12 note that a reading goes stale faster than a
  conclusion drawn from it, inverted — this one was too FRESH to mean anything.
- **`autocart.rc_runner` SAID "1 hold(s) due" AND IT WAS A TEST FIXTURE.** `dueHolds` is
  deliberately NOT filtered to real unit ids (the hold suites exist to test it), so any
  `npm test` run — including CI on a merge — puts a `requested` sentinel inside the 20-minute
  grace for the length of the run. It read `no holds due` once the run finished. Expect this
  whenever a merge lands; it cannot cart anything, because the unit id is non-numeric.

### `npm test` KILLED THE PRODUCTION RC SESSION (2026-08-19) — fixed in the FEED
The 2026-08-18 entry records fixture-driven profile churn as *"bounded, understood"*. **It is
not churn. It is the session**, measured:
```
13:33:52 ♻ token exp in 45m; renewed=no; src=live; okta=ALIVE   <- 7h old, self-sustaining
13:49:07 → hold runner wants the profile — closing and standing down
13:49:50 RC loaded and STAYING OPEN — token source: none        <- the token is GONE
13:50:38 ⚠ RC SESSION IS DEAD
```
- **THE LIVE TOKEN LIVES IN PAGE MEMORY, NOT localStorage**, when the SPA has been silently
  re-minting — so the keep-warm's yield-close-reopen loses it. (A token minted by OUR renewal
  goes through the exchange and into storage, and DOES survive a restart — the two behave
  oppositely, which is why 08-19's update kept the session and 13:49 did not.)
- **AND THE WORK IT YIELDED FOR WAS A TEST FIXTURE** — the runner's log names `#L__t9003`,
  `#L__t9102`, `#L__t9007`, and the 13:49 pass falls inside CI for **a PR that changed only
  Markdown.** So any `npm test` run, CI included, can take the session a real cart depends on.
- **FILTERED IN THE FEED, NOT IN THE QUERIES.** `dueHolds`/`pendingClaims` are what the hold
  suites exist to test; filtering them would gut the tests that make this table safe, which is
  why the 08-18 fix stopped at `nextHoldRelease`/`holdAtRisk`. `isRealUnitId` filters what the
  runner is SERVED — all three work lists, because all three make it take the profile, and
  `pollMs` too or a fixture drops it onto the 1s cadence. Server-side, so it reached the box on
  a push. `worker/feed-fixture-invisibility.test.mts`, six mutations.

### A BLANK RC APP IS NOT A FAILED LOGIN — in the release path too (2026-08-19)
`attemptLogin` has returned `provedNothing` for RC's *"We're having trouble loading the
application"* since 08-18. **The rehearsal honoured it; `maybeAutoLogin` did not** — the refund
sat inside the `r.ok` branch and a blank load returns `ok: false`, so the T−30 caller fell to
the plain failure arm: spent one of two attempts, reported `dead`, rang the phone, and printed
`rc-login.bat` — which force-kills the Chromium the token lives in.
- **Observed live the same day**: RC showed that screen during a hand sign-in, seconds after
  `stop-rc` killed eleven processes, and **cleared on a retry.** The transient case is real and
  it happens when the box is disturbed, which is what T−30 looks like.
- **NOTHING IS REPORTED on that arm** — `warm` and `dead` are both verdicts and a page that
  never rendered supports neither; the previous verdict goes stale, which `alarmIfSessionUnusable`
  still watches. It stays LOUD with a screenshot: this is also the 08-14 profile-fault signature.
- A REAL login failure still reports `dead` and still spends an attempt, pinned separately so
  this is not bought by making every failure inconclusive. `worker/autologin-noload.test.mts`.

### "UPDATE NOW" IS FAST NOW (2026-08-19) — and the ~20-minute note below is superseded
- **THE CLAIM WAS THE STALL.** A poller claims within 15s and spawns the updater; when the
  GUARD refuses (release within 6h, feed unreachable) the run ENDS — but the claim sat until
  its 20-minute TTL, so every retry answered `SKIP - another process holds the update claim` at
  a dead record. `noteBotUpdateAttempt` now RELEASES the claim on a refusal, so the next
  15-second poll retries. **Server-side: live already.**
- **EXCEPT THE BYSTANDER'S OWN REFUSAL.** `SKIP - another process holds the update claim` comes
  from a process refused *because a real update is running*; releasing on it would let a second
  updater claim while the first owns the checkout. `%claim%` is the discriminator, pinned
  against `update-guard.mjs`'s actual strings in `worker/bot-update-latency.test.mts`.
- **`npm ci` NOW RUNS ONLY IF `package-lock.json` MOVED** between the two shas — computed
  before the reset while both exist, and the ROLLBACK uses the same variable. That was one to
  three minutes on every update for a dependency change most pushes do not contain.
- **CHICKEN-AND-EGG, SO EXPECT ONE MORE SLOW ONE:** the `npm ci` half is bot-side, so the
  update that LANDS it is still slow and the one after is fast.

### A REMOTE `test-login`, AND WHY NOT A SHELL (2026-08-19)
Asked for PowerShell or cmd on the box so the diagnostics need no human. **Refused, and the
reasoning is `bot-commands.mjs`'s own header**: that machine holds the live RC session, the
DPAPI credential store, and a residential IP both providers have blocked, so a free-form
channel makes `AUTOCART_TOKEN` a shell on a home network. **Levers are added BY NAME.**
- `test-login` queues a SIGNAL FILE and never logs in itself — the rehearsal needs the Chromium
  profile the keep-warm owns, and a second process on that profile is the
  two-browsers-one-`user-data-dir` corruption. The keep-warm consumes it in its own loop and
  runs the SAME `runLoginRehearsal` body as the nightly, `prompt=login` included.
- **SCHEDULE GATES LIFT, SAFETY GATES DO NOT.** Gone: the 20:00 hour, the once-per-20h. Kept:
  the 6h release gate, the abnormal-exit quiet window, the credentials check, and **one
  on-demand run per 6h on the BOX's own clock** — a lever any token-holder can pull must be
  bounded by the machine, not by trust.
- **THE RATION IS A FILE, SPENT BEFORE THE ATTEMPT.** `supervise.ps1` restarts this process on
  exit, so an in-memory ration is re-issued by every restart — the crash-loop-spends-the-login
  -budget shape that cost the IP twelve hours on 08-06. The ask is consumed at pickup too.
- A refusal is REPORTED, not just logged: somebody is watching the admin page, and a silent
  refusal is indistinguishable from the signal never arriving.
- **EVERY LOG IS FETCHABLE NOW** (`rc-test-login`, `rc-cart-cap` added). Still a NAME allowlist,
  never a path. `worker/log-allowlist.test.mts` fails if a written log is unreachable OR if an
  entry points at a file nothing writes.

### THE RENEWAL RUNS IN A THROWAWAY TAB NOW (2026-08-19) — the first CURE, and what it rests on
The owner's instruction was "solve the leak", and the recorded cure (1) is what shipped
(PR #142): **the renewal's Okta round trip runs in a tab opened for that purpose and closed
in a `finally`** — same context, same cookies, same localStorage, so the minted token lands
in the same profile — and the renderer that did the trip dies at close, taking its
allocation with it.
- **THE THREE MEASUREMENTS IT RESTS ON**, all above: the ramp is NON-JS memory (heap trail:
  15-18 MB flat against multi-GB processes); it lands in the RENDERER (+1,237 of 2,046 MB)
  plus the browser process; and across twenty ramps it has **never once been seen to come
  back down in place** — every recovery was a new pid. A renderer's memory dies with its
  page, so give the trip its own page.
- **THE RECYCLE IS GONE FROM THIS PATH AND KEPT FOR `maybeAutoLogin`/THE REHEARSAL**, which
  still navigate the resident page. The recycle was a browser restart per renewal; restarts
  are not free (one turned the rehearsal red on 08-18) and after the tab they free memory
  that is already freed. **The old guard asserting the renewal sets `oktaTrip` was INVERTED
  deliberately** — reinstating that line reintroduces a per-renewal browser restart that
  looks like caution.
- **THE RESIDENT PAGE IS RELOADED AFTER A SUCCESSFUL TAB RENEWAL**, because `checkAndReport`
  reads the resident page and `window.__camphawkRcToken` is per-page: without it, every
  report after a tab renewal announces a dead session over a fresh hour of token — a repair
  that happened and cannot be seen.
- **WHAT THIS DOES NOT CLAIM: the allocation itself is not stopped.** A ramping trip still
  ramps while it runs; the RAM arm still guards it. The claim is only that the memory is
  handed back at close, every time, without costing the browser. **HOW TO READ THE SERIES:**
  spikes that drain at tab close with no `♻ recycling` line ⇒ working as designed; rc-family
  growth ACROSS renewals ⇒ the browser-process share does not drain, which is the residual to
  chase next (cure (2), `ctx.request`, remains unbuilt and would eliminate it).
- **AND THE "~2.3 GB PER OKTA TRIP" FIGURE IS NO LONGER A LAW.** The 19:20 renewal on 08-19
  made a complete, SUCCESSFUL round trip — click, authorize, callback, code exchange, fresh
  hour — for **141 MB** (`RAM 7839 → 7698`). Whatever separates a 141 MB trip from a 2.3 GB
  one is still unknown; the tab makes the question moot for the resident browser's health,
  and the RAM-paired trace keeps measuring it per-trip either way.
- **A TAB THAT CANNOT OPEN IS RECORDED** (`recordRenewal(renewed: false)`), so `planRenewal`'s
  floor and backoff pace the retries — unrecorded, a sick browser retries every tick, which
  is the 2026-08-08 request storm. The failure diagnostics (censuses) bind to the TAB while
  it is open: localStorage is shared, but the corpse-carrying `window.__camphawkRcToken`
  lives where the trip ran.
- `worker/keepwarm-recycle.test.mts`, six mutations, each verified applied — the renewal
  moved back to the resident page, the tab never closed, the recycle reinstated, the
  resident refresh removed, a failed tab open unrecorded, and the prime dropped.

### FIVE INSTRUMENTS AND NONE OF THEM STOPS IT — so COUNT THE BYTES (2026-08-19)
The owner's question, and it is the right one: *"It sounds like we keep trying to find a
solution for what to do after the leak, not stop it from leaking."* **Correct.** A size guard,
a RAM arm, a heap trail, a post-Okta recycle and an orphan sweep are all aftermath. Each was
justified in the moment by a box actively falling over, and none was ever a cure.
- **THE CANDIDATE WAS NAMED THREE TIMES AND NEVER TESTED.** "Network/IPC buffering" is written
  into three separate entries above as the leading explanation, and it is **directly
  observable** — non-JS memory growing by gigabytes in the RENDERER and the BROWSER PROCESS is
  the shape of a huge or looping response, and the browser process is where Chromium's network
  stack lives when the network service is not in a utility process (utility was flat).
  Nobody ever watched the network during a ramp.
- **`okta-net-trace.mjs` counts them**, wrapped around `renewSession`, logged pass or fail —
  the failing renewals are the ones that ramp, so a trace gated on success would miss every
  event it exists for. Aggregated BY PATH, because forty requests to one endpoint at 30 MB is
  a LOOP and looks nothing like one big download.
- **A NEGATIVE IS THE POINT.** Small numbers ELIMINATE the whole buffering family at a stroke
  and make the next candidate worth building for. The verdict line says which way it went
  rather than printing counters.
- **IT MUST NOT BECOME THE THING IT MEASURES.** Response bodies are NEVER read —
  `response.body()` buffers the payload into this process, which on a page suspected of moving
  hundreds of MB is the cure arriving as part of the disease, the same mistake as writing a
  multi-GB heap snapshot when the box cannot spawn. Only `content-length` is consulted, and the
  record count is capped.
- **AND IT MUST NOT LEAK A CREDENTIAL.** URLs are `origin + pathname`. Okta's callback is
  `/login/callback?code=…&state=…` and that code is exchangeable for the session — published
  once already on 2026-08-09 by reporting `location.href`. **Do not collect a field you would
  then have to filter.**
- **THE TWO REAL CURES, NOT BUILT, in order of ambition.** (1) Do the Okta round trip in a
  throwaway TAB in the same context — same cookies, same session — and close it; the last
  event put 2,689 MB of 4,168 in the renderer, reclaimed deterministically instead of by
  killing the browser. (2) Skip the renderer entirely: intercept the authorize request (the
  `prompt=login` machinery already does this), abort the navigation, replay it over
  `ctx.request` following redirects, hand the callback back. No page load, no gigabytes.
  **Do the trace first** — it is the only one that could make both unnecessary.
- `worker/okta-net-trace.test.mts`, **eight mutations, each verified applied.** One survived
  first: the disarm flag deleted. **The test was wrong, not the code** — it fired a leaked
  handler and then asserted a SECOND trace saw nothing, but a leaked handler pushes into the
  FIRST run's array, which has already been summarised. The effect is not observable from
  outside, so the flag is pinned structurally and the reason is written down.
- **THE FIRST TRACE RAN, AND IT NEARLY PRODUCED A FALSE ELIMINATION (2026-08-19 05:07).**
  ```
  05:06:13 renewing the session — the app holds no usable token (src=none)
  05:07:12   network trace: 112 response(s), 8.7 MB declared (+30 with no content-length)
             · simple_banner.jpg 3.3 MB · index-*.js x2 1.9 MB · index-*.css 0.5 MB
  05:07:24 ♻ recycling the browser — the sign-in click took it through Okta
  ```
  8.7 MB across a full Okta round trip is three orders of magnitude below a 2.3 GB
  allocation, and it was one sentence away from being written up as retiring the buffering
  candidate. **It was not entitled to be.** The 2-minute memory sampler BRACKETED that
  renewal — 05:05:56 and 05:07:56 either side of a run from 05:06:13 to 05:07:12 — and the
  post-Okta recycle freed everything twelve seconds after it ended. **Whether that navigation
  ramped at all is unobserved**, and a trace of a non-ramping trip says nothing about a leak.
- **TWO INSTRUMENTS HAD MADE EACH OTHER USELESS.** The recycle now cleans up faster than the
  sampler samples, so the series can no longer see the very event the trace is attached to.
  That is a new shape here: not a guard that cannot reach what it measures, but two correct
  instruments whose cadences cancel.
- **FIXED BY PAIRING THE TWO FACTS IN ONE READING.** `os.freemem()` is taken immediately
  before and after the SAME wrapped call — a syscall, so it keeps answering under the pressure
  that stops `rcFamilyMb()` spawning PowerShell, and read inside the `try` so the recycle
  cannot have run yet. The verdict is now three-way and **refuses to speak when there was no
  ramp**: `RAM 8940 → 6610 MB (−2330) ⇒ it ramped while the network moved almost nothing`
  versus `⇒ this navigation did NOT ramp, so the byte count says nothing about the leak`.
  Same rule as `unknown` never rounding to `signed-out`.
- **AND A GUARD FROM YESTERDAY BROKE OVER UNCHANGED BEHAVIOUR.** `keepwarm-recycle.test.mts`
  anchored on `await renewSession(`; wrapping the call in `withNetworkTrace(page, () =>
  renewSession(…))` made `indexOf` return **-1**, so `readAt < -1` was false and it read as a
  real regression. Re-anchored on the callee with an explicit `> -1` assert, so a missing
  anchor fails loudly instead of silently inverting.

### THE RAM GUARD KILLED THE REPAIR IT WAS PROTECTING (2026-08-19) — floor 4000 → 2000
Reported as *"the session died after 4 hours"*. It did not, and none of the three obvious
causes is the answer.
- **IT SUSTAINED ITSELF FOR ~7h45m.** From the 19:21 sign-in to 03:00 the token cycled
  `42m → 22m → 2m → 41m → 21m → 1m → 41m → 21m → 1m → 40m` — five or six SILENT re-mints, with
  `renewed=no` and **zero `renewing the session` lines**. The self-renewal recorded the night
  before held far longer than the 2.5h it was recorded on.
- **AT 02:58:43 THE RE-MINT STOPPED AND OKTA'S EXPIRY FROZE, IN THE SAME INSTANT.**
  ```
  02:57:30  okta exp 14:57:30   <- rolling, +12h from the moment of the check
  03:17:30  okta exp 14:58:43   <- frozen
  03:37:31  okta exp 14:58:43
  03:57:32  okta exp 14:58:43
  ```
  The probe still answers `ALIVE`; the window simply stops advancing. **So there is an
  ABSOLUTE cap sitting behind the rolling idle timer**, and the SPA cannot silently re-mint
  once it is reached. That qualifies the 12-for-12 finding rather than overturning it: the
  rolling window is real and it is bounded. **What the cap is measured from is NOT
  established** — 02:58:43 is 19h37m after the sign-in, which is not a round number.
- **THEN OUR OWN GUARD KILLED THE REPAIR.**
  ```
  03:58:37 renewing the session — the token has -1m left (src=live)
  04:00:36 ✗ RUNAWAY — stalled 117s with only 3630 MB of free RAM (floor 4000 MB)
  04:00:36   RAM trail: 7158→3630 MB free @ renew:click-sign-in (x8)
  04:00:36   Stalled in: renew:click-sign-in (78s in that step).
  ```
  The stand-down worked exactly as designed — it waited for a genuinely lapsed token (−1m).
  The memory series shows the rest: flat 280 MB until 03:58, **4,168 MB** at 04:00 (renderer
  2,689 + browser 1,350, the two-trip signature), 213 MB at 04:02 after the kill.
- **AND IT WAS STRUCTURAL, NOT BAD LUCK.** The arm needs a 60s stall AND low free RAM. The
  Okta navigation **always** exceeds 60s and **always** allocates several GB, so a renewal
  that is working perfectly meets both conditions every single time. That is why all five
  firings stalled in `renew:click-sign-in` — arithmetic, not coincidence. **`maybeAutoLogin`
  makes the same navigation at T−30 of a real release**, with the breadcrumb parked on
  `auto-login`, so at 4000 the guard could take the login a campsite depends on.
- **THE POST-OKTA RECYCLE CANNOT COVER THIS**: `visitedOkta` is set when the click RETURNS,
  and here the process died mid-click.
- **FLOOR IS 2000 NOW, from the box's own series.** Free RAM maps to COMMIT roughly
  1,875 MB → 74%, 982 MB → 83%, 520 MB → 89%; the numbers that matter are ~90% (Windows stops
  scheduling) and ~99% (Node aborts). 2000 acts at about 73% — seventeen points of margin —
  while leaving room for a renewal whose worst observed peak is 5,688 MB against a ~9,000 MB
  idle, i.e. a trough near 3,300 MB.
- **THE CASE THAT JUSTIFIED 4000 HAS ITS OWN REMEDY NOW.** The 25 GB event was an ORPHAN, and
  **this arm never fired on it** — the loop kept ticking, so there was no stall. That is
  `orphan-sweep.mjs`'s job and it does not depend on this threshold. What is left here is the
  BOUNDED case, which the box survives comfortably.
- `worker/keepwarm-recycle.test.mts` now bounds the floor from BOTH sides with those measured
  numbers (≥1500 so it never acts past ~85% COMMIT, ≤3000 so it cannot trip during a normal
  renewal), rather than the old ≥2000/≤8000 which encoded the reasoning that produced 4000.
  Three mutations, each verified applied: the floor restored to 4000, dropped to 500, and the
  both-conditions rule removed.

### TWO CONCURRENT `npm test` RUNS RACE ON A GLOBAL SWEEP (2026-08-18)
`rc-hold-capacity.test.mts` → *"a carted hold that could never be released stops holding a
seat"* failed once and passed on every re-run — alone, with the other three hold suites, and
on a clean full `verify` (914/914). **Not a flake to shrug at: the mechanism is specific.**
- The test ages its own row past `HOLD_LAPSE_MIN`, calls `reclaimLapsedHolds()`, and asserts
  its id comes back. **That function is a global MUTATING sweep** — it marks every lapsed
  `carted` row `expired` and returns the ones it claimed. So a concurrent run's sweep can
  claim this row first, and the second caller correctly returns nothing.
- **Caused by breaking `docs/LANES.md`'s own serialization rule**: a local `npm run verify` was
  run while CI ran `npm test` on the same production DB for PR #127. That file says in as many
  words that two suites at once produce flakes indistinguishable from regressions.
- **Left as a flake rather than "fixed".** Loosening the assertion would weaken a guard over a
  real bug (two carted holds were the entire fleet on 2026-08-13), and the actual rule — one
  test run at a time — already exists and was simply not followed.
- **And I pushed before confirming green**, because the command chained `grep … && git commit`
  and grep succeeds when it finds the failure line. A verify gate that runs after the push is
  not a gate.
- **IT RECURRED THE SAME NIGHT, WITH A DIFFERENT SUITE, AND THE TRIGGER IS NOW NAMED.** A local
  `npm run verify` run immediately after merging #132 failed **eight** tests in
  `claim.test.mts` — the Silver Lake re-alert guards, the nudge, the concurrent-claim winner —
  and passed 14/14 alone and 953/953 on a re-run minutes later. **Merging IS starting a test
  run**: the merge fires CI on master, which runs `npm test` against the same production DB.
  So "merge, then verify" is the concurrency, and it is easy to do without noticing because
  neither half looks like running two suites at once.
- **THE SPREAD IS THE USEFUL PART.** The first occurrence was `reclaimLapsedHolds`, a global
  mutating sweep, which made it look like a property of that one function. `claim.test.mts`
  collides through `watch_site_alerts` rows instead. **Any real-DB suite with fixed fixture
  keys is exposed**, so the rule is the whole remedy — there is no subset of tests that is
  safe to run concurrently.

#### THE SECOND CALLER IS PRODUCTION, NOT A SECOND TEST RUN (2026-08-19)
It recurred on PR #136 — same suite, same test, same assertion (*"a stuck hold must be
reclaimed"*, `false !== true`), 969/970 — on a branch whose diff is **React components,
a UA sniff and docs.** Nothing in it can reach `worker/`. It passed alone (7/7) on the
first re-run, as it always does.
- **AND NO SECOND `npm test` WAS RUNNING.** No side-lane session was live, and the only
  other CI run on the PR had been cancelled four minutes earlier, before it could have
  reached the suite. So the account above — "two concurrent runs" — **does not fit this
  occurrence**, and it is the account that would have had somebody hunting for a phantom
  second run.
- **THE SWEEP HAS A STANDING CALLER ON FLY.** `worker/poller.ts` runs
  `withSyncClaim('expire-holds', …)` every `EXPIRE_HOLDS_INTERVAL_MS`, and
  `sweepMissedHolds` calls `reclaimLapsedHolds()`. That is a **global mutating sweep running
  in production on a timer**, against the same database the tests use on purpose. The
  fixture is a `carted` row aged past `HOLD_LAPSE_MIN`, which is exactly what it claims —
  and `REAL_UNIT` does not protect it, because that filter is on `nextHoldRelease` and
  `holdAtRisk`, not on the lapse sweep.
- **SO ONE TEST RUN IS ENOUGH.** The race is not test-versus-test, it is
  **test-versus-production**, it needs no second session, and serializing the lanes cannot
  prevent it. `docs/LANES.md`'s rule is still right and still insufficient here.
- **DELIBERATELY NOT "FIXED" BY LOOSENING THE ASSERTION.** Two carted holds were the entire
  fleet on 2026-08-13, and this guard covers a real bug. The honest options are to have the
  test tolerate the sweep having won (assert the row reached `expired` by SOMEBODY, rather
  than that this caller claimed it) or to scope the fixture out of the sweep. Both are
  changes to a safety-critical query and neither should be made in passing on an unrelated
  PR — which is why this is a note and not a diff.
- **A re-run is the correct response, and it is not the same as shrugging.** What makes it
  legitimate here is that the diff cannot touch the code, the suite passes alone, and the
  mechanism is named. Any one of those missing and it is a regression being waved through.

### THE SESSION RENEWS ITSELF ONCE WE STOP TOUCHING IT (2026-08-18, first 2.5 hours)
An OBSERVATION, not yet a measurement, and it is better than the stand-down was meant to buy.
Straight off the keepalive lines, with **zero `renewing the session` entries in the window**:
```
20:58:57 ♻ … token exp in 15m; renewed=no; src=live; okta=ALIVE
21:18:58 ♻ … token exp in 54m   <- went UP
21:38:58 ♻ … token exp in 34m
21:58:59 ♻ … token exp in 14m
22:18:59 ♻ … token exp in 54m   <- again
22:39:00 ♻ … token exp in 34m
```
- **Our renewal never ran.** `planRenewal` stands down for the whole period (`the token has
  59m left — waiting for it to lapse`), so nothing of ours navigated to Okta. The token was
  re-minted twice anyway, between 20-minute checks.
- **AND THERE WAS NO RAMP.** Nothing above 400 MB in 2.5 hours, across both re-mint cycles —
  against a browser that produced twenty ramps in the five days before. That is consistent
  with the controlled comparison below: no Okta navigation, no allocation.
- **So the near-expiry stand-down may have done more than halve the leak.** It was justified
  as "the cell that leaks has never worked, so removing it costs nothing"; in the steady state
  it appears to remove our Okta round trips altogether, because the SPA re-mints on its own
  while the token is still alive and we no longer interrupt it.
- **WHAT re-mints is NOT established — do not write one in.** Candidates: okta-auth-js's own
  autoRenew (which this file records as failing and DELETING the tokens, measured in a
  different state), the keepalive's own page load, or `sessionLive`'s authenticated call.
  `renewed=no` on every line is not evidence against any of them — that flag compares before
  and after within ONE check and cannot see a re-mint between two.
- **IT INTERLOCKS WITH THE OKTA-PROBE FINDING, AND THAT IS THE PART TO BE CAREFUL WITH.** A
  silent re-mint needs a live Okta cookie, and the section below establishes that OUR OWN
  unconditional probe is what keeps that cookie from idling out. So the accidental
  load-bearing probe is plausibly what makes this loop self-sustaining, and "tidying" it would
  take this with it.
- **TWO CYCLES IS NOT A REGIME.** The reading that would matter is the same pattern still
  holding after an overnight, and after a real `attemptLogin` (which navigates and therefore
  still leaks by construction). Do not quote this as "the leak is solved".

### IT IS THE OKTA NAVIGATION, AND THAT IS A CONTROLLED COMPARISON (2026-08-18, fifth pass)
The stand-down above went live on the box at ~19:13 PT. Within ten minutes the keep-warm's own
log produced the cleanest evidence this investigation has had — three **token-less** renewals,
same code, same profile, same browser generation, differing in exactly one thing: whether RC's
sign-in control was found and clicked.

| time (UTC) | cell | stage reached | navigated to Okta? | `rc` family at the next sample |
|---|---|---|---|---|
| 19:04:04 | token-less | `no-signin-control` | **no** | 200 MB |
| 19:10:43 | token-less | `authorize` ✓ (`none → 3579s`) | **yes** | **2,331 MB** |
| 19:13:46 | token-less | `no-signin-control` | **no** | 237 MB |

- **The two that never navigated ran the identical `dropStoredToken`, `renew:reload` and
  `renew:prime-after-reload` and allocated NOTHING.** So the RAM trail's reading — "the onset
  is the reload after `dropStoredToken`" — was where the stall was *caught*, not where the
  allocation happens. That correction is the same shape as the one the trail itself made about
  `renew:click-sign-in`, one level further in.
- **THE ARITHMETIC AGREES.** A near-expiry renewal makes **two** Okta round trips — the SPA's
  own hidden `prompt=none` once a real clear signs it out, then our click — and lands at
  4,313 / 3,986 / 4,866 / 4,903 MB. One trip lands at 2,331 MB. Half the trips, half the
  memory, and the 19:03 trail shows the two halves separately
  (`8638→6552 @ renew:prime-after-reload`, then `6217→3802 @ renew:click-sign-in`).
- **WITH THE JS HEAP FLAT AT 15-18 MB** and the growth in the **renderer plus the browser
  process**, the mechanism is still non-JS memory — network/IPC buffering remains the leading
  CANDIDATE and is not promoted. What IS established is the trigger.
- **SO THE SCHEDULE CANNOT CURE THIS.** `attemptLogin` navigates to Okta too, and it is
  release-critical: `maybeAutoLogin` at T−30 is the only thing between a queued hold and a
  missed cart. There is no version of this product that never loads Okta.
- **THE FIX IS THEREFORE A RECYCLE, KEYED ON THE EVENT.** `renewSession` returns
  `visitedOkta` — read off the CLICK, not off `stage`, because `authorize`/`none` mean clicked
  and `no-signin-control` does not, which is three strings to keep in step across two files
  for one boolean. The resident loop reads one `oktaTrip` flag at the TOP (the auto-login and
  the rehearsal both `continue`, so a check beside each call site is three chances to forget
  one) and `break`s into the existing reopen path.
- **WHY RECYCLE RATHER THAN LET THE GUARD HANDLE IT.** 2.3 GB trips nothing: it leaves
  ~6,500 MB free against a 4,000 MB floor, and the renewal COMPLETES, so there is no stall
  either. Across twenty ramps in five days **every one was followed by a new pid** — the
  memory has never once been seen coming back down in place — and nothing has ever run two
  renewals in one browser life, because the guard always killed it first. **Whether it
  accumulates hour on hour is UNKNOWN**, and the choice was between finding out at 3 a.m. and
  making the question moot.
- **THIS IS NOT THE AGE RECYCLE THAT WAS REMOVED, and the reason is the fact that killed it.**
  That one fired on a clock and came back `token source: live` — because `localStorage`
  survives a browser restart — so it landed in the same near-expiry cell and changed nothing.
  Here that same fact is what makes this SAFE: the freshly minted token survives the reopen,
  `planRenewal` stands down for 59 minutes, and the browser sits at its 200 MB baseline until
  the token lapses. One recycle per token lifetime, at the moment the allocation happened.
- **NOT GATED ON `RECYCLE_COOLDOWN_MS`, though it stamps it.** We KNOW two gigabytes were just
  allocated; standing down would leave them standing. Pacing comes from `planRenewal`'s floor
  (5m), gap (10m) and backoff instead.
- **AND IT MAY BEAR ON THE LOGIN.** The owner's sign-in "got hung up at password" and a later
  one sat on *"We are processing your request…"*. Okta's form is rendered **by the navigation
  that allocates the gigabytes**, so memory pressure is now a live alternative to the CAPTCHA
  reading — **both remain candidates, neither is established.** The discriminators already
  exist: `diagnose()` reads Okta's own error banner, `saveFailureShot` writes a picture (a
  challenge is visible in it), and the RAM trail carries the step, so a login that allocates
  shows up as a trail entry losing GB `@ auto-login`.
- `worker/keepwarm-recycle.test.mts`, **seven mutations, each asserting the mutation applied** —
  `visitedOkta` read off the stage, the early skip dropping the field, the flag set after the
  `continue`, the check moved below the setters, the check moved above the profile yield, the
  cooldown gating it, and `process.exit` instead of `break`.
  **One guard failed at baseline and the reason is the usual one**: it anchored on
  `maybeAutoLogin(ctx, page)`, which matches the function DEFINITION four hundred lines above
  the call site. It anchors on the awaited call now. **Thirteenth time.**

### A 25 GB RUNAWAY, FIVE RECYCLES, AND THE GUARD CLOSED THE WRONG BROWSER (2026-08-18)
**THE CONTAINMENT DOES NOT CONTAIN AN ORPHAN, AND THE BOX REACHED 94% COMMIT.** This is the
single most urgent thing open. It followed straight on from the spurious CI-triggered login
above, and the two together are one chain.
```
20:00:44  ⏰ hold releases in 1m … signing in       <- a CI test fixture (see below)
20:01:51  [keep-warm process restarts MID-LOGIN]    <- ORPHANS its Chromium
20:02:40  rc  5,118 MB  pid 13004 renderer  64% COMMIT   free 4,361 MB
20:06:45  rc 17,811 MB  pid 13004           83%          free   982 MB
20:12:52  rc 25,307 MB  pid 13004           94%          free   163 MB
20:14:51  rc    325 MB  pid  6772           15%          free 11,788 MB
```
- **THE SIZE GUARD FIRED FIVE TIMES AND FREED NOTHING**, and said so without anybody hearing:
  `RECYCLING` at 20:02:21, 20:11:57, 20:14:20, with `over the line, but a recycle is still
  cooling down` at 22,356 / 23,994 / 24,794 / 25,408 / 25,812 MB in between. **The reading went
  UP across every recycle.**
- **THE PID SETTLES IT, AND IT WAS ALREADY IN THE MEMORY SERIES.** `max_pid` is **13004 in
  every sample** from 20:02:40 to 20:12:52 — across three recycles. And at 20:02:40, one second
  after a browser opened at 20:02:39, pid 13004 was already **4,953 MB**: a renderer born that
  second cannot be five gigabytes. **So 13004 predates the reopen. It is an ORPHAN**, left by
  the keep-warm process restarting at 20:01:51.
- **`ctx.close()` IS NOT A KILL, AND THE GUARD MEASURES A FAMILY IT CANNOT ACT ON.**
  `rcFamilyMb()` totals every Chromium on the profile directory; the recycle closes only the
  context this process owns. An orphan is therefore **fully visible to the measurement and
  invisible to the remedy** — so the guard recycles a healthy browser, over and over, while
  reporting the corpse's memory as the reason. Fourth instance in this repo of a guard whose
  remedy does not reach the thing it measures.
- **AND A SECOND CHROMIUM RAN ON ONE `user-data-dir`** — the corruption case the profile lock
  exists to prevent. The lock did not stop it because an orphan holds no lock file: the dying
  process released it on the way out, and the new keep-warm took it and launched anyway.
- **THE RAM ARM COULD NOT HELP EITHER.** It needs a stall **and** low RAM, and the loop kept
  ticking the whole time — so at 163 MB free, one condition short, it never fired. The
  both-conditions rule is right for the case it was written for (the owner using their own
  desktop) and it has no answer for a healthy loop next to a dying box.
- **WHAT TO BUILD, and it is bot-side so the box must update.** The keep-warm must **kill any
  Chromium on `.rc-bot-profile` that it does not own, immediately AFTER TAKING THE PROFILE LOCK
  and before `launchPersistentContext`** — while COMMIT is still normal and a PowerShell spawn
  still works. That is `kill-chrome`'s existing `rc` mechanism (kill by `--user-data-dir`, no
  cooperation needed) moved to the one moment it is both necessary and cheap.
  - **THE LOCK IS WHAT MAKES THE SWEEP SAFE, AND "AT STARTUP" WITHOUT IT WOULD BE A DISASTER.**
    `rc-hold-runner.mjs` drives the SAME profile directory, so a blanket kill on process start
    can land at 08:00:00 on the Chromium that is carting. Once we hold the lock the runner does
    not, so anything still on that profile is by definition owned by nobody — which is exactly
    the orphan, and nothing else. (This corrects the first draft of this entry, which said
    "at STARTUP" flat and would have been followed literally.)
  - **Do NOT put the kill in the trip path**: spawning is exactly what fails as COMMIT passes
    ~95%, which is the instrument-goes-quiet-at-the-peak trap.
  - **Scope it with the negative lookahead `kill-chrome` already uses.** A pattern that matched
    `auto-cart-bot` broadly would take the rec.gov profiles with it — that regression is
    already recorded once.
  - A second, independent candidate: a catastrophic free-RAM floor (~800 MB) that acts with **no
    stall requirement**. It reverses a documented "BOTH CONDITIONS, ALWAYS" decision, so take it
    deliberately or not at all — and note it may not help, since exiting a process does not
    necessarily reap an orphan either.
- ~~**NOTHING HERE IS FIXED YET.**~~ **BUILT 2026-08-18 — `scripts/auto-cart-bot/orphan-sweep.mjs`,
  and it needs a box update like everything else bot-side.** The keep-warm kills any Chromium on
  `.rc-bot-profile` the moment it takes the lock, before `launchPersistentContext`.
  - **THE LOCK IS THE WHOLE SAFETY ARGUMENT, and "at startup" would have been an incident.**
    Once we hold the lock the runner does not, so anything still on that profile is owned by
    nobody — which is the orphan and nothing else. A sweep on plain process start could land
    at 08:00:00 on the Chromium that is carting.
  - **It also removes the `SURVIVED` ambiguity that has bitten `kill-chrome` twice.** That
    re-check runs 3s after the kill, long enough for a supervisor to have opened a NEW browser,
    so a clean kill plus a healthy restart printed the same words as a kill that reached
    nothing. Here nothing may open a browser on this profile while we hold the lock, so a
    survivor is unambiguously a survivor.
  - **THE HOLD RUNNER DELIBERATELY DOES NOT SWEEP**, and a test pins that so it is re-taken
    rather than drifted into. Spawning costs a second or two on the one path where latency is
    the product (measured carts: T+1.8s, T+43s, T+49s). The keep-warm reopens on every yield,
    guard trip and restart — including the restart that CREATES an orphan — so one is reaped
    within minutes anyway. If the runner ever needs it, the shape is a sweep on a FAILED
    launch, not a spawn before every cart.
  - **A blind scan under-kills and can never over-kill.** An unelevated WMI query reads `$null`
    for `CommandLine`, and an unreadable process cannot match the pattern — so the elevation
    problem that has corrupted three readings here is, for once, safe by construction. The
    count is still reported, because the reading is short.
  - **Silent on the ordinary path, loud when it kills or fails.** It runs many times an hour;
    a line per reopen would bury the events worth reading. `DONE` is required before any
    reading counts — an incomplete scan is never "found nothing".
  - **`rc-diag.mjs --real-profile` IS THE ONE PARTICIPANT THAT DOES NOT RESPECT THE LOCK**, so
    a restarted keep-warm will now KILL its browser rather than merely failing to launch beside
    it. That procedure already requires stopping the bots AND disabling the watchdog; the
    script's header now says so where somebody will read it. `rc-probe.mjs` is unaffected — it
    uses `.rc-probe-profile`, which the pattern cannot match.
  - `worker/orphan-sweep.test.mts`, **nine mutations, each asserting the mutation applied** —
    the sweep before the lock, after the launch, deleted, a survivor counted as killed, `DONE`
    not required, the sleep made unconditional, the quiet path made chatty, the failure path
    silenced, and the runner starting to sweep.
  - **AND THE EXISTING ATTRIBUTION GUARD PASSED VACUOUSLY AT FIRST — FOURTEENTH TIME.**
    `chromium-attribution.test.mts` was given the new file to scan and its line regex matched
    nothing in it, so the suite went green against a pattern deliberately broken to `[^"]*`
    (verified). Its `checked >= 3` floor was already satisfied by the `.ps1` files alone.
    It now matches a JS `export const` assignment too, and asserts **per file** that a pattern
    was actually extracted — a guard that inspects nothing is indistinguishable from one that
    approves.

### `npm test` MADE THE PRODUCTION BOT SIGN IN TO RC (2026-08-18) — CI does it on every PR
The 2026-08-15 entry above records `npm test` telling the bot to cart a real campsite, fixed
with **non-numeric sentinel unit ids**. That protected the CART. **Nothing protected the
LOGIN**, and the same fixtures fire an unattended sign-in. Caught by causing it — while a
`npm run verify` was in flight, the mini-PC's keep-warm read a real `nextRelease` a minute
away and did exactly what it is built to do:
```
20:00:44 ⏰ hold releases in 1m and the session will not cover it — signing in (attempt 1 of 2)
20:00:49     → signed in, but the token will not cover the hold — dropping it to sign in fresh
20:02:21 ✗ RC Chromium at 4037 MB (limit 1500) — RECYCLING the browser.
20:02:21   JS heap 5 MB … only 0% of 4037 MB, so it is NOT the JS heap
[the keep-warm process then restarted MID-LOGIN]
```
- **That is a real unattended sign-in from the household address** — the act that cost twelve
  hours of IP block on 2026-08-06 and is rationed to two attempts per release for that reason
  — **plus a 4 GB Okta ramp that killed the browser mid-login.** Fired by CI, on every PR.
- **`holdAtRisk` IS THE SHARPER HALF: it is the ALARM'S TRIGGER.** A fixture releasing in one
  minute against a dead RC session **rings the owner's phone, twice, forty-five seconds
  apart.** Nobody had noticed because the session happened to be healthy.
- **IT EXPLAINS THE PROFILE CHURN IN THE SAME WINDOW** — four `→ hold runner wants the
  profile` in twenty minutes, which is the 2026-08-15 starvation signature recurring, and it
  is what makes an unrelated test run able to disturb an 08:00 cart.
- **AND IT EXPLAINS THE INTERMITTENCY** that nearly got written up as a feed bug: the log
  alternates `the token covers this hold` with `no hold is queued` because fixtures exist for
  the ~2 minutes of a test run and the keep-warm polls every 60s. **I had already queried the
  table, found zero non-terminal holds, and was one paragraph into calling `maybeAutoLogin`
  spurious.** The rows had simply been swept between the two queries.
- **FIXED with `REAL_UNIT` (`unit_id ~ '^[0-9]+$'`) on `nextHoldRelease` AND `holdAtRisk`.**
  It reuses the safety property that already exists instead of a second marker to keep in
  step, and it is server-side, so it reaches the box on a push with no bot update.
- **NOT APPLIED TO `dueHolds`, DELIBERATELY.** The hold suites exist to test `dueHolds`;
  filtering fixtures out of it would gut the tests that make this table safe at all. What it
  costs is profile churn against a sentinel that cannot cart — bounded, understood, and a
  separate decision from an unattended login and a phone call.
- `worker/hold-fixture-invisibility.test.mts` is **real-DB**, because the fix is one predicate
  inside two SQL statements and a test asserting a copy would assert the copy. Three
  mutations, each verified applied: the filter dropped from either query, and the regex made
  over-broad — **that last one is the dangerous direction**, since an `AND false` would pass
  both negative tests and silently switch off the whole auto-cart morning.
  - **The positive test needs a NUMERIC id, which is the thing that must never exist.** It is
    inserted straight to `carted` (never through `requested`, so `dueHolds` never sees it),
    is seconds old so `expireStaleHolds` cannot list it, is not `claiming` so `pendingClaims`
    cannot, and uses **`0`** — one digit, under `hold-fixture-safety`'s two-digit floor, so
    that guard needed no exemption carved into it. The id being implausible is listed THIRD
    on purpose; "vanishingly unlikely" is the reasoning this file has been burned by.

### OUR OWN LIVENESS CHECK KEEPS THE OKTA SESSION ALIVE — MEASURED, 12 FOR 12 (2026-08-18)
`checkAndReport` calls `oktaSessionAlive(ctx)` **unconditionally**, every keepalive tick and
every renewal. Off the box's own log, twelve consecutive readings across three hours:
```
checked 17:07:02  exp 2026-08-19T05:07:02   → +12.0000h
checked 17:27:02  exp 2026-08-19T05:27:02   → +12.0000h
   … ten more, every one +12.0000h from the moment it was CHECKED …
checked 19:50:40  exp 2026-08-19T07:50:40   → +12.0000h
```
- **A fixed 12h from creation would print the same instant every time. It does not.** The
  window moves with the clock, to the second, twelve for twelve. So the Okta session's expiry
  is a rolling idle timeout **that our own polling resets**, and it cannot idle out while the
  keep-warm is running.
- **SO THE "~12 HOUR OKTA SESSION" FIGURE THROUGHOUT THIS FILE IS OUR PROBE'S WINDOW, NOT
  RC'S.** Nobody has ever observed how long an unrefreshed one lives. Same family as the "~8
  hour session cap" that turned out to measure when we happened to look (2026-08-08).
- **WHICH SPECIFIC REQUEST REFRESHES IT IS NOT ESTABLISHED.** `/api/v1/sessions/me` is the
  leading candidate — `renewSession`'s own guard already asserts it — but every check also
  loads RC pages carrying the cookie. Do not write one in as fact.
- **THE RENEWAL'S CAREFUL GUARD IS NULLIFIED BY A SIBLING.** It skips the Okta probe when
  there is no token to lose, and says why in as many words: *"asking on every attempt would
  extend the very window we are trying to measure the length of."* `checkAndReport` then asks
  every twenty minutes regardless. The reasoning is right and the file next door defeats it —
  the recurring shape here, this time with the guard and its defeater in one process.
- **IT IS LOAD-BEARING BY ACCIDENT, AND THAT IS THE PART TO BE CAREFUL WITH.** A session that
  never idles out is why this bot can go days without typing a password. **Anyone who
  "corrects" the unconditional probe to match the renewal's guard will start the Okta session
  expiring and force real logins from an address that has eaten a 12-hour block.** Do not
  tidy it up; if it is ever changed, change it deliberately and expect more sign-ins.
- **AND IT IS WHY THE REHEARSAL KEEPS PROVING NOTHING.** `runLoginRehearsal` drops the token,
  reloads, and requires RC to REJECT the session before it will type a password. With Okta
  permanently fresh, the sign-in click is answered from the cookie with no form — which is
  `provedNothing`, correctly reported as inconclusive. Its one lifetime PASS (2026-08-16
  03:00) read `Session before the test: DEAD — RC rejected the token (401)` and `cleared 0
  key(s)`: a profile that was already genuinely empty. **The instrument is not broken; it is
  being handed a condition in which there is nothing to prove.**
  - **NOT "structurally impossible" — 2026-08-18 19:13 reached `attemptLogin` and FAILED for
    real** with Okta alive on the adjacent line. So a live Okta cookie makes an inconclusive
    run likely, not certain, and the distinction is worth keeping.
- **TWO CANDIDATE FIXES, NEITHER BUILT, and they are not equal.**
  1. **Force the form with `prompt=login`.** Intercept RC's own `/oauth2/v1/authorize` request
    with `page.route` and add the one parameter; RC's SPA still builds the client id, redirect
    URI and PKCE verifier, so nothing about the flow has to be owned here. **Non-destructive**
    — no cookie is deleted, so a failed rehearsal costs a live session nothing. Unverified:
    Okta may not honour it, and the callback may not survive.
  2. **Snapshot and delete the `idx` cookie**, attempt the password, restore on failure — the
    same shape as `dropStoredToken`'s snapshot. Certain to work and **destructive**: a
    rehearsal that discovers a broken password does so by ending the session it was testing.
    Arguably right (12h of warning beats finding out at 07:45) but it is a real cost.
  **`DT` MUST SURVIVE EITHER WAY.** It is the device cookie, and losing it makes a sign-in
  look like a fresh profile — which is what cost the household IP twelve hours on 2026-08-06.
- **BUILT 2026-08-18: the FIRST one** (`scripts/auto-cart-bot/force-login-prompt.mjs`). The
  rehearsal wraps `attemptLogin` in `withForcedLoginPrompt`, which intercepts RC's own
  `/oauth2/v1/authorize` and adds `prompt=login`. RC's SPA still builds the client id, redirect
  URI, `state` and the PKCE challenge; we add one query parameter to a request it already got
  right. **Bot-side — it needs a box update.**
  - **A 302, NOT `route.continue({ url })`.** Overriding a navigation request's URL has
    version-dependent semantics in Playwright; a redirect is something the browser does every
    day, and it re-enters the handler with the parameter already present, where the
    already-forced guard passes it through. Bounded at `MAX_REWRITES` (3) so a loop cannot hang
    the browser.
  - **THE HAZARD IS THE LEAK, AND IT IS WHY THIS IS A MODULE.** The rehearsal runs on the
    RESIDENT page. A route left installed would rewrite EVERY later authorize — including the
    silent re-mints that appear to be keeping the session alive on their own — turning a free
    background renewal into an unattended login that cannot succeed, hourly, from an address
    that has been blocked before. Disarmed TWO independent ways: a `finally` that calls
    `page.unroute`, and an `armed` flag the handler checks first, so a leaked route is inert
    even if `unroute` throws. **The flag is the half that does not depend on Playwright.**
  - **THE REHEARSAL ONLY, NEVER `maybeAutoLogin`** — that runs at T−30 of a real release and is
    the only thing between a queued hold and a missed cart. An unproven parameter in front of it
    would risk a campsite to improve a dashboard. Pinned by a test asserting exactly ONE call
    site.
  - **IT REPORTS WHETHER IT ACTUALLY ASKED.** `rewrites === 0` means the interception never
    fired, which is a different fault from Okta ignoring the parameter — and without the count
    the two produce the identical inconclusive run. A `provedNothing` WITH rewrites > 0 is
    recorded as *"Okta declined to re-prompt; forcing the form this way does not work"*, which
    is what would retire this approach in favour of the destructive cookie drop.
  - **The downside is bounded by the status quo:** nothing is deleted, so a failed rehearsal
    costs a live session nothing, and if Okta declines we land back on `provedNothing` — which
    is exactly where we already are. That is why it goes first.
  - `worker/force-login-prompt.test.mts`, **nine mutations, each verified applied.** Two of its
    own guards were wrong at baseline and **both anchored on a token that occurs twice** —
    `rewrites > 0` appears in the log line and in the detail line, so replacing either
    condition with a constant left the other matching. Anchored on `log(rewrites > 0` and
    `const detail = rewrites > 0` now. **Fifteenth and sixteenth time.**
  - **AND TWO EXISTING GUARDS BROKE OVER UNCHANGED BEHAVIOUR.** `rehearsal.test.mts` pinned
    `provedNothing[\s\S]{0,220}result: 'inconclusive'` — a PROXIMITY window, which a new comment
    pushed past. Re-anchored on the `if (r.provedNothing)` BLOCK, not widened; verified still
    failing when that branch is made to return `'ok'`. **The first re-anchor was itself wrong**
    — `if (r.provedNothing) {` also appears in `maybeAutoLogin`, earlier in the file, so a bare
    `indexOf` landed there and failed against correct code. Scope to the function first.

### THE LOGIN IS THE OPEN RISK, NOT THE LEAK (2026-08-18)
- **THE OWNER RAN THE LOGIN BY HAND AND IT "GOT HUNG UP AT PASSWORD".** That is a signature,
  not a vague symptom: a WRONG password is REJECTED (Okta shows a banner, `diagnose` reports
  `badCreds`). Hanging instead matches the 2026-08-06 reCAPTCHA, where the control reports
  `enabled=true` and every click times out because the challenge overlay swallows pointer
  events. **Retrying harder can never work**, and a CAPTCHA is a deliberate full stop for the
  unattended path.
- **So expect `maybeAutoLogin` at T−30 to fail as well** — it runs the same `attemptLogin`.
  This ALSO revises the 08-18 03:01 write-up above: that rehearsal failure was attributed to
  our own restart timing, and a real login fault is now the likelier explanation.
- **`rc_login_rehearsal` KEEPS NO HISTORY.** It is ONE ROW, updated in place (`id 1`), so the
  03:01 failure detail was overwritten by the next skip and is gone. The instrument built to
  catch exactly this cannot show a trend, and a failure survives only until the next stand-down.
  Fix it before trusting it.
- Overnight the session died completely — `okta=GONE(404)` after ~12h — so the renewal path is
  skipped entirely (`no Okta session to renew against`) and only a real sign-in can recover it.
- **OUR OWN CONTAINMENT TURNED THE DASHBOARD RED.** The supervisor restarted the process and
  the login rehearsal fired **24 seconds later**, against a browser that had just come up on a
  box recovering from 71% COMMIT. RC answered *"We're having trouble loading the
  application"*, and `autocart.rc_login` went **FAIL — "1 hold(s) ahead will fail unless a
  human signs in"**, with a real hold twelve hours out. The session was healthy again minutes
  later. Two fixes, because they are different faults:
  1. **A quiet window after an abnormal exit.** The bail writes `.camphawk-abnormal-exit`; the
     rehearsal stands down for `REHEARSAL_QUIET_AFTER_RESTART_MIN` (5). A FILE, because the
     process that knows does not survive to tell the process that needs to know. **`null` is
     "no record" and never gates** — a missing marker is the ordinary case.
  2. **RC's app failing to load is INCONCLUSIVE, not a broken login.** There is no sign-in
     link on a page that never rendered, so the hunt fails and reports the login broken. That
     is the banner trap and `provedNothing` again: an absent form means "we could not ask".
     It returns `provedNothing` now and stays LOUD in the log — it is also the 2026-08-14
     blank-page signature — but it no longer spends the once-per-20h budget or send anybody
     to the box.
- **TWO EXISTING GUARDS IN `rc-live-not-dead.test.mts` BROKE AND WERE UPDATED, NOT RELAXED** —
  they pinned `reason: await withBanner(link` by exact expression, and hoisting it into a
  `const` invalidated them over unchanged behaviour. **The first rewrite then WEAKENED one:**
  bounding the live branch at the first `withBanner(` means folding a banner INTO that branch
  merely shortens the slice, and the mutation passed. Verified failing, re-bounded on the
  `if (stillLive === true)` block, verified again. Eleventh time a guard here has anchored on
  the wrong thing.
- `worker/keepwarm-diagnosis.test.mts`, **13 mutations, each asserting the mutation applied.**
  **One survived and the reason is the lesson:** the mutation meant to delete the snapshot call
  left the identifier in place, so the regex still matched and the guard passed against code
  that still called it. A mutation that does not apply is a green proving nothing — the same
  discipline that has to be re-learned every time it is skipped.
  - **`envDefault` MISREAD A THRESHOLD FOR THE SECOND TIME IN ONE SESSION.** It was written
    hours earlier to stop `(\d+)` stopping at the underscore in `60_000`; its replacement then
    stopped at the SPACE in `40 * 60_000`, reading `MAX_BROWSER_AGE_MS` as **40 ms**. It now
    parses products. Tenth time a guard here has anchored on the wrong thing, and the second
    time inside the fix for the ninth.
- `worker/keepwarm-recycle.test.mts`, **8 mutations, each asserting the mutation applied** —
  including the guard moved back into the loop body, the stall condition dropped, the timer
  slowed back to 2 minutes, and a throttling flag restored. **Two of its own assertions were
  wrong at baseline and one PASSED FOR THE WRONG REASON:** a bare `(\d+)` stops at the
  underscore in `60_000`, so `MEM_STALL_MS` read as **60** and `WATCHDOG_MS` as **10** — and
  10 sails under a 15,000 ms ceiling. A guard that reads the wrong number will approve the
  wrong value later, silently. Ninth time a guard here has anchored on the wrong thing.

### THE UPDATER DIED INSIDE ITS OWN `stop-all` — a JOB OBJECT, fixed and PROVEN (2026-08-20)
"Update now" was pressed twice and landed neither time. **Not slowness — the updater was
killed partway through the stop it was performing**, and both logs have the identical shape:

```
09:16:36 [auto-update] updating b9a1dba -> 940acf7      09:36:37 updating b9a1dba -> 940acf7
09:16:37 [stop-all] stopping 26 process(es).            09:36:37 [stop-all] stopping 24 …
09:16:40   stopping node.exe pid 10732 (payload)  <-|   09:36:38   stopping node.exe 11924 <-|
          (nothing, ever)                                        (nothing, ever)
```
Fourteen of twenty-six stop lines, then sixteen of twenty-four, **both ending on a `node.exe`
kill**. No `git reset`, no restart, no rollback, no refusal. The watchdog then found nothing
running and restarted everything **on the OLD checkout**, so every health check read green
over a box that would not update — which is why this looked like "the update button is slow"
for most of a day.
- **THE OLD REASONING WAS THE DEFECT, AND HALF OF IT IS STILL TRUE.** `control-channel.mjs`
  argued its child was safe because (a) *"killing a parent on Windows does NOT kill its
  children"* and (b) `stop-all` matches the bot's own scripts, which `auto-update.ps1` is not.
  **(b) HOLDS** — `$CHILDREN` is `supervise.ps1|bot.mjs|broker.mjs|rc-keepwarm.mjs|
  rc-hold-runner.mjs|npm start|npm run broker|cloudflared` and the updater matches none of it;
  a test pins that so nobody "fixes" this by adding the updater to the kill list, which would
  make it kill itself deliberately rather than by accident. **(a) IS FALSE for a libuv-spawned
  child**: on Windows `uv_spawn` puts every non-detached child in the parent's **Job Object**,
  and the ancestry is `cmd.exe (npm start) → node.exe (bot.mjs) → powershell.exe
  (auto-update.ps1)`.
- **WINDOWS STARTS IT NOW.** `schtasks /Run` against the task `install-autoupdate.bat` already
  registers. Not a new mechanism — it fires every five minutes and is how every unattended
  update has ever landed. A process the Task Scheduler service starts is **not our descendant
  and is in no job object of ours**, so it survives by construction rather than by an argument
  about process trees.
- **NOT `detached: true`**, which is the textbook answer. It was tried on 2026-08-11 and
  produced literally nothing — no output, no error, no `auto-update.log` — while the same
  command by hand ran fine. Reaching for it again swaps a measured failure for an unmeasured one.
- **AND THE CLAIM BLOCKED THE RECOVERY.** The poller claimed before spawning, so the claim was
  held by a process the update was about to kill and sat there for its full 20-minute TTL —
  during which the Scheduled Task, **the one launcher that survives a stop-all**, refused
  ITSELF with `SKIP - another process holds the update claim` at 09:21, 09:26, 09:31, 09:41,
  09:46 and 09:51. The poller no longer claims; `update-guard.mjs` claims inside the updater,
  which is the process that actually moves the checkout.
- **PROVEN 2026-08-20 19:42:49 → 19:46:27 — `b7015c7` → `58cc767`, `updated and verified`, in
  3m38s unattended, through the full path including `stop-all`.** An earlier run the same
  afternoon reached `PROCEED` and then `already current at b7015c7`, which proved the trigger
  fires and proved **nothing** about the stop — record the 19:46 run as the evidence, not that one.
- **A PENDING REQUEST CHURNS THE BOX**: `UPDATE_RETRY_MS` is 15 min against a 20-min claim TTL,
  so a request that never lands re-spawns the updater indefinitely and each attempt bounces
  every process. Withdraw it (`requested_at = NULL`) rather than leaving it set, and never
  mark it applied — that asserts something untrue.

### `loadEnv` RESOLVED RELATIVE TO THE CALLER, AND A 401 READ AS A BAD TOKEN (2026-08-20)
`load-env.mjs`'s own header records the failure it exists to prevent — `rc-hold-runner.mjs`
answering `feed 401` for want of an environment, *"which reads exactly like a wrong token"*.
**It reappeared one directory deeper, inside the fix.** `mini-pc/report-applied.mjs` called
`loadEnv(import.meta.url)`, which resolves `mini-pc/.env` — a file that does not exist, because
the `.env` is one level up — and **returned SILENTLY**. So `AUTOCART_TOKEN` was absent, the POST
was answered 401, and it printed `server said 401`.
- **`bot_update_requests.applied_sha` therefore stopped moving on 2026-08-19** and still read
  `746cd5a` after two SUCCESSFUL manual updates on 08-20. **It misled this session for most of a
  day** — that sha was read while diagnosing why an update had not landed, and it was describing
  neither the box nor the attempt. `git-status` through `bot_commands` remains the authority.
- Exactly one caller was affected; every other is a sibling of the `.env`. **The silent return is
  the systemic half** and is what turned a one-line path bug into a day.
- The fallback is **BOUNDED to two candidates** (the caller's directory, then this module's).
  Walking up would eventually find an unrelated `.env` at the repo root and load it without
  saying so, and wrong values are harder to spot than absent ones.
- `loadEnv` **returns the file it read**, so a 401 now distinguishes `AUTOCART_TOKEN is NOT SET,
  .env read: NONE FOUND` from `came from the file and the server rejected it`. `envSource` was
  written for exactly this on 2026-08-07 and nothing was calling it.
- **`auto-update.ps1`'s own PowerShell reporter was never affected** — it has `Import-BotEnv`.
  So the scheduled/admin path reported correctly all along and only `update.bat` 401'd, which is
  why the field looked plausible rather than obviously dead.

### THE IN-APP OKTA FILL: REACT'S `_valueTracker` (2026-08-20)
Reported as *"it said can't leave blank even though it was filled in already as if we entered
it"*. The `client_reports` trace of hold 4734 agrees exactly: `email` → `password` → `submitted`
→ `login-result {ok:false, reason:"We found some errors…"}`, with the DOM read-back
(`user.value !== email`) passing throughout.
- **React keeps a `_valueTracker` per input and SUPPRESSES the change event when handed a value
  equal to the one it already tracks.** iOS keychain autofill had put the address there first, so
  the node was right and the widget's model was empty — which is what "filled in but says blank"
  means from the other end. `chSetValue` resets the tracker before writing, and BLURS afterwards
  because Okta validates required fields on blur.
- A second candidate — submitting in the same synchronous block, so a batched framework handles it
  while its model still holds the old value — produces an identical symptom and the trace cannot
  separate them, so both are fixed (`chSettle()` before each submit).
- **THAT SECOND ONE IS PINNED STRUCTURALLY ON PURPOSE.** A behavioural test built on the stub
  **PASSED with the settle removed**: the stub models the tracker rule (documented, synchronous)
  and NOT batching, so it was measuring the tracker fix twice and reporting it as two guards.
  A structural assertion that admits what it is beats a behavioural one that proves something else.
- **NO READ-BACK ON THE PASSWORD.** Comparing `pw.value` to the password puts the secret in an
  expression, and an engine quoting a failing expression is precisely how a real password reached
  the database on 2026-08-16.
- **THE STUB HAD NO TIMERS.** `vm.createContext({})` has no `setTimeout`, so every path past
  `chWait`'s first poll threw and was swallowed; the older stub tests passed because they only
  assert that SOME verdict was reported — i.e. they were proving the error path.
- **AND A NUL REACHED THE SERVED BUNDLE while writing this.** An intended space came through as
  `\x00`; `tsc` passed, every test passed, and it would have gone to every webview. The emitted
  bundle now gets the same no-control-characters rule the `.ps1` files have.

### "PLATFORM NOT REPORTED" WAS THE TRIM, NOT A MISSING FEATURE (migration 064, 2026-08-20)
The hand-off readout has printed that on **every hand-off it has ever summarised**, and it was
read as the feature being unbuilt. `ClaimFlow.notePlatform` has emitted a `platform` report from
six call sites all along — `recordClientReports` keeps the **TAIL** of 40, the platform is
reported **once, first**, so it sat at the head of exactly the region that gets discarded.
Measured on hold 4734: 40 reports stored, earliest survivor `session {n:2}`.
- **Same trimming that ate `✓ Added to cart` off the front of both 2026-08-13 hand-offs.**
- Migration 064 gives it columns. **`COALESCE`**, because a hand-off flushes several times on a
  debounce and only the first carries the platform. A non-string is stored as **NULL, never
  coerced** — anything with the manage token can post this, and `[object Object]` reaching a
  column is the shape that switched off the memory series for ten minutes.
- Not a bigger cap (buys one more run) and not a special case inside the trimming SQL (that
  statement must stay simple enough to reason about at 08:00).

### THE AUTO-LOGIN WAS THE BIGGEST OKTA TRIP NOBODY HAD MEASURED (2026-08-20)
```
07:29  12%   rc   300 MB  pid 6360    flat
07:31  64%   rc 2,811 MB  pid 6452    the auto-login's Okta navigation
07:41  76%   rc 9,434 MB  pid 6452
07:43  12%   rc   230 MB  pid 7560    the RAM guard killed it
```
Twelve minutes and **9.4 GB** — four times the worst renewal and six times as long, because
`okta=GONE` forces a full password sign-in. That variant needs a genuinely dead Okta session to
reach, which is why it had never been sampled.
- **It matters more here than for the renewal**: a guard kill leaves the profile lock reading as
  HELD for `STALE_MS` (10 min) and only a living holder renews it, so nothing can preempt it
  cooperatively. **A kill at 07:33 clears by 07:43 and is harmless; a kill at 07:53 holds the lock
  past 08:00 and the runner cannot take the profile to cart.**
- The trip now runs in a **throwaway tab** closed in a `finally`, as PR #142 did for the renewal.
  **Every page-taking call is bound to the tab** — `window.__camphawkRcToken` is per-page, the tab
  sits on `signin.reservecalifornia.com` during a sign-in, and a screenshot of the resident page
  photographs a page on which nothing happened. A version that moved only `attemptLogin` looks
  right and gets all three wrong.
- **NOT CLAIMED: that a tab close reclaims a NINE-gigabyte trip.** The renewal's trips are
  140-350 MB and drain in place on an unchanged pid; nothing has closed a tab that ramped this
  far, and the 08-20 event put 1,330 MB in a **`utility`** process, which is not the renderer.
  **HOW TO READ IT: a spike that drains at tab close with no `♻ recycling` line is this working.**
  **STILL UNEXECUTED as of 2026-08-20** — it only runs at T−30 of a real release.

#### PERSISTING THE LOGIN BUDGET NAIVELY WOULD HAVE MADE THAT MORNING WORSE
The per-release budget was module state, and `supervise.ps1` restarts the process on exit, so
every restart re-issued it — the crash-loop-spends-the-login-budget shape that cost the IP twelve
hours on 08-06. **And that accidental refund is what saved the 08:00 cart:**
```
07:30  attempt 1 -> 9.4 GB ramp -> the RAM guard killed the browser
07:43  the supervisor restarted the process
07:48  attempt 2 -> signed in, 60m token
08:00  carted at T+2s, claimed 08:05, released
```
A plain persisted counter would have counted attempt 1 and left one attempt of margin instead of
two, on the one morning any of this was measured. So a **KILLED** attempt is inconclusive and is
refunded — same rule as `provedNothing` — but **by the record** (`startedAt`, cleared on every
terminal path) rather than by the accident of process memory, and bounded to **one per release**
by `killed`, or a process that dies every attempt refunds for ever. The rule is a module
(`autologin-budget.mjs`) because importing `rc-keepwarm.mjs` starts the keep-warm loop and this
decision has an arm that only runs after a crash.

### `worker-deploy.yml`'s PATH LIST HAD DRIFTED FROM WHAT THE WORKER IMPORTS (2026-08-20)
`worker/poller.ts` imports `src/lib/limits.ts` (`RC_HOLD_CAPACITY`) and `src/lib/auth.ts`
(`hasAutocartEntitlement`, one definition with six enforcers, two inside the poller), plus
`rc-holds.ts`, `rc-holds-notify.ts` and `types.ts` — **and none of them triggered a worker
deploy**. A change to any ships to Vercel and not to Fly, so the site and the poller disagree with
nothing red anywhere: the deploy-by-different-routes trap that opened the T−30/T−25 alarm hole.
- **IT HAD NEVER BITTEN, AND THAT IS LUCK.** Every previous change to those files (#86, #89, #91,
  #125, #138) also landed a `worker/*.test.mts`, which matches `worker/**` and fired the deploy as
  a side effect. **The house habit of shipping a guard beside every change has been silently doing
  the deploy list's job.** The first push to escape it was #145 — a comment-only edit to
  `limits.ts` with no worker file beside it.
- Fixed by DERIVING the list: `worker/worker-deploy-paths.test.mts` walks the worker's real
  **transitive** import closure. Transitive because a direct-only walk passes today and stops
  covering the moment a worker file reaches something through a re-export.
- **OPEN AS PR #146** at the end of 2026-08-20 — merging it restarts both poller machines (the
  workflow is in its own path list, deliberately), so it wants a moment away from a release.

### THE OKTA SESSION'S STATE IS A COLUMN NOW (migration 065, 2026-08-21)
`autocart.rc_session` answers "does RC accept the current token". The OKTA session behind it is
a different fact and it is the one that decides what the next sign-in **costs**:

    okta=ALIVE   answered from the idx cookie   11 seconds,     +24 MB   (2026-08-21)
    okta=GONE    full password form             12 minutes,  +9,434 MB   (2026-08-20)

- **IT WAS ALREADY BEING PRODUCED AND THROWN AWAY.** `checkAndReport` has held the structured
  reading from `oktaSessionAlive` all along, stringified it into `okta=ALIVE (exp …)` and posted
  only the sentence — so the server would have had to un-parse our own prose to recover a value
  the bot already had. Same shape as `notePlatform` emitting a fact into a region that then
  discarded it (064).
- **A COOKIE-ANSWERED SIGN-IN REUSES THE EXISTING OKTA SESSION AND INHERITS ITS CAP.** It does
  not restart the clock. This answers the 2026-08-19 absolute-cap entry from the other side:
  ```
  14:30:06  ✓ signed in — token now 60m          <- 4s, no form: answered from the cookie
  14:42:33  okta=ALIVE (exp 2026-08-21T14:47:57) <- 5m ahead, NOT the rolling +12h
  15:00:32  okta=GONE(404)
  ```
  **"The bot signed in at T−30" therefore does NOT mean "Okta is good for twelve hours."** That
  morning it meant eighteen minutes.
- **NOTHING HERE MAY GO RED, and that is structural rather than a promise.** `oktaCostNote`
  returns `string | null` and has **no severity to return**, so no later edit can promote a cost
  prediction into a verdict. `okta=GONE` is the ORDINARY state between releases and reddening it
  is the cry-wolf failure fixed three times, most expensively at 07:33 on 08-16.
- **NULL IS "NOT REPORTED", NEVER "GONE"** — a pre-065 box sends no okta fields and must produce
  SILENCE, not a claim about a machine that has said nothing. A probe that ran and could not tell
  reports `UNKNOWN`.
- **`undefined` LEAVES THE STORED READING ALONE; `null` OVERWRITES IT.** Three of six
  `reportSession` callers never ask Okta anything, and writing NULL from them would erase a
  reading `checkAndReport` took moments earlier. **Deliberately NOT COALESCE** — Okta state went
  ALIVE-with-5-minutes to GONE inside twenty, so a preserved old value is *actively misleading*
  in a way a stale `bot_commit` merely looks current. `okta_checked_at` carries the age instead.
- An unparseable expiry becomes NULL rather than reaching `::timestamptz`, which throws — and
  that statement also carries the session verdict, so a malformed diagnostic field would have
  destroyed the reading it rides along with.
- **PROVEN END TO END 2026-08-21**, write half and read half:
  `— Okta good for 720m (checked 20s ago), so a repair would be the cheap cookie-answered one`.
- `worker/okta-state-reporting.test.mts`, 16 tests, twelve mutations. **Two of its own guards
  were wrong at baseline**: a bare `/reportSession\(/` matched the DEFINITION (eighteenth time),
  and the SELECT guard sliced 700 chars back from the `FROM` and read the **TypeScript row type**
  above the query — passing against a route with all three columns removed (nineteenth).

### THE EXPENSIVE SIGN-IN WAS PINNED TO THE RELEASE-CRITICAL WINDOW (2026-08-21)
`maybeAutoLogin` acts ONLY inside `AUTOLOGIN_LEAD_MIN` (30m), so the 12-minute / 9.4 GB password
variant could happen **at no other time**. That is dangerous for a measured reason: a RAM-guard
kill leaves the profile lock reading HELD for `STALE_MS` (10 min) with nothing alive to renew or
release it — **a kill at 07:33 clears by 07:43 and is harmless; a kill at 07:53 holds the lock
past 08:00 and the runner cannot take the profile to cart.** On 08-20 the cart survived only
because `supervise.ps1` happened to restart the process in time.
- **`scripts/auto-cart-bot/autologin-warmup.mjs`** signs in at **T−3h** when a hold is queued and
  Okta is GONE, so the T−30 sign-in is cookie-answered.
- **IT DOES NOT ADD A PASSWORD SIGN-IN, IT MOVES ONE.** It fires only when the T−30 login was
  going to be a password form anyway; afterwards no credential is submitted at all. Net password
  submissions per release: **one, exactly as today.** That matters — repeated logins from this
  address cost the household IP twelve hours on 08-06.
- The token's ~60-minute life is not an objection: the warm-up **cannot** cover the release
  (`L ≤ 45` arithmetic) and is not trying to. Its whole product is the OKTA SESSION left behind.
- **UNKNOWN STANDS DOWN.** Acting would submit a password on a guess. The failure direction is
  always "we did nothing", which is the status quo.
- **THE WINDOWS ARE DISJOINT BY CONSTRUCTION**, boundary to the release-critical caller (`<=`,
  not `<`) — two sign-in drivers on one Chromium profile is worse than either. `maybeAutoLogin`
  is still called FIRST anyway, so a later edit breaking that disjointness fails safe.
- **THREE HOURS IS BOUNDED FROM BOTH SIDES.** Far enough that a guard kill (10 min) and a
  supervisor restart (seconds) are free; near enough that the Okta session survives to T−30,
  because the absolute cap's origin is **NOT established**. **Do NOT raise it to "the night
  before" without measuring that cap** — that is the version that looks obviously better and is
  the one the single cap observation says may quietly stop working.
- The probe is gated on the window (`warmupWindowOpen`, ONE definition, called by both), or a
  second unconditional `/api/v1/sessions/me` per tick doubles our traffic to that endpoint.
- Its ration is **its own file** — not a field on the auto-login budget, whose kill-refund
  arithmetic is release-critical and was got wrong once. Persisted, because the RAM guard killing
  *this exact navigation* is what causes the restarts that would re-issue it. **No kill refund**:
  a killed warm-up leaves the auto-login's full budget intact, so forgiving it buys a second
  password submission for no change in outcome.
- `worker/autologin-warmup.test.mts`, 18 tests, eight mutations; disjointness checked
  **exhaustively over every minute**, not sampled. **An existing guard broke over unchanged
  behaviour** — `session-coverage.test.mts` sliced from the FIRST `const r = await attemptLogin(`
  in the file, which was `maybeAutoLogin`'s only by luck of ordering, and a second caller above
  it made it read a different function. Twentieth time.

### THE LEAK — WHERE IT ACTUALLY STANDS (2026-08-22)
**Read this before building anything memory-related. Nothing shipped so far is a cure.** The size
guard, the RAM arm, the heap trail, the post-Okta recycle, the orphan sweep, the throwaway tab and
now the warm-up are containment or **relocation**. The owner's standing ask is to fix it.

**ESTABLISHED.** The ramp is triggered by the **Okta navigation** — a controlled comparison, not a
correlation (08-18: three token-less renewals ten minutes apart; only the one that clicked through
cost anything, 2,331 MB, against two that ran the identical clear/reload/prime for nothing). It
lands in the **renderer** (+1,237 MB) **and the browser process** (+545 MB), with GPU, utility and
crashpad flat.

**NEVER OBSERVED: what allocates.** "Network/IPC buffering" is written into three separate entries
as the leading explanation and **has never been tested**.

- **THE "JS HEAP IS FLAT" READING ELIMINATES FAR LESS THAN THIS FILE HAS ASSUMED (2026-08-22).**
  Measured locally against a real Chromium: **640 MB of `Uint8Array` in a page reports
  `JSHeapUsedSize` = 0.0 MB.** External memory — ArrayBuffers, decoded images, network buffers —
  is simply not in that number. So a flat heap trail rules out *ordinary JS retention* (an array
  nobody trims, our fetch wrapper holding `init`) and rules out **nothing else**. It has been
  treated here as eliminating the whole JavaScript-adjacent family; it does not, and the heap
  trail could never have seen this class of allocation at all.
- **TRACK A — NAME IT. BUILT, PR #155, NOT YET ON THE BOX.**
  `scripts/auto-cart-bot/rc-native-sampler.mjs` uses CDP's native sampling profiler. **Verified
  before it was written**: the same 640 MB came back attributed to
  `partition_alloc::PartitionRoot::Alloc<>() <- ArrayBufferAllocator::Allocate()` with 2% error,
  in a few kilobytes — the response scales with DISTINCT STACKS, not bytes, which is the opposite
  shape from the multi-GB snapshot the house rules forbid.
  - Sampling starts **on the tab**, at creation (per-renderer; the trip runs in the throwaway
    tab, so starting it on the resident page profiles a renderer where nothing happens), and is
    **read after the trip returns** — CDP goes quiet as a ramp peaks, measured twice.
  - **THE BROWSER PROCESS CANNOT BE PROFILED THIS WAY** — `Memory.startSampling` is absent on
    that target, verified. So a reading covers the renderer only: 1,237 of 2,046 MB on the one
    event where both were measured. The rendered line says so, because a figure silently
    describing two thirds of a ramp is how "the biggest process" became a whole explanation once.
  - **HOW TO READ THE FIRST ONE:** `net::` frames confirm the buffering candidate after three
    entries asserted it without evidence; anything else means three entries need correcting.
- **TRACK B — THE CURE. DESIGNED, DELIBERATELY NOT STARTED, NEEDS THE OWNER'S GO-AHEAD.**
  Take the renderer out of the OAuth round trip: intercept `/authorize`, replay it over
  `ctx.request` following redirects, exchange the code ourselves. No page load, no renderer, no
  gigabytes. Three pieces already exist — we intercept `/authorize` (`force-login-prompt.mjs`),
  we already read `code_verifier` off the token POST (`rc-token.mjs:108`), and okta-auth-js's
  `okta-transaction-storage` is already known to the code.
  - **For the COOKIE-ANSWERED case it is a plain redirect chain**, and that is where the chronic
    damage is: **all twenty recorded ramps were renewals.**
  - The password case is Okta Identity Engine (`/idp/idx/*`) and is the CAPTCHA-exposed path —
    leave it in a browser. It is once per release, and the warm-up now puts it three hours from
    the cart.
  - **NOT STARTED ON PURPOSE.** It is surgery on the one path between a queued hold and a missed
    cart, and Track A's first reading could change its design entirely — if the growth is
    buffering in the **browser process**, `ctx.request` may not even be the right lever. Building
    it blind is how a repair gets credited to the wrong mechanism, which has happened three times.

### TRACK A'S FIRST READING NAMED NOTHING — IT WAS VALIDATED ON THE WRONG PLATFORM (2026-08-22)
The sampler fired on the box for the first time, 19:34 PT, and produced this:
```
02:34:58 native allocation, renderer only (...): 43 MB while free RAM moved -161 MB
           22 MB  <V8 Heap>
           14 MB  0x7ffc499b1707 <- 0x7ffc4375aa42
            4 MB  0x7ffc499b1707 <- 0x7ffc44ec485f
            2 MB  0x7ffc499b1707 <- 0x7ffc44da6a91
```
- **The module's header claimed "symbolization is partial — 1,083 of 1,733 frames".** That was
  measured against the Chromium in the **Linux dev container**. Playwright's WINDOWS build
  exports no internal symbols, so in production it is not partial, it is **absent**. Same shape
  as `cap sync`'s plugin path and the headless RC login: validated somewhere that is not where
  it runs.
- **THAT NAVIGATION DID NOT RAMP** (`RAM 9462 → 9301`), and the trace said so and refused a
  verdict — the three-way rule working. So the numbers mean nothing; what the reading shows is
  the SHAPE a real ramp would have arrived in. **We would have waited days for an event and
  then been told four hex addresses.**
- **Fixed in #160: addresses resolve to `module+0xoffset`** from the `modules` array
  `Memory.getAllTimeSamplingProfile` already returns beside `samples` and which the file
  discarded. Module bases move per process under ASLR, so a raw address groups within one
  profile and **nowhere else** — the offset is fixed for a build, and the `uuid` names the
  binary for offline symbolization.
- **The module NAME is not expected to discriminate** — nearly all of Chromium is one
  `chrome.dll`. It is printed for the one case where it settles something for free: a frame in
  a **system dll** (`ws2_32`, `winhttp`, `mswsock`) is the network stack, i.e. the buffering
  candidate this file has asserted three times and never shown.
- **BOT-SIDE, so it is not live until the box updates**, and the box cannot update while a hold
  is queued inside 6h of its release.
- **Nothing was going to be sampled tomorrow morning anyway.** `startNativeSampling` has ONE
  call site — the renewal's throwaway tab. `maybeAutoLogin` and the rehearsal are not sampled,
  and if T−30 mints a token `planRenewal` stands down for the hour. **A queued test hold buys
  the cart flow, not a leak reading**; do not treat the two as the same test.

### THE STALE TOKEN COMES FROM THE SERVER (2026-08-22) — every local candidate is eliminated
The 08-19 census left three candidates: IndexedDB, a cookie, or the server. The box has now
answered all three in one reading:
```
02:34:58 ✗ no fresher token (none → -603732s), got as far as: none
02:34:58   storage census: local 6 key(s), session 1 key(s) — NO token-shaped value in either
           store. IndexedDB: no databases at all, so the remaining candidates are a cookie
           or the server.
02:34:58   cookies: 10 on the RC origins, NONE token-shaped — so the stale token is coming
           from the server, not from this profile
```
- **-603,732s is a SEVEN-DAY-dead token**, and it is the same one receding, exactly as 08-19
  established for the 74-hour case. Clearing local storage cannot reach it because it is not
  there. **The `dropStoredToken` family of fixes is finished as a line of attack.**
- **This does NOT explain the leak** and must not be folded into it. It explains why the
  RENEWAL cannot repair the session — a different failure that happens to share a code path.

### THE RENEWAL HAS FAILED 20 TIMES RUNNING AND IS IN BACKOFF (2026-08-22)
`renewal stood down: 20 attempts in a row have failed, so the next is 30m apart`.
- **This does not endanger tomorrow's cart, and the distinction matters.** `maybeAutoLogin` at
  T−30 is a different mechanism with its own 2-attempt budget, and with **Okta ALIVE** it is
  the 11-second cookie-answered sign-in that migration 065 exists to predict. The login
  rehearsal passed ~24h earlier, which is the standing evidence that it works.
- **The backoff is correct behaviour**, not a fault to clear: a gate that never stops retrying
  is the 2026-08-08 request storm.
- **Do not tell anyone to run `rc-login.bat` on this alone.** The keep-warm prints "A human
  must sign in once" on every dead verdict, and that advice has been given twice over sessions
  that repaired themselves.

### RAMPS ARE MUCH RARER NOW — AN OBSERVATION, NOT A CURE (2026-08-22)
`chromium_memory_samples`, last 30 hours: **one ramp**, 01:49→01:59 PT, peaking 8,436 MB with
free RAM at 2,227 MB — then **eighteen hours flat at ~320 MB** (hourly peaks 319-496 MB).
- Against the 08-17 baseline of **twenty ramps in five days** (~one per six hours) that is
  roughly a **5x reduction**, and the near-expiry stand-down plus the throwaway tab are the
  plausible cause.
- **IT IS NOT A CURE AND MUST NOT BE WRITTEN UP AS ONE.** One ramp still reached 8.4 GB, which
  is the whole disease. And this is a 30-hour window — the file's own history is that every
  "not reproduced this session" reading was a window that happened to miss one.
- **What it does buy is patience**: there is no longer a fire, so Track B can wait for
  evidence instead of being built blind.

### THE OKTA CAP DID NOT RESET ACROSS A PASSWORD SIGN-IN (2026-08-16, folded in 2026-08-22)
Recorded here from PR #69, which sat open for a week carrying it. On the night of 08-16 the
20:00 PT rehearsal submitted a real credential, RC accepted it, and **the reported Okta expiry
did not move**: `13:53:31` printed at 02:02, 02:05, 02:07, 02:09, 02:29, 02:44, 02:56 and
03:52 UTC — pin-stable across a fresh sign-in.
- **It corroborates the absolute cap from a second direction.** 08-19 found the rolling window
  freezing while the probe still answered ALIVE, and 08-21 found that a COOKIE-answered
  sign-in inherits the existing cap. This says a **password** sign-in does too.
- **So the cap is measured from something other than the sign-in**, which narrows an
  explicitly open question rather than closing it. Do not write in an origin.
- **It bears directly on the T−3h warm-up.** That design assumes signing in early leaves an
  Okta session behind that survives to T−30. These three readings together say the session it
  leaves behind carries whatever remains of an older cap — so **do not extend the warm-up to
  "the night before" without measuring the cap first**, which the warm-up entry already warns
  about and this is the second reason for.

### THE RAMP IS AN ELEVEN-MINUTE CLIMB, NOT A SPIKE (2026-08-23)
Two ramps in thirty-two hours; everything else in the series flat at ~300 MB.

| | peak `rc` | free RAM | COMMIT | pid |
|---|---|---|---|---|
| 08-22 23:12→23:23 | 8,983 MB | 6,744 → 3,191 | 82% | 10364 throughout |
| 08-23 07:31→07:41 | **9,180 MB** | 5,960 → 3,328 | **88%** | 5296 throughout |

- **ONE renderer pid, climbing steadily for ELEVEN MINUTES at ~400 MB/min**, renderer ~90% of
  the total (8,245 of 9,180). Browser process grows proportionally but stays under 800 MB; GPU,
  utility and crashpad flat throughout.
- **That revises the ~2,400 MB/min figure recorded on 08-17.** Slower, longer, sustained — a
  different kind of allocation and a different search. The earlier number came from a 2-minute
  sampler bracketing a shorter event; this is the same instrument with the per-type breakdown
  (062) and a full climb inside the window.
- The morning ramp **begins at 07:31 — T−30, when `maybeAutoLogin` fires.**
- **CANDIDATE, NOT A FINDING: the "RC's app did not load" failures were the AFTERMATH.** They
  ran 07:43–07:45, after the ramp, with free RAM already back to 9,884 MB — so the browser had
  just been recycled, and a box coming off 88% COMMIT is exactly when RC's SPA would fail to
  boot. It reframes an alarm that read as an independent RC fault. The discriminator is whether
  those failures recur on a morning with no ramp; until then it is a candidate.
- **BOTH ATTRIBUTIONS WERE LOST, and that is the finding that produced PR #169.** The sampler
  ran for both. Its only output is `logs\rc-keepwarm.log`, and `tail-log` returns the last
  16,000 characters, so by the time anyone looked the surviving lines were all from navigations
  that did NOT ramp. `chromium_memory_samples` survived the same two events by being in
  Postgres. Migration 066 is that fix applied to the other half — **the series says a ramp
  happened, the readings say what was allocating while it did.**
- **THE MORNING ITSELF WORKED**: hold `45719` carted at **T+1.6s** (07:59:47.6 against
  07:59:46), released 08:10. The 07:45 alarm was CORRECT and the system repaired itself,
  because a `provedNothing` auto-login attempt is refunded and the retry loop kept going.

### THE HAND-OFF LANDS IN THE CART NOW, AND THE SIGN-IN NEVER PRESSED ANYTHING (2026-08-23)
Two rough edges reported by the owner after a hold that **worked** (carted at T+1.6s), so
neither was an outage. Both were reproduced against the SERVED BUNDLE before a line was
written, which is what stopped the second one being written up as "RC reworded its control".
- **A successful cart now NAVIGATES to `/Customers/ShoppingCart`** instead of ending its
  status line "tap the cart icon at the top of this page" — an instruction to go and
  navigate a page we had just put them on.
- **THE ORDERING IS THE WHOLE RISK, AND THE OWNER ASKED THE RIGHT QUESTION ABOUT IT.**
  `✓ Added to cart` reaching `client_reports` is the evidence the two RC cart POSTs fire.
  The epilogue observes `#camphawk-rc-status` through a **MutationObserver**, whose callback
  is a microtask — so a navigation in the same turn races the one line two synthetic holds
  were run to produce. Write the proof, let it out (`CART_NAV_DELAY_MS`), *then* go.
- **AND LANDING THERE IS AN UPGRADE TO THE PROOF.** The bundle is re-injected on every
  `loadstop`, so the cart page **reads the cart back** — `webaccesscustomer/load/shoppingcart`,
  `listCartEntries`' endpoint and shape verbatim. `content-rc.js` already called its own
  judgement (the submit's `IsSuccess`) *"one step weaker than `rc-cart.mjs`, which re-reads
  the cart"*. `cart-verified {entries}` is that gap closing, and the readout prints it.
  - **It matches NOTHING.** RC's cart entries carry no unit field; a matcher looking for one
    reported an empty cart for a full one twice and left six real campsites locked.
  - **`entries: 0` is a REAL reading and must arrive as itself** — RC accepted a submit and
    holds nothing. A shape we could not read reports `cart-unverified`, never a default `[]`
    the way `listCartEntries` does: right for cleanup, wrong for evidence.
- **THE DURABLE MARKER IS WHAT STOPS THIS BEING A NEW BUG.** `carted` is a module variable —
  enough for an SPA transition, nothing across a real navigation — and **both** consumers run
  again on the cart page (the extension matches `www.reservecalifornia.com/*`, the webview
  re-injects). A second submit on a held site returns "cart is already added", a REJECTION,
  which would overwrite a true success with a failure on the screen being read.
- **THE SIGN-IN NEVER PRESSED RC'S CONTROL, THREE WAYS.** Owner: *"Takes me to RC. It scrolls
  to calendar. Nothing happens. I hit login on that page and it then completed everything."*
  (1) It asked **once, synchronously** — we inject at `loadstop` and RC paints its header
  after, the identical race `scrollToTop()` documents two functions away as *"a race we lose
  most of the time, and the failure is silent"*. It polls now, as `clickSignInControl` always
  has. (2) **No visibility test**, so a hidden copy of RC's responsive header won in document
  order — and clicking a hidden element does nothing **while still reporting `signin-open`**,
  a false positive, which is worse than the miss. A **rect**, not `offsetParent`: the latter
  is null for a fixed header, which is exactly where the control lives. (3) A bare substring
  match could take a wrapper; it must stay a substring test (RC says "Log in / Sign up"), so
  the **shortest visible match wins** under a length ceiling.
- **`window.__camphawkRcToken` IS NEVER SET IN A WEBVIEW — a fourth defect, found on the way.**
  It belongs to `rc-token.mjs`'s Playwright capture on the BOX; in the app `rc-inject.js`
  broadcasts a postMessage and nothing assigns that global. **All three "have we got a
  session?" reads in the sign-in were permanently false.** The expensive one is the success
  loop: a sign-in that WORKED ran its 120-second poll to the end and reported
  `login-result {ok:false, reason:"signed in but no session appeared"}` — **a failure over a
  working session, on the screen somebody is standing on at 08:00.** That is the 2026-08-09
  banner trap for the FOURTH time. The reporter owns the signal now (facts, never the token),
  and an **expired token is not a session** — the rule the claim screen already applies to the
  same event.
- **TWO EXISTING GUARDS BROKE, AND BOTH WERE MEASURING NOTHING.** *"an existing session
  short-circuits"* anchored on `window.__camphawkRcToken`, so the ordering it asserted was
  **vacuous** — it pinned a check that could never fire, and the property became true for the
  first time in the same change. *"a failed sign-in reports its verdict"* was measuring the
  **error path**: `vm.createContext({})` has no `setTimeout`, so everything past the first
  poll threw and was swallowed, and the test passed because it only asserted that SOME verdict
  was reported. The sandbox has a fake clock now. **Twenty-first and twenty-second time.**
- **16 mutations, each verified applied and caught. FIVE of the new guards survived their
  first round** — including one whose fixture was rejected by the **length ceiling** and so
  never exercised the ranking it claimed to test, and one that stubbed the reporter's own
  answer and so could not see the reporter stop giving it. That last is why the session-signal
  tests run the **real bundle**: a stub of the answer reproduces the bug and passes.
- **Web-side, all of it** — `/api/rc-precart` serves the bundle, so it reaches already-installed
  apps on a push. No rebuild, no review. **Unproven on a real hold:** the navigation and the
  read-back have run only against the bundle in a stub page. The next hand-off answers it by
  itself — look for `cart read back` in `rc-holds-readout.mts`.

### THE FIXTURE COUNT IN THE HEALTH ROUTE WAS NEVER FILTERED (2026-08-23, evening)
Merging two PRs fired CI on master, CI runs `npm test` against the production DB, and
`autocart.rc_session` went **warn → fail** for the length of the run:
```
autocart.rc_session | fail | RC REJECTED the session and the auto-login has had its turn —
                             run mini-pc\rc-login.bat ... — 4 hold(s) ahead and the next is
                             within 25 min
```
Non-terminal holds queried directly at that moment: **four.** Ninety seconds later: **zero.**
They were the hold suites' sentinel fixtures, swept on the way out — the artifact the
2026-08-19 entry predicts for `autocart.rc_runner`, arriving on a different check.
- **THE 08-18 `REAL_UNIT` FIX DOES NOT REACH THIS ONE.** That change put
  `unit_id ~ '^[0-9]+$'` into `nextHoldRelease` and `holdAtRisk` in `src/lib/rc-holds.ts`.
  **The health route calls neither.** `src/app/api/health/status/route.ts` carries its own
  inline `upcoming` and `imminent` counts — hand-rolled copies of the same question — and
  neither carries the filter. A rule applied to one consumer and not to the sibling asking the
  same question, this time inside the fix for that very shape.
- **THE PHONE IS SAFE; THE DASHBOARD IS NOT.** `holdAtRisk` **is** filtered, so the voice alarm
  cannot fire on a fixture. What misfires is the check the **07:30 PT pre-flight Routine
  reads** — and the detail it prints tells a human to run `mini-pc\rc-login.bat`, which
  force-kills the Chromium the token lives in. **The destructive remedy, printed over a session
  with nothing wrong with it.** That is 2026-08-16 exactly, reached by a new route.
- **BOUNDED: the fixtures exist only for the length of a test run**, so the red is minutes long
  and clears itself. A 07:30 reading is wrong only if a run happens to overlap it. That is why
  this is a note and not an incident.
- **DIAGNOSED BOTH WAYS BEFORE BEING BELIEVED** — from the source (no `REAL_UNIT` in either
  inline query) and from the observation (fail → warn as the rows were swept). Either alone
  would have been a guess; the file's own history is full of the one that was.
- **RECORDED, NOT FIXED.** It is a predicate in a safety-critical health path, and the two
  honest remedies differ in kind: filter the counts in place, or route them through the
  already-filtered helpers so there is ONE definition instead of three. Same call as the
  `reclaimLapsedHolds` test question — not a change to make in passing, on a session whose job
  was merging.

## Open / next session

> **START AT `docs/NEXT-SESSION.md`** (rewritten 2026-08-23, late evening).
>
> **THE TWO APP FIXES SHIPPED (#171)** — the hand-off lands the user IN their cart and reads
> the cart BACK there (stronger proof than the status string we wrote ourselves), and the
> in-app sign-in now presses RC's own Log in control before hunting for a form. Web-side, so
> they are already live in installed apps. **NEITHER HAS RUN AGAINST A REAL HOLD** — look for
> `cart read back` in `scripts/rc-holds-readout.mts` after the next hand-off; that is the
> whole verification and nobody can force it.
>
> **THE BOX IS CURRENT — `6d4100b`, "updated and verified", 23 seconds end to end.** #169 is
> live, so the native sampler's reading now lands in Postgres and **ramp #23 will be
> attributed** instead of dying in a 16k-truncated log the way the last two did.
> **DO NOT READ `applied_note` AND CONCLUDE IT FAILED.** That verdict was read at 20:43; by
> 20:51 a later scheduled run had overwritten the note with its own
> `SKIP - outside the quiet window` **while leaving `applied_at` at 20:41:59** — the
> note-and-sha mismatch this file already documents, observed live within ten minutes.
> `autocart.bot_version` (`mini-PC and web are both on 6d4100b`) is the field that answers
> "did it land?".
>
> **THE LEAK IS NOT FIXED and remains the standing ask.** Everything shipped is containment or
> relocation. The 08-23 shape is an **eleven-minute climb on ONE renderer pid at ~400 MB/min**,
> renderer ~90% — not the short burst recorded on 08-17. Still never observed: **what
> allocates.** "Network/IPC buffering" is asserted in three entries and has never been tested.
> **Track B (replay the Okta trip over `ctx.request`, no renderer) is designed and deliberately
> NOT started** — it is surgery on the release-critical login path and needs the owner's
> go-ahead; Track A's first real reading could change its design.
>
> **A FIXTURE CAN STILL TURN `autocart.rc_session` RED** — the health route's own `upcoming`
> and `imminent` counts never got the `REAL_UNIT` filter (entry directly above). Bounded to the
> length of a CI run, and it prints the destructive `rc-login.bat` remedy while it lasts.
> Recorded, not fixed; the fix is a deliberate change, not a drive-by.
>
> **iOS:** `1.0 (5)` resubmitted 2026-08-22 with corrected notes — `docs/APP-STORE.md` §2d.
> Release is AUTOMATIC. A 3.1.1 rejection now is the ANSWER, not a fourth process failure.
>
> Master is **`6d4100b`** and the box matches it. **#171, #169 and #146 are merged; #168 was
> closed as superseded** (its correction had already landed via #165/#170 — the reasoning is on
> the PR so it does not read as a finding dropped in a merge). **No PRs are open.**
> **Delete `docs/NEXT-SESSION.md` once the sampler has a reading from a real ramp AND the App
> Store version has a decision**; it is a handover, not a permanent doc, and a stale one reads
> like current state.

### THE APP'S RC SESSION IS BEING MEASURED NOW — no renewal built yet (migration 058, 2026-08-13)
The mobile claim flow needs a live RC session inside the InAppBrowser data store, and the
owner has had to sign in on every claim — on 2026-08-12 that happened **inside the 08:00
window**, the moment the design exists to protect. **"Sign in once and it persists" was
over-claimed:** the 08-09 tests measured persistence across closing the webview and
force-closing the app, SAME DAY. Nothing measured days, and RC's own lifetimes (~1h access
token, ~12h Okta session) apply inside the app exactly as they do to the bot.
- **THREE CAUSES LOOK IDENTICAL FROM OUTSIDE** — the user is asked to sign in, and that is
  all anyone sees: (1) the token expired but the Okta session is alive, so the SPA can
  re-mint silently and the real cost is one sign-in per ~12h; (2) the Okta session expired
  too; (3) iOS ITP purged the webview's storage (~7 days without interaction). Building a
  renewal before those can be told apart is shipping a fix for the wrong one, so **this
  change measures and deliberately renews nothing.** Nothing is cleared and nothing is
  carted.
- **`openRcHandoff` with no `unitId` WAS ALREADY THE PROBE** — it opens RC, injects, reports
  `idle` and captures a token, and `rcFragment` returns '' without a unit so it *cannot*
  cart. What was missing was the part that makes a series out of it.
- **THE PREVIOUS OPEN'S TOKEN IS THE PRIMARY EVIDENCE, and this is the whole trick.**
  Injection happens at `loadstop`, by which time RC's SPA has booted — so a token found in
  storage NOW may be one the SDK minted seconds ago, and reading it proves nothing. That is
  `renewByReload` measuring the renewal against the token it meant to replace, one week
  later and in a new file. So `sessionProbe()` writes a marker (`camphawk_rc_probe`, RC's
  own localStorage inside our isolated store) recording the token's EXPIRY at the end of
  each open. **Arrived with that expiry in the past and a live token turns up anyway ⇒ RC
  re-minted from the Okta cookie with no credential typed.** That is `renewed`, and it is
  the answer to the open question — obtained non-destructively.
- **The marker's ABSENCE is the only way to see an ITP purge**: a wipe takes RC's tokens and
  our marker together, so "no marker" = store emptied, "marker, no token" = storage survived
  and the session ran out. Different fixes; previously the same event.
- **A PURGE AND A FIRST RUN CANNOT BE TOLD APART BY THE DEVICE — the SERVER does it.** From
  inside the webview both are the same silence. `deviceKey` lives in **our own origin's**
  localStorage, which the RC-origin wipe does not touch, so prior probes from that device
  are what separate them. If it is lost too, a purge degrades to `first-open` — never claim
  a purge you cannot prove.
- **`live` PROVES NOTHING ABOUT RENEWAL and says so** (`proves_renewal`). Ten working
  sessions are not ten pieces of evidence; that is how one observation has twice become "a
  measurement" in this file. A renewal is also refused when the token's own `iat` says it
  was minted long before this open — a replay is not a re-mint.
- **Never presence, always liveness.** `token captured` gained `expiresInSec`/`ageSec`,
  decoded locally, never the token. The timings ride **only the first sighting of each
  distinct token**: `expiresInSec` counts down, so on every rebroadcast it would defeat the
  duplicate collapse and bury the cart's own status at 08:00:00.
- **NO HEALTH CHECK, deliberately.** It only runs when a human presses the button, so a
  check would go stale within a day and read `fail` over a system behaving correctly — the
  cry-wolf failure already fixed three times. The panel shows the series; nothing pages.
- **Entirely WEB-SIDE — no rebuild, no review.** The script is served by `/api/rc-precart`,
  the panel and the claim screen are web. It reaches already-installed apps on a push.
- **STILL ZERO READINGS as of 2026-08-13 05:40Z** (readout run; "No probes recorded"). The
  series cannot start without the owner tapping the button in the app, so this is the one
  open item here that no agent can advance — ask, don't investigate. And **do not read the
  empty readout as a broken write**: the panel says "this reading was NOT recorded" in that
  case, and nobody has pressed it yet.
- **FIRST DISCRIMINATING READING, 2026-08-13 12:31 PT — and it came from the CLAIM SCREEN,
  not the button.** The test hand-off's first `session` report read `opens:6,
  marker:"present", storedToken:"none", prevTokenExpiresInSec:-12316` — the app arrived
  **3h25m past the previous open's token expiry, with the marker intact**, and a live
  939-char token turned up seconds later with **no credential typed**. That is the
  `renewed` shape the marker exists to catch: RC re-minted from the Okta cookie. The
  marker's presence is what rules out an ITP purge.
  **It is ONE observation and the readout will refuse a verdict on it** (`MIN_RENEWAL_TESTS`
  is 2) — which is correct, and is the discipline this file has twice failed. Do not quote
  it as "renewal is proven"; quote it as the first probe that actually tested renewal.
  Worth knowing the claim screen produces these for free, so the series need not wait on
  somebody remembering a daily button.
- **HOW TO USE IT:** Admin → System Health → Alerting → **"Open ReserveCalifornia"**, *from
  inside the app* (from a browser `canInject` is false and it tests nothing). **Once a day**;
  the answer is a shape over days, not a press. The claim screen records the same facts
  against a real hold for free (the `session` stage rides `client_reports`).
- **NOBODY CAN RUN THE PROBE REMOTELY — not an agent, not a Routine, not the mini-PC.** It
  measures the storage inside the OWNER'S PHONE's in-app webview; a scheduled session has no
  injectable webview, so it would degrade to the browser path and measure nothing. The tap is
  human by construction. What is automatable is the READING:
  `NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-app-session-readout.mts`.
- **THE READOUT REFUSES A VERDICT IT HAS NOT EARNED.** It counts only the probes that
  actually TESTED renewal — the ones that arrived with a dead or missing token — because a
  probe that found a healthy session asked RC nothing, and counting those is precisely how a
  working system gets mistaken for a self-renewing one. Under `MIN_RENEWAL_TESTS` (2) it
  reports NOT ENOUGH DATA and stops. Same posture as `recgov-429-profile.mts` refusing until
  all 24 hours have data.
- **PROBE AFTER A LONG GAP OR IT MEASURES NOTHING.** Two probes twenty minutes apart cannot
  test renewal at all — the token is still alive, so the answer is `live` and the question is
  untouched. Overnight is the discriminating one: the Okta session is ~12h, so gaps either
  side of that should split cleanly. The readout prints the longest gap survived and warns at
  36h of silence, because a hole in the series is a cost, not a neutral absence.
- `worker/rc-session-verdict.test.mts`, verified failing against 13 regressions — including
  a stored token accepted as live, a renewal claimed from any live token, `unknown` rounded
  to `signed-out`, and the classifier reading the LAST `session` report (which is this run's
  own marker write) instead of the first.

### "What counts as a match" DID NOT COUNT FOR ANYTHING (2026-08-15)
The New watch screen rendered a fieldset with exactly that legend, offering Site type
(Tent/RV/Cabin/Group) and a rig-length picker. **`grep -rn "site_type\|siteType" worker/`
returns ZERO hits and `loadWatches` does not even SELECT the column.** So a user picked RV and
we alerted them for tent sites, through a control whose own legend promised otherwise. Of the
five inputs only `siteType` was ever transmitted — `rvLength`, `electric`, `showers` and `pets`
were collected in the UI and dropped on submit.
- **Second offence, same file.** `NewWatch.tsx` already carried a comment recording that its
  auto-cart toggle was "PURELY DECORATIVE until 2026-08-01".
- **DECISION: remove the promise, do not implement it — for now.** Implementing is what users
  would prefer and is a bigger job than it looks: four buckets have to map onto rec.gov's
  `campsite_type` vocabulary AND ReserveCalifornia's AND UseDirect's AND GoingToCamp's, and
  every source whose site records carry no type needs a deliberate include-or-exclude answer —
  the same question the rig-length filter already answers by EXCLUDING campgrounds with no
  length on file. **Wrong in the strict direction and alerting stops silently, with no error
  anywhere.** A filter that works on rec.gov and quietly does not elsewhere is worse than none,
  because nothing tells the user which they got.
- **What replaces it is better and already works: PER-SITE MUTING** — explicit, source-agnostic,
  and honoured by both RC finders since 08-13.
- **THE PANEL WAS NEVER THE DEFECT, so the scope is surgical.** It STAYS on Explore, where
  search resolves it to `p_site_type = ANY(c.site_types)` and it genuinely filters. Removing it
  there would have deleted a working feature in the name of fixing a broken one.
- **The column and the `/api/watches` field stay.** Campflare's `campsite_kinds` is a real
  consumer; with the picker gone the value is simply absent, which is exactly what a user who
  left it blank already produced. **`CAMPFLARE_API_KEY`'s presence in production was NOT
  confirmed** — Vercel's env is authoritative and was not readable — which is a reason to leave
  the path intact rather than reason it away.
- `worker/watch-filters.test.mts` is **BIDIRECTIONAL**: it fails if the promise returns without
  the implementation, AND it tells you to restore the control if `worker/` ever starts reading
  `site_type`, so the decision is re-taken deliberately rather than by whoever notices first.

### MUTING IS ON THE NEW WATCH SCREEN NOW, AND IT IS ONE COMPONENT (2026-08-15)
The owner's ask: *"Most people won't know there is a mute section in manage watches, so if it
is here also it will be more used."* A control the poller genuinely honours was reachable only
from `/manage/<token>` — a screen users arrive at by tapping a link in an alert, i.e. **after**
the noise they wanted to avoid. It is now on `/new` as well, and it is what REPLACES the
site-type picker removed above: with that gone, naming the sites is the only working way for a
user to say "not that kind of site".
- **ONE implementation** — `v2/SiteMuteList.tsx`, mounted by both screens. The callers differ
  only in what a change MEANS (a write on manage; local state on `/new`, which has no watch to
  write to yet), and that is the `onChange` prop. Nothing else differs. A second copy is how
  `content-rc.js` spent months telling users to click a cart icon while `rc-cart.mjs` did the
  right thing, and `NewWatch.tsx`'s own header already stated the rule.
- **THE IDS ARE THE POLLER'S IDS, AND THAT CHAIN IS THE FEATURE.** The list loads from
  `/api/campgrounds/<id>/availability`, which is `getAvailabilityFromRecGov` /
  `getRCAvailabilityForMonth` — **the same functions the poller reads**. RC's emits
  `campsiteId: String(unit.UnitId)`, byte-for-byte what `findRCOpenUnit`/`findRCHeldUnits`
  compare. Checked in source BEFORE writing a line, because a write into a column no reader can
  match is exactly the 08-13 Carpinteria bug — and the 08-09 verification missed that by
  proving the write and never a reader. `worker/site-mute-creation.test.mts` pins links 1, 2, 4
  and 5 of the chain; `site-mute.test.mts` already held the finder end.
- **Bulk is TWO buttons, not one toggle.** "Mute all but one or two" means muting everything
  must be one tap — but a toggle whose label flips on whether everything is muted reads wrong
  in the middle state: after unmuting your two keepers it says "Mute all" again, and pressing
  it silently re-mutes them. **Under an active filter the labels say "Mute these 4", never
  "Mute all"** — someone who filtered to "B" and pressed "Mute all" would reasonably expect all
  300 sites, and that word is the entire safeguard. The count is what will CHANGE, not what is
  on screen.
- **MUTES RIDE ONLY THE CAMPGROUND THEY WERE LOADED FOR**, and this is the sharp edge the
  divisions work (`ce1840c`, landed mid-session) created: one submit now makes a watch PER
  DIVISION. Site ids are per-campground and **rec.gov's are GLOBAL**, so handing one park's list
  to a sibling division would not merely fail to match — it could mute a real site the user
  never saw. Two guards: the picker is hidden for a multi-division park (there is no single
  inventory it could honestly describe), and the payload sends mutes only where
  `t.id === campgroundId`. `/new` also clears the set whenever the campground changes, for the
  same reason.
- **`applyMutes` is a module, not two lines in the route** (`lib/watch-mutes.ts`), so a real-DB
  test exercises the statements rather than a COPY of them — the `rc-holds-readout` lesson. One
  statement per direction; the set arithmetic is in SQL so two taps racing cannot lose one; and
  **`COALESCE(…, '{}')` because `array_agg` over an empty set is NULL while the column is NOT
  NULL**, which "unmute all" hits on its very first press. `worker/watch-mutes.test.mts` covers
  that, ordering, idempotence, and an id containing a quote (`sqlit` interpolates, it does not
  bind).
- **Mutes are applied BEFORE unmutes**, so an id in both lists ends up UNMUTED — the safe
  direction, since a site wrongly muted is an alert nobody learns they missed while a site
  wrongly unmuted is only noise.
- **16 mutations, each asserting the mutation actually applied.** Two are worth keeping:
  the ordering mutation's first version broke `applyMutes` so thoroughly that a DIFFERENT test
  failed, which proves the code was broken and NOT that the rule is guarded — it had to be
  redone surgically before it meant anything. And **extracting `applyMutes` invalidated a guard
  written ten minutes earlier**: it pinned `mutate(` inside the route body and would have gone
  green against a route that no longer wrote anything. Both halves are pinned now (the helper
  does the work, the caller still calls it). Sixth time that correction has been needed.
- **A dependency array is a place a value goes stale invisibly.** `autoCart` was missing from
  `submit`'s deps at `4a8e958`, so `useCallback` handed back a closure over whatever it was
  when last rebuilt — and every other dep changes EARLIER in the form than that toggle does, so
  the ordinary path (campground → dates → turn auto-cart off → submit) posted `true`. The
  divisions commit restored it independently, so this is recorded as a hazard rather than as a
  fix. The test reads the ARRAY, not the body, and now pins `muted` and `autoCart` together —
  matched by content, because its first version anchored on the array's opening tokens and went
  quiet the moment divisions added two deps in front.

### ONE WATCH CAN COVER A WHOLE PARK (migration 070, 2026-08-15) — DORMANT UNTIL SOMEONE MAKES ONE
Carpinteria SB's four divisions were being watched as four separate watches, Pfeiffer Big
Sur as three — so one park ate most of a 6-watch allowance. A park watch now counts ONCE.
Side-lane work, crossing into `worker/` and `src/lib` with the owner's authorisation, and
reviewed here because those are the main lane's files.
- **NO LONGER EMPTY — THE FIRST PARK WATCH IS LIVE (checked 2026-08-17).** One active watch
  (`14e96a2e`, **Pfeiffer Big Sur SP**) now spans **2 campgrounds**, so the expansion path
  below is executing on every poller cycle rather than sitting dormant. **Every "this has
  never run" sentence in this section is therefore stale**, including the one under KNOWN
  GAPS. What that buys: the `CROSS JOIN LATERAL` expansion, the namespaced
  `<campgroundId>::<siteKey>` claim keys, the `rc_hold_notified_for` namespacing and
  `watchOpenings`' `::`-stripping SQL are all live code paths for the first time. Nothing
  has gone wrong — but nothing had been *exercised* before either, so the next park-watch
  alert is the first real evidence any of it works. Watch for a duplicate or missing alert
  on that watch specifically.
- **The paragraph below is kept because its REASONING is what made this safe to ship**, and
  it is still how a reader should judge the expansion — it is simply no longer a statement
  about today's data:
- **`watch_campgrounds` (070) WAS EMPTY, AND THAT WAS THE ENTIRE SAFETY ARGUMENT.**
  `loadWatches` now emits ONE ROW PER (watch, campground) via `CROSS JOIN LATERAL`, with
  `COALESCE(..., ARRAY[w.campground_id])` falling back for any watch with no rows. **Verified
  against prod independently of the PR's own claim**: the new expansion and the old query
  return the byte-identical set — 20 pairs, 20 distinct watches, zero multi. Migration 070 is
  genuinely applied (TEXT `watch_id`, both indexes, RLS on, 0 rows). `watches.campground_id`
  stays as the REPRESENTATIVE division.
- **TWO PLACES COLLAPSED PER-WATCH STATE, and both were caught by the author.**
  `claimNotification` keyed on `campsiteId ?? '*'` — and that sentinel is PER WATCH, so
  ReserveAmerica / GoingToCamp / TN-SC divisions of one park would collapse onto
  `(watch_id, '*')` and the first to open would silence the rest for an hour, which is
  migration 026's bug one level up. `rc_hold_notified_for` is ONE column and had the same
  collapse, its CLEAR included. Both namespaced `<campgroundId>::<siteKey>` **only when the
  watch is multi** — unconditional namespacing would rewrite every stored key and re-alert
  every currently-open site once on deploy.
- **THE THIRD CONSUMER WAS MISSED, AND THE AUTHOR PREDICTED IT IN THE SAME BREATH** — "if any
  of those key on watch id in a way that assumes one campground, it will be wrong the same
  silent way the two claims were." `watchOpenings` is that consumer, and it was wrong in
  exactly that way, three times at once and only for a park watch:
  1. **`AND a.site_key <> '*'` STOPPED EXCLUDING THE SENTINEL**, because a park watch's is
     `<campgroundId>::*`. Proved by EXECUTION, not by reading the regex —
     `siteKeyFor(null, {multi:true, campgroundId:'720'})` returns `720::*`. That filter's own
     comment says surfacing it would report "a number we made up" as an open SITE, and that
     is what it would have done.
  2. The name subquery joins `payload->>'campsiteId'`, which stores the BARE id, so every
     open site on a park watch came back unnamed.
  3. The id feeds `withBookLinks`, so the booking deep link named a site id that does not
     exist.
  Fixed by stripping the namespace IN SQL (everything after the first `::`, which is the
  campsite id on both shapes) **and testing the sentinel filter against the STRIPPED key**.
- **`worker/park-watch-openings.test.mts` IS REAL-DB** because the fix is a SQL expression and
  a test asserting a copy of it would assert the copy. Mutation-tested against all three
  reverts plus taking the wrong `::` segment. **Its first version proved NOTHING about defect
  2** — it only asserted ids, and a missing name is `null` either way, so the mutation passed;
  a notification fixture now exercises the join. Same shape as the memory readout's fixtures
  making "largest" and "last" indistinguishable.
- **`beat()` takes DISTINCT watches.** `watches` is one row per pair now, and that number
  renders as "Checking N watches every 15 seconds" on the admin page. Nothing gates on it,
  which is precisely why the human reading it should get the number its label promises.
- **KNOWN GAPS, not bugs to hunt.** ~~No multi-campground watch has EVER run a real poller
  cycle — the first park watch is the first exercise of the path.~~ **FALSE since at least
  2026-08-17: a 2-part Pfeiffer Big Sur watch is active and being polled.** Struck rather
  than deleted, because "nothing has exercised this" is exactly the sentence a later
  reader would quote as a reason not to trust an alert that is in fact real. ~~The watches list does not
  show a park watch's parts (`GET /api/watches` returns `divisions`; nothing renders it)~~
  **— CLOSED 2026-08-15 by the side lane (PR #63): `WatchCard` renders the park title plus
  its parts (capped at 4, then "+N more") and `/manage/<token>` lists them in full.** The
  INVENTORY half stands and is the part that matters:
  `/manage/<token>` can still only enumerate the REPRESENTATIVE division's sites, so a sibling
  division's site cannot be muted from there — the screen now says so in as many words rather
  than leaving the reader to infer it from a list that quietly covers one park in three.
  **`muted_site_ids` being watch-wide is CORRECT
  for a park watch** — campsite ids were measured unique within a park (10,757 sampled, zero
  collisions) — so this is a display gap, not corruption. Do not advertise park watches until
  one has been observed through a cycle.
- **`MAX_DIVISIONS_PER_WATCH = 10`** replaces the bound the watch cap used to provide; covers
  298 of the 321 multi-division parks whole. This is **UseDirect** load, NOT rec.gov — zero
  multi-division parks are rec.gov rows, so `poller.capacity` was never threatened by it,
  though it counts expanded campgrounds correctly now.
- **NO BACKTICKS IN A SQL COMMENT IN THESE FILES.** The queries are template literals, so a
  backtick terminates the string and the parse error surfaces somewhere unrelated. The author
  warned about this in the same message that asked for the review, having hit it twice — and
  it still cost a build here, in a comment quoting the very key shape being fixed.

### THE UI ROUND, 2026-08-15 evening — all three found by USING the app
Three defects reported from production with screenshots, none reachable by reading the
source, and all three the same family: the mechanism worked and the meaning was absent.
- **LEO CARRILLO OFFERED NO MUTE LIST.** The picker was gated on `divisions.length <= 1`,
  written when one submit meant one watch PER division. A park became ONE watch and the gate
  outlived its reason, hiding the feature for EVERY multi-division park. It now lists every
  checked division — safe because campsite ids are unique within a park — with each row
  labelled by its part, since two of Leo Carrillo's three are both "Canyon Campground".
  **`targets` is now ONE definition** read by the picker and the payload; they were briefly
  two, and that disagreement WAS the bug.
- **ONLY ONE PART OF A PARK WAS TICKED.** `pick()` ticked them all, exactly as its comment
  said — and `pick()` sets `campgroundId`, which triggers the resolve effect, which reset the
  selection to the representative a moment later and won every time. **A correct line, live
  and inert, overwritten by a second writer** — the inert-fix shape inverted. Both writers go
  through `defaultChosen` now, capped at `MAX_DIVISIONS_PER_WATCH` so a 70-division park does
  not fail its first submit on a limit nobody chose.
- **"SOME CAMPGROUNDS SHOW A CITY AND STATE AND OTHERS DO NOT."** Every call site gated the
  label on the CITY, which is the rarer field: 26% of visible campgrounds have no city, only
  3.6% have no state, and **all 859 ReserveAmerica rows are `{city: null, state: "NY"}`** — a
  state we had and threw away. `placeLabel` takes the list from 74% to 96% labelled.
  **`geo.hitLabel` was the only one of four call sites already correct**, so one feature held
  two expressions for one idea and the broken one was what users read first.
- **AND THE PLACE WAS THE PART THAT GOT TRUNCATED.** Explore's rail is a fixed 316px
  (`--ch-rail`) and its row put name AND place in one truncating span, so a long name ate the
  town — the half that distinguishes similar names. Name truncates on its own line now;
  widening the rail would have fixed one breakpoint and restructured the page.

### FILTERS: TWO WERE UNUSABLE ON THE DATA (2026-08-15)
The owner tested Silver Lake, which has showers in life and not in our catalog. The
measurement is worse than "sparse", and both removals are the SAME defect that had already
removed `drinking water`:
- **`showers` is recreation.gov ONLY** — 197 of 4,469 rec.gov rows and **zero** across all
  seven other sources. Ticking it silently excluded every state-portal campground.
- **`pets_allowed` is `true` for 100% of every non-rec.gov source** (882/882 ReserveAmerica,
  478/478 Ohio, 392/392 RC). A DEFAULT, not a measurement.
Both columns stay — JSON-LD publishes `petsAllowed` and the rec.gov showers ingest is real —
they just cannot carry a filter.
- **The three surviving filters were MEASURED to work**, which is the part worth keeping:
  against 80 campgrounds near Big Sur, site type gave 56/52/4/16, pad length 49/24/7, and a
  nonsense value returned 0 in both — that last is what proves the SQL clause is live rather
  than merely present. Electric is genuinely multi-source (9 of 14).
- **Hookups moved into Site type**, reversing a call recorded the same day. Left visible
  rather than overwritten: that reasoning was sound and only its surroundings changed —
  removing two chips left "Must have" holding one, and a one-item group is not a group.
- **Pad length is its own always-visible control now, and that fixed a real bug.** Explore
  sent `rvLength` only when `siteType === "rv"`, so a length set without also picking RV
  showed as applied and was never transmitted. A filter that lied about being on.
- **`worker/explore-filters.test.mts` derives its field list FROM `FilterValue`**, so adding
  a filter without wiring it to the query fails. A hand-written list of three would pass for
  ever against a fourth that does nothing — which is how the last one survived review.

### `npm run verify` GATES ON jsx-spacing NOW (2026-08-15)
An HTML entity anywhere in a JSX text node makes SWC drop that node's leading whitespace, and
this repo escapes entities everywhere (`react/no-unescaped-entities` pushes you there), so every
such node is a place it recurs — it silently broke four user-visible strings.
- **Placed BEFORE `npm test`.** It is a source scan that finishes in under a second; the test
  suite hits the production DB and takes ~2 minutes. Cheap gates first.
- **Only the unambiguous tier exits non-zero.** The "to eyeball" tier (an element is involved,
  so a flex gap may already cover it) prints and passes — that is what makes it safe to gate on,
  and it is the same reasoning that keeps `lint` OUT of verify.
- **CONFIRM A NEW GATE CAN ACTUALLY FAIL BEFORE TRUSTING IT.** Three attempts to provoke the
  hard tier produced nothing; the shape that works is two adjacent non-element children where an
  entity ate the leading whitespace. **And the first probe's exit 1 was an `ENOENT`** from a path
  outside the repo root — a crash read as the check firing, which is one keystroke from being
  written up as proof.
- `worker/verify-gates.test.mts` pins the membership and the ordering, because a gate quietly
  dropped from `verify` stops existing with no test failing and nothing to notice.

### THE 08:00 HAND-OFF WORKED END TO END (2026-08-16) — and the alarm that fired was ours
Two holds, both carted, both claimed, at exactly `RC_HOLD_CAPACITY`:

| site | carted | claimed |
|---|---|---|
| South Carlsbad 45722 | 15:00:43Z (**T+43s**) | 15:02:01Z |
| South Carlsbad 45723 | 15:00:49Z (**T+49s**) | 15:03:23Z |

45722 reported **`✓ Added to cart`** on iOS — the third confirmation of the cart POSTs — and a
later re-injection got `already added`, which is proof the cart STUCK, not a failure. 45723 was
claimed from a plain browser (`web build unavailable`), so both paths are exercised in one
morning. **`RC_HOLD_CAPACITY = 2` was met at its exact boundary and both seats filled**, which
is the first time the ceiling has been tested rather than exceeded.

#### A LIVE SESSION WAS REPORTED DEAD, AND THE PRINTED REMEDY WOULD HAVE KILLED IT
The phone rang at **07:33 PT, 27 minutes before the release that then worked perfectly.**
- **THE CHAIN.** `acceptable()` is liveness AND coverage, so a **live** session with a 40m token
  against a 46m requirement returned false. Drop-and-re-mint did not lift it. RC then showed no
  sign-in form — **it never does to a signed-in user** — so `attemptLogin` fell through to its
  no-form exit and returned `ok: false`, *"neither an email nor a password field appeared — RC
  said: 'You have a reservation arriving on today's date'"*. `maybeAutoLogin` reported that as
  `dead`, `autocart.rc_session` FAILED, `holdAtRisk` rang, and the remedy printed was
  `rc-login.bat` — **which force-kills the Chromium the access token lives in. Following the
  alarm's own advice would have destroyed the working session it was complaining about.**
- **THE 46-MINUTE BOUND WAS BEHAVING CORRECTLY.** It already carries a 15-minute cart hold and a
  5-minute margin. The token was six minutes under a deliberately conservative figure, and the
  cart fired at T+43s with the hold claimed two minutes later. **The REPORTING turned a
  conservative margin into an emergency**; the arithmetic was never wrong.
- **I CALLED IT THE 2026-08-09 BANNER TRAP AND IT IS NOT — the distinction is the finding.**
  That trap is a *dead-looking session that is really alive*, and its fix is the `acceptable()`
  poll above the exit, **which worked**. This is that poll's own NEGATIVE, described in words
  belonging to a different fault. Filing it under the old name would have sent the next reader
  to a fix already in place, which is how a real defect survives a post-mortem.
- **Two halves, both required.** `attemptLogin` asks `isLive()` at the terminal exit and returns
  `sessionLive: true` for a session that exists — **with NO banner on that path**, because to a
  signed-in user RC's text is evidence of SUCCESS and printing it as the explanation for a
  failure has now cost three separate mornings. `maybeAutoLogin` gives that its own arm,
  reporting **`warm` with the shortfall stated** rather than `dead`. **Severity is the defect,
  not the sentence:** `dead` is what pages and what prints the destructive remedy. The attempt
  is refunded like `provedNothing` — no credential was submitted, so the T−5 re-check keeps its
  turn.
- **The shortfall stays visible, and a guard fails if it becomes a plain success.** A silent
  short token is the opposite failure and the one that makes a downgrade dangerous.
- `worker/rc-live-not-dead.test.mts`, four mutations each asserting the mutation applied. Both
  halves pinned **by ORDER as well as presence** — a live check placed after the banner return,
  or a live arm after the dead arm, is unreachable and merely looks right.
- **BOT-SIDE.** Needs `update.bat`, "Update now", or a quiet window; nothing changes until the
  box moves.

### A TypeError PUBLISHED A USER'S PASSWORD (2026-08-16) — and the feature is REVERTED
An in-app RC sign-in (the user types credentials on the claim screen, we inject them into the
webview) was built, shipped, failed three times in one night, and was **reverted**. Two findings
outlived it.
- **THE LEAK. `window.__chRcLogin("<email>", "<password>")` was undefined**, and WebKit formats
  that as `X is not a function. (In 'SOURCE', 'X' is undefined)` — **where SOURCE is the failing
  expression, verbatim.** The bundle's global `error` listener reported it and a real
  ReserveCalifornia password landed in `client_reports` in production. **Nothing mishandled the
  secret; the ENGINE published it.** `scrub()` knew JWT shapes and sailed straight past it,
  exactly as it sailed past an OAuth authorization code on 2026-08-09. **Second time, same
  lesson: do not produce a value you then have to filter.** The row was scrubbed; the owner was
  told to change the password.
  - **The layer that counts is upstream** — bind credentials to locals so no call expression can
    contain one; an engine quoting source can then only quote `f(e, p)`. That came back out with
    the revert.
  - **`scrub()` DROPPING WEBKIT'S SOURCE QUOTE WAS DELIBERATELY KEPT**, and moved to
    `worker/rc-report-scrub.test.mts` so it does not depend on the sign-in existing. The
    mechanism belongs to the REPORTER, not that call site: any future expression touching a
    secret is published the same way. **Reverting the feature would otherwise have taken the
    lesson with it — which is how a finding disappears leaving no diff to notice.**
- **WHY THE SIGN-IN NEVER WORKED — two defects, and the second is why it took three tries.**
  `afterLoad` fired **once per hand-off**, and `__chRcLogin` begins by clicking RC's sign-in
  control, which **navigates to `signin.reservecalifornia.com` and destroys the JS context** — so
  it died on the park page and was never invoked on the page with the form. ClaimFlow's own
  comment said `afterLoad` was *"re-asked on every navigation"*; the flag defeated exactly that,
  and the guard beside it **pinned the flag**. And **every terminal path of `done()` was silent**
  — it only RETURNED its verdict, and `executeScript` discards return values, so "could not find
  the control", "no password field", "Okta rejected it" and "signed in" were the same nothing. A
  real run reported `injected`, `session`, `idle` and stopped, **indistinguishable from the
  sign-in never being invoked.**
- **Both fixes live unmerged on `claude/rc-login-fix` (PR #78)** — once per PAGE keyed on
  origin+path with a redirect-loop bound, and `login-result`/`signin-missing` reports. **Do not
  merge it onto the reverted claim screen**; re-land the feature first.
- **THE REVERT WAS THE RIGHT CALL AND WAS THE OWNER'S.** Two real holds released nine hours
  later and the claim screen is what takes them; a fourth overnight attempt would have put a
  half-tested gate in front of the one control that matters at 08:00. The reverted flow is not
  untried — it is the one with `✓ Added to cart` behind it.

### "ALREADY SIGNED IN" IS NOT "COVERED" — the 08:00 cart lost to a one-line short-circuit (2026-08-15)
A queued hold released at 08:00:40 PT and was never carted. The runner was alive, the feed was
right, the hold was `requested`, and the auto-login fired **correctly and on time**:
```
14:30:42 ⏰ hold releases in 30m and the session will not cover it — signing in ONCE
14:30:47     → already signed in — nothing to do
14:30:47   ✓ signed in unattended — the hold is covered
```
`maybeAutoLogin` computed that the token would NOT last, called `attemptLogin` to fix it, and
`attemptLogin` short-circuited on `isLive()` — **a question about whether a session EXISTS,
never about whether it will still exist when it is needed.** The token had 23 minutes, needed
50, expired at 07:53, and the cart failed at 08:00 with the release's one attempt already
spent on a no-op. The log line "the hold is covered" was a restatement of the INTENT, not a
reading of the result, and it made the next thirty minutes look healthy.
- **THIS IS THE 2026-08-09 LESSON RUNNING BACKWARDS.** `isLive()` was ADDED to `attemptLogin`
  *because* it reported failure over a healthy session. Nobody checked the other direction,
  and the opposite error is worse: a false failure wakes a human, a false success does not.
- **AND IT WAS ALREADY WRITTEN DOWN, ABOUT A DIFFERENT CALLER.** `rehearsal.mjs` documents
  this exact short-circuit — *"`attemptLogin` short-circuits on `isLive()`, so it would return
  ok without exercising one line of the sign-in. A pass that proved nothing is worse than a
  skip"* — and gates the nightly rehearsal on it. The same line sits in the RELEASE-CRITICAL
  path and the two were never connected. **A hazard recorded for one caller is not recorded.**
- **Five fixes, and the ordering of the first two matters.** (1) `attemptLogin` takes an
  optional `sufficient` deadline and BOTH already-signed-in returns go through it — the
  retry-loop one too, or the bug simply moves there. (2) A live-but-short session has its
  token dropped (**cookies untouched**, so `DT` survives) to reach a state it can sign in
  from; without that the form hunt finds no form and reports the 08-09 false alarm.
  (3) `provedNothing` is REFUNDED — no credential was submitted, so counting it spends the
  ration on a no-op. (4) The requirement is computed from where we STAND
  (`requiredTokenSeconds`), not from the lead: `AUTOLOGIN_MIN_TOKEN_MIN` is derived for the
  moment the lead opens and was applied at every moment inside it, so at T−5 it demanded 50
  minutes of token to cover 20 minutes of work. (5) The budget is **two attempts with an
  8-minute gap**, because one makes the first answer the only answer — deliberately not a
  retry loop, since repeated logins from this address cost 12h of IP block on 08-06.
- **`sessionAcceptable`'s THREE-VALUED coverage is the guard that matters.** `null` (an
  undecodable token) ACCEPTS. Rejecting would force a sign-in, and a sign-in first DROPS the
  stored token — a destructive act taken on an unknown, against a session that may be fine.
  Same rule as `hasAvailabilityInRange` returning null and `oktaSessionAlive`'s unknown never
  being reported as dead.
- **THE PROFILE-CONTENTION DEATH SPIRAL, found in the same log and fixed alongside.** One
  Chromium profile, two processes: the keep-warm OWNS the session (renewal, auto-login and
  measurement all live inside its **60-second** expiry poll) and the hold runner CONSUMES it,
  preempting cooperatively. A hold stuck `requested` with a dead session made the runner ask
  every **15 seconds**, so for twenty unbroken minutes:
  ```
  15:01:34 RC loaded and STAYING OPEN — token source: none
  15:01:34 → hold runner wants the profile — closing and standing down
  ```
  **The keep-warm never survived 35 seconds, so the repair could never complete** — the
  component that fixes the session was starved by the component that needs it, and it
  sustains itself (dead session → cart fails → hold stays `requested` → runner keeps asking).
  Two strikes then a 3-minute stand-off; **shorter than the 20-minute cart grace window on
  purpose**, so it can never trade a repairable session for a guaranteed miss.
- **Five silent `return false` gates are now six named sentences**, consecutive repeats
  collapsed (asked every 60s — 1,440 identical lines a day hides the answer as well as
  printing nothing). Diagnosing this took a `tail-log` off the box and 120 lines of
  scrollback, for the most release-critical decision the bot makes.
- **The two decisions are a pure module** (`scripts/auto-cart-bot/session-coverage.mjs`)
  because both were wrong in production and neither could be tested where it lived — one
  inside a Playwright call chain, one inside a loop that starts on import. Same reasoning as
  `relogin-retry.mjs` and `rehearsal.mjs`.
- `worker/session-coverage.test.mts`, **10 mutations, each asserting the mutation applied**.
  Half the guards are structural, because the pure functions can be perfect while nothing
  calls them — M4 (`maybeAutoLogin` stops passing `sufficient`) and M8 (the stand-off checked
  AFTER `requestProfile`) are that shape, which this repo has paid for three times.
- **THREE EXISTING GUARDS FAILED AND WERE UPDATED, NOT RELAXED.** `rc-token-renew.test.mts`
  and two in `rehearsal.test.mts` pinned `isLive()` and `removeItem(...)` **by name**; after
  the extraction into `acceptable()` and `dropStoredToken()` they would have gone green
  against code that no longer did either. They pin BOTH halves now — the helper does the
  work, and the caller still calls it. Same trap as `control-channel.test.mts` passing
  against a `restart-rc.ps1` that had stopped killing anything.
- **A CONTRIBUTING CAUSE WAS THE LEAKED TEST FIXTURES BELOW.** One of them fired
  `maybeAutoLogin` at 06:53 for a phantom hold "releasing in 1m", minting the short token
  that was still alive at 07:30 — which is exactly what triggered the short-circuit. Without
  them there would have been no token, no short-circuit, and a real sign-in.

### `npm test` TOLD THE PRODUCTION BOT TO CART A REAL CAMPSITE (2026-08-15)
An aborted real-DB test run left four `requested` holds with **numeric** unit ids on a real
ReserveCalifornia campground, and the mini-PC's hold runner spent fifteen minutes trying to
cart unit **9003 at Westport-Union Landing SB** — a site belonging to nobody, for a watch dated
2020, on behalf of `test-user-001`. **Nothing was locked only because the RC session happened to
be dead.** That is luck, and it is the whole finding.
- **THE SAFETY COMMENT WAS ABOUT THE WRONG PROCESS.** `rc-holds.test.mts` said "the fixture
  watch is dated 2020 so the poller's `end_date > CURRENT_DATE` filter can never see it, and
  every row is deleted on the way out." Both halves are true. Neither covers the **hold
  runner**: `dueHolds` selects on `release_at` alone, never joins `watches`, and does not care
  whether the watch is active or ancient. So the 2020 dates bought nothing on the one path that
  can lock a stranger's site, and "we delete on the way out" was the entire protection — which
  is precisely what an aborted run skips. **A safety argument that names a different consumer
  than the dangerous one is not a safety argument.**
- **IT WAS ALSO THE ~20s RC BROWSER CHURN the owner reported as "seems abnormal".** The runner
  asks the keep-warm for the Chromium profile on every attempt and polls every 15s, so the
  keep-warm yielded and reopened on that beat and the RC session could never stay alive —
  which then guaranteed every cart failed, which kept the rows `requested`, which kept the
  runner asking. Self-sustaining. Two symptoms, one cause, and the *cosmetic-looking* one is
  what surfaced it. **I first wrote this up as the duplicate elevated generation from 08-14
  and it was not** — that had already been fixed by a scheduled quiet-window update at 09:00
  UTC. Diagnosing it from the readout took one command; guessing took a paragraph of wrong.
- **The fix is a NON-NUMERIC sentinel unit id** (`U()` → `__t9003`), not better cleanup. Real
  RC unit ids are numeric, so a sentinel cannot collide with a real site — and unlike
  cleanup-on-exit that holds **during** the run too, which matters because a run lasts longer
  than the runner's 15s poll. Same rule `scripts/rc-test-hold.mts` already followed and that
  the hold suites never adopted. `before()` also sweeps leaked fixtures, so an abort self-heals
  on the next run instead of waiting for someone to read a dashboard.
- **`worker/hold-fixture-safety.test.mts` scans for it, and found TWO MORE FILES on its first
  run** — `expire-holds.test.mts` (8001-8005, one of them `requested` with a release five
  minutes past, i.e. squarely inside `dueHolds`' grace) and `rc-hold-capacity.test.mts`
  (7001-7003). Guarded mechanically because the dangerous line is `offer('9108', pacific(60))`
  next to nine identical neighbours, and it is only wrong because of a property of a different
  process on a different machine. Same family as `sql-routing.test.mts`.
  - The scan is **scoped to lines carrying a unit id**; the first version read whole files and
    flagged `'24'`/`'00'` inside the `pacific()` hour helper. A guard that cries wolf gets
    deleted, and it would take the real finding with it. The digit floor stayed at 2 rather
    than being raised to dodge that noise — a short real unit id is exactly the bad collision.
  - It also strips `U('…')` before matching, or it flags its own remedy and can never go green.
- **Mutation-verified against three regressions** (a fixture id put back to numeric, the sweep
  removed, the sentinel made numeric), each with an explicit assert that the mutation applied —
  a mutation that silently fails to apply is a green proving nothing.
- **Where the rows came from is NOT established.** They appeared at 13:35:2x UTC with no run in
  this session; `npm test` is serial per `docs/LANES.md` and CI runs it too. Do not write a
  culprit into this file. The live rows were `expired` (not deleted) so the evidence survives.

### THE FORCED KEEPALIVE SAMPLE NEVER RAN, AND THE BOX HAD BEEN ON STALE CODE FOR FOUR HOURS (2026-08-15)
`d85bc19` made `keepSessionsWarm` take its own memory reading, because the rec.gov Chromium
family lives ~5 seconds twice per 30-minute cycle and the 2-minute series samples it
essentially never. On 08-15 a real keepalive pass ran — `users.autocart_verified_at` moved at
05:31:27 and 05:32:15 UTC, 48s apart, which is its own 15-45s stagger, and only
`reportConnected` writes that column, after `withBrowser` returns — and **not one of the 250
rows in `chromium_memory_samples` carried `source = 'bot-keepalive'`.**
- **The cause was none of the three obvious ones. The RUNNING CODE was four commits old**, on a
  box whose checkout was current — the 08-14 trap again, by a new route. `e6a7ebf` contains
  **zero** occurrences of `bot-keepalive`, so the process could not take a forced sample at all.
- **FOUR INDEPENDENT INSTRUMENTS AGREED, and one of them had said so in plain English for
  hours.** (1) The keepalive fires on a fixed `setInterval` from process start, and 05:31:27 /
  06:01:27 fit **03:01:23 + 30m·n** exactly — seven consecutive fits — while the post-update
  process started 05:12:23 predicts 05:42:23 and 06:12:23, neither of which happened. (2) The
  sampler's in-memory interval phase is unbroken from 03:01:24, i.e. `last` never reset.
  (3) `rc_runner_heartbeat.bot_commit` read **`e6a7ebf`** against a `git-status` of `c1bd875`.
  (4) `autocart.bot_version` read *"mini-PC is on e6a7ebf; web is on 8a05308 — and it is MISSING
  bot-side changes."* **Nobody read it**, because its own next sentence explained the drift away.
- **`stop-all` SAID "nothing running." TWICE WHILE A WHOLE GENERATION WAS RUNNING.** Its filters
  are all `$_.CommandLine -and ...`, and an unelevated WMI query reads `$null` for a process in
  another security context — so an ELEVATED generation counts as **zero**, not as unkillable.
  The early return `if ($before -eq 0) { "nothing running."; exit 0 }` then fired **before the
  blind note and the broker-port check**, i.e. the one path where "I found nothing" is least
  trustworthy skipped both checks that exist to say so. Fixed: both are functions now, called
  from both paths, port check first, and the quiet path says *"nothing VISIBLE to stop"* when it
  was blind. **The port check alone would have stopped this dead** — 8787 was bound throughout,
  so `exit 1`, `start-all`'s `:stuck` branch, and the `taskkill` line printed for the human.
- **THE ELEVATION IS THE ROOT, AND IT IS WIDER THAN THE 08-14 NOTE SAID.** That note recorded
  "a `broker.mjs` started from an elevated prompt". It is the **whole 03:01 generation**: the
  proof is that `list-processes`, run by `bot.mjs` itself, prints the command line of broker pid
  15440 — the very process `stop-all` reported it could not read. Two components, one box, one
  instant, opposite views, decided only by elevation.
- **SO THE BOX CANNOT BE FIXED REMOTELY, AND THAT IS STRUCTURAL.** "Update now" is a no-op
  (`HEAD` is already at the target, so the guard has nothing to do), `restart-rc` goes through
  the same unelevated stop, and the watchdog has logged nothing since — consistent with it
  seeing all four payloads as healthy, which they are. **The fix is a human: an ELEVATED prompt,
  `mini-pc\stop-all.ps1`, then `start-all.bat` UNELEVATED** — elevated again just reloads the gun.
- **`autocart.bot_version`'s detail asserted a cause it cannot know.** `boxSha` is
  `git rev-parse HEAD` computed once **at process start**, so it reports the RUNNING code: an old
  sha means either the update has not been applied (self-heals) or it was applied and nothing
  restarted onto it (**never** self-heals). It named only the first. It names both now, plus the
  discriminator — `git-status` reads the checkout at the moment you ask. **Severity deliberately
  unchanged**; drift is normal for part of every day and turning it red is the cry-wolf failure.
- **THE SAME BLINDNESS WAS IN THE MEMORY SAMPLER, AND IT LEFT A ROW BEHIND.** At 05:12:24 the
  short-lived unelevated process stored `rc 0 procs, 0 MB` while pid 8844 was alive on both
  sides of it — the elevated process reported NINE at 05:11:52 and again at 05:13:51. Same
  filter, seconds apart, opposite answers, elevation the only variable. `C|` separates "found
  none of ours" from "never ran"; **"ran and could not see" is a THIRD state that reports
  identically to the first**, and the readout counts a zero as evidence and a null as nothing.
  The PowerShell emits `B|<count>` now, from the SAME `Get-CimInstance` filtered twice (two
  calls would make the ours/blind pair two readings a second apart, which is not a pair), and a
  scan that matched none of ours **while blind to some** reverts to null. **A PARTIAL reading
  keeps its numbers on purpose** — nulling it would delete real processes to express a doubt,
  and on a box where the owner's own browser runs as another user it would erase every reading
  for ever; the log line carries the doubt and says which way the row went.
- **The rec.gov family therefore remains sampled ZERO times** — see the entry above for why 175,
  now 250, consecutive `recgov 0` rows are the EXPECTED reading and not a lead. The instrument
  built for that family has still never run.
- Guarded in `worker/update-guard.test.mts` (reachability from the quiet path, order, one
  definition each, defined-above-use, and severity) and `worker/bot-version.test.mts`. Verified
  failing against six regressions including the restored early return and the port check present
  but dropped from the quiet path — the inert-fix shape that passes review.

### `query()` CANNOT WRITE — the routing bug class (2026-08-11)
`query()` goes to the `exec_select` RPC and `mutate()` to `exec_dml`, so **any
data-modifying SQL passed to `query()` throws, every time, forever.** Nothing about the
call site looks wrong: the two take the same arguments, return the same shape, and differ
only in an RPC name three files away — **TypeScript cannot tell them apart because the
difference lives in a string.**
- It shipped in three places at once and was found the first time a box could actually
  answer: `claimBotCommands` (`UPDATE .. RETURNING` through `query()`) threw on every call
  and its `.catch(() => [])` turned that into an empty list — **which is exactly what the
  feed returns when nobody has asked a question.** Two failure modes, one output.
  `claimBotUpdate` had it too, which would have made the update grant *permanently
  unwinnable*; `requestBotCommand` had it with no catch at all, so the admin "Ask" button
  would have 500'd. Only one of those three tells you.
- Both claims now report the failure instead of swallowing it. **"We could not ask" and
  "somebody else won the race" are different facts** — same family as
  `notifications.status = 'sent'` meaning only "Twilio returned 2xx".
- **`worker/sql-routing.test.mts` scans `src/lib` and `src/app`** for data-modifying SQL
  handed to `query()`. This is invisible by reading either file alone, so it is guarded
  mechanically or not at all.

### The control channel rides the ROSTER feed (migration 055, 2026-08-11)
On 2026-08-11 the RC hold runner died at 09:36 PT. It was the only process reading the
update flag and the diagnostics queue, so **the whole box went dark** — no update, no
diagnostics, no way to ask it one question — while `bot.mjs` polled the roster feed every
two seconds throughout, healthy and reachable the whole time. "The box is unreachable" and
"the RC runner is down" were the same event, and the second is the one you most want a
remote lever for, because it is the process that carts campsites.
- Both feeds carry it (`src/lib/bot-control.ts`), and both pollers read it through **one
  shared module** (`scripts/auto-cart-bot/control-channel.mjs`) — two copies would be two
  chances to fix one and forget the other, and the forgotten copy is by definition the one
  running when the other is dead.
- **THE UPDATE FLAG IS A CLAIM, NEVER GRANTED ON READ.** It briefly was granted inside
  `botControlFor`, i.e. on any GET — and the roster feed is polled every two seconds by a
  bot that, if it predates the control channel, ignores the `control` block entirely. That
  box would consume the grant within two seconds and throw it away, and the Windows
  scheduled task (the only thing that can update a stale checkout) would read
  `updateRequested: false` until the claim expired. **The lever disarmed itself on exactly
  the boxes that need it.** A poller that means to spawn the updater POSTs
  `{updateClaim: <actor>}` and is told granted or not. Same rule as the auto-cart
  entitlement being checked where it would be spent.
- **An unreachable claim is a NO.** An update is never urgent enough to risk two of them
  over one git checkout.
- **All four spawn paths claim now**, including the Windows scheduled task — it fires every
  5 minutes and `npm ci` outlasts that, so a second updater could move the checkout out
  from under the first. It claims **only when `requested` and never under `--force`**: a
  quiet-window update has no request to claim, so claiming unconditionally would refuse
  *every* scheduled update, which is the precise failure that file exists to avoid.
- `mini-pc\restart-rc.ps1` restarts the RC pair **only** — never `bot.mjs`, which is the
  process carrying the channel.

### The nightly RC login rehearsal (migration 054, 2026-08-11)
Three consecutive 08:00 holds failed and **all three failed AT LOGIN**. Every one was found
at 07:30 with twenty minutes to act, because the release was being used as the test. **It
is not the test; it is the exam.** `--test-login` could always have proved this — it was
never scheduled, so it only ever ran when somebody already suspected a problem.
- At 20:00 PT the keep-warm drops its **token only** (never the cookies — the `DT` device
  cookie is what stops a login looking like a fresh profile, and losing it is what cost 12h
  of IP block on 08-06) and runs the SAME body as `--test-login`, extracted into
  `runLoginRehearsal` so the two cannot drift. Result → `rc_login_rehearsal` →
  `autocart.rc_login`.
- **The gates are the design**, in `scripts/auto-cart-bot/rehearsal.mjs`: the rehearsal
  hour only, once per 20h, never within 6h of a release, never when the feed is
  unreachable, and **never when the session is LIVE** — `attemptLogin` short-circuits on
  `isLive()`, so it would return ok without exercising one line of the sign-in. **A pass
  that proved nothing is worse than a skip, because it reads as evidence.**
- **AND IT WALKED INTO THE BANNER TRAP ON ITS FIRST NIGHT.** It cleared the token, reloaded,
  got "not live", went hunting for a sign-in form — and RC's SPA re-authenticated in
  between, so there was no form and it reported the login as broken, quoting RC's *"You
  have a reservation arriving on today's date"*. **That banner is only ever rendered to a
  SIGNED-IN user.** It is evidence of success, and that is the SECOND time it has been read
  as the obstacle (the first, 2026-08-09, drove a dead-session verdict, two alarm calls and
  my telling the owner to sign in by hand over the session that carted a site fifteen
  minutes later). `attemptLogin` re-asked `isLive()` after the page load for exactly this
  reason; it just did not ask again at the OTHER exit — the one a mid-flight
  re-authentication lands on. It now returns `provedNothing` → recorded as **inconclusive**.
- **THAT RE-AUTHENTICATION IS ITSELF A LOOSE END — and pulling it found a real bug.**
  See "THE RENEWAL WAS MEASURING ITSELF" immediately below.

### THE RENEWAL RUNS ON THE BOX — CONFIRMED 2026-08-16 01:53 UTC
Read straight off `tail-log rc-keepwarm`, from a genuinely token-less profile:
```
01:52:18 renewing the session — the app holds no usable token (src=none)
01:53:05   ✓ renewed by authorize: none → 3580s
01:53:19    renewal stood down: the token has 59m left
```
**`none → 3580s` is the strongest form this evidence could take.** The `before` was NOT a
token, so "the previous token was put back" is not available as an explanation — a restored
stale copy carries its OLD expiry, which is exactly what the failures below show. A full
3580s is a fresh mint, by the CLICK stage, with no credential typed. The ration then works in
the other direction fourteen seconds later. **The reliable cell of the 2x2 is proven in
production.**

#### THE NEAR-EXPIRY CELL FAILS, AND THE DOCUMENTED READING OF `none` IS WRONG
Twice within fifteen minutes, on the same box, the same night:
```
02:43:31 renewing the session — the token has 9m left (src=live)
02:44:29   ✗ no fresher token (554s → none), got as far as: none — the previous token was put back
02:44:29     cleared 3 storage key(s): accessToken, okta-original-uri-storage, ssoAccessToken
02:54:40 renewing the session — the token has -2m left (src=live)
02:56:27   ✗ no fresher token (-115s → none), got as far as: none
02:56:27     cleared 2 storage key(s): accessToken, ssoAccessToken
```
- **`got as far as: none` WITH `okta=ALIVE` ON THE ADJACENT LINE.** The handover said "`none`
  repeatedly is a dead Okta session, and that is the honest negative the design wants". **That
  reading is falsified.** Okta was alive for both attempts (`exp 2026-08-16T13:53:31` printed
  in the same second). So `none` means the click found no control OR the round trip produced
  nothing — it does NOT license a conclusion about the Okta session. Do not read it as one.
- **The second attempt ran on an ALREADY-DEAD token (`-2m`) and still failed**, which is the
  cell the schedule was extended to cover. So the extension fires correctly and the underlying
  re-mint still does not happen from this state.
- **The two clears emptied DIFFERENT key sets** — 3 keys including `okta-original-uri-storage`,
  then 2. That is the `okta-` sweep finding something once and nothing the next time, and it is
  a fact worth having rather than a tidy story: whatever the SPA rebuilds between attempts is
  not stable.
- **The token was NOT restored by the renewal.** `03:01:33 renewal stood down: the token has
  59m left` is the rehearsal's doing, not the schedule's — see immediately below. Attributing
  that recovery to the renewal would be the third time this file credited a repair to the
  wrong mechanism.

### THE LOGIN REHEARSAL PASSED — FOR THE FIRST TIME IN ITS LIFE (2026-08-16 03:00 UTC)
```
03:00:33 ── nightly login rehearsal: proving the bot can still sign itself in ──
03:00:34 Session before the test: DEAD — RC rejected the token (401)
03:00:34   cleared 0 key(s): (none)
03:00:40     → clicked a:has-text("Log in") → signin.reservecalifornia.com
03:00:40     → Okta skipped the email step — it remembers this account
03:00:44 ✓ the bot can still sign itself in — tomorrow morning has a session behind it
```
**The entry below says the instrument has produced exactly one verdict in its life and that
verdict was "I proved nothing". It has produced a second, and it is a PASS.**
`autocart.rc_login` reads *"the bot signed in unattended 6m ago"*.
- **It fired at 20:00 PT, its own hour**, with the release 12h out — comfortably past the 6h
  gate — so all four gates were satisfiable and it ran. That is the first time the schedule
  has been observed working end to end.
- **It was NOT a banner-trap false pass.** `Session before the test: DEAD — RC rejected the
  token (401)` is RC's own answer, and the clear reported `0 key(s)` because the profile was
  already empty — so a credential really was submitted and the sign-in really was exercised.
  That is precisely the distinction `provedNothing` exists to draw.
- **`Okta skipped the email step — it remembers this account`** is the `DT` device cookie
  earning its keep, and the reason the "never lose the profile" rule is not superstition.
- **AND IT IS WHAT RESTORED THE SESSION**, not the renewal — the 59m token at 03:01:33 comes
  from this login. Two repairs ran within twenty minutes of each other and only one worked;
  crediting the wrong one is how a broken mechanism keeps its reputation.

### THE LOGIN REHEARSAL HAS NEVER PASSED, AND IT DID NOT FIRE ON 08-12
Observed 2026-08-12 22:29 PT, with three holds queued for the next morning.
`rc_login_rehearsal` holds **one row**: `ran_at` 2026-08-11 20:02 PT, **`ok` NULL**,
`skipped_why` = *"inconclusive — RC re-authenticated from the live Okta session before the
form hunt"*. So the instrument has produced exactly one verdict in its life and that verdict
was "I proved nothing" — which is the banner trap being caught correctly, not a fault.
- **Tonight's 20:00 PT window then passed with `ran_at` unmoved**, i.e. nothing attempted it.
  Cause NOT established, and do not guess one into this file — the four gates (the 20:00
  hour, once per 20h, never within 6h of a release, never when the session is live) all look
  satisfiable at 20:00 on 08-12, so the answer is somewhere else.
  **Two of those four are now arithmetically ruled out (2026-08-13):** the last run was
  08-11 20:02 PT so the gap at 20:00 on 08-12 was ~24h against a 20h minimum, and the
  release was 12h out against a 6h minimum. Only `sessionLive === true`, an unreachable
  feed, or the process not being alive during hour 20 remain.

- **AND THE REASON IS UNRECOVERABLE, BY A BUG IN THE INSTRUMENT'S OWN BOOKKEEPING
  (found + fixed 2026-08-13).** `maybeRehearse` gates its skip-record on one variable so a
  skip is written once a night instead of on every poll through the hour. That variable
  held the **hour number** (`rehearsedThisHour = hour`) and was **never reset** — so it
  latched at 20 for the life of the process, and the first night the hour was reached was
  the *only* night that could record anything. Every night after it, a skip wrote nothing
  and logged nothing.
  - So **"a gate stood it down, and here is which one" and "the process never reached
    20:00" produce the identical evidence: silence.** That is the house failure shape
    (`status = 'sent'` meaning only "Twilio returned 2xx"; `claimBotCommands` returning
    `[]` for both "nobody asked" and "the query threw") — this time inside the watchdog's
    own watchdog, which is why 08-12 cannot be diagnosed retroactively and 08-14 onward can.
  - Fixed with `rehearsalSlot()` in `rehearsal.mjs` — a **Pacific date**, null outside the
    rehearsal hour. A date cannot latch: tomorrow's window has a different key. Keyed on
    Pacific and not UTC deliberately, or the slot would roll at 17:00 PT, mid-evening, and
    disagree with `pacificHour()` across a DST boundary.
  - `worker/rehearsal.test.mts` verified failing against **both** halves: a latching slot,
    and the caller reverting to the bare-hour comparison — *the fix present but inert*,
    which is `6006428` and the `--claimed` omission, and the version that passes review.
  - **This is bot-side code, so it needs an `update.bat` or a quiet-window update to reach
    the box** — and the 02:00–05:00 window is shut while holds are `requested`. It changes
    nothing about whether a cart fires; it only makes the next silent night explain itself.
- **IT IS NOT THE 2026-08-10 WEDGE, and that is the distinction that matters at 07:30.** That
  failure was the keep-warm going silent for ten hours and taking `maybeAutoLogin` down with
  it. Here the keep-warm reported **45 seconds** before the reading, so the loop is alive and
  the 07:30 sign-in still runs. A missing rehearsal costs the ADVANCE WARNING, not the repair
  — check the keep-warm's report age before treating the two as the same event.
- The health line reads *"no rehearsal has PASSED in 26h27m"*, which is accurate and easy to
  misread as a regression: nothing has ever passed, so there is no green to have lost.

### THE RENEWAL QUESTION IS ANSWERED (2026-08-15 evening) — and the answer is "stop renewing"
The corrected clear reached the box (`d72fb2e`) and produced the first honest reading. Read
straight off `tail-log rc-keepwarm`, twice, an hour apart:
```
20:08:53 token has 9m left (src=live) — renewing by reload
20:09:19   ✗ no fresher token after the reload (565s → 540s) — the previous token was put back
20:09:19     cleared 3 storage key(s): accessToken, okta-original-uri-storage, ssoAccessToken
21:08:36 token has 9m left (src=live) — renewing by reload
21:09:02   ✗ no fresher token after the reload (553s → 528s) — the previous token was put back
```
- **`renewByReload` DOES NOT WORK, and this reading is finally entitled to say so.** The
  clear now reaches the `okta-` namespace and names what it emptied, so the negative is real
  rather than an artifact of clearing the wrong keys. The token still comes BACK 25s older,
  so **a persisted copy survives all three keys** — not sessionStorage-vs-localStorage
  guesswork, a fact forced by the measurement. Where it lives is still unknown; the
  remaining candidates are IndexedDB, a cookie, or a key name nothing has looked for.
- **THE `okta-` PREFIX ASSUMPTION WAS HALF RIGHT.** The sweep ran and found exactly ONE
  `okta-` key — `okta-original-uri-storage`, which is a redirect breadcrumb, not a token
  store. So okta-auth-js is **not** keeping tokens under `okta-` in this profile, and the
  three-way prediction in the old handover ("more than 2 keys ⇒ honest negative") needs that
  qualification: it listed three, but the third was not a token.
- **RC ISSUES NO REFRESH TOKEN AT ALL** — the single most useful line in the log, and it
  changes the shape of the problem:
  ```
  grant: {"hasRefreshToken":false,"expiresIn":3600,"scope":"openid profile email"}
  ```
  There is nothing to silently refresh WITH. Every "make the token renew itself" plan was
  reaching for a mechanism RC does not hand out. Stop looking for one.
- **BUT THE BOOTSTRAP RE-MINTS, WITH NO CREDENTIAL TYPED**, and that is the path forward:
  ```
  19:18:57  ✓ already signed in — RC re-authenticated before any form appeared,
            so no sign-in was exercised — token now 59m, needs 21m (covered)
  ```
  **59 minutes is a FULL-LIFETIME token, which is what separates this from the 08-11
  confound**: a restored stale copy would carry its old expiry (that is exactly what
  20:09:19 shows — 540s). A fresh hour means RC minted a new one from the live Okta cookie.
  The Okta session runs ~12h (`okta=ALIVE (exp 2026-08-16T10:09:03)` against a 22:09
  reading), so within that window a bootstrap costs nothing and needs nobody.
- **SO THE AUTOMATION ANSWER IS: DON'T RENEW THE TOKEN, RE-RUN THE BOOTSTRAP.** That is
  `attemptLogin`, which already short-circuits into the line above when the Okta session is
  alive. What is missing is only its SCHEDULE — today it fires at T−30 of a real release, so
  between releases the token dies and stays dead (the `⚠ RC SESSION IS DEAD … okta=ALIVE`
  lines, hours of them). Nothing is broken there; nothing is trying.
- **`renewByReload` should NOT be deleted on this reading.** It is the instrument that
  produced it, it now reports honestly either way, and its restore guard means a failed
  attempt costs nothing. Retire it when a bootstrap-on-a-schedule is proven, not before.

### WHY THE RELOAD FAILED: A PLAIN LOAD IS NOT THE BOOTSTRAP — THE CLICK IS (2026-08-15, later)
The section above is right that the reload does not renew and right that the bootstrap does.
It is wrong about **why**, and the correction is the whole fix. "RC will not renew" was never
the finding available; **nothing was asking it to.**
- **THE 2x2 IS COMPLETE, off one evening of `tail-log rc-keepwarm`, and every cell is
  reproduced:**

  | | token present, short | no token at all |
  |---|---|---|
  | **plain load** | no re-mint (4x: 18:18, 18:25, 20:08, 21:08) | no re-mint (2x: 18:46, 22:22) |
  | **sign-in click** | not observed to work (1x, see below) | **59m token (2x: 19:18, 22:26)** |

  The negative controls are the valuable half and they were sitting in the log all along:
  `RC loaded and STAYING OPEN — token source: none` at 18:46:50, then **thirty minutes and
  two twenty-minute checks** with `okta session STILL ALIVE` and nothing appearing. A plain
  navigation, from a genuinely token-less profile, against a live Okta session, produces
  nothing. Then `19:18:38 clicked a:has-text("Log in")` → `19:18:57 token now 59m`.
- **MECHANISM, and it follows from the pair rather than preceding it:** with no token in
  storage RC's SPA renders signed-out and simply sits there — it issues no `/authorize` of
  its own. The sign-in control starts the authorization-code flow; Okta answers it from the
  `idx` cookie without showing a form; RC exchanges the code for a fresh hour. `renewByReload`
  cleared correctly and then did the one thing that cannot work. **The clear was necessary
  and never sufficient.**
- **`hasRefreshToken:false` stands and is unaffected.** There is nothing to *silently
  refresh* with, and there never was. What re-mints is a full authorization-code round trip
  that costs no credential because Okta already knows the device. Do not read this entry as
  reopening the refresh-token question.
- **SO THE FIX IS TWO STAGES AND A SCHEDULE, NOT A NEW MECHANISM.**
  `renewByReload` is now **`renewSession`** (renamed, because a name describing half of what
  a function does is what this file keeps paying for) and runs the reload, then — only if the
  reload produced nothing — the click. **The result says WHICH stage minted the token**:
  `reload` would mean the SDK's own bootstrap has started working and this can be simplified
  back down, `authorize` is the expected success, and `no-signin-control` is separated from
  `none` because they need different responses.
- **THE ONE OBSERVED CLICK FAILURE IS THE KNOWN WEAK CELL, and it is the near-expiry one.**
  At 18:22 `attemptLogin` dropped a live-but-short token, and the SPA went on rendering its
  signed-in banner — so no `a:has-text("Log in")` anchor existed, `button:has-text("Login")`
  matched something else, and nothing was started. That is the surviving-persisted-copy
  finding showing up from the other end. **Expect the near-expiry path to fail sometimes;**
  the token then expires, the profile becomes token-less, and the reliable cell takes it on
  the next pass. Cost is minutes, not the night.
- **`worker/renewal-schedule.test.mts` decides WHEN** (`scripts/auto-cart-bot/renewal-schedule.mjs`),
  and the case it adds is the one the old loop refused outright:
  - The old condition was `left != null && left > 0 && left < RENEW_BEFORE_S`, i.e. act on a
    nearly-dead token and **never** on an already-dead one. Defensible clause by clause and
    wrong as a whole: a signed-out profile is where a re-mint is both **free** (nothing to
    clear, nothing to restore) and worth most. **It cost ninety dead minutes in one evening**
    — 18:47→19:18 and 21:29→22:25 — both repaired only because somebody happened to queue a
    hold, since `maybeAutoLogin` was the sole caller.
  - Rationed on **its own terms, not the login's**: a floor (5m) honoured whatever changed, a
    gap (10m) for repeating an unchanged state, a backoff (30m after 3 consecutive failures)
    that **never becomes a stop** — a gate that switches itself off for good is the
    `.camphawk-ready` bug. A re-mint is not a login: no credential is submitted, no form is
    filled, and the CAPTCHA that stops `attemptLogin` lives on the password form this never
    reaches. It therefore does NOT spend the one-attempt-per-release budget.
  - **The ration lives at MODULE scope.** `warmResident` reopens its browser every time the
    hold runner wants the profile — ten times in four hours on 08-15 — so state inside that
    loop would bound nothing at all.
  - **Okta is probed only when there is a token to lose.** `/api/v1/sessions/me` refreshes
    Okta's own idle timer, so asking on every attempt extends the very window whose length
    we are trying to learn. The probe guards the DESTRUCTIVE clear; with no token there is
    nothing to clear, so it guards nothing and is skipped. The attempt is self-diagnosing —
    a dead Okta session lands on the form and reports `stage: 'none'`.
- **`maybeAutoLogin` IS DELIBERATELY UNTOUCHED.** It remains the release-critical path with
  its own budget at T−30. This is a background improvement; if it were also the release
  repair, one bad night of renewals would spend the ration that protects an 08:00 cart.
- **The dedupe keys on a STATE, not on the sentence** — every stand-down reason carries a
  minute count that changes on every 60s ask, so `autoLoginSkip`'s direct string comparison
  would collapse nothing and print 1,440 lines a day. It also had to MOVE into the tested
  module: as six lines in `rc-keepwarm.mjs` it was pinned by a regex on its own shape, and a
  mutation reinstating the volatile comparison **from inside the body** matched that shape
  and passed. A source scan cannot see through a function it can only pattern-match.
- **27 mutations, each asserting the mutation applied.** Two are worth keeping: the one above,
  and `clickSignInControl`'s extraction tripping `rc-autologin.test.mts`'s **pinned export
  list** — which is the "an existing guard pinned it by name" rule working as designed, and
  the list is pinned precisely so adding to it is a decision with a written reason.
- **BOT-SIDE, so none of this is live until the box updates.** `autocart.bot_version` is a
  hint; `git-status` through `bot_commands` is what answers "did it land?". **Nothing here is
  proven until the log shows `✓ renewed by authorize` on the box** — the evidence above is
  two hand-triggered reproductions of the mechanism, not one run of the schedule.

### THE RENEWAL WAS MEASURING ITSELF (2026-08-12) — the keep-warm question is REOPENED
`renewByReload` has been reporting "RC will not renew" since it shipped, and **it was never
asking RC anything.** From the box's own log:
```
00:06:09 token has 10m left (src=live) — renewing by reload
00:06:10   ✗ reload did NOT mint a fresher token (575s → 575s)
```
**One second, and `before === after` to the second.** A navigation plus an SPA bootstrap
plus an OIDC round trip cannot happen in a second, and a real failure does not hand back the
identical number — that is the same token being read straight back.
- **Mechanism, established from the code, not guessed:** the function deleted
  `window.__camphawkRcToken` (our own captured copy) and left **localStorage** alone. That
  is the copy okta-auth-js decides from, so with a still-valid token there the SDK issues no
  `/authorize` at all; the app then makes its first API call with that same token, the
  capture hook records it as `source: 'live'`, and `primeToken` returns it instantly. **The
  renewal was measured against the very token it was supposed to replace.**
- **The counter-evidence was in the same night's log.** The login rehearsal clears
  `ssoAccessToken`/`accessToken` and reloads — and RC re-minted a token from the live Okta
  session within seconds, **no credential typed**. So the BOOTSTRAP path works; it is the
  SDK's background `autoRenew` that does not. Clearing storage is what chooses between them.
- **`idx` IS in the profile now** — `DT, ln, [opaque], luf_*, idx, JSESSIONID`. That is
  Okta Identity Engine's session cookie, and "no `sid`, no `idx`" is what the whole
  "nothing to keep warm" verdict was built on. It appeared once `keepSignedIn()` started
  being ticked. The failure line meanwhile blamed *"the Okta cookie may be gone"* with
  `okta=ALIVE` on the adjacent line — **a diagnosis contradicted by the field next to it.**
- **What is now true:** the evidence for "RC will not renew" was worthless, and there is one
  positive observation that it will. That is **not** a solved keep-warm — one observation is
  not a measurement, and this file has been burned twice by treating one for the other. The
  fixed code makes the next attempt a real test and reports honestly either way; it should
  answer within a token lifetime of reaching the box.
- ~~**IT ANSWERED ON 2026-08-15, AND THE ANSWER IS NO.**~~ It ran and it failed:
  ```
  14:43:53 token has 10m left (src=live) — renewing by reload
  14:44:19   ✗ no fresher token after the reload (578s → 552s) — the previous token was put back
  ```
  **It was NOT a real test either, and the heading above is left struck through because
  believing it was is the mistake.** `after` is not null — a token came BACK, 26 seconds older
  than the one dropped, i.e. the same token. A navigation wipes JS memory and
  `window.__camphawkRcToken` was deleted, so **it can only have come from another PERSISTED
  copy**. That is forced by the measurement, not inferred.
- **THE CAUSE: `ssoAccessToken`/`accessToken` ARE RC'S OWN COPIES, NOT THE SDK'S.** okta-auth-js
  namespaces its own store under `okta-` and that is what it decides from on boot, so clearing
  two keys of the blob left the SDK holding the token and handing it straight back — no
  `/authorize`, nothing asked of RC at all. `rc-probe.mjs` had recorded the same fact from the
  other end months earlier: *"the whole session lives in localStorage, and copying that blob
  DOES carry the login"*. **The clear was reasoning about two keys of a session that lives in
  many.**
- **SO THE TWO CLEARS NEVER DISAGREED — THEY WERE THE SAME INCOMPLETE CLEAR.** This entry
  previously called the disagreement "the whole open question" and said nobody had diffed them.
  Diffed 2026-08-15: the rehearsal's clear was a THIRD hand-rolled copy of the identical two
  `removeItem` calls. **So the 08-11 "RC re-minted from the live Okta session with no credential
  typed" observation is CONFOUNDED** — an incomplete clear produces exactly that appearance,
  because the app comes back signed in on a token that never actually left. Nobody recorded
  whether it had a FRESH expiry, so it cannot be told apart after the fact.
- **THAT IS THE 08-12 BUG IN A SECOND COSTUME**, and it is the reason to be careful here: the
  original was "the renewal measured itself against the token it meant to replace", and this is
  "the evidence FOR renewal was produced by the same failure to delete it". Two of the three
  observations this file has treated as proof that RC will renew are now unusable. The third
  (the mobile app probe, 08-13) went through a different code path and is untouched.
- **WHAT IS ACTUALLY KNOWN: nothing either way.** Do NOT record "RC will not renew" — no clear
  that reached the SDK's storage has ever been tested. Do NOT record that it will. The clear is
  correct now (`dropStoredToken` covers `okta-` too, with an exact-restore snapshot) and it
  **reports the key names it emptied**, so the next run on the box is the first real reading.
  If a failure ever lists only the two RC keys again, the `okta-` prefix assumption is what
  needs revisiting.
- **`maybeAutoLogin` stays exactly as it is** until renewal is *proven*. A renewal that
  works is what would retire it; a renewal that is merely plausible is not. (Reinforced
  2026-08-15: it is now the ONLY thing standing between a queued hold and a missed cart.)
- **The clear is DESTRUCTIVE, so the fix is guarded three ways** — never on an explicit
  `alive: false` from Okta (`null` is "we could not tell" and still attempts, or one hiccup
  disables renewal forever), judge on a token that is genuinely *different* rather than
  merely live, and **restore the exact keys that were emptied and reload** if nothing
  fresher arrives, so the worst case is no worse than doing nothing.
  `worker/rc-token-renew.test.mts` was verified failing against all four regressions.

### Never offer a hold when there is no bot to honour it (2026-08-11)
The RC pair stopped at 09:36 PT and nothing noticed for over two hours — `autocart.bot`
stayed green because the rec.gov bot kept beating, the same trap as 08-07. Meanwhile the
poller went on offering "Hold it for me"; the last went out **two hours into the outage**.
**The cost is not the failed cart — it is that a user who believes the site is handled
STOPS WATCHING**, so a morning they could have won with an alarm clock is lost instead.
`rcBotUsable()` reads the **runner heartbeat**, not the session: a dead session is a
pending repair (`maybeAutoLogin` at T−30) and refusing on it would be the 08-09 cry-wolf;
a missing runner is different, nothing is coming to fix it. Two enforcers — the poller
withholds the BUTTON (still sends the coming-soon alert, which is the part the user can
act on) and the `hold` action refuses too, because a link outlives the alert that carried it.

### MUTING A SITE DID NOTHING TO ITS COMING-SOON ALERTS (2026-08-13)
Reported as *"I got an alert for a muted site at Carpinteria."* `findRCOpenUnit` has taken
an exclusion list since site-mute shipped; **`findRCHeldUnits` — the coming-soon path, which
announces a unit the night before it releases — never did**, and the poller never passed
one. So a mute silenced the availability alerts and did nothing whatever to the coming-soon
alerts for the same site.
- The data: watch `768b5c36` (Carpinteria Santa Cruz), unit **4667 (`#C218`)**, one of 41
  muted ids, sent push + SMS + email as `kind=coming_soon` at 19:43:37. `#C203` did the same
  on 08-12.
- **The half that silently did nothing was the half that mattered more.** Coming-soon is the
  noisier path — a held unit re-announces itself ahead of every release — which is why the
  user noticed the mute "not working" rather than "working for some alerts".
- **THIS IS WHY THE 2026-08-09 VERIFICATION MISSED IT.** That check proved the WRITE
  persisted and that `/manage/<token>` listed the mute back. **Nothing checked that a reader
  honoured it**, and a feature whose write half works and whose read half is absent is
  indistinguishable from a working feature until somebody gets the alert. When verifying a
  feature end to end, the end is the CONSUMER, not the round-trip through the API that set it.
- `worker/site-mute.test.mts` holds both finders and the poller's call sites. It is scoped to
  **watch-scoped** calls: `findRCOpenUnit` is also called from the plain "is anything free in
  this range?" helper, which has no watch and correctly has no mute list. **The first version
  of that test failed at baseline on exactly that call** — a guard written from the shape of
  the bug can be wrong about the rule.
- It also pins `String(unit.UnitId)`: the id is a NUMBER and `muted_site_ids` is `text[]`, so
  an unstringified compare silently never matches and reads as "no mutes are set".

### Auto-cart alerts lost the site id and the kind (2026-08-11)
Reported as *"a bunch of duplicate texts for the same site"*. Silver Lake 044:
`06:32 kind=available id=85946` (the main lane, correct), then **08:08, 13:08, 15:13 all
`kind=undefined id=undefined`**. Every alert the auto-cart lane produces is replayed from
one stored payload built by `autocartPayload()`, and that payload **never included
`campsiteId`**; the reconciler's fallback then dispatched it bare, so `kind` was undefined too.
- The booking link degrades to the whole **campground** with no site id, so alerts for
  different sites arrive looking identical — that is the "duplicate" appearance.
- **`campsiteId` is the MUTE TARGET.** `lib/notifications` builds the mute link from it
  alone, so the one control that would stop a noisy site was missing from precisely the
  alerts causing the noise.
- The row cannot be attributed to a site afterwards — **my first pass at "am I getting
  duplicates?" partitioned on `campsiteId` and silently excluded every broken row.** The
  analysis missed the bug for the same reason the alert was broken.
- **NOT a dedupe failure**: the per-site claim held throughout. The job row has carried
  `campsite_id` in its own column the whole time; only the payload lost it, which is the
  tell that this was an omission — and no type caught it because the fields that matter on
  `NotificationPayload` are all optional. `worker/autocart-payload.test.mts` pins the full set.

### "The auto-login has had its turn" was said 15 minutes early (2026-08-12)
`autocart.rc_session` read **fail** at **T−34** with *"the auto-login has had its turn — run
mini-pc\rc-login.bat"*, while `maybeAutoLogin` had not run at all. It ran at ~T−31 and signed
in unattended. **Anyone acting on that sentence would have driven to the box over a session
that repaired itself four minutes later** — the 08-09 cry-wolf, a second time, in the one
check the 07:40 pre-flight reads.
- **ONE CONSTANT WAS DOING TWO JOBS.** `RC_SESSION_CRITICAL_MIN` (45) is when a dead session
  starts to MATTER; it is not when the repair is spent, which cannot be sooner than the login
  runs (`RC_AUTOLOGIN_LEAD_MIN`, 30). The alarm gate learned this on 08-09 and gates on
  `ALARM_AFTER_MIN` (25) plus a definitive `auto sign-in failed`; the health check kept the
  naive version, **directly beneath the long comment explaining the lesson it was breaking**.
- `RC_SESSION_REPAIR_SPENT_MIN` is that number, **shared with the alarm** so the page and the
  phone cannot disagree about whether a repair is pending. A reported failure outranks the
  clock, as it does for the alarm.
- Also replaced a bare `30` in the message string with `RC_AUTOLOGIN_LEAD_MIN` on the web
  side. That sentence is read by a human deciding whether to intervene.
- `worker/autologin-lead.test.mts` pins the two windows apart and requires the spent window to
  equal the alarm's; verified failing against both the 45-minute constant and the old
  expression. **Ruled out first:** `d1ab782` already carried lead 30, so this was NOT the
  two-halves-deploy-by-different-routes gap.

### Health severity — two false alarms that would have paged all night (2026-08-11)
Now that the health Routine notifies, a wrong `fail` is a phone call every two hours.
- **`autocart.rc_session` failed on ANY hold ahead.** Tapping a hold at 18:34 turned it red
  for thirteen hours before the release, over a system behaving exactly as designed: the
  token lives ~1h, so the session is legitimately dead most of the day, and
  `maybeAutoLogin` signs in at T−30 unattended. **Dead and stale are now different faults**
  — `dead` = the keep-warm is alive and reporting honestly, repair SCHEDULED, fails only
  within `RC_SESSION_CRITICAL_MIN` of the release; `stale` = the keep-warm is not reporting,
  and `maybeAutoLogin` lives INSIDE it, so the repair is *absent* rather than pending —
  unchanged, fails on any hold ahead. That is 2026-08-10 exactly.
- **The detail line asked a human to do what the bot does at 07:30.** It said *"a human must
  run `rc-keepwarm.mjs --login`"* on every dead verdict. On 08-09 I read that line and told
  the owner to sign in by hand, over the session that carted a site fifteen minutes later.
  **A check that asks for work the machine is about to do itself trains people to ignore the
  one that matters.** The manual instruction survives only for the case where it is true.

### Diagnostics that fail invisibly — three from one evening (2026-08-11)
All three had the same shape: **the failure produced the same output as the healthy case.**
- **`tail-log` hung on a BOM-less UTF-16 log.** Redirected PowerShell output is UTF-16LE
  with **no BOM**, so every branch of `readTextFile` missed it and decoded as UTF-8, putting
  a NUL between every character. **Postgres text cannot hold a NUL**, so the answer was
  unstorable, nothing was written, and `finished_at` stayed NULL — which reads on the admin
  page as "picked up, no answer yet", indistinguishable from a wedged command. Three fixes,
  because any one alone still fails invisibly: detect BOM-less UTF-16LE by sampling NULs on
  odd offsets (cannot false-positive — real UTF-8 never contains a NUL), strip NULs in
  `scrub` unconditionally, and **retry a failed report WITHOUT the output** so the row always
  closes. An error line that arrives beats a result that never does.
- **`auto-update.ps1` reported every run and was answered 401.** The task IS registered and
  IS firing; its own log said so, and said in the same breath that every report was
  rejected. `AUTOCART_TOKEN` lives in `scripts/auto-cart-bot/.env` and **a Windows Scheduled
  Task has no parent environment to inherit from.** That is indistinguishable from a task
  that was never registered, and **I read it exactly that way for hours** — concluded "no
  scheduled task, no overnight self-heal" from an absence that was really a rejection. Same
  trap `update-guard.mjs` was fixed for with `loadEnv`, in a sibling file: the fix went to
  the thing that READS the answer and not to the thing that REPORTS it. `Import-BotEnv` is
  defined at the top and called **before the first `Report-Attempt`** — PowerShell runs
  top-down, and a call above its definition dies with "not recognized".
- **`restarts.log` drops its lines exactly when a stop fails.** A remote update reported
  "REFUSED — processes would not stop" and the log held the opening line and nothing else.
  Every supervisor and every stop path appends to one file, and Windows file locking makes
  all but one writer fail while it is held — **contention PEAKS during a stop**, because
  four supervisors write their own "exited" lines at that same moment. So the log is least
  reliable at the only time anyone reads it. `supervise.ps1` was fixed hours earlier and its
  siblings were not, so the test now asserts across the **directory**: any `.ps1` writing
  `restarts.log` must retry, must state UTF8, and must write to the console BEFORE the file.

### `update.bat` reported the wrong commit, and node still crashes on the way out
- **`update.bat` never reported what it landed on.** `auto-update.ps1` reports through
  `Report-Applied`; the manual path did not, so the admin panel kept showing the last
  *unattended* result — "37e1527, REFUSED" — while the box was happily running `d1ab782`.
  That is the field you check to find out whether a fix arrived, and it misled me twice in
  one evening. `report-applied.mjs` now reports the real `git rev-parse HEAD`.
- **The libuv crash is NOT fixed, whatever the comment said.** `update-guard.mjs` still exits
  with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`; swapping
  `AbortSignal.timeout` for a manual `AbortController` did not do it. Harmless **today only**
  because `auto-update.ps1` reads the verdict LINE and never the exit code — that reading is
  the mechanism keeping updates working, not belt-and-braces. Likeliest cause is the
  keep-alive socket undici leaves pooled (exiting tears the loop out from under it; not
  exiting risks never draining — two symptoms, one cause). **A comment asserting a fix that
  did not work is worse than no comment**, same as `6006428` claiming to fix the RC URL while
  only touching the copy.

### `autocart.bot_version` — does the box run the code master has? (migration 056, 2026-08-12)
`autocart.rc_runner` proves the box can reach camphawk.app; `autocart.rc_session` proves RC
accepts its token. **Neither said which CHECKOUT was doing either**, and "the halves deploy
by different routes" is the most expensive recurring failure in this log — it caused the
T−30/T−25 alarm gap on 08-11, and an evening of reading "37e1527, REFUSED" on the admin page
while the box happily ran `d1ab782`. `git-status` via `bot_commands` could answer it, but
only when a human **asks**; this is the passive version.
- Runner computes `git rev-parse HEAD` + `git log -1 --format=%cI` **once at startup** (the
  checkout cannot change under a running process — the updater stops it first) and sends
  them as headers on the feed poll it already makes. A git failure omits the headers; it
  must never take down the runner.
- **TWO columns, because a sha alone cannot answer the question.** A sha says the box
  *differs*; it cannot say what is missing, because a server with no checkout cannot compute
  ancestry. Master is linear, so a box whose HEAD **predates the last commit touching
  `scripts/auto-cart-bot/`** is missing bot-side code. `next.config.ts` bakes the deploy sha,
  its date, and that bot-code date at build time.
- **The severity is the part that needed thinking.** Drift is NORMAL for part of every day
  (Vercel deploys on push; the box waits for 02:00–05:00 or a human), so failing on
  "different shas" would be red most mornings — the cry-wolf failure already fixed twice.
  **`fail` only for missing bot-side code AND a hold queued**; that is the one configuration
  where the halves can disagree at a release. `pages: false`.
- **Every unknown is a warn, never an ok** — an old runner, no git on the box, or a shallow
  Vercel clone that cannot find the last bot-side commit. The detail names which evidence is
  missing.
- `COALESCE` on the UPDATE so an old runner cannot **erase** a commit a current one reported
  (stale + `beat_at` is readable; NULL is not), and the header is validated as 7–40 hex
  before storage — any holder of `AUTOCART_TOKEN` sets it and it renders on the admin page.
- **AND THAT COALESCE IS WHY `autocart.bot_version` CANNOT BE TRUSTED TO ANSWER "DID IT
  LAND?" (2026-08-14).** Measured: `git-status` reported `HEAD 60d9b98 on master` while
  `bot_commit` sat at **`7780c32`** — the pre-update commit — **steadily**, sampled eight
  times over 90 seconds, with `beat_at` advancing every 15s the whole time. A poller that
  cannot compute its own sha omits the header (by design, so a git failure never takes the
  runner down), COALESCE then preserves the last value anyone did report, and the result is a
  **stale sha sitting next to a live heartbeat, which reads as current.** Exactly the shape
  this file keeps recording: two facts of different ages presented as one record, like
  `appliedNote` and `appliedSha`.
  - **The authoritative answer is `git-status` through `bot_commands`**, which runs
    `git rev-parse HEAD` on the box at the moment you ask. Use that to confirm an update;
    `autocart.bot_version` is a hint, and a warn from it may mean "nobody reported" rather
    than "the box is behind".
  - It cost real confusion here: the field read `60d9b98` right after one update and
    `7780c32` afterwards, which looked like the box rolling BACKWARDS. It had not — the
    checkout never moved from `60d9b98`.
  - **Do not "fix" this by dropping the COALESCE.** That trades a stale reading for a NULL
    one, and the entry above explains why NULL is worse. What is missing is an AGE on the
    commit field — `bot_commit_at` is the commit's own date, not when it was reported, so
    there is currently nothing that can say "this sha is older than the heartbeat beside it".
- `worker/bot-version.test.mts`, verified failing against three regressions.

### THE ON-DEMAND UPDATE DEADLOCKED ITSELF (2026-08-12) — read before pressing "Update now"
`7193c21` taught `update-guard.mjs` to claim, to close the Windows task's race. But the
guard runs on **TWO** paths and only one is the task: the pollers claim FIRST and then spawn
`auto-update.ps1`, which runs the guard too — so it claimed again and **lost to its own
parent's claim, taken one second earlier**. Every on-demand update refused itself with
*"another process holds the update claim (or we could not ask)"*.
- **It could never drain.** A standing request is re-claimed on every poll, so the 20-minute
  TTL just produced another SKIP. Reproduced three times, ~20 min apart.
- **And the fix could only be delivered by the mechanism it fixes.** The one remaining way
  in was a human at the box running `update.bat`.
- **The tell was that the same path WORKED at 15:53 and failed from 15:56 on.** Nothing about
  the request changed; the BOX moved `d1ab782 → 21dcc4e` in between, and that was `7193c21`'s
  first production run. Its own commit message says it could not reach the box before the
  08:00 cart — which is exactly why it had never been exercised. **A commit that cannot reach
  the box before a release is a commit nothing has run.**
- Fixed with `--claimed`: the spawner saying "I already hold it, do not ask". Passed by
  `control-channel.mjs`, forwarded by `auto-update.ps1`'s new `-Claimed` switch, honoured by
  the guard. **The Scheduled Task does NOT pass it** — it claims nothing and the guard is its
  only gate — so 7193c21's race stays closed, and the test asserts that too.
- `worker/update-guard.test.mts` verified failing against BOTH regressions: the guard ignoring
  `--claimed`, and **the poller not passing it** — the fix present but inert, which is the
  version that looks right in review and changes nothing.
- **RESOLVED THE SAME NIGHT: the box is on `bbe87e9`**, applied 2026-08-12 21:21 PT, so
  `kill-chrome` and this fix ARE live and `autocart.bot_version` reads "mini-PC and web are
  both on bbe87e9". An earlier `update.bat` run genuinely did not land (`bot_commit` never
  moved for ~5h while the runner kept beating), and **why that one failed was never
  established** — worth knowing it can happen silently. The later update landed despite three
  holds being `requested` for the next 08:00, which the 6h release check should have blocked,
  so **the interaction between the manual path and that check is not fully understood either.**
  Read `tail-log auto-update` before trusting either the manual path or the quiet window.
- **A HEALTH READING GOES STALE FASTER THAN A CONCLUSION DRAWN FROM IT.** I reported the box
  stuck at 21:12 and it updated at 21:21 — the reading was right when taken and wrong by the
  time it was quoted. Re-read before acting on anything older than a few minutes.
- ~~**AND IT HAPPENED AGAIN ON 2026-08-13 — "Update now" TAKES ~20 MINUTES, NOT ~2.**~~
  **SUPERSEDED 2026-08-19 — the stall was a claim held past a finished refusal; see "UPDATE NOW
  IS FAST NOW". The reading below is what the 20 minutes WAS, not what it is.** An
  update requested at 19:57 landed at **20:21**. I watched for 16 minutes, saw
  `SKIP - another process holds the update claim (or we could not ask)` with `claimed_at`
  NULL, and reported the 08-12 deadlock had recurred. **It had not.** That SKIP is a
  TRANSIENT state during a normal update, and the timing is structural: a poller spawns the
  updater only **once per process life**, so the retry that actually lands is the Windows
  scheduled task, which fires **every 5 minutes**. Budget twenty minutes before concluding
  anything, and confirm with `autocart.bot_version` rather than with the note.
- **`appliedNote` and `appliedSha` DO NOT DESCRIBE THE SAME EVENT.** `Report-Applied` sends
  the current `git rev-parse HEAD` alongside whatever verdict that run reached — so after a
  successful update, the next scheduled run writes `SKIP - outside the quiet window` next to
  the NEW sha. Reading them as one record makes a completed update look like a refused one.
  **`autocart.bot_version` is the field that answers "did it land?"**
- **THE ESCAPE HATCHES, while a box still runs the deadlocked code:** `update.bat` by hand, or
  a quiet-window run with **no request pending** (the guard claims only when `requested`).
  Cancel the request first or the quiet-window path claims too. **`nextHoldRelease` counts
  only `requested`/`carted`/`claiming`, NOT `offered`** — so untapped offers do not block the
  02:00–05:00 window, but tapping one does, and the 6h release check is not liftable.

### THE ON-DEMAND UPDATE WROTE NO LOG AT ALL, AND NEITHER DID ITS SPAWNER (2026-08-14)
Two "Update now" requests (20:48Z, 21:08Z). Both times the box claimed within **seconds**,
spawned `auto-update.ps1`, ran `stop-all` — stopping every process — and left `HEAD` at
`7780c32`. **Neither logged one word about why.**
- **`$log` WAS RELATIVE** (`logs\auto-update.log`). The Windows Scheduled Task starts in the
  bot directory, so the TIMER path writes correctly and this looked healthy for weeks;
  `bot.mjs` spawns the updater with **no `cwd` option**, so the ON-DEMAND path inherited the
  poller's directory and every `Add-Content` failed with *"Could not find a part of the path
  `C:\Users\Tyler\campsite-finder\logs\auto-update.log`"* — the repo root, whose `logs`
  directory does not exist. **The two-halves trap again: the path that works is not the path
  that carries the diagnostics.** Now absolute, anchored to `$PSScriptRoot`; guarded in
  `update-guard.test.mts`, which strips comment lines first because the new comment quotes
  the broken form. **WHY the directories diverge despite `Set-Location $botDir` two lines
  above is NOT established** — an absolute path removes the question rather than answering
  it, and the guess is deliberately not written here.
- **IT COMPOUNDS, and that is the real finding.** The updater's stdout goes to
  `logs\update-spawn.log`, which is written by **`bot.mjs` — a process `stop-all` KILLS on
  the way through** — so that log necessarily ENDS at the stop, every time, by construction.
  Between the two, an on-demand update had **no durable record anywhere**. That is why it has
  twice been diagnosed by inference, and why "Update now takes ~20 minutes" was inferred
  rather than read.
- **A PENDING REQUEST CHURNS THE BOX.** `UPDATE_RETRY_MS` is 15 min and the claim TTL is 20,
  so a request that never lands re-spawns the updater indefinitely and each attempt bounces
  every process. Withdraw it (`requested_at = NULL`) rather than leaving it set — do NOT
  mark it applied, which asserts something untrue.
- **`tail-log auto-update` COULD NOT BE READ EITHER** during this, because the mixed-encoding
  bug below returned the newest lines as mojibake. Three diagnostics failing at once around
  one event is the recurring shape here, not bad luck.

### `tail-log` RETURNED THE NEWEST LINES AS MOJIBAKE, EVERY TIME (2026-08-14)
Asked for `auto-update` mid-diagnosis, the box answered with solid CJK — every line.
**These logs are append-only and have outlived an encoding change**, so ONE FILE holds
UTF-16LE at the front (PowerShell 5.1's `Tee-Object`) and UTF-8 at the back (everything
appended once `supervise.ps1` started setting `[Console]::OutputEncoding`). The BOM-less
heuristic sampled the first 512 bytes, chose UTF-16LE for the whole file, and mis-decoded the
back — **which is the only part `tail-log` ever returns.** The comment claiming it "cannot
false-positive on real UTF-8" was true of the test and false of the file: it never asked
whether one file could be two things.
- Fixed by splitting at the **last NUL** — UTF-8 cannot contain one, so that byte is exactly
  the end of the UTF-16LE region. Exact, not estimated, and alignment falls out for free.
- **Sampling the tail instead of the head was the first fix and was only mostly right** (a
  fixed window still straddles the join while the UTF-8 part is shorter than the window). Its
  own regression test caught it. Tuning the window is a smaller version of the same guess.
- **VERIFIED AGAINST THE REAL BYTES off the box** — 332 log lines recovered where the box had
  returned none. That check **falsified an earlier version of the fix first**: the recovered
  buffer appeared to hold NULs at the END, which would have made the split catastrophic. They
  turned out to be the box's own `(truncated to the last 16000 characters)` notice, appended
  as ASCII AFTER the mis-decode and turned back into `X\0` pairs by the reconstruction — **an
  artifact of measuring, not of the file. Reconstructed evidence needs its own audit.**

### `rc-login.bat`'s KILL HAD NEVER RUN — `\"` IS NOT A CMD ESCAPE (2026-08-14)
Reported as *"RC login isn't working"*: the script printed `=== Closing anything holding the
RC profile ===` and then died with **`'ForEach-Object' is not recognized as an internal or
external command`**. The kill was inline PowerShell whose regex contained `[^\"]`.
**`\"` is PowerShell's escape and cmd has no backslash escape**, so that quote CLOSED the
string, everything after it was unquoted, and the very next `|` became a **cmd PIPE** — cmd
then tried to run `ForEach-Object` as a program.
- **So the kill has never run once, on any invocation, since the file was written.** The
  script announced the stop, stopped nothing, and went on to open a **second Chromium on a
  profile the first still held** — which is the corruption every comment in that file warns
  about. Exactly the shape of the WINDOWTITLE filter that matched nothing (08-08): a step
  that fails silently at the one thing it exists for, then fails loudly somewhere harmless.
- **THE NEAR MISS IS THE ARGUMENT FOR THE FIX.** `rc-test-login.bat` carried a line that
  *looks identical* and worked — because only `rc-login.bat` had the Chromium arm with the
  `\"` in it. Same-looking code, opposite behaviour, decided by a language boundary invisible
  at the call site. The remedy is not better quoting, it is **having no quoting to get
  wrong**.
- **`mini-pc\stop-rc.ps1` is now the ONE way to free the RC profile**: the pair, their
  supervisors, the Chromium scoped to `.rc-bot-profile`, the stale lock file — then it
  **RE-CHECKS and exits non-zero naming the survivors**. Never by image name.
  `rc-login.bat` and `rc-test-login.bat` call it with **`-File`** (no code crosses cmd) and
  jump to a `:busy` branch on survivors rather than signing in on top of them.
  `restart-rc.ps1` delegates to it too — one stop, not three.
- **THE GUARDS HAD TO FOLLOW THE BEHAVIOUR INTO THE NEW FILE.** `control-channel.test.mts`
  asserted "never kills the rec.gov bot" and "re-checks rather than trusting the kill"
  against `restart-rc.ps1`'s own body; after the extraction every one of them would have
  **passed on a file that no longer killed anything at all**. They read both files now, and
  `restart-rc` is separately pinned to ABORT on `$LASTEXITCODE` — an extracted check whose
  caller drops the exit code is no check at all.
- **`rc-test-login.bat` was ALSO still relaunching the pair unsupervised** — the downgrade
  fixed in `rc-login.bat` on 08-11 and left standing in the second copy, which is what a
  second copy always costs. One test pins both files now.
- Guarded mechanically: **no `.bat` may contain `\"` inside a `powershell -Command` string**.
  Scoped to `-Command` on purpose — `install-autoupdate.bat`/`install-watchdog.bat` pass `\"`
  to `schtasks /TR`, where it is the documented nesting and where there is no `|` for a
  broken quote to expose.

### `restart-rc` RELAUNCHED THE RC PAIR AS BARE `node` REPLs (2026-08-14)
The one remote lever for the RC pair has been starting **Node REPLs instead of the bots**,
and four independent safeguards read that as healthy. Found by reading `restarts.log`, where
the same `supervise.ps1` logs `starting: $Command` and its two callers disagreed:
```
21:46:47 [supervise:rc-keepwarm] starting: node rc-keepwarm.mjs   <- start-all.bat
21:48:48 [supervise:rc-keepwarm] starting: node                   <- restart-rc.ps1
```
- **`Start-Process -ArgumentList @(...)` JOINS WITH SPACES AND QUOTES NOTHING.** The child
  got `-Command node rc-keepwarm.mjs`, bound `-Command` to `node`, and `supervise.ps1` ran
  `cmd /c "node"`. `start-all.bat`, `rc-login.bat` and `rc-test-login.bat` were always right
  because **cmd passes their quotes through verbatim** — `restart-rc.ps1` was the only
  launcher using the array form, and the only one broken. Fixed by building the whole command
  line as ONE already-quoted string, which does not depend on how any PowerShell version
  chooses to join an array. The `-File` path is quoted too: a profile path with a space would
  break identically and just as silently.
- **A REPL NEVER EXITS, WHICH IS WHY NOTHING NOTICED.** `supervise.ps1` only speaks when a
  child exits, so `restarts.log` simply went quiet — indistinguishable from a healthy night.
  Same shape as `status = 'sent'` meaning only "Twilio returned 2xx".
- **THE WATCHDOG COULD NOT SEE IT EITHER**, and this is the sharper half. `Get-Missing`
  matched `rc-keepwarm\.mjs` against every command line — and the *broken supervisor's own*
  command line ends `-Command node rc-keepwarm.mjs`, so the string was present while nothing
  was running it. It now excludes `supervise.ps1` processes. **That is the union-count bug it
  shipped with, in new clothes: healthy by construction in the outage it exists for.**
- **AND `autocart.rc_runner` STAYED GREEN — see the entry below.**
- `worker/supervised-launch.test.mts` forbids the array form, requires every `-Command` to be
  followed by a quoted argument, and pins the watchdog's exclusion. Verified failing against
  both restored bugs.
- **`list-processes` carries the tell if you read it closely**: a healthy launch shows
  `supervise.ps1" -Name "bot" -Command "npm start"` (quotes present), a broken one shows a
  bare trailing `rc-keepwarm.mjs` with no closing quote.

### THE RUNNER HEARTBEAT WAS KEPT GREEN BY THE UPDATER (2026-08-14)
`rc_runner_heartbeat.beat_at` is the entire evidence base for `rcBotUsable()` and
`autocart.rc_runner`, and it claims to mean "the process that carts sites is alive". It was
stamped on **every authorized GET** of the hold feed — and three processes make one:
`rc-hold-runner` (15s), `rc-keepwarm` (20m, `?rehearsal=1`), and **`update-guard.mjs` every 5
minutes from the Windows scheduled task**. So it could not go stale while the box had a
working task, which is always.
- **MEASURED, and the number is the proof**: with the runner dead as a REPL, `beat_at`
  advanced every **301 seconds** — the updater's tick, to the second, not the runner's 15s.
  Sampled seven times over two minutes rather than inferred from one reading.
- The cost is not the wrong dashboard: `rcBotUsable` gates the **"Hold it for me" button**,
  so the poller goes on promising carts nothing will perform — the exact failure that check
  was written to prevent on 08-11, defeated through its own instrument.
- **THE RULE IS "SAYS IT IS SOMETHING ELSE", NEVER "PROVED IT IS THE RUNNER"**
  (`beatIsFromRunner` in `lib/rc-holds.ts`). The server half deploys on push; the bot half
  waits for `update.bat`. "Only an identified runner counts" would read every healthy box as
  a dead runner for that whole gap — the two-halves-deploy trap that opened the T−30/T−25
  alarm hole. An unidentified caller therefore stamps exactly as before; only a caller that
  positively identifies as NOT the runner is skipped. **The failure direction is the status
  quo, never a new false alarm.**
- `bot_commit` stays unconditional — "what code is this box running?" is a different question
  and the keep-warm and updater are just as entitled to answer it.
- `worker/runner-heartbeat.test.mts`, verified failing against three regressions including
  the runner-only rule (which is the tempting version, and the one that cries wolf).

### RC WENT BLANK IN THE BOT'S BROWSER, AND IT WAS THE CHROMIUM PROFILE (2026-08-14)
Reported as *"RC login isn't working"* and *"white screen"*. ReserveCalifornia's app mounted,
showed its own spinner, and never finished — in the bot's Playwright Chromium only. The
owner's normal Chrome, **same machine, same IP**, loaded it fine. `rc-autologin` reported
*"could not find the Log in link — RC may have reworded it"*, which is a CONSEQUENCE: a page
that never renders has no link in the DOM. It cost most of a day.
- **THE ANSWER: the `.rc-bot-profile` directory.** Renaming it and letting the keep-warm
  build a fresh one rendered RC completely, with **"Log in / Sign up"** present in the header
  — which is what `a:has-text("Log in")` matches, so the auto-login's selector was never
  wrong either. **WHAT in that profile did it is UNKNOWN**: it survived deleting `Cache`,
  `Code Cache`, `Service Worker` and `Local Storage`. The old directory is kept as
  `rc-profile-old` and is the only copy of the evidence — do not delete it without looking.
- **SIX THEORIES DIED FIRST, and they are worth keeping so they are not re-run.**
  NOT RC redeploying (their bundle's `last-modified` is 12 Aug and the bot carted against
  that exact build on 13 Aug). NOT a service worker (`/service-worker.js` and `/sw.js` both
  404→403; there isn't one). NOT the JS syntax (the most modern feature in the bundle is
  `Object.hasOwn`, Chrome 93+). NOT Playwright moving (the lockfile pins 1.61.1 both sides of
  the update that straddles the last working cart). NOT the WAF (the failure screenshot is
  RC's own spinner, not an Access Denied page or a challenge). NOT the token-capture hook.
- **`scripts/auto-cart-bot/rc-diag.mjs` IS WHAT SETTLED IT**, and the reason is the 2x2. Its
  first version launched a throwaway profile with NO capture hook and rendered perfectly —
  which read as proof the profile was guilty and **proved nothing**, because it differed from
  the bot in TWO ways at once. Same confound as "2-segment messages get filtered" when the
  real variable was the link domain. `--capture` and `--real-profile` change one thing each.
- **THREE OF MY OWN CONCLUSIONS WERE WRONG ALONG THE WAY**, all from evidence that looked
  solid:
  1. *"A fresh profile is still white."* **That test never ran.** Every
     `ren .rc-bot-profile rc-profile-old` was typed from `C:\Users\Tyler` and answered
     *"The system cannot find the file specified"*, so the "fresh" profile was the old one.
     **Use absolute paths on that box; a failed `cd` is silent and the next command lies.**
  2. *"`RC loaded and STAYING OPEN` proves the page is fine."* It means **navigation
     resolved**, nothing more. I reversed a correct diagnosis on it.
  3. *"Seven chrome.exe with two unquoted = two instances, so an orphan holds the lock."*
     `kill-chrome` cleared all seven, the keep-warm reopened ONE browser, and the shape came
     back **identical**. Seven processes with two unquoted entries is simply what a single
     healthy Chromium looks like.
- **`exitCode=21` from `launchPersistentContext` means PROFILE IN USE**, not a crash. It is
  the correct answer when the keep-warm holds the profile, and `--real-profile` needs the
  pair stopped. **The watchdog fights that** — it restarts the RC pair within 5 minutes, so a
  test that needs them down needs the task disabled (`schtasks /Change /TN "CampHawk
  watchdog" /DISABLE`, which needs an ELEVATED prompt), or an approach that does not hold
  them down at all. Renaming the profile and letting `start-all` rebuild it is that approach.

### THE STOP SCRIPTS COULD NEVER KILL CHROME'S CHILD PROCESSES (2026-08-14)
Found while chasing the blank page above. **It is a real bug and it was NOT the blank page** —
that distinction is recorded because I wrote the wrong version into the source first.
- `stop-rc.ps1` and `stop-all.ps1` matched `--user-data-dir=[^"]*\.rc-bot-profile`. Playwright
  launches the PARENT with the path unquoted; **Chrome re-quotes it for its own renderer/GPU/
  utility children**, and `[^"]*` cannot cross that opening quote. So every stop killed the
  parent and left the children alive, holding the real Chrome lock on the user-data-dir —
  which deleting our own lock file does not touch.
- **`kill-chrome` used `\S*` and was correct the whole time**, which is exactly why that lever
  worked when `stop-rc` did not: a difference invisible in either file, decided by one
  character three files apart. Same family as `\"` not being a cmd escape.
- `worker/chromium-attribution.test.mts` now asserts every `--user-data-dir` kill pattern — in
  every mini-PC `.ps1` and in `bot-commands.mjs` — matches BOTH the unquoted parent and the
  quoted child. It reads **assignments only**, because the new comments quote the broken
  pattern to explain it and a test that failed on its own explanation would be "fixed" by
  deleting the explanation.
- **`kill-chrome`'s "SURVIVED" report is misleading and still is.** It kills, sleeps 3s, and
  re-counts — and it clears the profile lock *so the keep-warm can reopen*, which it does
  inside those 3 seconds. `BEFORE` prints only a COUNT, so "7 before, 7 after" cannot tell a
  failed kill from a fresh browser. Compare the **pids**: they were entirely different every
  time, i.e. the kill worked. Fix it to print pids and diff the sets.

### THE WATCHDOG ASKED "IS ANYTHING RUNNING?" — RESTARTS THE BOTS, NEVER THE PC
`mini-pc\watchdog.ps1` + `install-watchdog.bat` (2026-08-14): a Windows Scheduled Task, every
5 minutes, run by **Windows and not by our code**, so it survives everything short of the
machine being off. It exists because every remote lever rides a poller ON the box — when the
pollers are dead there is nothing left to receive a command, which is structural and has now
bitten three times.
- **IT RESTARTS PROCESSES. IT DOES NOT REBOOT WINDOWS, deliberately** — and that is the
  answer to "will it fix a crashed PC?": **no.** In every outage so far Windows was fine and
  only our processes had died, a reboot ENDS the RC session (the token lives in the Chromium
  it would close), and a reboot tier is only safe if the bots start themselves at login,
  which is not established. It is also **no help in the case that actually needed a human**:
  when the box wedged on 08-12 RustDesk could not connect and the machine had to be power-
  cycled by hand — a Scheduled Task cannot run on a Windows that is not scheduling. The fix
  for that is the memory leak below, not a bigger hammer here. `update-guard.test.mts` fails
  on any `Restart-Computer`/`shutdown /r`.
- **IT SHIPPED ASKING "IS ANYTHING RUNNING?" AND WAS FIXED HOURS LATER — the house failure,
  in the watchdog itself.** The rec.gov bot and the RC pair are different processes;
  `autocart.bot` stayed green through the RC runner's death on **both** 08-07 and 08-11 for
  exactly this reason. A union count would have read the very outage it was written for —
  `bot.mjs` up, keep-warm and hold runner dead, holds queued for 08:00 — as **healthy**, and
  exited silently every five minutes all night. Each payload is checked **by name** now.
- **THE LEVER IS CHOSEN TO MATCH THE GAP.** `start-all.bat` stops everything first, which is
  what makes a duplicate structurally impossible **and** what closes the Chromium holding the
  RC token — so it is only for a genuinely dark box. The RC pair alone goes through
  `restart-rc.ps1`, which costs no session that is not already gone. **Bot or broker down
  while the RC pair is UP is a deliberate, NAMED hole**: it says so and exits non-zero rather
  than spending a live session on a process whose own supervisor should have restarted it.
- **The update stand-down HAS AN EXPIRY (15 min)**, because on 08-14 the updater itself was
  what died — still holding everything down. A stand-down with no expiry protects the broken
  thing.

### A Chromium ate 41 GB of COMMIT, and nothing could kill it remotely (2026-08-12)
The first real `memory` reading answered the question `fix-pagefile` was waiting on, and the
answer was **consumption, not the ceiling**: one `chrome.exe` on our profiles at **9.4 GB**,
growing **~395 MB/min**, with COMMIT at **99% of 50 GB**. Killing that single pid took commit
to **21% of 35 GB** and freed ~41 GB — Windows then shrank the lazily-grown pagefile back.
- **It reached 7.9 GB in 46 seconds** of the keep-warm starting. That is not ordinary growth.
- **`restart-rc` could not clear it** — it killed 2 of the instance's 9 processes. So the one
  remote lever for a runaway browser did not reach it, and it took a person typing `taskkill`
  into a phone. Hence **`kill-chrome`** (`rc` / `recgov` / `all`), which kills by profile
  family, re-checks, names survivors and clears the RC profile lock.
- **STILL UNDIAGNOSED, and I twice guessed the profile wrong.** The RC profile path is
  `…\auto-cart-bot\.rc-bot-profile`, so it contains BOTH patterns `memory` and `restart-rc`
  match on — the two cannot be compared that way. Attribute it on the next occurrence with
  evidence, not by reading regexes.
- `fix-pagefile` is **not** the fix and would have masked this. Pagefile peak was 0.4 GB
  against 34 GB allocated: commit was going to reservations, not paging.
- **`memory` CAN ATTRIBUTE IT NOW (2026-08-14), which it could not before.** It reported a
  count and a total and nothing else, so the leak was unattributable *by construction* — the
  guessing above was the only option the tool left. It now prints, per Chromium, the
  **`--user-data-dir` in full** plus pid and private MB, and totals per family. **Order is
  load-bearing:** `.rc-bot-profile` is tested BEFORE `auto-cart-bot` because it sits inside
  it, and the general test first would file every RC process under rec.gov — the exact
  misattribution being fixed. The directory only, never the command line: Chromium argv
  carries URLs, and a field you would have to filter is better not collected.
- **AND `kill-chrome recgov` WAS KILLING THE RC PROFILE TOO.** `--user-data-dir=\S*auto-cart-bot`
  matches `…\auto-cart-bot\.rc-bot-profile`, so the lever you reach for *precisely because*
  `restart-rc` leaves rec.gov alone would have ended the live RC session. Negative lookahead
  now, rather than matching the `profiles\` subdirectory, so an overridden `PROFILES_DIR`
  cannot quietly turn it back into "everything". Having three scopes is only worth something
  if two of them are survivable at 07:50. `worker/chromium-attribution.test.mts` pins both,
  verified failing against the restored scope and against the reversed family order.
- **NOT REPRODUCED THIS SESSION, and the readings say why.** 2026-08-14 05:06Z: COMMIT **13%
  of 57.7 GB**, `OURS 0`, **`CHROME 0` — no Chromium on the box at all**, because the RC pair
  were REPLs and never launched one (see the `restart-rc` entry). So there was nothing to
  measure, and a second reading five minutes later would have measured the same nothing.
  **Do not read "no leak observed" as "no leak"** — the growth RATE across two readings is
  still the signature, and it still needs an occurrence.

### THE CHROMIUM LEAK IS RECORDED NOW, BECAUSE IT CANNOT BE CAUGHT BY HAND (migration 059, 2026-08-14)
The prescribed remedy — two `memory` readings five minutes apart, because the growth RATE is the
signature — was run and produced a clean, confident, **useless** answer: the same 8 pids in both
readings, 312 MB → 264 MB, about **−9 MB/min**, COMMIT 16% of 57.7 GB.
- **Every process sampled was on `.rc-bot-profile`, and NO rec.gov process existed at all**
  (`CHROME 8` = `OURS 8`). `keepSessionsWarm` in `bot.mjs` opens a rec.gov Chromium per enrolled
  user **every 30 minutes** and closes it, so the family that has never been ruled out is
  **EPISODIC** and a five-minute window has ~1 chance in 10 of containing one. Two manual readings
  are not merely risky here, they are structurally unlikely to sample it — which is why three
  attempts have produced three non-answers. **A family with no processes running has been ruled
  out of NOTHING**, and reading that reading as "it did not reproduce" is the whole trap.
- **"Keep-warm" NAMES TWO DIFFERENT THINGS**, and that is a plausible part of why the family was
  guessed wrong twice: `rc-keepwarm.mjs` (RC session) vs `keepSessionsWarm()` inside `bot.mjs`
  (rec.gov keepalive). The 08-12 note *"7.9 GB in 46 seconds of the keep-warm starting"* does not
  say which, and they are different profile families.
- **So `bot.mjs` samples every 2 min and POSTs it** on the feed POST it already makes →
  `chromium_memory_samples`. Readout `scripts/chromium-memory-readout.mts`. Hosted in `bot.mjs`
  because the RC pair have died twice while it stayed healthy (08-11; the 08-14 REPL morning).
  **Server-side and not a log file, by measurement:** on 08-12 the keep-warm's log FROZE through
  Windows file locking while the process went on reporting to the server perfectly.
- **The verdict pairs on `max_pid`.** A rec.gov family total going 0 → 900 MB is usually a browser
  that did not exist in the first sample; subtracting those is a coincidence with units on it, and
  without the rule it would report a leak on every keepalive pass for ever. **Refuses a verdict
  under 10 comparable pairs**, counting pairs it could compare rather than rows fetched.
- **A GAP IS THE SIGNATURE, NEVER A ZERO.** Sampling spawns PowerShell, and spawning is exactly
  what fails at 99% commit — the `supervise.ps1` failure IS that failure — so the series ENDS
  rather than peaking. And "NO LEAK IN THIS WINDOW" never becomes "there is no leak".
  - **AND THE GAP AT THE END WAS THE ONE IT COULD NOT SEE (fixed 2026-08-14).** `worstGapMin`
    measured the longest hole BETWEEN two samples, so a series that simply STOPS — which is
    exactly the shape above — had no gap at all: every sample a tidy two minutes apart, and a
    box that died mid-ramp at 03:00 printing the same `NO LEAK IN THIS WINDOW` as a box sitting
    idle. The house shape, inside the instrument written to catch it. `seriesEnded` is measured
    against `now` (injected, so the function stays pure), and **`lastCommitPct` is what tells a
    crash from a bot that was merely stopped** — ending at ~16% is an update or a switched-off
    box, ending at 90% is the crash. It is ADDITIVE: "it climbed AND THEN the series stopped"
    is the strongest reading this table can produce, and overwriting the growth verdict with
    the silence would discard the half that names the family.
- **SIZE IS A SECOND QUESTION, AND THE RATE RULE CANNOT ANSWER IT (2026-08-14).** The 08-12
  process reached 7.9 GB in **46 seconds** — faster than the 2-minute cadence — so that ramp is
  invisible here: it appears as a pid that did not exist last time, already enormous, and the
  `max_pid` pairing rule correctly refuses to call it a rate. So the readout could print
  `NO LEAK IN THIS WINDOW`, or `NOT ENOUGH DATA`, over a 7.9 GB browser **sitting in its own
  table**. `BIG_PROCESS_MB` (1500, against measured normals of 40-114 MB) reports it as
  `OVERSIZED PROCESS`. A measured rate still leads — two readings of one process is the
  stronger evidence — and size corroborates it. **Size is deliberately NOT gated on
  `MIN_COMPARABLE_PAIRS`**: that threshold gates a RATE, and refusing to name a multi-GB
  browser for want of pairs would be the instrument declining to report what it exists to find.
  The peak is the LARGEST reading in the window and never the newest, so a spike `kill-chrome`
  or a closing keepalive browser has already cleared is still attributed.
  - **That last rule survived its first mutation test.** Every fixture happened to put its
    biggest process in the final row, so "largest" and "last" were indistinguishable and the
    mutation passed the whole suite. A guard written from the shape of the bug can be wrong
    about the rule — same lesson as `site-mute.test.mts` failing at baseline.
- **No alarm on it, deliberately.** A warn at ~70% COMMIT (while `kill-chrome` still works and the
  box is still reachable) is the obvious next step and should be decided on the series, not before.
- **THE SAMPLER RECORDED A ZERO IT HAD NOT MEASURED, ON ITS FIRST DAY (2026-08-14).** The box
  reached `60d9b98` and samples began every two minutes exactly as designed — **and every row
  said `rc 0 procs, 0 MB` while the `memory` command, interleaved seconds apart on the same box
  through a BYTE-IDENTICAL filter, reported NINE Chromium on `.rc-bot-profile`.** The commit
  figures in those same rows were right (`10277 MB` against the command's `10.0 GB`), so
  PowerShell ran and only the process scan came back empty.
  **The empty scan is not the bug; the ZERO is.** `memory-sample.mjs`'s own header states the
  rule it broke — an absent reading returns nulls, never zeros — and it had been applied to the
  `M|` line and not to the scan. That is the SAME half-application as the `op_Addition` rollup
  below: **twice, in the two instruments built to attribute this one leak.**
  - Counts start `null`; a zero is written only when the scan proves it ran.
  - PowerShell emits **`C|<count>` BEFORE the loop**, because "found none of ours" and "never
    completed" were the same evidence and **both are real** (08-14 had a window with genuinely
    zero of our browsers). It also localises the failure: `C|9` with no `P|` means the loop
    broke, no `C|` at all means PowerShell stopped before it.
  - **stderr is read and logged.** It was discarded, so the one line explaining the empty scan
    was thrown away at the point it was produced.
  - **WHY the scan returns nothing is NOT established — do not guess it into this file.** The
    filters are identical, so it is about how the sampler invokes PowerShell rather than what
    it asks. The `C|` line answers it on the next reading.
  - **Two mutations survived the first round**: deleting the `C|` line from the PowerShell, and
    emitting it after the loop. Every parse test feeds `parseSample` a hand-written string, so
    the parser and the thing producing its input could drift apart silently — and there is no
    PowerShell on the machine this repo is written from. Guarded mechanically now.

- **TWO INSTRUMENTS WERE LYING, both the house shape.** `memory`'s per-family rollup kept
  `@(count, mb)` in a hashtable and threw `op_Addition` once per process on **every run it ever
  made** — printing `FAMILY rc 0 process(es), 0 MB` over a profile holding 312 MB, while the
  per-process list above it was correct. `rc 0 MB` reads as the RC family being innocent, on the
  one line you compare across two readings. And `kill-chrome` called everything it found after its
  3-second re-check `SURVIVED` — long enough for the supervisor to have opened a NEW browser, so a
  clean kill plus healthy recovery printed the same words as a kill that reached nothing (the
  08-12 "7 before, 7 after"; the pids were different every time, i.e. it had worked). It diffs pid
  sets now. Both fixed by the idiom already working three lines away, not by a second guess.

#### THE SAMPLER CAN NEVER PRODUCE A VERDICT ON THE REC.GOV FAMILY (2026-08-15)
The series ran clean for 175 samples and reported `recgov 0` in **every one of them**, and the
readout says so in a warning: *"NO recgov process was running at any point in this window."*
That reads as "the episodic family still has not been sampled — keep waiting". **Waiting cannot
work, and the reason is arithmetic, not luck.**
- **MEASURED, from the box's own `bot` log against the sample timestamps.** `keepSessionsWarm`
  fires on a fixed 30-minute interval from `bot.mjs` start, so the window is predictable:
  ```
  [04:01:23] interval fires (03:01:23 start + 30m + 30m)
  [04:01:27] ♻ tyl***: rec.gov session kept warm     <- +4s
  [04:01:49] ♻ cam***: rec.gov session kept warm     <- +26s, after the 15-45s stagger
  ```
  Samples ran at 03:59:34, **04:01:35**, 04:03:35. The one sample inside the window landed in
  the GAP between the two browsers — the first had closed at ~04:01:27, the second had not yet
  opened. Same shape at 03:31:23 (`+4s`, `+25s`).
- **So each keepalive browser exists for a few SECONDS**, twice per 30-minute cycle: on the
  order of **10-20 seconds of browser per 1800**, under 1% coverage. Across the ~13 cycles in
  the series that predicts one or two catches, so **zero out of 175 is unremarkable and is NOT
  evidence of anything.** Do not read the readout's warning as a lead; it is the expected
  reading.
- **THE STRUCTURAL HALF DOES NOT DEPEND ON THAT ESTIMATE, and it is the finding.** A verdict
  needs a RATE, the rate rule pairs two samples **of the same `max_pid`**, and the cadence is
  two minutes — so a rate requires the process to live longer than two minutes. **These live
  about five seconds.** A NORMAL keepalive browser therefore cannot produce a rate verdict
  from this instrument *rarely*; it cannot produce one **at all**. The recorder built precisely
  because "the rec.gov family is episodic and manual readings miss it" has the same blind spot
  it was built to remove — narrowed from a five-minute window to a two-minute one, and the
  family is five seconds wide.
- **THAT IS NARROWER THAN IT READS, AND THE FIRST DRAFT OF THIS ENTRY OVERSTATED IT.** It said
  "a rec.gov LEAK cannot produce a rate verdict at all", and that does not follow: a process
  that is actually leaking **persists** — the 08-12 one grew for minutes and reached 9.4 GB —
  and a browser that lives minutes gets sampled and paired like any other. **The periodic
  series is NOT blind to a sustained runaway.** What it cannot see is the family's **normal
  baseline** (still unknown, and abnormal is not recognisable without it) and a ramp that
  begins and ends inside one short life. The correction is left visible rather than quietly
  rewritten, because "the instrument is blind to rec.gov" is exactly the tidy sentence that
  gets quoted later as a reason to stop looking.
- **`OVERSIZED PROCESS` is the one thing that could still speak**, because it is a single
  reading and is deliberately not gated on the pair count. That is a real partial answer: the
  08-12 event held 7.9 GB, so a recurrence would be reported *if a sample happened to land on
  it* — still under 1% per cycle, and only once it is already enormous.
- **RULED OUT FIRST, so it is not re-run:** the sampler is **not** misfiling recgov as rc.
  `classifyProfile` tests `.rc-bot-profile` BEFORE `auto-cart-bot` — the correct order, with the
  trap named in its own comment — and `PROFILES_DIR` defaults inside `auto-cart-bot`, so the
  PowerShell filter matches the rec.gov profiles as written. The attribution is sound; the
  CADENCE is the problem.
- **The 08-12 note is what makes this expensive rather than academic.** It says the process
  *"reached 7.9 GB in 46 seconds of the keep-warm starting"* — and CLAUDE.md already flags that
  "keep-warm" names two different things. If it was `keepSessionsWarm`, then the one family the
  instrument cannot measure is the family the only measured event points at.
- **THE FIX IS TO SAMPLE FROM WHERE THE EVENT IS, not to poll faster.** `keepSessionsWarm`
  knows exactly when its browser is open — it opened it. A sample taken inside that block
  catches it every time, at two samples per cycle instead of a 1-in-100 chance, and needs no
  new cadence and no extra PowerShell on an idle box. Same rule as `rc-keepwarm` posting its own
  verdict instead of a watcher inferring it, and as the RcReport channel: the process that knows
  is the process that reports.
- **BUILT 2026-08-15.** `createSampler`'s returned function takes `{ force, source }`;
  `keepSessionsWarm` calls it with `source: 'bot-keepalive'` inside its `withBrowser` callback.
  Two readings per cycle instead of ~0. Three properties are load-bearing and each is pinned by
  a test verified failing:
  - **It is AWAITED.** The scan runs in a separate PowerShell process, so an unawaited call
    lets `withBrowser` close the context first and the sample measures the absence it was
    added to see. `void` instead of `await` is a one-character version of this fix that looks
    right and records nothing.
  - **It is INSIDE the browser block.** Moved after it, same result.
  - **A forced sample does NOT reset the interval clock.** If it did, a keepalive would push
    the periodic series out by two minutes twice an hour — and a periodic sample landing just
    after a forced one is the ONLY way this instrument ever pairs two readings of a keepalive
    browser, which happens exactly when that browser failed to close, i.e. the runaway case.
    Resetting the clock would delete the case worth catching.
  - A forced sample lost to an in-flight read **says so in the log**: the interval can afford a
    skipped tick, but a forced one is the only sighting of a five-second browser and a silent
    miss reads as "the family was not running".
  - **`bot.mjs`'s `post()` had `source: 'bot'` bound as a constant**, so forwarding the source
    was part of the change; left alone, every forced reading would land in the series it exists
    to be told apart from. Pinned too — it is the third inert-fix shape here.
- **IT WORKS, AND THE REC.GOV FAMILY HAS A BASELINE FOR THE FIRST TIME (2026-08-15).** After a
  quiet-window update reached the box at ~09:00 UTC, `chromium_memory_samples` carries rows
  with `source = 'bot-keepalive'` — **two per 30-minute cycle**, at off-beat timestamps
  (13:01:19 and 13:01:48 against a periodic series on :07 and :35), which is the 15-45s stagger
  between the two enrolled users. `families observed` finally reads `rc, recgov`.
  **rec.gov: 7-9 processes, 134-145 MB, FLAT across nine consecutive cycles.** That is the
  number 175 consecutive `recgov 0` rows could not produce, and it is the first evidence about
  the family the 08-12 event pointed at.
  **It is a baseline, NOT an exoneration.** A steady ~140 MB says the ordinary keepalive
  browser does not leak; it says nothing about the 7.9-GB-in-46-seconds event, which by
  construction still cannot be caught by a 2-minute cadence unless a sample happens to land on
  it. `OVERSIZED PROCESS` remains the only thing that would report that.
- **A DIAGNOSTIC CAN BE MARKED STARTED AND NEVER ARRIVE.** Three `memory` commands were stamped
  `started_at = 04:01:24.014` — all three identical, i.e. one hand-out — and **the box's log
  shows no `? diagnostic` line for any of them** while the same log shows #87, #88 and the
  keepalives either side. `bot.mjs` was demonstrably alive throughout (samples every two minutes,
  and it answered the next command). `claimBotCommands` stamps `started_at` **as it hands them
  out**, so a response lost in flight leaves a command permanently "picked up, no answer yet" —
  which is the state CLAUDE.md already records as indistinguishable from a wedged command. Worth
  knowing before reading that state as the box being stuck.

### THREE DIAGNOSTICS LIED AT ONCE, AND THE HEARTBEAT WAS RIGHT (2026-08-12)
I told the owner the RC pair was dead and to go to the box. **It was running the whole time.**
- **`list-processes` showed only the PowerShell wrappers**, no `node` — by construction, it
  matches a pattern the relaunched processes did not.
- **The keep-warm log froze at 15:56:38** while the process kept reporting to the server —
  Windows file locking, the same family as `rc-login.bat`'s relaunched windows dying on
  `Tee-Object` because the survivors held the logs open.
- **My own 30-line tail cut the `restart-rc` lines**, and I blamed `restarts.log`'s known
  contention bug. It had written them correctly.
- **`rc_runner_heartbeat` was accurate throughout** and would have settled it in one query.
  **Check the thing that reports to the SERVER before believing two local diagnostics.**
- Also corrected: **`stop-all` DOES kill orphaned Chromium** (it killed two during the update).
  I said it did not.

### Front-of-flow: sign in to RC BEFORE the release (2026-08-12)
`rc-handoff.ts` had already concluded "SIGN IN INSIDE THE WEBVIEW, **AS STEP ONE OF THE
CLAIM**" and it was never built — every `openRcHandoff` call sat on the far side of the
release, so the injectable webview did not exist until the drop had happened. The old step 1
opened the SYSTEM browser, whose cookie jar the injection can never read.
- Measured on the 08-12 hold: first injection reported *"Couldn't read your RC login"*, the
  user signed in mid-window, and a LATER injection captured a 939-char token — so the data
  store persists across separate opens. The mechanism was right; the ORDERING was wrong.
- Step one opens the webview with **no `unitId`**, so the script finds no job, reports `idle`
  and still captures the token — a rehearsal of everything except the cart.
- `token captured` is now the gate, replacing the self-assertion checkbox. **Verification is a
  fast path, NEVER a new blocker**: unconfirmed falls back to the checkbox, because "we could
  not confirm" and "there is no session" are different facts.
- **THE COPY MUST NOT PROMISE A CART** until a real hold reports `✓ Added to cart`. My first
  draft did exactly that; `rc-handoff.test.mts` guards it now. **The first version of that
  guard was worthless** — it matched raw JSX with a class excluding `<`, so the tag in
  `add <strong>{site}</strong> to your cart` interrupted the phrase and the mutation passed.
- **The two RC cart POSTs were proven on 2026-08-13 12:31 PT** — see the trace under "THE
  CART POSTS NEVER FIRE" below. As of the 08-12 hold described next they were not:
- ~~**The two RC cart POSTs are STILL unproven.**~~ The 08-12 hold carted at 08:00:02, released at
  08:05:24, and reported `token captured` with no cart outcome — and the report channel was
  demonstrably working either side of it.
- **The app session does NOT survive days.** The 08-09 tests proved it survives closing the
  webview and force-closing the app — same day. Nothing measured longer, and RC's own session
  lifetime (~1h token, ~12h Okta) applies inside the app too. Sign in shortly before a release.

### THE RELEASED SCREEN HAD NO SIGN-IN STEP — FIXED 2026-08-13 evening
Step one — the in-webview RC sign-in that `prepareRc` performs — was wired into the
PRE-RELEASE state only. In the ordinary 08:00 flow that is fine: the user signs in, then
presses "hand it over". **On a REVISIT it is not**, and revisits became reachable the same
evening (see below), so a user landing on the released screen has never run step one in that
webview. "Finish on ReserveCalifornia" then ran the precart against a signed-out webview,
which sits on *"Reading your session…"* for `getToken`'s twelve-second wait and can only end
by asking the user to sign in on RC's own page — which RC scrolls past its own sign-in
control. The release is spent by then. Identical cause to the morning's hold: **the precart
needs a session in THAT webview and nothing on this screen established one.**
- **CONFIRMED IN PRODUCTION DATA, not only from the report.** Hold `45719` — the synthetic
  one that PROVED the cart POSTs at 12:31 — was reopened twice at ~17:11 PT and its
  `client_reports` tail holds both attempts, identical: `injected {job:true}` →
  `session {opens:19, marker:"present", storedToken:"none"}` → `banner "Reading your
  session…"` → `closed`. **No token, no `load`, no `submit`.** Compare the same hold's
  successful run five hours earlier: `token captured` → `Adding to your cart…` → `load ok` →
  `✓ Added to cart`. `marker:"present"` with `storedToken:"none"` is the migration-058 shape
  for "the store survived and the session ran out" — not an ITP purge.
- **The fix is `rcHandoffStep` in `lib/claim-gate.ts`, and `prepareRc` is the way through
  it.** No new mechanism; both halves already existed for the pre-release screen. It is a
  function rather than two `&&`s in the JSX because **its edges are the interesting part**
  and an inline copy on a third screen would get them wrong quietly:
  **`unconfirmed` PROCEEDS** (the webview closed without announcing a token, which may
  equally mean we never got to look — same rule as `unknown` never being reported as a dead
  RC session), and **`canInject === false` always proceeds** (the hand-off opens the SYSTEM
  browser, which carries the user's own real session; a sign-in button there would navigate
  away from this screen and report nothing back, so the gate could never lift).
- The revisit copy (`afterSignInBody`) **promises nothing about a cart** — the precart has
  not run, and the missing session is exactly what stops it — so it stays OUT of
  `POST_RELEASE` and the existing denylist covers it by default.
- Preset `ch-claim-revisit` renders it (the stubbed `cordova.InAppBrowser` is what makes
  `canInject` true; without it the preset shows the plain-browser screen and proves nothing).
- **It was the third UI bug in two days found by running the real flow on a phone**, after the
  stranding-when-it-worked and the toolbar-over-content. None was reachable by reasoning, and
  all three were the app doing the right thing while the screen described a different product.

### DON'T THROW A REVISITING USER INTO RC (2026-08-13 evening)
"Open the hand-off again" on the Watches panel jumped straight out to ReserveCalifornia with
no chance to read which site it was. The redirect effect fires on `status === 'released'` and
only ever saw the CURRENT status, so it could not tell "the bot has just let go, every pause
is exposure" from "this released an hour ago and somebody came back to look". At 08:00 going
immediately is right and stays; on a revisit it is the screen acting ON the user.
`arrivedReleased` is recorded on the FIRST load and read by the effect.
- **The ref is ASSIGNED in `load`, not merely declared.** Declared-and-read would leave it
  null, always falsy, behaviour unchanged and the diff looking correct — the "fix present but
  inert" shape that has already cost this codebase two commits (`6006428`, the `--claimed`
  poller omission). Nearly shipped that way.

### THE CART POSTS NEVER FIRE — AND IT IS NOT THE TOKEN (2026-08-13; FIXED AND PROVEN THE SAME DAY — see the sub-section two below)
The first hand-off on the new flow produced a full `client_reports` trace, and it settles a
question open since 08-09. `#60`, released 08:00:05, claimed, injected on `/park/696/631`:
```
token   captured:true length:939 decodable:true expiresInSec:3381   (~56 min of life)
status  "Reading your session..."
status  "Click the cart icon once (to start your cart), then click Add to cart."
        ...cycling between those two, ~27 reports
```
- **THE TOKEN IS FINE.** A live, decodable, 56-minute RC access token, read out of the
  webview. Every "it cannot read the session" reading of this — including two I gave the
  owner the same morning — is WRONG.
- **THERE IS NO `load`, NO `submit`, AND NO ERROR STAGE.** The script never attempts the two
  cart POSTs. It goes straight to the manual banner. So they are not failing; they are not
  being tried.
- **The banner names the precondition:** RC's precart needs an EXISTING cart — a cart key you
  only get once a cart has been started — and the injected script cannot create one. The BOT
  has one on its side (it carted twice that morning, 1.9s and 5.3s after release); the user's
  own session does not.
- **So the open question changes shape.** It was never "do the POSTs work?" — it is **"how
  does the user's session get a cart key without them clicking the cart icon?"**
- The `session` stage also reported `opens:4, marker:present, storedToken:jwt,
  storedExpiresInSec:3381` — migration 058's probe working, and the app session surviving
  four separate opens.

#### ANSWERED: `load` MINTS THE CART KEY, AND THE BOT HAS NEVER HAD ONE EITHER (2026-08-13)
The precondition was ours, not RC's. `rc-hold-runner` passes `existing || NO_CART` —
`00000000-0000-0000-0000-000000000000`, **RC's own sentinel for "I have no cart"** — and
`precartInPage` then adopts the `ShoppingCartKey` that `load` hands back, under a comment
saying in as many words "that is how a fresh session is supposed to acquire one". **The step
`content-rc.js` refused to reach IS the step that mints the key.** It carted twice that
morning through exactly this path.
- **The fix is convergence, not a new precart.** `content-rc.js` now does what
  `rc-cart.mjs` does: send `NO_CART` when there is no key, adopt `Result.ShoppingCartKey`
  off `load` before the submit, and **write the final key into
  `localStorage["shoppingCartKey"]`** — RC's SPA never hears about an HTTP submit, so
  without that write a successful cart shows the user an EMPTY cart, which is a working
  hand-off that reads as a broken one.
- **Two divergences, not one.** It also never read `localStorage["shoppingCartKey"]` at all
  — only a key broadcast by `rc-inject.js` off RC's live traffic — so even a user who
  *had* a cart was told to go and click the cart icon.
- **The "a minted key makes a phantom cart" warning it replaces was about a CLIENT-INVENTED
  GUID**, which RC has never heard of. `NO_CART` is RC's own sentinel and comes back
  answered. Do not read the old comment as forbidding this.
- **The 5-second wait for a broadcast key is GONE.** It was affordable only while it gated
  the whole attempt; five seconds is twice the entire ~2.5s exposure window.
- **THE CLAIM SCREEN COPY IS DELIBERATELY UNCHANGED.** It still never promises a cart —
  `rc-handoff.test.mts` guards that, and the promise is only earned once a real hold reports
  one added. Branch the copy on capability *after* that, not before.

##### PROVEN 2026-08-13 12:31 PT — THE CART POSTS FIRE, AND `submit` MINTS THE KEY, NOT `load`
A synthetic hold from `rc-test-hold.mts` (South Carlsbad #35, unit 45719, arrival
2026-12-01) carted at **12:31:12, 1.8s after its release**, was released by the bot at
12:32:24, and the owner's own phone took it. The trace, from `client_reports`:
```
injected  job:true  href=https://www.reservecalifornia.com/park/720/715
session   opens:7 marker:present storedToken:jwt storedExpiresInSec:3586
token     captured:true length:939 decodable:true expiresInSec:3586
status    "Adding to your cart..."
log       "precart load ok - cart key STILL MISSING (RC returned none)"
status    "✓ Added to cart - review & check out on ReserveCalifornia."
```
**The owner confirmed it in RC's own cart page**, which is the read-back the injected
script does not do — it judges on the response payload (`IsSuccess` not false), one step
weaker than `rc-cart.mjs`, which re-reads the cart. Ask for that confirmation on any future
run rather than treating the status line as the whole proof. RC's page showed
*"South Carlsbad SB - Northern End (sites 35-102) - Premium Campsite - 035"*, *"Tue
12/01/2026 - Wed 12/02/2026 (1 night)"* — the exact unit and dates asked for, so this is a
match on identity and not merely a non-empty cart.
- **Sub Total read $78.25 against an $8.25 line**, which is consistent with one site plus
  RC's reservation fee (the $8.25 sits under *Reservation Fees*) and NOT read as a second
  item. Nobody verified that, and it is the sort of arithmetic that later gets quoted as
  evidence about cart contents — **if it matters to the cap question, re-read the cart
  rather than this sentence.**
- **The CampHawk banner still renders its "Add to cart" button next to "✓ Added to cart"**,
  and sits over the Sub Total row. Cosmetic, but it invites a second tap on a cart that is
  already correct — the same family as the toolbar-overlapping-content fix on 08-12.
- **THE MECHANISM IS NOT WHAT THE HEADING ABOVE SAYS, and the heading is left standing so
  the correction is visible.** `load` returned **no `ShoppingCartKey` at all** — the `log`
  line says so in its own words — and the **`submit` carrying the `NO_CART` sentinel
  succeeded anyway.** So the fix works, and it works because RC will open a cart on the
  submit; "the step `content-rc.js` refused to reach IS the step that mints the key" was
  right about the remedy and wrong about which call does the minting. A right-for-the-
  wrong-reason explanation is exactly what hardens into the next false premise.
- **`capturedCartKey` and `localStorage` were BOTH empty at the moment it mattered**, even
  though `cartkey captured:true` reports appear before and after — which is why the
  `|| NO_CART` fallback is load-bearing and not a defensive nicety.
- **The claim copy is now unblocked but STILL UNCHANGED.** One hold has reported a cart;
  that earns the branch, it does not perform it. Do it as its own change, with
  `rc-handoff.test.mts` updated deliberately rather than in passing.
- **This says nothing about the multi-cart question.** The bot's cart key here was a THIRD
  distinct one (`a6c5420d…`) minted while the earlier carts had already lapsed — sequential
  again, so `RC_HOLD_CAPACITY` still rests on nothing new. See `--cart-cap`.
- `worker/rc-precart-cart-key.test.mts` runs the **real served bundle** in a stub page and
  watches `fetch` — the first test to exercise the precart rather than syntax-check it.
  Verified failing against four regressions: the restored bail-out, not adopting `load`'s
  key, not writing it back, and judging the submit by status code alone.

### RESERVECALIFORNIA CAPS THE BOT'S CART AT 2 (2026-08-13)
Three holds were queued for one 08:00 release. Two carted within seconds; the third came back
with RC's own words: *"Your request violates the 'Maximum Reservations in Cart' restriction.
The maximum number of reservations allowed in the cart is '2'."* Nothing of ours failed — the
runner was there, the session was live, the timing was right.
- `#76` correctly stayed `requested` (retryable while its window is open), so claiming one of
  the other two frees a slot and it can go in on a later pass.
- **"This is a hard capacity ceiling, not a bug" — WRITTEN HERE, AND PROBABLY WRONG.**
  Corrected the next day; the original sentence is kept because it is how a self-inflicted
  limit gets recorded as a law of nature. See directly below before planning around a 2.

#### THE SEATS LEAK, AND NOTHING RECLAIMED THEM (2026-08-13, found the same day)
Two holds carted at 08:00 were still `carted` at **09:40**, with `last_attempt_note` =
*"RC session is dead — needs a human sign-in"*. Both had a valid `cart_key` and
`cart_entry_key`; nothing had gone wrong with the cart.
- **The release loop lives INSIDE `withRC`.** A dead RC session skips the whole callback,
  so nothing releases — and `expireStaleHolds` only *hands the runner a list*, it never
  moves a status. **Another watchdog wired to the thing it watches**, which is the exact
  failure `worker/expire-holds.ts`'s own header was written about, one level down.
- **The session is legitimately dead most of the day** (`maybeAutoLogin` signs in at T−30
  of the next release), so those rows would have sat until the following morning.
- **With a ceiling of two, two stuck holds ARE the entire fleet** — held for users who had
  already gone, while every later offer is refused against seats nobody occupies. That is
  the "several users have holds we cannot all claim" failure, arriving from the other end.
- `reclaimLapsedHolds` (in `expire-holds.ts`, on **Fly**, so it does not depend on the bot)
  marks a `carted` hold `expired` after `HOLD_LAPSE_MIN` (180 — far past RC's ~15-minute
  cart even if that unobserved figure is several times wrong). **`cart_key` is KEPT**: we
  did not release it, RC lapsed it, so the evidence stays and a later healthy pass could
  still try. The claim screen no longer says *"so we released the site"* — it says the site
  is back on the open market, which is true whichever way it ended.

#### ANSWERED 2026-08-15: THE CAP IS PER CART, AND THE CEILING IS OURS
`rc-probe.mjs --cart-cap` ran on the box and the four steps are decisive:
```
1. unit 43793 → a FRESH cart      → in cart: YES, holds 1, key 68928f9e…
2. unit 43794 → the SAME cart     → in cart: YES, holds 2, key 68928f9e…
3. unit 43795 → the same cart     → in cart: no, holds 0
   RC said: Your request violates the 'Maximum Reservations in Cart'
            restriction. The maximum number of reservations allowed in the cart is '2'.
4. unit 43795 → a FRESH cart      → in cart: YES, holds 1, key f572383a…
```
- **STEP 3 IS WHAT MAKES THIS AN ANSWER.** The control was refused **in RC's own words**, so
  step 4 succeeding is a real second cart and not an artifact of a probe that was never
  actually at the limit. Without that refusal the run would have been `INCONCLUSIVE`, which
  the script's own instructions say must never be rounded to a verdict.
- **Two carts live at once, one session, one account.** `68928f9e…` and `f572383a…`. So
  `RC_SITES_PER_CART = 2` is RC's and real; **`RC_MAX_CARTS = 1` was never RC's at all.** The
  hold runner reuses one cart key — `localStorage["shoppingCartKey"]`, passed as
  `existing || NO_CART` — and simply need not.
- **The data model already supports the fix.** `rc_hold_requests.cart_key` is per HOLD. The
  runner has to stop reading the browser's pointer and let each hold mint its own cart.
- **RAISE `RC_MAX_CARTS` TO 2, NOT TO UNLIMITED.** The probe's own closing line: *"NOT yet
  proven: how many carts a session may hold. This showed two."* That is the same discipline
  that kept it at 1 while it was unmeasured, and the reason this entry exists at all.
- **The retry case gets harder, and it was flagged before this ran.** A hold that carted but
  whose read-back failed stays `requested`; a retry into a NEW cart will not find the old
  entry. It must check both candidate keys, the way `rc-probe` already does.
- **DO NOT quote this run's login verdict.** Step 2 printed *"Already signed in (persistent
  profile) — skipping login"*, and the script flags the distinction itself. "Unattended login
  WORKS" is not earned by a run that skipped the login.
- **The probe emptied the RC session on its way through**, and the renewal repaired it
  unattended in 47 seconds — `04:07:43 renewing … (src=none)` → `04:08:30 ✓ renewed by
  authorize: none → 3580s`, with `cleared 0 storage key(s)`. That is the second production
  confirmation of the reliable cell, and the first as an unplanned recovery rather than a
  scheduled tick.
- **Step 7 writes `rc-blob.json` — a LIVE session, 13 keys.** It is gitignored
  (`scripts/auto-cart-bot/.gitignore`), so it cannot be committed, but it is full account
  access sitting in the working tree. Delete it after a run.

#### CAPACITY IS ENFORCED NOW, IN TWO PLACES (2026-08-13)
`RC_HOLD_CAPACITY` = `RC_SITES_PER_CART` (2, **RC's, measured**) × `RC_MAX_CARTS` (1,
**ours, and 1 only because that was all we could prove** — `--cart-cap` ANSWERED THIS on
2026-08-15: the cap is per CART, so this may go to 2. See directly above.)
- **The poller withholds the BUTTON** when the release window is full, and sends the
  ordinary coming-soon alert instead — same posture as `rcBotUsable`.
- **The `hold` action checks again**, because a link outlives the alert and two other
  people can tap in between. **It does not refuse**: a full window can empty (on 08-13 the
  third hold went in once one of the other two was claimed), so it accepts and says the
  site is *next in line rather than secured*. Refusing would throw away a hold that may
  well come good; repeating the flat promise is what makes a user stop watching.
- **`offered` counts.** The button is in an email we cannot retract, so it is a promise
  whether or not anyone tapped. Counting only taps is how three people end up on two seats.
- **A failed count fails CLOSED** (`MAX_SAFE_INTEGER`), like `rcBotUsable`.
- Not a lock — two shards could both see room. At a handful of holds a day that beats a
  transaction, and the failure is one offer over, never a wrong cart.
- `worker/rc-hold-capacity.test.mts`, verified failing against seven regressions.

#### TESTING THE HAND-OFF WITHOUT WAITING FOR 08:00 (2026-08-13)
`dueHolds` never cared what time the release is — it selects `requested` rows within
`leadSeconds` ahead and `graceMinutes` (20) behind, and the runner's `msUntilRelease` wait
is already clamped at zero for a time that has passed. So a hold with `release_at` two
minutes out is carted on the next 15s poll. **`scripts/rc-test-hold.mts`** queues one and
prints the claim URL.
- **IT COULD NOT RUN AT ALL, AND THE REFUSAL IS WHY NOBODY KNEW (found 2026-08-13).** The
  default watch lookup ordered by `w.updated_at` and **`watches` has no such column** — it
  has `created_at` — so every run that reached that line died on `column w.updated_at does
  not exist`. The only previous run had a live hold and exited at the refusal ONE STEP
  EARLIER, so the first line of the script's actual job had never executed. **A guard that
  fires on the first run postpones the first real test of everything behind it**; the
  refusal looked like the script working.
- **`--find` asks RC which units are genuinely bookable** on far-future midweek nights, per
  watched campground, and prints the `--unit`/`--arrival`/`--watch` triple ready to paste.
  "Never invent a unit id" was the one instruction here whose failure mode is locking a
  stranger's campsite, and it was left to a human with no tool to obey it.
  **Slices are keyed `2026-12-01T00:00:00`, not `2026-12-01`** — index by the bare date and
  every unit reads as booked, which looks exactly like a sold-out season. Read `slice.Date`,
  as `lib/availability/reservecalifornia.ts` does.
- **A REAL numeric unit id exercises the whole chain** — precart, `load` + `submit`, the
  cart read-back, the claim screen, `token captured`, the release. It also **LOCKS A REAL
  SITE** until the claim releases it or RC drops the cart, so: far-future midweek date,
  unpopular loop, and never an invented id. The sentinel unit tests the screen only.
- It **refuses while a real hold is live**, because a test cart takes a seat that user's
  site needs — and that refusal is what surfaced the leak above on its first run.
- **A TEST HOLD BLOCKS THE UPDATE WINDOW while it is live.** It inserts as `requested`,
  which `nextHoldRelease` counts, so the guard's 6h release check refuses an update for as
  long as the release is still ahead. Self-clearing the moment that time passes — but an
  "Update now" pressed in the same minute as queueing a test will refuse, and the reason
  will look like the 08-12 deadlock rather than the thing you just did.
- **Open the claim URL IN THE APP.** From a browser `canInject` is false and the injected
  precart is never exercised, which is the whole thing being tested.

#### THE CAP SAYS *CART*, AND WE PUT EVERY HOLD IN ONE CART (2026-08-13)
`rc-hold-runner` reads `localStorage["shoppingCartKey"]` and passes `existing || NO_CART`,
and `precartInPage` writes each winning key straight back — so the first hold of the
system's life minted a cart and **every hold since has been funnelled into that same one.**
The third hold did not hit RC's ceiling; it hit the second seat of the cart it was put in.

**THE "15 HOLDS, TWO CART KEYS" EVIDENCE WAS MINE AND IT IS MISLEADING (checked 2026-08-13).**
15 is the row count of `rc_hold_requests`; **only FOUR of those rows were ever carted**
(10 `expired` unanswered, 2 `failed`, 1 still `offered`). So the reuse evidence is not
"15 holds funnelled into 2 carts" — it is **three holds in one cart on one morning**, plus
one hold in one cart the morning before. Quoting the row count made a single day's
behaviour look like a long-standing pattern.
- **AND THE RUNNER DID NOT REUSE 08-12's CART.** `13d0e605…` took `#33` on 08-12 and
  `5b23626e…` took all three on 08-13 — a *fresh* key the next morning, without anyone
  changing the code. So `existing || NO_CART` does not funnel forever; `load` handed back a
  new cart once the old one was stale. **Minting a second cart is therefore not the
  unproven part** — obtaining one is already observed. What is unproven is whether TWO can
  be LIVE AT ONCE on one session, which is the only thing that raises capacity.
- The three 08-13 rows also show the cap releasing a seat exactly as expected: `#60` freed
  at 15:07:13 and `#76` carted into the same cart at **15:07:14**.
- **Why that is plausibly free to fix:** the cart is a free-floating GUID-keyed object with
  `CustomerId: 0`, and `load` mints a fresh one for the asking (that is the same finding
  that made the injected precart work). N carts of 2, one session, one account, **no new
  login, no new credential, no second identity.**
- **UNPROVEN, and do not act on it before it is measured.** Nobody has asked RC whether one
  session may hold two carts at once. Cross-session adoption, the keep-warm and
  `renewByReload` were all this plausible and all false.
- **`--cart-cap` IS BOT-SIDE CODE, so it cannot run until the box updates.** It shipped in
  `bf387c8` inside `rc-probe.mjs`, and the mini-PC only moves on `update.bat`, "Update now"
  or a quiet-window run — `autocart.bot_version` is what says whether it has arrived. A
  probe that is not on the box looks identical to a probe nobody has bothered to run.
- **`rc-probe.mjs --cart-cap` settles it** — cart A into a fresh cart, B into the same cart,
  C into the same cart (**the control: it must be refused with RC's own cap wording, or step
  4 succeeding proves nothing**), then C into a fresh cart. It releases only the entries it
  created, never `empty/shoppingcart`, and restores the profile's cart pointer.
  **Run it with the bot's cart EMPTY** — the probe signs in as the same RC account from a
  different session, so a real hold already in the bot's cart counts against any per-ACCOUNT
  cap and would fake the pessimistic answer.
- **If it comes back per-cart**, the fix is that the runner must stop reusing the key. Note
  the one retry case that gets harder: a hold that carted but whose read-back failed stays
  `requested`, and a retry into a *new* cart would not find the old entry — check both
  candidate keys, the way `rc-probe` already does.
- **If it comes back per-account**, then concurrency really does cost identities, and the
  poller must stop offering a third hold for a release window rather than promising one it
  cannot keep.

### THE HAND-OFF UI OVERHAUL, AND TWO BUGS IN THE INSTRUMENT (2026-08-13 evening)
Six notes from two real iOS hand-offs. All six shipped, plus two defects the work exposed.
- **A HOLD NOW HAS A HOME SCREEN** (`v2/HoldsPanel` + `GET /api/rc-holds/mine`). The only
  route to a site sitting in RC's cart was the alert that announced it — one email, one
  push, one device, and a token that cannot be reconstructed. Swipe the notification away
  and a campsite with a fifteen-minute fuse was unreachable. It renders at the TOP of
  Watches and **above both early exits**, so a watch-list error at 08:00 cannot hide it.
  Plain `<Link>`s on purpose: `Browser.open` or `target="_blank"` would drop the user in the
  system browser where `canInject` is false and the automatic cart silently degrades.
- **`/api/rc-holds/(.*)` IS ENUMERATED NOW.** The wildcard read as a description of the
  family because every route under it was token-authed; a Clerk-authed route arriving
  inside it is opted out of middleware protection *by the act of creating the file*.
- **THE CLAIM COPY IS A FUNCTION OF THE CAPABILITY** (`lib/claim-copy.handoffCopy`), and
  **the promise is EARNED and now allowed** — `canInject` only, post-release only, because
  two holds reported `✓ Added to cart`. Branch on CAPABILITY, never platform: the POSTs are
  measured on iOS and have never run on Android. `worker/rc-handoff.test.mts` now CALLS the
  function instead of reading a file; the pre-release exclusion is a denylist so a new field
  is covered by default. **The old regex was narrower than its own comment** — it demanded
  `add …cart` or `cart it`, and *"We're putting it in your cart"* walked straight through.
  First version defeated by a `<strong>` tag, second by a synonym.
- **THE INJECTED BANNER HAS THREE STATES** (`extension/content-rc.js`): `signin` has NO
  button at all — `rc-inject.js` broadcasts the token on RC's first authenticated call, so
  signing in IS the trigger and the retry is automatic; `working` has no control; `carted`
  offers only the way to checkout, and the sentence names the cart icon. `carting`/`carted`
  guard `addToCart` itself, not the button — it is also reached from the auto-retry and from
  a re-injection. **`#camphawk-rc-status` is untouched**: the epilogue observes it, so the
  frame changed and never the sentence.
- **THE SIGNIN STATE NOW HAS A BUTTON, AND IT IS NOT A RETRY (2026-08-13 evening).** "No
  button" was right about the CART — signing in is itself the trigger — and wrong about what
  the user needs: RC lands them scrolled down at the availability calendar with its own
  sign-in control off screen, so the instruction pointed at something invisible. `signin` now
  **scrolls to the top** (that state only; moving the page under someone mid-cart is its own
  bug) and offers a **Log in** button that finds RC's own control and presses it. Matched on
  the ACCESSIBLE NAME, never a class — RC's class names are generated and the words a user
  reads are the stable part — and restricted to `a`/`button`, because an injected script
  clicking any div whose text says "sign in" is how it starts pressing things nobody meant.
  **Not found is a fine outcome:** it says so and leaves the page alone rather than
  navigating to a sign-in URL nobody keeps honest.
- **`carted` SAYS ONE THING NOW.** It carried an eagle, a headline, `CA State Parks · <date>
  (1 night)`, a status sentence AND a button — four lines to say "it worked", stacked over
  RC's own checkout controls. The subtitle and status line are hidden in that state. **The
  status ELEMENT stays in the DOM and `setStatus` keeps writing to it** — hidden, never
  removed, because the epilogue reads `#camphawk-rc-status` for the hand-off's verdict and
  removing it would blind the diagnostic at the moment it finally has something to say.
- **RC scrolled the user PAST its own sign-in control**, and `presentationstyle=fullscreen`
  answers the choppy seam (the plugin's iOS default is `pagesheet`, a card that deliberately
  shows the presenting screen above it). `location=yes` stays, permanently.
- **THE REPORT COLLAPSE ONLY LOOKED AT THE PREVIOUS LINE, AND IT COST THE PROOF.**
  `rc-inject.js` rebroadcasts the token AND the cart key on every RC call, so the stream is
  `token, cartkey, token, cartkey…` — **no two neighbours are ever identical and nothing
  collapsed.** Both 08-13 hand-offs stored 40 reports, 39 of them that pair, and
  `recordClientReports` keeps the TAIL — so `✓ Added to cart` was trimmed off the front of
  both. The proof of the whole channel's purpose survived in a screenshot. Fixed by deduping
  the mechanical stages against the whole run; scoped to `token`/`cartkey` because RC's own
  status text can go A → B → A.
- **AND THE READOUT QUOTED THE WRONG LINE.** It printed `RC declined (200) — cart is already
  added` as the verdict on both proven holds. That is a **re-injection submitting over an
  entry we already hold, i.e. evidence the cart SURVIVED.** It scans the whole run now, and
  prints the PLATFORM per hand-off — which is what makes one Android run self-answering.

**THE CLAIM SCREEN IS NOW ONE BUTTON AT A TIME (2026-08-12 evening).** Three numbered steps, a
checkbox and a dead button became `Start hand-off` → `Waiting for you to sign in…` →
`Signed in — it's mine, hand it over`. **The final press STAYS** — signing in is not the same
intent as "I am ready now", and auto-releasing on the token would hand the site to whoever else
is watching while its owner put the phone down. What was removed is the busywork, not the
decision. Unconfirmed still falls back to the checkbox; the browser path is unchanged.
- **`/api/admin/test-claim` + the "Open the claim screen" button** make the whole flow testable
  without waiting for 08:00. It MUST be an in-app link: the same URL from Mail or Messages
  opens the system browser, where `canInject` is false and the flow degrades to the checkbox,
  testing nothing. Push carries a url and works too, but only from a runtime with FCM.
- **THREE BUGS FOUND ON THE FIRST REAL RUN, ALL THE SAME SHAPE — the app doing the right thing
  while the screen described a different product.** None would have surfaced before 8am.
  1. **Stranded when it WORKED.** Already-signed-in user → token captured instantly → gate
     flipped → and they saw none of it, because the claim screen is UNDERNEATH the webview.
     The green release button was rendered one layer down the whole time. `closeOnToken` closes
     the sign-in window on capture. **NEVER on the cart path** — there the token is the MIDDLE
     of the job and closing would kill the webview before the two cart POSTs.
  2. **The IAB toolbar sat ON the content** and read as a truncated URL between two dead
     arrows. `toolbarposition=top`. `location=yes` STAYS — hiding whose site you are
     authenticating on is the shape of a phishing page.
  3. **"Switch to your ReserveCalifornia tab" — there is no tab in the app.** An instruction
     the reader cannot follow is worse than none: it reads as a missed step at the one moment
     the design wants them to sit still. Branched on `canInject`.
- **STEP ONE IS PROVEN IN THE APP, 2026-08-12 evening.** The synthetic hold captured 17
  client reports on a real run: `injected` on `/park/6/358` (the real URL shape, from
  `lib/booking-url`) → `idle` → Okta `/authorize` → `/login/callback` → **`token captured ·
  939`**, then two further captures on the park page, then `closed` — which is `closeOnToken`
  working. So the webview opens, the script injects, RC signs in INSIDE it, and the gate's
  signal arrives. Same 939 length the 08-09 emulator tests produced.
  **`job:false` throughout is correct** — step one passes no `unitId` precisely so it cannot
  cart. **The two cart POSTs remain unproven** and still need a real held unit.
- **A SAFE WAY TO FABRICATE A TEST HOLD.** `unit_id` is NOT NULL and an invented one can
  collide with a real site and lock it — so use a **non-numeric sentinel**
  (`__camphawk-verify-DO-NOT-USE__`; real RC unit ids are numeric), and set `release_at` months
  out. `nextHoldRelease` counts `carted`, so a near date would put a real release on the books
  and block the 02:00–05:00 update window. One is parked now: hold `06febc63-6c84-49ac-bf53-
  0123d9bb7e81`, Carpinteria, releasing 2026-12-20 — **deleted 2026-08-12 once it had answered.**

### Stripe is constructed lazily, in ONE place (2026-08-12)
Five routes did `new Stripe(process.env.STRIPE_SECRET_KEY!.trim())` at **module scope**.
`!` is a promise you cannot keep about an env var: if the key ever went missing, `.trim()`
throws *while the module is being evaluated*, so the route never reaches its handler at all
— **dead, not degraded** — across checkout, plan, portal, account deletion and the
**webhook**. A dead webhook is silent by construction: Stripe retries for days while
subscription rows quietly stop matching what people pay.
- `lib/stripe-client.getStripe()` moves the throw to the first request that needs Stripe,
  caches on success, and names the variable *and* where it is configured.
- **Six sites, not five** — `admin/page.tsx` had one too. It was already safe (guarded,
  returns `null`) and keeps that posture via `stripeConfigured()`: a dashboard tile should
  say "no figure", which is the opposite call from a billing route.
- **Typecheck caught what the edit missed**: three module-scope helpers outside the handlers
  also used the client. That is the case for a typecheck gate in miniature.
- Deliberately **not** `import 'server-only'` — it resolves to a throwing stub outside a
  server bundle, including `node:test`, which would make the missing-key behaviour
  untestable. The property is asserted mechanically instead.
- `worker/stripe-init.test.mts` scans the whole `src` tree, because the point is that the
  *sixth* route somebody adds cannot reintroduce it.

### The box ran out of COMMIT, and both diagnostics looked the other way (2026-08-12)
`supervise.ps1` could not start a shell at all — *"the paging file is too small"*, then an
`OutOfMemoryException`. **A supervisor that cannot launch a shell cannot restart anything**,
so the process whose whole job is bringing the keep-warm and hold runner back failed at the
one moment it exists for, and silently, because it is the thing that would have reported.
- **It is COMMIT (RAM + page file), not disk.** `disk-free` answered 404 GB the same night,
  which reads as "not a space problem" and sends the question the wrong way. Windows could
  not *grow* a system-managed page file fast enough for a burst.
- **`list-processes` cannot see the culprit by construction** — it matches our node and
  PowerShell scripts only, so every Chromium (resident RC tab, rec.gov per-user profiles,
  any orphan a force-kill left) is invisible. Those are the large ones.
- **`memory`** reports RAM, commit against the limit, page file allocated/peak + whether it
  is system-managed, our Chromium count and private total, and the top 12 by private bytes.
  Ours is matched on our profile dirs — the same rule `stop-all` kills by — so the owner's
  own browser is only ever a count. Commit comes from `Win32_OperatingSystem`'s *Virtual*
  figures, not a perf counter: counter names are localised and the classes can be disabled.
- **`mini-pc\fix-pagefile.ps1`** reports by default, `-Apply` writes. Sizes derive from the
  box's own RAM (initial 1.5x floor 16 GB, max 4x floor 32 GB), it turns automatic
  management off FIRST (it otherwise overrides the write and ignores it silently), and it
  **reads the setting back**. It never reboots — the change is not live until one, and a
  restart ends the RC session exactly like `update.bat`.
- **Raising the ceiling is not reducing what sits under it.** "Chromium is the biggest
  consumer" is an inference from what runs, not a measurement; the first `memory` reading
  decides whether consumption also has to come down.
- **A `.ps1` trap now guarded mechanically:** a backtick continues a line only as the LAST
  character before the newline — one trailing space and it escapes the space, the statement
  ends there, and the parse error surfaces well below the cause. Invisible in every editor,
  and there is no PowerShell on the machine these files are written from.

### `--once` asserted the one thing it never checked (2026-08-12)
`rc-hold-runner.mjs --once` with nothing queued printed *"Feed reachable, token accepted"* —
and that line sat **above** the early return, so `withRC` was never reached: no profile, no
browser, no token, nothing sent to RC. `rc-check.bat` runs it as step 1, so **the message
somebody sees when they are worried was the one least entitled to reassure them.** The quiet
pass now goes through `withRC` with a no-op callback — a full rehearsal of everything except
the two cart POSTs, which cannot be rehearsed without a real held unit. Three outcomes kept
apart: pass, dead session / profile-not-taken (`withRC`'s own reason verbatim, plus "the
SESSION was not tested"), and expired/undecodable — never rounded up to a pass, which is the
2026-08-09 false green. `worker/rc-runner-smoke.test.mts`.

### Retry a DB call only when it never left (2026-08-12)
Two real-DB tests flaked with `DB mutate error: DNS resolution failure`, and both times I
re-ran and shrugged — which is how a real regression gets waved through. `client.ts` now
retries (3 attempts, 200ms doubling), split by **what the message proves, not how transient
it feels**: DNS/`ECONNREFUSED`-class errors prove nothing was sent and are retried for reads
**and** writes; `fetch failed`/`ECONNRESET`/`timed out` may have executed and are retried
for **reads only** (`query` goes to `exec_select`, which refuses anything data-modifying).
`fetch failed` sits on the dangerous side deliberately: undici raises it for DNS failures
too, but supabase-js hands us `error.message` with the `cause` already discarded. Real
database errors are never retried — that only makes a broken query look like a slow one.

### Supabase's "CRITICAL" RLS email was a false positive (2026-08-11)
`rls_disabled_in_public` on **`spatial_ref_sys`** — a table PostGIS creates and owns. It is
not ours, it holds published coordinate-system definitions, and it cannot have RLS enabled
by us anyway. Nothing to do. Real RLS coverage is migration 027 plus `action_tokens` and
`alert_canary`; if a future alert names one of ours, that one is real.

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

### 2026-08-10 08:00 MISSED — a WEDGED keep-warm held the Chromium profile
South Carlsbad `#42` was `requested` and never carted. The runner was alive, tried on
every pass, and said exactly why: **`Chromium profile held by rc-keepwarm`**. The 046
machinery worked — this was one command to diagnose, against six hours of guessing on
08-07. Three of the four locked units were still free at 08:11 and were bookable by hand.
- **The keep-warm hung at ~04:48 UTC and held the profile lock for ten hours** without
  running its loop. `maybeAutoLogin` lives INSIDE the keep-warm, so no 07:45 sign-in
  either; the Okta session had expired at 04:35 UTC.
- **A STALE VERDICT IS NOT A DEAD ONE, and only dead rings the phone.**
  `autocart.rc_session` read *"RC accepts the session for 10h23m, checked 37401s ago,
  STALE"* — level `warn`. `holdAtRisk` fires on a session reported dead, so a verdict ten
  hours old with a hold 45 minutes out rang nothing and the 07:30 pre-flight showed amber.
  The "unknown is not healthy" rule was applied to the VERDICT and not to its AGE.
- **Profile preemption is cooperative and a wedged holder never cooperates.** The runner
  drops `.camphawk-profile-wanted` and waits 60s for the keep-warm's loop to notice; the
  lock's staleness handling only covers a CRASHED holder, not a hung-but-alive one.
- **`rc-check.bat` is reassuring in exactly the fatal case.** Its step 2 printed
  *"profile busy (rc-keepwarm) — skipping this pass, NOT a dead session"*, which is true
  and useless: it cannot tell "mid-pass, fine" from "wedged for ten hours". Only
  `rc-login.bat` clears it (kills by command line, deletes the lock).
- **Nothing watches the watcher.** Ten hours of silence from a process that reports every
  20 minutes should be an alarm on its own, independent of its last verdict.
- **Timing note, not a conclusion:** `bf271dd` deployed at 04:50:17Z, ~2 min after the
  keep-warm's last report. A deploy blip should log and retry, not wedge a loop — but an
  unhandled rejection on a failed POST would do exactly this, and that would make ANY
  network blip fatal. Unproven either way; worth ruling out before blaming the process.

### THE MINI-PC SUPERVISES AND UPDATES ITSELF NOW (2026-08-10) — needs ONE last update.bat
Nothing restarted a dead process: `start-all.bat` opened bare `powershell -NoExit` windows,
so a process that exited left a window with an error in it and its job stopped being done.
That is why both missed mornings needed a human, and it is what multiplies per state.
- **`supervise.ps1`** wraps every long-running bot process (bot, broker, keep-warm, hold
  runner — NOT cloudflared, which reconnects itself). Restart on exit, exponential backoff
  capped at 5 min, and it **stops loudly after 5 exits in 10 min**: a process that dies and
  restarts instantly is a busy loop wearing a service's clothes, spending the RC login
  budget while every dashboard stays green.
- **IT IS WHAT COMPLETES THE KEEP-WARM WATCHDOG.** That watchdog deliberately EXITS on a
  wedged loop so the Chromium profile frees for the hold runner — but unsupervised,
  "released the profile and died" left the session unattended until morning. Supervised:
  exit → restart → `maybeAutoLogin` re-establishes the session → 08:00 still fires.
- **`auto-update.ps1` + `install-autoupdate.bat`** (run once, as admin) register an HOURLY
  task that almost always does nothing. `update-guard.mjs` owns the decision — in JS,
  because it is the part that can lose a campsite and PowerShell is the part nothing can
  test (`worker/update-guard.test.mts`). It refuses outside **02:00–05:00 PT**, refuses
  **within 6h of a real release**, and refuses outright **if it cannot reach the feed** —
  unknown is not safe, and an update ends the RC session.
- **It verifies rather than assumes:** after relaunching it waits up to 4 min for
  `autocart.rc_runner` to go `ok`, and **rolls back to the previous commit** if it does
  not. Same rule as the worker deploy Action failing unless a fresh heartbeat lands.
- Supervisors are killed BEFORE the checkout moves, or they restart the children being
  replaced and the box runs old code under a new commit.
- **STOPPING IS `mini-pc\stop-all.ps1`, AND EVERY START PATH CALLS IT (2026-08-11).**
  An update "just added another 5" windows. Four causes, one shape — something that looked
  like it stopped the old processes and didn't. (1) These windows are `powershell -NoExit`,
  so a dead process leaves its console behind: **"is there a window?" was never evidence
  anything was running.** (2) `update.bat` killed by WINDOW TITLE, which matches nothing —
  the identical bug fixed in `rc-login.bat` on 08-08 and left here; it survived on
  `taskkill /IM node.exe /F` until supervisors shipped, after which the supervisors lived
  through it and **restarted the children it had just killed**. (3) `auto-update.ps1` never
  stopped cloudflared (which `start-all` relaunches — one duplicate tunnel per update,
  forever) and its pattern missed `bot.mjs` entirely; **`Stop-Process` does not kill a
  process TREE on Windows**, so killing the `npm start` shim left the rec.gov bot orphaned.
  (4) Nothing killed an orphaned **Chromium** — Playwright's browser outlives a force-killed
  parent and holds the real Chrome lock on the user-data-dir, which deleting our own lock
  file does not touch. stop-all kills supervisors → payloads by name → bot Chromium scoped
  to our profile dirs, then **RE-CHECKS and exits non-zero**; callers refuse to launch on a
  failed stop. **`start-all.bat` stopping first is what makes the duplicate structurally
  impossible** rather than merely fixed in the update paths.
  **Never kill by image name:** `taskkill /IM chrome.exe /F` was in `update.bat` and closes
  the browser of whoever is sitting at this machine.
  Two more found the same read: `rc-login.bat` relaunched the RC pair **unsupervised**, so
  a hand sign-in quietly downgraded the two processes it was fixing (the keep-warm's wedge
  watchdog exits on purpose expecting a restart — that is the 08-10 ten-hour silence); and
  `auto-update.ps1` called `Report-Applied` above its definition on the new refusal path —
  **PowerShell runs top-down**, so it would have died on "not recognized" and left the
  request PENDING, i.e. retried every 15s.
  Tests strip comment lines before asserting a pattern is ABSENT, or "must not kill by
  image name" fails on the comment explaining why not to.
- `update.bat` stays as the manual path, and still ends the RC session.
- **UPDATES ARE ON-DEMAND NOW (migration 051), and the timer is the FALLBACK.** Admin →
  System Health → **"Update now"** sets a flag; the hold runner sees it on its next 15s
  poll and hands off to `auto-update.ps1` (detached — the updater kills the runner on its
  way through, and once per process life, because two updaters racing one checkout is
  worse than a slow update). The scheduled task runs every 5 min and almost always
  refuses. **A request lifts the quiet window and NEVER the release check** — an update
  ends the RC session however it was triggered, so "I asked for it" must not override "a
  cart is minutes away". Nothing connects INTO the box: it is behind a home router, and
  opening a port on the machine holding the RC session to save a scheduled task is a poor
  trade. The request is cleared whether the update succeeded or not, or a failure would be
  retried every 15 seconds.
- **A MANUAL RE-LOGIN AFTER AN UPDATE IS NOW OPTIONAL.** The update still ends the session
  (the token lives in the Chromium it closes), but `maybeAutoLogin` restores it ~15 min
  before the next real release, unattended, proven 2026-08-10. Expect
  `autocart.rc_session` to read dead in between — that is correct, not a fault.

### The rec.gov auto-relogin never retried — a log line that lied (2026-08-11)
`keepSessionsWarm` skipped any profile with no `.camphawk-ready` marker
(`if (!isLoggedIn(...) || inUse.has(...)) continue`), and a failed auto-relogin **deleted
that marker unconditionally — three lines after logging "keeping the saved login, will
retry next cycle"**. The pass that promised the retry switched off the gate the retry
needed, so the FIRST failure (CAPTCHA or not) disqualified that user from every future
keepalive pass, forever. One account sat 12 days with nothing trying.
- **It read as a permanent rec.gov CAPTCHA and was not.** Nothing was standing in the way;
  nothing was attempting. Don't infer a live challenge from a stalled retry.
- The two-strike bad-password rule was **dead code** for the same reason — the second
  strike could never be thrown.
- **AND IT ESCALATED.** `LOGIN_MODE` defaults to `local`, where the main loop calls
  `ensureLogin()` on a missing marker: a 10-minute interactive window nobody is at, then
  `setEnrollment(false)` — it turns the user's auto-cart **off**. So the missing marker
  didn't just stop the retry, it un-enrolled people over a CAPTCHA the bot had already
  decided to retry past.
- **THE FIX IS NOT "STOP DELETING THE MARKER".** `.camphawk-ready` is read by `processJob`,
  which must not cart against a session known to be dead. The marker was carrying two
  meanings that came apart when auto-relogin was added — "the session is live" and "this
  profile is eligible for a pass". Separate now: the session flag stays honest,
  `.camphawk-relogin` carries the owed repair, and both `keepSessionsWarm` and
  `ensureLogin` honour it.
- **BOUNDED, because the naive fix is an unbounded loop.** Every attempt opens a headful
  browser and posts credentials from the household IP. CAPTCHA: 6 attempts on 30m/1h/2h/
  4h/6h (13.5h — crosses an overnight challenge, surfaces the same day), then gives up
  loudly into manual reconnect **keeping the credentials**. Rejected password: still 2, and
  `deleteCreds` — a wrong password never fixes itself and hammering it risks a lockout.
- Decision logic is a pure module (`scripts/auto-cart-bot/relogin-retry.mjs`);
  `worker/relogin-retry.test.mts` verified failing against the restored gate, against
  `ensureLogin` firing during a pending repair, and against a success that fails to clear
  the marker.
- **`/connect` was never affected** — that is `broker.mjs`, a separate flow that always
  attempts a fresh sign-in and hands a CAPTCHA to whoever is at the page.

### PowerShell scripts must be pure ASCII (2026-08-11)
An em dash inside a double-quoted string took **all four supervised processes** down.
Windows PowerShell 5.1 reads a `.ps1` **without a BOM as Windows-1252**; the em dash is
`E2 80 94`, byte `0x94` is `U+201D` (curly right double quote), **and PowerShell accepts
curly quotes as string delimiters**. The string closed mid-line and the parse cascaded into
"missing the terminator", reported six lines from the cause. The same bytes in a COMMENT
are harmless, which is why it needs checking mechanically — today's comment is tomorrow's
message string. **ASCII, not a BOM**: a BOM is invisible and any editor or `git`
normalisation can drop it. `worker/update-guard.test.mts` fails on any non-ASCII byte.
- Same mismatch through the other door: Node writes UTF-8 and the console is cp437, so
  `supervise.ps1` sets `[Console]::OutputEncoding` — otherwise every em dash lands in
  `logs\rc-keepwarm.log` as `TCo`, and those files are the post-mortem record.
- **The pre-flight Routine moved 07:30 → 07:40 PT** (`trig_015nU7BciNU5GKimmgXjvAZG`). At
  07:30 it now collides with `maybeAutoLogin` and would report "dead" during the repair —
  the 08-09 cry-wolf exactly. At 07:40 it reports the outcome with 20 minutes to act.

### The auto-login lead is T−30 now, and "covered" is DERIVED (2026-08-11)
`RC_AUTOLOGIN_LEAD_MIN` 15 → **30**. The ceiling is arithmetic, not taste: a login at T−L
mints a ~60-minute token, and the bot needs it to **RELEASE at up to T+15** (the user has
the whole cart hold to tap claim, and `remove/cartentry` runs on the bot's session), so
`T−L+60 ≥ T+15` → **L ≤ 45**. At 30 the token still has 30m at the cart — twice the cart
hold — and a human gets 30 minutes to answer the phone, find a computer and sign in. **The
extra fifteen minutes are for a HUMAN, not for the bot to retry**; one attempt per release
stands, because repeated logins from this address are what cost 12h of IP block on 08-06.
- **`AUTOLOGIN_MIN_TOKEN_MIN` was a flat 20 and that was ALREADY WRONG at L=15.** "Covered"
  has to mean alive through the **release**, not through the cart: at 20 the bot sees a
  token with 21 minutes left, calls the hold covered, skips its ONE login, carts at T−0
  with ~6 minutes of token and then **fails the claim** — the user taps "I'm ready" and
  nobody releases the unit. Reachable by signing in by hand an hour before a release, i.e.
  exactly what the 07:30 pre-flight asks for. Now `LEAD + CART_HOLD_MIN + 5`.
- **`ALARM_AFTER_MIN` 12 → 25 must move WITH the lead.** It is the fallback branch (the
  keep-warm reporting nothing at all); a login that fails still rings at once on the
  `auto sign-in failed` branch. At 12 against a lead of 30 it satisfies "inside the lead"
  and buys an **18-minute silence** in the only window where someone can act — so the test
  asserts *how far* inside (≤8m), not merely that it is.
- **THE TWO HALVES DEPLOY BY DIFFERENT ROUTES**: `ALARM_AFTER_MIN` is on Vercel (instant on
  a `master` push), `AUTOLOGIN_LEAD_MIN` is mini-PC code (needs `update.bat`). In the gap
  the alarm fires at T−25 while the login still waits for T−15 — **the 2026-08-09 cry-wolf
  bug exactly.** Land them together.
- `worker/autologin-lead.test.mts` holds the inequality: the constants live in three files,
  two languages, and `rc-keepwarm.mjs` cannot import `RC_CART_HOLD_MINUTES` from
  `limits.ts`, so it carries a copy the test pins. Verified against five regressions.

### UNATTENDED LOGIN WORKS — first clean production run, 2026-08-10 18:35Z
`rc-test-login.bat` ran the real `attemptLogin` from a genuinely signed-out state and got
`token exp in 60m; okta=ALIVE (exp 2026-08-11T06:35:53)` — a full-life access token AND a
12-hour Okta session, i.e. `keepSignedIn()` ticked the box. `session_live_since` and
`session_since` both moved, so it was a real transition, not a reconfirmation.
**This is the first time the path has succeeded unattended.** The three "failures" on
08-09 were the missing already-signed-in branch, not the login. A dead session is
therefore no longer automatically a human errand — but `maybeAutoLogin` still gets ONE
attempt per release and a CAPTCHA is still a full stop, so the human fallback stays.

### `update.bat` ENDS the RC session — update FIRST, log in AFTER (2026-08-10)
`rc-login.bat` said *"your sign-in survives that — it lives in `.rc-bot-profile\`, which
nothing deletes"*. The PROFILE survives; the SESSION does not. RC keeps no Okta session
cookie in the profile (the 2026-08-09 finding), so **the access token in the running
browser IS the whole session** — and `update.bat`'s `taskkill /IM node.exe /F` closes that
browser. Measured: a hand sign-in at 16:15:06Z read *"no token at all — signed out; okta
session GONE (404)"* at **16:23:08Z**, straight after an update. Both scripts say so now.

### Twilio A2P ticket #28871693 — ANSWERED 2026-08-11, and the answer is DON'T EDIT
Twilio (Christian M.) replied. Two things, and together they retire the work rather than
authorise it.
- **"No filtering has occurred since August 5th."** Our own receipts say it harder:
  **08-06 → 08-12 is 71 sent, 71 delivered, 0 undelivered.** The one bad day is 08-05
  (27 sent, 9 delivered, 13 undelivered, all `30007`) — before `camphawk.app/b/<token>`
  came out of SMS. *(08-03/08-04 read 0/0 because they predate migration 038's receipt
  tracking — `untracked`, not failures. Do not count them as either.)*
- **He offers to escalate for API campaign edits** (up to a week). He first says an
  approved campaign "cannot be edited", which contradicts Twilio's own rectifying-campaigns
  doc — the correction already recorded here — and then concedes the API path himself.
  Not worth arguing; take the capability.
- **TWILIO REPLIED AGAIN 2026-08-13 16:42 PT.** Four points. Two are pending escalations —
  the filtered-message examples went to the Carrier Partner, and **API campaign edits are
  still being enabled**, which remains the blocker for putting `camphawk.app` back into SMS.
  One is closed: **the sender identifier "CampHawk" is compliant**; non-compliance would mean
  a real brand discrepancy (his example: "Camp Walk").
- **THE FOURTH — OPT-OUT LANGUAGE — WAS CONSIDERED AND DELIBERATELY NOT BUILT.** Twilio
  recommends `Reply STOP` in the first message and every third message or monthly, and warns
  that missing it "can significantly increase the risk of filtering". **We carry none, in any
  message, ever — and our own data rules it out as a cause of anything we have seen.** 08-05
  was a controlled comparison: same handset, same day, same segment count, and NEITHER arm had
  opt-out language, so it cannot explain why the recgov link delivered and the camphawk.app
  link did not, 10 for 10. And 77+ for 77 have delivered since 08-06, still with none. **STOP
  already works** regardless — Twilio's Messaging Service handles the keyword at the platform
  level whether or not we advertise it, so users can opt out today; the gap is only that we
  do not TELL them.
  The cost is real: per-user tracking, a dispatcher branch, and ~21 characters against a
  **5-character** one-segment margin. **Revisit it as part of reintroducing the camphawk.app
  link**, which is the change that already spends risk and the one moment where stacking a
  second documented factor would be a bad trade. Not before.
- **THE OWNER REPLIED 2026-08-13 AND WE ARE WAITING ON TWILIO.** The ball is in their court;
  do not draft another reply, and do not submit an edit until the capability is confirmed
  enabled on the account. **The replacement samples are already generated and waiting** in
  `docs/a2p-campaign.md` (from `scripts/a2p-samples.mts`) with three caveats recorded beside
  them — read those before acting on whatever Twilio says, particularly that the 08-12 link
  test cannot rank link shapes and that the measured shape (`/manage/<token>`) is not the
  proposed one (`/claim/<uuid>?t=`).

> **SUPERSEDED 2026-08-12 BY THE OWNER: WE NEED THE camphawk.app LINK BACK.** Removing it
> was a stopgap to stop losing texts, not the design. So the edit IS wanted, and the
> paragraph below is kept only because its RISK analysis still stands — read it as "why to
> get the samples right before spending the edit", not as "do not edit".
>
> **What the edit can and cannot do.** It CAN change `message_samples`, `description` and
> `message_flow` on an approved campaign; only the four booleans are frozen, and
> `HasEmbeddedLinks` is already `Yes`, so nothing blocks us. It CANNOT "register the
> domain" — **there is no declared-link-domain field**, only that boolean and the samples.
> Whether the carrier keys on samples is INFERENCE; do not promise it.
>
> **THE MEASUREMENT IS BUILT: `scripts/sms-link-test.mts`** (2026-08-12). Dry-run by
> default; `--with-redirect --send` sends four variants — provider-only control, bare
> domain, `/manage/<token>` (the untested one), and `/b/<token>` as the positive control —
> then `--read` prints the carrier receipts. **`--read` needs only the DB**, so results can
> be pulled from any session; only `--send` needs Twilio. It refuses without
> `TWILIO_MESSAGING_SERVICE_SID` (`MG7bf4f78c06ea99f61efcbccd8fe47b5b`, recorded in
> `docs/a2p-campaign.md`) because the A2P campaign hangs off the Messaging Service and a
> bare From number would make the result uninterpretable. Full notes in `docs/SETUP.md`.
> **Run it before spending the edit** — the samples should show the shape that actually
> delivers.
>
> **IT HAS BEEN RUN — 2026-08-12, 4 of 4 DELIVERED, AND THE RESULT IS INCONCLUSIVE BY
> DESIGN.** Provider-only, bare `camphawk.app`, `camphawk.app/manage/<token>` **and the
> `/b/<token>` positive control** all came back `delivered` with no error code. The control
> is the whole reading: `/b/` is the exact shape filtered **13 for 13 on 08-05**, and it
> arrived. **So nothing is being filtered right now, and this run cannot rank link shapes** —
> it has no discriminating power when every arm passes. That is precisely the confound
> `--with-redirect` exists to expose, and it matches Twilio's "no filtering has occurred
> since August 5th" rather than contradicting it.
> - **Do NOT read this as "camphawk.app links are safe again."** What it licenses is
>   "our domain was not filtered on 2026-08-12", which is a statement about the day, not
>   about the shape. Filtering is carrier-side and can resume without notice; the 08-05
>   evidence that `/b/` gets filtered *when filtering is on* is untouched by this run.
> - **The unknown-token `/b/` link still 302s** (it redirects to `/`), so the control really
>   was a redirect and not an accidental 404 — checked, because a 404 would have made it no
>   control at all.
> - **What this DOES settle for the samples:** shape cannot be chosen on evidence, so choose
>   it on the documented rule instead — T-Mobile §4.8 names redirects, so put
>   `camphawk.app/manage/<token>` in the samples and keep `/b/` out of SMS. That was already
>   the standing instruction below; the measurement neither strengthens nor weakens it.
> - **To get a real answer the run must land while filtering is ON**, which is not something
>   we can schedule. The cheaper path is to reintroduce the non-redirect link behind the
>   delivery panel (migration 038) and let it be the detector, exactly as it was for the
>   regression it already caught.
>
> **BOTH HALVES OF THE INSTRUMENT WERE BROKEN, AND THE FIRST RUN IS WHAT FOUND OUT.** The
> script had never executed with real credentials, so nothing had ever exercised its write
> path. Three defects, each hiding the next:
> 1. **A leading space on `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`** failed all four sends
>    with `Authentication Error - invalid username` — which names the *username* and so
>    reads as a wrong or revoked SID. Nothing in the repo trimmed. Now `lib/notifications/
>    twilio-env.ts`, one trimmed reader, six call sites, guarded by a tree scan in
>    `worker/twilio-env.test.mts`. **The expensive site was never this script**: the same
>    untrimmed read guarded `/api/webhooks/twilio`, which verifies receipts and **fails
>    CLOSED** — a padded token there 403s 100% of carrier callbacks and every message sits
>    `sent` with no `delivery_status` forever, i.e. it silently disables migration 038.
> 2. **`notifications.user_id` is NOT NULL** and the script supplied none, so all four
>    inserts failed *after* the texts went out. It printed `Sent 4 of 4` (true) and `--read`
>    then said *"No sms_test rows yet. Run with --send first."* — the sentence meaning **you
>    have not run the experiment**, shown to someone who just had. Two faults, one output;
>    the house failure mode. The row is now pre-flighted before the first text, and both
>    messages name the other possibility.
> 3. **`channel = 'sms_test'` was rejected by `notifications_channel_check` outright.** The
>    isolation the header documents at length — never `'sms'`, so the experiment cannot turn
>    the admin panel red — was never once possible. **Migration 057** adds the value;
>    applied to prod 2026-08-12.
> The 08-12 run was recovered from Twilio's own Messages API rather than re-sent, so the
> four rows in `notifications` are the real receipts, marked `backfilled` in their payload.
>
> **MEASURE FIRST, and test the SHAPE not just the domain.** Every filtered message carried
> `camphawk.app/b/<token>`, and `/b/` is a **302 redirect** — T-Mobile's Code of Conduct
> §4.8 is literally "URL Redirects/Forwarding" and §3.3 "Use One Recognizable Domain Name".
> That is the only DOCUMENTED violation in the whole picture. The discriminating experiment
> dropped `Manage:` and kept the `/b/` link — still filtered — so **a non-redirect
> camphawk.app URL has never been tested.** `camphawk.app/manage/<token>` may well deliver
> today with no edit at all. Use the delivery receipts (migration 038) to find out, the same
> way domain-vs-length was settled.
>
> **When the links do come back, do NOT use `/b/` in SMS.** Link to the real destination.
> Then put THAT shape in the samples.

**THE ORIGINAL DECISION (now superseded): accept the escalation, do NOT submit an edit.** The edit's only purpose was
ever to make `camphawk.app` links legal in SMS, and we removed those links instead — which
is what fixed delivery. Submitting an edit **re-triggers vetting on a campaign that is
currently delivering 100%**, to buy something we are not using. Enabling the API permission
is an account flag and costs nothing; making an edit is the risky act. Keep the option,
don't spend it.

**What would change this:** wanting the `Manage:` link back in SMS. That is the one reason
to spend the edit — and it needs the samples updated FIRST (`scripts/a2p-samples.mts`
generates them from the dispatcher), because the current registration's samples link only
to `recreation.gov` and `reservecalifornia.com`.
**Do not reintroduce a camphawk.app link in SMS before that edit is approved.** The
delivery panel is the regression detector and would go red within hours.
Full text, replacement copy and the Console path stay in `docs/a2p-campaign.md`.

> **THE SAMPLES ARE GENERATED AND WAITING (2026-08-12 evening).** `docs/a2p-campaign.md` now
> carries all nine bodies from `scripts/a2p-samples.mts` — the seven we send today plus the
> two that need `camphawk.app` registered first (the RC hold-secured and hold-offered
> messages, which say *"open your email or the app"* precisely because they cannot carry a
> link). Generated from the dispatcher's own `smsBody()`, so they cannot drift the way the
> 7/7/2026 set did. `--check` exits 1 if any body exceeds one segment.
> Three caveats recorded with them, each a way this gets misquoted later:
> - **The measured shape is not the proposed shape.** The 08-12 test sent
>   `camphawk.app/manage/<8-char-token>`; the samples carry
>   `camphawk.app/claim/<uuid>?t=<token>` — longer, UUID path, query string. Both are real
>   pages rather than redirects, so both satisfy T-Mobile §4.8, but the claim shape is
>   unmeasured. **Do not cite the link test as evidence for it.**
> - **155 and 154 chars against a 160 budget**, already after `fitOneSegment` trims the name.
>   Five characters of margin, and a 2-segment alert is the shape that was being filtered.
> - Delivery has been **77 for 77 since 08-06**, and `no-receipt` is 0 — which independently
>   proves the Twilio webhook is verifying signatures, i.e. the credential trim did not break
>   the callback path.

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
  > **BOTH LEGS OF THIS HAVE NOW FAILED (2026-08-12).** The premise is false — `idx` is in
  > the profile, and has been since `keepSignedIn()` started being ticked. And the
  > corroborating evidence, `renewByReload` never producing a fresher token, was a broken
  > measurement that never cleared the storage the SDK reads. **Do not cite this paragraph
  > as settled** — see "THE RENEWAL WAS MEASURING ITSELF" above. What survives is the
  > narrower, still-true finding: the SDK's background `autoRenew` fails and deletes the
  > tokens. What is now open is whether a BOOTSTRAP with empty storage renews, which is a
  > different code path and the one observation we have says yes.
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
  **ANSWERED THE SAME NIGHT — AN OKTA SESSION IS NOT ENOUGH.** Measured across four
  20-minute passes: `exp in 60m → 40m → 20m → gone`, `renewed=no` throughout, a perfectly
  linear countdown to the token's ~60-minute life. At 05:44Z keep-warm reported, in its own
  words: **"no token at all — signed out; okta session STILL ALIVE — the silent renew is
  failing, not the login"**. That branch re-primes before judging, so it is not the
  stale-token mistake, and it asks Okta directly rather than inferring.
  **So the conclusion below STANDS, but its REASON was wrong.** It said there was nothing
  to renew against; there now demonstrably is — a live Okta session with a 12h rolling
  expiry — and RC's app still fails to exchange it for a new access token, then deletes the
  token it had. The blocker was never the missing session. That narrows the diagnosis
  rather than reopening it: `prompt=none` fails for some other reason (origin, PKCE state,
  third-party-cookie policy in an automated Chromium), and finding out is real work with no
  guarantee. **`maybeAutoLogin` remains the mechanism, not a fallback.**
  Caveat worth keeping: `oktaSessionAlive()` reads `/api/v1/sessions/me`, which itself
  refreshes Okta's idle timer — so the rolling 12h window may be us extending it, not RC.
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
- **THE HOLD RUNNER WAS REPORTING A FALSE GREEN (found 2026-08-09, fix needs `update.bat`).**
  It called `reportSession(true)` whenever `primeToken` returned *a* token — presence, not
  liveness. At 05:42:38Z the access token had expired six minutes earlier and okta-auth-js
  had not yet cleared it, so the runner announced a healthy session, **overwrote keep-warm's
  correct "dead" verdict 80 seconds before keep-warm could state it, and moved
  `session_live_since`** — corrupting the lifetime measurement migration 047 exists to take.
  A green `autocart.rc_session` over a dead session is the 2026-08-07 failure exactly, and
  the **07:30 pre-flight reads that check.** Same family as `notifications.status = 'sent'`
  meaning only "Twilio returned 2xx" and `IsSuccess: true` on a cart that held nothing.
  Fixed with a **local** `tokenSecondsLeft` decode, never a network probe: the report is
  fire-and-forget because at 08:00:00.000 nothing may go in front of the precart. An
  undecodable token now reports NOTHING rather than guessing — keep-warm asks RC properly
  every pass and is the authority on a positive verdict.
- **THE FIRST REAL 8AM HOLD WORKED, 2026-08-09: carted at 15:00:02Z, TWO SECONDS after the
  release, claimed 15:02:01, released.** Every link that had broken before held at once —
  the runner picked it up (unlike 08-07), the cart was correctly timed (unlike 08-08's 85s
  early), the session was live, and the hand-off completed for the first time.
- **AND THE MORNING'S THREE FAILURES WERE ALL MINE, from one missing check.**
  `attemptLogin` had no already-signed-in branch. `maybeAutoLogin` runs because the token it
  can SEE is gone — but loading RC's home page is itself what makes the SPA fetch one, so by
  the time it looked for a sign-in link there was a healthy session and no link to find. It
  reported "the sign-in form did not load", which drove a dead-session verdict, which fired
  two alarm calls, which sent me chasing a phantom pre-check-in modal and telling the owner
  to sign in by hand — over the session that carted the site fifteen minutes later. The
  token proved it: 45 minutes left on a 60-minute token at 15:00 puts its issue at 14:45,
  exactly when the "failed" login ran. **It now asks `isLive()` after the page load, before
  hunting for a form.** Note the banner RC showed ("You have a reservation arriving on
  today's date") is only ever rendered to a SIGNED-IN user — it was evidence of success and
  I read it as the obstacle.
- **The alarm gate was structurally guaranteed to cry wolf** (fixed same day). It fired at
  `ALARM_LEAD_MIN` (45) while the repair does not run until `RC_AUTOLOGIN_LEAD_MIN` (15) —
  so on EVERY hold, not as an edge case, the phone rang half an hour before the thing that
  fixes it. It now waits for `auto sign-in failed` in the reported detail, or for the login
  window to close (`ALARM_AFTER_MIN` = 12, just inside the lead). `worker/alarm-gate.test.mts`
  fails against the 45-minute version.
- **And its rate limit was dead code:** `MIN_GAP_MS` was 15 minutes against a keep-warm that
  reports every 20, so every report cleared the window and nothing was ever suppressed. It
  read like a safeguard in review. 30 minutes now, and the test asserts it exceeds the
  cadence rather than asserting a number.
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
> **CAPACITY IS 20, NOT 2 — every `RC_HOLD_CAPACITY` figure in the entries below is
> HISTORICAL.** `RC_MAX_CARTS` went 1 → 2 (2026-08-15, `--cart-cap`) → **10** (2026-08-17,
> `--cart-ladder`: ten distinct cart keys holding **twenty reservations at once** on one
> session and one account, every rung controlled by a third add refused in RC's own wording,
> all twenty released HTTP 200). So `RC_HOLD_CAPACITY = RC_SITES_PER_CART (2) × RC_MAX_CARTS
> (10) = 20`, and parallel carting shipped with it (`CART_CONCURRENCY = 4`).
> **`src/lib/limits.ts` is the authority; these mornings happened when the ceiling was 2.**
> Quoting "two tapped holds is exactly capacity" as current is a mistake I made on
> 2026-08-19 by reading these lines instead of the constant.
**2026-08-16 WORKED END TO END, TWICE OVER, AT FULL CAPACITY.** South Carlsbad 45722 carted
15:00:43Z and was claimed 15:02:01Z; 45723 carted 15:00:49Z and was claimed 15:03:23Z. Both
`released`. 45722 reported **`✓ Added to cart`** on iOS (and `already added` on a re-injection,
which is proof it STUCK); 45723 was claimed from a plain browser, so both client paths ran in one
morning. **Two tapped holds is exactly `RC_HOLD_CAPACITY`**, and both seats filled. (Do NOT
call this the first time the ceiling was met — the 08-14 note below claims that too, and it was
written the night BEFORE and never had its outcome recorded. This is the first one with times
against it.)
**READ THE 07:33 FALSE ALARM BEFORE TRUSTING A `dead` VERDICT NEAR A RELEASE** — see the entry
above. A live session with a short token was reported dead and the printed remedy would have
destroyed it.

**2026-08-12 WORKED END TO END.** Elk Prairie `#33`: offered 01:15Z, tapped 01:34Z,
**carted 15:00:02Z — two seconds after the release** — `claiming`, then **released
15:05:24Z**. `maybeAutoLogin` signed in unattended at ~07:29 PT with no human involved, which
is the link that broke on 08-07 and 08-08.

**TWO SYNTHETIC HOLDS PROVED THE HAND-OFF ON 2026-08-13** (12:31 and 12:47 PT, both
`✓ Added to cart`, the first confirmed on RC's own cart page). Queued with
`scripts/rc-test-hold.mts`, South Carlsbad #35 and #37, arrival 2026-12-01 — the reproduction
recipe, and the second run is what makes "`submit` mints the key, not `load`" a finding
rather than a one-off.

**2026-08-13 RESOLVED (read 12:30 PT).** All three tapped holds acted on: Elk Prairie `#60`
carted 15:00:05Z and **released** 15:07:13Z; South Carlsbad `#102` carted 15:00:01Z and
`#76` at 15:07:14Z — one second after `#60` freed a seat — and **both then leaked, sitting
`carted` with nobody coming for them until `reclaimLapsedHolds` marked them `expired`.**
That sweep is the 44ae4b7 fix working on its first morning. `#60`'s hand-off still reported
the OLD "click the cart icon" banner, which is what confirmed the 09:11 precart fix had
never run against a real hold.

**STALE — WRITTEN THE NIGHT BEFORE, OUTCOME NEVER RECORDED.** Kept because its reasoning about
the quiet window is still correct and reusable, but do not read its "first morning the ceiling is
met" as an observation: nothing here says what happened on 08-14.
**TWO holds are TAPPED for 2026-08-14 08:00 PT** — South Carlsbad `#55` and Carpinteria
`#C218`, both `requested` since 03:00Z (read 21:55 PT 08-13). `#95` is `offered` and
untapped, so it does not compete. **Two tapped is exactly `RC_HOLD_CAPACITY`**, so this is
the first morning the ceiling is met rather than exceeded.
`nextHoldRelease` counts `requested`/`carted`/`claiming` and never `offered`, so **the
02:00–05:00 quiet-window update path is SHUT tonight** — 02:00 is exactly 6h from the
release and the check is not liftable. Re-read this rather than remembering it: the
tapped/untapped distinction inverts the decision, and this entry was wrong about it for a
day once already (it said all three were untapped, hours after two had been tapped).

*(Historical: South Carlsbad `#41` 08-08; Leo Carrillo `#L108` 08-07 FAILED — see the runner
section above.)*

**THE READOUT HID A HOLD THAT WAS ABOUT TO RELEASE — FIXED 2026-08-13.**
It windowed on **`offered_at`** — "offered in the last 24h" — so a hold that is still
`requested` and minutes from its release dropped off the list if the OFFER was made more
than a day earlier. That is precisely the row the readout exists to surface. Caught on
08-13 when it showed two of three queued holds and the owner corrected it from the app's
watches screen, which had them all. It windows on **`release_at`** now, so a release in
the future is always in range and a hold can only leave the list once its moment has
passed.
- The bound is built with `to_char(… AT TIME ZONE 'America/Los_Angeles')` like every other
  `release_at` call site — it is zone-less Pacific TEXT, and a bare `NOW()` is seven hours
  adrift, which silently amputates the oldest seven hours of the window.
- `worker/rc-holds-readout.test.mts` runs the **real script** against three fixtures and
  reads its stdout, because the defect was one column name in one WHERE clause and a test
  asserting against a copy of that clause would assert the copy. Verified failing against
  all three regressions: the restored `offered_at`, the dropped time zone (the −20h fixture
  is the only one that catches it — the ±3-day fixtures cannot), and no window at all.
- The fixtures are `offered` with a non-numeric sentinel unit id, two independent reasons
  the production runner cannot cart one: **`dueHolds` does not care whether the watch is
  active**, so a careless `requested` fixture minutes from release would cart a real site.

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
**Docs current to 2026-08-18 (seventh pass).** **THE ORPHAN SWEEP IS BUILT** — the keep-warm
now kills any Chromium on `.rc-bot-profile` the moment it takes the lock, which is the one
placement that is safe (the hold runner drives the same directory, so a sweep at plain startup
could land at 08:00:00 on the browser that is carting). That closes the 25 GB runaway which
took the box to **94% COMMIT** while the size guard fired five times and freed nothing —
`max_pid` was 13004 across every recycle, so `ctx.close()` was closing a healthy browser while
the measurement counted an orphan. **Bot-side: it needs a box update.** The login that orphaned
it was fired by **`npm test` in CI** (fixed server-side in #125). And the guard meant to cover
the new kill pattern **passed vacuously at first** — fourteenth time a guard here has anchored
on the wrong thing.

*(Fifth pass.)* **THE LEAK'S TRIGGER IS NAMED, BY A CONTROLLED
COMPARISON RATHER THAN A CORRELATION: it is the OKTA NAVIGATION.** Three token-less renewals ten
minutes apart, same code and profile, split cleanly on whether RC's sign-in control was clicked
— the one that navigated cost **2,331 MB**, the two that reached `no-signin-control` cost
**nothing**, having run the identical clear, reload and prime. That retires "the onset is the
reload after `dropStoredToken`", and it **falsifies half of the entry shipped the same morning**:
the token-less cell does ramp, so the near-expiry stand-down halves the leak (two Okta trips per
near-expiry renewal against one) and cannot cure it. **`attemptLogin` navigates too and is
release-critical, so no schedule can fix this** — the browser is now RECYCLED after any Okta
round trip, keyed on the click (`visitedOkta`), which is safe for the same reason the age recycle
was useless: `localStorage` survives a restart, so the minted token does too. Containment is
otherwise unchanged: the RAM guard has fired four times and the box has not been past 71% COMMIT.
**THE OPEN RISK IS STILL THE LOGIN.** The owner's sign-in hung at the password and a later one
sat on *"We are processing your request…"*. A CAPTCHA and memory pressure are now **both** live
candidates — Okta's form is rendered by the very navigation that allocates the gigabytes — and
neither is established. **START AT `docs/NEXT-SESSION.md`.**

*(Previous pass.)* **THE CHROMIUM LEAK IS ATTRIBUTED AT LAST — 20
ramps in 5 days, every ~70 minutes, every one the keep-warm's own resident RC browser, one
process, ~2,400 MB/min of REAL memory (free RAM 13.1 GB → 0.9 GB).** It is not an occasional
event and never was. **The recycle shipped that morning was inert by construction** — checked in
the resident loop's body, while the leak happens during a wedge, which is that loop not
advancing. The guard now lives in the watchdog timer and trips on `os.freemem()`.

*(Previous pass.)* **THE HOLD RUNNER WAS DOWN FOR 2.5 HOURS AND THE
WATCHDOG NEVER SPOKE** — an 08:00 test hold was never carted, `last_attempt_note` stayed NULL,
and `rc-login.bat` restored the SESSION while the runner stayed dead. **This is process
supervision on the mini-PC, not anti-bot** — the rehearsal passed on 08-16 and the renewal
re-mints unattended, so do NOT go looking for a CAPTCHA solver. `bot.mjs` was beating
throughout, so the control channel is live and the box is diagnosable. **START AT
`docs/NEXT-SESSION.md`.**

*(Previous pass.)* **CONCURRENT CART MINTING IS MEASURED SAFE** — six simultaneous
`NO_CART` precarts, six DISTINCT carts, one reservation each, all released, 1.4s — so a release
group now carts **four at a time** instead of serially, and the last of twenty holds lands nearer
T+6s than T+20s. Getting there cost two probe runs that each locked six real campsites and
answered nothing: one matched cart entries on a unit id RC's entries do not carry (third time,
and it released nothing), the other called a **connectivity failure a race** because six reads of
one `localStorage` pointer counted as one distinct cart. Both instruments now refuse a verdict
they have not earned. Also: **RC auto-hold is labelled BETA** — the entitlement was never the
gate (`is_beta` has entitled it since migration 032), what was missing was that nothing SAID so
and nothing on `/new` revealed the feature existed; and `supportsRcHold` now stops the poller
offering a hold on the nine UseDirect portals the bot has **no account for**. **Open: fold PR #78
back in after re-landing the in-app sign-in; the box needs an update for the parallel carting and
the 07:33 alarm fix.**

*(Previous pass.)* **Docs current to 2026-08-16 (second pass).** **THE 08:00 HAND-OFF WORKED END TO END** — both
holds carted at T+43s and T+49s, both claimed, `✓ Added to cart` reported on iOS, and
`RC_HOLD_CAPACITY = 2` met at its exact boundary with both seats filled. **The alarm that fired
at 07:33 was ours**: a LIVE session with a 40m token against a 46m requirement was reported
`dead`, and the remedy it printed (`rc-login.bat`) would have killed the very session it was
complaining about. Fixed in PR #80 — **bot-side, so it needs `update.bat`, "Update now", or a
quiet window before it means anything.** Also this pass: **a TypeError published a user's
ReserveCalifornia password** (WebKit quotes the failing source expression; `scrub()` sailed past
it exactly as it sailed past an OAuth code on 08-09), and the in-app sign-in that produced it is
**REVERTED** — its two real fixes sit unmerged on `claude/rc-login-fix` (PR #78) and must NOT be
merged onto the reverted claim screen. **Open: fold PR #78 back in after re-landing the feature;
`autocart.bot_version` should be checked before trusting the 07:33 fix is live.**

*(Previous pass.)* **Docs current to 2026-08-16.** **THE RENEWAL RUNS ON THE BOX** — `✓ renewed by authorize:
none → 3580s` at 01:53:05 UTC, from a genuinely token-less profile, no credential typed. The
reliable cell of the 2x2 is proven in production, and the `⚠ RC SESSION IS DEAD … okta=ALIVE`
runs it was built to end are gone. **The near-expiry cell still fails** (twice, `554s → none`
and `-115s → none`) — and the previously documented reading of that failure is FALSIFIED:
`got as far as: none` was printed with `okta=ALIVE` on the adjacent line both times, so it does
NOT mean a dead Okta session. **And the login rehearsal PASSED for the first time in its life**
at 20:00 PT, which is what restored the session that night — not the renewal. Two repairs ran
twenty minutes apart and only one worked; the entries above say which.
~~**Two test holds are queued for 2026-08-16 08:00 PT**~~ — **THEY RAN, AND BOTH CARTED.** See
"THE 08:00 HAND-OFF WORKED END TO END" above for the times and what the morning proved.

*(Previous pass.)* **Docs current to 2026-08-15 (third pass).** The renewal question is now answered TWICE OVER,
and the second answer corrects the first: `renewByReload` fails **because a plain page load is
not the bootstrap** — RC's SPA, holding no token, issues no `/authorize` of its own, and the
CLICK on its sign-in control is what starts the flow Okta answers from the `idx` cookie. The
2x2 is complete (plain load: nothing, 6 times; click: a 59-minute token, twice). Shipped:
`renewSession` (two stages, reporting which minted the token), `renewal-schedule.mjs` (which
also acts on an ALREADY-DEAD token — the refusal that cost ninety dead minutes in one evening),
and 27 mutation-verified guards. `maybeAutoLogin` is deliberately untouched.
~~**IT HAS NEVER RUN ON THE MINI-PC**~~ — **IT HAS, and it worked: `✓ renewed by authorize:
none → 3580s` at 2026-08-16 01:53:05 UTC.** See "THE RENEWAL RUNS ON THE BOX" above for the
reading and for the near-expiry cell that still fails.

*(Previous pass.)* The earlier session resolved the renewal question at
the code level — **`renewByReload` was clearing RC's OWN two token keys and not okta-auth-js's
`okta-` store**, so the SDK handed the same token back and nothing was ever asked of RC. That
also **CONFOUNDS the 08-11 "RC re-minted with no credential typed" evidence**, since the
rehearsal's clear was a third copy of the same two keys — so "RC will renew" and "RC will not
renew" are BOTH unsupported, and the next run on the box is the first real reading. Also added:
**"What counts as a match" DID NOT COUNT FOR ANYTHING** (site_type removed from New watch; the
panel stays on Explore where it works) and **jsx-spacing as a verify gate**.
`docs/NEXT-SESSION.md` is retargeted again — its subject is now **site muting on the New watch
screen**, the owner's one outstanding feature ask.
**Everything bot-side from 08-15 is merged and STILL NOT ON THE MINI-PC.**

**Docs current to 2026-08-15.** That session added, in CLAUDE.md: **"ALREADY SIGNED IN" IS NOT
"COVERED"** (the 08:00 cart lost to a one-line short-circuit, the profile-contention death
spiral, and the five fixes for both), **`npm test` TOLD THE PRODUCTION BOT TO CART A REAL
CAMPSITE**, the **08-15 answer folded into "THE RENEWAL WAS MEASURING ITSELF"** (our renewal
path does not re-mint; the rehearsal's does — that contradiction is the open question), and the
**first-ever rec.gov memory baseline** (134-145 MB, flat). `docs/NEXT-SESSION.md` is retargeted:
its subject is now **making the RC session renew itself**, both STOP sections are CLEARED, and
the Chromium leak is downgraded rather than closed.
**The 08-15 bot-side fixes are merged and NOT yet on the mini-PC** — they need an `update.bat`,
"Update now", or a quiet window before the next release depends on them.

**Docs current to 2026-08-14.** That session added the **`\"` cmd-escape bug** that meant
`rc-login.bat`'s kill had never run, **`mini-pc\stop-rc.ps1`** as the one way to free the RC
profile, and the **watchdog** — including the fact that it restarts PROCESSES and never
reboots Windows, and that it shipped asking "is anything running?" and had to be fixed to
check each payload by name. All three are in `docs/CONTEXT.md` under the mini-PC section.
**THE BOTS DO START AT WINDOWS LOGIN — owner-confirmed 2026-08-14.** That is what a
last-resort reboot tier was waiting on, and `watchdog.ps1`'s header said the opposite. **It is
still not verified from the repo**, and the ROUTE is unknown — `shell:startup`, a Run key or a
logon-triggered task — which matters, because it is machine-local config nothing here creates,
so it can vanish without a commit and without a symptom until the one night it is needed. Worth
five commands (in `docs/NEXT-SESSION.md`) to record which one it is.
**A reboot tier is now defensible; it is still NOT the 08-12 fix.** That box was wedged badly
enough that RustDesk could not connect, and **a Scheduled Task cannot fire on a Windows that is
not scheduling** — the tier would never have run. That case is the Chromium leak. Any tier
belongs behind repeated `start-all` failures, must carry the updater's release check (a reboot
ends the RC session however it is triggered), and the assertion in `update-guard.test.mts`
banning `Restart-Computer` must be NARROWED to that branch, never deleted.

**Docs current to 2026-08-13.** The later session added, in CLAUDE.md: the
**update-guard deadlock** (and its two escape hatches), the **41 GB Chromium** +
`kill-chrome`, the **three diagnostics that lied while the heartbeat was right**, the
**claim-flow sign-in step**, and the **repair-spent threshold**. `docs/a2p-campaign.md`
carries the **generated replacement samples** and the three caveats on them.

**Both docs are current to 2026-08-13**, including the **app RC session probe**
(migration 058) — the marker, why the previous open's token is the evidence, why a purge can
only be told from a first run by the server, `scripts/rc-app-session-readout.mts` and the
rule that **nobody can run the probe remotely**. Also corrected here: the 08-13 hold count
(THREE, all tapped, so the quiet-window update path is shut) and the fact that the **login
rehearsal has never passed and did not fire on 08-12**. `docs/CONTEXT.md` carries the hold flow, the
reCAPTCHA/keep-warm design, the mini-PC's five processes, migrations
039/040/043/044/046/**053/054/055/056**, the `rc-login.bat` window-title bug, the corrected
A2P facts, and this session's control channel, login rehearsal, `query()` routing class,
alert payload omission, health-severity split, DB retry, renewal-measuring-itself,
COMMIT exhaustion + `fix-pagefile`, the `memory`/`restart-rc` commands, the `--once` smoke
test, `autocart.bot_version` (incl. the shallow-clone trap) and the lazy Stripe client.
`docs/SETUP.md` carries the same, plus the `verify` recipe, the lint triage and the four
repo-tooling additions (Stop hook, `deploy-scope.mts`, `/rc-status`, `.mcp.json`).
**`CH_DEPLOY_SHA` / `CH_DEPLOY_AT` / `CH_BOT_CODE_AT` are DERIVED at build time — never set
them by hand;** see the env-var section in CONTEXT.

### iOS 1.0 WAS REJECTED 2026-08-14 — GUIDELINE 2.1, AND THE REVIEWER NEVER GOT IN
Reviewed 2026-08-13 on an iPhone 17 Pro Max, rejected the next morning. **One item, and
it is not 3.1.3(b):** *"We were unable to sign in with the following demo account
credentials … Unable to sign in (and Yahoo Mail)."* ASC files it as *2.1.0 Performance:
App Completeness*.
- **The business-model defence was never reached, let alone tested.** Nobody disputed the
  notes, the price-free rendering or the absence of a purchase mechanism — the reviewer
  could not open the app, so §2's 1,992 characters went unread. Do NOT record this as
  "3.1.3(b) survived review"; it was not adjudicated.
- **TWO independent causes, and fixing either one alone leaves the app rejected.**
  1. **The password in the Sign-In Information field is WRONG.** Apple quoted
     `TFlof12345!`; Clerk's `POST /v1/users/<id>/verify_password` answers **422
     `incorrect_password`** for that string. So "unable to sign in" is literally true at
     the password step, and this was checkable from a web session at any point in the
     sixteen days the version sat in the queue — with the secret key we already have.
     **§5's "VERIFIED DONE 2026-08-08" checked that the field was POPULATED, never that
     its contents WORK.** Same shape as the site-mute bug (the write half verified, the
     read half never exercised) and as `status = 'sent'` meaning only "Twilio returned
     2xx": presence is not liveness, and the check that felt done was measuring the
     cheaper half.
  2. **Clerk Device Trust emails a one-time code on any password sign-in from a new
     device.** Formerly "Client Trust"; the API status is still `needs_client_trust`
     (`node_modules/@clerk/shared/dist/types/signInFuture.d.ts`). It fires when the user
     enters a valid password, has no MFA, and the device is unrecognised — **which is
     every App Review device, every time, by construction.** The code goes to the Yahoo
     inbox, and the reviewer says in as many words that they could not get into that
     either. The demo account is `password_enabled=true`, `two_factor_enabled=false`, so
     it is squarely in scope.
- **THE FIX IS CONFIGURATION, NOT CODE, AND NEEDS NO NEW BINARY.** Clerk Dashboard →
  **Protect → Rules → Device Trust → Manage → toggle off Enable → Save** (instance-wide;
  Clerk documents no per-user exemption), then reset the demo password and paste the real
  one into Sign-In Information. The version is already Rejected, so **the queue position
  is spent and resubmitting the same build costs nothing** — do not let "a rebuild loses
  our place" argue for a native change that is not needed. Nothing in `src/` changes.
- **Device Trust is instance-wide, so turning it off is a real trade** — it is what stops
  a stolen password being enough from an unknown device, for all 8 accounts. Accepted here
  because no card data is reachable in-app (Stripe holds it) and a second rejection is the
  larger cost. The keep-it-on alternative is to enable TOTP on the demo account and hand
  Apple backup codes; rejected as more moving parts in front of a reviewer who has already
  failed to sign in once. **If it is ever switched back on, the NEXT review hits this
  again** — it is a permanent property of reviewing a password-only app, not a one-off.
- Reply text and the resubmit sequence are in `docs/APP-STORE.md` §2a.

### iOS 1.0 was SUBMITTED — the queue, for the record (2026-08-08)
Confirmed from App Store Connect: the version read **Waiting for Review**, so it was
submitted and was genuinely queued. (This heading briefly said the opposite — I inferred
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
reply. ~~The rejection to argue rather than code around is **3.1.3(b)** — the app has no
purchase mechanism at all, which is the whole defence.~~ **WRONG, AND IT ARRIVED
2026-08-19 — see below.**

### iOS 1.0 (5) REJECTED 2026-08-19 — GUIDELINE 3.1.1, and 3.1.3(b) WAS NEVER THE DEFENCE
The reviewer got into the app this time (iPad Air 11-inch M3) and found what the plan
always expected: *"the app accesses digital content purchased outside the app, such as
subscriptions, but that content isn't available to purchase using In-App Purchase."*
**Factually right, nothing to dispute** — the demo account is a paying subscriber, and a
non-subscriber reads *"Subscriptions are managed at camphawk.app"* with no link, no price
and no way to act.
- **THE SENTENCE STRUCK OUT ABOVE HAD THE GUIDELINE BACKWARDS.** 3.1.3(b) Multiplatform
  permits access to content bought elsewhere **"provided those items are also available as
  in-app purchases within the app"** — it *restates* the demand rather than excusing it, and
  Apple's letter cites it against us for exactly that reason. The no-IAP carve-out is
  3.1.3(a) **Reader** apps, whose enumerated list (magazines, books, audio, video, cloud
  storage, professional databases) does not cover a campsite alerting service. **"The app
  has no purchase mechanism at all" was never a defence; it was the FINDING.**
- **THE REAL ALLOWANCE IS IN APPLE'S OWN LETTER**, two paragraphs above its boilerplate
  "Next Steps": *"Apps on the United States storefront may link out to the default browser,
  using buttons, external links, or other calls to action, for payment mechanisms other than
  in-app purchase."* That is `NATIVE_LINKOUT`, dark since 2026-07-27 for precisely this, and
  it is **web-side — so it reaches the build already under review with no rebuild.**
- **THE ONE-LINE FIX WAS A TRAP AND IT IS TWO FLAGS NOW.** The flag is shared by both native
  apps and their availability differs: iOS is US-only, the Android closed test is
  **worldwide** because the paid tester service requires it. Both carve-outs are
  US-storefront only, so flipping one boolean fixes Apple **by showing steering UI to non-US
  Play testers** — the failure the module's own header warns about, introduced BY the fix for
  the other store. `LINKOUT_BY_STORE` is `{ios: true, android: false}`; **android stays false
  until Play PRODUCTION is live and US-only.** A **STORE** check (device OS names the store
  exactly), never a country check — country is ASC availability, and device locale would not
  do that job.
- **WHAT IS NOT ESTABLISHED:** whether a link-out ALONE clears 3.1.1 with no IAP at all.
  Apple's "Next Steps" still demands IAP and sits directly above their own link-out
  allowance; the two do not agree. A number of US subscription apps operate this way
  post-injunction — a pattern, not a guarantee. The fallback is StoreKit: weeks of native
  work, a new build, and 15-30% commission, which is why the free option goes first.
- `worker/store-linkout.test.mts`, seven mutations each verified applied — including **iOS
  matched before Android in the UA sniff**, which would enable Android steering through the
  back door and defeat the flag entirely.
- Reply text, the storefront precondition and the full reasoning: `docs/APP-STORE.md` §2c.

### THE 3.1.1 FIX WAS LIVE AND THE REVIEWER COULD NOT SEE IT (2026-08-22)
Rejected again on the same guideline, same build. **The change was never adjudicated**, and both
reasons are ours.
- **EVERY LINK-OUT SURFACE IS GATED ON `!subscribed`, AND THE DEMO ACCOUNT IS A SUBSCRIBER**
  (`status: active, grandfathered: true`, checked in the DB). All five — Settings,
  PricingSection, Explore, WatchCta, and NewWatch (behind `needsSubscription`, the SERVER's
  answer to a submit). That is **"a subscriber is never sold to" working exactly as designed**,
  and the consequence nobody had drawn is that with the credentials we handed Apple, the
  reviewer could not see the fix ANYWHERE. From their seat the app is precisely what they
  described. The link-out is live in production; it is invisible to that account.
- **THIS IS THE 2026-08-14 SHAPE AGAIN.** That rejection came from a demo password nobody had
  tried; this one from a demo ACCOUNT nobody had viewed the fix through. Both times the artefact
  was correct and the thing handed to the reviewer was not. **Check what the reviewer will
  actually SEE, with the credentials they will actually use** — "the fix is in the bundle" is a
  different claim, and §2c verified only that one.
- **THE APP REVIEW NOTES ARGUE THE OPPOSITE CASE, IN WRITING.** They say the app *"does not link
  out to any purchase flow"* under a **3.1.3(b)** heading — the guideline §2c established is a
  restatement of the demand, not a defence. §2c records sending the reply and verifying the
  bundle and says nothing about the notes. **Confirm in the console before acting; nobody here
  can read ASC**, and the block in `docs/APP-STORE.md` §2 is a COPY.
- **CONFIRMED 2026-08-22: the console notes ARE stale** — the owner read the live field back and
  it carries the 3.1.3(b) heading and *"does not link out to any purchase flow"* verbatim. **And
  the console holds FIVE SECTIONS `docs/APP-STORE.md` §2 does not** (devices tested, main
  features, external services, regional differences, regulated industry — §2b's six written
  answers). §2 is a COPY and it is NOT current; rewriting the notes from it deletes Apple's own
  answers and invites a second 2.1.
- **NO SECOND DEMO ACCOUNT — SIGNING OUT REVEALS THE LINK-OUT**, verified in source.
  `WatchCta`'s `isNative` branch sits ABOVE its `!signedIn` branch, and `useSubscription` gives a
  signed-out user `loaded: true, subscribed: false, unknown: false` — so the app renders the
  external link, not a sign-up route. `Explore` renders it too. A second account needs a mailbox
  that does not exist AND re-introduces the Clerk Device Trust email-code trap that caused the
  08-14 rejection. **"Do not rely on signing out" still holds for UNPROMPTED sign-out**; what
  makes it safe is numbered steps in the notes.
- **The fix is console-side: rewrite the notes (preserving §2b's answers), give sign-out steps,
  reply and resubmit the same binary.**
- **A manage-billing link in Settings is worth adding and is SEPARATE.** 3.1.1 is about
  *purchasing*, so a management link answers no part of the citation on its own — it complements
  the notes fix rather than replacing it, and it is code rather than console.
- **RESUBMITTED 2026-08-22** (owner-reported): notes replaced, **same binary**, `1.0 (5)`.
  Verified here before it went: the link-out is live in the deployed bundle, all five surfaces
  gate on `!subscribed`, the demo account is active, and a signed-out user reaches the link.
  **NOT verifiable from here:** that the notes saved, and that the sign-out steps behave as
  written on the device — nobody here can read ASC, and the on-device check is exactly what §2a
  and §2d were both caused by skipping.
- **THIS ROUND FINALLY TESTS WHETHER LINK-OUT ALONE CLEARS 3.1.1 WITH NO IAP.** §2c recorded
  that as unestablished and it stayed that way, because the reviewer never saw a link-out. This
  is the first submission where they can. **A rejection now is the real answer** and moves the
  decision to StoreKit — weeks of native work, a new build, and 15-30% — rather than another
  notes round. Both text blocks and the full reasoning are in `docs/APP-STORE.md` §2d.
- **THE NOTES FIELD CAP IS 3,999, VERIFIED** — App Store Connect says *"Must be less than 4000
  characters"* and its counter read `-18` against a 4,018-character draft, i.e. it counts
  newlines exactly as `wc -c` does. A local count is therefore trustworthy; no need to
  paste-and-see.

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

**Verified 2026-08-09 — three of the four are now closed:**
- **The campsite mute list on `/manage/<token>` WORKS END TO END**, driven against
  production. `/manage/<token>` is TOKEN-authed, not Clerk, so it is the one signed-in
  surface an agent can actually exercise — remember that next time something here is
  "unverifiable". Confirmed: the token resolves; `mute` persists (checked in the DB, not
  just the response echo); a muted id **not** in the alert history is still listed, with
  `name: null`, which is the documented behaviour and the part most likely to have rotted;
  re-muting the same id does not duplicate (the `NOT ($2 = ANY(...))` guard holds); missing
  `siteId` and an unknown `op` both 400; a bad token 404s. `stop`/`resume` verified on the
  same trip. Tested with the sentinel id `__camphawk-verify-DO-NOT-USE__` on a watch with
  no live RC hold, so no real alert could be suppressed, and the watch was restored to
  `muted_site_ids = []`, `active = true`.
- **Phone save and the auto-cart toggle are proven BY THE DATA, and the argument is the
  single writer.** `users.phone` is written by exactly one route (`/api/user/phone`) and 8
  accounts have one; `users.autocart_enabled` defaults to `false` (migration 010) and is
  written by exactly one route (`/api/user/autocart`), and 4 accounts have it `true`. Those
  values cannot exist unless both writes work. **Do NOT use `users.updated_at` as evidence
  here** — `syncUser` bumps it on every authenticated page load, so a fresh timestamp means
  somebody opened a page, not that they saved a setting.
- **The admin menu item is confirmed by the owner** (2026-08-09): it draws in the account
  menu and opens `/admin`. That closes the last of the four. It needed a human because it
  is a `<UserButton.Action>` inside Clerk's `<UserButton.MenuItems>` — `ClerkProvider`, a
  real session, and a click to open the menu. **The `ch-nav-admin` screenshot preset does
  NOT verify this**: with no provider, Clerk's `UserButton` renders nothing, so the preset
  returns a header with no avatar at all and its label ("admin now lives in the account
  menu") is showing something it cannot show. Don't read a green run of it as evidence.

**So the whole front-end swap is now verified.** Revert is still `git revert a029c27` if
something is badly wrong.

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
