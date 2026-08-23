# Next session — start here

*Rewritten 2026-08-23. Two live threads: the memory leak, and the iOS review.
Delete this file once the sampler has produced a reading from a real ramp AND the App Store
version has a decision. It is a handover, not a permanent doc, and a stale one reads like
current state.*

---

## ⏰ TIME-SENSITIVE — read before anything else

**A REAL hold releases 2026-08-23 07:59:46 PT** (unit `45719`, `requested`). Real numeric id, so
a real campsite is in the pipeline.

**CORRECTED 2026-08-23 ~07:15 PT (this paragraph and the table below were stale from the moment
they were written — the box updated a few hours later the same night and the correction sat
in `docs/NOTES-claude-side-lane-setup-f7bpe2.md` without being folded in here).** The box is
**NOT** missing the instruments:

| | |
|---|---|
| Master | `1cf83a2` |
| Mini-PC | `57e9d79` — **has #160, #163, #166** (updated 08-22 23:12:03 PT, confirmed by
`git-status` per commit #165; re-confirmed live via `autocart.bot_version` ~07:15 PT
2026-08-23, <1h before release: "mini-PC is on 57e9d79; web is on 1cf83a2 — no bot-side code
in the gap") |
| Update gate shuts | **01:59:46 PT** (6h before the release, not liftable) — moot; box was
already current well before this |

What landed (all present on the box now):

- **#160** — the sampler resolves addresses to `module+offset`. **Without it a reading names
  nothing**: Playwright's Windows Chromium exports no internal symbols, and the first real
  reading off the box (08-22 19:34 PT) came back as four bare hex addresses.
- **#163** — the auto-login is sampled at all. It is the 9.4 GB trip, and it was the one nothing
  measured.
- **#166** — the network trace wraps it too.

So today's trip — ramp or not — should be readable with all three instruments live.

**BUT DO NOT EXPECT THE BIG RAMP TOMORROW, and do not read a quiet morning as a cure.** Okta
expires **18:01 UTC = 11:01 PT**, which is AFTER the 08:00 release — so Okta is alive at T−3h and
T−30, the warm-up correctly stands down, and the T−30 sign-in is the **cheap cookie-answered**
kind (11s, +24 MB). The 9.4 GB variant needs `okta=GONE` at T−30.

What tomorrow IS worth: a sampled reading of a **non-ramping** Okta trip, which is the control
this investigation has never had — and the renewal path is sampled all day regardless.

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
| Mini-PC | `57e9d79` — **has all three memory instruments; see the top of this file** |
| Open holds | **one REAL hold**, unit `45719`, releases 08-23 07:59:46 PT |
| RC session | **healthy again** — see below |

**THE SESSION REPAIRED ITSELF AT ~20:30 PT ON 08-22, AND THE MECHANISM MATTERS.** It had been
dead with a **seven-day-stale** token that the renewal could not shift (20 consecutive failures,
then 30m backoff — the stale value comes from the SERVER, so clearing local storage cannot reach
it). What fixed it was the **20:00 PT login rehearsal** submitting a real credential:
`autocart.rc_login` → *"the bot signed in unattended 26m ago"*, and `rc_session` went to
`token exp in 40m; src=live; okta=ALIVE`.

That is the 2026-08-16 pattern exactly, and it is the second time the rehearsal — an instrument
built to *test* the login — has been the thing that **performed** the repair. **Do not credit
the renewal schedule for it.** Crediting a repair to the wrong mechanism has cost this file
three times.

