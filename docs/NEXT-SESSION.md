# Next session — RC hand-off: cosmetics, the multi-cart question, Android

*Written 2026-08-13 after the session that proved the two RC cart POSTs. Delete this file
once its three items are done — it is a handover, not a permanent doc.*

Paste the block at the bottom as the opening prompt. Everything above it is the context
that block assumes.

---

## Where things stand

**The cart POSTs are PROVEN (2026-08-13 12:31 PT, iOS).** A synthetic hold from
`scripts/rc-test-hold.mts` carted 1.8s after its release, the bot released at 12:32:24, and
the owner's phone took it: `✓ Added to cart`, confirmed on RC's own cart page showing the
exact unit and dates. Full trace and the mechanism correction are in CLAUDE.md under
"THE CART POSTS NEVER FIRE".

Two things that run counter to what was written down beforehand, both worth re-reading
before building on them:

- **`submit` mints the cart key, not `load`.** The log line reads `precart load ok — cart
  key STILL MISSING (RC returned none)` and the submit carrying the `NO_CART` sentinel
  succeeded anyway. The fix works; the documented mechanism was wrong.
- **The platform was never recorded.** The write-up was one edit from saying "Android"; the
  real answer came from a screenshot's status bar. Now stamped — see item 2.

## The three items

### 1. Cosmetics on the claim + hand-off flow (the owner has notes)

The owner ran two real hand-offs on 2026-08-13 and found the flow "not very clean or
appealing". **Their notes are the input; ask for them first and do not guess.** Two known
from the screenshot, which are examples of the class rather than the whole list:

- The CampHawk banner renders its **"Add to cart" button beside "✓ Added to cart"**, and
  overlaps RC's Sub Total row. It invites a second tap on a cart that is already correct.
- Same family as the 2026-08-12 fix where the InAppBrowser toolbar sat on the content.

**The banner is `extension/content-rc.js`, served to the app by `/api/rc-precart`.** It is
byte-identical for the desktop extension on purpose, so a change there lands in both — check
the extension still reads right. The claim screen itself is `src/components/v2/ClaimFlow.tsx`.

**THE COPY RULE STILL BINDS, and it is now a judgement call rather than a prohibition.**
`worker/rc-handoff.test.mts` fails if the claim copy promises a cart. One hold has now
reported one added, which *earns* the branch on capability — it does not perform it. If you
change that copy, change the test deliberately and say why in the commit; do not let it
happen as a side effect of a cosmetic pass. Note also the first version of that guard was
worthless (it matched raw JSX with a class excluding `<`, so a `<strong>` tag interrupted
the phrase) — mutate it before trusting it.

**Test with a real hold, not by reading.** `scripts/rc-test-hold.mts --find` prints
bookable far-future midweek units; queue one with `--watch <id> --unit <id> --arrival
<date>`, then open the claim screen **in the app** (Admin → System Health → "Open the claim
screen" — a pasted link opens the system browser, where `canInject` is false and the whole
thing being tested is skipped). It locks a real campsite for the length of the test.

### 2. Platform in the report envelope — DONE, verify it landed

`ClaimFlow` now stamps `{stage:'platform', detail:{platform, appBuild, nativeShell, ua}}`
once per claim, before every `openRcHandoff`. Guarded by `worker/rc-report-platform.test.mts`
(mutation-verified against a forgotten exit, a missing once-latch, and a leaked URL).

**Confirm it on the next real hand-off** — a `platform` stage should be the first entry in
`client_reports`. If it is absent, the deploy did not reach the device: the script is served
web-side, so a push to `master` is enough, but check `CH_DEPLOY_SHA`.

### 3. Can one RC session hold more than one cart?

