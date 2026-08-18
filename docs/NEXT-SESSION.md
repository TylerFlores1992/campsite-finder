# Next session — the leak is contained and narrowed; the LOGIN is the open risk

*Rewritten 2026-08-18. This is a handover, not a permanent doc. **Delete it once the login is
proven again and the near-expiry renewal has been dealt with.***

---

## Read this first: two things are open, and they are not equally urgent

| | state | urgency |
| --- | --- | --- |
| **The RC login** | hung at the password by hand; no rehearsal PASSED since 08-16 | **This is the one that loses a campsite** |
| **The Chromium leak** | contained (4 firings, box never past 71%), cause narrowed, not cured | Cosmetic by comparison — the box survives it |

The leak ate a whole session because it was interesting. **It is no longer the thing that can
cost somebody a booking.** The login is.

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

### And fix the instrument while you are there

**`rc_login_rehearsal` KEEPS NO HISTORY.** It is one row updated in place (`id 1`). The
2026-08-18 03:01 failure detail was overwritten by the next stand-down and is simply gone —
so the check built to catch a login regression cannot show a trend, and a failure survives
only until the next skip. Verified by reading the table: one row, `ok=null`,
`skipped_why='rehearsed 1h ago'`, `ok_at` still pointing at 2026-08-16.

---

## 2. THE LEAK — what is known, and the one change left to try

### Known, measured, not guessed

- **Family:** the keep-warm's own resident RC browser. 20 ramps in 5 days, ~every 70 min.
- **Not the JS heap.** 15 MB, flat, twelve identical samples, while the process reached 4.9 GB.
  V8's default max old space is ~4 GB and these have peaked at 27 GB, so a JS-heap explanation
  is not available.
- **Renderer AND browser process**, GPU / utility / crashpad flat:
  ```
  baseline  {browser:42,  utility:24, renderer:103,  gpu-process:93, crashpad:2} =  264MB
  ramp      {browser:587, utility:28, renderer:1340, gpu-process:89, crashpad:2} = 2046MB
  ```
- **Onset is the reload after `dropStoredToken`**, NOT the sign-in click:
  ```
     3s ago  6912→3946 MB free @ renew:click-sign-in      (x7)
    73s ago  8440→7253 MB free @ renew:prime-after-reload  (x4)
   113s ago  9060      MB free @ login rehearsal
  ```
  The click is simply the longest step, which is why the stall landed there four times running.

**Leading candidate: network/IPC buffering** — renderer plus browser process, with the network
service evidently not in the (flat) utility process. **Labelled a candidate. Do not promote it
to a finding without evidence.**

### The change left to try — NOT BUILT

**Stop renewing at near-expiry.** The step that leaks is a step that has never worked:

- Every ramp began in a near-expiry renewal (`the token has 10m left (src=live)`) — 5 for 5.
- That cell has **never once succeeded** (`554s → none`, `-115s → none`, and on 08-18 not one
  attempt completed — the guard killed the browser every time).
- The **token-less** cell works and does not ramp: `✓ renewed by authorize: none → 3580s`,
  repeatedly, with `cleared 0 storage key(s)`.

So let the token lapse and renew from empty. The apparent cost — a few dead minutes per hour —
is what we already have, because the near-expiry attempt fails anyway.

**A wobble, recorded so it is not re-discovered as a refutation:** two near-expiry renewals on
08-18 (11:08, 11:38 UTC) show no ramp. Both read `· skipped: no Okta session to renew against`.
They never ran; they neither support nor contradict.

---

## 3. What NOT to redo

- **Do not park the resident tab on `about:blank`.** Measured innocent: it sits at 200–330 MB
  for the best part of an hour and only ramps during the renewal, in all twenty events. Parking
  targets the harmless part and adds a page load per poll from an IP with a 12h block in its
  history.
- **Do not re-add an age recycle.** Built and removed the same night: `localStorage` survives a
  browser restart, so a recycled browser comes back `token source: live` and lands in the same
  near-expiry cell. It changed neither the cell nor the timing.
- **Do not re-add the three throttling-disable flags.** Their stated purpose (catching RC's own
  renewal timer) was disproven twice over. They are not the leak's cause either — that A/B has
  still not been run cleanly — but nothing needs them.
- **Do not ask for heap facts at the trip.** Two firings, two different CDP failures; the
  browser will not answer at that point down a new socket or an existing one. The trail is the
  instrument.

---

## 4. State of the box, as of 2026-08-18 05:00 PT

- mini-PC on `7f5e1d8`; master is ahead by the web-side `sqlit` fix (`4fa84d5`) — **no bot
  update needed for that one.**
- Session **DEAD**, `okta=GONE(404)` after ~12h. The renewal is skipped entirely in that state;
  only a real sign-in recovers it.
- The 08:00 PT hold is **`TEST · 4729`** — synthetic, and 4729 comes from the block of unit ids
  that were **invented** and never verified against real San Miguel inventory. Yesterday's
  `4728` already failed. **No real campsite is at stake in that hold.**

---

## Opening prompt for the next session

> Read `CLAUDE.md` and `docs/NEXT-SESSION.md`. Two things are open. The RC **login** is the
> urgent one: it hung at the password when run by hand, no rehearsal has passed since 08-16,
> and `rc_login_rehearsal` keeps only one row so failures are overwritten — start by getting a
> trustworthy read on whether the unattended sign-in still works, and fix the rehearsal's
> history while you are there. The Chromium **leak** is contained (the RAM guard has caught
> four ramps and the box has not been past 71% COMMIT) and narrowed to non-JS memory in the
> renderer and browser process, beginning at the reload after `dropStoredToken`. The change
> left to try is removing the near-expiry renewal entirely, since that cell has never once
> succeeded and is where every ramp starts. Do not redo the four things in section 3.
