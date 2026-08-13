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

### 1. The claim + hand-off UI (the owner's notes, from two real runs on 2026-08-13)

The owner ran the flow twice on iOS and found it "not very clean or appealing", and has
**explicitly said a complete overhaul is fine if it makes sense** — this is not a
constrained tidy-up. The target: *hold the same style as the app, very user friendly and
appealing.* Their six notes, verbatim in substance:

1. **Holds should appear in the Watches tab**, so they can be found and started without
   relying on the notification or the email.
2. **Replace the tent glyph with a proper CampHawk logo**, decently sized, that links back
   to the app/site when tapped. (Today it is a lucide `Tent` icon in `ClaimFlow.tsx`.)
3. **Tapping "Start hand-off" scrolls you down to the calendar.** It should stay at the top
   so the RC sign-in button is easy to find.
4. **Replace the "Add to cart" box with a large, clear "sign in" instruction** at that
   stage — the user's job there is to sign in, and the UI is offering a cart button.
5. **Seeing the page behind the webview at the top looks choppy.** Make that seam clean.
6. **Once carted, say so plainly** — that it is in the cart, and to tap the 🛒 to check out.

**Notes 4 and 6 are one thing: the banner has three states and currently blurs them.**
*needs sign-in* → *working* → *carted, go check out*. The screenshots show `✓ Added to
cart` rendered **beside a still-live "Add to cart" button**, which invites a second tap on
a cart that is already correct.

**WHERE THE CODE IS, and the constraint that shapes how far to go:**
- The claim screen is `src/components/v2/ClaimFlow.tsx` — ours, on the `--ch-*` tokens,
  and the right place to be ambitious.
- **The banner is `extension/content-rc.js`, served to the app by `/api/rc-precart`, and
  byte-identical for the desktop Chrome extension by design.** A redesign lands in both.
  It is also injected into *RC's own page*, so heavy styling risks colliding with their CSS
  and reads like an ad or a phishing overlay. **Recommendation: overhaul the CampHawk-owned
  screen, but keep the banner restrained** — three unmistakable states, big type, minimal
  chrome. It also runs inside the ~2.5s exposure window, where a bug costs a campsite.
- Note 5 is the InAppBrowser presentation (`src/lib/native/rc-handoff.ts`). `location=yes`
  **must stay** — hiding whose site you are authenticating on is the shape of a phishing
  page — so solve the seam with the toolbar's own styling, not by removing it.
- Note 3: RC's SPA does the scrolling after load. The injected script already runs at
  `loadstop`, so scrolling to top there is the cheap fix; `lib/booking-url` is the only
  place allowed to build the `/park/<placeId>/<facilityId>` URL.
- Note 1 is a **feature, not cosmetics** — the Watches screen needs a live-holds surface
  and a way into the claim screen. Today `/claim/<id>?t=<token>` is token-authed and
  `noindex, nocache` precisely because the token authorises the release. From the Watches
  tab the user is already signed in, so mint the entry server-side for the owner rather
  than putting a token in client state. **It must open in-app**, or `canInject` is false
  and the automatic cart silently degrades to the manual path.

**THE COPY RULE — note 6 is exactly the change it has been guarding against, so read this.**
`worker/rc-handoff.test.mts` fails if the claim copy promises a cart, because promising one
before the cart POSTs were proven would have had users stop watching a site nobody had
secured. **TWO holds have now reported `✓ Added to cart` (12:31 and 12:47 on 2026-08-13),
which earns the branch** — so note 6 is legitimate, and the guard must be updated
*deliberately*, in its own commit, saying what changed and why. Do not let it fall over as
a side effect of a redesign.
- **Branch on capability, not on hope.** `canInject` false (any plain browser) still gets
  the manual copy; the promise is only honest where the injected precart actually runs.
- The first version of that guard was **worthless** — it matched raw JSX with a character
  class excluding `<`, so the tag in `add <strong>{site}</strong> to your cart` interrupted
  the phrase and the mutation passed. **Mutate it before trusting it.**

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

TASK 1 — REDESIGN THE CLAIM + HAND-OFF UI. I ran it twice on iOS and it is not clean
or appealing. A complete overhaul is fine if it makes sense to you. It must hold the
same style as the app, and be user friendly and appealing. My six notes:
  1. Holds should appear in the Watches tab, findable and startable without the
     notification or email.
  2. Replace the tent glyph with a decent-size CampHawk logo that links back to the
     app/site.
  3. "Start hand-off" scrolls down to the calendar — keep it at the top so the RC
     sign-in button is easy to find.
  4. At that point, replace the "Add to cart" box with a large clear instruction to
     SIGN IN.
  5. Seeing the page behind the webview at the top looks choppy — make it clean.
  6. Once carted, say plainly that it is carted and to tap the cart icon to check out.
Notes 4 and 6 are one thing: the banner has three states (needs sign-in / working /
carted) and currently blurs them — it shows "Added to cart" next to a live "Add to
cart" button.
Screen: src/components/v2/ClaimFlow.tsx. Banner: extension/content-rc.js, served by
/api/rc-precart and byte-identical for the desktop Chrome extension — a change lands
in both, it is injected into RC's own page, and it runs inside the ~2.5s exposure
window. Note 1 is a feature, not cosmetics. Note 5 is the InAppBrowser; location=yes
must stay.
Note 6 is the change worker/rc-handoff.test.mts exists to block. Two holds have now
reported "Added to cart", so it is earned — update that guard deliberately, in its
own commit, branching on canInject. Mutate it before trusting it; the first version
of it was broken.
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
