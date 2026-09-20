# CLAUDE.md — a classification, not a move

*Written 2026-09-20 against `db08b9b`. It moves nothing.*

`CLAUDE.md` is auto-loaded into every session in this repo, so every session pays for all of
it before it reads a single line of code. This file classifies every entry so a wrong call is
visible here, in a table, rather than after twelve thousand lines have moved.

**Nothing here is a recommendation to delete anything.** Every verdict is a destination.

## EVERY LINE RANGE BELOW IS AGAINST `db08b9b`, WHERE THE FILE IS 19,812 LINES

**Not against master.** `CLAUDE.md` gains lines on most days, and an insertion anywhere
shifts every range below it — so a range checked against a later master is wrong by however
many lines landed above it, and the entries added since are not classified at all.

It was stale before the day was out. Four commits later master read **20,166 lines**, and the
first insertion landed at **line 2151**, so all but the opening ~2,100 lines of the table had
moved. That is not a defect in the classification; it is what a line number is.

Re-derive rather than trusting a range:

    git show db08b9b:CLAUDE.md                                        # the file as classified
    git diff --unified=0 db08b9b origin/master -- CLAUDE.md | grep '^@@'   # where it shifted

**The classification does not go stale — only the coordinates do.** The verdicts, the reasons
and the arithmetic hold whatever line an entry starts on: the leak is 38.5% of the file today
and will be 38.5% of it next week.

