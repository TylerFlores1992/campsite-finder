# Next session — two measurements, both needing a human

*Started 2026-08-13 after the session that proved the two RC cart POSTs. Rewritten the same
evening: the UI overhaul is done and the diagnostics channel is cleared, so only the two
items that need somebody at a keyboard remain. **Delete this file once both are answered.***

---

## Done since the last handover — do not re-do these

- **The claim + hand-off UI overhaul is shipped and on master** (`3ce77d9`, `0e91c99`). All
  six of the owner's notes: holds in the Watches tab, the CampHawk logo linking home, RC
  opening at the top rather than at the calendar, a large SIGN IN instruction in place of an
  Add-to-cart button that could not work, a full-screen webview instead of a card with the
  page showing behind it, and a plain "it's in your cart — tap the cart icon". Full write-up
  in CLAUDE.md under "THE HAND-OFF UI OVERHAUL".
- **The cart promise is earned and allowed**, on `canInject` only and post-release only.
  `worker/rc-handoff.test.mts` now calls `handoffCopy` instead of reading a file.
- **The diagnostics channel is fine.** Command #37 was claimed in 2 seconds by `bot` and
  answered in 3.9. #36 was orphaned by the 20:21 update, not swallowed by `botControlFor`.
  `scripts/bot-command-probe.mts` is the tool if it ever needs re-asking.
- **Two bugs in the hand-off instrument**, both found by pointing the readout at the runs
  that proved the cart POSTs: the report collapse was consecutive-only against an
  interleaved flood (so the verdict was trimmed off), and the readout quoted a re-injection's
  "already added" as the outcome. Both fixed; see CLAUDE.md.

---

## 1. Can one RC session hold more than one cart?

**The item that changes capacity.** `RC_HOLD_CAPACITY` = `RC_SITES_PER_CART` (2, RC's,
measured) × `RC_MAX_CARTS` (**1, ours, and 1 only because that is all we can prove**).

`scripts/auto-cart-bot/rc-probe.mjs --cart-cap` settles it and is on the box (it shipped in
`bf387c8`; `autocart.bot_version` read `c682aa8` on 08-13, which is after it). It is headful
because RC serves a reCAPTCHA on sign-in, so **only a human at the mini-PC can run it.**

**Run `mini-pc\rc-cart-cap.bat`** — it carries the units, the two confounds and how to read
the four outcomes. It needs the box to be on `3ce77d9` or later; before that, by hand:

```
cd scripts\auto-cart-bot
set RC_CAP_UNITS=43793,43794,43795
set RC_ARRIVAL=2026-12-01
set RC_NIGHTS=1
node rc-probe.mjs --cart-cap --headful
```
(The probe reads the DPAPI-stored password as of `3ce77d9`. On an older checkout it still
wants `RC_EMAIL`/`RC_PASSWORD` in the environment.)

**BOTH CONFOUNDS MUST BE CLEAR, and each fakes the pessimistic answer — the expensive one to
believe:**
1. **The bot's cart empty** — no hold in `carted`/`claiming`. `rc-holds-readout.mts` says.
2. **The owner's PHONE cart empty too, which the probe's own header does not mention.** The
   claim flow now carts inside the app on the owner's own RC session, and there is one RC
   account, so a site left there occupies exactly the seat a per-ACCOUNT cap is being tested
   for. A completed BOOKING is fine — that is a reservation, not a cart entry.

Reading it: `THE CAP IS PER CART` → the ceiling is ours, the runner reuses one cart key and
need not, raise `RC_MAX_CARTS`. `NOT PER CART` → it is the account, and concurrency costs
identities. `RC PUT IT BACK IN THE SAME CART` → treat the cap as binding. `INCONCLUSIVE` is
**not an answer** and must not be rounded to one. **Do not raise `RC_HOLD_CAPACITY` on
reasoning alone.**

What is already known and is weaker than it was written up as: "15 holds, two cart keys" was
the ROW count and only four were ever carted. But the runner DID mint a fresh cart on 08-13
without being asked to, so obtaining a second cart is already observed; what is unproven is
whether two can be live AT ONCE.

## 2. Do the cart POSTs fire on Android?

Proven on iOS twice (2026-08-13, one confirmed by eye on RC's own cart page). Android has
sign-in, session persistence and token capture measured — never `load` + `submit`. WKWebView
and Android's WebView differ exactly where this feature lives, so a result on one is not a
result on both.

**One Android hand-off answers it, and the readout now says so by itself.** Queue a hold,
open the claim screen **in the Android app**, complete the hand-off, then:

```
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts
```

The HAND-OFF section prints `[android build …]` and the outcome. `✓ Added to cart` is the
answer. "nothing reported" is the ordinary plain-browser case, not a failure — and if the
platform tag is missing, the claim screen never ran on a build carrying the stamp, which
means the URL was opened in the system browser rather than in the app.

To queue one:
```
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts --find        # pick a real unit
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-test-hold.mts \
  --watch <id> --unit <id> --arrival 2026-12-01
```
It prints the claim URL. **Open it IN THE APP** (Admin → System Health → "Open the claim
screen"); from a browser `canInject` is false and the injected precart — the whole thing
being tested — never runs. It locks a real campsite until the claim releases it.

## Traps worth keeping

- **`rc-test-hold.mts` creates a `requested` hold, which blocks the update window** while it
  is live (the guard refuses within 6h of a release). Self-clearing once the time passes.
- **An `offered` hold does NOT block it.** This inverts the decision and has been misread
  twice — re-read it, do not remember it.
- **Pushing to `master` auto-deploys Vercel**, which swaps the claim bundle mid-test. Land
  changes between test runs, not during one.
- **"Update now" takes ~20 minutes, not ~2**, and shows `SKIP - another process holds the
  update claim` in the meantime. That is TRANSIENT — a poller spawns the updater once per
  process life, so the retry that lands is the Windows task on its 5-minute tick.
  **`autocart.bot_version` answers "did it land?"**, not `appliedNote`.
- **Tests hit the real DB**, so a CI run briefly injects hold rows visible in the readout.
  Fixtures are `offered` with a non-numeric sentinel unit id, because `dueHolds` does not
  check whether a watch is active.
