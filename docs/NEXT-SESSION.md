# Next session — start here

*Rewritten 2026-08-22 (evening). Two live threads: the memory leak, and the iOS review.
Delete this file once the sampler has produced a reading from a real ramp AND the App Store
version has a decision. It is a handover, not a permanent doc, and a stale one reads like
current state.*

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
| Master | `744bc85` |
| Mini-PC | `e2be117` — **behind master by DOCS ONLY**, nothing bot-side |
| Open holds | none |
| RC session | token dead, **Okta ALIVE** — the ordinary between-releases state |

**THE BOX BEING BEHIND MASTER IS FINE HERE, AND THAT IS A JUDGEMENT, NOT A SHRUG.** Everything
between `e2be117` and `744bc85` is documentation plus another lane's relay code. The sampler
landed IN `e2be117`, so the instrument is on the box. Check rather than trust this sentence — a
sha is cheap and this file has been wrong about one before:

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status
```

**THE SESSION LINE IS THE NEW REPORTING WORKING.** `session_ok: false` with `okta_alive: true`
is exactly what migration 065 was built to distinguish: RC rejects the current token, but the
Okta session behind it is alive, so a repair right now is the **11-second cookie-answered** kind
rather than the 12-minute, 9.4 GB password form. `autocart.rc_session` says so in words.

**Still open:** **#160** (the sampler's Windows attribution — see below) and **#146**
(worker-deploy trigger paths — merging restarts both poller machines, deliberately, so do it at
a quiet moment and not near a release).

**#156, #69 and #51 are closed** — and NOT because they were stale, which is what an earlier
draft of this file called them. All three carried findings nobody had folded in: that Feature E's
watch-driven recorder never stopped (rediscovered independently three times, because the
correction kept sitting in an open PR), and that the Okta cap does not reset across a password
sign-in. Both are in `CLAUDE.md` now.

**A REAL TEST HOLD IS QUEUED FOR 08:00 PT ON 2026-08-23** — South Carlsbad #35, unit 45719,
arrival 2026-12-01, hold `51f3ad3d-8856-4bd0-8dd3-b64ad31d8b5f`. It is a TEST; the owner does
not want the site. It locks a real campsite for ~15 min from 07:59:46 until claimed or RC drops
the cart, and the 02:00–05:00 PT box update window is shut while it is queued (the 6h release
gate, correctly). **It buys the cart/claim flow and NOT a leak reading** — see Track A below.

---

## The leak: what is known, what is not

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

## Track A — name it (MERGED, #155, live on the box)

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

**THE TEST HOLD WILL NOT PRODUCE A READING, AND THIS IS THE THING NOT TO GET WRONG.**
`startNativeSampling` has ONE call site — the renewal's throwaway tab. `maybeAutoLogin` and the
rehearsal are not sampled at all, and if T−30 mints a token then `planRenewal` stands down for
the hour. Wiring the sampler into `maybeAutoLogin` is the obvious next move and would put the
biggest trip there is (the 9.4 GB password sign-in) under measurement.

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
