# Next session — start here

*Rewritten 2026-08-23 (evening). The session's task is the TWO APP FIXES at the top. The leak
and the iOS review are the standing threads behind them.
Delete this file once the sampler has produced a reading from a real ramp AND the App Store
version has a decision. It is a handover, not a permanent doc, and a stale one reads like
current state.*

---

## What this session is for: TWO APP FIXES

Both are in the RC hand-off — the flow that runs on the owner's phone at 08:00. Both were
reported by the owner on 2026-08-23 after a hold that **worked** (carted at T+1.6s), so
neither is an outage; they are the two rough edges left in a flow that is otherwise proven.

### FIX 1 — land IN the cart, and verify it there

Today a successful cart sets a status string: *"✓ Added to cart — tap the cart icon at the top
of this page to check out."* The owner's ask: **just land in the cart instead.**

The pieces already exist. `RC_CART_URL` is defined in `src/lib/booking-url.ts`
(`https://www.reservecalifornia.com/Customers/ShoppingCart`, capitalised exactly as RC serves
it — do NOT tidy the casing), and `adoptBanner()` in `extension/content-rc.js` already renders
an "Open cart" button pointing at it. The fresh-cart path at `content-rc.js` ~line 346 simply
does not use it.

**AND THIS IS AN UPGRADE TO THE PROOF, NOT A THREAT TO IT — which is the owner's own question,
asked well.** The concern is real: `#camphawk-rc-status` is what `lib/rc-precart-script`'s
epilogue reads to report the hand-off's verdict, and `✓ Added to cart` in `client_reports` is
the evidence the two cart POSTs fired. Navigate too early and that proof is lost.

But the injected bundle is re-injected on EVERY navigation (`loadstop` fires again — the fact
that made `afterLoad` fire once per hand-off a bug on 2026-08-16). So on the cart page the
script runs again and can **read the cart back**, which is strictly stronger than a status
string we wrote ourselves. `content-rc.js`'s own comments call the current judgement — on the
response payload's `IsSuccess` — *"one step weaker than `rc-cart.mjs`, which re-reads the
cart."* Landing on the cart is exactly where that gap closes.

**The ordering is the whole risk.** Client reports are debounced 1.5s before they POST. Flush
`✓ Added to cart` FIRST, then navigate, then report a `cart-verified` stage from the cart page.
Navigating first trades a proven signal for an unproven one.

### FIX 2 — the in-app sign-in must click RC's own Log in control

Owner, 2026-08-23: *"I enter my info on our app side. Click our button to sign in. Takes me to
RC. It scrolls to calendar. Nothing happens. I hit login on that page and it then completed
everything for me."*

That last sentence is the diagnosis: **our script is looking for the credential form before
anything has navigated to Okta.** RC lands the user scrolled to the availability calendar with
its own sign-in control off screen; until that control is pressed there is no form to fill.

The bot solved this exact problem — `clickSignInControl` in `scripts/auto-cart-bot/
rc-autologin.mjs`, matched on the ACCESSIBLE NAME rather than a class, because RC ships new
bundles whenever it likes and its class names are generated. `content-rc.js` already has a
`signin` banner state that scrolls to top and offers a Log in button for the same reason. The
injected sign-in path needs that click before it hunts for fields.

**Read `rc-autologin.mjs`'s `signIn()` before writing any of this.** CLAUDE.md records that
reinventing this flow cost two failed runs on 2026-08-09 — Enter BEFORE the button, the email
step is flaky rather than blocked, Okta's error banner must be read rather than guessed at.

**AND MIND THE 2026-08-16 LESSON, which this feature caused.** A `TypeError` in this exact code
path published a real ReserveCalifornia password into `client_reports`, because WebKit formats
`X is not a function` by quoting the FAILING SOURCE EXPRESSION verbatim. Bind credentials to
locals so no call expression can contain one. `worker/rc-report-scrub.test.mts` guards the
reporter end; the call site is the other half.

---

## The one thing to understand first

**The owner's standing ask is "fix the leak". The leak is NOT fixed.**

Everything shipped so far — the size guard, the RAM arm, the heap trail, the post-Okta recycle,
the orphan sweep, the throwaway tab, and the warm-up merged yesterday — is **containment or
relocation**. The box stays healthy. The allocation still happens.

Do not read five green instruments as a cure, and do not tell the owner it is handled. They
asked this directly on 08-21 and the answer was: *"we keep trying to find a solution for what to
do after the leak, not stop it from leaking."* They were right.

