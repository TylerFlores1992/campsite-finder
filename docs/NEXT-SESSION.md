# Next session — the leak has its first CURE, and it has never run

*Rewritten 2026-08-19 (evening PT). A handover, not a permanent doc. **Delete it once the tab
renewal has been observed on the box and the two open questions below are answered.***

**Do not start anything until the owner says so.** Everything here is merged, verified and
waiting; the useful first move is reading state, not writing code.

---

## Read this first

**Master is `ab9bcfb`. Six PRs merged on 2026-08-19 (#138–#143).** The box may or may not have
them — check, do not assume:

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status
```

`autocart.bot_version` on the admin page is a HINT and can show a **stale sha beside a live
heartbeat** (COALESCE keeps the last reported value). `git-status` is the authority.

### The one thing that matters most

**The leak's first cure is built, guarded, and has NEVER EXECUTED.** `renewSession`'s Okta
round trip now runs in a **throwaway tab closed in a `finally`** — same context and cookies, so
the minted token lands in the same profile, but the renderer that allocates dies at close
instead of the whole browser being recycled.

It rests on three measurements, all in CLAUDE.md: the ramp is **non-JS** (heap flat at 15–18 MB
against multi-GB processes), it lands in the **renderer + browser process**, and across twenty
ramps it has **never once come back down in place** — every recovery was a new pid.

**How to read the memory series once it runs** (`scripts/chromium-memory-readout.mts`):

| what you see | meaning |
|---|---|
| spikes that drain at tab close, no `♻ recycling` line | **working as designed** |
| rc-family growth ACROSS renewals | the browser-process share does not drain — that residual is the next target |
| no spikes at all | better than expected; do not credit it without checking a renewal actually ran |

**It does NOT claim the allocation stops.** A ramping trip still ramps while it runs and the RAM
arm still guards it. The claim is only that the memory comes back, every time, without costing
the browser.

---

## Two open questions, both one reading away

**1. Where does the three-day-old token come from?** Eliminated so far: `localStorage`,
`sessionStorage`, **IndexedDB** (no databases at all). The next failed renewal prints either
`TOKEN-SHAPED COOKIE(S) — the corpse may live here` or `NONE token-shaped … coming from the
server`. Either line closes it. A cookie is fixable (`dropStoredToken` learns to reach it); the
server is a different investigation no clear can fix.

**2. Does `prompt=login` force Okta's form?** Still unproven. The rehearsal keeps landing on
`provedNothing` because our own liveness probe keeps the Okta cookie permanently fresh (measured
12 for 12). Look for one of these in `tail-log rc-keepwarm`:

- `(asked Okta for a fresh credential — rewrote N authorize request(s))` → it fired
- `(the authorize request was never intercepted …)` → **our** bug, not Okta's

A `provedNothing` WITH rewrites > 0 retires the approach in favour of the destructive cookie
drop. That distinction is the whole reason the count is printed.

**You can now trigger this remotely** — Admin → System Health → **"Prove the unattended RC
sign-in works, now"**, or `bot-ask.mts test-login`. It runs the same body as the nightly.
One per 6h, never within 6h of a release, and it refuses out loud.

---

## What is NOT broken, so nobody re-investigates it

- **The renewal works.** `✓ renewed by authorize: none → 3580s`, twice on 08-19, unattended,
  under a minute, from a token-less profile. What made it *look* broken was the stale token
  poisoning the path; a real sign-in clears it.
- **The login works.** A hand sign-in took **17 seconds** with no CAPTCHA — Okta still remembers
  the device via `DT`. The 08-18 "hung at password" reading is not a standing fault.
- **A blank RC app** (*"We're having trouble loading the application"*) is transient more often
  than not, and `maybeAutoLogin` no longer treats it as a failed login. Only if it PERSISTS is
  it the 08-14 profile fault — remedy is the rename, at the cost of `DT`, so it is a last resort.
- **`autocart.rc_runner` saying "1 hold(s) due"** during a merge is a `npm test` fixture. It can
  no longer make the runner take the profile (#138), but `dueHolds` still returns them by design.

---

## Standing traps worth re-reading before touching anything

- **A health reading taken 0 seconds after a restart is not evidence.** `rc_session` read `fail`
  twice on 08-19 purely because the keep-warm had not primed the token yet.
- **`npm test` hits the production DB.** `rc-hold-capacity` and `claim` flake against
  *production's own* `expire-holds` sweep — **not** only against a second test run. A re-run is
  legitimate when the diff cannot touch `worker/`, the suite passes alone, and you say so.
- **Never invent an RC unit id.** `scripts/rc-test-hold.mts --find` is the only way.
- **`.ps1` files must be pure ASCII** — one em dash took all four supervised processes down.
- **Guards anchored on proximity windows or whole expressions break over unchanged behaviour.**
  That happened three more times on 08-19 (rehearsal's `!facts.reachable`, the recycle's return
  literal, the trace's `page`). Re-anchor on the property; never relax.

---

## Immediate operational state (verify, do not trust — this ages fast)

- **Test hold `4734` releases 08:00 PT 2026-08-20.** Open the claim link **in the app**, not a
  browser, or the injected precart never runs.
- Hold `43823` is `offered` and untapped for the same morning. An untapped offer never carts
  **and** does not arm `maybeAutoLogin` (`nextHoldRelease` counts `requested`, not `offered`).
- **iOS 1.0 (5) is back in review** — the 3.1.1 rejection was answered with the US-storefront
  link-out, live and verified in the deployed bundle. `LINKOUT_BY_STORE` is `{ios: true,
  android: false}`; **Android stays false until Play production is US-only.**

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts
curl -s https://camphawk.app/api/health/status | python3 -m json.tool
```