**This is the item that changes capacity.** `RC_HOLD_CAPACITY` = `RC_SITES_PER_CART` (2,
RC's, measured) × `RC_MAX_CARTS` (**1, ours, and 1 only because that is all we can prove**).

The probe exists: `scripts/auto-cart-bot/rc-probe.mjs --cart-cap`. Its header explains the
four steps and why step 3 is the control. **It is bot-side code, so it only runs once the
mini-PC has updated** — `autocart.bot_version` says whether it has arrived.

```
cd scripts\auto-cart-bot
set RC_CAP_UNITS=43793,43794,43795     REM Pfeiffer Big Sur Weyland, verified bookable
set RC_ARRIVAL=2026-12-01
node rc-probe.mjs --cart-cap --headful
```

**TWO confounds must be clear before the answer means anything:**

1. **The bot's cart must be empty** — the header says this. No hold in `carted`/`claiming`.
2. **THE OWNER'S PHONE CART TOO, and the header does NOT say this.** The claim flow now
   carts on the owner's own RC session inside the app. If that login is the same RC account
   the bot uses — likely, since there is one account — then sites sitting in the phone's
   cart occupy the very seats a per-ACCOUNT cap is being tested for, and step 4 gets refused
   for a reason that has nothing to do with carts. **That produces the pessimistic answer,
   which is the expensive one to believe.** Check the phone's cart, or establish that it is
   a different RC account, and record which.

Reading the result: `ok` → the ceiling is ours, the hold runner reuses one cart key and need
not; raise `RC_MAX_CARTS`. `no` → the ceiling is the account, and concurrency costs
identities. **Do not raise `RC_HOLD_CAPACITY` on reasoning alone.**

What is already known, and is weaker than it was written up as: "15 holds, two cart keys"
was the ROW count — only four rows were ever carted. But the runner *did* mint a fresh cart
on 08-13 without being asked to, so **obtaining a second cart is already observed**; what is
unproven is whether two can be live AT ONCE.

## Traps that cost time this session

- **`rc-test-hold.mts` creates a `requested` hold, which blocks the update window** while it
  is live (`nextHoldRelease` counts `requested`, and the guard refuses within 6h of a
  release). Self-clearing once the release time passes, but it will refuse an "Update now"
  pressed in the same minute.
- **An `offered` hold does NOT block it.** The tapped/untapped distinction inverts this
  decision and has been misread twice — re-read it, do not remember it.
- **Pushing to `master` auto-deploys Vercel**, which swaps the claim bundle mid-test. Land
  cosmetic changes between test runs, not during one.
- **Adding any test under `worker/` triggers the worker-deploy Action**, restarting the
  poller. Harmless (the Action fails unless a fresh heartbeat lands) but not free.
- **Tests hit the real DB**, so a CI run briefly injects hold rows visible in the readout.
  Fixtures must be `offered` with a non-numeric sentinel unit id: `dueHolds` does not check
  whether a watch is active, so a `requested` fixture minutes from release would have the
  production runner cart a real site.

---

## Opening prompt

```
CampHawk — RC hand-off: cosmetics, then the multi-cart question.

Read CLAUDE.md, then docs/NEXT-SESSION.md, then docs/CONTEXT.md as needed.

The two RC cart POSTs are PROVEN as of 2026-08-13 (iOS, real hold, confirmed on RC's
own cart page). That question is closed. Three things are open.

TASK 1 — COSMETICS. I ran the claim + hand-off flow twice and it does not look clean
or appealing. I have notes; ask me for them before changing anything. Known: the
CampHawk banner shows an "Add to cart" button next to "✓ Added to cart" and overlaps
RC's Sub Total row. The banner is extension/content-rc.js (served by /api/rc-precart,
byte-identical for the desktop extension — check both). The screen is
src/components/v2/ClaimFlow.tsx.
Do not let the claim copy start promising a cart as a side effect;
worker/rc-handoff.test.mts guards it, that guard was itself broken once, and the
branch-on-capability is a deliberate change of its own.
Test with a real hold via scripts/rc-test-hold.mts --find, opened IN THE APP. Do not
deploy to master while I am mid-test — it swaps the bundle under me.

TASK 2 — CAN ONE SESSION HOLD MORE THAN ONE CART? RC_HOLD_CAPACITY is 2 sites x 1
cart and the 1 is there only because that is all we can prove. rc-probe.mjs
--cart-cap settles it; it is bot-side, so check autocart.bot_version first and press
"Update now" if the box is behind. BEFORE running it, both the bot's cart AND my
phone's RC cart must be empty — the claim flow now carts on my own session, probably
the same RC account, so a leftover site there would fake a per-account refusal.
Do not raise RC_HOLD_CAPACITY on reasoning alone.

TASK 3 — ANDROID. The cart POSTs are proven on iOS only. Android has had sign-in,
persistence and token capture measured, never load+submit. ClaimFlow now stamps the
platform into client_reports, so one Android hand-off answers it — tell me what to run.

WORKING RULES: branch, npm run verify + CI green, merge to master (auto-deploys).
Mutation-test any regression test before trusting it. Prefer small scripts that print
only the answer. A health reading goes stale faster than a conclusion drawn from it.
```