---

## Where things stand

| | |
|---|---|
| Master | `1cf83a2` |
| Mini-PC | `57e9d79` — has every memory instrument except #169 |
| Open holds | none |
| RC session | dead, but **Okta ALIVE** — so a repair is the cheap kind |

**THIS MORNING WORKED, AND THAT IS THE BASELINE THE TWO FIXES SIT ON.** Hold `45719` carted at
**T+1.6 seconds** (07:59:47.6 against a 07:59:46 release — the fastest yet) and was released at
08:10. A 07:45 alarm fired and was CORRECT: the session really was dead, and the system repaired
itself because every failed auto-login attempt is refunded, so the retry loop kept going until
RC's app loaded.

**THE SESSION IS DEAD RIGHT NOW AND IT IS THE KNOWN PATHOLOGY, NOT A NEW FAULT.** The storage
census fired and answered: *"cookies: 10 on the RC origins, NONE token-shaped — so the stale
token is coming from the server, not from this profile."* That is the seven-day-stale-token
finding from 08-22 recurring. Okta is alive, so the repair is the 11-second cookie-answered
kind; the renewal cannot shift it on its own, and the 20:00 rehearsal has twice been the thing
that actually fixed it.

**Still open:** **#169** (the sampler-persistence work below — merge and update the box, or the
next ramp is lost like the last two), **#146** (worker-deploy paths — restarts both pollers, so
pick a quiet moment).

---

## The leak: what is known, what is not

### NEW 2026-08-23 — the ramp has a shape nobody had seen, and it is not a spike

Two ramps in thirty-two hours, everything else flat at ~300 MB:

| | peak `rc` | free RAM | COMMIT | pid |
|---|---|---|---|---|
| 08-22 23:12→23:23 | 8,983 MB | 6,744 → 3,191 | 82% | 10364 throughout |
| 08-23 07:31→07:41 | **9,180 MB** | 5,960 → 3,328 | **88%** | 5296 throughout |

**ONE renderer pid, growing steadily for ELEVEN MINUTES at ~400 MB/min.** The renderer is ~90%
of it (8,245 of 9,180 MB); the browser process grows proportionally but stays under 800 MB;
GPU, utility and crashpad are flat throughout.

That revises the older reading of ~2,400 MB/min in a short burst. It is slower, longer, and
sustained — which is a different kind of allocation and a different search.

The morning ramp **starts at 07:31 — T−30, exactly when `maybeAutoLogin` fires.**

**AND IT REFRAMES THAT MORNING'S FAILURE — as a CANDIDATE, not a finding.** The
*"RC's app did not load"* errors ran 07:43–07:45, AFTER the ramp, with free RAM already back to
9,884 MB — so the browser had just been recycled. A box coming off 88% COMMIT is exactly when
RC's SPA would fail to boot. The RC failures look like the AFTERMATH of the memory event rather
than an independent fault. Do not write that in as established; the discriminator is whether
they recur on a morning with no ramp.

### BOTH ATTRIBUTIONS WERE LOST, AND THAT IS WHY #169 EXISTS

The sampler ran for both ramps. Neither reading survived: its only output is
`logs\rc-keepwarm.log`, and `tail-log` returns the last 16,000 characters. By the time anyone
looked, the only sampler lines left were from navigations that did NOT ramp (7 MB, 9 MB,
53 MB) — which the three-way verdict correctly refuses to draw conclusions from.

`chromium_memory_samples` survived those same two events by being in Postgres. **PR #169** is
that fix applied to the other half (migration 066, already applied to production). **Merge it
and update the box, or ramp number twenty-three is lost the same way.**

**Established.** The ramp is triggered by the **Okta navigation**. That is a controlled
comparison, not a correlation — 2026-08-18, three token-less renewals ten minutes apart, same
code and profile: the one that clicked through to Okta cost 2,331 MB, the two that reached
`no-signin-control` cost nothing having run the identical clear, reload and prime.

It lands in the **renderer** (+1,237 MB) **and the browser process** (+545 MB). GPU, utility and
crashpad stayed flat.

**Never observed: what allocates.** "Network/IPC buffering" appears in three separate CLAUDE.md
entries as the leading explanation and **has never been tested**.

### A correction that matters more than it looks

Measured locally on 08-22, against a real Chromium:

```
640 MB of Uint8Array allocated in a page  ->  JSHeapUsedSize reads 0.0 MB
```

