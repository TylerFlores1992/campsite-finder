# ReserveCalifornia auto-cart: holds, carts, the hand-off, and the mini-PC

*Extracted verbatim from `CLAUDE.md` on 2026-09-21. This file is the AUTHORITATIVE RECORD
for the RC 08:00 hold flow — offers, the fairness line, cart capacity, the claim screen and
the in-app hand-off — and for the Windows mini-PC that runs the bot: its supervisors, its
update path, its watchdog and its remote control channel.*

**Nothing here was rewritten.** Every block is the original text in its original order,
strike-throughs included. A struck heading is usually a claim that was later measured false
by the very evidence beneath it; read both.

`CLAUDE.md` keeps router entries carrying the conclusions and the standing prohibitions.


**One caveat, and it is the cost of splitting one file into four.** `CLAUDE.md` interleaved
these subjects chronologically, so a cross-reference inside a block — *"the entry above"*,
*"see directly below"* — may now point at text that landed in a **different** archive. The
blocks themselves are intact and in their original relative order; only their neighbours
changed. `docs/PRUNE-LEDGER.md` maps every block to its original `CLAUDE.md` line range, so a
reference that has lost its target can be located there in one lookup.
---

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

### THE NIGHTLY UPDATE IS STRUCTURALLY IMPOSSIBLE ON ANY NIGHT WITH AN 08:00 HOLD (2026-09-20)
Asked to "resolve the blocked issue and find a solution so this doesn't keep happening" after a
bot-side fix failed to reach the box for a third time. **The blocked issue is arithmetic in
`update-guard.mjs`'s own defaults, and the comment beside them asserts the opposite.**
```
windowStart 2 · windowEnd 5 · minHoursToRelease 6      RC releases at 08:00 PT
08:00 − 6h = 02:00, and the quiet window is 02:00–05:00 — they touch and do not overlap
```
- **MEASURED AGAINST THE REAL FUNCTION, NOT READ OFF THE CONSTANTS.** `safeToUpdate` walked
  across a night with a genuine 08:00 hold queued:
  ```
  01:45 PT  SKIP  outside the quiet window (1:00 PT, allowed 2:00-5:00)
  02:00 PT  OK    quiet window, next release 6.0h away          <- the ONLY passing moment
  02:05 PT  SKIP  a hold releases in 5.9h — too close to take the session down
  02:30 PT  SKIP  a hold releases in 5.5h
  03:00 PT  SKIP  5.0h      04:00 PT  SKIP  4.0h      04:59 PT  SKIP  3.0h
  ```
  The gate is `hrs < minHoursToRelease`, so **02:00:00 passes by exactly zero margin and every
  instant after it is refused.** The scheduled task fires every five minutes and is essentially
  never at 02:00:00.000, so in practice the window is shut for its entire length.
- **THE COMMENT SAYS THE REVERSE, AND IT IS THE REASON NOBODY LOOKED.** `minHoursToRelease`
  carries *"Six covers a 02:00 update against an 08:00 release with the whole quiet window to
  spare."* It covers a 02:00 update with **no** spare and covers nothing at 02:05. A plausible
  sentence asserting a margin that the same file's other two constants delete — the
  tidy-story-as-fact shape, in the module whose whole job is a decision.
- **SO A BOT-SIDE FIX CANNOT REACH THE BOX UNATTENDED ON ANY NIGHT A HOLD IS QUEUED**, which is
  most nights this product does anything. That is why #363's successor sat undeployed, and why
  the same "it is merged but not on the box" sentence has been written three times.
- **"UPDATE NOW" IS THE UNBLOCK AND IT WORKS TODAY.** An explicit request lifts the window and
  not the release check, so with a release 17.7h out it returns
  `{ok: true, reason: "requested, next release 17.7h away"}` — verified against the real
  function in the same run. **The lever was never broken; the SCHEDULE was.**
- **THE CHEAPEST REPAIR IS TO MOVE THE WINDOW, NOT TO SHORTEN THE GATE.** Six hours is the
  protection and it is the half that should not move; 02:00–05:00 is a preference. A window of
  **23:00–02:00 PT** runs the lead from 9h down to 6h and is clear of the gate for its whole
  length. **NOT MADE HERE** — it is a bot-side change to the guard that stands between an
  update and a missed cart, and it wants its own change with its own mutation-verified guard
  rather than a drive-by inside a docs branch.
- **AND A GUARD SHOULD PIN THE RELATIONSHIP, NOT THE NUMBERS.**
  `worker/update-guard.test.mts` asserts the constants; nothing asserts that the window and the
  lead leave a usable overlap against an 08:00 release. That is why three constants could be
  individually correct and jointly useless.

#### AND IT BIT THE SAME EVENING, WITH THE OWNER'S OWN HOLDS ON THE OTHER SIDE OF IT (2026-09-20)
The arithmetic above was walked against a hypothetical release. Hours later it was the live
state, and it is worth recording as an observation rather than a derivation:
```
box HEAD   db08b9b   11 commits behind master
in the gap scripts/auto-cart-bot/recgov-login.mjs   +423  <- #379, the fix for the
           scripts/auto-cart-bot/renewal-schedule.mjs +140     owner's own reported bug
           scripts/auto-cart-bot/rc-keepwarm.mjs      +9
holds      #M450 and #R359, both `requested` by the owner, releasing 2026-09-21 08:00 PT
session    DEAD 2h43m, okta GONE(404)
```
- **SO THE UNATTENDED PATH IS SHUT TONIGHT, BY THE ARITHMETIC ABOVE AND NOT BY A FAULT.**
  `nextHoldRelease` returns 08:00 PT, the quiet window is 02:00-05:00, and the 6h gate covers
  all of it.
- **"UPDATE NOW" IS OPEN AND HAS A DEADLINE OF 02:00 PT.** A request lifts the window and not
  the release check, so it passes while the lead exceeds 6h — verified against the real
  function at 17.7h — and is refused from 02:00 onward.
- **AND THE USUAL COST OF PRESSING IT IS ZERO RIGHT NOW, WHICH IS THE PART THAT IS EASY TO GET
  BACKWARDS.** The standing objection is that an update ends the RC session, because
  `stop-all` closes the Chromium the token lives in. **The session is already dead** — so at
  this moment the destructive half costs nothing, and `maybeAutoLogin` at T-30 (07:30 PT) is
  the designed repair either way, with the login rehearsal having PASSED at 03:01 the same
  morning. **A dead session is the CHEAPEST moment to update, not a reason to wait.**
- **THERE IS NO SCRIPTED PATH: `requestBotUpdate` has exactly one caller**, the Clerk-authed
  `/api/admin/bot-update` route, so no session can press it. Checked rather than assumed —
  this is the owner's action by construction, not by policy.

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

### THE HAND-OFF LANDS IN THE CART NOW, AND THE SIGN-IN NEVER PRESSED ANYTHING (2026-08-23)
Two rough edges reported by the owner after a hold that **worked** (carted at T+1.6s — a test
fixture, see the correction above; the cart was real either way), so neither was an outage. Both were reproduced against the SERVED BUNDLE before a line was
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

### `cart read back` NEVER PROVED THE OWNER COULD REACH THE CART (2026-08-29)
The first Android hand-off reported the two lines this repo treats as proof — and the owner,
holding the phone, said the cart was empty and RC was asking them to log in.

```
TEST · 43793 [android build 1.0 (25)]: ✓ Added to cart — opening your cart…
    cart read back: 1 entry — RC confirms it is holding something
```

**RC'S OWN INVENTORY SETTLED IT, AND BOTH HALVES ARE TRUE AT ONCE.** `rc-test-hold.mts --find`
re-asked RC for Weyland Camp's 2026-12-01 inventory: **unit 43793 was gone and the count had
dropped 39 → 38.** So the reservation is real. And the owner's account menu offered **"Log
out"** while the cart control asked them to **log in** — RC contradicting itself, on one screen.
**The cart exists, and the page cannot show it.**

- **THE READ-BACK IS RC'S ANSWER TO *OUR* QUESTION, ASKED WITH *OUR* KEY.** It POSTs
  `webaccesscustomer/load/shoppingcart` with a `shoppingCartKey` we supply. `entries: 1` means
  RC holds something under that key; it says **nothing** about whether RC's own SPA — which
  reads `localStorage["shoppingCartKey"]` to decide which cart it is showing — knows the cart
  exists. The readout called it *"stronger still: RC's own answer, not our status string"*.
  Half right, and the wrong half is load-bearing.
- **THE COST IS THE WORST SHAPE THIS PRODUCT HAS.** A site is locked, and the user is told it
  is theirs. That is strictly worse than failing: it takes the campsite off the market AND
  makes them stop watching — the rule every claim-screen decision has been governed by since
  2026-08-09.
