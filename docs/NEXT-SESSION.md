# Next session — the leak is contained and narrowed; the LOGIN is the open risk

*Rewritten 2026-08-18. This is a handover, not a permanent doc. **Delete it once the login is
proven again and the near-expiry renewal has been dealt with.***

---

## Read this first — START HERE, and it is not what the rest of this file used to say

**The orphan sweep is BUILT** (`scripts/auto-cart-bot/orphan-sweep.mjs`) — the keep-warm kills
any Chromium on `.rc-bot-profile` the moment it takes the lock, before it launches. That is the
one safe placement: `rc-hold-runner.mjs` drives the same directory, so a sweep at plain process
start could land at 08:00:00 on the Chromium that is carting. Once we hold the lock the runner
does not, so anything still there is owned by nobody.

**It is bot-side, so none of it is live until the box updates.** Until then the 25 GB case can
recur exactly as it did.

| | state | urgency |
| --- | --- | --- |
| **The RC login** | account changed and signed in by hand; no unattended rehearsal has passed since 08-16 | **This is the one that loses a campsite** |
| **Orphaned Chromium** | sweep built, unproven — needs a box update, then a real orphan | Watch for `♻ orphan sweep` in the keep-warm log |
| **The Chromium leak** | trigger NAMED (the Okta navigation); recycled after each round trip | Understood; watch that ramps now peak ~2.3 GB |

### The single most useful thing to check first

**Is the session still renewing itself with no ramp?** In the 2.5 hours after the near-expiry
stand-down went live, the token was re-minted twice (`exp in 15m` → `54m`, twice) with **zero
`renewing the session` lines** and **no memory event above 400 MB**. Our renewal never ran and
the SPA did it for free.

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/chromium-memory-readout.mts
```

- Still no ramps overnight ⇒ the stand-down did more than halve the leak; it removed our Okta
  round trips from the steady state.
- Ramps returned ⇒ something is navigating again. Check the keep-warm log for `renewing the
  session` and for `attemptLogin` — the login navigates and therefore still leaks by
  construction, and no schedule can change that.

**Two cycles is not a regime.** Do not quote it as "the leak is solved", and do not write in a
mechanism for the silent re-mint — three candidates are listed in `CLAUDE.md` and none is
established.

### What to watch once the box updates

- `♻ orphan sweep: killed N Chromium…` in `logs\rc-keepwarm.log` — the first real firing. It
  is **silent when there is nothing to kill**, so silence is the healthy reading, not evidence
  it did not run.
- `⚠ orphan sweep did not complete` means the spawn failed and carries stderr. That is the
  guard failing, not finding nothing.
- **`rc-diag.mjs --real-profile` now loses its browser** to a restarted keep-warm unless the
  watchdog task is disabled. Its header says so; that procedure already required it.

---

## 1. THE LOGIN — start here

**The owner ran the sign-in by hand on 2026-08-17 and reported it "got hung up at password."**

That is a signature, not a vague symptom:

- A **wrong** password is REJECTED — Okta renders an error banner and `diagnose()` reports
  `badCreds` → *"ReserveCalifornia rejected the email or password"*.
- **Hanging** matches the 2026-08-06 reCAPTCHA instead, where the control reports
  `enabled=true` and every click times out because the challenge overlay swallows pointer
  events. **Retrying harder can never work.**

So `maybeAutoLogin` at T−30 should be expected to fail too — it runs the same `attemptLogin`.

### What to do

1. **`mini-pc\rc-test-login.bat` on the box, with a human watching.** It clears the token
   ONLY (never the cookies — the `DT` device cookie is what stops a sign-in looking like a
   fresh profile, and losing it cost 12h of IP block on 08-06) and runs the real
   `attemptLogin`. It reads Okta's own error banner, so it distinguishes CAPTCHA from bad
   credentials from a form that never appeared. **A failure leaves the profile signed OUT.**
2. If it is a CAPTCHA: the headful path waits up to 5 minutes for a human to solve it. That is
   survivable for a person at the keyboard and fatal unattended, which is the whole reason
   `maybeAutoLogin` gets ONE attempt and then rings the phone.
3. Do **not** loop retries from that address. Repeated sign-ins are what cost the household IP
   twelve hours on 2026-08-06.

### WHY THE REHEARSAL KEEPS PROVING NOTHING — measured 2026-08-18

`checkAndReport` asks `oktaSessionAlive(ctx)` on **every** keepalive tick. Twelve consecutive
readings off the box, across three hours:

```
checked 17:07:02  exp 2026-08-19T05:07:02   → +12.0000h
checked 17:27:02  exp 2026-08-19T05:27:02   → +12.0000h
   … ten more, every one +12.0000h from the moment it was CHECKED …