So **"the JS heap is flat at 15–18 MB while the process is 25 GB"** eliminates *ordinary JS
retention* — an array nobody trims, our fetch wrapper holding `init` — and eliminates **nothing
else**. External memory is not in that number. The heap trail could never have seen this class of
allocation.

That reading has been treated in CLAUDE.md as ruling out the whole JavaScript-adjacent family. It
does not. Do not repeat that inference.

---

## Track A — name it (MERGED; #155 is on the box, #160/#163/#166 are NOT)

`scripts/auto-cart-bot/rc-native-sampler.mjs`, wired into the renewal's Okta trip.

Verified before it was written — the same 640 MB came back as:

```
partition_alloc::PartitionRoot::Alloc<>() <- namespace)::ArrayBufferAllocator::Allocate()
```

2% error, a few kilobytes of response. It is a Poisson sampler: output scales with **distinct
stacks**, not bytes — the opposite shape from the multi-GB heap snapshot the house rules forbid
writing when the box cannot spawn a process.

**IT FIRED ON 2026-08-22 AND NAMED NOTHING — the instrument was validated on the wrong
platform.** Four of five rows came back as bare hex (`0x7ffc499b1707 <- 0x7ffc4375aa42`): the
"1,083 of 1,733 frames symbolized" figure was measured in the **Linux dev container**, and
Playwright's Windows build exports no internal symbols. **#160 fixes it** by resolving addresses
to `module+0xoffset` from the `modules` array CDP already returns — stable across runs (module
bases move under ASLR; offsets do not) and symbolizable offline via the module `uuid`.

That navigation did not ramp, so its numbers meant nothing and the trace said so. What it showed
was the shape a real ramp would have arrived in.

**#160 IS BOT-SIDE AND THE BOX CANNOT UPDATE WHILE THE TEST HOLD IS QUEUED.** Push it after the
hold clears (~08:15 PT).