- **AND iOS IS NOT THE WORKING CONTROL IT LOOKS LIKE.** Reading the two iOS runs against each
  other is what makes this a finding rather than an Android bug:

  | | evidence | human looked at RC's cart page? |
  |---|---|---|
  | 08-13 iOS | `✓ Added to cart` only — **the read-back did not exist yet** | **YES** — exact unit and dates confirmed |
  | 08-24 iOS | `✓ Added to cart` + `cart read back: 1 entry` | **no** |
  | 08-29 Android | `✓ Added to cart` + `cart read back: 1 entry` | **yes — and it was NOT there** |

  ~~**So `cart read back` has never once been corroborated by a human, on any platform.**~~
  **TRUE UNTIL 2026-09-02, WHEN AN ANDROID HAND-OFF WAS CONFIRMED ON RC'S OWN CART PAGE** —
  header, badge and reservation — after #249/#250. Struck rather than deleted: read as
  current it says the instrument has never been validated, and it has. The
  only visually-confirmed run predates the instrument *and* predates the code path: the cart
  navigation and the read-back both arrived on 2026-08-23 (#171), and 08-13's status line was
  *"review & check out on ReserveCalifornia"* with no navigation at all. **08-24 has exactly
  today's evidence and was written up as "the whole verification".** It may have had this same
  defect and nobody would know.
- **THE CAUSE IS NOT ESTABLISHED — do not write one in.** Candidates, none tested: the cart is
  free-floating with `CustomerId: 0` and RC's page refuses to show an unattached cart to a
  signed-in user; or the SPA holds its cart in memory from page load and our `localStorage`
  write lands too late for it. **Ruled out by reading the code, not guessed:** the write DID
  have a key to write — `cart-verified` fell back to `mark.cartKey` only if localStorage were
  empty, and a run with neither would have reported `cart-unverified`.
- **WHAT SHIPPED IS AN INSTRUMENT AND HONEST COPY, NOT A CURE.** Every candidate fix is
  unverified and the known-dead list here is long — cross-session cart adoption fails
  (2026-08-06), `?shoppingCartKey=` in the URL does nothing, `empty/shoppingcart` is forbidden.
  Guessing at the mechanism is how a repair gets credited to the wrong one, which has happened
  three times.
  1. **`cart-verified` now reports `keySource` and `attached`**, both from data already in hand
     and neither costing a request. `keySource: 'marker'` means localStorage did NOT have the
     key, i.e. RC's page cannot see the cart. `attached: false` means `CustomerId: 0`.
     **`attached` is a BOOLEAN, never the id** — a customer id is not a credential, but the
     standing rule is not to collect a value you would then have to filter. **`null` is "RC did
     not tell us", never `false`.**
  2. **The banner stops claiming the page shows it.** `✓ Added to cart` STAYS — `client_reports`
     is read for it and `ClaimFlow` matches on it — but *"this is your cart. Check the dates and
     check out"* was an assertion **about the page** and it has been observed false. Both call
     sites changed; fixing one would leave the other telling the old story on every reload.
  3. **The readout says what the line does and does not establish**, and names the only proof of
     reachability there is: a human looking at RC's cart page.
- **THE NEXT HAND-OFF ANSWERS IT BY ITSELF**, which is why no cure was guessed at. Web-side —
  `/api/rc-precart` serves the bundle, so it reaches installed apps on a push, no rebuild.
- `worker/rc-precart-cart-key.test.mts`, four new guards, four mutations each verified to APPLY
  and to fail: `keySource` hardcoded to `localStorage`, `attached` coerced to `false` when RC
  said nothing, the banner claim restored, and `keySource` dropped from the report.
  **TWO OF THE FOUR WERE WRONG WHEN FIRST WRITTEN AND WOULD HAVE PASSED VACUOUSLY** — `makePage`
  leaves `localStorage` empty unless `storedCartKey` is passed, so the "came from localStorage"
  and "came from the marker" tests staged the IDENTICAL state and both went green measuring
  nothing. Caught by reading the fixture rather than the assertion.

### A CAMPSITE WAS LOST TO A TWO-SECOND MARGIN, AND THE FIXES FOR IT CAUSED TWO MORE (2026-08-30)
Four defects in one day, all on the path between a queued hold and a cart, **and two were
created by the fixes shipped earlier the same day.** Merged as #230, #234, #235; box `65f5583`.

**1. THE COVERAGE CHECK ROUNDED, AND A TWO-SECOND DEFICIT READ AS COVERED.** `minutesUntil`
returned `Math.round(...)`, so the requirement was a SIXTY-SECOND STAIRCASE against a token
that decays continuously. From the box's own two lines:

    07:29:44  "the token covers this hold (50m left, needs 50m)"   <- left in (3000, 3030]s
    07:51:58  "the session will not cover it — signing in"          <- left <= 1680s

which brackets the expiry at 08:19:44–08:19:58 against a requirement of 08:20:00. **Two to
sixteen seconds short**, called covered twenty-two times across twenty-one minutes — the whole
safe window — then correctly refused at T−8, when signing in is the worst move available. The
Okta navigation ran into the release and the site went to somebody else. `tokenSecondsNeeded`
takes SECONDS and was RENAMED for it: passing minutes to a seconds parameter under-requires by
sixty and stands the login down silently.

**2. A CRASH AND A BAIL WERE THE SAME EXIT CODE.** `process.exit(1)` appears once, in the
watchdog's `bail()` — and Node exits 1 on an unhandled throw with **no handler registered
anywhere in that process**. Neither arm could have fired (RUNAWAY needs free RAM under 2000 MB
and the box had **4,768**; WEDGED needs 720s against 526s). Handlers now name it and **release
the profile lock**, which a crash never did: an unhandled throw held it for `STALE_MS` with
nothing alive to renew, so a crash at 07:53 keeps the runner off the profile past 08:00.

**3. A QUEUED HOLD DESTROYED ITS OWN SESSION.** Measured twice:

    18:08:26  kept warm — token exp in 46m
    18:08:52  -> hold runner wants the profile — closing and standing down
    18:09:36  RC loaded and STAYING OPEN — token source: none

`readLiveToken` prefers `window.__camphawkRcToken`, the capture hook's copy off RC's own
outbound header, which lives in PAGE MEMORY and dies with the browser. `persistLiveToken`
writes it to `localStorage`, **awaited, immediately before the yield**, because the close is
what destroys it. The shape is not guessed: `readLiveToken` returns
`localStorage.getItem('ssoAccessToken')` DIRECTLY as the token, so the key holds a bare JWT. It
only ever ADDS; a token already stored is left alone, because RC's own SDK owns those keys.

**4. THE AUTO-LOGIN IS A DESTRUCTIVE REPAIR, AND THE HEADROOM MADE IT FIRE ON A HEALTHY
SESSION.** Self-inflicted by fix 1's companion change (margin 5 → 15):

    18:52:39  kept warm — token exp in 30m
    18:54:38  hold releases in 2m and the session will not cover it — signing in
    18:54:43      -> signed in, but the token will not cover the hold — dropping it
    18:56:31  RC loaded and STAYING OPEN — token source: none

`attemptLogin` **drops the stored token** before hunting for a sign-in form — it must, because
RC's SPA renders signed-in while a token is present. So the repair destroys what it repairs.
That 30-minute token was **adequate** — it outlived the release plus the whole cart hold — and
short only of the MARGIN. **The reasoning error was mine and it is specific: an extra sign-in
was argued to cost ~400 MB and eleven seconds. It also costs the token you already hold.** The
margin is NOT reverted; inside `AUTOLOGIN_RETRY_GAP_MS + 2m` of the release, only a genuinely
INADEQUATE token justifies the destruction.

**AND `nextHoldRelease` WENT BLIND THE INSTANT A RELEASE PASSED.** It required
`release_at >= NOW()` while `dueHolds` keeps serving the same hold for `HOLD_GRACE_MIN`. So for
the whole 20-minute retry window the bot was told there was no hold, and `maybeAutoLogin` — the
only thing that types a password — stood down with `no hold is queued` while the runner was
still trying to cart. **THE TELL:** `maybeAutoLogin` already carried
`if (mins < -20) … 'past the retry window'`, written for exactly that case and **unreachable**,
because `release` was always null. The grace was the literal 20 in three places; it is
`HOLD_GRACE_MIN` now.

- **THE STAND-OFF WAS SHORTER THAN THE REPAIR IT WAITS FOR** — corrected in the 2026-08-15
  death-spiral entry. Sized on the renewal FLOOR, which assumes success; a failed renewal
  retries at the GAP. Measured: failed 18:11:51, stood down 18:17:20, retried **18:22:22**.
- **THE EXISTING GUARD PINNED THE BUG.** `session-coverage.test.mts` asserted
  `ms <= 5 * 60_000` — exactly `RENEW_FLOOR_MS` — requiring the stand-off to be no longer than
  the cadence it must outlast, so the fix could not be made without it going red.
- **THE SESSION REPAIRS ITSELF ONCE THE HOLD IS REMOVED — three times, ~5-10 min**, unattended,
  no password. That is the evidence the churn is the cause, not RC.
- **CI FAILED ONCE AND IT WAS THE LANES RULE.** The side lane merged #236 at 19:17:02, starting
  a master `npm test` on the production DB, overlapping this PR's 19:19:35–19:24:09 run. The
  identical merged tree passes **1482/1482** locally, CI's exact count. **`ListAgents` shows
  only sessions on THIS machine** — an empty list is not exclusive use of the database.
- **`git checkout` DESTROYED UNCOMMITTED WORK THREE TIMES IN ONE DAY** — twice reverting a
  mutation (`git checkout -- <file>` goes to HEAD, i.e. the fix's absence) and once moving
  content between branches (`git checkout <branch> -- <file>` overwrites the working copy).
  **Commit before mutating; revert a mutation by EDIT.**

#### `keySource` ANSWERED IT AND THE LEADING THEORY IS DEAD (2026-08-30)
The instrument built above did its job on the first hand-off that reached it, and it **refutes
the explanation this entry was written around.** Android, build 1.0 (25), unit 43832:

```
injected       {"job":true,"href":".../Customers/ShoppingCart"}
banner         "✓ Added to cart — check the dates and check out…"
token          {"captured":true,"length":939,"decodable":true,"expiresInSec":3534}
cart-verified  {"status":200,"entries":1,"attached":null,"keySource":"localStorage"}
```
and the owner, looking at RC on that phone, got **"Please login or create account to continue
booking"** on RC's home page.

- **`keySource: "localStorage"` KILLS THE CART-KEY THEORY.** The entry above says
  `keySource: 'marker'` would mean "RC's page cannot see the cart", and that was the leading
  candidate for the empty cart. It read **localStorage** — the key was exactly where RC's own
  SPA looks — and the page still refused. **Stop citing the cart key as the cause.**
- **NOR IS IT A MISSING SESSION.** The same run captured a live 939-character token with
  **3,534 seconds left**, decodable, and `storedToken: "jwt"` in the app's own store.
- **SO THE NARROW STATEMENT IS: RC hands back `entries: 1` for our key while its UI treats the
  session as signed out.** RC's login state therefore lives somewhere OTHER than the token we
  capture, and completing Okta's flow does not populate it. Consistent with the 2026-08-06
  session-bound-cart finding, except it is the LOGIN that is not transferring, not the cart.
- **NO MECHANISM IS NAMED HERE ON PURPOSE.** Three mechanisms were guessed on 2026-08-30 and
  each cost a test. What would settle it is the census that already exists on the bot
  (`storage-census.mjs`) and not in the app: key NAMES and cookie NAMES on RC's origin after an
  in-app sign-in, never values, against what a normal RC login leaves behind. That turns "the
  login did not take" into "this key is missing". **NOT BUILT.**
- **AND "WHAT IS DIFFERENT ON ANDROID?" HAS AN ANSWER FROM THE SOURCE: NOTHING IN THE CART OR
  LOGIN PATH.** Asked to compare the platforms, the honest reading is that our code does not
  branch on one. `rc-precart-script.ts` and `rc-login-script.ts` contain **no functional
  platform branch at all** — the only platform-aware line in either is the report TRANSPORT
  (prefer the raw `cordova_iab` global, fall back to `window.webkit.messageHandlers.cordova_iab`
  on iOS), which is diagnostics and cannot affect a cart. The only other differences are two
  `openRcHandoff` open flags, both cosmetic: `hardwareback=no` (Android's back button walks RC's
  history) and `presentationstyle=fullscreen` (iOS only; Android ignores it, its InAppBrowser is
  already full-height). **So a platform-specific bug would have to live in RC or in the webview,
  not in anything we wrote.**
- **THE ONE REAL PLATFORM DIFFERENCE POINTS THE WRONG WAY, WHICH IS WHY IT IS NOT THE ANSWER.**
  Android's `CookieManager` is **process-wide** and the InAppBrowser shares it with the app's
  main WebView; iOS's WKWebView has its own `WKWebsiteDataStore` and its own ITP rules. That
  predicts Android sessions being MORE durable than iOS ones, not less — and it is why the
  08-09 persistence tests were repeated on iOS rather than inferred from Android. **Reaching
  for it to explain an Android-only symptom is reasoning backwards.**
- **AND THE PREMISE OF THE COMPARISON IS ITSELF RETIRED: iOS WAS NEVER SHOWN TO WORK.** "iOS
  worked, so compare" rests on `cart read back: 1 entry` from 08-24 — the same line Android
  produced on 08-29 and 08-30 over a cart the owner could not open. **No iOS run with that
  instrument attached has ever been corroborated by a human looking at RC's cart page**, so it
  may carry this identical defect and nobody would know. The comparison has no working control
  on either side; only the app-side census would produce one.
  **STILL TRUE OF iOS ON 2026-09-02, AND NO LONGER TRUE OF ANDROID** — the Android side now has
  the corroborated run this paragraph says neither had. iOS is the one still resting on an
  unverified `cart read back`, and its binary is three weeks older; a fresh iOS build and one
  corroborated iOS hand-off is what would finally give this comparison two working ends.

#### THE FULL 80-REPORT TRACE, READ 2026-08-31 — the sign-in WORKS and the probe is blind
The whole `client_reports` sequence for hold `TEST · 43832` was pulled and read in order. It
moves this from "no mechanism named" to **one named, testable hypothesis**, and it does it by
eliminating the two things everyone assumes first.
```
submitted   {}
injected    href=.../login/callback   session {opens:32, storedToken:"none"}
signin-open {}
injected    href=.../login/callback   session {opens:33, storedToken:"jwt", storedExpiresInSec:3598}
token       {captured:true, length:939, decodable:true, expiresInSec:3598}
closed      {}                                   <- we close ~2s after the token appears
injected    href=.../park/690/612      session {opens:34, storedToken:"jwt", ...:3536}
   [ two cart POSTs ] log "precart load ok — cart key in hand"
status      "✓ Added to cart"
injected    href=.../Customers/ShoppingCart  session {opens:35, storedToken:"jwt", ...:3534}
cart-verified {"status":200,"entries":1,"attached":null,"keySource":"localStorage"}
```
- **RC'S OWN SPA COMPLETED ITS HALF OF THE LOGIN.** `storedToken` goes `none` → `jwt` with a
  full 3,598s across ONE second on the callback page. **We did not write that** — the app-side
  bundle never writes a token; `persistLiveToken` is the BOT. So RC's app minted and stored its
  own copy. "The sign-in did not take" is eliminated.
- **AND RC'S SPA IS AUTHENTICATING ITS OWN TRAFFIC THROUGHOUT.** `rc-inject.js` rebroadcasts on
  every RC API call carrying an `accesstoken` header, and the trace collapses
  `repeated {"of":"token","times":34}` then `29` — **sixty-plus authenticated calls**, against
  the two our precart makes. The SPA has the token and is using it. "There is no session" is
  eliminated, from a second direction and more strongly than the token facts alone.
- **SO THE NARROW STATEMENT SHARPENS: RC's app is making authenticated calls with a live token
  while its own UI renders signed out.** Those are not the same state, and something decides the
  second one that we have never looked at.
- **THE HYPOTHESIS — LABELLED AS ONE, because three mechanisms were guessed on 08-30 and each
  cost a test.** `sessionProbe` reads exactly two keys, `ssoAccessToken` and `accessToken`
  (`rc-precart-script.ts`, the `var stored = get("ssoAccessToken") || get("accessToken")` line).
  **Those are RC's OWN copies.** This file's 2026-08-15 entry already establishes that
  **okta-auth-js namespaces its own store under `okta-` and that is what it decides from on
  boot** — which is exactly why `dropStoredToken` had to be widened past those two keys, and
  why the two-key clear "never asked RC anything". So **`storedToken: "jwt"` reports RC's copy
  and says NOTHING about the store that drives the header name and the cart page's login
  prompt.** Every reading taken so far is blind to the one that matters.
- **THE SUSPECT IF THAT HOLDS IS `closeOnToken`.** We close the sign-in webview the instant the
  token is captured — two seconds, per the trace — and okta-auth-js's `parseFromUrl()` →
  `tokenManager.setTokens()` may not have finished. That would leave RC's own copy written and
  the SDK's store empty, which is precisely the split above. **Not established**; the instrument
  below is what would establish it. Note `closeOnToken` was itself a fix for a real bug (the
  08-12 "stranded when it WORKED"), so it is not to be simply removed.
- **THE OTHER BRANCH IS THE FREE-FLOATING CART.** `attached: null` means RC does not return
  `CustomerId` on `load/shoppingcart`, so that field **cannot discriminate and needs replacing
  with something that can**. The cart is minted with `NO_CART` and the 2026-08-06 finding is
  that it carries `CustomerId: 0`. If the SDK store turns out to be populated, this is where the
  investigation goes instead — and it is a different fix entirely.
- **THE TRACE HIT THE 80-REPORT CAP AND THE MIDDLE WAS DROPPED**, which the readout says out
  loud. ~~The token rebroadcast ate ~63 of 80 slots **after** the consecutive-duplicate
  collapse, because `token` and `cartkey` alternate and only consecutive repeats collapse.~~
  **BOTH HALVES OF THAT ARE FALSE, MEASURED AGAINST THE ROW ITSELF (2026-08-31).** Struck
  rather than deleted: it would send the next reader to re-fix a collapse that works, and it
  names a mechanism that was repaired on 2026-08-13.
  - **The collapse is NOT consecutive-only.** `NOISY = { token, cartkey }` are deduped against
    everything already sent in the document, not against the previous line — that is exactly
    the 08-13 fix, and the entry above quotes its own evidence of it working
    (`repeated {of: token, times: 34}`).
  - **`token` occupies SIX of the eighty slots on hold 43832, not sixty-three.** Counted:
    `repeated:14 injected:11 session:11 idle:10 reinjected:9 token:6 banner:5 …`, with
    `tokenx34`, `tokenx29`, `tokenx13`, `tokenx2` and `tokenx1` all folded. The rebroadcast is
    the one thing that is NOT eating the trace.
  - **WHAT FILLS IT IS NAVIGATION COUNT.** `injected:11` and `session:11` — the bundle
    re-injects on every `loadstop` and a sign-in walks across eleven documents, each costing
    an `injected`, a `session`, a `reinjected` and a first-sighting `token`. **The reporter's
    re-install guard is `window.__camphawkRc`, which is per-DOCUMENT**, so a real navigation
    takes the whole dedup table with it and the next page starts counting again. Candidate,
    not established: nobody has instrumented which of the eleven are RC's own SPA transitions
    and which are true navigations.
  - **IT IS NOT CURRENTLY EATING ANYTHING THAT MATTERS**, which is why this is a note and not
    a fix. The trim keeps **head 20 + tail 60** (`CLIENT_REPORT_HEAD`/`_TAIL`), not the tail of
    40 the 08-20 entry describes — so `platform` (n:0) and the first `session` (n:2) survive at
    the front, and `close`, `cart-verified` and the outcome survive at the back. Only the
    middle goes. **Checked before relying on it, because putting an instrument at the head of
    a tail-only trim is exactly what made `notePlatform` invisible for weeks.**

#### BISECTED BY HAND, AND IT IS THE CLOSE TIMING — `/login/callback` (2026-08-31)
The owner ran the ADMIN probe, which calls `openRcHandoff` with **no `closeOnToken`**, so its
window stays open. That one difference is the whole experiment.
```
attempt 1   froze during loading — had to force-close the app
attempt 2   RC's "trouble loading the application" screen
attempt 3   (~5 min later) RC rendered — NOT signed in
   signed in by hand, staying on the page:
      -> TYLER in the header, account menu with LOGOUT
      -> cart page reachable · Your Reservations reachable
   pressed Done, reopened it:
      -> NAME STILL THERE
```
- **SO A CLOSE AND A REOPEN ARE INNOCENT.** The UI-visible session survives both. That was
  genuinely not certain: it was equally possible the webview could never hold one, in which
  case the entire in-app design was wrong. It can.
- **THE ONLY VARIABLE LEFT IS *WHEN* WE CLOSE, AND THE TRACE SAYS WHERE WE WERE:**
  ```
  injected  href=.../login/callback     <- Okta has redirected back; RC's SPA is booting
  token     {"ageSec":2, "expiresInSec":3598}
  closed    {}                          <- we destroy the webview, 2s in
  ```
  `/login/callback` is where RC completes the OAuth exchange and bootstraps its customer
  session. **We were killing the webview in the middle of it** — which is why the token was
  real and the *page* was not: RC's SPA had a token and never finished becoming signed in.
- **THE DOUBT, STATED SO NOBODY RE-DISCOVERS IT.** The manual sign-in was also HAND-TYPED
  rather than script-driven. That is not thought to matter — the scripted sign-in produced a
  genuine 939-char token and RC's SPA persisted its own copy a second later — but it is **not
  eliminated.** If a hand-off still fails while reporting `close {reason:'settled'}`, this was
  the wrong half and the fill is the next suspect.
- **FIXED: the close is DEFERRED while RC is still in the flow** (`isMidSignIn` +
  `rcCloseAction` in `src/lib/rc-token-liveness.ts`). A live token off the callback still
  closes at once — the already-signed-in path, i.e. 2026-08-12's stranded-when-it-worked case,
  is unchanged. On the callback it arms a **bounded** settle timer and closes when RC leaves
  the flow under its own steam.
  - **THE TIMEOUT IS NOT OPTIONAL.** "Wait for RC to finish" unbounded is 08-12 by another
    door: a callback that never resolves strands the user on a page with no way back.
  - **THE MATCH IS DELIBERATELY NARROW** — Okta's host and `/login/callback` only. Waiting on
    anything unrecognised would make EVERY already-signed-in hand-off sit through the timeout,
    trading a bug for every user against a rare one. **The cost of narrow, named:** if RC moves
    its callback path this silently stops matching and the bug returns with nothing red.
  - **EVERY CLOSE NAMES ITS REASON** — `token` (ordinary), `settled` (RC finished; the fix
    working), `timeout` (RC never finished). Without it, *a fix that never fired* and *a fix
    that worked* produce the identical report, which is the shape this file keeps recording.
  - **THE DECISION IS A PURE FUNCTION, for the reason `claim.ts` and `hold-line.ts` were.** It
    lived inline in an InAppBrowser `message` handler, reachable only from a native webview —
    which is how `closeOnToken` shipped in #126 with nothing testing it, stayed wrong until
    08-24, and carried this bug from #126 to 08-31.
  - `worker/rc-signin-close.test.mts`, **12 mutations, each verified to APPLY and to fail** —
    including the caller reverting to its inline test, which is the fix-present-and-inert shape
    a guard on the pure function alone would sail past.
- **A SEPARATE RISK, RECORDED BECAUSE IT KEEPS READING AS BACKGROUND NOISE:** RC's app took
  **three attempts and ~5 minutes** to render, including its own "trouble loading" screen. The
  same thing happened mid-test on 08-30. **At 08:00 that loses the site on its own**, whatever
  we fix about login state, and nothing in this repo measures it.

##### TESTING IT NEEDED A LOCKED CAMPSITE, AND NOW IT DOES NOT (2026-08-31)
The fix above is live and web-side, and the only way to reach it was a live 8am hold — which
means locking a real campsite, blocking `npm test`, the box's updates and the 02:00-05:00
window, and waiting. **The instrument that removes all of that already existed and was one
argument short.** The admin probe opens RC through the same `openRcHandoff` seam with **no
hold**; it simply never passed `closeOnToken`, which is the entire variable.
- **TWO BUTTONS NOW, DIFFERING IN EXACTLY THAT.** The historic one is **kept as the CONTROL** —
  its window stays open, and that is precisely what let the 08-31 bisect sign in by hand and go
  looking at RC's header, cart and Your Reservations. **Do not unify them.** The finding came
  from the difference, and a comparison with no control is how a repair gets credited to the
  wrong mechanism, which has happened three times here.
- **`onClick={run}` WOULD HAVE MADE THE CONTROL RUN THE VARIANT.** React hands the synthetic
  MouseEvent to the first parameter and it is truthy, so both buttons would have been one probe
  wearing two labels — a broken experiment reporting as a working one. Arrow wrappers, pinned.
- **THE `close` REASON IS AMBIGUOUS IN ONE DIRECTION AND THE STAGES SETTLE IT.** `settled` is
  RC leaving the callback under its own steam (the fix working) and `timeout` is the backstop.
  **`token` means two different things**: with no `signin-open`/`email`/`password` before it,
  the user was already signed in and an immediate close is the correct unchanged path; after a
  real sign-in it means `isMidSignIn` has stopped matching, RC has moved its callback path, and
  the 08-31 bug is back **with nothing else red**. The readout prints that gloss rather than
  leaving the next reader to derive it, and marks the second case.
- **AND THE PROBE MUST BE RUN FROM A SIGNED-OUT WEBVIEW OR IT MEASURES NOTHING** — a live
  session closes on the home page, never reaches the callback, and reports `token` for the
  innocent reason. Said on the panel, because a run that cannot exercise the deferral is
  indistinguishable from one that did and passed.

##### THE PROBE WAS BLIND TO THE STORE THAT DECIDES (2026-08-31)
`sessionProbe` read `ssoAccessToken` and `accessToken` — **RC's OWN copies**. okta-auth-js keeps
its own under `okta-` and decides login state from THAT on boot, which is exactly why
`dropStoredToken` had to be widened past those two keys on 2026-08-15 after a clear that touched
only them "never asked RC anything". **So every reading this probe has ever taken was blind to
the one store that drives the header name and the cart page's login prompt** — and that is why
`storedToken: "jwt"` with 3,534 seconds on it and *"Please login or create account"* could both
be true on 08-30 without either being wrong.
- **NAMES, COUNT AND SHAPE. NEVER A VALUE.** Every value there is or contains the session, and
  this repo has published a credential twice by collecting a field it then had to filter — an
  OAuth code on 08-09, a password on 08-16. The token is matched against and measured; it is
  never carried. Guarded against the WHOLE wire payload, not the fields somebody remembered.
- **A NON-TOKEN ENTRY REPORTS `none`, NOT `opaque`, AND THAT IS THE 08-15 FINDING ENCODED.**
  That sweep found exactly one `okta-` key and it was `okta-original-uri-storage`, a redirect
  breadcrumb. "One key" and "a session" are different readings, so the count and the shape are
  printed together and `opaque` is reserved for something genuinely JWT-shaped that will not
  decode. The first version called the breadcrumb `opaque` and was caught by running it.
- **PRESENCE IS NOT LIVENESS, restated one store along.** An `okta-` entry holding a token that
  died yesterday is a different finding from a live one, so the expiry rides beside the shape.
- **THE CAPS WOULD HAVE EATEN IT IN SILENCE.** Object key order is insertion order, so the four
  `okta*` fields sit at the END of an 11-field `session` detail — and the report routes capped
  at **8** (hold path) and **10** (admin path). They were exactly what got dropped, and the
  instrument would have reported nothing while looking like it had run. Both are 12 now, and
  **the guard DERIVES the required width from what the probe actually sends**, so the next field
  added fails there rather than disappearing in production.
- **THE READING IS SCOPED TO AN ORIGIN AND TO THE END OF THE RUN, and both were got wrong on
  the first pass — caught by querying the real rows rather than reasoning about them.** Hold
  43832 stored **eleven** `session` reports, from BOTH `www.reservecalifornia.com` and
  `signin.reservecalifornia.com`. `localStorage` is per-origin, so a census taken on the signin
  origin describes storage RC's SPA never reads: scoring it would report *"the SDK store is
  empty"* about the wrong store — **a false confirmation of the leading hypothesis, which is
  the most expensive kind of wrong.** The census reports its origin now.
  - And it took the FIRST report, which is the park page **before anyone signs in**, where an
    empty okta store is the correct and uninteresting answer — so it would have flagged the bug
    on every healthy hand-off. The question is what the store holds AFTER. Same first-not-last
    mistake that cost a diagnosis on 2026-08-29, **in the same block of the same file**, which
    is why `cart-verified` two lines above already carries the `findLast` fix for it.
- **HOW TO READ IT:** `okta-` holding no live token beside a live `ssoAccessToken` means the SDK
  never finished its half and the fix is in the sign-in completion. `okta-` populated means the
  SPA has everything and the problem is the **free-floating cart** (`CustomerId: 0`, 08-06) —
  a different investigation. Note `attached` reads `null` because RC does not return
  `CustomerId` on `load/shoppingcart`, so **that field cannot discriminate and still needs
  replacing with something that can.**
- **THE READOUT'S GLOSS IS A PURE FUNCTION** (`closeReasonReading`), for the reason `claim.ts`,
  `hold-line.ts` and `held-cadence.ts` were: inline in `rc-holds-readout.mts`, the branch that
  says *the bug is back* cannot be reached without a real hand-off in the database, so the one
  branch that matters would have shipped having never once run. The signed-in flag is passed
  IN, from the stages — deriving it from the reason would make the discriminator circular and
  that branch unreachable.
  - **`timeout` stays `info`.** It is a real finding and not a regression, and dressing the
    backstop as red is the cry-wolf failure this file has fixed three times.
  - **An unrecognised reason is reported as itself.** A bundle older than #240 sends none at
    all and a later one may send a fourth; folding it into a known verdict is how an absent
    reading becomes a negative.
- `src/lib/rc-signin-probe.test.mts`, **fourteen mutations, each verified to APPLY and to
  fail** — including the value reported, the breadcrumb called `opaque`, the expiry dropped,
  the flag taken but never passed on, either cap put back, the regression downgraded to
  `info`, `timeout` promoted to a warning, and the readout keeping its own copy of the gloss.
  - **ONE "SURVIVED" AND IT WAS THE MUTATION, NOT THE GUARD.** The unrecognised-reason test
    passed against a mutation that injected `isMitSignIn` where the assertion looks for
    `isMidSignIn` — a typo in the mutation string, so the intended change never applied and
    the green proved nothing. Redone with the regression wording verbatim and caught. **The
    mutation harness now asserts the file actually CHANGED**, not merely that the anchor
    matched; an anchor can match and the replacement be a no-op.
- **THE GUARDS ARE UNDER `src/`, NOT `worker/`, DELIBERATELY.** `npm test` globs both, but
  `worker/**` is the FIRST entry in `worker-deploy.yml`'s `paths:`, so a guard over two web
  modules would restart both poller machines. Checked against the workflow rather than
  remembered — this file records getting that claim wrong twice.

#### AND THE SAME RUN PROVED THREE ANDROID FIRSTS (2026-08-30)
Struck from the open-questions list, because each had never been observed on Android:
- **THE IN-APP RC SIGN-IN WORKS.** `signin-missing {candidates:6}` → `email` → `password` →
  `submitted` → `/login/callback` → a 939-char token, the identical shape iOS produced on
  2026-08-09. Every previous Android attempt died before this.
- **THE TWO RC CART POSTS FIRE AND RC ACCEPTS THEM FROM ANDROID** — `job:true` and
  `✓ Added to cart`. Previously proven on iOS only (2026-08-13).
- **THE WHOLE CHAIN RUNS**: bot carts (T+11s) → user claims → bot releases → the user's own
  session re-carts. Bot side is clean: carted 19:51:10Z, released 20:11:24Z.
- **AND THE SITE IS NOW LOCKED IN A CART WE CANNOT RELEASE**, exactly as on 08-29: the phone
  minted its own key and `cartkey {"captured":true}` records THAT it existed and never its
  value, deliberately. It lapses on RC's own schedule — both 08-29 sites were bookable again
  within a day.
- **RC ITSELF WAS DEGRADED FOR ~20 MINUTES MID-TEST** ("We're having trouble loading the
  application", on the phone AND a PC) while `www.reservecalifornia.com` answered **200 in
  0.39s** from here. A healthy edge over a broken app tier: worth knowing, because the 08:00
  path talks to their API and never loads the SPA.

### THE RETEST CARTED NOTHING AND SAID IT HAD — THE MARKER COULD NOT NAME ITS SITE (2026-08-29)
A second Android hand-off an hour after the first, on a different park, reported
`✓ Added to cart` for a site it never touched. Three separate defects, and the retest was
worthless because of the first.
```
cart-verified {"entries":1,"attached":null,"keySource":"localStorage"}
session       {"opens":20,"firstOpenAgoSec":3553,"storedExpiresInSec":116}
log           "precart load ok — cart key in hand"
status        "RC declined (200) — cart is already added"
```
- **`alreadyCarted()` WAS `!!sessionStorage.getItem(DONE)` — IT ASKED WHETHER *ANYTHING* HAD
  BEEN CARTED IN THIS WEBVIEW.** The session was 59 minutes and 20 opens old and still held
  the FIRST hand-off's marker, so the bundle short-circuited and announced success for unit
  4756 on the strength of having carted 43793. **A success message over an uncarted site is
  the worst output this screen has** — the user stops watching a site nobody is holding.
  Scoped on `unitId` now, plus a clear at the source when a new claim link arrives.
  - **A MARKER THAT CANNOT NAME ITS UNIT ACTS RATHER THAN SUPPRESSING.** That is one written
    by an older bundle, and the directions are not symmetric: wrongly "carted" claims a site
    we do not hold; wrongly "not carted" re-submits, RC answers "cart is already added", and
    the cost is the checkout affordance on a cart that is genuinely ours. Same rule as
    `unknown` never rounding to a verdict that suppresses action.
- **THE TOKEN HAD ~2 MINUTES LEFT** (`storedExpiresInSec` 134 → 116 across the flow) and the
  precart was refused. `rcHandoffStep` checked that a token EXISTED, never that it would
  still be alive when the cart fired — **presence is not liveness, restated for the claim
  screen**, and the ordering is what makes it expensive: the failure lands AFTER the bot has
  released, so the site returns to the open market with nobody holding it. The gate now takes
  the remaining life (`MIN_TOKEN_SECONDS_FOR_HANDOFF`, 90s) and sends the user to sign in
  FIRST. **An unknown expiry behaves exactly as before** — a client that reports none must not
  start being bounced, which is the `unconfirmed`-proceeds rule.
  - **A DEADLINE, NOT THE REPORTED SECONDS.** `expiresInSec` is a snapshot from when the
    report was written and the user may sit on the screen for minutes; the gate asks how long
    is left NOW.
- **THE READOUT WAS READING THE OLDEST REPORT.** The bundle re-injects on every navigation, so
  one hand-off writes several `cart-verified` rows; `find` returned the first, written by
  whatever bundle the webview had cached. **So the run that finally carried `keySource` was
  reported as not carrying it, and the instrument built that morning was written off as
  undeployed.** `findLast` is the whole fix.
- **AND THE DEPLOY HAD NOT LANDED WHEN THE TEST RAN.** I merged #221 and queued the retest
  without confirming Vercel had shipped it — so the first half of the run used the old bundle.
  `curl -sI camphawk.app/api/rc-precart` (max-age 300) is the check, and it takes one command.
- **WHAT THE NEW FIELDS DID SAY, on the first hand-off's cart: `keySource: localStorage` and
  `attached: null`.** So RC's own SPA *did* have the key — which **weakens** the leading
  "the page cannot see it" theory — and RC does not return `CustomerId` on that endpoint, so
  `attached` cannot discriminate and needs replacing with something that can. **The
  reachability cause is still not established.**
- **SEVEN MUTATIONS, and the two that mattered SURVIVED the first round.** The marker tests
  staged a fresh fragment, so `readFragment`'s clear removed the stale marker before
  `alreadyCarted` was ever consulted — the scoping check could be deleted outright and both
  still passed. Re-done with no fragment and the job supplied through the stash, which is the
  path a reload or a re-injection actually takes. **A third guard, on the clear itself, then
  survived twice more**: asserting it through its EFFECT cannot work, because the unit check
  produces the same outcome and a successful cart overwrites the marker anyway. It needs a
  DECLINED submit, so nothing is written and what remains is exactly what the clear did.
- **AND A NEIGHBOURING GUARD FAILED OVER A COMMENT.** `rc-login-script.test.mts` bounded
  "a captured token clears the captcha prompt" with a **500-character window**, which a new
  comment pushed past — the `rehearsal.test.mts` proximity-window shape again. Re-anchoring
  took three attempts, each verified by mutation: stripping comments was not enough, and
  bounding on the next `setRcCheck(` still reached into the `login-result` handler below,
  which has its own `setLoginStage(null)`. Bounded on the branch's own closing brace.
  **A window measured in characters is a guess about layout.**

### A REAL CAMPSITE IS LOCKED AND WE CANNOT RELEASE IT (2026-08-29)
The cost of the run above, recorded rather than tidied away. Pfeiffer Big Sur, Weyland Camp
**#W079 (unit 43793), arrival 2026-12-01** — the bot carted at T+2s, released cleanly at
19:32:18Z, and the phone's own session re-carted it into a cart the owner cannot open.
- **NOTHING WE HAVE CAN LET GO OF IT.** The hold row's `cart_key` is the BOT's, already
  released. The phone minted its own, and `cartkey {"captured":true}` records **that a key
  existed, never its value** — deliberately, and correctly. So there is no key to send a
  `remove/cartentry` with.
- It lapses when RC drops the cart. **That number is still unmeasured**: our own
  `expireStaleHolds(45)` removed one at exactly 45 minutes on 08-25, which bounds it from
  BELOW only. `rc-probe.mjs --cart-lapse` exists to measure it and has still never been run.
- **Harm is small and that is luck, not design** — a December midweek night with 38 other sites
  free. A test on a popular site would have taken one somebody wanted.
- **THE RULE THIS EARNS: a hand-off test is not over when the readout says it worked.** Ask for
  the cart page. Until 08-29 nobody had, on any run with the instrument attached.

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
- ~~**RECORDED, NOT FIXED.**~~ **FIXED 2026-08-27 (PR #202), by the second of the two named
  remedies.** `holdsAhead(withinMinutes?)` and `holdsDueWithin(minutes)` in `src/lib/rc-holds.ts`
  carry `REAL_UNIT` in their own bodies and replace all five inline counts, so there is ONE
  definition rather than three copies of the same question. **No severity or threshold changed** —
  it only stops fixtures being counted. A sixth count was found computed and discarded
  (`Promise.all` had three entries, the destructuring took two) and removed.
  `worker/health-hold-counts.test.mts` is real-DB for the predicate and structural for the route,
  because the danger is a SIXTH copy appearing and no behavioural test can see one that has not
  been written yet.

### AND THE GUARD FOR THAT COULD NOT SEE THE FIXTURE THE FIX SHIPPED (2026-08-27)
The test written for the entry above contained a `requested` hold on unit **`999000111`**, five
minutes out. That is a numeric unit id in the one status `dueHolds` serves — **an instruction to
the production runner to POST a precart for whatever real campsite carries that number.** The
2026-08-15 incident, re-created by somebody who had just read the entry about it, in the fix for
its sibling.
- **IT SURVIVED ON TIMING, NOT ON DESIGN.** The feed's lead is 90s and the row sat 300s out, so it
  would only have become due had the suite taken ~3.5 minutes to reach its sweep. Checked in the
  database rather than reasoned: no fixture row, no live holds, and the CI run was cancelled the
  moment it was spotted. **"Nothing happened" is not the finding; "nothing was stopping it" is.**
- **`hold-fixture-safety.test.mts` WAS GREEN THROUGHOUT, AND IT IS THE GUARD FOR EXACTLY THIS.**
  Three independent layers of its scope each let it through, and each is now fixed and
  mutation-verified:
  1. **`holdTestFiles()` selected on `offerHold|requestHold`** — describing "files that drive the
     hold state machine" by the two helpers that happened to exist when it was written. **SIX
     suites write `rc_hold_requests` with plain SQL and none of them was ever scanned.** The
     selector asks about the CAPABILITY now: anything that writes the table is in scope, with no
     import required, because a raw INSERT needs none.
  2. **The line filter looked for `offer(`/`requestHold(`/`unit_id`.** Those describe where a unit
     id is USED; a fixture id is as often DECLARED once at the top and referenced by name, and
     `const REAL = '999000111';` carries none of them. A bare numeric constant declaration is in
     scope now — checked against every file first, and it flags nothing that exists.
  3. **The helper names were a fixed list**, so a suite calling its own `hold(`/`cartedHold(` was
     invisible. The scan DERIVES the names from the file now: any function whose body contains
     `INSERT INTO rc_hold_requests`. That cannot go stale when the next suite names its helper
     something else.
- **A WHOLE-FILE SCAN WAS TRIED AND REJECTED, on measurement rather than taste.** It flags
  `'24'`/`'00'` from the `pacific()` helper in six files and an `appBuild: '19'` in a seventh —
  and the guard's own comment already records that a version which cried wolf would be deleted,
  taking the real finding with it.
- **The fixture is now the shape `hold-fixture-invisibility.test.mts` established**, with the same
  three independent reasons: `carted` and never `requested`, seconds old and not `claiming`, and
  the id is `0` — one digit, under the two-digit floor, so no exemption is carved into the guard.
  The positive assertion drops to `holdsAhead` alone and loses nothing: `REAL_UNIT` is ONE shared
  constant, so breaking it fails there, and dropping it from `holdsDueWithin` alone is caught by
  the sentinel test requiring that count to stay flat.
- **Sweeps are scoped to the fixture WATCH, not the unit ids** — a bare `unit_id = '0'` would
  reach any real row that ever carried it.
- **`EVERY suite that writes rc_hold_requests is scanned` pins the widening**, because narrowing
  the selector back would read as a tidy-up and would restore the hole in silence.

### TWO PEOPLE WERE PROMISED ONE CAMPSITE, AND A LINE DECIDES IT NOW (migration 068, 2026-08-24)
**Measured, not hypothetical.** Unit `43191` ("#96", Morro Bay, arrival 2026-09-04,
releasing 08-25 08:00 PT) was offered to **two different users** — melinda.flores0501 via
"Morro Lottery sites" (rc-2185, watch created 16:53) and tylerflores1992 via "Upper
Section" (rc-583, watch created **19:45**). RC lists one physical campsite under more than
one facility, so both offers were correct and there was still one campsite. **The LATER
watcher is the one who tapped.**
- **NOTHING DECIDED WHO GOT IT.** `dueHolds` had no de-dupe, so had both tapped, the runner
  would have been handed both rows and asked RC for the same unit twice — one cart
  succeeds, RC refuses the other in its own wording, and the loser's row sits `requested`
  with `last_attempt_note` **NULL**, which the readout calls *"NOTHING has tried to act on
  this hold at all"*: the signature of the 2026-08-07 runner outage. **The absence of a
  policy was also manufacturing a false alarm.**
- **THE POLICY, as the owner specified it.** Earliest `watches.created_at` gets first dibs;
  BOTH are still offered; rotation is spent on being given FIRST DIBS rather than on
  winning (so a user who never claims cannot sit at the top for ever); and the offer screen
  says which you are, at the point of decision.
- **THE LINE ONLY BITES WHEN BOTH TAP.** `dueHolds` serves one hold per (release_at,
  unit_id), lowest `line_rank` among the **requested** ones — somebody who never answered
  is not in the running. Today only tyler tapped, so today he gets it.
- **THE TICKET IS FROZEN PER LINE, AND A TEST CAUGHT WHY.** Charging the winner raises
  their live `hold_offer_seq`, so a live read sorts them BELOW the person they just beat on
  the very next cycle: ranks flip, the runner-up is charged too, and "you're first in line"
  changes under the reader. The poller re-ranks every cycle, so this would have run five
  times a minute. `rc_hold_requests.line_seq` records the ticket each member was RANKED
  with. **Found by mutation, not by review.**
- **THE EXPIRY CASCADE IS NOT BUILT, deliberately.** It needs RC's real cart lapse, which is
  read off RC's own bundle as ~15 min and **has never been observed**, while
  `reclaimLapsedHolds` waits 180. Between those two numbers we would re-cart a site RC may
  already have released and tell a second user we hold something we do not. **Measure the
  lapse first.**
- `worker/hold-line.ts` (extracted because importing `poller.ts` starts it),
  `worker/hold-line.test.mts` real-DB, nine mutations each verified to apply.

### AN OFFER CAN BE DECLINED NOW, AND IT IS NOT COSMETIC (2026-08-24)
`HoldsPanel` gave `offered` rows no X and its header said why: with no server-side decline,
an X could only hide the card while the bot carted anyway, and **a control that appears to
cancel and does not is worse than no control**. The owner asked for the X; the answer was
`declineHold`, not a hidden card.
- **It frees a capacity seat AND a position in the line** — `holdWindowLoad` counts an
  `offered` row because the button is in an email we cannot retract, and declining moves the
  next person up. Hiding a card could never do either. Both tested.
- **`offered` ONLY.** `requested` is a commitment the bot is about to honour (retracting it
  is a *cancel*, a different act, and getting it wrong at 07:59 loses a campsite);
  `carted`/`claiming` is a real site in a real cart, and marking it terminal does not
  release it — that is the 2026-08-13 leak with a button on it. A refusal is a 409, never a
  removal.
- **Ordering was backwards**: `/api/rc-holds/mine` sorts by `release_at`, so a finished
  hand-off from an earlier release outranked a live offer. `src/lib/hold-ordering.ts` sorts
  by URGENCY (a cart with ~15 min on it first, `requested` last). Finished hand-offs
  (released, untouched an hour) collapse behind one disclosure line. **An unknown age counts
  as FRESH**, never stale.

### RC AUTO-HOLD SAYS WHAT IT IS NOW, IN THE WORDS THE MODULE ALREADY HAD (2026-08-24)
It was reachable ONLY by receiving an alert, so the only way to discover it was to already
be using it — the owner's "no sign of auto cart". `RcHoldExplainer` on `/pricing` says what
it is in four steps; the Watches list's offer card carries the SHORT note above the button.
- **`AutoCartSettings` had already invented a second form of words** ("still under
  testing…"), which is the drift `@/lib/autocart-beta` exists to prevent. It composes
  `AUTOCART_BETA_NOTE` with a new `AUTOCART_BETA_SCOPE` now — the one fact that card adds
  is that **Recreation.gov auto-cart is NOT in testing**.
- **NOT IN SMS**, unchanged and still guarded.
- **TWO OF THE NEW GUARDS SURVIVED THEIR FIRST MUTATION**, both the house shape: the mount
  assertion matched `{/* <RcHoldExplainer /> */}`, and the no-paraphrase rule matched the
  **IMPORT line**. Anchored on stripped source and on the component body. **24th and 25th
  time**, and the first time both were caught before merge.

### THE FIRST TWO-TAPPED CONTEST IS QUEUED FOR 2026-08-26 08:00 PT — outcome UNREAD
Set up deliberately by the owner on a second account to exercise the fairness line, and it is
the first time one physical site has had **two genuinely requested holds**:

    unit 43086 "#123", rc-583 (Morro Bay Upper Section), release 08-26 08:00 PT

    tylerflores1992      watch 08-24 12:45:30   ticket 0 -> 297   RANK 1   requested 05:02:40
    iamtylerflores12345  watch 08-26 05:07:46   ticket 0          RANK 2   requested 05:51:09

- **The ordering is the owner's rule applied literally.** Both users sat at ticket 0, so the
  tiebreak was `watches.created_at` and the earlier watcher took first dibs.
- **THE ROTATION CHARGED, AND THAT IS THE HALF WORTH READING.** `hold_offer_seq` on the
  winner went 0 → 297 while the runner-up stayed 0, so the NEXT contest between them inverts.
  Until now that rule had only ever been asserted by a test.
- **EXPECTED AT 08:00:** `dueHolds` serves one row per (release, unit) — rank 1 — so the main
  account carts and the rank-2 row stays `requested` and uncarted. **That is the line working,
  not a failure**, and `requested`-past-its-release is otherwise the signature of a dead
  runner. Read `last_attempt_note` before concluding anything.
- **THE RANK-2 ROW CARRIES NO "someone is ahead of you" NOTE, and that is a real gap.**
  `rankHoldLine` writes it only to rows already `requested`; at 05:50:55 the runner-up's row
  was still `offered` and it was tapped fourteen seconds later. Nothing re-ranks the line
  afterwards unless another offer for that unit arrives, so the note may never be written.
  Diagnostic only — `last_attempt_note` has no user-facing reader — but it is the field the
  readout uses to tell a queue from an outage.

### THE FAIRNESS LINE SERVED BOTH RIVALS — 14 SECONDS APART (2026-08-26)

The first two-tapped contest ran, and the line **did not do the one thing it exists to do.**
Both holds carted:

    15:00:02  ✓ held #123 (2026-09-04) — entry ae877ae5-9ee1-479b-bec9-4d9f610ae718
    15:00:13  0 to hand over, 1 to cart, 0 to release      <- the NEXT poll
    15:00:17  ✓ held #123 (2026-09-04) — entry 6f0863e0-78d7-4cd2-9ec6-22ffc02f1351

**Two distinct cart entries for one physical campsite, and RC accepted both.**

- **THE DE-DUPE IS PER CALL, NOT PER CONTEST.** `dueHolds` uses
  `DISTINCT ON (release_at, unit_id)`, which picks one row **within a single query**. The
  runner polls every 15s. The instant rank 1 succeeded and left `requested`, rank 2 became
  the top `requested` row for that unit and was served on the very next pass.
- **THE HEADER STATES THE INTENT IT FAILS TO DELIVER**, which is why nobody caught it:
  *"Serving both would ask RC for the same unit twice: one cart succeeds and RC refuses the
  other in its own wording."* **RC did not refuse.** It issued a second reservation — so the
  anticipated failure (a confusing error) was replaced by a worse one that looks like success.
- **THE COST.** Two of the bot's ten cart slots for one site; **both users told their site is
  held** when only one can have it; and the loser finds out at CHECKOUT, after being told it
  was secured — the "user stops watching" failure the whole opt-in design is built around.
- **`hold-line.test.mts` COULD NOT HAVE CAUGHT IT.** Its assertion calls `dueHolds` ONCE and
  checks that one row comes back. That is true and always was. The bug is only visible across
  **two successive calls with a status change in between**, which no test simulates.
- **THE FIX IS NOT BUILT.** `dueHolds` must exclude any `(release_at, unit_id)` that already
  has a LIVE hold — `carted` or `claiming` — so the rule becomes *one live hold per unit*
  rather than *one served per call*. That is the most release-critical query in the product
  and it is not a drive-by; it wants its own change, with a test that calls `dueHolds` twice.
  - ~~**THE FIX IS NOT BUILT.**~~ **BUILT AND MERGED (#201).** `dueHolds` carries a
    `NOT EXISTS` over `('carted','claiming','released','claimed')`, which makes the rule
    TEMPORAL rather than per-call, and `hold-line.test.mts` calls `dueHolds` twice with a
    status change in between. Struck rather than deleted: "the fix is designed and NOT
    built" is exactly the sentence a later reader quotes as current state, and it survived
    at the top of **Open / next session** for two days after the fix landed.
- **AND THE RANK-2 ROW CARRIED NO NOTE**, so from the readout the morning looks like two
  clean carts rather than a contest that went wrong. `rankHoldLine` writes the "someone is
  ahead of you" note only to rows already `requested`; this one was tapped fourteen seconds
  after the line was ranked and nothing re-ranks afterwards.

#### AND THE REASON NOTHING RE-RANKS WAS A GATE MEANT FOR THE NOTIFICATION (2026-08-28)
The sentence above ends *"nothing re-ranks afterwards"* and stops there. **Where that came
from is one line in `poller.ts`, and it is not in `hold-line.ts` at all.**
- **`rankHoldLine` for the PRIMARY held unit sat inside the block gated by
  `claimHoldNotification`**, which is once per (watch, release, unit); every later cycle
  `continue`s on that claim without reaching it. So the line was ranked **exactly once in
  the life of an offer** — at the moment the alert went out.
- **THE EXTRAS LOOP HAS ALWAYS RE-RANKED EVERY CYCLE.** `heldUnits.slice(1)` calls it
  unconditionally, with a comment saying why (*"a contest is only visible once the second
  offer exists, and it can arrive on any cycle"*). The reasoning was written down, correct,
  and applied to the rarer of the two paths. The primary unit missed it purely because its
  call happened to be inside a gate that exists for the TEXT, not for the ranking.
- **SO THE LOSS LANDS ON THE ORDINARY CASE, NOT AN EDGE.** An offer goes out the evening
  before and is tapped at breakfast. Every tap after the ranking pass — which is nearly all
  of them — leaves a row `requested` past its release with `last_attempt_note` **NULL**,
  which `rc-holds-readout.mts` prints as *"NOTHING has tried to act on this hold at all"*.
  That is the 2026-08-07 dead-runner signature, manufactured by the line on every contested
  morning. Diagnostic only (`last_attempt_note` has no user-facing reader), and the field a
  human reads at 08:15 to tell a queue from an outage.
- **THE FIX IS THE CALL SITE: re-rank ABOVE the claim gate**, so it runs every cycle like
  the extras path. The in-block call is KEPT — on the claim-winning cycle the offer row is
  created *after* the pre-claim call has already run and found nothing, so without it a
  fresh offer waits a full cycle to be ranked.
- **AND THAT MAKES THE NOTE WRITE PER-CYCLE, WHICH NEEDED ITS OWN GUARD.** `noteAttempt`
  stamps `last_attempt_at = NOW()` unconditionally, so ranking every 15s all night would
  leave that column permanently reading "0m ago" — destroying the one signal that says WHEN
  the line last changed its mind, and the same column the readout uses for *"the runner
  TRIED 3m ago"*. Rows already carrying the note are skipped, compared against an exported
  `BEHIND_NOTE` constant so no test can pin a copy of the wording.
  - **THE CONSTANT MUST STAY UNDER `noteAttempt`'s 300-CHARACTER SLICE.** Past it the
    stored value can never equal the constant, the skip never matches, and the churn guard
    silently stops guarding — fix-present-and-inert, pinned by its own test.
- **THE DB TEST DOES NOT CATCH THIS BUG, AND THAT IS MEASURED RATHER THAN ASSUMED.** The
  new "tapped after ranking" test PASSES against master's `hold-line.ts` — verified by
  running it under the mutation that restores master's exact filter. `rankHoldLine` always
  noted late tappers *when called*; it was never called. **Only the STRUCTURAL guard
  (`rankHoldLine` appears before `claimHoldNotification(w.id` in stripped source) fails
  against the real defect.** The behavioural test is a property guard, not a reproduction,
  and calling it one would be the twenty-fifth instance of a guard credited with catching
  something it cannot see.
- Five mutations, each verified to APPLY and to fail: the call moved back below the claim,
  the note-skip dropped, the constant pushed past 300 chars, `rankHoldLine` early-returning
  when no rank changed, and the `requested` filter dropped so `offered` rows are noted too.
- **AND THE MUTATION RUN ITSELF COST THE FIX ONCE.** `git checkout <file>` was used to
  revert each mutation while the fix was still UNCOMMITTED, so it reverted to HEAD and
  deleted the change under test — after which two mutations reported "did not apply"
  against a file that no longer contained the code they targeted. **Commit before mutating**,
  or the reverts are indistinguishable from the fix never having been written.

### A DEAD SESSION STILL STRANDS A CARTED SITE (2026-08-26) — the 08-13 leak, recurring
Both carted rows were **still `carted` 78 minutes later**, with `released_at` NULL:

    last_attempt_note : RC session is dead — needs a human sign-in
    session           : no RC token at all — neither live nor stored
    okta              : GONE

The runner was alive and trying every 15s. **The release loop lives inside `withRC`**, so a
dead session skips the whole callback and nothing lets go — exactly the 2026-08-13 finding,
which `reclaimLapsedHolds` only half-fixed: it marks the row `expired` at `HOLD_LAPSE_MIN`
(180 min) and **keeps `cart_key`, so it never releases the site on RC.**
- **NOTHING WOULD HAVE REPAIRED IT.** `renewSession` skips with Okta GONE; `maybeAutoLogin`
  only fires at T−30 of a release and the next was 23 hours away. The site was off the market
  indefinitely.
- **`test-login` IS THE REMOTE LEVER, AND IT WORKED IN THREE MINUTES.** Queued 09:18:30 →
  session `ok` at **09:20:24** → the runner released both holds by **09:22:29**. It is
  rationed to one per 6h on the box's own clock and refuses within 6h of a release, so it is
  safe to reach for; it is the only remote thing that can restore a dead session, because the
  renewal cannot when Okta is gone.

#### THE STRANDING HAS NEVER ACTUALLY HAPPENED — MEASURED, AND THE MARGIN IS 98 MINUTES (2026-08-27)
The entry above is the standing account of `reclaimLapsedHolds`' half-fix, and the handover
carried it as the top actionable bug. **Checked against production rather than reasoned:
there is not one stranded row, and there never has been.**
```
rc_hold_requests WHERE cart_entry_key IS NOT NULL AND released_at IS NULL AND status <> 'released'
  failed  TEST · 43112  carted 08-26 16:36Z   released after  53 min
  failed  TEST · 43106  carted 08-26 16:36Z   released after  45 min
  failed  #123          carted 08-26 15:00Z   released after  82 min   <- the dead-session pair
  failed  #123          carted 08-26 15:00Z   released after  82 min
  failed  #96           carted 08-25 15:00Z   released after  45 min
status counts: expired=34  offered=5  failed=5  released=1
```
- **ZERO `expired` rows carry a cart entry key**, which is the shape the stranding would
  leave. So the 180-minute lapse sweep has never once fired on a row it could strand — every
  carted hold was released first, by us, via `expireStaleHolds`.
- **`failed` + *"released unclaimed — nobody came for it"* IS THE CORRECT RECORD, NOT A BUG**,
  and it is what a naive query mistakes for the stranded shape. `route.ts` splits the two
  releases deliberately: `forClaim` → `markReleased` (the hand-off worked), a bare timeout
  release → `markFailed` with that note. `markFailed` does not stamp `released_at`, so
  filtering on `released_at IS NULL` catches five rows that were all released properly.
  **Read the writer before calling a row stranded.**
- **THE MARGIN IS 98 MINUTES AND IT COST A HUMAN.** Worst observed is the 08-26 pair at
  **82 min** against `HOLD_LAPSE_MIN` 180 — and it only got there because somebody queued
  `test-login`. Unattended, `renewSession` was skipping (Okta GONE) and `maybeAutoLogin` was
  23 hours away, so nothing was going to release those rows before the sweep expired them.
- **AND THE SWEEP'S SAFETY ARGUMENT IS DISPROVED, WHICH IS THE PART TO CARRY FORWARD.**
  `HOLD_LAPSE_MIN`'s comment justifies 180 as *"far enough past both that 'RC has released
  this by itself' is safe to act on even if the real number is several times what the bundle
  claims"* — resting on RC dropping a cart at ~15 min. **On 08-25 RC still held #96 at
  exactly 45 minutes** (our own `expireStaleHolds(45)` removed it, HTTP 200). So the bundle's
  15 is out by at least 3x, three of the "several times" of margin are already spent, and
  **RC's real lapse has no upper bound at all.**
- **SO IT IS LATENT, NOT LIVE — DO NOT FIX IT BLIND.** The obvious remedy (let the runner's
  release list pick up lapsed-but-unreleased rows) needs a retry bound, and the only honest
  source for that bound is RC's real cart lapse, which is exactly the number nobody has
  measured. Building on it is what `hold-line.ts` already refuses to do for the expiry
  cascade. **Measure the lapse first** — let one test hold sit past 45 minutes without our
  sweep touching it and watch when RC lets go.
- **The cheap containment needs no number**: raising `HOLD_LAPSE_MIN` widens the window the
  session has to recover in, and it is one env var. That is a decision, not a tidy-up.

#### `rc-probe.mjs --cart-lapse` IS BUILT TO TAKE THAT MEASUREMENT (2026-08-27) — NOT YET RUN
Cart one unit into a FRESH cart, then simply do not let go, and poll until RC does. It
reports a **bracket** (last seen present, first seen absent), because a poll every N minutes
cannot do better and pretending otherwise is how `15` got written down in the first place.

    RC_LAPSE_UNIT=<from --find> RC_ARRIVAL=2026-12-15 RC_NIGHTS=1 \
      node rc-probe.mjs --cart-lapse --headful

- **DELIBERATELY NOT THROUGH THE HOLD PIPELINE.** A queued hold is released by
  `expireStaleHolds(45)` at minute 45, so it can never measure past the number we already
  have — and raising that default would change production behaviour for every user to run an
  experiment. The probe uses `.rc-probe-profile`, so it does not take the keep-warm's
  Chromium either.
- **THE CONTROL IS THE READ-BACK BEFORE THE CLOCK STARTS.** A precart that silently failed
  leaves an empty cart, and polling that reports RC dropping it within seconds — an instant,
  dramatic, entirely fabricated answer to the one question being asked. It refuses with
  `THE QUESTION WAS NEVER REACHED` instead. Same discipline as `--cart-cap`'s step 3.
- **AN UNREADABLE CART IS NOT AN EMPTY ONE, AND THIS IS THE THIRD TIME.**
  `listCartEntries` returns `{entries: []}` on a non-200 or an unparseable body and
  `findCartEntry` returns `{found: false}` on any throw — right for CLEANUP, fatal here,
  where ABSENT is the signal. One 502 would become "RC dropped the cart". The mode does its
  own strict read with **PRESENT / ABSENT / UNKNOWN**, an UNKNOWN advances nothing, and a
  first ABSENT only arms a confirmation. A cart that comes BACK is logged as spurious rather
  than quietly dropped, because it means one of the two reads was lying.
- **IT REFUSES TO START within `RC_LAPSE_MAX_MIN + 60` of a release**, and refuses just as
  hard when the feed is unreachable — "we could not find out" is not permission. Holding a
  cart across 08:00 spends one of the ten slots `RC_HOLD_CAPACITY` is built on.
- **RUNNING OUT OF TIME IS A LOWER BOUND** and says so. "RC holds carts forever" is the same
  class of claim as the 15 this replaces.
- **It locks ONE real campsite for the run.** Far-future midweek, id from
  `scripts/rc-test-hold.mts --find` — **never invented**, which is the 2026-08-17 rule. It
  releases in a `finally`, on the max-duration exit, and on **SIGINT** (an interrupted run is
  the likeliest way this strands the site it is measuring, and `finally` does not cover it).
- `worker/cart-lapse.test.mts`, 15 tests, **ten mutations each verified to apply and to
  fail.** Two survived the first round and both were the same recorded mistake — pinning a
  CONDITION rather than what it returns. `/!resp\.ok\(\)/` passed against a branch flipped
  from UNKNOWN to ABSENT, and `ok: false` counted `>= 4` passed against the unreachable-feed
  branch flipped to `ok: true` with four refusals still behind it. **A count is not a
  pairing.** Three more failed at baseline by describing a shape the probe does not have
  (a `state:` key that is really a ternary, a `} else {` that first occurs far above, and
  Playwright's `ok()` where this branch uses `fetch`'s `ok` property).
- **AND IT BROKE A NEIGHBOURING GUARD BY BEING INSERTED, WHICH IS THE 25th TIME.**
  `concurrent-mint.test.mts` sliced from its own block to `if (signedIn && (CART_CAP ||
  CART_LADDER))`, and `--cart-lapse` went between them — so its `BLOCK` swallowed the new
  code, which contains the same `THE QUESTION WAS NEVER REACHED` string. **Verified: the
  suite passed 15/15 against a probe whose concurrent-mint verdict had been deleted.**
  Re-anchored on the next block and re-verified failing. A guard that slices between two
  anchors is broken by anything inserted between them, silently and in the passing direction.

### `reclaimLapsedHolds` KEPT `cart_key` AND NEVER USED IT — the premise it rested on is retired (2026-08-28)
Its own header already said the row's `cart_key`/`cart_entry_key` were kept "so a later
healthy pass could still try" — and nothing did. `expireStaleHolds`'s `toRelease` query
(the only thing that ever asks the bot to release a site) selects `status = 'carted'` only.
The moment `reclaimLapsedHolds` flipped a stuck row to `expired` at `HOLD_LAPSE_MIN` (180
min), it left the runner's retry list **for ever** — the comment described an intention the
code never implemented.
- **THE ASSUMPTION BEHIND `expired` WAS "RC PROBABLY DROPPED IT BY ITSELF."** That premise
  is the one 2026-08-25's `--cart-lapse` sibling measurement retires: RC did **not** lapse an
  unclaimed cart on its own inside 45 minutes — `expireStaleHolds(45)` released it, HTTP 200,
  ours. So a hold that could not be released because the RC session was dead is not "probably
  gone by itself" — it is most likely still locked, on a real campsite, with nobody able to
  book it. Silently declaring it `expired` was very likely stranding the site, not tidying a
  row.
- **THE FIX: STOP TERMINATING IT.** `reclaimLapsedHolds` no longer touches `status`. The row
  stays `carted`, which keeps it in `expireStaleHolds`'s retry list on every poll — the
  runner will actually ask RC to let go the next time the session is healthy, however long
  that takes. Costs nothing extra: since 2026-08-13 every hold mints its OWN cart, so a stuck
  row occupies only its own cart, never a shared pool other holds are waiting on — the
  capacity-leak motivation this function was ORIGINALLY built for (2026-08-13, RC's cart cap
  was 2 and per-hold carts did not exist yet) no longer applies the way it did.
  `reclaimLapsedHolds` now only writes ONE diagnostic `last_attempt_note` (idempotent — a
  second sweep over an already-noted row is silent, or a hold stuck for days would get the
  identical note rewritten, and logged as newly "stuck", every 60 seconds forever).
- **CAPACITY IS HANDLED SEPARATELY, WITHOUT TERMINATING THE ROW.** `holdWindowLoad`
  (`src/lib/rc-holds.ts`) now excludes a `carted` row directly by age
  (`carted_at < NOW() - HOLD_LAPSE_MIN minutes`), so a hold nobody can free up still stops
  making a genuinely new offer for the SAME release read as full — the one real thing the
  old `expired` status bought — without needing the row to be terminal to get it.
- **`HOLD_LAPSE_MIN` MOVED to `src/lib/limits.ts`.** It used to live in
  `worker/expire-holds.ts`, read only by that file and its test. `holdWindowLoad` needed the
  same number, and `rc-holds.ts` already imports things `expire-holds.ts` imports FROM — a
  same-direction import would have made the two files import each other. `limits.ts` is a
  leaf both sides already read (`RC_HOLD_CAPACITY` lives there for the identical reason).
- **THE CLAIM SCREEN NEEDED NO CHANGE.** `ClaimFlow.tsx`'s `status === 'carted'` branch
  already renders the full "sign in and hand it over" flow — so a hold that stays `carted`
  past 180 minutes is now something the claim link can still complete, rather than falling
  into the `expired` branch's "back on the open market" copy while possibly still locked in
  our own cart. That comment block (owned by the side lane, `src/components/v2/`) still
  narrates the retired mechanism; not touched here — lane boundary, and it is a documentation
  staleness, not a functional one.
- `worker/rc-hold-capacity.test.mts`'s existing test rewritten around the new behaviour
  (status stays `carted`, keys survive, `holdWindowLoad` excludes by age, a second sweep is
  silent) — asserted against a **baseline**, not an assumed-empty window, since this file's
  own earlier tests share one release window and leave rows `offered` in it.
- **NOT VERIFIED AGAINST THE REAL BOT.** This is Fly-worker- and web-only — no
  `scripts/auto-cart-bot/*` file changed, so it needs no mini-PC update, only the ordinary
  worker deploy `src/lib/notifications/**`/`worker/**` already trigger. What is unverified is
  the real-world claim itself (RC not auto-lapsing past 45 min) generalising past the one
  2026-08-25 measurement — treat it the way this file treats every number read off a bundle
  or a single observation: the best available reading, not a law.

### ONE ACCOUNT ALWAYS GETS FIRST DIBS (migration 069, 2026-08-28) — a deliberate thumb on the scale
The owner asked to always rank number one in the hold line, and reaffirmed it after being shown
who is on the other side of it. `users.line_priority` (integer, default 0) is read by
`orderLine` **ahead of** the rotation ticket and watch age, so a flagged account ranks first
from the worst possible position. **Built, merged (#214, `ba0753d`), deployed, and PROVEN on the
live line.**
- **WHO LOSES, RECORDED BECAUSE IT WAS ASKED AND ANSWERED, NOT TO RE-LITIGATE IT.** In the live
  line for unit 43189 the accounts ahead were `melinda.flores0501` (a paying subscriber —
  active, base tier, grandfathered) and `iamtylerflores12345` (the owner's own test account).
  **Melinda is family, which is what settled it.** Two accounts that are NOT family also compete
  in future lines: `suziegrieve03` (3 active watches, more than anyone) and `cam1234123` — both
  beta users, both holding a NULL ticket, which reads as 0 and would otherwise outrank
  everybody. That was raised once, accepted, and is written into migration 069's header so a
  later reader finds a decision rather than a bug.
- **A COLUMN, NOT A HAND-EDITED TICKET.** The cheap route was `UPDATE users SET hold_offer_seq
  = 0`, and it is strictly worse: invisible at the ranking site, it drifts back the moment the
  rotation charges the ticket again, and the next person reading the line sees a number where a
  decision belongs. The override has a name, ONE enforcer (`orderLine`) and a test.
- **THE COPY HAD TO CHANGE WITH IT, AND THAT WAS THE REAL WORK.** Two surfaces asserted *why*
  somebody was ahead, and priority makes both false: `BEHIND_NOTE` said *"they watched it
  first"* (read by whoever diagnoses at 08:15), and **`HoldConfirm.tsx`'s `LineNote` — which is
  USER-FACING** — said *"you started watching first"* and *"Somebody started watching it before
  you"*, on the screen where a person decides whether to trust the bot instead of setting an
  alarm. Both now state the POSITION, which is always true, and not the REASON, which is not.
  **Shipping the flag without this would have made the app tell a real user something untrue at
  the moment of decision.**
- **PRIORITY IS READ LIVE, NOT FROZEN ONTO THE HOLD like `line_seq`, and the asymmetry is
  deliberate.** The ticket is frozen because RANKING ITSELF SPENDS IT — a live read sorts the
  winner below the person they just beat on the next cycle. Nothing charges a priority, so that
  failure cannot arise, and taking effect on the next cycle is the POINT of changing it. **Do
  not "make this consistent" by adding a frozen column** — that would pin a revoked override
  onto every hold already in flight.
- **THE ROTATION STILL CHARGES THE FLAGGED ACCOUNT.** Winning as rank 1 raises
  `hold_offer_seq` every contest, so removing the flag drops that account to last for a while.
  That is correct — they have been winning — and it makes switching it off honest rather than
  abrupt. Left deliberately.
- **PROVEN ON THE LIVE LINE, which is stronger than the deploy's own self-report.** After the
  worker deploy the production poller re-ranked unit 43189 by itself:
  ```
  rank 1  tylerflores1992@gmail.com      offered
  rank 2  tylerflores1992@gmail.com      requested   <- the tapped row
  rank 3  melinda.flores0501@yahoo.com   offered
  rank 4  iamtylerflores12345@yahoo.com  offered
  ```
  **A poller on the old code cannot produce that ordering** — it does not even SELECT
  `u.line_priority` — so the re-rank is independent evidence the new code is live, of the kind
  a green deploy step is not.
- **`dueHolds` SERVES THE LOWEST RANK AMONG `requested` ROWS**, so rank 1 being an untapped
  offer is harmless: the tapped row at rank 2 is what gets carted.
- Eight mutations, each grep-verified to APPLY before its red was trusted — including the
  priority comparison reversed (it is the ONE descending term, so `a - b` reads natural and
  silently demotes the flagged account, presenting as "the flag does nothing"), and
  `u.line_priority` dropped from the SELECT, which is the fix-present-and-inert shape.
- **`suziegrieve03` AND `cam1234123` HOLD A NULL TICKET, WHICH READS AS 0.** That is why the
  guard specifically tests "priority beats a ZERO ticket": a flag that only beat spent tickets
  would lose every contest containing a newcomer, which is the production case.

#### AND A PRE-EXISTING TEST DEFECT SURFACED THE MOMENT A REAL HOLD EXISTED
`health-hold-counts.test.mts` compared `holdsAhead(25)` — **bounded** — against `holdsAhead()`
— **unbounded** — as its baseline. Those agree only while every live hold happens to be within
25 minutes of releasing, i.e. **while the table is empty**, which is how it was written in #202
and how it passed for five days.
- It went red the moment a hold was tapped for a release **19 hours out**, on a branch whose
  diff could not touch it, and read exactly like a regression.
- **VERIFIED FAILING ON `aea82d4` WITH NONE OF THE BRANCH'S CHANGES** — that check is what
  separated it from a regression, and it took one command. `THE BOUND IS A BOUND`, three tests
  further down the SAME FILE, already took a bounded baseline; these two simply did not follow
  it.
- Re-verified against three mutations (`REAL_UNIT` not filtering, `REAL_UNIT` as `AND false` —
  the dangerous over-correction — and the bound ignored) so the rebaseline is not a weakening.
- **THE GENERAL SHAPE: a real-DB guard whose baseline is a DIFFERENT query than its assertion
  is only correct on an empty table.** There may be more of these; they will surface one live
  hold at a time.

#### THE `HoldConfirm.tsx` HEADER STILL CARRIED THE REFUTED DUPLICATE-FACILITY STORY
It read *"RC lists one physical campsite under more than one facility, so two people can each be
offered the same site"*. **Measured false on 2026-08-25** — zero inventory overlap; the
collision was our own result-map bug, fixed by `watch-key.ts` in #188. `worker/hold-line.ts`'s
header was corrected then and **this copy of it was not**, so the file kept teaching the wrong
cause. Corrected while changing the copy beside it. Same shape as the two docs PRs that sat
open carrying the Feature E correction: **a correction applied to one copy is not applied.**

#### TWO SMALL TRAPS PAID FOR AGAIN
- **BACKTICKS IN A SQL COMMENT COST A BUILD, for at least the third time.** These queries are
  template literals, so a backtick in a `--` comment terminates the string and the parse error
  surfaces on an unrelated line. The park-watch entry already warns about this in as many words
  and it still happened, inside a comment explaining the very field being added. `tsc` catches
  it; nothing else does.
- **A SEMICOLON INSIDE A SQL STRING LITERAL BREAKS A NAIVE SPLITTER.** Migrations here are
  applied by hand, and the obvious way is to split the file on `;` — which cuts a statement in
  half when one is hiding in a `COMMENT ON ... IS '...'`. Cost one failed apply. 069 now says so
  in the file.
- **The health endpoint's checks are keyed `name`, NOT `id`.** A summary filtering on `c.id`
  prints `undefined` for every check and silently drops the ones you were looking for.

### iOS AND ANDROID DIVERGED ON ONE CAMPSITE EACH, AND THE INSTRUMENTS SAID THEY MATCHED (2026-09-01)
Two real-site hand-offs eleven minutes apart, both carted at T+2s. **iOS worked — RC's header
carried the owner's name and the cart was reachable. Android did not** — RC rendered *"Before
booking, please sign in or create a profile"* and the cart asked him to log in. Owner-confirmed
on both devices.
- **EVERY OUTCOME FIELD MATCHED, AND THAT IS THE FINDING.** `✓ Added to cart`,
  `cart read back: 1 entry`, `close: timeout`, and the okta census down to
  `oktaKeys: 1 · oktaToken: none · storedToken: jwt · keySource: localStorage`. **The
  instruments did not measure the thing that differed** — the house shape, arriving in the
  diagnostics built to escape it. I reported the two platforms as "identical line for line"
  on the strength of those fields and was wrong: the traces were identical, the outcomes were
  not.
- **THEY DIVERGE FOUR STAGES EARLIER, IN THE SIGN-IN.**
  ```
  iOS      signin-missing {candidates:6} → email → password → submitted
  Android  signin-open {}                →         password → submitted
  ```
  Android never reached Okta's IDENTIFIER page: a password field was already on screen, so
  `chFind(CH_PW_SELS)` matched and the caller skips the email step entirely. **Okta renders
  "Keep me signed in" on the identifier step**, so there was no checkbox in the DOM and
  `chKeepSignedIn` found nothing.
- **THE TICK RETURNED A BOOLEAN NOBODY READ**, so "ticked it" and "there was no box on this
  page" were the same silence — which is precisely why two runs with opposite outcomes
  produced the same trace. It reports now (`keep-signed-in` → `{at, ticked, boxes, matched}`),
  counts and a boolean, **never label text**: the sibling `signin-missing` already refuses
  candidate text because RC's header carries the signed-in user's own name.
- **WHY THE TICK IS LOAD-BEARING, from this file's own measurement.** 2026-08-09: the ported
  login calls `keepSignedIn()` and the hand-rolled one never did, so *"every previous session
  was established without 'Keep me signed in', so of course Okta issued nothing persistent"* —
  `okta=GONE(404)` before, a ~12h session after. The function's comment says the `idx` cookie
  comes from that box. A run without it still completes the OAuth exchange and mints a good
  939-char access token — **which is why the cart POSTs succeed** — while leaving nothing for
  RC's SPA to render a name from.
- **CANDIDATE, NOT A FINDING.** What is established is that the tick did not happen; that it
  is WHY the header is empty is inference from one prior measurement. **A hand-off reporting
  `ticked` whose header is still empty refutes it outright.**
- **PATH-DEPENDENT, NOT PLATFORM-DEPENDENT.** iOS fails identically on any run where Okta
  remembers the account. Which page you land on is decided by the device's password manager
  and Okta's cookies, not by our code — so "what is different on Android?" has the same answer
  it has had all along: nothing, in our source.
- **`signInPathReading` PRINTS THE PATH NOW**, above the keep-signed-in line because it is
  that line's precondition. Derived from stages, **never from the platform** — keying it on
  the device would encode the exact confusion it exists to end, and is pinned by a test.
- Ten mutations, each grep-verified to APPLY. **Two survived the first round and both were
  real gaps**: `boxes` hardcoded to `0` passed the whole suite (the no-box test asserts zero
  trivially, the success test only checked `ticked`) — which would have read as "Okta never
  offered the option" on EVERY run; and the readout dropping `keepSignedInReading` for a
  literal passed too, because every test exercises the function directly. `closeReasonReading`
  had the identical exposure and was never guarded either. Both pinned.
- **TWO EXISTING GUARDS BROKE OVER UNCHANGED BEHAVIOUR AND WERE RE-ANCHORED, NOT RELAXED** —
  one pinned the literal `chKeepSignedIn()` expression, the other an entire import line that a
  second imported name invalidated. Twenty-somethingth time.

#### AND `findLast` MAKES A TICKED BOX REPORT AS "NO CHECKBOX AT ALL" (2026-09-04) — ~~NOT FIXED~~ FIXED IN #271
The instrument above got its first identifier-first run on a real hold, and **it reported the
opposite of what happened.** From `client_reports` on `#L034`, in order:
```
n:7   signin-open      {waitedMs:1015}
n:7   signin-form      {waitedMs:251}
n:8   keep-signed-in   {at:"email",    boxes:1, ticked:true,  matched:true}   <- it WAS ticked
n:10  keep-signed-in   {at:"password", boxes:0, ticked:false, matched:false}  <- expected
```
- **AN IDENTIFIER-FIRST RUN EMITS TWO REPORTS, AND THE SECOND IS ALWAYS EMPTY BY DESIGN.**
  Okta renders the box on the identifier step only, so reaching the password step and finding
  `boxes: 0` is the CORRECT observation there and carries no information. `rc-holds-readout.mts`
  takes `findLast`, so it reads that one — and prints *"NOT ticked on the password step: no
  checkbox on the page at all … so this sign-in likely left NO persistent session"* over a run
  that ticked it.
- **THE LINE DIRECTLY ABOVE IT CONTRADICTS IT, WHICH IS HOW IT WAS CAUGHT.**
  `signInPathReading` prints IDENTIFIER-FIRST on the same run, and the warn's own text asserts
  *"the identifier step, which this run skipped"* — of a run that did not skip it. Two lines
  from one readout stating incompatible things about one sign-in.
- **THE `findLast` COMMENT REASONS IT OUT AND REACHES THE WRONG ANSWER**, which is why it will
  survive a review: *"a sign-in can touch the identifier page and the password page, and the
  question is what the run ended up doing."* True of the okta census beneath it (one store, two
  readings, the later one wins) and **false here** — these are two DIFFERENT pages being asked
  a question only one of them can answer, so the later reading is not fresher, it is
  inapplicable. **The rule wanted is "the report where the box EXISTED"**: prefer `boxes > 0`,
  fall back to the last only when none had one, which is the genuine password-first case this
  reading was built for.
- **IT COST A WRONG REPORT TO THE OWNER THE SAME MORNING**, on the one field that decides
  whether the NEXT sign-in is the 11-second cookie-answered kind or the 12-minute password
  variant — so the warn argues for a cost we are not paying, and would argue for it on every
  identifier-first run for ever.
- ~~**NOT FIXED**~~ — **FIXED THE SAME DAY (#271).** `pickKeepSignedInReport` in
  `src/lib/rc-token-liveness.ts` prefers the report where the box EXISTED and falls back to the
  last only when none had one, which keeps the genuine password-first warn. A pure function
  rather than a line in the script, for the reason `closeReasonReading` and `signInPathReading`
  are. **The fixtures stage BOTH reports** — a single-report fixture passes against `findLast`
  and measures nothing, which is the vacuous-guard shape this file has recorded twenty-odd
  times. Four mutations, each asserted to APPLY and verified to fail: the picker always taking
  the last, the fallback dropped, `boxes > 0` widened to `>= 0`, and the readout reverting to
  `findLast`. **Guards under `src/`, not `worker/`**, so it fires no worker deploy.
- **VERIFIED ON THE REAL ROW, not only the fixture.** `rc-holds-readout.mts` against production
  now prints, for the same `#L034` that was reported backwards:
  `sign-in path: IDENTIFIER-FIRST …` then `"Keep me signed in" was ticked on the email step`.
  The two lines agree.
- **AND IT DOES NOT REFUTE THE 09-01 CANDIDATE.** That entry says a hand-off reporting `ticked`
  whose header is still empty refutes it outright. This run reported `ticked` **and** the header
  was populated (`customerId PRESENT`, `GetSSOLoggedInUser → HTTP 200 · RC Response 1`,
  `close: session`), which is the candidate holding, not failing.

#### ⚠ #248 CHANGED THE BASELINE TO INSTRUMENT THE THING THAT IS NOT THE BASELINE
The standing instruction is that **iOS is the baseline**, and this change was written off an
ANDROID observation while editing `src/lib/rc-login-script.ts` — **which iOS runs too**. Raised
by the owner, and it is the right instinct: the danger is fixing the broken platform by
disturbing the working one.
- **It is the ONLY file in #248 that reaches either app.** The readout, the pure functions and
  `docs/PLATFORM-PARITY.md` cannot affect a device.
- **The behavioural delta was audited before merge and is essentially nil:** `chKeepSignedIn`
  went from `{ b.click(); return true; }` to `{ matched = true; b.click(); ticked = true;
  break; }` plus a `chSay`. Same click, same conditions, same short-circuit; **no caller reads
  the return value**, and `chSay` swallows its own errors, so it cannot throw out of the tick.
- **IF iOS REGRESSES, REVERT `rc-login-script.ts` ALONE.** Reverting the whole PR would take
  the parity work with it, which is the half that stops this recurring.

### RC'S SIGN-IN IS TWO STEPS, AND EVERY CLOSE RULE WE EVER SHIPPED RACED THE SECOND (2026-09-01, #249)
The Android "no name, cart asks to log in" defect, open since 2026-08-29, **is explained from
RC's own source and fixed** — and two of the readings I gave the owner the same evening were
wrong. Found by fetching RC's SPA bundle (`index-BvrbWbr2.js`) and reading how it decides it is
signed in, which nobody had done in a month of instrumenting our side of it.
- **THE MECHANISM, from RC's code.** Okta's callback fires the `ProcessSSOLogin` thunk: it
  writes `ssoCustomerName` + **`ssoAccessToken`** (the 939-char JWT we capture) with
  `isLoggedIn: false`, then **awaits `GET WebAccessCustomer/SSO/GetSSOLoggedInUser`**. Only
  that RESPONSE (`Ks`) writes **`customerId`**, `customerName`, **`accessToken` (RC's OWN
  token, distinct from Okta's)** and `customerDetail`, sets `isLoggedIn: true`, and navigates
  **client-side**. On boot: **`isLoggedIn: !!localStorage.getItem("customerId")`**. The header
  name is `customerName`. The cart page's axios client requires RC's `accessToken`, and with it
  null dispatches **`customerLogOut`, which also deletes `ssoAccessToken`** — the login prompt,
  and why the Okta token has seemed to vanish.
- **WE CLOSED BETWEEN THE STEPS, EVERY TIME.** `rc-inject.js` captures the token off RC's
  outbound `accesstoken` header, and the first such call after the callback IS step two's
  request. So `token captured` marks the instant step two LEAVES, and `closeOnToken` (#126),
  the liveness gate (#152) and the `/login/callback` deferral with a 10s timer (#240) were all
  the same race with different fuses. `settled` could never fire — the post-login navigation
  is client-side, no `loadstop` — so both platforms closed on `timeout` every run.
- **THE PLATFORM DIFFERENCE IS IN THE INAPPBROWSER PLUGIN.** Android's `closeDialog` navigates
  the WebView to `about:blank`, killing the in-flight step-two request. iOS's `close` only
  dismisses the view controller; the WKWebView keeps running until torn down later, so the
  request finishes and writes `customerId`. **Not our code, not cookies, not the webview's
  storage.** Read out of `node_modules/cordova-plugin-inappbrowser/src/{android,ios}`.
- **TWO OF MY OWN 09-01 READINGS WERE WRONG, stated plainly.** (1) *"okta store empty — the
  SDK never finished its half"*: RC wraps okta-auth-js's store in secure-ls under
  **`@secure.s.okta-token-storage`**, and the census tested a bare `okta-` PREFIX, so it never
  looked at the real store. False negative every time it printed, on both platforms.
  (2) *"Keep me signed in" as the leading candidate*: it decides whether the NEXT sign-in is
  cookie-answered (the 08-09 measurement stands); it does not decide the header. Right
  observation, wrong mechanism — and I called it the leading candidate. (3) The cookie-store
  theory is retired: RC writes no session cookies (the only `document.cookie` in its bundle is
  axios's XSRF helper).
- **THE FIX (A): close on `customerId`, and on nothing else.** The bundle reports
  `rc-session { loggedIn }` — `!!customerId`, a BOOLEAN, never the id — on install and when it
  flips. `rcCloseAction` closes on `true`; a token, live or not, on any page, is no longer a
  reason; `isMidSignIn` and the settle timer are GONE, with a guard asserting exactly one
  `setTimeout` remains (the load watchdog). **No timer closes a sign-in window any more — the
  backstop WAS the defect.** If step two never finishes the bundle shows a notice in the window
  ("when you see your name at the top, tap Done") and reports `settle-timeout { held: true }`;
  that is the configuration the 08-31 hand bisect proved works. Already-signed-in pages close
  at once (RC boots with `customerId`, reported on install).
- **(B) THE CLAIM GATE FLIPS ON `rc-session`, NOT THE TOKEN.** `setRcCheck('verified')` moved
  out of the token branch; the token still carries the deadline. This is the owner's
  "verify they're in fact signed in" done against the fact RC itself uses.
- **(C) THE CENSUS READS THE KEYS RC DECIDES ON.** `rcLoggedIn`, `ssoToken` and `rcToken`
  reported separately (`storedToken: "jwt"` was satisfied by either and could not discriminate);
  okta keys matched ANYWHERE in the name; a populated secure-ls store reads `encoded`, a third
  shape between `jwt` and `none`. Route caps 14 → 18. `rcSessionReading` names the defect state
  — *customerId ABSENT beside an Okta token* — as itself.
- **EVERY OBSERVATION FITS**: the bisect (window left open → step two finishes → name shows,
  survives Done + reopen), cart POSTs succeeding on both (the API accepts the Okta token alone),
  the cart page prompting (interceptor, no RC token), RC's slow web tier making step two slow
  enough to lose the race.
- **NOT MEASURED YET:** that `customerId` was in fact absent after the failing Android run — no
  earlier census read it. The mechanism is from RC's source and #249's first hand-off reads the
  key directly; that run is the confirmation. **Guarded 14 ways**, each mutation grep-verified
  to apply: the host ignoring the decision, closing on a token again, growing a timer back, the
  gate flipping on the token, the id VALUE reported, the census reverting to a prefix, and more.
  `rc-session-close.test.mts` drives the real seam with a stub InAppBrowser and a fake clock.
- **TWO HARNESS DEFECTS CAUGHT BY RUNNING THEM.** The reporter's 500ms poll kept the sandbox
  alive and hung the suite (unref'd now); and `window` inside a vm context is the contextified
  proxy, not the raw sandbox, so a message with `source: ctx` correctly failed the reporter's
  cross-frame check — the guard was right and the stub was wrong.

### THE ANDROID HAND-OFF IS FIXED, AND A HUMAN FINALLY LOOKED AT THE CART (2026-09-02)
Five real-site hand-offs were run on the Pixel across the day, against #249 + #250 + #252.
**Three completed end to end**, one was interrupted by a CAPTCHA (fixed, below) and one was
lost to a wedged runner (below). The third of them produced the reading this repo has been
missing since 2026-08-13:
```
owner's screenshot of www.reservecalifornia.com/Customers/ShoppingCart
  -> TYLER in the header          <- customerId is written; RC knows who this is
  -> cart badge: 1
  -> the reservation itself, the unit and dates we carted
```
- **`cart read back: 1 entry` IS CORROBORATED FOR THE FIRST TIME, ON ANY PLATFORM.** Three
  separate entries in this file say it never has been — 08-29's table, the 08-24 iOS
  correction, and `docs/PLATFORM-PARITY.md` §3. **Those are now stale and are struck where
  they stand.** The line was always RC's answer to OUR question with OUR key; what was
  missing was anybody checking that RC's own page agreed, and now one has.
- **SO #249 AND #250 ARE THE FIX, AND THE MECHANISM READ OUT OF RC'S BUNDLE IS CONFIRMED
  FROM THE OTHER END.** `customerId` present, header populated, cart openable — the exact
  three things the two-step account predicts and the exact three that were absent on 08-29,
  08-30 and 09-01.
- **THE FIRST OF THE FIVE STILL FAILED, and the owner's own words are the diagnosis:**
  *"the test worked. after a RC load freeze that crashed the app and another problem
  loading. I came back later and it logged me in and successfully completed the hand-off."*
  **RC's app tier, not ours.** Same shape as the 08-31 bisect (three attempts, ~5 minutes)
  and the 08-30 mid-test outage. **At 08:00 that loses the site on its own, whatever we fix
  about login state, and NOTHING IN THIS REPO MEASURES IT.** It is the largest un-instrumented
  risk left on this path.
- **THE RC SESSION DIED WITHIN ~2 MINUTES OF EVERY QUEUE, FOUR FOR FOUR.** Queue a hold ->
  `dueHolds` serves it -> the runner takes the Chromium profile -> the keep-warm stands down
  and loses the live token. That is the 2026-08-30 `persistLiveToken` case, and the recovery
  is the ~11-minute stand-off (`RENEW_MIN_GAP_MS + 60s`) before the renewal retries. It cost
  a `test-login` on most runs. **Working as designed and still the thing that makes testing
  slow**; whether the persist actually reached the box is not established — that fix is
  bot-side and the box's sha was not checked against it.

### THE RUNNER HUNG IN THE PRE-RELEASE WAIT, ALIVE AND POLLING NOTHING (2026-09-02)
A test hold failed with `error: "no cart at release time — the hold runner did not pick it up"`
and `last_attempt_at` NULL — the 2026-08-07 dead-runner signature. It was not dead.
```
12:41:52   RC token acquired (live)
12:41:52   ready for 1 hold(s) — holding 77.0s until 2026-09-02T05:43:09 PT
           [nothing, ever]
```
- **`list-processes` SHOWED THE PROCESS ALIVE** (`node.exe rc-hold-runner.mjs`), so it WEDGED
  rather than crashed. `supervise.ps1` restarts on EXIT only, so nothing recovered it; the Fly
  `runner-watch` alarm needs a hold due inside 45 min and the sweep had just failed the only
  hold there was. **It would have sat there indefinitely.** `restart-rc` fixed it in seconds and
  the keep-warm minted a fresh 60-minute token unattended.
- **THE CANDIDATE, AND IT IS A CARRIED-ACROSS OMISSION.** After `await sleep(wait)` the runner
  calls `precartInPage`, which was a **bare `page.evaluate`**. `rc-token.evaluateWithin` was
  written on 2026-08-17 precisely because Playwright's evaluate has NO timeout; the keep-warm
  was fixed and `rc-hold-runner.mjs` used it **zero** times. A hazard recorded for one caller is
  not recorded — the same shape as `attemptLogin`'s `isLive()` short-circuit.
- **NOT PROVEN.** Nothing recorded which await it was, and a Playwright call failing to honour
  its own timeout against a dead browser is still live. **The bound is worth having either way:**
  an unbounded await in a loop with no wedge detector is a latent hang by construction, and the
  cost is the whole runner rather than one cart.
- **BOUNDED AT 60s** (`RC_CART_EVAL_TIMEOUT_MS`), not the module's 20: this is two POSTs from
  inside the page and normally takes seconds, but it runs at 08:00:00 against a web tier that
  has needed three attempts and five minutes to answer. **The bound catches a WEDGE, not a slow
  morning.** A timeout reports `timedOut` and the runner names it as OURS — a wedged browser is
  not an RC refusal — and the cart read-back still runs, because the POSTs may have landed and
  what was lost is the answer.
- ~~**STILL MISSING: the runner has no wedge watchdog at all.**~~ **BUILT 2026-09-03 (`96aee1e`)
  AND ON THE BOX** — `d341139` contains it, confirmed by `git-status` and not by
  `autocart.bot_version`, which is a hint. `RC_RUNNER_HUNG_MS` (4 min) in an **unref'd**
  `setInterval` (an interval holds the event loop open, and `--once` sets an exit code rather
  than calling `process.exit`), with the keep-warm's 08-17 breadcrumb — `mark`, which
  deliberately does NOT reset `lastTick`, or entering a step would postpone the watchdog that
  exists to catch a step never finishing — and `sleepTicking`, so a legitimate 3-minute
  pre-release hold is not read as a stall. **Releasing the profile lock on the way out is most
  of its value:** a wedged pass renews that lock from its own timer, so until the bail runs the
  keep-warm can never take the profile back and the RC session cannot be repaired.
  `worker/runner-wedge.test.mts`. Struck rather than deleted — *"the deeper fix is NOT built"*
  is exactly the sentence that gets quoted as a task, and it was, in two other files, for a day
  after it shipped.
- **BOT-SIDE, so it needs a box update before it means anything.**
  `worker/rc-cart-timeout.test.mts`, seven guards.

### A CHALLENGE BETWEEN THE EMAIL AND THE PASSWORD ABANDONED THE SIGN-IN (2026-09-02)
Owner: *"RC opened. captcha. completed. I had to finish sign in by hand."* The trace names it:
`email {}` then `login-result {ok:false, stage:"password", reason:"the password field never
appeared"}`.
- **THERE WERE CHALLENGE ARMS EITHER SIDE OF THE GAP AND NONE INSIDE IT.** Okta shows its
  challenge AFTER the identifier is submitted, and `chWait(CH_PW_SELS, 20000)` was a flat
  twenty seconds with no `chCaptchaVisible()` check — so a human solving a puzzle ran the clock
  out and the run reported a failure over a sign-in that was proceeding normally.
- **`chWaitPassword` extends the deadline ONCE, to a fixed point** (`CHALLENGE_WAIT_MS`, 5 min,
  matching the pre-fill arm). Refreshing it per tick is an unbounded wait wearing a timeout's
  clothes: an unsolved challenge must still end or the window never closes — 2026-08-12 by
  another door.
- **AND THE TAKEOVER ANNOUNCES ITSELF.** `captcha-cleared` is what says the script resumed;
  without it "it resumed" and "the user finished by hand" were the same silence.
- **TWO GUARDS WERE VACUOUS AND MUTATION TESTING FOUND BOTH.** The fixture staged the challenge
  at t=0, where the PRE-EXISTING pre-fill arm reports `captcha` — so deleting the new report
  left the suite green. The challenge now appears only after the email step. And the
  "unbounded" mutation was EQUIVALENT: inside `seenAt === null`, `Date.now()` and `seenAt` are
  the same instant, so it changed nothing; the real variant removes that guard.

### THE SIGN-IN'S "LONG PAUSE" WAS US HUNTING RC'S CONTROL ON OKTA'S PAGE (2026-09-02, #252)
Reported by the owner after three successful Android hand-offs: *"RC opens and goes to login
screen, there is a long pause before it clicks stay signed in and continues to password. I
feel like an end user will assume it's failing and start to do things that could affect the
login."* **He was right, and it was a defect rather than slowness.**
- **THE MECHANISM.** On Okta's identifier page there is no password field yet, so the script
  falls into `chWaitFor(chSignedIn() || chSignInControl(), SIGNIN_WAIT_MS)` — hunting **RC's
  OWN "Log in / Sign up" control on `signin.reservecalifornia.com`, where it cannot exist.**
  It burns the full **12 seconds**, reports `signin-missing`, and only then finds the email
  field instantly. Every scripted sign-in has paid this, on both platforms.
- **THE TRACE SAID SO AND NOBODY READ IT.** `signin-missing {candidates: 6}` — six anchors is
  Okta's sparse page, not RC's header, which carries dozens. The number that identified the
  page was in every trace since the field was added on 08-23.
- **THE COST IS NOT THE TWELVE SECONDS, IT IS WHAT THE USER DOES IN THEM.** A hand-off screen
  that looks hung is one where somebody starts pressing things, and this is the screen where
  that loses a campsite. Same reasoning as the 08-09 claim-copy rule.
- **FIXED BY WAITING FOR THE RIGHT THING PER HOST.** On Okta's host the FORM ends the wait; on
  RC's host only RC's control does, unchanged. **A host check rather than "race everything",
  deliberately:** RC's own pages carry a hidden login modal driving `customerLogin` — a
  DIFFERENT flow from the Okta SSO everything here depends on. `chFind` requires
  `offsetParent`, so a hidden modal cannot match today; accepting the form on RC's host anyway
  would put that one CSS change away from typing the credential into the wrong form.
- **EVERY BRANCH REPORTS `waitedMs` NOW.** The pause was invisible in the record — the miss was
  reported and the twelve seconds spent producing it were not. A number makes the next one a
  reading rather than a feeling.
- **`location` MAY BE ABSENT IN A SANDBOX**, and a throw here lands in the outer catch and reads
  as a failed sign-in. Read defensively, like the #250 callback guard beside it.
- **THE SANDBOX CLOCK IS WHAT MAKES THIS TESTABLE**: `loginSandbox()` advances a virtual clock
  by each `setTimeout` delay, so "it waited the full 12s" is an assertion rather than a slow
  test. Six mutations, each grep-verified to apply.
- **ONE GUARD WAS VACUOUS AND MUTATION TESTING FOUND IT.** "An already-signed-in session
  short-circuits" staged a session live BEFORE the run, so it returned at the top-of-run check
  and never reached the signed-in arm *inside* the wait predicate — deleting that arm left it
  green. Replaced with a session that arrives DURING the wait, which is the case the arm exists
  for (the token lands with RC's first authenticated call, after `loadstop`).
- **A WEBVIEW-FREE LOGIN WAS CONSIDERED AND REJECTED, and the reasoning is worth keeping.**
  RC's bundle shows what it would take: build Okta's `/authorize` with client_id, redirect_uri,
  state, nonce and a PKCE challenge, drive Okta's IDX API with the credentials, exchange the
  code, call `GetSSOLoggedInUser`, then write `ssoAccessToken`, `accessToken`, `customerId`,
  `customerName` and `customerDetail` into the webview's storage. Three specific objections:
  **a CAPTCHA becomes unhandleable** (no page to solve it on — a human holding the phone is
  precisely why this path survives where the bot's does not); **scripted API sign-ins are what
  provoke the anti-bot posture** that already cost this household IP twelve hours on 08-06; and
  it breaks silently whenever RC changes a step, with the failure landing at 08:00.
  **THE BETTER SHAPE OF THE SAME IDEA IS "open the window and close it at once when RC comes
  back already signed in"** — a cookie-answered sign-in was measured at **11 seconds and +24 MB**
  against twelve minutes for the password path (08-21). Not built; wants measuring on both
  phones rather than assuming.

### #249 WAS NECESSARY AND NOT SUFFICIENT: OUR SIGN-IN SCRIPT WAS CLICKING "LOG IN" ON THE CALLBACK PAGE (2026-09-01, #250)
The first Android run on #249 held the window open — the new notice fired at 30s — and RC
still rendered signed out, on its HOME page. Two readings from the trace, and the second is
ours.
- **THE KEEP-SIGNED-IN CANDIDATE IS REFUTED, EXACTLY THE WAY THE 09-01 ENTRY SAID IT WOULD
  BE.** `keep-signed-in {at:"email", boxes:1, ticked:true}` — the box was on screen, it was
  ticked, and the header was empty. It decides the NEXT sign-in's cost and nothing about the
  header. Stop citing it for this defect.
- **`signin-open {}` ON `/login/callback`, BOTH PLATFORMS.** `afterLoad` re-runs the sign-in
  script on every navigation (deliberately — the 08-16 fix). On the callback it found no form,
  no session yet (`ssoToken: none`, `@secure.s.okta-transaction-storage` present = exchange in
  flight), and RC's "Log in" control — and clicked it, navigating to Okta mid-exchange. Okta
  answered from the cookie, a SECOND callback followed, and the two documents are in the trace
  (`opens: 64`, `opens: 65`). The iOS 08-31 trace shows the same two callbacks.
- **WHY ANDROID LOST AND iOS DID NOT, and it is timing, not platform.** On Android the first
  exchange had already COMPLETED before our click (`token ageSec:1` captured on callback #1 —
  i.e. step two's request left), so `ssoCustomerName`/`ssoAccessToken` were persisted. The
  second callback then booted with `isSsoLoggedIn: true` and no RC token — the state in which
  RC's own request interceptor answers a request needing RC's token with **`customerLogOut`
  and `Qt.navigation("/")`**: the home page in the screenshot, the "Before booking, please
  sign in" notice, and the 56 authenticated calls the home page makes. On iOS the click landed
  BEFORE the first exchange completed (no token on callback #1), so callback #2 booted clean.
  Which side of the exchange our click lands on is a race; iOS won it. **Candidate mechanism
  for the second half; the click itself is measured.**
- **FIXED TWO WAYS.** The sign-in script does nothing on `/login/callback` and reports
  `callback-in-flight` (a named terminal path through `done()` — the 08-16 rule); and
  `afterLoad` returns null for the callback so a cached older bundle is never handed the
  credential there. **`location` may be absent in a sandbox** — the guard threw a
  ReferenceError into the outer catch on its first run and read as a failed sign-in.
- **AND STEP TWO IS OBSERVED NOW.** `rc-inject.js` reports every `/SSO/` endpoint response as
  `rc-api { path, status, rcResponse }` — origin+pathname only (the query carries the email
  and Okta subject), one number read out of the body and the rest never kept. `rc-session`
  carries `sso` beside `loggedIn`, so "ssoAccessToken appeared then vanished with customerId
  never written" — customerLogOut firing — is a line in the readout instead of an inference.
- **THE TEST HOLD WAS LEFT `carted`**; `expireStaleHolds(45)` releases it. Nine mutations,
  each grep-verified to apply. **`\/` INSIDE A TEMPLATE LITERAL COLLAPSES TO `/`** — a regex
  written that way in the emitted sign-in script produced `/^/login/callback/i` and stopped
  the entire served bundle parsing; the suite caught it, a string test replaced it.

### A HOLD OFFER WAS ONE ROW PER CAMPSITE, FOR EVER (migration 074, 2026-09-04)
Reported by the owner: *"We currently only offer a hold once to users, and if the site
becomes available again they dont see it."* Exactly right, and the mechanism was one index.
- **`rc_hold_requests_unique` WAS (watch_id, unit_id, arrival_date) — NO RELEASE IN IT.**
  `offerHold`'s `ON CONFLICT (…) DO UPDATE … WHERE status = 'offered'` therefore still
  matched once the row went terminal, the DO UPDATE refused, `offerHold` returned null, the
  poller withheld the button, and **nothing existed for the watch page to list.** One row
  was the whole history of a (watch, unit, arrival) for the life of the watch:
  a decline, a lapse at 08:00, or a **transient RC cart failure** each retired that campsite
  permanently. Production carried **50 `expired` and 9 `failed`** rows in exactly that state.
- **The `WHERE status = 'offered'` guard was never the bug and must stay.** Within one
  release a re-alert still has to leave a tapped row alone. Widening the key does not
  replace it; that is mutation-tested separately.
- **A DECLINE STILL STANDS FOR ITS OWN RELEASE**, which is what the user said no to — and
  what keeps the X on an offer meaning anything. Only a *new* release is a new offer.
- **THE MIGRATION AND THE CODE ARE TIGHTER THAN USUAL.** `ON CONFLICT (a,b,c)` needs an
  index on exactly (a,b,c), so between the index widening and the new `offerHold` deploying
  the old upsert raises *"no unique or exclusion constraint matching the ON CONFLICT
  specification"*. **That fails CLOSED** — caught, null, alert sent with no button, exactly
  as when the bot is absent — which is why the gap was acceptable. Applied with zero
  offered/requested/carted rows in the table.
- **THERE WERE TWO MORE HAND-ROLLED COPIES OF THAT CONFLICT TARGET, and the second is the
  dangerous one.** `worker/rc-client-reports.test.mts` (a fixture — caught loudly by CI) and
  **`scripts/rc-test-hold.mts`**, which queues a REAL hold on a REAL campsite and is on
  `docs/LANES.md`'s SERIAL list. **Nothing runs that script in CI**, so it would have thrown
  the next time somebody set up a live test, at whatever hour that happened to be.
  `hold-per-release.test.mts` now asserts every `ON CONFLICT` on this table names the same
  four columns.
- **AND IT EXPOSED A NEIGHBOUR'S FIXTURE BUG.** `rc-holds.test.mts`'s *"re-offering the same
  opening does not duplicate it"* called `pacific(120)` **twice** — two strings formatted to
  the second from two reads of `Date.now()`. With the release in the key those are two
  different releases and correctly get two rows: **the fixture was describing "the same
  opening" with a value that was not stable across the two calls**, and the assertion only
  held before because the release was not in the key at all.
- **MIGRATION NUMBERING: the side lane took 072 AND 073 out of MAIN's block** (PR #258,
  2026-09-03), which is why this is 074. Main's remaining block is **075-079**.

### HOLDS MOVED INTO THE WATCH CARD, AND A QUEUED ONE CAN BE CALLED OFF (2026-09-04)
- **WHAT MOVED: `offered` and `requested` only**, as two collapsed bars with counts in the
  summary. **`carted`/`claiming`/`released` STAY at the top of the page** — a real campsite
  in a real cart with ~15 minutes on it, and stacking tomorrow's decisions above it pushed
  the thing with a fuse further down the page the busier a user got.
- **`src/lib/hold-placement.ts` IS THE COMPLEMENT, NOT AN URGENCY TEST.** The panel keeps
  whatever no card will draw. That one phrasing is what keeps the **orphans** — an offer
  whose watch was deleted, or every hold when `/api/watches` fails while
  `/api/rc-holds/mine` succeeds — and it is why the panel still renders in `WatchesList`'s
  error and "no watches yet" branches. A totality test asserts every hold appears **exactly
  once**; an unrecognised status shows up in the panel rather than vanishing.
- **THE X ON A QUEUED HOLD IS A SECOND VERB, NOT A WIDER `declineHold`.** This file already
  said why `requested` had no control: *"retracting it is a CANCEL, a different act with a
  different confirmation, and getting it wrong at 07:59 loses a campsite."*
  - **`cancelHold` RETURNS THREE OUTCOMES AND TWO ARE REFUSALS THAT MEAN DIFFERENT THINGS.**
    `too-late` (inside `HOLD_CANCEL_CUTOFF_MIN`) vs `not-queued` (it moved on). Collapsing
    them would tell somebody at 07:55 that their hold had already been carted — a wrong
    story about what is happening, which is the class of lie that kept the control off.
  - **THE RACE IS SAFE, SO THE CUTOFF IS ABOUT HONESTY.** `markCarted` is
    `WHERE status <> 'carted'`, so a cart landing after a cancel flips the row to `carted`
    **with its cart key** and `expireStaleHolds` releases the site. Nothing is stranded —
    asserted, not argued.
  - **`HOLD_CANCEL_CUTOFF_MIN` IS DERIVED FROM `RC_HOLD_FEED_MAX_LEAD_SEC`**, which the feed
    route now reads instead of its own literal 600. Two copies of that number is how
    `nextHoldRelease` came to disagree with `dueHolds` about whether a hold still existed.
- **`HoldRow` IS ONE DEFINITION NOW.** The panel and the card both draw it; `variant` changes
  chrome and nothing else. A second copy of the row that decides whether somebody trusts the
  bot at 08:00 is how `content-rc.js` spent months telling users to click a cart icon.
- **THE CARD HAD TWO SOURCES FOR THE SAME FACT AND THEY DISAGREED.** `pending_holds` (from
  `/api/watches`, fetched once) and the `holds` prop (from `/api/rc-holds/mine`, polled every
  20s) are the same rows under the same predicate on different clocks — so a cancel emptied
  the dropdown while the badge above went on saying "Holding #96 · 8 AM" until the next page
  load. The live list wins when the page supplies it; `pending_holds` stays the fallback for
  a card rendered without the page around it.
- **TWO EXISTING GUARDS BROKE OVER THE EXTRACTION AND WERE RE-ANCHORED, NOT RELAXED.**
  `holds-panel-layout` and `autocart-beta` both sliced into `HoldsPanel.tsx` for markup that
  now lives in `HoldRow.tsx`; left pointing at the old file **both would have read nothing
  and passed.** Each was re-verified failing against the regression it exists for. ~27th time.
- **BOTH BARS ARE CLOSED BY DEFAULT**, which is what was asked ("a drop down bar for both")
  and what reclaims the space the report was about. The badges above already carry the count
  and the release time. Preset `ch-watch-holds` renders the card; `ch-holds` now renders what
  the panel keeps, including an orphan.
- **AND I PUT BACKTICKS IN A SQL COMMENT INSIDE A TEMPLATE LITERAL** — the trap recorded in
  the park-watch entry, in the same session that read it. `tsc` catches it; nothing else does.

### A CAMPSITE WAS LOST TO A 12-SECOND RETRY GAP, AND THE FIX IS A BURST (2026-09-03, #261)
`#L005` at Leo Carrillo was tapped for the 08:00 PT release and never carted. **Nothing was
broken** — the runner was healthy and asked RC about a hundred times across the 20-minute
grace, and RC refused every one with *"The unit is not available for the date(s) specified."*
- **THE NUMBERS ARE OURS, NOT A GUESS.** Carts at quiet, arbitrary release times land at
  T+1s to T+4s; the two at real 08:00 PT releases landed at **T+3s** and **T+6s**; and the
  gap between our retries, measured from the runner's own log, is **min 10s, MEDIAN 12s, max
  24s**. The same morning the poller watched `rc-542::42527` open at 08:00:13 and be gone by
  its next 15-second cycle. **A 12-second gap sitting on top of a window that closes in
  seconds is the whole loss.**
- **THE OWNER'S OBJECTION IS WHAT PRODUCED THIS.** I had reported the retry cadence as
  adequate; *"15 seconds could easily be enough for someone else to cart the site before
  us"* is what made me measure the gap rather than assume it. **They were right and the
  reasoning that said otherwise was mine.**
- `scripts/auto-cart-bot/cart-burst.mjs`: **`BURST_LEAD_MS` 15s before the release through
  `BURST_WINDOW_MS` 30s after, retrying every `BURST_GAP_MS` (500ms)** against a shared
  `BURST_BUDGET` of 40 attempts. Outside that window the old cadence stands — the burst buys
  the 45 seconds that matter and nothing else.
- **THE LEAD IS THE CONTESTED HALF, AND IT IS DELIBERATE.** See the entry below: we do not
  know that RC never releases early, so opening the lane at T−15s is the only way to be
  asking when it does. The cost of an early ask is a refusal, which is free; the cost of not
  asking is the site.
- **`releaseMoment` is fixed BEFORE the sleep, never recomputed after it** — a deadline
  computed on the far side of a wait is a deadline measured from the wrong instant.
- **THE LOAD IS NEGLIGIBLE** and that was checked rather than waved through: ~60 requests
  across 45 seconds, from the ONE residential IP the bot already uses, once per release.
- **ON THE BOX SINCE 2026-09-04 03:20 UTC** (`d341139`, `bot_commit` confirmed, heartbeat
  live). Untested in anger: the first real 08:00 release with the burst live is the reading.
- `worker/cart-burst.test.mts`, 21 guards. **Two neighbouring guards broke over unchanged
  behaviour and were re-anchored, not relaxed** — `per-hold-cart` pinned the failure report's
  entire expression, and `runner-wedge` pinned `sleepTicking(wait)` by argument; the second
  re-anchor made the negative STRONGER (`await sleep(` rather than `await sleep(wait)`).

### "RC NEVER RELEASES EARLY" IS UNPROVABLE WITH THE INSTRUMENT WE HAVE (2026-09-03)
> **ANSWERED 2026-09-04, AND THE ANSWER IS THAT IT DOES.** One facility's flip bracket is
> **entirely before T** — see "IT RAN, AND RC RELEASES EARLY" two sections down. Everything
> below stands as written: it is about what the POLLER can and cannot see, and that is
> unchanged. It is the reason a second instrument had to be built.

Asked whether a site has ever become available before its predicted release. I answered
**twice** and was wrong the first time; the correction is the finding.
- **THE READINGS.** Eight poller transition alerts for held units we never carted (so each
  is a first sighting rather than a re-alert after our own release): `#133` T+3s, T+3s, T+4s,
  T+4s; `#L045` T+10s; `#L034` T+13s; `#54` T+13s; `#78` T+28s. **Every one at or after T.**
- **AND THAT IS NOT THE SAME AS "NEVER EARLY".** The poller samples every **fifteen
  seconds**, so an alert at T+3s means only that the first sample after the flip landed
  there — the flip is anywhere in **(T−12s, T+3s]**. Four of the eight sit entirely inside
  that blind spot. **The instrument's resolution swallows the question**, and my first answer
  reported the sampling artefact as the finding.
- **THE CART PATH CANNOT ANSWER IT EITHER.** The runner waits out `msUntilRelease` by design,
  so the project's ENTIRE early-cart record is **one observation, 2026-08-08, at 85 seconds
  early, refused.** That bounds 85s. It says nothing about 5s.
- **CLOCK SKEW IS RULED OUT, MEASURED.** The owner's *"RC clock vs our clock could easily be
  off a few seconds"* was worth taking seriously and does not hold: RC's edge `Date` header
  agreed with ours to within **1 second, 5 for 5**. So the uncertainty is our SAMPLING, not
  our clock — a distinction that changes which fix is worth building.
- **THIS IS WHY THE BURST OPENS AT T−15s.** Not because early release is established, but
  because it is *not excluded* and the cost of asking early is a refusal.

### THE RELEASE WINDOW IS BEING MEASURED DIRECTLY (2026-09-04, #264) — AND IT ANSWERED
`scripts/rc-release-window.mts` answers the question above at **2-second resolution** instead
of fifteen, by polling RC's grid directly across a release.
- **A BATCH IS WHAT MAKES IT CHEAP.** One `/search/grid` call returns the WHOLE facility —
  69 units in 0.64s, measured — and at Leo Carrillo **48 locked nights across three
  facilities release at the same instant**. One poll per facility per tick therefore measures
  every releasing unit at once: a single morning yields more flip times than a month of
  poller alerts.
- **IT TALKS TO RDR DIRECTLY, DELIBERATELY.** `fetchGrid` routes through `/api/rc-proxy` —
  Vercel — because Fly cannot reach the California RDR host. Using it here would spend
  hundreds of invocations from the same lambda IP the poller uses, and those WAFs meter per
  IP: **the instrument would degrade the thing it measures.**
- **THREE RULES, EACH A WAY IT COULD LIE.** A failed poll is **UNKNOWN, never "free"** (a 403
  recorded as availability manufactures a flip at exactly the moment the answer matters); a
  flip is a **BRACKET** (`locked at X, free by Y`), never a midpoint, because a midpoint
  invents precision the cadence does not have — which is the error the script exists to test;
  and it **refuses a verdict it has not earned** (`THE QUESTION WAS NEVER REACHED`).
- **THREE DEFECTS FOUND BY RUNNING IT, none by reading it.** (1) **The filter in the comment
  was not in the code** — it claimed to track only units whose lock names THIS release, over
  code that tracked every locked night; locks releasing next week would have sat "never
  freed" for ever and dragged the denominator. A comment asserting a filter that is not
  there, **in the instrument built to stop exactly that.** (2) It slept to the window's START
  before checking the END had passed, so a closed window parked for ten hours. (3) *"We could
  not look"* and *"there is nothing there"* printed the same sentence — and the likeliest
  cause is the documented `NODE_USE_ENV_PROXY=1` omission, whose failure mode looks exactly
  like an empty facility. **It cost me one wrong diagnosis before that message was fixed.**
- **REHEARSED LIVE ten hours early**: 48 nights enumerated, 57 polls, 0 unreadable, 0 flipped
  — the correct answer at that hour. **Flip detection itself is untried and can only be tried
  at a release.**
- ~~**SCHEDULED: Routine `trig_012K7iCrj1J9KspyqGucZSHC`, one-shot, fires 2026-09-04 14:50 UTC
  (07:50 PT).**~~ **THAT FIRING MEASURED NOTHING AND REPORTED `SUCCEEDED`** — see "THE ROUTINE
  FIRED, REPORTED SUCCEEDED, AND MEASURED NOTHING" below. The same trigger is now a **daily
  cron at 07:56 PT** through 2026-09-11. Struck rather than deleted: read as current it says a
  measurement was scheduled and taken, and it was scheduled and lost.
- **THE OWNER NAMED ITS LIMIT AND WAS RIGHT:** *"I don't think this will give us a good tell
  on how long each site stays free before someone takes it — there are too many sites
  available to make this a high popularity site."* It measures **when RC lets go**, not **how
  long a site survives**; Leo Carrillo in December is not contested. Do not read a long
  survival time there as evidence about a contested morning.


#### IT RAN, AND RC RELEASES EARLY — 45 NIGHTS, 582 POLLS, 0 UNREADABLE (2026-09-04)
The first direct reading. It retires the question the entry above says the poller structurally
could not answer, and it does it with a bracket that never touches T.
```
EARLIEST free  -0.2s   MEDIAN  +0.5s   LATEST  +1.1s
rc-583   locked -2.2s -> free -0.2s    8 nights   <- the whole bracket is NEGATIVE
rc-539   locked -1.6s -> free +0.5s   21 nights
rc-542   locked -0.9s -> free +1.1s   16 nights   <- the facility #L034 is in
45 of 47 nights flipped - 2 never freed - 4 re-taken inside the window, quickest within 61.5s
```
- **ONE FACILITY SETTLES IT AND THE OTHER TWO DO NOT.** `rc-583`'s last locked observation is
  T−2.2s and its first free one is T−0.2s, so the flip lies in **(−2.2s, −0.2s] — entirely
  before the release.** `rc-539` and `rc-542` straddle T and say nothing either way. **Quote
  rc-583, not the median**: a median of +0.5s across three facilities is an average of one
  proven-early bracket and two undecided ones, and reads as "on time" when the finding is the
  opposite.
- **SO THE BURST'S T−15s LEAD IS JUSTIFIED ON EVIDENCE NOW, NOT ON "NOT EXCLUDED".** #261
  opened the lane early because early release was *not ruled out*; it is now **observed**. Do
  not shorten the lead as a tidy-up — the 15s exists to be asking when this happens, and the
  cost of an early ask is a refusal, which is free.
- **FACILITIES FLIP ATOMICALLY, AND THAT IS THE NEW FACT.** Every night in a facility shares
  one bracket, and the three facilities are separated by ~1.3s from each other. So RC is not
  releasing per-unit — it is flipping a facility's whole locked inventory in one action, and
  the three ran in sequence. That is why a single grid poll per facility measures every
  releasing unit at once, and it is what makes the instrument cheap.
- **`#L034`'s OWN FLIP IS INFERRED, NOT MEASURED — labelled because the temptation is real.**
  Its three nights were **not** among the 47 tracked, so there is no direct bracket for it.
  What there is: it sits in `rc-542`, whose bracket is (−0.9s, +1.1s], and it **carted at
  T+1.44s**. Under facility-atomicity the site was free somewhere between 0.34s and 2.3s
  before the cart landed. **That is inference resting on a finding from the same run**, which
  is fine to record and wrong to quote as a measured flip time.
- **T+1.44s IS THE FASTEST CART AT A REAL 08:00 RELEASE AND IT IS ONE OBSERVATION.** The two
  before it were T+3s and T+6s under the 12-second retry gap. Consistent with the burst
  working; not proof that it is what did it. A second morning tells the difference.
- **THE 4 RE-TAKEN NIGHTS ARE NOT CLEAN EVIDENCE OF CONTENTION.** Free then locked again
  inside the window is what a competitor looks like — and it is also what **our own cart**
  looks like from the grid's side. The run cannot separate them, and at least one of our own
  carts landed in that facility in that window. Do not report "someone else took four sites
  in a minute" from this.
- **THE OWNER'S RECORDED LIMIT STILL BINDS.** It measures **when RC lets go**, never **how
  long a site survives**. The 61.5s figure is the shortest observed gap to a re-lock in one
  window at one park, not a survival time.

#### THE ROUTINE FIRED, REPORTED SUCCEEDED, AND MEASURED NOTHING (2026-09-04)
The reading above nearly did not happen, and the failure is the house shape arriving in the
scheduling layer.
```
14:50:14Z  trig_012K7iCrj1J9KspyqGucZSHC fires
14:52:22Z  run finishes - ROUTINE_RUN_STATUS_SUCCEEDED
14:58:30Z  the measurement window would have opened (T-90s)
```
- **IT REPORTED SUCCESS SIX MINUTES BEFORE ITS OWN WINDOW OPENED.** The fired agent could not
  hold the script in the foreground — **the Bash tool's ceiling is 600 seconds** and a 07:50
  fire needs ~15 minutes of wall clock — so it backgrounded the run and ended its turn. **A
  fresh-session Routine's container is reclaimed when the turn ends**, taking the backgrounded
  process with it. Nothing errored anywhere.
- **`SUCCEEDED` MEANT ONLY "THE AGENT'S TURN ENDED WITHOUT THROWING".** Same family as
  `status = 'sent'` meaning only "Twilio returned 2xx", one layer further out: the scheduler's
  own success signal cannot see whether the work happened.
- **CAUGHT BY ASKING, WITH THREE MINUTES TO SPARE.** The owner asked whether the monitoring was
  set up at 07:54; the run was already logged `SUCCEEDED` and the answer looked like yes. It
  was re-run by hand in time. **Do not read a green Routine run as a measurement taken** — read
  the output.
- **FIXED BY MOVING THE FIRE TIME, NOT BY BACKGROUNDING BETTER.** 07:56 puts the whole run at
  ~8 minutes, inside the ceiling, so it can be foreground. The prompt now carries
  `run_in_background: false, timeout: 600000` and names this failure so the next agent does not
  reinvent the workaround that caused it.

#### AND ON 2026-09-10 ALL THREE FACILITIES CLOSED BEFORE T — the median is negative now
The 09-04 reading rests on ONE facility's bracket (`rc-583`, −2.2 → −0.2) while the other two
straddle T, which is why that entry's reading rule is *quote the negative bracket, never the
median*. **Today every facility is negative, so the caveat is no longer load-bearing:**
```
rc-583   locked -4.2s -> free -2.2s   (9 nights, across 3 different campsites)
rc-539   locked -3.5s -> free -1.5s   (5 nights, across 2)
rc-542   locked -2.9s -> free -0.9s   (1 night)
EARLIEST -2.2s · MEDIAN -2.2s · LATEST -0.9s      15 of 15 flipped · 315 polls · 0 unreadable
```
- **15 OF 15 NIGHTS WERE FREE BEFORE THE PREDICTED RELEASE**, and **earliest, median and latest
  are all negative** — so this is the first day on which the finding does not depend on picking
  the right facility out of three. **Early release is now three-for-three across independent
  facilities on one morning**, on top of one-for-three on 09-04.
- **FACILITY-ATOMICITY HELD AGAIN, and more strongly than on 09-04.** Each facility's nights share
  a single bracket **to the poll** — rc-583's nine span three different campsites and rc-539's
  five span two — and the three facilities are separated by ~0.7s from one another. Same staggered
  sequence, on a different morning, with different inventory.
- **IT IS DIRECT SUPPORT FOR THE CART BURST'S T−15s LEAD.** Every observed flip lies between
  **−4.2s and −0.9s**, so a lane that opened at T would have been late to all fifteen. `#261`
  opened the lane early when early release was only *not excluded*; it is now measured twice.
- **THE ONE RE-LOCK IS NOT CONTENTION AND IS NOT REPORTED AS SUCH.** `rc-583 #102 @2026-09-25`
  was taken again at **+78.2s**. From the grid our own cart and a competitor's are identical, and
  that rule does not relax because the number is interesting.
- **Recorded: 3 facility rows.** With 09-04 and 09-09 that is three measured releases in the
  table; the Routine has one firing left (09-11) and self-disables on 09-12.

#### IT IS A DAILY CRON FOR A WEEK NOW (2026-09-04) — with two gaps recorded, not papered over
Owner: *"make it a daily cron for a week then we should have plenty of info."*
**`trig_01MDTcr2WFDqX6dCsi7gVDPG`** is `56 14 * * *` (07:56 PT) and it **self-disables on any
Pacific date ≥ 2026-09-12.** First RECORDED fire is **2026-09-06**, not 09-05.
- **THE ID CHANGED ON 2026-09-05 AND THE OLD ONE IS DEAD.** `trig_012K7iCrj1J9KspyqGucZSHC`
  fired into a fresh session with **no repository attached**, so it could not run the script at
  all — it was replaced with a Routine bound to a session that has the checkout. **Every earlier
  mention of that id in this file is historical**, and `mcp__Claude_Code_Remote__update_trigger`
  cannot change `persistent_session_id`, so the fix had to be a delete-and-recreate. This is the
  second time an ID written into this file went stale within days (issue #181 was the first):
  **read `list_triggers` before acting on any trigger id here.**
- **`rc_release_readings` READING ZERO ROWS ON 2026-09-05 IS THE EXPECTED STATE, NOT A FAULT.**
  The replacement's first firing is 09-06 07:56 PT. `scripts/rc-release-readout.mts` says as
  much in its own empty-case text; do not read it as the `--record` path being broken.
- **THE DATE IS NO LONGER HARDCODED** —
  `--release=$(TZ=America/Los_Angeles date +%F)T08:00:00`. A daily Routine carrying a fixed
  date measures the same morning seven times and reports `THE QUESTION WAS NEVER REACHED`
  six of them, which reads as the instrument failing.
- **THE INDEPENDENT BACKSTOP MAY BE INERT, AND IT SAID SO ITSELF.**
  `trig_01FtjDWmMS8PvGQ8z1TSYbHQ` is a one-shot at 2026-09-12 14:00Z whose only job is to
  disable the measurement Routine from outside. Its create call returned *"this trigger stores
  no MCP connectors, so the sessions it fires will run without connector (`mcp__<server>__*`)
  tools"* — and `mcp__Claude_Code_Remote__update_trigger` is the one tool it needs. **So the
  load-bearing stop is the self-disable inside the measurement prompt, and the backstop is a
  hope.** Recorded rather than assumed, because a backstop that reports success at doing
  nothing is the fix-present-and-inert shape this file has now paid for six times.
- **NOTHING PERSISTS THE READINGS, AND THAT IS THE REAL GAP.** Seven runs print to stdout in
  seven ephemeral fresh sessions. There is no table, no file that survives the container, and
  no way to put day 1 beside day 7 except opening seven transcripts by hand — which is exactly
  how the 08-23 attributions were lost to a 16,000-character `tail-log` window before PR #169
  moved readings into Postgres. **"Plenty of info" needs the readings COMPARABLE, and they are
  not.** The fix is a small table plus a `--record` flag on `rc-release-window.mts`; it is
  **NOT BUILT**, deliberately, and raised rather than assumed.
- **THE 09-04 BASELINE IS IN THE PROMPT** so each run can be read against it rather than in
  isolation, along with the four reading rules above (quote the negative bracket, not the
  median; facility-atomic; re-locks are not contention; unreadable is never free).

##### THREE FIRINGS, THREE LOSSES, AND THE THIRD IS THE ONE THE 07:54 MOVE WAS MEANT TO STOP (2026-09-07)
`rc_release_readings` still holds **zero rows**. 09-05 was lost to a fresh session with no
repository; 09-06 to a bound session mid-turn; **09-07 to a bound session mid-turn again**, which
is the failure the move to 07:54 and `--after=120` was bought to prevent.
- **THE DRAIN TOLERANCE IS ~3.75 MINUTES AND A BUSY TURN IS LONGER.** The message arrived
  **14:54:51Z**; the window ran **14:58:30 → 15:02:00Z**; the session was inside a single tool
  call waiting on `npm run verify`. The run finally started at **15:02:09Z — nine seconds after
  the window closed.**
- **AND NO "NOTIFICATIONS PENDING" NOTICE EVER SURFACED.** The only system messages in that
  span were `<task-notification>` blocks for backgrounded Bash commands. The Routine's message
  was found by calling `ReadNotifications` **on my own initiative**, eight minutes late. So a
  bound-session Routine can sit queued, silently, behind one long tool call — and "it fires
  into its own session and needs nothing from here" (which is what the session was handed) is
  **false and is what made it safe to ignore.** It fires into THIS session and needs the turn.
- **RUNNING IT AFTERWARDS CANNOT ANSWER THE QUESTION, and the script says so rather than
  guessing.** At 15:02:09 all three facilities read `0 locked night(s) for this release` (with
  6 rc-539 nights locked for other times) and it refused: `THE QUESTION WAS NEVER REACHED`.
  **That is not "RC released nothing"** — nights released at 15:00 no longer read as locked, so
  after T the two are indistinguishable. Which is precisely why it must run before T.
- **DO NOT TWEAK THE SCHEDULE AGAIN.** That instruction is already recorded, it has now been
  paid for a third time, and moving the fire earlier spends the 600s Bash ceiling one for one.
  **The recorded remedy is to RUN IT BY HAND**, on a day somebody is present, before 07:58:30 PT.
- **THE STRUCTURAL FIX IS A DECISION, NOT A TIDY-UP.** A fresh session per fire has the repo
  problem (09-05); a bound session has the busy problem (09-06, 09-07). What would close it is
  a fresh session **with the checkout attached**, which is an environment question nobody has
  answered. Raised, not chosen.

### RC'S OWN LOAD IS INSTRUMENTED NOW (2026-09-04)
Three gaps in the hand-off readout, all the house shape — a fact produced and thrown away.
- **`never-loaded` and `load-error` had no reading.** `closeReasonReading` knew `token`,
  `settled`, `timeout` and `session`; the two states meaning *RC's app never rendered* fell
  through to the unrecognised branch, so **the largest un-instrumented risk on this path was
  the one outcome the readout could not name.** Both are `warn` now.
- **A SUCCESSFUL load reported no TIME.** `rc-handoff.ts` stamps `openedAt` before
  `iab.open`, and reports `rc-load { ms }` on the **first** `loadstop` only. `rcLoadReading`
  returns `null` for a non-number — **never 0**, which would read as an instant load.
  `RC_SLOW_LOAD_MS` (8s) is the line between `info` and `warn`.
- **AND THE ORDERING IN THE COMMENT WAS NOT IN THE CODE**, for the second time this session:
  `loadstop` claimed `everLoaded`/`disarmLoadTimer` preceded the injection and they did not.
  A mutation caught it only after the guard was re-anchored on an index comparison rather
  than on presence.
- **`src/lib/rc-load-stats.ts`** aggregates across runs and **refuses a distribution with no
  samples**; the median is an OBSERVED value (lower-middle), never interpolated — inventing a
  number between two real ones is the same error the flip-bracket rule forbids.
- **`src/lib/rc-hold-outcome.ts` gates on `tapped` (`requested_at`), NOT on status.** The
  status axis produced a false *"a race we lost"* on its first production run: a hold nobody
  tapped is not a race, and reporting it as one manufactures a competitor.

#### AND THE ALL-CLEAR HAD NO FLOOR — ONE HAND-OFF SAID WHAT FIFTY WOULD (2026-09-06)
The corpus was read for the first time, over thirty days rather than the default twenty-four,
and the instrument built to answer *"one hand-off in three or one in fifty?"* answered it from
a sample of **one**:
```
RC LOAD: 2 timing(s) across 1 of 11 hand-off(s) — median 0.2s, slowest 0.6s
  (10 hand-off(s) reported no timing — an older client bundle or a plain browser)
  No hand-off failed to render RC in this window.        <- over ELEVEN hand-offs, ONE of which could speak
```
- **THE SIZING IS THE FINDING, AND IT IS SMALLER THAN ANYONE HAD ASSUMED.** Eleven hand-offs
  in thirty days, **seven of them TEST fixtures**, and the timing instrument landed on
  2026-09-03 — *after* nearly every hand-off that has ever happened. So the standing question
  (**how often does RC's own web tier lose us a hand-off?**) has a corpus of **one timed
  hand-off, zero failures**, and at ~1 real hand-off every few days it needs weeks, not days.
  `docs/NEXT-SESSION.md` quoted *"median 0.2s, slowest 0.6s"* as *"the first data points are
  in"*; that is two samples from a single session and it has not moved since.
- **`else if (s.samples > 0)` WAS THE WHOLE BUG.** The module's own header says *"the
  denominator is the point"* and applies that rule to the DISTRIBUTION (it refuses a median
  with no samples) — and then gated the all-clear on there being any sample at all. **This is
  `SMS_MIN_SAMPLE = 10` ("2 of 3 dropped is 67% and means nothing"), `MIN_RENEWAL_TESTS`, and
  `recgov-429-profile.mts` refusing until all 24 hours have data — the rule written down three
  times and not applied in the fourth place that needed it.**
- **THE FLOOR IS ONE-DIRECTIONAL, AND THAT ASYMMETRY IS THE POINT.** An **observed** failure is
  a fact at any sample size and still reports at any count; an **absence** of failures is only
  evidence once enough hand-offs could have produced one. Applying the floor to both would
  suppress the reading somebody has to act on, which is the worse error by a distance —
  pinned by its own test, and the mutation that adds the floor to the outage branch is the
  one that matters.
- **THE DENOMINATOR IS `runsTimed`, NOT `handoffs`.** A close reason only reaches us from a
  #249-or-later host, so a hand-off that reported no timing **could not have reported an
  outage either** — "no hand-off failed" over eleven when one could speak is a subset
  presented as the whole, which is exactly what the timing-gap line two branches above already
  refuses to do. Guarded: twenty untimed hand-offs must not carry a corpus of four over the
  floor.
- **`RC_LOAD_MIN_TIMED_RUNS = 5`, BOUNDED FROM BOTH SIDES.** Not ten: hand-offs run at ~eleven
  a month and a floor this corpus cannot reach replaces one wrong sentence with **none at
  all**, for ever. Counted in HAND-OFFS and never in samples — a hold opened four times gives
  four readings of ONE session's experience of RC, which is why `runsTimed` exists.
- **VERIFIED BY RENDERING IT AGAINST THE REAL CORPUS**, which is the only way a verdict bug
  ever is: it now prints *"TOO THIN TO SIZE: 1 hand-off(s) could report an outage (floor is
  5) … Widen the window with --hours= before reading anything into it."* Six mutations, each
  grep-verified to APPLY and each caught. **The pre-existing guard asserting the all-clear on
  a single hand-off PINNED THE BUG** and was inverted rather than relaxed — the
  `held-offer-scope` shape, where a test required the defect.
- **THERE IS A 100x SAMPLER SITTING UNUSED, AND IT IS A PROXY — recorded, not built.** The
  keep-warm loads RC's app on the box every renewal (~48/day, `network trace: 133
  response(s), 10.6 MB declared` three times in one log read on 09-06, all successful) and
  the reading exists only in a log that rolls at 16,000 characters. **It measures RC's app
  tier from a desktop on a home connection, not a phone at 08:00**, so it can never replace
  the hand-off corpus — what it could do is tell a *"RC was down for everyone"* morning from a
  *"RC was slow for this phone"* one, which today nothing can. Same shape as the okta state
  and `notePlatform`: a fact produced and discarded.

### THE 08:00 FAST LANE HAS NEVER ONCE BEEN OBSERVED RUNNING (2026-09-17)

A real user's hold was lost at the 15:00 UTC release and the owner asked the only question that
matters: *"I need to know if the burst fired, because that will prove one of two things. We still
got beat even with a 500ms search, or our burst broke somehow and that needs to be fixed."*

**NEITHER COULD BE ANSWERED, AND THE REASON IS THAT THE BURST HAS NO DURABLE RECORD.** It has been
live since 2026-09-03 and across all of history there is not one stored trace of it:
```
bot_commands  output ilike '%fast attempt%'      0 rows
bot_commands  output ilike '%until 15s before%'  0 rows
rc_hold_requests  a burst summary in a note      0 rows
```

- **ON A LOSS THE SUMMARY RIDES IN `error`, AND THE SLOW LANE OVERWRITES IT.**
  `reportCartFailure` deliberately keeps a hold `requested` while the feed's 20-minute grace is
  open — which is correct, and is what let #76 cart at T+7:14 once a seat freed on 08-13 — so the
  runner retries every 15 s and **~110 later failures each overwrite the one note that carried the
  burst.** The instrument is destroyed by a feature working as designed.
- **ON A WIN IT IS NOT REPORTED AT ALL.** `describeBurst` goes to `log(...)` and
  `report({ ok: true, cartKey, cartEntryKey })` carries no burst field. So the 09-04 `#L034` cart
  at **T+1.44 s** — the fastest at any real 08:00 release, and the best evidence the lane has ever
  produced — is a log line nobody kept.
- **AND THE LOG IS NOT A RECORD.** `tail-log` returns 80 lines by default, `Math.min(400, …)` at
  most, then a 16,000-character cap, **with no offset and no rotation**. On the day itself the
  runner log reached back only to 15:13 and the keep-warm only to 15:15 — minutes after the event.

**SO A CART THAT FAILED AND A LANE THAT NEVER ARMED PRODUCED THE IDENTICAL EVIDENCE: NONE.** That
is the shape this file records more than any other, and it was sitting on the one path where the
product either gets somebody a campsite or does not.

#### THE LOGIC IS INTACT, AND INTACT LOGIC IS NOT EVIDENCE THAT IT RAN
Everything checkable from a session checks out, and none of it answers the question:
- `worker/cart-burst.test.mts` **21/21**.
- `isNotAvailable("The unit is not available for the date(s) specified.")` -> **true**, so RC's
  own refusal is retryable and not mistaken for a cap.
- Replayed against the day's real inputs, `shouldRetryBurst` gives **31 attempts from T-14.0 s to
  T+31.0 s**, stopping on the WINDOW and not the budget (40).
- `cart-burst.mjs` is present and imported at the box's own commit `6fc7292`, the feed's 90 s lead
  and the runner's 15 s poll both demonstrably fired that morning.
**None of that says the runner arrived before T on this release**, which is the whole question.

#### THE TWO-WAY SPLIT OMITS THE READING THAT MATTERS, AND IT IS THE ONE TO FEAR
The owner's framing was "beaten, or broken". There is a third, and it is the quiet one:

| what the row says | what happened | where the fault is |
|---|---|---|
| many attempts | RACED and lost | nowhere — the burst works |
| **exactly one attempt** | the lane ARMED and declined to retry | **ours** — a session, a wedge, a WAF refusal; the reason names it |
| **NO ROW AT ALL** | the runner never arrived before T | **ours** — the burst did not run |

**ONE ATTEMPT IS NOT A RACE**, and reporting it as one sends the next reader to RC's side of a
fault that is ours. **NO ROW is the owner's feared case**, and it is the only one that cannot be
distinguished by adding detail to an existing record — it has to be a row that is guaranteed to
exist whenever the lane armed.

#### WHAT SHIPPED: ONE `cart-burst` EVENT PER HOLD PER RELEASE PASS
`bot_events` (migration 075) is already in Postgres, already read by a readout, and already
survives a rolling log — the exact problem PR #169 solved for the alloc readings and nobody had
applied here. `cart-burst` joins `BOT_EVENT_KINDS` and the runner emits on **both** paths.
- **GATED ON `waitedForRelease`, NOT ON ATTEMPTS.** Ungated, the ~110 ordinary retries each emit a
  row and an absent row then means nothing at all. Gated on the burst having RETRIED, the
  one-attempt reading is discarded — which is the second row of that table, and it is the one that
  says the fault is ours. Both mutations are guarded.
- **`firstOffsetMs` IS MEASURED (`laneOpenedAt - releaseMoment`), NEVER `-BURST_LEAD_MS`.** The
  constant is arithmetic about where we MEANT to wake; only the measurement can show the sleep
  overshooting, which is the failure mode that would cost a site while every constant read right.
- **THE OFFSETS ARE SIGNED.** `T-14.0s` is the only way this project can ever record an early
  lapse, and the 09-04 and 09-10 release-window readings say RC does let go before its own
  predicted release.
- **FIRE-AND-FORGET, NEVER AWAITED.** A diagnostic that can delay the thing it observes is not
  worth having at 08:00:00 — the rule `recordClientReports` already follows.
- **THE DETAIL CARRIES RC'S OWN UNIT LABEL AND NOTHING ELSE.** No cart key, no entry key, no
  token: do not collect a field you then have to filter. An OAuth code and a password have each
  reached a report in this repo by exactly that route.
- **THE READOUT PRINTS IT FIRST**, above every memory section, because those are about a spare
  machine and this is about whether a real person got the campsite they were promised — and its
  **empty branch says an absent row is the finding**, not an all-clear.

#### FOUR OF THE TWELVE GUARDS SURVIVED THEIR FIRST MUTATION, AND TWO MUTATIONS WERE THE WRONG RULE
Fourteen mutations, each asserted to APPLY before its red was trusted.
- **`void 0 && noteBurst(...)` PASSED BOTH EMIT GUARDS**, and `void 0 && cartBurstReading(x)`
  passed the readout guard — the call present and dead, which is how a dead `maybeMemoryDump`
  once passed 33 tests. All three are anchored at the START OF A LINE now, so neither `void 0 &&`
  nor `if (false)` matches.
- **TWO OF MY OWN MUTATIONS APPLIED AND EXPRESSED THE WRONG RULE.** One replaced the FIRST
  occurrence of `cartBurstReading(` — which is the **import line**, not the call site. The other
  replaced one line of the readout's empty branch and left the sentence the guard anchors on
  intact. **A mutation that applies is not the same as a mutation that expresses the rule**, and
  the harness can only check the first: read the mutated region, not the exit status.
- **AND THE ABSENT-READING FAILURE WAS INSIDE THE INSTRUMENT ITSELF.** `cartBurstReading` dropped
  the timing window entirely when an offset was missing, so *"we recorded no timing"* and *"the
  timing was not worth showing"* rendered identically. Its own guard caught it; both spellings are
  named now (`T?` on the single-offset branches, `(no timing recorded)` on the window).

#### TWO NEIGHBOUR GUARDS BROKE, AND ONLY ONE OF THEM WAS WRONG
- `worker/bot-events.test.mts` pins `BOT_EVENT_KINDS` **by value**, on purpose, so adding a kind
  is a DECISION rather than a drift. Taken, with the reason written in. That guard did its job.
- `worker/runner-wedge.test.mts` bounded its pre-release-hold slice at **"under 20 lines"**.
  Twenty lines of burst instrumentation landing legitimately inside that region took it to 29, so
  it failed over behaviour that had not moved. **Fourth time a window measured in lines or
  characters has broken a guard here**, after `rehearsal.test.mts`'s 220, `rc-login-script`'s 500
  and the US-spelling guard's indentation. Re-anchored on what it was really protecting —
  **exactly one ticking sleep in the region, inside the `waitedForRelease` gate** — and
  re-verified against both regressions it exists for.

#### WHAT THIS DOES NOT DO
**It does not make the burst faster and it does not prove it works.** It makes the next contested
release answerable, and until one happens the row count is zero — which is the expected state and
not a fault. **BOT-SIDE**, so it is inert until the box updates; confirm with
`npx tsx scripts/bot-ask.mts git-status`, never `autocart.bot_version`.

#### AND THE POLLER'S 15 SECONDS IS NOT THE CART'S CADENCE — I QUOTED IT AS IF IT WERE
Asked whether the site was carted, I answered with `rc-hold-outcome.ts`'s verdict — *"the poller
never saw this unit open at any 15-second sample"* — and the owner corrected it: *"Why was it only
checking every 15 seconds? I thought we changed to a burst."* **They were right.** Those are two
independent loops on two different machines: the **Fly poller** samples availability every 15 s,
and the **mini-PC hold runner** carts at 500 ms across a 45-second window. The sentence is about
detection and says nothing about the cart.
- **AND I THEN READ THE POLLER'S SILENCE AS EVIDENCE THE SITE NEVER OPENED.** The owner rejected
  that too — *"these are very sought-after sites that will be picked up in less than 15 seconds"* —
  and the arithmetic is on their side: `claimNotification` is stamped on every cycle a site is
  open, so an empty `watch_site_alerts` means zero **sampled** open cycles, which at a 15-second
  cadence is exactly what a sub-15-second flip looks like. **An instrument that cannot resolve the
  event is not evidence about the event.** Both corrections came from the owner, and both are the
  reason this instrument exists.

### "RECONNECT AUTO-CART FOR REC.GOV" WAS ONE HIDDEN INPUT, AND THE LOOP WAS CLOSED (2026-09-18)

Reported from the Android app: the auto-login fails with credentials the owner believes are
correct, the app asks them to reconnect, and in the manual fallback window **the email is
re-typed into the password field on every keystroke**. Three separate causes, none of them
the password, and the box had been printing the first one for two days.

```
couldn't fill the login form for user_…: locator.waitFor: Timeout 8000ms exceeded.
  - waiting for locator('input[type="email"], input[name="email"], …').first() to be visible
    19 x locator resolved to hidden <input value="" name="email" type="hidden"/>
```

- **rec.gov CARRIES A NEWSLETTER FORM AHEAD OF ITS HEADER**, so `input[name="email"]` matches a
  **hidden** input that comes FIRST in document order. `.first()` resolved to it and
  `waitFor({state:'visible'})` could never succeed — for every attempt, with correct
  credentials, since the helper was written. Every clause is `:not([type="hidden"]):visible`
  now, which makes `.first()` the first VISIBLE candidate rather than the first in the DOM.
- **IT IS BOTH HALVES OF THE REPORT BECAUSE IT IS A CLOSED LOOP.** The same helper is
  `bot.mjs`'s auto-relogin (`attemptLoginWithCreds`, `bot.mjs:437`), so a dropped session can
  never be repaired -> the ready marker goes -> the app says "reconnect auto-cart for rec.gov"
  -> reconnecting runs THIS function and fails identically. **From the outside that reads as
  "my password is wrong"**, which is why it was reported as a credentials problem.
- **`attemptLoginWithCreds` RETURNED A BARE `false` FOR EVERY CAUSE**, so the one reason the
  auto-relogin could never work was invisible in `bot.log` for as long as it was broken. It
  logs the reason now. Same family as `claimBotCommands` returning `[]` for both "nobody asked"
  and "the query threw".
- **THE CENSUS READS MARKUP, NEVER VALUES.** When nothing visible turns up it reports
  `N match(es), M visible — hidden input[type=hidden][name=email]` from tag/type/name/id alone.
  *"The modal never opened"* and *"the modal opened and every field is hidden"* need different
  fixes and used to print the same eight-second timeout. **`.value` is never read** — this repo
  has published a credential twice by collecting a field it then had to filter (an OAuth code
  on 08-09, a password on 08-16).
- **THE OPENER IS NEVER CLICKED TWICE.** The header control TOGGLES the modal, and
  `getByRole('button', /log ?in/i)` matches it before the modal's own "Log In" in document
  order — so a second click on a slow-but-working modal shuts the thing being waited for. A
  retry is only worth anything when the first round found no control at all.

#### THE STREAMED FALLBACK REPLAYED THE WHOLE BUFFER, AND GBOARD FIRES IT EVERY KEYSTROKE
`/connect`'s stream mode overlays one transparent `<input>` on the canvas — a `<canvas>` cannot
raise a soft keyboard — and forwards the DIFFERENCE in its value. The old diff had three arms:
append, trim, and **"anything else -> re-send the entire value"**, without deleting what was
already there.
- **THE BUFFER WAS NEVER CLEARED BETWEEN REMOTE FIELDS**, so after the email it still held the
  email. **An email typed straight into a password with no space is ONE token to Gboard**, so
  any recomposition takes that third arm — which is exactly "with every keystroke".
- `diffKeystrokes` (`src/lib/remote-keys.ts`) is the ordinary common-prefix diff, and every
  case the old code handled specially falls out of it. **IT CAN NEVER DELETE MORE THAN IT
  TYPED** — the count is bounded by `prev`, and `prev` only ever grows by characters this
  module already forwarded. That is the safety argument for forwarding Backspaces at all: a
  "select all and replace" costs our own keystrokes, never the remote field's contents.
- **DROPPING THE BUFFER SENDS NOTHING.** It is forgetting what we typed, not asking rec.gov to
  unwind it; a reset that forwarded Backspaces would delete the email out of the field the user
  just left. It drops on a tap and on any caret-moving key — **Backspace and Delete are
  deliberately NOT caret-moving**, since they shrink the value and the diff already sees them.

#### AND THE PASSWORD FIELD HAD NO REVEAL, WHICH IS WHY THE FIRST CAUSE WAS UNDIAGNOSABLE
Asked for directly. The only feedback a wrong password gets on `/connect` is a streamed rec.gov
window forty seconds later, so there was no way to check what the phone keyboard had actually
put in the field. **`type="button"`: a bare `<button>` inside a `<form>` defaults to SUBMIT**, so
the tap meant to reveal the password would send the credentials.
`autoCapitalize`/`autoCorrect`/`spellCheck` are off because revealing turns it into
`type="text"` and Android will then capitalise the first character of a password that was typed
correctly.

#### TESTING IT HERE: HEADLESS CHROMIUM CANNOT REACH recreation.gov, AND THE PROBES DO NOT NEED IT
`page.goto('https://www.recreation.gov/')` fails **`ERR_CERT_AUTHORITY_INVALID`** while `curl`
answers 200 in the same second. `~/.pki/nssdb` holds **only the SQLite schema and no
certificates**, and `certutil` is not installed — so the proxy README's *"the browser NSS store
is already set up"* is not true of this container. **Disabling TLS verification is forbidden**,
so the answer is fixtures rather than a workaround.
- **`scripts/recgov-login-probe.mjs`** serves rec.gov's SHAPE — a hidden `input[name="email"]`
  in a newsletter form ahead of a header opener and a lazily-mounted modal — in four variants,
  and drives the REAL `openLoginModalAndFill`.
- **`scripts/connect-keys-probe.mts`** drives Chromium's own composition machinery over CDP
  (`Input.imeSetComposition`, the path an Android IME takes) and feeds the values the BROWSER
  produced through the REAL `diffKeystrokes`. A unit test pins the decision; only this can say
  what an IME actually does to an input's value.
- **EACH CARRIES A CONTROL THAT MUST REPRODUCE THE PRE-FIX FAILURE, or the probe refuses its
  verdict.** The login control fails with the production log line's own shape
  (`21 x locator resolved to hidden <input … type="hidden"/>`); the keystroke control forwards
  **40 characters containing the email once** against the shipped 12 and zero. A probe whose
  control cannot fail is a probe that proves nothing, and this repo has published a verdict
  from one.
- **THE KEYSTROKE PROBE'S FIRST VERSION REPORTED TWO FAILURES AND THE PROBE WAS WRONG, NOT THE
  CODE.** It counted the legitimate typing of the email into the EMAIL field as a replay, and
  simulated the reset by clearing only the tracker while the browser's own value still held the
  email — so the diff ran `'' -> 'email+S'` and typed the whole thing. Both metrics are scoped
  to the password phase now and the reset is a real second browser run. **An instrument that
  measures the correct behaviour as a failure is the more expensive direction**, because the
  natural response is to "fix" working code.

#### AND THE REVEAL'S OWN GUARD ANCHORED ON THE DECLARATION — ~30th TIME
It sliced +-400 characters around `code.indexOf('setShowPassword')`, which finds the `useState`
destructuring on line 52, four hundred lines from the button. **It failed for the wrong reason
and could never have caught the right one.** `jsxOpeningTag(needle, tag)` bounds on the ELEMENT
instead — back to the nearest `<tag`, forward to the first `>` OUTSIDE braces, because
`onClick={() => …}` and `aria-label={a ? b : c}` both carry a `>` that is not the end of the tag
— and a missing anchor fails LOUDLY rather than passing vacuously. **Fourth time a window
measured in characters has broken a guard here**, after `rehearsal.test.mts`'s 220,
`rc-login-script.test.mts`'s 500 and the US-spelling guard's indentation.
- **THE ANCHOR WAS THEN WIDENED, ON A MUTATION RATHER THAN ON TASTE.** `setShowPassword((v) =>
  !v)` catches the regression AND fires on a legitimate refactor of the updater;
  `setShowPassword(` catches the regression and does not, and it still cannot match the
  destructuring (`setShowPassword] = useState`). **A guard that cries wolf is one that gets
  deleted, taking the real finding with it.**
- **AND `npm run typecheck` CAUGHT AN IMPORT THE WHOLE SUITE WAS HAPPY WITH** —
  `from './remote-keys.ts'` is TS5097 without `allowImportingTsExtensions`. Fourth time the
  typecheck has been the thing that noticed, and the reason it runs both configs.

**DEPLOY: web-side for the page and the diff, BOT-SIDE for `recgov-login.mjs`** — so cause #1 is
**not fixed on the box until the mini-PC updates**, and that update ends the RC session. None of
the changed paths is in `worker-deploy.yml`'s `paths:` (read, not remembered), so no poller
restarts.

#### THE RC SIBLING HAS A MILDER VERSION OF THIS, AND IT IS DELIBERATELY NOT TOUCHED
`rc-autologin.mjs`, `rc-probe.mjs` and `src/lib/rc-login-script.ts` carry the same kind of
selector list for Okta. **They are structurally safer**: each tries its selectors ONE AT A TIME
and asks `isVisible()` on each `.first()`, so a hidden first match makes it move to the next
selector rather than wait out a timeout on a joined list. The residual hazard is narrower — a
selector matching BOTH a hidden and a visible input would still resolve `.first()` to the hidden
one and skip the selector entirely — and it has never been observed, because
`signin.reservecalifornia.com` is a dedicated sign-in page with no newsletter form ahead of it.
**Recorded, not fixed:** it is the release-critical path between a queued hold and a missed cart,
the login rehearsal passes on it, and widening a fix past its evidence is how the 08-22 round was
spent.

#### 2026-09-18 — THE rec.gov RECONNECT IS FIXED, MERGED, AND LIVE ON BOTH HALVES

**Read the "RECONNECT AUTO-CART FOR REC.GOV WAS ONE HIDDEN INPUT" entry above.** Merged as #363
(`fff3b98`) and #364 (`2e49994`), verify 2290/2290, and **none of the changed paths is in
`worker-deploy.yml`'s `paths:`** — read, not remembered — so no poller restarted.

**THE BOX TOOK `2e49994` ON 2026-09-18 AT 15:19 UTC, IN 35 SECONDS** (`updated and verified`),
requested from a session rather than waiting for the quiet window. Confirmed with
`bot-ask git-status`, corroborated by `autocart.bot_version` reading *"mini-PC and web are both on
2e49994"*, and `git merge-base --is-ancestor fff3b98 2e49994` holds. `list-processes` shows ONE
`node.exe rc-keepwarm.mjs` and ONE `rc-hold-runner.mjs` — no duplicate payloads.

- **THE UPDATE COST THE RC SESSION AND THAT IS ITS PRICE, NOT A FAULT.** `stop-all` closes the
  Chromium the token lives in; the check's own detail says *"normal between releases, the token
  only lives ~1h"*, and `planRenewal` repairs it unattended. **Do not reach for `rc-login.bat`** —
  it force-kills the browser the repair needs. It was taken deliberately with **zero holds
  queued**, so the 6 h release gate was open and nothing was at risk.
- **AND IT FIRED THE CURE A THIRD TIME, 34 SECONDS INTO THE NEW BROWSER** — see "IT FIRED A THIRD
  TIME" above. A box update is now **2-for-2** at forcing the burst wedge, and `wedge.silent` got
  its first production reading.
- **HOW TO READ THE FIRST RECONNECT FROM HERE:** `bot-ask tail-log broker` should no longer carry
  `locator.waitFor: Timeout … resolved to hidden <input … type="hidden"/>`. A refusal now names
  which of the two it was — *"the modal never opened"* vs *"every field is hidden"* — plus a
  census of the page's email inputs by tag/type/name/id. **Never `.value`.**
- **BOTH RECOVERY PATHS ARE FIXED BY THE ONE CHANGE**, because `bot.mjs`'s auto-relogin and the
  broker's manual reconnect call the same `openLoginModalAndFill`. **The `.camphawk-relogin`
  retry-budget state lives on the box's filesystem and is not readable from a session**, so
  whether a repair is owed right now is unknown from here; the next reconnect attempt answers it.
- **AND THE PROBES RUN HERE, WITH NO PHONE AND NO BOX:** `node scripts/recgov-login-probe.mjs`
  and `npx tsx scripts/connect-keys-probe.mts`. Each refuses a verdict unless its control
  reproduces the pre-fix failure, so a green run is worth something.

##### THE PREDICTION WAS RIGHT AND THE FAILURE MOVED ONE STEP (2026-09-20)
The bullet above says *"`tail-log broker` should no longer carry `locator.waitFor: Timeout …
resolved to hidden <input … type="hidden"/>`"*. **Read on 2026-09-20 and it does not** — the
hidden-input timeout is gone from every attempt after the box updated. What replaced it is a
different refusal at the NEXT step, and the box update sits cleanly between the two:
```
11:47:27  couldn't fill the login form …: locator.waitFor: Timeout 8000ms exceeded.
          19 × locator resolved to hidden <input value="" name="email" type="hidden"/>
15:19:03  Remote sign-in broker listening …            <- the box is now on 2e49994
15:51:29  couldn't fill the login form …: no VISIBLE recreation.gov password field
          after submitting the email. password inputs on the page: 0 match(es), 0 visible
```
- **SO #363 DID WHAT IT CLAIMED, AND THE OWNER'S "still failing" IS A DIFFERENT FAULT.** The
  email field is found and submitted now; rec.gov then renders no password input at all. Both
  halves are measured off one log with the restart line between them — **that ordering is the
  evidence**, and without it the second message reads as the first fix not working.
- **THE NEW MESSAGE IS THE CENSUS EARNING ITS KEEP ON ITS FIRST OUTING.** *"0 match(es), 0
  visible"* is exactly the distinction #363 added: *"the modal never opened"* and *"the modal
  opened and every field is hidden"* used to print the same eight-second timeout. Here it says
  neither — it says the field is not in the DOM, which is a third state and a real reading.
- **WHAT IT IS NOT ESTABLISHED TO MEAN.** Zero password inputs after a submitted email is
  consistent with rec.gov having moved to a second step we do not wait for, with a challenge
  interposed, and with the submit not having taken at all. **Do not write one in.** The one thing
  it rules out is the hidden-input bug, because that bug could not produce this message.
- **READ THE BROKER LOG EITHER SIDE OF A BOX UPDATE, NOT JUST THE TAIL.** The whole diagnosis is
  one `bot-ask tail-log broker:150` and the `Remote sign-in broker listening` line; the tail alone
  shows only the new failure and reads as no progress.

#### 2026-09-17 — THE CART BURST RECORDS ITSELF NOW, AND IT NEEDS ONE CONTESTED RELEASE

**Read "THE 08:00 FAST LANE HAS NEVER ONCE BEEN OBSERVED RUNNING" above before anything else.**
A real user's Carpinteria hold (`#A124`, rc-357) was lost at the 15:00 UTC release — RC answered
*"The unit is not available for the date(s) specified."*, the row went `failed` at 15:20:01Z and
`notifyHoldMissed` told the user on all three channels — and **nothing could say whether the
500 ms lane fired.** It does now.

- **THE ROW COUNT IS ZERO AND THAT IS THE EXPECTED STATE.** One `cart-burst` event is emitted per
  hold per release pass that waited for the release, so the first one arrives on the next
  **tapped** hold. Untapped offers produce nothing and that is not a fault.
- **HOW TO READ THE FIRST ONE.**
  `NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts` — **CART BURSTS prints first.**
  Many attempts = raced and lost, the burst works. **Exactly one attempt = the lane armed and
  declined to retry, and the fault is OURS** — the `reason` names it. **No row at all, for a hold
  that was tapped and whose release has passed = the runner never arrived before T.** Cross-check
  against `scripts/rc-holds-readout.mts` before reading silence as quiet.
- **DO NOT read a `failed` hold as the burst being broken, or as a race lost, without that row.**
  That is the whole reason it exists.

**IT IS LIVE ON THE BOX — `637316e`, applied 2026-09-17 17:44:17 UTC in twenty-four seconds**,
read from `npx tsx scripts/bot-ask.mts git-status` and **never from `autocart.bot_version`** (that
column COALESCEs and can show a stale sha beside a live heartbeat). `list-processes` showed exactly
one `rc-keepwarm.mjs` node and one `rc-hold-runner.mjs`, so no payload was duplicated.
**A hold tapped from 17:44 on is covered; an absent row for one tapped BEFORE it says nothing.**

#### THE CAPTCHA BLOCK IS OVER — DO NOT ACT ON IT
The 12:00 UTC warm-up was stopped by an image challenge on Okta's email step and the handover
said a human sign-in was needed before 14:30. **It was not, and both predictions were falsified by
the box itself:** the session repaired unattended, `maybeAutoLogin` ran four trips at 14:34-14:37,
and `session_live_since` is **14:37:05**. The 15:00 release had a live session; the site was lost
to RC, not to the sign-in. **One CAPTCHA is an event, not an escalation** — the reading that would
matter is whether the next unattended sign-in after a human one also meets one, and nobody has
that.

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

### A TypeError PUBLISHED A USER'S PASSWORD (2026-08-16) — ~~and the feature is REVERTED~~
~~An in-app RC sign-in (the user types credentials on the claim screen, we inject them into the
webview) was built, shipped, failed three times in one night, and was **reverted**.~~
**THE REVERT LASTED TWO DAYS. THE FEATURE HAS BEEN LIVE SINCE 2026-08-18 AND THIS SECTION SAID
OTHERWISE FOR THIRTEEN.** `src/lib/rc-login-script.ts` was re-added in **#126 (08-18)**, improved
by **#147 (08-20)** and **#171 (08-23)**, is imported by `ClaimFlow.tsx` and
`rc-precart-script.ts`, and **ran in production on Android on 2026-08-30** — `signin-missing` →
`email` → `password` → `submitted` → a 939-char token. Struck rather than deleted: read as
current, the heading says the in-app sign-in does not exist, and it is the code any
iOS-versus-Android comparison is actually about. **It cost exactly that on 08-30**, when
comparing the two platforms began from "the feature is reverted".
- **AND THIS FILE ALREADY DOCUMENTED BOTH RE-LANDINGS IN DETAIL.** "THE IN-APP OKTA FILL:
  REACT'S `_valueTracker`" (#147) and "THE HAND-OFF LANDS IN THE CART NOW, AND THE SIGN-IN NEVER
  PRESSED ANYTHING" (#171) are both ABOVE this entry, and both describe code this entry says was
  removed. **The file contained its own refutation twice and it was read past** — the unit-45719
  shape. **When a feature comes back, strike the entry that says it is gone**; a newer entry
  beside it is not a correction, because nothing makes a reader of the old one aware of it.

Two findings outlived the revert and both are still true.
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
- ~~**Both fixes live unmerged on `claude/rc-login-fix` (PR #78)**~~ — **BOTH ARE LIVE, AND #78
  IS CLOSED-NOT-MERGED (2026-08-17).** They arrived through the re-landing instead, not through
  that branch: the per-navigation `afterLoad` is back (`ClaimFlow.tsx` carries the comment
  recording that the once-per-hand-off flag defeated it), and `login-result`/`signin-missing`
  are both in the served bundle — Android reported both on 08-30. **There is nothing to fold
  in.** Read as an open task, this line sends the next session to a closed PR for code that is
  already running.
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
  Two strikes then a stand-off, **shorter than the 20-minute cart grace window on purpose**,
  so it can never trade a repairable session for a guaranteed miss.
  **IT WAS THREE MINUTES AND THAT NUMBER WAS WRONG TWICE (2026-08-30).** Three minutes bought
  "three uninterrupted keep-warm cycles" — but the 60-second expiry poll is not what repairs a
  dead session; `planRenewal` is. It was then sized on `RENEW_FLOOR_MS` (5m), which assumes the
  renewal SUCCEEDS — and the case this exists for is the one where it FAILS, which retries at
  `RENEW_MIN_GAP_MS` (**10m**), measured. It is `RENEW_MIN_GAP_MS + 60s` now, derived in source.
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
- **A COMMENT ARMS IT, AND WITH A HOLD QUEUED A COMMENT WOULD TURN IT RED (2026-09-10).**
  `CH_BOT_CODE_AT` is `git log -1 --format=%cI -- scripts/auto-cart-bot`, so it moves for ANY
  commit touching that path and has no notion of code versus prose. Observed live: the box sat
  on `7875a6f` reporting *"it is MISSING bot-side changes"* against master, and the entire
  difference was **a five-line comment** in `keepwarm-launch.mjs` recording the GPU trial's
  evidence — `git diff` over the whole of `scripts/auto-cart-bot/` and `mini-pc/` is that one
  hunk. The box's behaviour was already correct (`RC_KEEPWARM_DISABLE_GPU ?? '0'` is present at
  `7875a6f`, so the flags default off there).
  - **THE COST IS THE REMEDY IT INVITES.** The honest reading of "missing bot-side changes" is
    to update the box — and an update **ends the RC session**, because the token lives in the
    Chromium it closes. So a documentation edit can buy a destructive action that repairs
    nothing. It is warn-only today; under the rule two bullets up, **`fail` needs missing
    bot-side code AND a hold queued**, and a comment satisfies the first half — so the same
    edit made the evening before a release reads as red at 07:30. Read in the source rather
    than inferred: `missesBotCode` is `Date.parse(boxCommitAt) < Date.parse(botCodeAt)` and the
    level is `holdsAhead > 0 ? 'fail' : 'warn'`. **And the red branch prints a claim a comment
    cannot support** — *"with N hold(s) queued. The two halves can disagree at the release."*
    Two halves cannot disagree over prose.
  - **AND THIS REPO'S OWN DISCIPLINE IS WHAT ARMS IT.** Findings are written into the comment
    beside the code deliberately; every time that happens in a bot-side file, this check fires.
    The two habits are in direct tension and neither is wrong.
  - **RECORDED, NOT FIXED, and the reason is the failure direction.** The tempting fix is to
    compare content with comments stripped — which is a parser, in front of the one check that
    says whether the box and the web agree about release-critical code, and a parser that
    mis-reads a real change as cosmetic fails SILENTLY in the expensive direction. Changing the
    severity rule is the same trade. Neither is a drive-by. **What is free is reading the diff
    before acting on the warn:** `git diff <boxSha>..origin/master -- scripts/auto-cart-bot/
    mini-pc/` answers in one command whether an update would change anything.
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
- **The pre-flight Routine moved 07:30 → 07:40 PT** (now
  `trig_01NdJC1SvSDwxZZroAooVKnU` — the ID it carried then was deleted 2026-08-23). At
  07:30 it now collides with `maybeAutoLogin` and would report "dead" during the repair —
  the 08-09 cry-wolf exactly. At 07:40 it reports the outcome with 20 minutes to act.

### `update.bat` ENDS the RC session — update FIRST, log in AFTER (2026-08-10)
`rc-login.bat` said *"your sign-in survives that — it lives in `.rc-bot-profile\`, which
nothing deletes"*. The PROFILE survives; the SESSION does not. RC keeps no Okta session
cookie in the profile (the 2026-08-09 finding), so **the access token in the running
browser IS the whole session** — and `update.bat`'s `taskkill /IM node.exe /F` closes that
browser. Measured: a hand sign-in at 16:15:06Z read *"no token at all — signed out; okta
session GONE (404)"* at **16:23:08Z**, straight after an update. Both scripts say so now.

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

**Two Routines cover this daily.** Both were DELETED AND RECREATED on 2026-08-23, so the
IDs below are the second set — **the ones this file named until 2026-08-27 no longer
exist** (issue #181). Verified against `list_triggers` before being written down.
- **`trig_01NdJC1SvSDwxZZroAooVKnU`** — **07:40 PT pre-flight** (`40 14 * * *`), the one
  that can actually save a hold, and **the only one that reaches the phone**. Reads
  **both** `autocart.rc_session` and `autocart.rc_runner` from `/api/health/status` — they
  are different failures, and a green runner says nothing about the session (that gap is
  the whole 08-07 story). Deliberately needs no repo and no DB, just the public endpoint,
  so it cannot fail the way a clone-dependent check did on its first run.
- **`trig_01CzPKmDUz5MC3tbYFGMTS4a`** — **08:15 PT outcome** (`15 15 * * *`), reads the
  hold readout and says what actually happened. A post-mortem by construction; 08:00 has
  passed. **Bound to the CampHawk-Main session** via `persistent_session_id`, so it dies
  with that session and re-pointing it needs another delete-and-recreate.
- **WHY THEY WERE REPLACED RATHER THAN EDITED, and why it will happen again.**
  `update_trigger` accepts only `name`, `prompt`, `cron_expression`, `run_once_at`,
  `enabled` and `model`. It CANNOT change `notifications` or `persistent_session_id` — so
  adding push to the pre-flight, and binding the outcome to a session, each required a
  delete-and-recreate. **There was no edit that would have preserved the IDs**, which is
  why an ID written into this file is a fact with a short shelf life.
- **PUSH AND IN-SESSION REPORTING ARE MUTUALLY EXCLUSIVE** — the server rejects
  `notifications` on any bound Routine. That is why only the pre-flight rings the phone.
- **THE PROMPTS THEMSELVES GO STALE, AND ONE WAS TEACHING A REFUTED STORY.** On 2026-08-27
  the 08:15 prompt still opened with a block headed *"TOMORROW (2026-08-25) SPECIFICALLY"*
  which asserted *"RC lists one physical site under more than one facility, so this is not a
  matching bug"* — the duplicate-facility explanation this file measured FALSE (zero
  inventory overlap; the collision was our own result-map bug, fixed in #188). A daily
  Routine firing a refuted cause into a fresh session is the same shape as a docs PR sitting
  open carrying a correction: **it teaches the next reader the wrong thing, on a schedule.**
  `prompt` IS editable, so this one is cheap to fix — check both prompts when a finding here
  is corrected.
- **DELETE-ONCE-PROVEN: re-take that decision deliberately rather than by neglect.** The
  flow has now worked on 08-12, 08-13, 08-16, 08-23, 08-24 and 08-26.
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
was useless: `localStorage` survives a restart, so the minted token does too. ~~Containment is
otherwise unchanged: the RAM guard has fired four times and the box has not been past 71% COMMIT.~~
**THAT SENTENCE IS FALSIFIED — 2026-08-22 and 08-23 reached 82% and 88% COMMIT with the RAM arm
firing on NEITHER.** Struck rather than deleted: it is the exact sentence a later reader would
quote to conclude a 9 GB ramp had been contained.
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
offering a hold on the nine UseDirect portals the bot has **no account for**. **Open: ~~fold PR #78
back in after re-landing the in-app sign-in~~ — DISCHARGED: #78 is closed and its two fixes
shipped with #126/#147/#171; the box needs an update for the parallel carting and the 07:33
alarm fix.**

*(Previous pass.)* **Docs current to 2026-08-16 (second pass).** **THE 08:00 HAND-OFF WORKED END TO END** — both
holds carted at T+43s and T+49s, both claimed, `✓ Added to cart` reported on iOS, and
`RC_HOLD_CAPACITY = 2` met at its exact boundary with both seats filled. **The alarm that fired
at 07:33 was ours**: a LIVE session with a 40m token against a 46m requirement was reported
`dead`, and the remedy it printed (`rc-login.bat`) would have killed the very session it was
complaining about. Fixed in PR #80 — **bot-side, so it needs `update.bat`, "Update now", or a
quiet window before it means anything.** Also this pass: **a TypeError published a user's
ReserveCalifornia password** (WebKit quotes the failing source expression; `scrub()` sailed past
it exactly as it sailed past an OAuth code on 08-09), and the in-app sign-in that produced it is
**REVERTED** *(for two days — re-landed 2026-08-18 in #126; PR #78 is closed and its fixes are
live, so that "Open" is discharged).* **Open: `autocart.bot_version` should be checked before
trusting the 07:33 fix is live.**

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
