# Next session — start here

*Rewritten 2026-08-22. Delete this file once PR #155 has produced a reading from a real ramp.
It is a handover, not a permanent doc, and a stale one reads like current state.*

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
| Master | `48111c4` |
| Mini-PC | `48111c4` — **in sync** |
| Open holds | none |
| RC session | healthy (Okta ALIVE, ~12h window) |

**Open PRs, both green:**

- **#155 — the native memory sampler.** The instrument that would NAME the allocation. **This is
  the one that matters.** Merge it and update the box, or the next ramp goes unmeasured like the
  twenty before it.
- **#146 — worker-deploy trigger paths.** Merging restarts both poller machines (the workflow is
  in its own path list, deliberately), so do it at a quiet moment, not near a release.

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

## Track A — name it (built, PR #155)

`scripts/auto-cart-bot/rc-native-sampler.mjs`, wired into the renewal's Okta trip.

Verified before it was written — the same 640 MB came back as:

```
partition_alloc::PartitionRoot::Alloc<>() <- namespace)::ArrayBufferAllocator::Allocate()
```

2% error, a few kilobytes of response. It is a Poisson sampler: output scales with **distinct
stacks**, not bytes — the opposite shape from the multi-GB heap snapshot the house rules forbid
writing when the box cannot spawn a process.

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

**So: merge #155, update the box, get one reading, then take Track B to the owner with evidence.**

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
- **A guard that anchors on a token occurring twice will break silently.** It has now happened
  twenty-one times. When one fails over unchanged behaviour, re-anchor it and then **verify it
  still fails against the regression it exists for** — a re-anchor that quietly weakens a guard is
  worse than the break.