**THE AUTO-LOGIN IS SAMPLED NOW TOO (#163).** The sampler had ONE call site — the renewal's
throwaway tab, which is the *cheap* Okta trip (140–350 MB, 2.3 GB at worst). `maybeAutoLogin` is
the expensive one, **9,434 MB over twelve minutes on 2026-08-20** because `okta=GONE` forces the
full password form, and nothing was measuring it. It now attaches CDP to its throwaway tab and
reads in the `finally` **before** `tab.close()` — closing destroys the renderer whose profile it
is — paired with an `os.freemem()` delta so a non-ramping trip cannot be misread as a negative.

It cannot cover a RAM-guard kill, which takes the process. The memory series is still the only
witness to those.

**THE TEST HOLD STILL WILL NOT PRODUCE A READING**, for a different reason now: the box is
frozen while a hold is queued, so tomorrow morning runs the pre-#163 code. The first auto-login
reading comes from the release *after* the box updates.

**Still unsampled: the rehearsal** (it navigates the resident page) — and no `withNetworkTrace`
on the auto-login, which would test the buffering candidate on the biggest navigation there is.
That is the obvious next instrument.

**How to read the first real one:**

- `net::` frames → the buffering candidate is confirmed after three entries asserted it without
  evidence.
- Anything else → three CLAUDE.md entries need correcting.
- **The line covers the RENDERER ONLY.** `Memory.startSampling` is absent on the browser target
  (verified, not assumed), so the browser process's +545 MB is not in the figure. The rendered
  line says so. A number silently describing two thirds of a ramp is how "the biggest process"
  became a whole explanation once already.

**Getting a ramp to measure.** The warm-up (#154) now schedules the biggest one there is — the
9.4 GB password sign-in — at T−3h of any queued hold when Okta is gone. That was a side effect of
building it, but it is the useful one: an expensive Okta trip at a predictable time that nothing
depends on.

---

## Track B — the cure (designed, NOT started, needs the owner's go-ahead)

**Take the renderer out of the OAuth round trip.** Intercept `/authorize`, replay it over
`ctx.request` following redirects, exchange the code ourselves. No page load, no renderer, no
gigabytes.

Three pieces already exist:

- we already intercept `/authorize` (`force-login-prompt.mjs`),
- we already read `code_verifier` off the token POST (`rc-token.mjs:108`),
- okta-auth-js's `okta-transaction-storage` is already known to the code.

For the **cookie-answered** case this is a plain redirect chain, and that is where the chronic
damage is: **all twenty recorded ramps were renewals.** The password case is Okta Identity Engine
(`/idp/idx/*`) and is the CAPTCHA-exposed path — leave it in a browser. It is once per release,
and the warm-up now puts it three hours from the cart.

**Why it has not been started.** It is surgery on the one path between a queued hold and a missed
cart, and Track A's first reading could change its design entirely — if the growth turns out to be
buffering in the **browser process**, `ctx.request` may not even be the right lever. Building it
blind is how a repair gets credited to the wrong mechanism, which has happened here three times.

**#155 is merged and on the box, so the arming is done.** What remains: get ONE reading from a
real ramp, then take Track B to the owner with evidence rather than with a hypothesis.

---

## The OTHER live thread: iOS review

**`1.0 (5)` was resubmitted 2026-08-22 with corrected App Review notes — same binary.** This is
a separate thread from the leak and it can resolve while nobody is looking, because **release is
automatic**: approval puts it on the App Store with no human step.

**Read `docs/APP-STORE.md` §2d before touching anything here.** The short version: the 3.1.1 fix
(the US-storefront link-out) had been live in the reviewed build since 08-19 and **the reviewer
could not see it**, for two reasons that were both ours — every link-out surface is gated on
`!subscribed` and the demo account is a subscriber, and the console notes still said in writing
that the app *"does not link out to any purchase flow"*. Fixed console-side: rewritten notes with
explicit **sign-out** steps, and no second demo account (signing out reveals the link because
`WatchCta`'s `isNative` branch precedes its `!signedIn` branch).

**HOW TO READ THE OUTCOME — this matters, because the obvious reading is wrong:**

- **Approved** → it is live. Nothing to do; the `LINKOUT_BY_STORE.ios` flip already happened.
- **Rejected on 3.1.1 again** → **that is the ANSWER, not a fourth process failure.** §2c and
  §2d both recorded "does link-out alone clear 3.1.1 with no IAP?" as unestablished, because on
  neither occasion could the reviewer reach a link-out. This is the first submission where they
  can. A rejection now moves the decision to StoreKit — weeks of native work, a new build, and
  15–30% — and should be taken to the owner as that decision, not as another notes round.
- **Rejected on something else** → treat it on its own terms. §2a, §2b, §2c and §2d were each a
  different fault from what the previous one looked like.

**Android stays off.** `LINKOUT_BY_STORE.android` is `false` and must remain so until Play
PRODUCTION is live and US-only — the closed test is worldwide, and the anti-steering carve-outs
are US-storefront only.

---

## Also landed this session

- **Migration 065 — the Okta session's state is a column.** `autocart.rc_session` now says
  whether the next repair is the 11-second cookie exchange or the 12-minute, 9.4 GB password
  form. Proven end to end in production. **It cannot go red** — `oktaCostNote` returns
  `string | null` and has no severity to return, by design; `okta=GONE` is the ordinary state
  between releases.
- **#154 — the warm-up.** Signs in at T−3h when Okta is gone, so the T−30 sign-in is
  cookie-answered. Moves the expensive trip out of the window where a RAM-guard kill can hold the
  profile lock past 08:00. **It does not add a password sign-in, it moves one.**
- **§2d + the resubmission.** The 3.1.1 fix was live and invisible to the reviewer; notes
  rewritten, same binary resubmitted. `docs/APP-STORE.md` §2d carries both text blocks, the
  verified 3,999-character Notes cap, and the reasoning.
- **#152 — the claim screen.** A successful release no longer reports "Network error. Try again."
  (advice for an act that cannot be repeated), and the gate now reads the token's **expiry**, not
  merely that one was captured — which is what let a release happen against a 23-hour-dead session
  on 08-21.

---

## Standing rules worth re-reading before touching any of this

- **Never invent an RC unit id.** `scripts/rc-test-hold.mts --find` is the only way. A real
  numeric id LOCKS a real campsite until claim or release.
- **Do not update the box while a hold is queued within 6h.** The gate is not liftable and it is
  not a bug.
- **`npm test` hits the production DB on purpose**, and races production's own sweeps — a flake
  there is not automatically a second test run.
- **Check what the REVIEWER will see, with the credentials they will actually use.** "The fix
  is in the bundle" is a different claim, and verifying only that one cost two App Store rounds
  — 08-14 (a demo password nobody had tried) and 08-22 (a demo account nobody had viewed the fix
  through).
- **A guard that anchors on a token occurring twice will break silently.** It has now happened
  twenty-one times. When one fails over unchanged behaviour, re-anchor it and then **verify it
  still fails against the regression it exists for** — a re-anchor that quietly weakens a guard is
  worse than the break.