**~~THE BOX BEING BEHIND MASTER IS FINE HERE~~ — TRUE ON 08-22, FALSE FOR A FEW HOURS, TRUE
AGAIN NOW.** That sentence was written when the gap was documentation plus another lane's relay
code, then went false when #160/#163/#166 landed bot-side and the box had none of them. **The
box updated at 23:12:03 PT the same night and took all three in one go** (confirmed by
`git-status`, recorded in commit #165 but never folded into this section until this pass). Left
struck rather than rewritten clean, because the false-for-a-few-hours state is exactly the kind
of thing that gets missed if the correction only lives in a side-lane notes file.

Check rather than trust any sha in this file — it is cheap, and this file has been wrong about
one before:

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status
```

**THE SESSION LINE IS THE NEW REPORTING WORKING.** `session_ok: false` with `okta_alive: true`
is exactly what migration 065 was built to distinguish: RC rejects the current token, but the
Okta session behind it is alive, so a repair right now is the **11-second cookie-answered** kind
rather than the 12-minute, 9.4 GB password form. `autocart.rc_session` says so in words.

**Still open:** **#146** (worker-deploy trigger paths — merging restarts both poller machines,
deliberately, so do it at a quiet moment and not near a release). #160 shipped and is on the
box (see above) — no longer open.

**#156, #69 and #51 are closed** — and NOT because they were stale, which is what an earlier
draft of this file called them. All three carried findings nobody had folded in: that Feature E's
watch-driven recorder never stopped (rediscovered independently three times, because the
correction kept sitting in an open PR), and that the Okta cap does not reset across a password
sign-in. Both are in `CLAUDE.md` now.

> ### `autocart.bot_version` WAS RED FOR A WHILE ON 08-22/23 — SUPERSEDED, THE BOX UPDATED
>
> ```
> FAIL  autocart.bot_version  mini-PC is on e2be117; web is on b8d8848 — and it is MISSING
>                             bot-side changes, with 1 hold(s) queued.
> ```
>
> **This was the state for part of the evening and it was caused deliberately-ish and harmless
> at the time.** #160 and #163 are bot-side, and both were merged while the test hold was
> queued — which is the one configuration `bot_version` fails on, by design. **It is not the
> state now**: the box updated at 23:12:03 PT (a REQUESTED update lifts the quiet window even
> with a hold queued — only the 6h release check is unliftable, and that check had already
> passed by then). Live read ~07:15 PT 2026-08-23: `WARN mini-PC is on 57e9d79; web is on
> 1cf83a2 — no bot-side code in the gap`, i.e. ordinary docs-only drift, not a real gap.
>
> **CORRECTED: the gap is no longer diagnostic-only in the file sense.** An earlier version of
> this note said *"`rc-keepwarm.mjs` and every line of the cart path are byte-identical on both
> sides"*, and #163 made that false within the hour by wiring the sampler into
> `maybeAutoLogin`. What is still true is the thing that matters: **the change is confined to
> `maybeAutoLogin`, adds no logic to the login itself, and every call it adds is bounded (5s)
> and returns a null rather than throwing.** Its cost on the release-critical path is at worst
> ~15s of CDP calls against a 30-minute lead.
>
> **And tomorrow's cart runs the OLD code either way**, because the box is frozen until the
> hold clears — so neither PR can affect it. The risk is deferred to whenever the box next
> updates, which is after the test, which is the right order.
>
> It clears the moment the box updates, which cannot happen until the hold clears (~08:15 PT).
> **The check is right and the merge ordering was the mistake** — bot-side code should land
> when no hold is queued, so this reads red only when it means something. `pages: false`, so
> nothing rings; it is red on the admin page and in the 07:40 pre-flight only.
>
> **If it says anything OTHER than the sampler commit, that is a different fact — read it.**

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

## Track A — name it (MERGED; #155, #160, #163, #166 are ALL on the box as of 08-22 23:12 PT)

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

**#160 IS BOT-SIDE, AND — CORRECTED — it did NOT have to wait for the hold to clear.** A
REQUESTED update lifts the quiet-window gate even with a hold queued; only the 6h release check
is unliftable, and it had already passed by 23:00 PT. The box took #160 (and #163, #166) at
23:12:03 PT the same night, confirmed by `git-status`.

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