checked 19:50:40  exp 2026-08-19T07:50:40   → +12.0000h
```

A fixed 12h from creation would print the same instant each time. **It moves with the clock,
to the second.** So the Okta session is a rolling idle window our own polling resets, and it
cannot idle out while the keep-warm runs.

- The rehearsal needs RC to **reject** the session before it will type a password. With Okta
  permanently fresh, the sign-in click is answered from the cookie with no form →
  `provedNothing` → inconclusive. Its one lifetime pass came from a genuinely empty profile.
- **The "~12h Okta session" figure throughout `CLAUDE.md` is our probe's window, not RC's.**
- **Do not "fix" the unconditional probe.** It is load-bearing by accident: a session that
  never idles out is why this bot goes days without a password.
- Two candidate fixes for the rehearsal, neither built: intercept RC's own `/authorize` with
  `page.route` and add **`prompt=login`** (non-destructive, unverified), or snapshot-and-delete
  the `idx` cookie with a restore on failure (certain, destructive). **`DT` must survive
  either way.**

### The rehearsal now FORCES the form — read its next run carefully

`withForcedLoginPrompt` adds `prompt=login` to RC's own authorize request, so Okta should show
the credential form instead of answering from the cookie. **Bot-side; live once the box
updates.** Three outcomes, and they mean different things:

| the log says | what it means |
| --- | --- |
| `asked Okta for a fresh credential — rewrote N authorize request(s)` then a **pass** | it works; `autocart.rc_login` goes green and stays green |
| `rewrote N` then **inconclusive**, detail says *"Okta declined to re-prompt"* | Okta ignores `prompt=login`. **This approach is dead** — go to the destructive cookie drop |
| `the authorize request was never intercepted` | the route did not fire; the run says nothing about the password. Fix the interception, do not conclude anything |

**If ramps come back hourly, suspect a leaked route first.** A handler left installed would
force `prompt=login` onto every silent re-mint. It is disarmed two ways and tested, but it is
the one failure mode of this change that would be expensive.

### And fix the instrument while you are there

**`rc_login_rehearsal` KEEPS NO HISTORY.** It is one row updated in place (`id 1`). The
2026-08-18 03:01 failure detail was overwritten by the next stand-down and is simply gone —
so the check built to catch a login regression cannot show a trend, and a failure survives
only until the next skip. Verified by reading the table: one row, `ok=null`,
`skipped_why='rehearsed 1h ago'`, `ok_at` still pointing at 2026-08-16.

---

## 2. THE LEAK — the trigger is NAMED, and the schedule cannot cure it

### The controlled comparison (2026-08-18 19:04–19:14 UTC)

Three **token-less** renewals, ten minutes apart, same code, same profile, same browser
generation. The only difference is whether RC's sign-in control was found and clicked:

| time | stage reached | navigated to Okta? | `rc` at the next sample |
| --- | --- | --- | --- |
| 19:04:04 | `no-signin-control` | no | 200 MB |
| 19:10:43 | `authorize` ✓ (`none → 3579s`) | **yes** | **2,331 MB** |
| 19:13:46 | `no-signin-control` | no | 237 MB |

The two that never navigated ran the identical `dropStoredToken`, `renew:reload` and
`renew:prime-after-reload` and allocated nothing. **So it is the Okta navigation.** The RAM
trail's "onset at the reload" was where the stall was *caught*, one level in from where the
click was caught before it.

The arithmetic agrees: a near-expiry renewal makes **two** Okta trips (the SPA's own hidden
`prompt=none` once a real clear signs it out, then our click) and lands at 4–5 GB; one trip
lands at 2.3 GB.

### What that changed

- **Half of yesterday's plan is false.** The token-less cell *does* ramp. The near-expiry
  stand-down halves the leak and cannot cure it.
- **No schedule can cure it.** `attemptLogin` navigates to Okta too and is release-critical.
- **So the browser is recycled after any Okta round trip**, keyed on the click
  (`renewSession` returns `visitedOkta`), read from one flag at the top of the resident loop.
  Safe for exactly the reason the age recycle was useless: `localStorage` survives a restart,
  so the freshly minted token does, and `planRenewal` then stands down for 59 minutes.
- **Still unknown, and now moot:** whether the 2.3 GB accumulates across renewals in one
  browser life. Nothing has ever run two — the guard always killed it first.

### Still open on the leak

- **The mechanism inside the Okta page load.** Non-JS memory, renderer + browser process,
  network/IPC buffering is a CANDIDATE and is not promoted. Nothing distinguishes it yet.
- **Watch for:** ramps should now peak at ~2.3 GB (one trip) and be followed within a minute
  by a `♻ recycling the browser` line and a 200 MB baseline. A 4–5 GB ramp after the box
  updates would mean something still makes two trips.

### Earlier, still true

- **Family:** the keep-warm's own resident RC browser. 20 ramps in 5 days, ~every 70 min.
- **Not the JS heap.** 15 MB, flat, twelve identical samples, while the process reached 4.9 GB.
  V8's default max old space is ~4 GB and these have peaked at 27 GB, so a JS-heap explanation
  is not available.
- **Renderer AND browser process**, GPU / utility / crashpad flat:
  ```
  baseline  {browser:42,  utility:24, renderer:103,  gpu-process:93, crashpad:2} =  264MB
  ramp      {browser:587, utility:28, renderer:1340, gpu-process:89, crashpad:2} = 2046MB
  ```
- A near-expiry ramp loses memory in **two** places, which is the two Okta trips:
  ```
     3s ago  6912→3946 MB free @ renew:click-sign-in      (x7)
    73s ago  8440→7253 MB free @ renew:prime-after-reload  (x4)
   113s ago  9060      MB free @ login rehearsal
  ```
  Read oldest-first. The `prime-after-reload` loss is the SPA's own hidden `prompt=none`
  after a real clear; the `click-sign-in` loss is ours. Neither occurs when the clear takes
  nothing and the click finds no control — which is what the table above measures.

**Leading candidate for the mechanism: network/IPC buffering** — renderer plus browser process,
with the network service evidently not in the (flat) utility process. **Labelled a candidate.
Do not promote it to a finding without evidence.**

**Both near-expiry renewals on 08-18 at 11:08 and 11:38 UTC show no ramp, and prove nothing** —
both read `· skipped: no Okta session to renew against`, so they never ran. Recorded so they are
not re-discovered as a refutation.

---

## 3. What NOT to redo

- **Do not park the resident tab on `about:blank`.** Measured innocent: it sits at 200–330 MB
  for the best part of an hour and only ramps during the renewal, in all twenty events. Parking
  targets the harmless part and adds a page load per poll from an IP with a 12h block in its
  history.
- **Do not re-add an age recycle.** Built and removed the same night: `localStorage` survives a
  browser restart, so a recycled browser comes back `token source: live` and lands in the same
  near-expiry cell. It changed neither the cell nor the timing. **The post-Okta recycle is a
  different thing and is deliberately keyed on the event** — that same `localStorage` fact is
  what makes it safe rather than useless, since the token it just minted survives the reopen.
- **Do not re-add the three throttling-disable flags.** Their stated purpose (catching RC's own
  renewal timer) was disproven twice over. They are not the leak's cause either — that A/B has
  still not been run cleanly — but nothing needs them.
- **Do not ask for heap facts at the trip.** Two firings, two different CDP failures; the
  browser will not answer at that point down a new socket or an existing one. The trail is the
  instrument.

---

## 4. State of the box, as of 2026-08-18 12:40 PT

- mini-PC on `f02e497` — it HAS the near-expiry stand-down (`renewal stood down: the token has
  59m left — waiting for it to lapse`, first seen 19:21:33 UTC). It does **not** yet have the
  reason-reporting fix, the inconclusive fix, or the Okta recycle.
- **The RC account was changed this morning** after the old one would not sign in; the owner
  signed in by hand seconds before the 08:00 hold. `rc-test-login.bat` then succeeded at
  ~19:21 UTC and the session is live (`token exp in 45m; okta=ALIVE`).
- `rc_login_rehearsal_log` (migration 063) is live and holds its first row — the 19:13 failure.
  **The singleton still reads that failure**, because the run the owner watched succeed
  reported nothing at all; that is what the inconclusive fix addresses.

---

## Opening prompt for the next session

> Read `CLAUDE.md` and `docs/NEXT-SESSION.md`. Two things are open. The RC **login** is the
> urgent one: the account had to be changed and signed in by hand seconds before an 08:00
> hold, and no unattended rehearsal has passed since 08-16 — start by getting a trustworthy
> read on whether the unattended sign-in still works, now that the rehearsal keeps a history
> and reports its inconclusive runs. The Chromium **leak**'s trigger is named: the **Okta
> navigation**, established by a controlled comparison of three token-less renewals that
> differ only in whether the sign-in control was clicked. The browser is now recycled after
> any Okta round trip; confirm from the memory series that ramps peak near 2.3 GB and are
> followed by a `♻ recycling the browser` line. Do not redo the four things in section 3, and
> do not re-assert that the token-less cell does not ramp — it does.