**The partition was checked, not asserted.** 274 rows, every row's stated line count equal to
its span, covering 14–19812 with zero overlaps and a single 2-line gap at 12993–12994 (the
Open block's own heading). Verified independently on 2026-09-20 before this merged.

## How to read a verdict

| verdict | means |
| --- | --- |
| **STAY** | A rule that applies whatever you are working on. It has to be in context before you know what you are doing, so it cannot live behind a trigger. |
| **skill:`<name>`** | A finding you need only when you are in that subsystem. Goes to `.claude/skills/<name>/SKILL.md`, whose *description* is written as a trigger. |
| **HISTORY** | Superseded narrative — the reasoning that produced a rule, where the rule itself is recorded elsewhere. Goes to `docs/HISTORY.md`, read by nothing automatically. |
| **OPEN** | Live, unfinished work. Stays in the Open block. |

## The arithmetic

| verdict | lines | share |
| --- | ---: | ---: |
| skill:chromium-leak | 7,618 | 38.5% |
| skill:rc-autocart | 2,695 | 13.6% |
| HISTORY | 1,949 | 9.8% |
| skill:rc-session | 1,582 | 8.0% |
| skill:app-store | 1,091 | 5.5% |
| skill:mini-pc | 992 | 5.0% |
| STAY | 918 | 4.6% |
| skill:billing | 540 | 2.7% |
| skill:alerting | 522 | 2.6% |
| skill:test-hygiene | 476 | 2.4% |
| skill:frontend | 324 | 1.6% |
| skill:catalog-poller | 297 | 1.5% |
| skill:rc-status | 286 | 1.4% |
| skill:seo | 121 | 0.6% |
| OPEN | 89 | 0.4% |
| skill:orchestrate | 68 | 0.3% |
| skill:health | 61 | 0.3% |
| skill:providers | 55 | 0.3% |
| skill:likelihood | 51 | 0.3% |
| skill:browser-qa | 33 | 0.2% |
| skill:costs | 30 | 0.2% |
| **total classified** | **19,798** | |

**1,007 lines stay** (5.1%). The file goes from 19,812 lines to roughly 1,007.

## What the numbers say

**One investigation is 38.5% of the file.** The Chromium memory leak — every ramp, every
instrument, the cure and its three firings — is **7,618 lines**. It is a real and well-run
investigation and almost none of it is needed to fix an alerting bug, change a price, or
answer a question about a hold.

**And it never landed in a section of its own.** It is spread through
`## Web-session gotchas (this environment)`, whose heading promises something else entirely.
That section began as four environment notes — `NODE_USE_ENV_PROXY`, the placeholder
`GITHUB_TOKEN`, no `.env` file, headless Chromium cannot reach Mapbox — and those four are
still there, at lines 892–1132. **241 lines of the section match its title; the other 11,860
do not.** Nothing stopped anything landing there, because a heading that stopped describing
its contents also stopped being a boundary.

The Open block is the same failure with a clock on it: **1,650 of its 6,819 lines are a
blockquoted stack of twenty-odd dated handovers**, each superseded by the one above it.

## The skills, and their descriptions are the load-bearing part

A skill is read only when its description matches what you are doing, so **the description is
the trigger and is the whole risk**. Written badly, a finding in a skill reads exactly like a
finding nobody ever wrote — which is the failure `docs/LANES.md` records about the one-writer
rule, arriving from the other side.

| skill | lines | fires when you are... |
| --- | ---: | --- |
| `chromium-leak` | 7,618 | touching the keep-warm browser, reading `chromium_memory_samples` or `bot_events`, or asked why the box uses so much memory |
| `rc-autocart` | 2,695 | touching holds, the cart, the burst, the claim screen or the hand-off |
| `rc-session` | 1,582 | touching the RC token, Okta, `planRenewal`, `attemptLogin` or the login rehearsal |
| `app-store` | 1,091 | touching an App Store or Play submission, IAP, RevenueCat or a store listing |
| `mini-pc` | 992 | touching the box: supervisors, the update path, the watchdog, PowerShell or a `.bat` |
| `billing` | 540 | touching Stripe, `subscriptions`, entitlement or the RevenueCat webhook |
| `alerting` | 522 | touching notifications, SMS, A2P, alert copy or batching |
| `test-hygiene` | 476 | writing a real-DB test, chasing a CI red, or mutation-testing a guard |
| `frontend` | 324 | touching `src/components/v2/` or a screen |
| `catalog-poller` | 297 | touching the catalog sync, sharding, the rec.gov scheduler or a breaker |
| `rc-status` | 286 | asking whether the 08:00 cart fired — **merge into the existing `/rc-status` skill, do not create a second one** |
| `seo` | 121 | touching landing pages, metadata or the sitemap |
| `orchestrate` | 68 | dispatching a child — **merge into the existing skill** |
| `health` | 61 | touching `/api/health/status` or a check severity |
| `providers` | 55 | touching `/api/rc-proxy` or a UseDirect breaker |
| `likelihood` | 51 | proposing to restart Feature E accrual |
| `browser-qa` | 33 | driving the site from the home server — **merge into the existing skill** |
| `costs` | 30 | asked what the infrastructure costs |

**Three of these already exist** (`rc-status`, `orchestrate`, `browser-qa`) and take content
rather than being created. **Four are small enough to be suspicious** — `health`, `providers`,
`likelihood`, `costs` total 197 lines between them, and a skill that small may be better as a
paragraph under STAY than as a file nobody triggers. That is a judgement to take deliberately,
not a rounding error.

## Four rules, without which this makes the file worse

1. **A NEVER rule stays, whatever its topic.** "Never let a child choose a migration number"
   is about migrations and you need it before you know you are near one. Topic does not
   decide STAY; *when you need to already know it* does.
2. **`CLAUDE.md` keeps an index of every skill and what triggers it.** Without one, the only
   way to discover a finding is to already suspect it exists.
3. **A test asserts every indexed skill exists.** A skill renamed or deleted must fail the
   build, or the index rots into a list of destinations that are not there — the
   `hold-fixture-safety` shape, where a guard that inspects nothing reads as one that approves.
4. **`docs/HISTORY.md` is never auto-loaded and is never deleted.** The reasoning that
   produced a rule is what stops the rule being re-litigated; it just does not need to be in
   context to write code.

## What this does not decide

- **Whether to do it at all.** 19,812 lines to ~1,007 is the prize; the risk is a finding that
  stops being found. Both are real.
- **Who writes it.** `docs/LANES.md` makes `CLAUDE.md` a single writer's file, and this is the
  largest edit it has ever had.
- **The order.** The leak skill alone is 38.5% and is self-contained, so it is the cheapest
  first move and the one whose result is measurable in a session's opening context.
- **Anything about correctness.** Every verdict here is about *where a finding lives*. Not one
  line of it is a claim that a finding is wrong.

## The entries

| lines | n | verdict | entry | why |
| --- | ---: | --- | --- | --- |
| 14–48 | 35 | `skill:frontend` | Front-end rewrite — SHIPPED + SWAPPED LIVE (2026-07-27) | The v2 swap is finished and shipped; the live rules (one gating component, robots-per-page, ch-* tokens only) belong with the components. |
| 49–73 | 25 | `skill:seo` | SEO (added 2026-07-27, live since the swap lifted the layout `noindex`) | SEO architecture plus the falsified cancellation retarget. Nothing here is needed to fix a poller bug. |
| 74–77 | 4 | `HISTORY` | Roadmap A–E — ALL SHIPPED (2026-07-22) | Four lines saying five roadmap items shipped two months ago. Nothing actionable. |
| 78–128 | 51 | `skill:likelihood` | Feature E — FULLY STOPPED 2026-07-30 (display *and* collection) | Feature E is stopped behind three switches. Load it only when somebody proposes restarting accrual. |
| 129–170 | 42 | `skill:providers` | `/api/rc-proxy` takes a BATCH (2026-07-30) | The rc-proxy batch contract, FANOUT, the 12s upstream timeout. Needed when touching UseDirect egress, never otherwise. |
| 171–227 | 57 | `skill:rc-autocart` | Auto-Cart tier + lead-time tiering (2026-08-01) | Auto-Cart tier, entitlement, six enforcers, lead-time tiering. Billing+entitlement surface. |
| 228–245 | 18 | `skill:rc-session` | RC login now hits a reCAPTCHA (2026-08-07) — the binding constraint | The reCAPTCHA finding is the premise of the whole keep-warm design. |
| 246–414 | 169 | `skill:rc-autocart` | ReserveCalifornia auto-cart — SETTLED 2026-08-06, and still OFF | Path B, the cart hand-off, mobile recapture. The largest single auto-cart entry. |
| 415–436 | 22 | `skill:alerting` | Alert copy — three bugs from one real text (2026-08-06) | Alert copy: rcSiteLabel, formatStayDates, fitOneSegment, the coming-soon lead. |
| 437–473 | 37 | `STAY` | Alerting — the claim (read this before touching the poller) | The claim is the single most consequential decision in the poller and its own heading says read this first. A cross-cutting invariant, not a topic. |
| 474–498 | 25 | `skill:alerting` | SMS delivery is MEASURED now, not assumed (2026-08-05) | Migration 038, delivery_status vs status, the Twilio signature. |
| 499–574 | 76 | `skill:alerting` | SMS: link ONLY to the provider, never to camphawk.app (2026-08-05) — SOLVED | The A2P domain finding and its correction. Load with the SMS surface. |
| 575–600 | 26 | `skill:alerting` | Alert texts must stay in ONE segment (2026-08-05) — the length theory, disproved | One-segment rule and the disproved length theory. |
| 601–608 | 8 | `skill:catalog-poller` | Expired watches close themselves (2026-08-05) | expire-watches: the predicate must never be wider than the poller filter. |
| 609–620 | 12 | `skill:frontend` | The admin dashboard never signals with colour alone (2026-08-05) | Admin never signals with colour alone. A UI rule, enforced by LEVEL_MARK. |
| 621–657 | 37 | `skill:catalog-poller` | THE EGRESS-CASCADE WATCHDOG (issue #14) — DONE SINCE JULY, UNGUARDED UNTIL 2026-08-27 | The egress-cascade watchdog and its two external signals. |
| 658–675 | 18 | `skill:catalog-poller` | rec.gov 429s — four fixes in one loop (2026-07-30) | rec.gov 429 breaker, half-open probe, pacing, UA. |
| 676–695 | 20 | `STAY` | Empty ≠ booked (2026-07-31) — and rec.gov is NOT moving to Vercel | Empty is not booked: a null-is-not-a-negative rule that has now recurred in six unrelated places. This is the file house rule with a worked example. |
| 696–703 | 8 | `STAY` | `npm run typecheck` — `tsc` alone does NOT cover the worker | npm run typecheck covers both configs. Applies to every change in the repo. |
| 704–744 | 41 | `skill:catalog-poller` | One rec.gov fetch lane — `worker/recgov-scheduler.ts` (2026-07-31) | The rec.gov scheduler, budget, single-flight, four call sites. |
| 745–772 | 28 | `skill:catalog-poller` | Catalog syncs — three fixes on 2026-08-04, one theme | Catalog sync fixes, sharding the sync, RIDB media, geocoding. |
| 773–787 | 15 | `skill:catalog-poller` | Sharding is LIVE at `SHARD_COUNT = 2` (2026-08-02) | SHARD_COUNT=2 live, clone-before-raise. |
| 788–816 | 29 | `skill:catalog-poller` | Shard scaffolding — shipped dark at `SHARD_COUNT = 1` (2026-07-31) | Shard scaffolding, lease, capacity gauge, watch cap. |
| 817–836 | 20 | `STAY` | Tests exist now — `npm test` | Tests hit the real DB on purpose, and break-it-first before trusting a guard. Governs every change. |
| 837–849 | 13 | `skill:providers` | Reservation-provider resilience (2026-07-30) | UseDirect/rec.gov breakers, RC retry, the Fly-cannot-reach-RDR reason rc-proxy exists. |
| 850–891 | 42 | `STAY` | Deploy (recap — details in SETUP.md) | Deploy: which push deploys what, and that worker/** in paths: means a test file restarts the pollers. Needed on every merge. |
| 892–1132 | 241 | `STAY` | &nbsp;&nbsp;(the section preamble) | The section as its heading promises: NODE_USE_ENV_PROXY, the placeholder GITHUB_TOKEN, no .env file, Chromium cannot reach Mapbox, the live site cannot be browsed, a new public route 404s, never call a request-time API in the root layout, and the CI-log caps. Every one applies whatever you are working on. This 241-line preamble is the only part of the 12,101-line section that its own title describes. |
| 1133–1204 | 72 | `skill:rc-autocart` | &nbsp;&nbsp;CONCURRENT CART MINTING IS SAFE, MEASURED (2026-08-17) — and carting is parallel now | Concurrent cart minting measured safe; CART_CONCURRENCY=4 and why not 20. |
| 1205–1245 | 41 | `skill:rc-autocart` | &nbsp;&nbsp;RC AUTO-HOLD IS LABELLED BETA, AND THE ENTITLEMENT WAS NEVER THE GATE (2026-08-17) | The beta label, and that the entitlement was never the gate. |
| 1246–1293 | 48 | `skill:mini-pc` | &nbsp;&nbsp;THE HOLD RUNNER WAS DOWN 2.5 HOURS AND THE WATCHDOG NEVER NOTICED (2026-08-17) | Runner down 2.5h. Windows process supervision, not RC. |
| 1294–1353 | 60 | `skill:mini-pc` | &nbsp;&nbsp;THE WATCHDOG NEVER RAN — WINDOWS STOPPED SCHEDULING (2026-08-17, second pass) | Task Scheduler stopped scheduling. The second pass on the same outage. |
| 1354–1385 | 32 | `skill:chromium-leak` | &nbsp;&nbsp;THE KEEP-WARM WEDGES ~HOURLY IN THE NEAR-EXPIRY RENEWAL (2026-08-17) — STILL OPEN | The near-expiry wedge; later entries attribute it to the browser at 25 GB. |
| 1386–1489 | 104 | `skill:chromium-leak` | &nbsp;&nbsp;THE CHROMIUM LEAK IS FULLY ATTRIBUTED (2026-08-17, third pass) — 20 RAMPS IN 5 DAYS | Twenty ramps in five days, fully attributed to the rc family. |
| 1490–1534 | 45 | `skill:chromium-leak` | &nbsp;&nbsp;THREE INSTRUMENTS FOR THE UNCURED HALF (2026-08-17, fourth pass) | Breadcrumb, heap facts over CDP, the removed age recycle. |
| 1535–1661 | 127 | `skill:chromium-leak` | &nbsp;&nbsp;THE FIRST REAL FIRING, AND WHAT IT COST (2026-08-18) | First containment firing; os.freemem calibrated. |
| 1662–1686 | 25 | `skill:chromium-leak` | &nbsp;&nbsp;FOURTH FIRING, 2026-08-18 23:12 PT — BOTH INSTRUMENTS ANSWERED | Process type plus RAM trail: renderer and browser process. |
| 1687–1727 | 41 | `skill:rc-session` | &nbsp;&nbsp;STOP RENEWING AT NEAR-EXPIRY (2026-08-18) — BUILT, awaiting a box update | planRenewal stands down while the token is alive. The renewal schedule. |
| 1728–1852 | 125 | `skill:rc-session` | &nbsp;&nbsp;A THREE-DAY-OLD TOKEN KEEPS COMING BACK (2026-08-19) — the session cannot exit the loop | The three-day-old token and the storage census. |
| 1853–1875 | 23 | `skill:test-hygiene` | &nbsp;&nbsp;`npm test` KILLED THE PRODUCTION RC SESSION (2026-08-19) — fixed in the FEED | A test run took the production RC session. Fixture visibility in the feed. |
| 1876–1890 | 15 | `skill:rc-session` | &nbsp;&nbsp;A BLANK RC APP IS NOT A FAILED LOGIN — in the release path too (2026-08-19) | provedNothing in the release path. |
| 1891–1906 | 16 | `skill:mini-pc` | &nbsp;&nbsp;"UPDATE NOW" IS FAST NOW (2026-08-19) — and the ~20-minute note below is superseded | The update claim released on a refusal. |
| 1907–1928 | 22 | `skill:mini-pc` | &nbsp;&nbsp;A REMOTE `test-login`, AND WHY NOT A SHELL (2026-08-19) | test-login as a named lever, and why not a shell. |
| 1929–1969 | 41 | `skill:chromium-leak` | &nbsp;&nbsp;THE RENEWAL RUNS IN A THROWAWAY TAB NOW (2026-08-19) — the first CURE, and what it rests on | The throwaway tab: the first cure, and what it rests on. |
| 1970–2038 | 69 | `skill:chromium-leak` | &nbsp;&nbsp;FIVE INSTRUMENTS AND NONE OF THEM STOPS IT — so COUNT THE BYTES (2026-08-19) | Five instruments and none stops it; the network trace. |
| 2039–2090 | 52 | `skill:chromium-leak` | &nbsp;&nbsp;THE RAM GUARD KILLED THE REPAIR IT WAS PROTECTING (2026-08-19) — floor 4000 → 2000 | The RAM floor 4000 to 2000 and the arithmetic behind it. |
| 2091–2150 | 60 | `skill:test-hygiene` | &nbsp;&nbsp;TWO CONCURRENT `npm test` RUNS RACE ON A GLOBAL SWEEP (2026-08-18) | Two concurrent npm test runs race on a global sweep. |
| 2151–2185 | 35 | `skill:rc-session` | &nbsp;&nbsp;THE SESSION RENEWS ITSELF ONCE WE STOP TOUCHING IT (2026-08-18, first 2.5 hours) | The SPA re-mints when we stop touching it. |
| 2186–2250 | 65 | `skill:chromium-leak` | &nbsp;&nbsp;IT IS THE OKTA NAVIGATION, AND THAT IS A CONTROLLED COMPARISON (2026-08-18, fifth pass) | The controlled comparison that named the Okta navigation as the trigger. |
| 2251–2346 | 96 | `skill:chromium-leak` | &nbsp;&nbsp;A 25 GB RUNAWAY, FIVE RECYCLES, AND THE GUARD CLOSED THE WRONG BROWSER (2026-08-18) | The 25 GB orphan and the guard that closed the wrong browser. |
| 2347–2392 | 46 | `skill:test-hygiene` | &nbsp;&nbsp;`npm test` MADE THE PRODUCTION BOT SIGN IN TO RC (2026-08-18) — CI does it on every PR | npm test made the production bot sign in to RC. |
| 2393–2484 | 92 | `skill:rc-session` | &nbsp;&nbsp;OUR OWN LIVENESS CHECK KEEPS THE OKTA SESSION ALIVE — MEASURED, 12 FOR 12 (2026-08-18) | Our own probe keeps the Okta session alive. Load-bearing by accident. |
| 2485–2541 | 57 | `skill:rc-session` | &nbsp;&nbsp;THE LOGIN IS THE OPEN RISK, NOT THE LEAK (2026-08-18) | The login as the open risk; rehearsal keeps no history. |
| 2542–2589 | 48 | `skill:mini-pc` | &nbsp;&nbsp;THE UPDATER DIED INSIDE ITS OWN `stop-all` — a JOB OBJECT, fixed and PROVEN (2026-08-20) | The updater killed inside its own stop-all. A Job Object. |
| 2590–2612 | 23 | `skill:mini-pc` | &nbsp;&nbsp;`loadEnv` RESOLVED RELATIVE TO THE CALLER, AND A 401 READ AS A BAD TOKEN (2026-08-20) | loadEnv resolved relative to the caller; a 401 read as a bad token. |
| 2613–2639 | 27 | `skill:rc-autocart` | &nbsp;&nbsp;THE IN-APP OKTA FILL: REACT'S `_valueTracker` (2026-08-20) | React _valueTracker in the in-app Okta fill. |
| 2640–2653 | 14 | `skill:rc-autocart` | &nbsp;&nbsp;"PLATFORM NOT REPORTED" WAS THE TRIM, NOT A MISSING FEATURE (migration 064, 2026-08-20) | Platform not reported was the trim (migration 064). |
| 2654–2696 | 43 | `skill:chromium-leak` | &nbsp;&nbsp;THE AUTO-LOGIN WAS THE BIGGEST OKTA TRIP NOBODY HAD MEASURED (2026-08-20) | The auto-login was the biggest Okta trip nobody had measured. |
| 2697–2713 | 17 | `STAY` | &nbsp;&nbsp;`worker-deploy.yml`'s PATH LIST HAD DRIFTED FROM WHAT THE WORKER IMPORTS (2026-08-20) | worker-deploy.yml paths drifting from what the worker imports. A deploy-scope rule that decides whether any merge restarts the pollers. |
| 2714–2756 | 43 | `skill:rc-session` | &nbsp;&nbsp;THE OKTA SESSION'S STATE IS A COLUMN NOW (migration 065, 2026-08-21) | Okta state as a column (migration 065). |
| 2757–2794 | 38 | `skill:rc-session` | &nbsp;&nbsp;THE EXPENSIVE SIGN-IN WAS PINNED TO THE RELEASE-CRITICAL WINDOW (2026-08-21) | The T-3h warm-up, and why not the night before. |
| 2795–2931 | 137 | `skill:test-hygiene` | &nbsp;&nbsp;#203 DOES NOT COVER A FIXED SENTINEL, AND I PROVED IT BY BREAKING THE RULE (2026-08-28) | Fixed sentinels are mutually destructive between two runs of one suite. |
| 2932–2978 | 47 | `skill:chromium-leak` | &nbsp;&nbsp;THE TRAIL'S SILENCE IS INSTRUMENTED, AND THE BOX HAS IT (2026-08-28) | The trail silence instrumented. |
| 2979–3085 | 107 | `skill:chromium-leak` | &nbsp;&nbsp;THE TRAIL ANSWERED, AND IT IS THE PROFILER — TRACK A CANNOT SEE THESE BYTES (2026-09-04) | Track A retired: the sampling profiler cannot see these bytes. |
| 3086–3143 | 58 | `skill:chromium-leak` | &nbsp;&nbsp;THE LEAK — WHERE IT ACTUALLY STANDS (2026-08-22) | Where the leak actually stands. The standing summary. |
| 3144–3182 | 39 | `skill:chromium-leak` | &nbsp;&nbsp;TRACK A'S FIRST READING NAMED NOTHING — IT WAS VALIDATED ON THE WRONG PLATFORM (2026-08-22) | Track A validated on the wrong platform. |
| 3183–3199 | 17 | `skill:rc-session` | &nbsp;&nbsp;THE STALE TOKEN COMES FROM THE SERVER (2026-08-22) — every local candidate is eliminated | The stale token comes from the server. |
| 3200–3211 | 12 | `skill:rc-session` | &nbsp;&nbsp;THE RENEWAL HAS FAILED 20 TIMES RUNNING AND IS IN BACKOFF (2026-08-22) | Twenty failed renewals and the backoff. |
| 3212–3223 | 12 | `skill:chromium-leak` | &nbsp;&nbsp;RAMPS ARE MUCH RARER NOW — AN OBSERVATION, NOT A CURE (2026-08-22) | Ramps rarer, an observation not a cure. |
| 3224–3239 | 16 | `skill:rc-session` | &nbsp;&nbsp;THE OKTA CAP DID NOT RESET ACROSS A PASSWORD SIGN-IN (2026-08-16, folded in 2026-08-22) | The Okta cap did not reset across a password sign-in. |
| 3240–3291 | 52 | `skill:chromium-leak` | &nbsp;&nbsp;THE RAMP IS AN ELEVEN-MINUTE CLIMB, NOT A SPIKE (2026-08-23) | The eleven-minute climb, revising the rate figure. |
| 3292–3327 | 36 | `skill:chromium-leak` | &nbsp;&nbsp;NEITHER 9 GB RAMP TRIPPED THE RAM ARM (2026-08-24, folded from side-lane §24b) | Neither 9 GB ramp tripped the RAM arm. |
| 3328–3392 | 65 | `skill:rc-autocart` | &nbsp;&nbsp;THE HAND-OFF LANDS IN THE CART NOW, AND THE SIGN-IN NEVER PRESSED ANYTHING (2026-08-23) | The hand-off lands in the cart; the sign-in never pressed anything. |
| 3393–3468 | 76 | `skill:rc-autocart` | &nbsp;&nbsp;`cart read back` NEVER PROVED THE OWNER COULD REACH THE CART (2026-08-29) | cart read back never proved the owner could reach the cart. |
| 3469–3849 | 381 | `skill:rc-session` | &nbsp;&nbsp;A CAMPSITE WAS LOST TO A TWO-SECOND MARGIN, AND THE FIXES FOR IT CAUSED TWO MORE (2026-08-30) | Four defects on the path between a queued hold and a cart. Coverage rounding, crash vs bail, token persistence. |
| 3850–3910 | 61 | `skill:rc-autocart` | &nbsp;&nbsp;THE RETEST CARTED NOTHING AND SAID IT HAD — THE MARKER COULD NOT NAME ITS SITE (2026-08-29) | The retest carted nothing and said it had. |
| 3911–3926 | 16 | `skill:rc-autocart` | &nbsp;&nbsp;A REAL CAMPSITE IS LOCKED AND WE CANNOT RELEASE IT (2026-08-29) | A real campsite locked with no key to release it. |
| 3927–3964 | 38 | `skill:test-hygiene` | &nbsp;&nbsp;THE FIXTURE COUNT IN THE HEALTH ROUTE WAS NEVER FILTERED (2026-08-23, evening) | The health route counted fixtures. |
| 3965–4005 | 41 | `skill:test-hygiene` | &nbsp;&nbsp;AND THE GUARD FOR THAT COULD NOT SEE THE FIXTURE THE FIX SHIPPED (2026-08-27) | The guard could not see the fixture the fix shipped. |
| 4006–4066 | 61 | `HISTORY` | &nbsp;&nbsp;A REAL TEST HOLD IS QUEUED FOR 2026-08-24 07:58:47 PT — to MANUFACTURE a ramp (2026-08-23) | A specific test hold queued on 2026-08-23 to manufacture a ramp. The experiment ran; the reading rules it states are restated in later leak entries. |
| 4067–4106 | 40 | `HISTORY` | &nbsp;&nbsp;THE MANUFACTURED RAMP WAS NEVER READ — EGRESS IS STILL BLOCKED (2026-08-24 08:15 PT) | That experiment was never read because egress was blocked. The durable half (readouts fail loudly, so an empty answer is a real answer) is restated under STAY. |
| 4107–4180 | 74 | `skill:chromium-leak` | &nbsp;&nbsp;BOTH FIXES ARE DEPLOYED, AND THE THIRD DOOR IS INSTRUMENTED (2026-08-24, evening) | The warm-up sampled; the general guard over every Okta path. |
| 4181–4310 | 130 | `skill:chromium-leak` | &nbsp;&nbsp;THE RAMP WAS ORDERED, IT ARRIVED ON CUE, AND TRACK A HAD NO INSTRUMENT ON IT (2026-08-24 13:00 PT) | The ordered ramp arrived and Track A had no instrument on it. |
| 4311–4407 | 97 | `skill:alerting` | &nbsp;&nbsp;26 TEXTS IN AN HOUR: A PER-CAMPGROUND KEY IN A SINGLE-VALUED COLUMN (2026-08-24) | 26 texts in an hour: a per-campground key in a single-valued column. |
| 4408–4441 | 34 | `skill:rc-autocart` | &nbsp;&nbsp;TWO PEOPLE WERE PROMISED ONE CAMPSITE, AND A LINE DECIDES IT NOW (migration 068, 2026-08-24) | The fairness line (migration 068). |
| 4442–4460 | 19 | `skill:rc-autocart` | &nbsp;&nbsp;AN OFFER CAN BE DECLINED NOW, AND IT IS NOT COSMETIC (2026-08-24) | declineHold, and why it is not cosmetic. |
| 4461–4474 | 14 | `skill:rc-autocart` | &nbsp;&nbsp;RC AUTO-HOLD SAYS WHAT IT IS NOW, IN THE WORDS THE MODULE ALREADY HAD (2026-08-24) | RC auto-hold discoverability. |
| 4475–4500 | 26 | `skill:catalog-poller` | &nbsp;&nbsp;A POLLER ROW IS A (WATCH, CAMPGROUND), AND FIVE MAPS STILL THOUGHT IT WAS A WATCH (2026-08-24) | A poller row is a (watch, campground). Five maps disagreed. |
| 4501–4526 | 26 | `skill:alerting` | &nbsp;&nbsp;THREE SITES AT ONE PARK IS ONE TEXT NOW (2026-08-24) | Three sites at one park is one text. |
| 4527–4538 | 12 | `skill:test-hygiene` | &nbsp;&nbsp;`npm test` RUNS FILES CONCURRENTLY AND FIVE SUITES SWEPT EACH OTHER'S FIXTURES (2026-08-24) | npm test runs files concurrently; five suites swept each other. |
| 4539–4624 | 86 | `skill:chromium-leak` | &nbsp;&nbsp;THE CONTENTION TEST RAN ITSELF, AND TRACK A WAS POINTED THE WRONG WAY (2026-08-25) | The contention test ran itself; Track A pointed the wrong way. |
| 4625–4774 | 150 | `skill:chromium-leak` | &nbsp;&nbsp;THE TRACK A TRAIL — BUILT 2026-08-25, and it corrected me twice on the way | The Track A trail, and two corrections on the way. |
| 4775–4802 | 28 | `skill:alerting` | &nbsp;&nbsp;"SEP 4-5" FOR A 4-6 WATCH IS CORRECT — the alert names the NIGHTS (2026-08-27) | Sep 4-5 for a 4-6 watch: the alert names the nights. |
| 4803–4860 | 58 | `STAY` | &nbsp;&nbsp;A DISPLAY CONVENTION IS NOT A TIME-ARITHMETIC CONVENTION (2026-08-26) | A display convention is not a time-arithmetic convention. Zone-less Pacific wall clock. Recurs in SQL, JS and log files; not one subsystem. |
| 4861–4885 | 25 | `HISTORY` | &nbsp;&nbsp;THE FIRST TWO-TAPPED CONTEST IS QUEUED FOR 2026-08-26 08:00 PT — outcome UNREAD | A contest queued for 2026-08-26 whose outcome the next entry records. |
| 4886–4974 | 89 | `skill:rc-autocart` | &nbsp;&nbsp;THE FAIRNESS LINE SERVED BOTH RIVALS — 14 SECONDS APART (2026-08-26) | The fairness line served both rivals 14 seconds apart. |
| 4975–5085 | 111 | `skill:rc-autocart` | &nbsp;&nbsp;A DEAD SESSION STILL STRANDS A CARTED SITE (2026-08-26) — the 08-13 leak, recurring | A dead session still strands a carted site. |
| 5086–5720 | 635 | `skill:chromium-leak` | &nbsp;&nbsp;A PASSWORD SIGN-IN CAN BE CHEAP — 32 SECONDS AND ZERO MEMORY (2026-08-26) | A cheap password sign-in, plus the forcing recipe and the stall trigger misses. |
| 5721–5925 | 205 | `skill:chromium-leak` | &nbsp;&nbsp;THE DUMP CAN NEVER ANSWER — A WEDGED RENDERER IS *PRESENT AND EMPTY* (2026-09-09) | The dump can never answer: a wedged renderer is present and empty. |
| 5926–6122 | 197 | `skill:chromium-leak` | &nbsp;&nbsp;VMTHREAD ANSWERED ON ITS FIRST RAMP: THE MAIN THREAD IS SPINNING (2026-09-09) | VMTHREAD: the main thread is spinning. |
| 6123–8505 | 2383 | `skill:chromium-leak` | &nbsp;&nbsp;THE SPINNING THREAD IS SAMPLED NOW (2026-09-09) — VMSTACK, built, awaiting a box update | VMSTACK through the cure and its three firings. The single largest block in the file at 2,383 lines. |
| 8506–8641 | 136 | `STAY` | &nbsp;&nbsp;THE METHOD WAS THE PROBLEM, NOT THE LEAK (2026-09-08) — asked "why do we keep missing things?" | The method was the problem, not the leak. Predict the reading before building the instrument. A rule about how to work here, with the leak only as its worked example. |
| 8642–8693 | 52 | `skill:rc-autocart` | &nbsp;&nbsp;`reclaimLapsedHolds` KEPT `cart_key` AND NEVER USED IT — the premise it rested on is retired (2026-08-28) | reclaimLapsedHolds kept cart_key and never used it. |
| 8694–8788 | 95 | `skill:rc-autocart` | &nbsp;&nbsp;ONE ACCOUNT ALWAYS GETS FIRST DIBS (migration 069, 2026-08-28) — a deliberate thumb on the scale | line_priority (migration 069). |
| 8789–8904 | 116 | `skill:rc-autocart` | &nbsp;&nbsp;iOS AND ANDROID DIVERGED ON ONE CAMPSITE EACH, AND THE INSTRUMENTS SAID THEY MATCHED (2026-09-01) | iOS and Android diverged on one campsite each. |
| 8905–8970 | 66 | `skill:rc-autocart` | &nbsp;&nbsp;RC'S SIGN-IN IS TWO STEPS, AND EVERY CLOSE RULE WE EVER SHIPPED RACED THE SECOND (2026-09-01, #249) | RC sign-in is two steps; every close rule raced the second. |
| 8971–9005 | 35 | `skill:rc-autocart` | &nbsp;&nbsp;THE ANDROID HAND-OFF IS FIXED, AND A HUMAN FINALLY LOOKED AT THE CART (2026-09-02) | The Android hand-off fixed and human-verified. |
| 9006–9049 | 44 | `skill:rc-autocart` | &nbsp;&nbsp;THE RUNNER HUNG IN THE PRE-RELEASE WAIT, ALIVE AND POLLING NOTHING (2026-09-02) | The runner hung in the pre-release wait. |
| 9050–9069 | 20 | `skill:rc-autocart` | &nbsp;&nbsp;A CHALLENGE BETWEEN THE EMAIL AND THE PASSWORD ABANDONED THE SIGN-IN (2026-09-02) | A challenge between the email and the password. |
| 9070–9118 | 49 | `skill:rc-autocart` | &nbsp;&nbsp;THE SIGN-IN'S "LONG PAUSE" WAS US HUNTING RC'S CONTROL ON OKTA'S PAGE (2026-09-02, #252) | The long pause was us hunting RC control on Okta page. |
| 9119–9157 | 39 | `skill:rc-autocart` | &nbsp;&nbsp;#249 WAS NECESSARY AND NOT SUFFICIENT: OUR SIGN-IN SCRIPT WAS CLICKING "LOG IN" ON THE CALLBACK PAGE (2026-09-01, #250) | The sign-in script clicking Log in on the callback page. |
| 9158–9195 | 38 | `skill:app-store` | &nbsp;&nbsp;WHERE iOS AND ANDROID ACTUALLY DIFFER — AUDITED, AND THE ANSWER REFRAMES THE QUESTION (2026-09-01) | Where iOS and Android actually differ. Platform parity. |
| 9196–9233 | 38 | `skill:billing` | &nbsp;&nbsp;`trialing` COULD NEVER APPEAR, AND IT MADE TWO CORRECT NUMBERS LOOK LIKE THEFT (2026-09-02) | trialing could never appear. |
| 9234–9385 | 152 | `skill:billing` | &nbsp;&nbsp;A CHURN WAS INVISIBLE UNTIL THE DAY IT LANDED, AND EVERY NUMBER WAS RIGHT (migration 078, 2026-09-16) | cancel_at_period_end (migration 078). |
| 9386–9429 | 44 | `skill:frontend` | &nbsp;&nbsp;DATES ARE EDITABLE ON `/manage/<token>` NOW — and the form was never the hard part (2026-09-02) | Dates editable on /manage. |
| 9430–9467 | 38 | `skill:billing` | &nbsp;&nbsp;`subscriptions` CAN BE RECONCILED AGAINST STRIPE NOW (2026-09-02) | The Stripe reconcile. |
| 9468–9515 | 48 | `skill:test-hygiene` | &nbsp;&nbsp;A HOLD-SUITE TEST ASSERTS A GLOBAL, SO A LIVE TEST HOLD FAILS IT (2026-09-02) | A hold-suite test asserts a global. |
| 9516–9552 | 37 | `skill:rc-autocart` | &nbsp;&nbsp;A HOLD OFFER WAS ONE ROW PER CAMPSITE, FOR EVER (migration 074, 2026-09-04) | One row per campsite for ever (migration 074). |
| 9553–9597 | 45 | `skill:frontend` | &nbsp;&nbsp;HOLDS MOVED INTO THE WATCH CARD, AND A QUEUED ONE CAN BE CALLED OFF (2026-09-04) | Holds in the watch card; cancelHold. |
| 9598–9621 | 24 | `skill:alerting` | &nbsp;&nbsp;THE DEAD-MAN'S SWITCH IS GONE (2026-09-04) | The dead-man switch removed. |
| 9622–9654 | 33 | `skill:rc-autocart` | &nbsp;&nbsp;A CAMPSITE WAS LOST TO A 12-SECOND RETRY GAP, AND THE FIX IS A BURST (2026-09-03, #261) | The cart burst. |
| 9655–9680 | 26 | `skill:rc-autocart` | &nbsp;&nbsp;"RC NEVER RELEASES EARLY" IS UNPROVABLE WITH THE INSTRUMENT WE HAVE (2026-09-03) | RC never releases early is unprovable with the poller. |
| 9681–9880 | 200 | `skill:rc-autocart` | &nbsp;&nbsp;THE RELEASE WINDOW IS BEING MEASURED DIRECTLY (2026-09-04, #264) — AND IT ANSWERED | The release window measured directly, and it answered. |
| 9881–9893 | 13 | `skill:catalog-poller` | &nbsp;&nbsp;THE THIRD SHARD (2026-09-04, #262) | The third shard. |
| 9894–9928 | 35 | `STAY` | &nbsp;&nbsp;I READ A STALE CHECKOUT AS PRODUCTION DRIFT, AND BROKE THE HOLD BUTTON FOR SIXTEEN MINUTES (2026-09-04) | git fetch origin master before calling production wrong. Cost sixteen minutes of a broken hold button and applies to every diagnosis. |
| 9929–10002 | 74 | `skill:rc-autocart` | &nbsp;&nbsp;RC'S OWN LOAD IS INSTRUMENTED NOW (2026-09-04) | RC own load instrumented; the all-clear floor. |
| 10003–10152 | 150 | `skill:chromium-leak` | &nbsp;&nbsp;THE RDR LOOP IS A LOAD-TIME BURST AT ~800 REQ/S, NOT A 150/S POLL (2026-09-06) | The RDR burst at ~800 req/s, and its independence from the leak. |
| 10153–10226 | 74 | `skill:seo` | &nbsp;&nbsp;~~"CANCELLATIONS DON'T START UNTIL TWO WEEKS OUT" IS FOLK WISDOM AND OUR DATA SAYS OTHERWISE~~ — I MEASURED THE WRONG WINDOW (2026-09-04) | Cancellation lead-time folk wisdom, and the window that was measured wrong. |
| 10227–10248 | 22 | `skill:seo` | &nbsp;&nbsp;TWO PROBLEM-INTENT PAGES, AND THEY ARE NOT THE FALSIFIED BET (2026-09-04) | Two problem-intent pages. |
| 10249–11129 | 881 | `skill:chromium-leak` | &nbsp;&nbsp;THE ONSET IS A 35 GB COMMIT STEP, THE TAB HAS ITS OWN RENDERER, AND THE INSTRUMENTS FOR BOTH ARE BUILT (2026-09-04) | The 35 GB commit step, the request counter, the region walk. |
| 11130–11159 | 30 | `skill:costs` | &nbsp;&nbsp;SUPABASE EGRESS WAS 2.1x THE FREE LIMIT AND 60% OF IT WAS `bot.mjs` POLLING EVERY 2s (side-lane §27, 2026-08-24; folded 2026-09-04) | Supabase egress 2.1x the free limit; POLL_MS still open. |
| 11160–11176 | 17 | `STAY` | &nbsp;&nbsp;A TOOL-CALL PARAMETER LEAKED ITS OWN CLOSING TAGS INTO MASTER'S HISTORY (2026-09-04) | A tool-call parameter leaked its closing tags into a commit. Check the tail of a long parameter. About working here, not about the product. |
| 11177–11309 | 133 | `skill:billing` | &nbsp;&nbsp;THE TWO NEW SUBSCRIBERS PAID FOR THREE FINDINGS (2026-09-09) | SMS consent, the /new promise, dead notify columns. |
| 11310–11378 | 69 | `skill:app-store` | &nbsp;&nbsp;ANDROID 16 IGNORES `overlaysWebView: false`, AND EIGHTEEN SCREENS DREW UNDER THE STATUS BAR (2026-09-10) | Android 16 ignores overlaysWebView; safe-area insets. |
| 11379–11423 | 45 | `skill:frontend` | &nbsp;&nbsp;"FAVORITES IS SPELT WRONG" — IT WAS, AND FIVE MORE WERE (2026-09-10) | US spelling gate. |
| 11424–11498 | 75 | `skill:mini-pc` | &nbsp;&nbsp;THE STAND-DOWN LOG FLOODED THE WINDOW SOMEBODY READS AT 08:00 (2026-09-16) | The stand-down log flooded the tail-log window. |
| 11499–11595 | 97 | `skill:mini-pc` | &nbsp;&nbsp;THE KEEP-WARM DIED SILENTLY AND THE LOCK OUTLIVED IT BY EIGHT MINUTES (2026-09-16) | The keep-warm died silently; the lock outlived it. |
| 11596–12738 | 1143 | `skill:chromium-leak` | &nbsp;&nbsp;THE RAMPS STOPPED BEFORE THE CURE DID, AND THE RENEWAL NEVER REACHES OKTA (2026-09-17) | The drought, the cure probes, the two ramp populations. EXCEPTION: 12216 (the AS t alias trap) is STAY. |
| 12739–12865 | 127 | `skill:rc-autocart` | &nbsp;&nbsp;THE 08:00 FAST LANE HAS NEVER ONCE BEEN OBSERVED RUNNING (2026-09-17) | The 08:00 fast lane has never been observed running; cart-burst events. |
| 12866–12992 | 127 | `skill:rc-autocart` | &nbsp;&nbsp;"RECONNECT AUTO-CART FOR REC.GOV" WAS ONE HIDDEN INPUT, AND THE LOOP WAS CLOSED (2026-09-18) | The rec.gov reconnect: one hidden input, and the closed loop. |
| 12995–13062 | 68 | `skill:orchestrate` | &nbsp;&nbsp;&nbsp;&nbsp;2026-09-20 — ONE SESSION CAN DISPATCH ANOTHER, AND IT COSTS MORE TO ARRIVE THAN TO WORK | One session can dispatch another. Belongs in the orchestrate skill that it documents. |
| 13063–13095 | 33 | `skill:browser-qa` | &nbsp;&nbsp;&nbsp;&nbsp;2026-09-20 — CLAUDE HAS HANDS ON THE SITE NOW, FROM THE HOME SERVER | Claude has hands on the site from the home server. The browser-qa skill already exists. |
| 13096–13127 | 32 | `skill:rc-autocart` | &nbsp;&nbsp;&nbsp;&nbsp;2026-09-18 — THE rec.gov RECONNECT IS FIXED, MERGED, AND LIVE ON BOTH HALVES | The rec.gov reconnect fixed, merged and live. |
| 13128–13163 | 36 | `skill:health` | &nbsp;&nbsp;&nbsp;&nbsp;2026-09-18 — THE DELIVERY CANARY HAS BEEN QUIET FOR ~35 HOURS — WARN, UNCHASED | The delivery canary quiet for 35 hours, then explained by a worker deploy re-phasing it. |
| 13164–13189 | 26 | `skill:rc-autocart` | &nbsp;&nbsp;&nbsp;&nbsp;2026-09-17 — THE CART BURST RECORDS ITSELF NOW, AND IT NEEDS ONE CONTESTED RELEASE | The cart burst records itself. OPEN in the sense that it needs one contested release to speak. |
| 13190–13198 | 9 | `HISTORY` | &nbsp;&nbsp;&nbsp;&nbsp;THE CAPTCHA BLOCK IS OVER — DO NOT ACT ON IT | The CAPTCHA block is over. A do-not-act-on-it note about a state that has passed. |
| 13199–13212 | 14 | `HISTORY` | &nbsp;&nbsp;&nbsp;&nbsp;STATE, READ RATHER THAN REMEMBERED (2026-09-17 17:46 UTC) | A dated state snapshot: master sha, box sha, shards, event counts. Stale within hours by construction. |
| 13213–13229 | 17 | `skill:test-hygiene` | &nbsp;&nbsp;&nbsp;&nbsp;A CANCELLED CI TWIN LEAVES A FIXTURE ROW, AND THE READOUT RENDERS IT AS A READING | A cancelled CI twin leaves a fixture row the readout renders as a reading. OPEN: recentBotEvents has no source filter. |
| 13230–13237 | 8 | `skill:test-hygiene` | &nbsp;&nbsp;&nbsp;&nbsp;AND I BROKE THE LANES RULE WHILE ENFORCING IT — AGAIN | Broke the lanes rule while enforcing it. |
| 13238–13251 | 14 | `OPEN` | &nbsp;&nbsp;&nbsp;&nbsp;STILL OPEN, UNCHANGED | Still open, unchanged. Three live items. |
| 13252–13329 | 78 | `skill:chromium-leak` | &nbsp;&nbsp;&nbsp;&nbsp;THE BOX'S `wedge-recycle` EVENT IS NEARLY EMPTY, AND THE LOG THAT CARRIES THE PROOF ROLLS IN 20 MINUTES (2026-09-17) | The wedge-recycle event is nearly empty and the log rolls. |
| 13330–13401 | 72 | `skill:chromium-leak` | &nbsp;&nbsp;&nbsp;&nbsp;THE DROUGHT IS THE SILENT SELF-SUSTAINING REGIME, AND FORCING IS NOT AVAILABLE TO ME (2026-09-17) | The drought is the silent self-sustaining regime; forcing is not available. |
| 13402–13420 | 19 | `STAY` | &nbsp;&nbsp;&nbsp;&nbsp;AND A `Monitor` CANNOT CARRY A LOAD-BEARING WATCH — IT EXPIRES AT 30 MINUTES BY CONSTRUCTION | A Monitor expires at 30 minutes by construction, so it cannot carry a load-bearing watch. A tooling rule, not a leak finding. |
| 13421–13457 | 37 | `OPEN` | &nbsp;&nbsp;THE CANCELLATION BADGE MISSES THE ONLY CANCELLING SUBSCRIBER (2026-09-16) — one-line gate, three copies | The cancellation badge cannot see the only cancelling subscriber. Unfixed, dated Oct 8. Stays in the Open block. |
| 13458–13493 | 36 | `skill:chromium-leak` | &nbsp;&nbsp;&nbsp;&nbsp;(the section preamble) | The commit residual: the pagefile tracks rather than lags, so the burst never has to wait on growth. |
| 13494–13506 | 13 | `skill:chromium-leak` | &nbsp;&nbsp;&nbsp;&nbsp;AND WINDOWS HAS ALREADY DONE OPTION B BY ITSELF — THE PAGEFILE SETTLED (2026-09-11) | Windows settled the pagefile by itself; option B is off. |
| 13507–13588 | 82 | `skill:chromium-leak` | &nbsp;&nbsp;&nbsp;&nbsp;THE BAIL ARM HAS A COMMIT TRIGGER NOW (option A) — and what it CANNOT do | The bail arm commit trigger (option A) and what it cannot do. |
| 13589–13616 | 28 | `skill:chromium-leak` | &nbsp;&nbsp;&nbsp;&nbsp;THE REAL LEVER IS THE NUMBER OF OKTA TRIPS, AND IT IS ARITHMETIC (2026-09-11) | The real lever is the number of Okta trips. |
| 13617–13667 | 51 | `STAY` | &nbsp;&nbsp;&nbsp;&nbsp;~~`exec_select` SILENTLY RETURNS A SCALAR FOR A BARE COLUMN ALIAS~~ — IT IS THE ALIAS `t`, AND `AS` CHANGES NOTHING (corrected 2026-09-17) | The `AS t` alias trap: a column aliased `t` collapses exec_select to a scalar. One query away from a false reading, in any DB call. |
| 13668–13850 | 183 | `HISTORY` | &nbsp;&nbsp;2026-09-11 — THE LEAK IS DIAGNOSED AND CONTAINED. IT IS **NOT FIXED**. | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 13851–14039 | 189 | `HISTORY` | &nbsp;&nbsp;2026-09-10 — THE TRIAL RAN AND THE COMMAND-BUFFER CANDIDATE IS REFUTED | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14040–14076 | 37 | `HISTORY` | &nbsp;&nbsp;2026-09-10 — TWO PHONE-REPORTED DEFECTS, BOTH FIXED; THE RDR BURST IS STILL OPEN | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14077–14113 | 37 | `HISTORY` | &nbsp;&nbsp;2026-09-09 (evening) — THE GPU CENSUS ANSWERED, AND THE SPIN IS SAMPLED NOW | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14114–14133 | 20 | `HISTORY` | &nbsp;&nbsp;RAMP GAPS ARE 2.3h TO 18.6h — AND BOTH EARLIER FIGURES WERE WINDOWS | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14134–14146 | 13 | `HISTORY` | &nbsp;&nbsp;WHEN A RAMP COULD BE FORCED — 22:33:36 PT TONIGHT, AND IT SHOULD NOT BE | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14147–14155 | 9 | `HISTORY` | &nbsp;&nbsp;STILL FORBIDDEN, each for a recorded reason | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14156–14161 | 6 | `HISTORY` | &nbsp;&nbsp;AND DO NOT REBUILD THESE — each was measured blind for a knowable reason | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14162–14217 | 56 | `HISTORY` | &nbsp;&nbsp;2026-09-09 (later) — VMTHREAD ANSWERED: THE MAIN THREAD IS SPINNING | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14218–14236 | 19 | `HISTORY` | &nbsp;&nbsp;AND THE RELEASE-WINDOW ROUTINE FINALLY RECORDED (2026-09-09 07:56 PT) | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14237–14279 | 43 | `HISTORY` | &nbsp;&nbsp;2026-09-09 — THE SUBSCRIBER READ (#307). THE LEAK ENTRY BELOW IS THE STANDING PRIORITY. | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14280–14355 | 76 | `HISTORY` | &nbsp;&nbsp;2026-09-09 (later) — THE DUMP IS RETIRED; THE READING MOVED OUTSIDE THE PROCESS | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14356–14414 | 59 | `HISTORY` | &nbsp;&nbsp;2026-09-09 — THE CAPTURE CHAIN IS FINISHED; THE RENDERER IS WHAT WILL NOT ANSWER | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14415–14469 | 55 | `HISTORY` | &nbsp;&nbsp;2026-09-08 (evening) — THE ORDERED RAMP FIRED AND MISSED, AND ONE CLAIM IS CORRECTED | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14470–14514 | 45 | `HISTORY` | &nbsp;&nbsp;2026-09-08 (latest) — THE METHOD CHANGED; THE TRIGGER NO LONGER NEEDS A RAMP TO TEST | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14515–14553 | 39 | `HISTORY` | &nbsp;&nbsp;2026-09-08 (later) — THE FOURTH MISS: THE GRACE WAITED FOR NOTHING | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14554–14588 | 35 | `HISTORY` | &nbsp;&nbsp;2026-09-08 — THE DUMP MISSED A THIRD TIME, AND THE THIRD MECHANISM IS THE SAMPLER'S CADENCE | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14589–14686 | 98 | `HISTORY` | &nbsp;&nbsp;2026-09-07 — THE RAMP CAME, THE DUMP FIRED, AND IT MEASURED THE WRONG BROWSER | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14687–14747 | 61 | `HISTORY` | &nbsp;&nbsp;2026-09-06 EVENING — NOTHING IS ASSIGNED; THE LEAK IS WAITING ON A RAMP | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14748–14833 | 86 | `HISTORY` | &nbsp;&nbsp;2026-09-06 — THE WALK ANSWERED: 16,387 MAPPED SECTIONS OF 2 MB | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14834–14850 | 17 | `HISTORY` | &nbsp;&nbsp;2026-09-05 — THE BAIL ARM WAS INERT, THE REQUEST COUNTER ANSWERED, AND A BAIL COST THE SESSION | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14851–14875 | 25 | `HISTORY` | &nbsp;&nbsp;2026-09-04 EVENING — THE LEAK INSTRUMENTS ARE BUILT AND WAIT ON A BOX UPDATE | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14876–14886 | 11 | `HISTORY` | &nbsp;&nbsp;THE 09-04 08:00 RELEASE CARTED AND WAS HANDED OVER — `#L034`, T+1.4s | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14887–14902 | 16 | `HISTORY` | &nbsp;&nbsp;TWO SESSIONS WROTE CONTRADICTORY ACCOUNTS OF ONE INDEX INTO THIS FILE, ON THE SAME DAY | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14903–14924 | 22 | `HISTORY` | &nbsp;&nbsp;~~MIGRATION 074 WAS NOT APPLIED WHEN I SAID IT WAS~~ — I WAS READING THE OTHER LANE'S REVERT | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14925–14965 | 41 | `HISTORY` | &nbsp;&nbsp;AND `#L034`'s 01:11 MISS NOW HAS TWO CANDIDATES, NOT ONE — do not write either in | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14966–14972 | 7 | `HISTORY` | &nbsp;&nbsp;READ THIS BEFORE CALLING PRODUCTION WRONG ABOUT ANYTHING | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14973–14982 | 10 | `HISTORY` | &nbsp;&nbsp;SIX WATCHES THE DEAD-MAN'S SWITCH SWITCHED OFF ARE STILL OFF — the owner's call | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 14983–15015 | 33 | `HISTORY` | &nbsp;&nbsp;~~THEN: MERGE #255.~~ **#255 MERGED 2026-09-03** — THE ANDROID HAND-OFF IS FIXED AND HUMAN-VERIFIED. | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 15016–15033 | 18 | `HISTORY` | &nbsp;&nbsp;ALSO OPEN: RUN THE RECONCILE. `trialing` STILL READS 0 AND THAT IS EXPECTED. | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 15034–15039 | 6 | `HISTORY` | &nbsp;&nbsp;`#L080` RELEASED 2026-09-02 08:00 PT AND EXPIRED UNTAPPED — not a fault | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 15040–15047 | 8 | `HISTORY` | &nbsp;&nbsp;~~A HOLD-SUITE TEST FAILS WHENEVER A HOLD IS LIVE~~ — FIXED 2026-09-02 | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 15048–15059 | 12 | `HISTORY` | &nbsp;&nbsp;ANOTHER SESSION IS ACTIVE ON THIS REPO AND ON THE MINI-PC | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 15060–15322 | 263 | `HISTORY` | &nbsp;&nbsp;PLAY: RELEASE 25 IS IN REVIEW (submitted 2026-09-01). NOTHING TO DO BUT WAIT. | A dated handover, superseded by the one above it. The whole stack is chronological narrative. |
| 15323–15411 | 89 | `skill:rc-autocart` | &nbsp;&nbsp;THE APP'S RC SESSION IS BEING MEASURED NOW — no renewal built yet (migration 058, 2026-08-13) | The app RC session probe (migration 058). |
| 15412–15442 | 31 | `skill:frontend` | &nbsp;&nbsp;"What counts as a match" DID NOT COUNT FOR ANYTHING (2026-08-15) | The site-type picker that counted for nothing. |
| 15443–15503 | 61 | `skill:frontend` | &nbsp;&nbsp;MUTING IS ON THE NEW WATCH SCREEN NOW, AND IT IS ONE COMPONENT (2026-08-15) | Muting on the new-watch screen. |
| 15504–15585 | 82 | `skill:catalog-poller` | &nbsp;&nbsp;ONE WATCH CAN COVER A WHOLE PARK (migration 070, 2026-08-15) — DORMANT UNTIL SOMEONE MAKES ONE | Park watches (migration 070). |
| 15586–15612 | 27 | `skill:frontend` | &nbsp;&nbsp;THE UI ROUND, 2026-08-15 evening — all three found by USING the app | Three UI defects found by using the app. |
| 15613–15636 | 24 | `skill:frontend` | &nbsp;&nbsp;FILTERS: TWO WERE UNUSABLE ON THE DATA (2026-08-15) | Two filters unusable on the data. |
| 15637–15653 | 17 | `STAY` | &nbsp;&nbsp;`npm run verify` GATES ON jsx-spacing NOW (2026-08-15) | npm run verify gates on jsx-spacing. A gate that governs every change; placed before npm test because cheap gates come first. |
| 15654–15702 | 49 | `skill:rc-autocart` | &nbsp;&nbsp;THE 08:00 HAND-OFF WORKED END TO END (2026-08-16) — and the alarm that fired was ours | The 08:00 hand-off end to end, and the alarm that was ours. |
| 15703–15759 | 57 | `STAY` | &nbsp;&nbsp;A TypeError PUBLISHED A USER'S PASSWORD (2026-08-16) — ~~and the feature is REVERTED~~ | A TypeError published a password. Do not collect a field you then have to filter. A security rule that has now fired twice on different fields. |
| 15760–15840 | 81 | `skill:rc-session` | &nbsp;&nbsp;"ALREADY SIGNED IN" IS NOT "COVERED" — the 08:00 cart lost to a one-line short-circuit (2026-08-15) | Already signed in is not covered; the profile-contention death spiral. |
| 15841–15886 | 46 | `skill:test-hygiene` | &nbsp;&nbsp;`npm test` TOLD THE PRODUCTION BOT TO CART A REAL CAMPSITE (2026-08-15) | npm test told the bot to cart a real campsite; the sentinel unit id rule. |
| 15887–15949 | 63 | `skill:mini-pc` | &nbsp;&nbsp;THE FORCED KEEPALIVE SAMPLE NEVER RAN, AND THE BOX HAD BEEN ON STALE CODE FOR FOUR HOURS (2026-08-15) | The forced keepalive sample and four hours of stale code. |
| 15950–15969 | 20 | `STAY` | &nbsp;&nbsp;`query()` CANNOT WRITE — the routing bug class (2026-08-11) | query() cannot write. A routing bug class invisible to TypeScript, guarded by a tree scan. Applies to every DB call site. |
| 15970–15999 | 30 | `skill:mini-pc` | &nbsp;&nbsp;The control channel rides the ROSTER feed (migration 055, 2026-08-11) | The control channel rides the roster feed (migration 055). |
| 16000–16027 | 28 | `skill:rc-session` | &nbsp;&nbsp;The nightly RC login rehearsal (migration 054, 2026-08-11) | The nightly login rehearsal (migration 054). |
| 16028–16068 | 41 | `skill:rc-session` | &nbsp;&nbsp;THE RENEWAL RUNS ON THE BOX — CONFIRMED 2026-08-16 01:53 UTC | The renewal runs on the box; the reliable cell proven. |
| 16069–16093 | 25 | `skill:rc-session` | &nbsp;&nbsp;THE LOGIN REHEARSAL PASSED — FOR THE FIRST TIME IN ITS LIFE (2026-08-16 03:00 UTC) | The rehearsal passed for the first time. |
| 16094–16138 | 45 | `skill:rc-session` | &nbsp;&nbsp;THE LOGIN REHEARSAL HAS NEVER PASSED, AND IT DID NOT FIRE ON 08-12 | The rehearsal had never passed and did not fire. |
| 16139–16185 | 47 | `skill:rc-session` | &nbsp;&nbsp;THE RENEWAL QUESTION IS ANSWERED (2026-08-15 evening) — and the answer is "stop renewing" | The renewal question answered: stop renewing. |
| 16186–16266 | 81 | `skill:rc-session` | &nbsp;&nbsp;WHY THE RELOAD FAILED: A PLAIN LOAD IS NOT THE BOOTSTRAP — THE CLICK IS (2026-08-15, later) | A plain load is not the bootstrap; the click is. |
| 16267–16341 | 75 | `skill:rc-session` | &nbsp;&nbsp;THE RENEWAL WAS MEASURING ITSELF (2026-08-12) — the keep-warm question is REOPENED | The renewal was measuring itself. |
| 16342–16353 | 12 | `skill:rc-autocart` | &nbsp;&nbsp;Never offer a hold when there is no bot to honour it (2026-08-11) | Never offer a hold when there is no bot to honour it. |
| 16354–16378 | 25 | `skill:alerting` | &nbsp;&nbsp;MUTING A SITE DID NOTHING TO ITS COMING-SOON ALERTS (2026-08-13) | Muting did nothing to coming-soon alerts. |
| 16379–16397 | 19 | `skill:alerting` | &nbsp;&nbsp;Auto-cart alerts lost the site id and the kind (2026-08-11) | Auto-cart alerts lost the site id and the kind. |
| 16398–16418 | 21 | `skill:rc-session` | &nbsp;&nbsp;"The auto-login has had its turn" was said 15 minutes early (2026-08-12) | The auto-login had its turn, said 15 minutes early. |
| 16419–16434 | 16 | `skill:health` | &nbsp;&nbsp;Health severity — two false alarms that would have paged all night (2026-08-11) | Two false alarms that would have paged all night; Check.pages. |
| 16435–16464 | 30 | `skill:mini-pc` | &nbsp;&nbsp;Diagnostics that fail invisibly — three from one evening (2026-08-11) | Three diagnostics that fail invisibly. |
| 16465–16480 | 16 | `skill:mini-pc` | &nbsp;&nbsp;`update.bat` reported the wrong commit, and node still crashes on the way out | update.bat reported the wrong commit. |
| 16481–16557 | 77 | `skill:mini-pc` | &nbsp;&nbsp;`autocart.bot_version` — does the box run the code master has? (migration 056, 2026-08-12) | autocart.bot_version (migration 056) and the COALESCE trap. |
| 16558–16611 | 54 | `skill:mini-pc` | &nbsp;&nbsp;THE ON-DEMAND UPDATE DEADLOCKED ITSELF (2026-08-12) — read before pressing "Update now" | The on-demand update deadlocked itself. |
| 16612–16640 | 29 | `skill:mini-pc` | &nbsp;&nbsp;THE ON-DEMAND UPDATE WROTE NO LOG AT ALL, AND NEITHER DID ITS SPAWNER (2026-08-14) | The on-demand update wrote no log at all. |
| 16641–16661 | 21 | `skill:mini-pc` | &nbsp;&nbsp;`tail-log` RETURNED THE NEWEST LINES AS MOJIBAKE, EVERY TIME (2026-08-14) | tail-log returned mojibake: one file, two encodings. |
| 16662–16698 | 37 | `skill:mini-pc` | &nbsp;&nbsp;`rc-login.bat`'s KILL HAD NEVER RUN — `\"` IS NOT A CMD ESCAPE (2026-08-14) | Backslash-quote is not a cmd escape; the kill had never run. |
| 16699–16730 | 32 | `skill:mini-pc` | &nbsp;&nbsp;`restart-rc` RELAUNCHED THE RC PAIR AS BARE `node` REPLs (2026-08-14) | restart-rc relaunched the pair as bare node REPLs. |
| 16731–16755 | 25 | `skill:mini-pc` | &nbsp;&nbsp;THE RUNNER HEARTBEAT WAS KEPT GREEN BY THE UPDATER (2026-08-14) | The runner heartbeat kept green by the updater. |
| 16756–16798 | 43 | `skill:rc-session` | &nbsp;&nbsp;RC WENT BLANK IN THE BOT'S BROWSER, AND IT WAS THE CHROMIUM PROFILE (2026-08-14) | RC went blank in the bot browser; it was the Chromium profile. |
| 16799–16820 | 22 | `skill:mini-pc` | &nbsp;&nbsp;THE STOP SCRIPTS COULD NEVER KILL CHROME'S CHILD PROCESSES (2026-08-14) | The stop scripts could never kill Chrome child processes. |
| 16821–16851 | 31 | `skill:mini-pc` | &nbsp;&nbsp;THE WATCHDOG ASKED "IS ANYTHING RUNNING?" — RESTARTS THE BOTS, NEVER THE PC | The watchdog asked is anything running; restarts bots, never the PC. |
| 16852–16889 | 38 | `skill:chromium-leak` | &nbsp;&nbsp;A Chromium ate 41 GB of COMMIT, and nothing could kill it remotely (2026-08-12) | A Chromium ate 41 GB of commit. |
| 16890–17076 | 187 | `skill:chromium-leak` | &nbsp;&nbsp;THE CHROMIUM LEAK IS RECORDED NOW, BECAUSE IT CANNOT BE CAUGHT BY HAND (migration 059, 2026-08-14) | The leak recorded because it cannot be caught by hand (migration 059). |
| 17077–17090 | 14 | `skill:mini-pc` | &nbsp;&nbsp;THREE DIAGNOSTICS LIED AT ONCE, AND THE HEARTBEAT WAS RIGHT (2026-08-12) | Three diagnostics lied at once and the heartbeat was right. |
| 17091–17116 | 26 | `skill:rc-autocart` | &nbsp;&nbsp;Front-of-flow: sign in to RC BEFORE the release (2026-08-12) | Sign in to RC before the release. |
| 17117–17152 | 36 | `skill:rc-autocart` | &nbsp;&nbsp;THE RELEASED SCREEN HAD NO SIGN-IN STEP — FIXED 2026-08-13 evening | The released screen had no sign-in step. |
| 17153–17164 | 12 | `skill:rc-autocart` | &nbsp;&nbsp;DON'T THROW A REVISITING USER INTO RC (2026-08-13 evening) | Do not throw a revisiting user into RC. |
| 17165–17262 | 98 | `skill:rc-autocart` | &nbsp;&nbsp;THE CART POSTS NEVER FIRE — AND IT IS NOT THE TOKEN (2026-08-13; FIXED AND PROVEN THE SAME DAY — see the sub-section two below) | The cart POSTs, and that submit mints the key. |
| 17263–17429 | 167 | `skill:rc-autocart` | &nbsp;&nbsp;RESERVECALIFORNIA CAPS THE BOT'S CART AT 2 (2026-08-13) | RC caps the cart at 2; later measured per cart, ceiling 20. |
| 17430–17527 | 98 | `skill:rc-autocart` | &nbsp;&nbsp;THE HAND-OFF UI OVERHAUL, AND TWO BUGS IN THE INSTRUMENT (2026-08-13 evening) | The hand-off UI overhaul and two bugs in the instrument. |
| 17528–17547 | 20 | `skill:billing` | &nbsp;&nbsp;Stripe is constructed lazily, in ONE place (2026-08-12) | Stripe constructed lazily in one place. |
| 17548–17576 | 29 | `skill:mini-pc` | &nbsp;&nbsp;The box ran out of COMMIT, and both diagnostics looked the other way (2026-08-12) | The box ran out of commit; memory and fix-pagefile. |
| 17577–17587 | 11 | `skill:rc-autocart` | &nbsp;&nbsp;`--once` asserted the one thing it never checked (2026-08-12) | --once asserted the one thing it never checked. |
| 17588–17598 | 11 | `STAY` | &nbsp;&nbsp;Retry a DB call only when it never left (2026-08-12) | Retry a DB call only when it never left. Splits by what the error proves, not by how transient it feels. Applies to every query. |
| 17599–17604 | 6 | `STAY` | &nbsp;&nbsp;Supabase's "CRITICAL" RLS email was a false positive (2026-08-11) | The Supabase RLS CRITICAL email is a false positive on a PostGIS table. A do-not-chase note; cheaper to keep than to re-derive. |
| 17605–17664 | 60 | `HISTORY` | &nbsp;&nbsp;The first 8am hold FAILED — and the recovery worked (2026-08-07) | The first 8am hold failed, 2026-08-07. Every fix it drove is recorded in the rc-autocart entries above. |
| 17665–17691 | 27 | `HISTORY` | &nbsp;&nbsp;2026-08-10 08:00 MISSED — a WEDGED keep-warm held the Chromium profile | 2026-08-10 missed; a wedged keep-warm. Superseded by the keep-warm and leak entries. |
| 17692–17759 | 68 | `skill:mini-pc` | &nbsp;&nbsp;THE MINI-PC SUPERVISES AND UPDATES ITSELF NOW (2026-08-10) — needs ONE last update.bat | supervise.ps1, auto-update and stop-all. |
| 17760–17793 | 34 | `skill:rc-autocart` | &nbsp;&nbsp;The rec.gov auto-relogin never retried — a log line that lied (2026-08-11) | The rec.gov auto-relogin never retried. |
| 17794–17810 | 17 | `skill:mini-pc` | &nbsp;&nbsp;PowerShell scripts must be pure ASCII (2026-08-11) | PowerShell scripts must be pure ASCII. |
| 17811–17839 | 29 | `skill:rc-session` | &nbsp;&nbsp;The auto-login lead is T−30 now, and "covered" is DERIVED (2026-08-11) | The auto-login lead is T-30, and covered is derived. |
| 17840–17849 | 10 | `skill:rc-session` | &nbsp;&nbsp;UNATTENDED LOGIN WORKS — first clean production run, 2026-08-10 18:35Z | Unattended login works: the first clean production run. |
| 17850–17857 | 8 | `skill:mini-pc` | &nbsp;&nbsp;`update.bat` ENDS the RC session — update FIRST, log in AFTER (2026-08-10) | update.bat ends the RC session. |
| 17858–18011 | 154 | `skill:alerting` | &nbsp;&nbsp;Twilio A2P ticket #28871693 — ANSWERED 2026-08-11, and the answer is DON'T EDIT | The Twilio A2P ticket and the do-not-edit answer. |
| 18012–18029 | 18 | `HISTORY` | &nbsp;&nbsp;The 8am flow could never have worked — the cart fired BEFORE the release (2026-08-08) | The 8am flow could never have worked, 2026-08-08. The fix is in the rc-autocart entries. |
| 18030–18195 | 166 | `skill:rc-session` | &nbsp;&nbsp;The RC keep-warm was never renewing anything (2026-08-08) | The keep-warm was never renewing anything. |
| 18196–18204 | 9 | `skill:health` | &nbsp;&nbsp;A dead RC session is NOT "alerting is broken" (2026-08-08) | A dead RC session is not alerting broken. Check.pages. |
| 18205–18490 | 286 | `skill:rc-status` | &nbsp;&nbsp;If a hold is queued: did the 8am cart fire? (the daily check) | The daily did-the-cart-fire check. A /rc-status skill already exists; this is its content and should merge into it rather than becoming a new one. |
| 18491–18533 | 43 | `skill:app-store` | &nbsp;&nbsp;iOS 1.0 WAS REJECTED 2026-08-14 — GUIDELINE 2.1, AND THE REVIEWER NEVER GOT IN | iOS rejected 2026-08-14, guideline 2.1. |
| 18534–18580 | 47 | `skill:app-store` | &nbsp;&nbsp;iOS 1.0 was SUBMITTED — the queue, for the record (2026-08-08) | iOS 1.0 submitted; the queue. |
| 18581–18618 | 38 | `skill:app-store` | &nbsp;&nbsp;iOS 1.0 (5) REJECTED 2026-08-19 — GUIDELINE 3.1.1, and 3.1.3(b) WAS NEVER THE DEFENCE | iOS 1.0 (5) rejected 3.1.1. |
| 18619–19119 | 501 | `skill:app-store` | &nbsp;&nbsp;THE 3.1.1 FIX WAS LIVE AND THE REVIEWER COULD NOT SEE IT (2026-08-22) | The 3.1.1 fix was live and the reviewer could not see it. Includes the 09-14 submission state. |
| 19120–19145 | 26 | `skill:app-store` | &nbsp;&nbsp;A WEB DEPLOY CANNOT ADD PURCHASE CAPABILITY — folded in 2026-08-30, written 08-24 | A web deploy cannot add purchase capability. |
| 19146–19156 | 11 | `STAY` | &nbsp;&nbsp;THE SIDE LANE'S NOTES ARE REFERENCED BY NOTHING — read them before trusting this file | The side lane notes are referenced by nothing. A process rule about the fold-in, and it belongs next to the one-writer rule. |
| 19157–19195 | 39 | `skill:app-store` | &nbsp;&nbsp;PLAY IN-APP PURCHASE WORKS — a real purchase, read back out of RevenueCat (2026-08-30) | Play in-app purchase works. |
| 19196–19354 | 159 | `skill:billing` | &nbsp;&nbsp;THE REVENUECAT WEBHOOK HAS 401'd EVERY EVENT IT HAS EVER RECEIVED (2026-09-14) | The RevenueCat webhook 401d every event, and the partial-index ON CONFLICT. |
| 19355–19451 | 97 | `skill:app-store` | &nbsp;&nbsp;APPLE IAP WAS DECIDED ON 2026-08-24, AND THIS FILE DID NOT CARRY IT FOR SIX DAYS | Apple IAP was decided on 2026-08-24. |
| 19452–19475 | 24 | `skill:app-store` | &nbsp;&nbsp;DO THIS THE MOMENT THE APP IS LIVE | Turn on store link-out the moment the app is live. |
| 19476–19498 | 23 | `skill:app-store` | &nbsp;&nbsp;Play REJECTED 2026-08-03 — Misleading Claims, missing government source links | Play rejected 2026-08-03; the sources page. |
| 19499–19549 | 51 | `skill:app-store` | &nbsp;&nbsp;Play target API 36 — Capacitor 8 BUILT AND ON TESTFLIGHT (build 8, 2026-08-08) | Play target API 36; Capacitor 8. |
| 19550–19636 | 87 | `skill:app-store` | &nbsp;&nbsp;ANDROID DEVELOPER VERIFICATION — REGISTERED, 3 KEYS, ALL VERIFIED (confirmed 2026-09-16) | Android developer verification; registered, nothing to do. |
| 19637–19644 | 8 | `skill:app-store` | &nbsp;&nbsp;Mobile app — everything below needs `npm install && npx cap sync` + a REBUILD | Mobile app changes that need a rebuild. |
| 19645–19680 | 36 | `HISTORY` | &nbsp;&nbsp;Verified since / still unverified | Verified since / still unverified. Every one of the four is now closed. |
| 19681–19718 | 38 | `OPEN` | &nbsp;&nbsp;Known, not urgent | Known, not urgent. Small live items; stays. |
| 19719–19812 | 94 | `STAY` | &nbsp;&nbsp;TEN THINGS THAT LIVED ONLY IN THE HANDOVER (folded 2026-09-10) | Ten things that lived only in the handover. A set of cross-cutting rules (exit codes through pipes, rebase --onto, SQL elapsed time, the blank-outlook default) with no single home. |
