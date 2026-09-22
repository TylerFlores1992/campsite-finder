# Next session — start here

*Rewritten from scratch **2026-09-10** (main lane). It had reached 1,603 lines of stacked dated
blocks, which is the opposite of a handover.*

**This is a HANDOVER, not a permanent doc. `CLAUDE.md` owns every finding.** Nothing here is the
only copy of anything — the ten items that were, got folded into `CLAUDE.md` before this rewrite
(see "TEN THINGS THAT LIVED ONLY IN THE HANDOVER"). **Keep it this way: when a block here goes
stale, delete it rather than striking it through.** Strikethrough belongs in `CLAUDE.md`, where the
correction is itself the record; here it is just weight.


## 0. FIRST: THE BURST HAS NOW BEEN OBSERVED, AND IT STOPS WHEN IT WINS

*This section replaced the 09-17 "the burst has never been observed" block, which is answered:
it fired twice on 2026-09-21 and both rows are in `bot_events`.*

**Read `CLAUDE.md` → "THE CART BURST STOPS WHEN IT WINS".** Two Carpinteria holds carted at the
08:00 PT release and **both hand-offs were declined** by RC. Three separate defects, all found
from the runner's own log:

```
15:00:00  x could not hold #R359: HTTP 200 (13 fast attempts ending T-0.5s … RC said something else: HTTP 200)
15:00:00  v held #M450 - won it on attempt 14 at T+0.1s
15:00:24  x could not hold #R359: cart is already added      <- and ~75 more, every ~12s
15:15:03  v held #R359 - entry 9b6aa2dc-...
```

1. **The burst's stop condition fires on SUCCESS.** `why = v.error || \`HTTP ${status}\`` and a
   successful submit has no `ErrorMessage`, so `why` became the string `"HTTP 200"`,
   `isNotAvailable` did not recognise it, and the lane stopped at **T−0.5s with 15 budget left**.
   **We won `#R359` and reported a loss.**
2. **`cart is already added` was logged as a failure** ~75 times over 15 minutes — RC telling us
   the site was already ours. **`carted_at` and a large `T+s` are a LABEL, not a late win.**
3. **The hand-off made exactly ONE attempt.** 40 attempts to take a campsite, one to hand it
   back. `#M450`'s release genuinely happened (`-> handed over #M450 (HTTP 200)`), so its decline
   was a competitor or un-propagated release, and one POST resolved that by assuming the worse.

**All three are fixed and LIVE** (#385, #388, #389). The hand-off retry is web-side and was
verified serving from `/api/rc-precart`; the burst fixes are on the box at `eeb9d05`, confirmed
by `bot-ask git-status`.

**What is still open from it** is in `CLAUDE.md`'s Open block: `#M450`'s decline, `released`
having no "handed off and lost" state, and why `findCartEntry` misses.

**AND THE LATE TEXT WAS THE SAME BUG.** `notifyHeld` fires on `markCarted`'s TRANSITION, so the
owner was told at 15:15:03 because that is when the read-back matched. Nothing about the
campsite changed. A mislabelled hold is a text that does not arrive.

## 0a. THE rec.gov RECONNECT IS FIXED AND LIVE ON BOTH HALVES — nothing is pending

**Read `docs/ARCHIVE-RC-AUTOCART.md` → `"RECONNECT AUTO-CART FOR REC.GOV" WAS ONE
HIDDEN INPUT, AND THE LOOP WAS CLOSED`.** (The heading carries its own inner quotes — grep for
`WAS ONE HIDDEN INPUT`.) Reported from the Android app on 2026-09-18: *"reconnect auto-cart for rec.gov"*, the
reconnect failing with credentials the owner believed correct, and in the manual `/connect`
fallback **the email re-typed into the password field on every keystroke.** Three causes, none of
them the password.

- **THE LOOP.** `openLoginModalAndFill`'s selector list matched rec.gov's **hidden** newsletter
  `input[name="email"]`, which comes first in DOM order — so `.first()` resolved to it and
  `waitFor({state:'visible'})` timed out at 8,000 ms on every attempt, forever, with correct
  credentials. The same helper is `bot.mjs`'s auto-relogin, so a dropped session could never
  repair itself: marker goes → the app says *reconnect* → reconnecting runs the same broken
  function. **From the outside that reads as "my password is wrong."**
- **THE REPLAY.** `/connect`'s stream mode re-sent the whole buffer on any recomposition and never
  cleared it between remote fields — and an email typed straight into a password with no space is
  **one token to Gboard**, so every keystroke recomposed. `src/lib/remote-keys.ts` is an ordinary
  common-prefix diff now.
- **THE REVEAL.** There was no way to see what the phone keyboard had put in the password field,
  which is *why* the first cause was undiagnosable from the app. `type="button"` — a bare
  `<button>` inside a `<form>` defaults to submit and would have sent the credentials.

**BOTH HALVES ARE LIVE.** #363 (`fff3b98`) and #364 (`2e49994`) are merged; **the box applied
`2e49994` on 2026-09-18 at 15:19 UTC in 35 seconds** (`updated and verified`), confirmed with
`bot-ask git-status` and corroborated by `autocart.bot_version` reading *"mini-PC and web are both
on 2e49994"*. `git merge-base --is-ancestor fff3b98 2e49994` holds. No worker deploy fired — none
of the changed paths is in `worker-deploy.yml`'s `paths:`, read rather than inferred.

**TWO PROBES RUN HERE, WITH NO PHONE AND NO BOX**, and each **refuses its verdict unless the
control reproduces the pre-fix failure** — so a green run is worth something:

```bash
node scripts/recgov-login-probe.mjs        # serves rec.gov's shape, drives the REAL helper
npx tsx scripts/connect-keys-probe.mts     # drives Chromium's own IME over CDP
```

**HEADLESS CHROMIUM CANNOT REACH recreation.gov FROM HERE** — `ERR_CERT_AUTHORITY_INVALID` while
`curl` answers 200 in the same second (`~/.pki/nssdb` holds only the schema; `certutil` is absent).
**Disabling TLS verification is forbidden**, which is why both probes are fixtures.

**THE RC SIBLING IS RECORDED, NOT TOUCHED.** `rc-autologin.mjs`, `rc-probe.mjs` and
`src/lib/rc-login-script.ts` carry the same kind of selector list — but each tries selectors one at
a time and asks `isVisible()` on each `.first()`, so a hidden first match moves on instead of
timing out, and `signin.reservecalifornia.com` has no newsletter form ahead of its sign-in. It is
the release-critical path between a queued hold and a missed cart. **Widening a fix past its
evidence is how the 08-22 round was spent.**

> **AFTER AN UPDATE, CHECK THE PAYLOADS CAME BACK.** `bot-ask list-processes` should show ONE
> `node.exe rc-keepwarm.mjs` and ONE `node.exe rc-hold-runner.mjs` — it did, at 15:22 UTC.
> Repeated `starting: node rc-keepwarm.mjs` in `restarts.log` (**Pacific!**) inside ten minutes is
> the crash-loop, and the remedy is a human at the box.

**A MERGE IS A TEST RUN.** Do not merge and then verify locally — CI runs the same suite against
the same production database, and the `claim`/`hold-line` suites fail in ways indistinguishable
from a regression.

---

## 0b. Ground yourself — four commands, in this order

```bash
curl -sS "$HTTPS_PROXY/__agentproxy/status"                        # blocked hosts, if any
git fetch origin master && git log --oneline -3 origin/master      # what master really is
NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status        # what the BOX really runs
curl -s https://camphawk.app/api/health/status | python3 -m json.tool | head -40
```

Three things that will bite in the first ten minutes:

- **`NODE_USE_ENV_PROXY=1` or nothing reaches Supabase — including `npm test`.** Without it ~150
  real-DB tests fail at once with `Host not in allowlist`, which reads exactly like a revoked
  allowlist and is not. The discriminator is one `curl` to the same host. Prefix the WHOLE
  `verify`, not one stage.
- **`git fetch origin master` before calling anything wrong.** A stale local checkout was read as
  production drift on 09-04 and cost a 16-minute hold-button outage.
- **`bot-ask git-status` is the authority on the box's commit, never `autocart.bot_version`** —
  that column COALESCEs and can show a stale sha beside a live heartbeat.

---

## 0c. THE CURE HAS FIRED THREE TIMES — read the box with these queries, not with the memory series

**Three firings (09-17 09:50:17, 09-17 17:44:39, 09-18 15:19:36 UTC) are not a rate either, and
all three are the SAME lever** — the last two are box updates, which produce the cold RC home-page
load the burst population needs. `docs/CHROMIUM-LEAK.md` → "IT FIRED", "A SECOND TIME" and "A THIRD TIME" are
the account; this section is how to read the box for the next one.

```sql
SELECT at, detail->>'reason' FROM bot_events
 WHERE detail->>'reason' = 'wedge-recycle' ORDER BY at DESC;   -- 3 rows as of 09-18 15:25 UTC
```

**`silent` AND `strikes` ARE ON THOSE ROWS NOW.** `silent === strikes` (3 and 3, on both firings
that carry the field) is the direct answer to the predicted flapping failure: every silent probe
went into the run of three and no `alive` reading reset the counter. **A non-zero `silent` with no
firing would be the finding**, and the repair there is a decaying strike counter, never a lower
threshold.

**A ~30 s cure fits entirely between two two-minute memory samples, so the SERIES IS THE WRONG
INSTRUMENT** — and a wedge the cure wins produces **no** `bail:ramp`, **no** `ramp-scan` and
**no** `mem-dump phase=ramp`. **So `bot_events` is now the only census of wedges there is, and a
quiet one is not evidence that the box is quiet.** The event is in Postgres and cannot roll out of
a log window; **the log lines that say the cure WORKED can and do** — pull
`tail-log rc-keepwarm:400` within ~20 minutes of a firing.

**IF THE COUNT IS STILL 1, THE SECOND QUERY SAYS WHETHER THE TRIGGER IS EVEN LIVE:**

```sql
SELECT max(at) FROM bot_events WHERE kind = 'tab-close';   -- the last Okta trip
SELECT count(*) FROM bot_events WHERE detail->>'reason' LIKE 'bail:%'
   AND at > now() - interval '6 hours';                    -- 0 means no trip was KILLED
```

Every Okta trip leaves a `tab-close` (the close is in a `finally`); a trip killed by a bail leaves
none. **`tab-close` recent = the trigger is live and the cure is genuinely waiting; `tab-close`
hours old with zero bails = the trigger is OFF and the cure cannot fire at all** — which is what
the healthy self-sustaining regime looks like, because `planRenewal` stands down while the token
is alive and the ESTABLISHED trigger is the Okta navigation.

- **THE FALSE-POSITIVE HALF IS STILL THE MEASURED ONE.** ~2,400 probes across ~20 browser lives
  since 21:50:59 UTC on 09-16 — through renewals, stand-downs, keepalive checks and five forced
  restarts — **with no run of three**, and one genuine firing. Individual `wedged` readings were
  never counted; `silent` counts them, and it is **bot-side, so it is inert until the box
  updates.**
- The detector itself is validated: `detail->>'reason'` resolves on every stored `request-counts`
  row, and the keep-warm emits exactly `snapshot({ reason: 'wedge-recycle' })`.


### FORCING A RAMP IS **DENIED** TO AN UNATTENDED SESSION — no longer the blocker, still true

`restart-rc` is refused by the harness classifier as **"Interfere With Workloads"**. That is a
permission denial, not a technical failure, and it is not to be worked around. `test-login` is
not a substitute (below). **A session with no human present still cannot produce a ramp on
demand** — what changed on 09-17 is that one arrived by itself, so this bounds how fast a SECOND
reading can be obtained rather than whether any can.

- **A HUMAN CAN DO IT IN ONE COMMAND**, and this is the single highest-value thing to ask for:
  `npx tsx scripts/bot-ask.mts restart-rc`, which makes a COLD browser loading RC's home page —
  the young-population shape, **2-for-4** as a deliberate lever. **Pace at ~15 minutes**:
  `supervise.ps1` stops LOUDLY after 5 exits in 10 minutes and leaves the RC pair dead. Never
  inside the T−3h warm-up window of a real release.
- **Do not quote the 2-for-4 as today's rate.** The two hits were 09-09 and 09-10, while the
  young/burst population was live. **That population is BACK** — 09-17 09:50 carried 30,631
  answer-less asks on `futurebookingstartsendsdates` in a 44.6 s browser — after 46.5 hours away,
  which was its longest recorded absence. So a forced restart is likelier to land now than it was
  yesterday, and a natural one may arrive without asking.

### THE 14:30 AUTO-LOGIN RAN AND THE CAPTCHA PREDICTION WAS FALSIFIED

**The 09-17 block is settled. Four `auto-login` trips landed 14:34-14:37, `session_live_since`
moved to 14:37:05, and the 15:00 release had a live session.** So the handover's
*"`maybeAutoLogin` meets the same overlay, spends both attempts and rings the phone"* did not
happen. The site was lost to RC, not to the sign-in. **Keep the reasoning below; it is about every
future release.**

**THE T−30 AUTO-LOGIN IS A COIN FLIP, 1 OF 3.** Five real releases fall inside the 297-hour
`bot_events` window and exactly ONE pairs with an `auto-login` tab-close (**09-05 14:42 against a
15:00 release**, T−18). **09-09 and 09-15 produced none at all**, because `maybeAutoLogin` stands
down when the token already covers the hold — a renewal mints ~60 minutes and the requirement is
`LEAD + CART_HOLD_MIN + AUTOLOGIN_MARGIN_MIN` = 60. **So whether it fires turns on where the last
renewal happened to land, and a quiet arm at T−30 is the ORDINARY case rather than a fault.**
Check `bot_events` for an `auto-login` `tab-close` before concluding anything ran. (One caveat: a
trip killed by a bail emits no `tab-close`, and 09-15 has a `bail:ramp` sixteen minutes AFTER its
release — its browser age of 6.2 h fits a renewal, so a killed auto-login is unlikely there and is
not excluded.)

**AND THE ATTRIBUTION RULE APPLIES WHENEVER IT DOES FIRE** (`docs/CHROMIUM-LEAK.md` → "THE CURE WATCHES ONE
RENDERER OF TWO"). `maybeAutoLogin` runs in a **throwaway tab** and the cure probes
**`residentPage` only**, so a ramp in the trip's own renderer is invisible to it — and correctly
so, because `closeTabBounded` in the `finally` already reclaims that one. **"The cure did not
fire" is not a verdict on the cure until the ramp is attributed to a renderer.**

**ARM A CAPTURE AS A BACKGROUND BASH TASK, NEVER A `Monitor`.** `timeout_ms` caps at 30 minutes,
so a `Monitor` is guaranteed to lapse; the bash task is what caught the 12:00 CAPTCHA after a
session restart had already killed one.

**THE BOX IS NO LONGER HELD.** Zero live holds, so `restart-rc`, `kill-chrome` and a box update
all cost the RC session and nothing more. **A box update is owed** — §0a.

### TWO WAYS TO MISREAD CI, BOTH MEASURED TODAY

Both produced a wrong answer here, and both are one query away from producing another.

- **`?head_sha=` SILENTLY OMITS RUNS.** It returns **200 with `total_count: 0`** for shas whose
  runs exist — two of three checked hours later, while `?branch=` returned all of them in the
  same second. A watch pinned to it reported nothing for twenty minutes **while that run
  FAILED**. Not lag, not the short-sha trap. **Build on `?branch=<name>` and match the sha in
  the results.**
- **"THE PUSH RUN CARRIES THE VERDICT" IS FALSE.** One push starts a `push` run and a
  `pull_request` run on the same sha; the concurrency group keys on `head_ref || ref_name`,
  identical for both, so they cancel **each other** and the survivor is whichever started
  second — measured in **both directions** on consecutive shas of one branch. **The verdict is
  whichever twin is NOT cancelled**, and **both cancelled is its own reading**: a newer push
  superseded that sha, so it will never get one.

### THE DROUGHT IS THE SELF-SUSTAINING REGIME — waiting is waiting for it to end

**33 hours with no ramp** as of 12:51 UTC on 09-17 (last one 09-16 03:51) against a 2.3-18.6 h
gap range, and hourly peak commit flat at **7,000-7,200 MB** throughout. Four more clean Okta
trips landed on 09-17 (three renewals at 68.6-69.6 s and the 42 s CAPTCHA warm-up) and **not one
ramped** — each printed `this navigation did NOT ramp` with its own RAM delta. The explanation is
read off three instruments:

- **TRIPS FIRED CONSTANTLY, STOPPED FOR SIX HOURS, AND CAME BACK IN THE OLD BAND.** Eleven at
  68.3-69.6 s (09-16 17:39 to 22:43), eight at <=49 s (09-17 00:13 to 04:31), a **340-minute
  hole**, then 10:12, 10:43, 11:15, 11:38, 11:49 and 12:01 at **68.6-69.7 s**. **So the 21-second
  step-down REVERTED with nothing changing on the box** (`HEAD 6fc7292` throughout) — it was a
  ~4-hour episode, not a step, and the open question is "what OSCILLATES?" rather than "what
  changed?", which rules out any code, config or deploy cause. **Even the 69 s band did not
  ramp.**
- **THE SILENCE IS THE SPA RE-MINTING, IN THE KEEP-WARM'S OWN LOG.** `token exp in 2m` at
  05:29:26 then `token exp in 41m` at 05:49:26 with **`renewed=no`**. `planRenewal` stands down
  while a token is alive, so there is no Okta trip to be the trigger. **That regime has been
  measured to run TEN HOURS.**
- **AND THE OLD-BAND WAIT HAS ALREADY BEEN RUN AND LOST.** `request-counts` carries `ageMs` at
  every graceful teardown: **a browser lived 704.2 minutes on 09-16 and produced nothing** — the
  longest life on record, the top of the 52-611 min band. So "let a browser age" is not an
  experiment waiting to run.

### THE SCAN WENT BLIND AND CLEARED — read the three states apart

`chromium_memory_samples.rc_mb` was **NULL from 09-17 04:15:31 and cleared at 09:41:11**, the
sampler naming its own cause on every tick in the `bot` log: *"8 Chromium had an unreadable
command line — this process may not be elevated"*. **The window is SHUT**, so the ramp arm,
`ramp-scan`, the region walk and the baseline dump are all live again (the 11:39:47
`mem-dump (baseline) in 314ms` is that working). Everything below is how to read the next one.

- **`NULL` = we could not look. `0` = we looked and found none of ours. A number = we looked and
  here it is.** The recovery sample reads `rc_mb=0 procs=0` — a REAL reading, because the old
  browser was already gone — so dating the recovery off the first NON-ZERO row puts it three
  quarters of an hour late. That mistake was made here on 09-17 and corrected.
- `commit_used_mb` is `Win32_OperatingSystem` and answered perfectly throughout (**~7,065 MB of
  48,894** at baseline; a ramp charges ~32 GiB in <=34 s and takes it to 35-47 GB).

- **So a ramp check keyed on `rc_mb` cannot see one.** Use `rc_mb >= 1500 OR commit_used_mb >= 15000`.
- **WHILE BLIND IT DISABLES THE WHOLE RAMP ARM, INCLUDING ITS COMMIT BAR.** `readLatestMemory` refuses
  the entire reading on a missing rc figure and both arms gate on `known`. **The cure, `HUNG_MS`
  and the RAM arm are unaffected**, so the protection order is cure, `HUNG_MS`, (ramp arm, dead),
  RAM arm. That made the box briefly the cleanest test bed it will ever be, and **it lasted about
  five hours** — so do not plan around it. Recorded and deliberately NOT fixed: it is the arm that
  exits the process and it needs a box update. (The 09-17 hold that blocked that update has
  since resolved, so the update itself is no longer held — see the box-update block above.)
- **A RESTART IS A CANDIDATE CAUSE, NOT ESTABLISHED.** Blindness resumed five seconds after
  `restart-rc (#428)`; the first run began 13 minutes after the 04:02 restart and cleared on its
  own. **So do not run one to "clear" it** — it is as likely to cause it.

### WHAT IS PROVEN, AND THE ONE THING THAT IS NOT

`node scripts/cure-end-to-end.mjs` measures the three legs on **one page in one run**, through
the shipped exports, with the control arm that matters:

```
healthy  : evaluate answered, probe alive/alive/alive, strikes 0, 0 mappings
wedged   : evaluate SILENT >2000ms, getMetrics answered   <- production's own signature
the cure : 3 strikes -> recycle, 243 -> 0 mappings in 520ms
```

- It **refuses** four ways and the refusal was fired (`CURE_PROBE_MS=1` exits 1) — the healthy
  page must accrue NO strike, which is the defect its own first version had.
- **~2,400 production probes since 09-16 21:50:59, across ~20 browser lives, zero false
  positives.** That is the half that costs an RC page load if it is wrong, measured on
  Windows/149. It says nothing about the true-positive half.
- **Unproven: a single end-to-end firing in production.** Everything else — the mechanism, the
  detector on the production platform, the release path (430 healthy closes, 8-628 ms, none
  hung) — is measured.

### THE BOX UPDATE IS DONE — 24 SECONDS, AND WHAT IT BOUGHT

Requested 17:43:53 UTC, applied **17:44:17** on `637316e`, confirmed by `bot-ask git-status`.
Four things reach the box only on an update and all four are now live: the near-miss logging, the
six wedge event fields, the recycle-budget decay, and **the `cart-burst` event**.

- **THE COST WAS THE SESSION AND NOTHING ELSE.** `stop-all` ends it (~11 minutes to repair
  itself) and resets the browser to age 0. Zero holds were live, so nothing else was at stake.
- **IT WAS ALSO A FORCING LEVER AND IT HAS NOT PAID.** A cold browser on RC's home page is the
  BURST population's shape. Commit stayed flat at ~7,550 MB through 17:46 — **no ramp.** One
  restart is not a trial; the recorded rate for a deliberate `restart-rc` is 2-for-4.
- **THE T-30 AUTO-LOGIN IS THE CHEAP VARIANT AND NOT A LIKELY TRIGGER.** Okta's window reads the
  ROLLING `+12.0000h` signature, so T-30 is answered from the `idx` cookie in ~11 seconds. The
  expensive variant has ramped 3 times in 7; **the cheap one never has.**
- **If the cure fires while the per-process scan is blind it still reports honestly** —
  `memKnown: false`, `memWhy: "memory reading has no rc figure"`, `commitUsedMb: null`. The
  discriminator is carried independently by `chromium_memory_samples.commit_used_mb` at a
  two-minute cadence.

### HOW TO READ THE FIRST FIRING

**Ask this ONE query before anything else. It is the whole state of the proof:**

```sql
SELECT count(*) FROM bot_events WHERE detail->>'reason' = 'wedge-recycle';   -- 0 as of 09-17 06:00
```

A ~30 s cure can fit entirely between two two-minute memory samples, so **the SERIES IS THE WRONG
INSTRUMENT** — that event is in Postgres and cannot roll out of a log window. The detector is
validated (`detail->>'reason'` resolves on 5 of 5 stored `request-counts` rows), so a zero is
about the subject, not the query.

> **PULL `bot-ask tail-log rc-keepwarm:400` FIRST, BEFORE ANYTHING ELSE — AND NOTE THE `:400`.**
> The box emits `requestCounter.snapshot({ reason: 'wedge-recycle' })` and **nothing else** — the
> request counts and the reason. Everything that says what the firing DID is in the log.
>
> **THE WINDOW IS A LINE COUNT, NOT A CHARACTER COUNT, AND THE DEFAULT IS 80.** `tail-log`
> slices `DEFAULT_TAIL = 80` lines and only then applies `MAX_OUTPUT = 16_000`; the argument
> takes `<name>:<n>` up to 400. Measured the same minute: the default returned **38 minutes**,
> `:400` returned **89 minutes** (188 lines). **One colon is 2.4x the evidence and needs no box
> update.** Every "the log rolled at 16,000 characters" line in `CLAUDE.md` has the mechanism
> wrong; the correction is the entry headed *"AND THE WINDOW WAS NEVER 16,000 CHARACTERS"*.
>
> Even at `:400` the signal-to-noise is **5 informative lines in 188** — the rest is the two
> stand-down lines #358 dedupes — so widen the window AND land #358. The capture watcher that
> pulls it within ~90 s **dies with the session that armed it**, and it asks for `:400` now.
>
> **AND A `Monitor` CANNOT CARRY THAT WATCH** — `timeout_ms` caps at 1,800,000 ms, so it lapses
> every 30 minutes by construction and each re-arm leaves a gap. Use a background Bash task with
> a terminating condition; it has no cap and exits once when it has something to say.

In `logs\rc-keepwarm.log`: a recycling line naming the wedge, then `closed the wedged page in
Nms`, then the loop reopening — with **no** `✗ RAMP` and no `✗ WEDGED` beneath it.

**Expect the close to take ~2.5 s regardless of how much it releases.** Measured: 1,877 mappings
in 2,532 ms against 0 mappings in 2,516 ms — **16 ms apart**, so the release is O(1) in the count
and `page.close()` destroying the renderer process is why.

Once the box HAS updated, the event carries these (absent today = the box being old, never the
cure failing):

| field | reads | means |
|---|---|---|
| `closeMs` | 9-628 ms across 430 healthy production closes | a close in minutes, or `hung`, is the close inheriting the hang |
| `tokenKept` | `written` / `already-stored` / `no-token` / `already-stored-stale` / `timeout` | the live token lives in PAGE memory and dies with the close |
| `strikes` | 3 | fewer means `WEDGE_STRIKES` moved |
| `memKnown` / `memWhy` | `false` / `memory reading has no rc figure` while the scan is blind | honest, not a fault |
| `commitUsedMb` | ~7,040 baseline vs 35,000-47,000 for the leak | **the leak-versus-baseline discriminator** |

**THE RECYCLE-LOOP DEFECT IS FIXED AND THE BOX HAS IT** (squash-merged in #360, so `1720e8b`
is not an ancestor of master but its content is — `git show origin/master:scripts/auto-cart-bot/
page-wedge.mjs | grep decayedRecycles`). `WEDGE_MAX_RECYCLES` could never bind — `wedge` was reset
on every reopen and every recycle *produces* a reopen — so `escalate` was dead code and a page
that wedges within 30 s of each fresh load would recycle, reopen and wedge for ever, invisible to
`supervise.ps1` because the process never exits. The fix is `decayedRecycles` (30 m).
**A second `wedge-recycle` within MINUTES is still the shape to look at**; the two on record are
eight hours apart, which is not it.

### If a reading IS wanted at a known moment, in order of cost

1. **`rc-test-hold.mts --in 120`** — the only recipe with a recorded hit rate (**3 in 7**). It
   needs **`okta=GONE` AND a dead token**, opens the T−3h..T−30 warm-up window at once with
   ninety minutes of margin, and the hold is deleted the moment the trip is under way so nothing
   is carted. **It refuses while a real hold is live.**
2. **`restart-rc`** — cheapest by far (no campsite, no password, no Okta precondition), **and
   DENIED to an unattended session.** Ask a human.
   - **A BOX UPDATE IS THE SAME LEVER AND IS NOT DENIED.** `update.bat` runs `stop-all` then
     `start-all`, i.e. exactly the cold generation change `restart-rc` produces — and the
     **17:44:39 `wedge-recycle` fired 22 seconds after the 17:44:17 update**, on the browser it
     created. So an update that is happening anyway is a free shot at the burst population.
     **Do not schedule one FOR this** (it costs the RC session); **do read `bot_events` after
     every one.**
3. **`test-login` — do NOT spend it while Okta is ALIVE.** It forces `prompt=login` by
   interception so it does navigate, but Okta answers from the cookie (09-07: eleven seconds,
   +24 MB) — the cheap cell. Rationed one per 6 h, and it costs a password submission from an
   address that has eaten a twelve-hour block.

**`okta=GONE` cannot be brought forward.** The reported expiry is the ROLLING window our own
`/api/v1/sessions/me` probe refreshes. **The discriminator is one subtraction:**
`okta_expires_at - okta_checked_at`. 12.0000h is rolling and says nothing about the cap; a window
that SHRINKS is the frozen absolute cap, which is the precondition. **Do not "fix" the
unconditional probe to make forcing easier** — it is load-bearing by accident, and the cost is
real logins from a blocked address.

---

## 1. State — re-verified 2026-09-22, 04:20 UTC (2026-09-21 21:20 PT)

| | |
|---|---|
| master | `8c9b7d5`. Five PRs landed 09-21: **#386** (worker-deploy replaced-machine + `recentBotEvents` source filter), **#387** (a CI correction), **#388** (hand-off retry), **#389** (burst stop-on-success), **#390** (three findings). **Verify against `origin/master`; this line ages.** |
| open issues | **none** — #243 was closed by #386. |
| open PRs | **none.** |
| mini-PC | **`eeb9d05`**, applied 2026-09-22 03:07 UTC in **23 seconds** on demand. Confirmed by `bot-ask git-status` → `HEAD eeb9d05 on master`, never `autocart.bot_version`. It is one docs commit behind web (`8c9b7d5`) and **there is no bot-side code in that gap.** |
| health | **18 of 19 ok**, overall `degraded` — the one warn is `autocart.bot_version` on the docs-only gap above. |
| fleet | worker heartbeat **2s**, **14 watches**; `poller.shards` **3/3 held**; `poller.capacity` **8/12 across 3 machines, 4 slots free**. |
| holds | **`#R315` (Carpinteria SB — Santa Rosa) is TAPPED and queued for 2026-09-22 08:00 PT.** Two more sites sit `offered` and untapped, which is not a fault. |
| RC session | **LIVE.** The 09-21 box update ended it, and an on-demand rehearsal at 03:55 UTC re-established it: `okta=ALIVE (exp 2026-09-22T15:55:40)` — **past the 08:00 PT release** — with a fresh 60-minute token. `autocart.rc_login` PASSED unattended post-update. **The 6h on-demand ration is spent until ~02:55 PT.** |
| the burst | **OBSERVED, twice, and both defects fixed.** §0. |
| the hand-off | **retries 5x now**, live in production, verified serving from `/api/rc-precart`. §0. |
| the leak | **DIAGNOSED, CONTAINED, DURATION CURED — still NOT eliminated.** §2. Unchanged 09-21. |
| migrations | highest **`078`**. **Main's block is `077-079`, so `079` is the ONLY number left** — the next main-lane migration after that needs a new block claimed out loud in `docs/LANES.md` first. Side lane `080+`. |

**THE ONE THING TO CHECK FIRST TOMORROW:** how `#R315` went at 08:00 PT.
`NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts`, and read §0 before reading a
`could not hold` line as a loss.

## 2. The leak — DIAGNOSED, CONTAINED, AND THE DURATION CURED. **IT IS NOT ELIMINATED.** Read before touching anything memory-related.

**`docs/CHROMIUM-LEAK.md` → "THE 32 GiB CEILING IS `base::SharedMemorySecurityPolicy`" and the block directly
beneath it, "THE RESIDUAL IS COMMIT, AND NOTHING WATCHES IT", are the full account.** Everything
here is a pointer to them.

### 2.0 Where it actually stands

**It still happens every few hours. The containment catches every one. What is left is a COMMIT
risk, and nothing anywhere is gated on commit.** Off the box's own series, the 48 hours to
2026-09-11 (1,628 samples):

| | |
|---|---|
| onsets (rc family crossing 1500 MB) | **6** — most recent 10.4h before the reading |
| peak `rc_mb` | **4,661 MB** — it was 8,000-9,400 MB before the bail arm existed |
| peak COMMIT used | **46,807 MB** of a 47,870 MB limit |
| tightest COMMIT headroom | **665 MB** — 09-10 04:26, used 40,175 / 40,840 |
| minimum free RAM | **5,140 MB** — the RAM arm's floor is 2,000, so it *cannot* fire |
| `bail:ramp` fired on | **6 of 6**, ~2 minutes after each onset |

**The private-byte climb is genuinely cut short every time, and that is the containment working —
it is why the peak roughly halved.** The **~32 GiB MAPPING is untouched by any of it**: the burst
completes in **≤34 seconds**, faster than any arm can react to, and Chromium's own ceiling is what
stops it going further. **Do not read "contained" as "cured".**

**Since 2026-09-16 the DURATION is cured and the burst is not — §2.6.** A wedged page used to hold
its 32 GiB until the 120 s ramp arm or the 12-minute `HUNG_MS` arm killed the whole browser; the
page-wedge arm closes the page and releases them in seconds. That is a different claim from the
paragraph above, which stands unchanged.

### 2.1 PROVED — none of it needing a ramp, a box update or a new instrument

- **The ceiling is `base::SharedMemorySecurityPolicy::kTotalMappedSizeLimit`** —
  `32ULL * 1024 * 1024 * 1024`, a per-process atomic budget on total *mapped* shared memory,
  added to stop address-space spraying. `32 GiB / 2 MiB = 16,384` and the check is `>=`, so the
  **maximum pure-2 MiB count is 16,383**, against a measured **16,381-16,383** on six walks — the
  1-3 residual being the renderer's other budget-counted shared mappings (0-6 MiB, the right
  magnitude and the right direction). One grep over the whole checkout, one hit.
- **So the sections are `base::SharedMemoryMapping`s.** Only two callers charge that budget, so
  **stopping at exactly that number is the fingerprint of the code path** — much stronger evidence
  than the 2 MiB size, which this repo already retired as a search key.
- **No peer process holds them.** The walk's own `CHROME` lines, never read until now: 14,721
  handles in the target renderer against **1,224 in the browser** and 180-832 in every other
  process, with 4.015 KB of paged pool per section. **ipcz `NodeLinkMemory`, discardable memory
  and the GPU transfer path are all eliminated by that alone**, because each needs a peer to map.
- **The "middle population" wants no second constraint.** A cap is a ceiling, not a target: an
  event whose driver ran out of work stops below it. (Labelled a candidate; it needs nothing.)

**REPRODUCED, with both single-variable controls flat** — `node scripts/leak-repro.mjs`:

| candidate | 2 MiB shared mappings in the renderer |
|---|---|
| idle, and the pure microtask wedge | **0** |
| fetch with no response (connection refused) | **0** |
| fetch and drain the body | **0-1** |
| **`wedge-and-fetch`** — a microtask loop issuing fetches, never yielding to the task queue | **12 → 800 in 30 s, linear** |

and pushed harder, live: renderer **3,208** (6.3 GiB), network service **6**, browser **0** —
**the production peer asymmetry, exactly.** It reads `/proc/<pid>/maps` from OUTSIDE the process,
which is the property every CDP instrument lacks and the reason three of them got silence.
**Caveat kept deliberately: that is Chromium 141 on Linux (memfd) against the box's 149 on Windows
(pagefile-backed).** It establishes the MECHANISM, not the production event.

**THE CHAIN, read in source:** `URLLoader::ContinueOnResponseStarted` makes a 2 MiB pipe per
RESPONSE — **not per request**, which is why 69,060 answer-less asks cost nothing and why the
burst/leak decoupling is real; `DataPipe::Deserialize` maps the consumer **on the IO thread** the
moment it arrives; the drain is a **posted task**; `deferred_messages_` is unbounded. **A wedged
main thread cannot stop the mapping, only the release.**

### 2.2 THE COMMIT RESIDUAL — A BUILT, B ANSWERED AND OFF, **C BUILT** (§2.6), D standing

**Every arm this repo has built watches free RAM or the rc family's private bytes. The burst
spends neither.** So the one resource that actually runs low during a ramp is the one nothing is
gated on — and commit exhaustion is the **only** failure this box has had that needed a human
(2026-08-12, `supervise.ps1` could not start a shell and the machine was power-cycled by hand;
08-17, both Scheduled Tasks stopped together).

**The box, read 2026-09-11 16:15 UTC with `bot-ask memory`:**

```
RAM       15.7 GB total, 10.4 GB free
COMMIT     7.0 GB used of 46.7 GB limit   (idle)
PAGEFILE  C:\pagefile.sys — 31.0 GB allocated, peak 0.0 GB, SYSTEM MANAGED
```

**`peak 0.0 GB` is the confirmation the 32 GiB is never touched** — 31 GB charged and essentially
nothing ever written to disk. It also means a larger pagefile would cost disk, not I/O.

**FOUR OPTIONS. A is BUILT (#336) and B is ANSWERED AND OFF as of 2026-09-11; C and D stand.**
Full reasoning is in `CLAUDE.md` → "THE RESIDUAL IS COMMIT, AND NOTHING WATCHES IT" and
"THE COMMIT RESIDUAL: THE PAGEFILE TRACKS, AND OPTION B IS OFF". In brief:

- **A — a COMMIT trigger on the bail arm. BUILT 2026-09-11.** `writeLatestMemory` dropped
  `commitUsedMb`/`commitLimitMb`; they now go through the file and `rampBailDecision` carries a
  second bar on condition B, `RAMP_SCAN_COMMIT_MB` **imported** so the two arms cannot disagree
  about which event they see. Backtested over 19 onsets: **earlier on 11 by a median 77 s, never
  later, median 1,984 MB off the peak commit**. **It cannot touch the burst** — at the sample
  where it first fires the commit is already 35,794-48,444 MB. Bot-side; it rides the quiet
  window, so **no forced update and no RC session spent**.
- **B — the pagefile. ANSWERED AND OFF.** The precondition is **TRACKING**: the limit grows on
  essentially every sample and never stalls while used climbs — fastest **+30,902 MB in 33 s**,
  finishing 1,456 MB ahead, against a burst of <=34 s. And **Windows has already done B by
  itself**: the limit has been a constant **47,870 MB since 2026-09-10 12:40 UTC across 913
  samples**, so a burst needs no growth at all and idle headroom is 40,902 MB. **Do not spend a
  reboot.** The settle is not durable — a reboot resets it — which is a reason not to reboot
  rather than a reason to.
- **C — stop the wedge. BUILT 2026-09-16, and it is the PAGE that is recycled, not the browser.**
  That distinction is what defuses the recorded counter-argument: a browser replacement is 8x
  enriched before a ramp, and this replaces no browser — it closes one page and lets the loop's
  existing reopen path rebuild it. Parking the resident page stays refused for its own separate
  reason (it would silence `autocart.rc_session` and the phone alarm). See §2.6.
- **D — do nothing, deliberately.** A real option: 6 for 6 on the bail, free RAM never under
  5.1 GB, the mapping hard-capped, and **no human needed since 2026-08-17.**

### 2.3 A SECOND OPEN ITEM, and it just got a THIRD blindness measured into it

One pipe per response needs ~14,433 responses in that renderer inside the burst, and the resident
page's counter read **20 lifetime requests**. `requestCounter.attach(page)` is on the RESIDENT
page alone and `withNetworkTrace` is equally page-scoped, so **dedicated workers, service workers
and the throwaway tabs are invisible to both**. **Do not read "20 requests" as "20 responses in
that renderer."** The one-line fix is `context.on('request')`, which closes the service-worker and
throwaway-tab halves at once; **dedicated workers are NOT settled**, so do not widen the claim.
Bot-side.

**AND THE COUNTER IS BLIND TO A WEDGED PAGE ENTIRELY — measured 2026-09-16.** With a page wedged
and demonstrably making hundreds of fetches (the mappings climbing 2 MiB at a time is the proof),
**`page.on('request')` AND `ctx.on('request')` both reported ZERO.** Same cause as every CDP
instrument before it: the events route through the page's own target, serviced on the thread that
is wedged. **So `context.on('request')` does NOT close this third half**, and a "quiet" ramp may
be one whose traffic we could not see — which is a **candidate** weakening of the burst/leak
decoupling, measured in-container on a synthetic wedge and **never confirmed against a production
ramp**. Do not rewrite the decoupling entries on it. The `wedge-recycle` `request-counts` event is
what would settle it.

### 2.4 STOP DOING THESE

- **Hunting a 2 MiB constant.** The size grep over the whole checkout is clean; ipcz is the worked
  example of a 2 MiB allocation that is COMPUTED, and a size grep is blind to those.
- **Citing "the sections are NOT base shared memory".** That came from the 09-07 VOID dump of a
  healthy *replacement* browser; all four ramp dumps are `target-silent`, so `shared_memory` has
  never been read for a ramping renderer, and the cap proves it is base shared memory.
- **Spending a ramp on the memory dump.** A wedged renderer contributes ZERO allocator dumps at
  every level — settled off-box by `dump-wedge-probe.mjs`.
- **Forcing a ramp *through the warm-up*.** That route is **3-in-7**, spends the warm-up's one
  turn per Okta lifetime, and costs a password submission from an address that has eaten a
  twelve-hour block. **`restart-rc` is a different lever with different costs and is NOT covered
  by this line** — it is **2-for-4** (the two hits were 09-09 and 09-10, when the young/burst
  population was live; **it is back as of 09-17**), needs no Okta precondition and locks no
  campsite, and §0c is the one thing outstanding that needs a ramp.
- **Lowering `LOW_RAM_MB`, lowering `MEM_DUMP_STALL_MS`, parking the resident page, building
  Track B.** Each is refused for a recorded reason in `CLAUDE.md`.
- **Enlarging the pagefile. The precondition was settled on 2026-09-11 and the answer is
  TRACKING, so this is a flat no again** — for a measured reason rather than the retired one.
  The limit grows on essentially every sample and never stalls while used climbs (+30,902 MB in
  33 s, finishing 1,456 MB ahead, against a ≤34 s burst), and **Windows has already done it by
  itself**: a constant 47,870 MB since 09-10 12:40 UTC across 913 samples. **Do not run
  `fix-pagefile.ps1 -Apply`** — it costs a REBOOT and with it the RC session.

**AND THERE IS NO FIX ON OUR SIDE OF THE ALLOCATION — say it plainly.** The pipe size is
compile-time (512 KiB only on ChromeOS and 32-bit; no Finch flag), the drain is Chromium's, and
the wedge is RC's own promise loop. What changed is that the damage is now known to be hard-capped
by Chromium at 32 GiB of commit, in memory that is never touched — which is exactly why the RAM
arm has sat out fifteen-plus ramps: **it watches the one resource that is not running out.** That
makes an open-ended risk a **bounded** one. **It does not make it a closed one** — §2.2 is the
work that is left.

### 2.5 THE NAMED NEXT PIECE OF WORK — **NOT STARTED, and it wants the owner's word**

**A is aftermath and cannot be anything else.** At the sample where the commit trigger first
fires the commit is already 35,794-48,444 MB — the ~32 GiB is charged in ≤34 s and nothing that
reads a two-minute file can catch it. **What actually decides the exposure is how often we
navigate to Okta**, and that is measured:

```
renewal trips     229 over 164.6h = 33.4/day
gap bands         backoff(30m) 123 · minGap(10m) 69 · alive(~60m) 7 · other 29
failure bands     192 of 228 = 84%
onsets            18 over the same window = 2.62/day
RAMP RATE         18 onsets / 229 trips = 1 in 12.7
```

**229 attempts bought 7 successes**, so a repair costs ~33 attempts, and 12.7 attempts cost one
32 GiB burst — **each successful repair costs about 2.6 ramps.**

**`RENEW_BACKOFF_GAP_MS` is flat at 30 minutes and never escalates**, against a condition the
module's own comment calls persistent (*"when that cookie is gone every attempt will fail
identically until a human signs in"*). Escalating 30 → 60 → 120 → 240 takes failure attempts from
~28/day to **~10/day**, total trips 33.4 → ~15/day, and ramps **2.62 → ~1.2/day**. The release
path is untouched: `maybeAutoLogin` at T−30, the T−3h warm-up, the nightly rehearsal.

- **THE DESIGN WRINKLE THAT MUST BE HANDLED, not discovered later:** a `maybeAutoLogin` success
  does **not** call `recordRenewal`, so `failures` stays high — a fresh lapse would then start at
  the escalated gap instead of at `minGap`. The counter needs resetting when a live token is
  observed, or the escalation quietly delays the first attempt of a new episode.
- **WHY IT IS NOT DONE:** `planRenewal` is bot-side, it is what repairs a session between
  releases, and the SPA's silent re-mint is an OBSERVATION of RC's behaviour rather than a
  guarantee. `CLAUDE.md` says in as many words not to drive-by a change to it. **It wants the
  owner's word.**
- **AND EVEN THIS IS A REDUCTION IN FREQUENCY, NOT A CURE.** Every remaining ramp still charges
  the full 32 GiB. The pipe size is compile-time with no Finch flag, the drain is Chromium's, and
  the wedge is RC's own promise loop. ~~**frequency is the only variable we own.**~~ **CORRECTED
  2026-09-16: DURATION is a second one, and §2.6 now owns it.** Struck rather than deleted — "the
  only variable we own" is exactly the sentence that argues against building anything else. The
  two are complementary: this section reduces how OFTEN a burst happens, §2.6 reduces how long its
  mappings are HELD, and neither touches the ≤34 s burst itself.

### 2.6 THE CURE (2026-09-16) — it cures the DURATION, not the burst

`scripts/auto-cart-bot/page-wedge.mjs` plus one arm in the keep-warm's existing watchdog timer.
**`docs/ARCHIVE-OPEN-BLOCKS.md` → "THE CURE: RECYCLE THE WEDGED PAGE, NOT THE BROWSER" is the full account.**

Probe the resident page with a **bounded** `page.evaluate('1')`; after **3 consecutive**
no-answers at a **10 s** cadence, close the page. A renderer holds its mappings for as long as
its page exists, and a close needs nothing from the thread that is wedged.

| measurement | reading |
|---|---|
| `page.close({runBeforeUnload:false})` on a wedged page | **1,052 mappings (2.06 GiB) released in 86 ms** |
| `page.reload({timeout:8000})` on the same page | **HUNG past its own timeout**, killed at 70 s |
| end to end, on the real reproduction, via the SHIPPED exports | `peak 233 CLIMBING` → `probe=wedged strikes=3 act=recycle` → **`233 -> 0 in 2525ms`** |

- **IT IS FIRST IN THE TIMER because it is the cheap arm.** A page close costs one RC page load;
  `HUNG_MS` and the ramp arm cost the RC session (~11 min). And what it destroys is already dead —
  a wedged page answers no CDP, so `checkAndReport` cannot read it and `readLiveToken` cannot
  reach `window.__camphawkRcToken`. The token is persisted first, bounded at 2 s.
- **THREE STRIKES, NOT ONE, and the renewal is the case it must survive** — it stalls the LOOP for
  46-71 s (133 tab closes) while the resident renderer answers CDP throughout, so a healthy
  renewal produces `alive` readings and never reaches a strike. A REJECTION ("Target closed") is
  `inconclusive`, never a strike: that is a page CHANGING, and counting it would recycle a healthy
  page during an ordinary reopen.
- **`runBeforeUnload: false` AND `close` RATHER THAN `reload` ARE BOTH LOAD-BEARING** — each asks
  the wedged thread to do something, which is how a fix inherits the hang it exists to end.
- **IT DOES NOT ELIMINATE THE LEAK, and §2.0 stands unchanged.** The burst maps 16,384 sections in
  ≤34 s; a detector that must first observe silence acts at ~30 s. What changes is how long a
  wedged page HOLDS them.
- **UNPROVEN IN PRODUCTION.** Container-local Chromium (141/Linux) against a synthetic wedge,
  against a box running 149/Windows — the platform pair that burned the native sampler twice.
  It is **bot-side**, so it is inert until the box takes it. **Confirm with `bot-ask
  git-status`, never `autocart.bot_version`.**

#### How to force the first firing, and what each outcome means

**The lever is `restart-rc`, not a test hold.** A forced restart makes a COLD browser loading
RC's home page, which is the shape the 02:0x cluster turned out to be, and it is **2-for-4**
against a 10% pooled base rate — no campsite, no password submission, no Okta precondition.
**Pace it at ~15 minutes**: `supervise.ps1` stops LOUDLY after 5 exits in 10 minutes and leaves
the RC pair dead. n=4, so it is a working lever and not a rate — and the two misses were on
09-17, when the burst population had been absent for 46 hours.

**The predictions are written down BEFORE the run, per the house rule, so they can be falsified:**

| | expected |
|---|---|
| `logs\rc-keepwarm.log` | `♻ no answer in 3 consecutive probes…`, then `token on the way out: …`, then **`closed the wedged page in Nms`** — the container measured 86 ms |
| the arms below it | **NO `✗ RAMP` and NO `✗ WEDGED`.** The arm acts at ~30 s (3 strikes × 10 s); the ramp arm needs 120 s and `HUNG_MS` twelve minutes |
| `bot_events` | a `request-counts` row with `reason: 'wedge-recycle'`, rendered **with the bails** rather than below the teardown baseline |
| `chromium_memory_samples` | **the ~32 GiB commit step still happens** — the burst completes in ≤34 s, faster than any detector — but it should return to baseline within about one sampler tick instead of staying up for ~2 minutes, and the `rc_mb` peak should sit **below the 3,000 MB the bail arm has been capping at**, plausibly below 1,500 |

**A 2-minute sampler can miss a ramp that is cleaned up in 30 seconds entirely**, leaving one
elevated sample or none. So the series is the *corroborating* instrument here and the log and
`bot_events` are the primary ones — do not read a quiet series as the arm not firing.

**THREE WAYS IT CAN STAY SILENT, and they need different responses:**

1. **`✗ RAMP` with no `♻` above it — the probe kept ANSWERING.** That is a real finding rather
   than a broken arm: it would mean the mapping happens while the resident page is still
   responsive to CDP, which contradicts the 09-09 VMTHREAD reading (main thread `Running`, 4
   for 4) and the `alloc trail [resident]: EMPTY` line. **Expected not to happen**, because a
   wedged main thread is per-renderer and same-site pages share it — but it is the interesting
   outcome if it does.
2. **A FLAPPING page never reaches three strikes.** One `alive` reading resets the counter to
   zero by design (`wedgeDecision`: *"a page that answered is the end of the episode"*), so a
   renderer that answers once between two silences can ramp indefinitely without a recycle.
   **The container wedge was total** — `evaluate` answered before and was silent after — so
   flapping was never exercised. If this is what happens, the fix is a decaying counter rather
   than a reset, and it is a deliberate change, not a tweak: resetting is what stops an ordinary
   reopen being read as a wedge.
3. **The arm is SILENT on the healthy path, so "ran and found the page alive" and "never ran"
   write the same nothing.** That is the house shape and it is accepted here, because the
   discriminator costs nothing: the arm runs unconditionally every tick while not bailing, so
   **`bot-ask git-status` showing the new sha is what rules out "never ran"**. What it cannot
   tell apart is `alive` from `inconclusive`. Worth one log line if a second firing is ever
   ambiguous; not worth building before the first one.

## 3. Other things open — all detail is in `CLAUDE.md`

- **THE CANCELLATION BADGE STILL CANNOT SEE THE ONE CANCELLING SUBSCRIBER — NAMED, MEASURED, AND
  NOT STARTED ON THE OWNER'S INSTRUCTION (2026-09-16).** Migration 078 is merged and deployed, the
  owner has run the reconcile, it changed **exactly one row**, and **the data in the database is
  correct**. Every admin surface still shows nothing, because all four gates read
  `cancel_at_period_end` and Stripe reports this one as a **dated** cancellation:
  `cancel_at = 2026-10-08`, flag **false**. Stripe has two independent ways to end a subscription
  and a non-null `cancel_at` does not imply the flag.
  - **IT IS NOT A RECONCILE BUG AND NOT A DATA BUG** — both fields are read off one Stripe object
    in one statement, checked in source. **Do not go looking there.**
  - The repair is `COALESCE(cancel_at_period_end, false) OR cancel_at IS NOT NULL`, and the three
    caveats that make it more than a one-liner (four copies of the predicate, the live-row filter,
    the missing mirror fixture) are in docs/ARCHIVE-PRODUCT-AND-PLATFORM.md → **"THE CANCELLATION BADGE MISSES THE ONLY
    CANCELLING SUBSCRIBER"**.
  - **The Oct 8 deadline is real but not urgent** — three weeks of margin, and the row is right,
    so nothing is lost by taking it deliberately.

- **THE ANDROID "SEP 30" DEADLINE EMAIL IS ANSWERED — REGISTERED, 3 KEYS, ALL VERIFIED. DO NOT
  RE-OPEN IT (2026-09-16).** Google sent a final reminder threatening *"removed from Google Play
  globally"*; the Play Console reads **✓ Registered, `app.camphawk.mobile`, Keys 3, all Verified,
  updated Aug 1** — a month before the reminder. It was auto-registered because the app publishes
  an **AAB** and therefore necessarily uses Play App Signing. **Nothing is owed.**
  - **The email and the docs describe TWO mechanisms sharing one date, and quoting either alone
    misleads.** *Registration* is global and its consequence is removal; *install-time
    enforcement* is BR/ID/SG/TH-only until 2027. **Quote the row, not the date** — docs/ARCHIVE-PRODUCT-AND-PLATFORM.md →
    "ANDROID DEVELOPER VERIFICATION".
  - Open only if the sideload APK ever becomes a real channel: three registered keys is more than
    the app signing key alone, so the `camphawk_upload` key is very likely among them — **Play
    Console → Setup → App integrity** lists both certificates in full and would settle it in one
    look. Not now.

- **One screenshot outstanding, and only the owner can take it.** The Android 16 safe-area fix is
  deployed and web-side, but `env()` is 0 in headless Chromium and this container cannot reach the
  live site, so **nothing has seen it on a phone.** Open `/claim` or `/privacy` on the Pixel; the
  CampHawk mark should clear the clock. Ten seconds.
- **THE RENEWAL HAS FAILED 96% OF THE TIME FOR SIX DAYS, AND `planRenewal` IS DELIBERATELY
  UNTOUCHED.** Of 191 renewal-to-renewal `tab-close` gaps, **163 sit in a failure cadence and 7 in
  the alive band** — chronic, not an episode, so the 08-22 entry's *"20 attempts in a row have
  failed"* is the steady state rather than a moment. (**Filter to `label = 'renewal'`**, and note
  that 89% is a different quantity — the share landing on a named branch at all, which the first
  draft of the entry nearly published as the failure rate.) **It costs the session nothing** (RC's
  SPA re-mints silently) **and it is not free**: ~33 Okta navigations a day, at least ~28
  accomplishing nothing, from the address that has eaten a twelve-hour block — and an Okta navigation is the leak's own established trigger. **Do not
  drive-by a change to it**: it is bot-side, it is what repairs a session between releases, and
  the SPA's re-mint is an observation of RC's behaviour rather than a guarantee. It wants the
  owner's word. **The overnight reading it was waiting on is now IN** and supports the
  stand-down case rather than weakening it.
- **THE OVERNIGHT READING IS TAKEN — see the state table. Ten hours of total silence, then the
  renewal resumed and failed for six straight hours.** It answers the 08-18 question and it is
  the payoff of the gap instrument: one query, no box, no log. **What it does NOT answer is
  whether RC would have accepted the token** — `planRenewal` reads the token's own `exp`, and
  `session_ok` is RC's answer. Do not merge those two.
- **THE APP/STORE SURFACE IS THE SIDE LANE'S AS OF 2026-09-10** (owner's call, recorded in
  `docs/LANES.md`): `docs/APP-STORE.md`, `docs/PLAY-STORE.md`, `docs/STOREKIT-PLAN.md`, both store
  consoles and RevenueCat's. **A main-lane session should not pick these up** — read
  `STOREKIT-PLAN.md`'s "PICKING THIS UP?" block if you need the state, and hand the work over.
  - **`src/lib/**` stays MAIN regardless of topic**, including `native/purchases.ts`,
    `store-plans.ts` and the RevenueCat webhook — a change under `src/lib/auth.ts` or `limits.ts`
    is in `worker-deploy.yml`'s `paths:` and restarts all three pollers.
  - **Still MAIN's, and still open:** HMAC is reported-not-enforced, and out-of-order webhook
    delivery is unhandled (needs a migration, so main's block).
- **THE BILLING CHAIN IS PROVEN END TO END AS OF 2026-09-14 — purchase → RevenueCat → webhook →
  row → `hasAutocartEntitlement` → "Start watching", confirmed in the app by the owner.** It had
  never once run: the webhook 401'd **23 for 23** for a fortnight, then the sandbox guard dropped
  everything that got in, then the write it finally reached raised `42P10` on every row because
  `ON CONFLICT` omitted a partial index's predicate. Three bugs, each hiding the next.
  **ALL THREE ARE NOW PROVEN BY ONE ROW** — an Apple TestFlight purchase on 2026-09-15 03:23 UTC
  wrote the first `provider=apple` row this product has ever had, and a plan change four minutes
  later updated the SAME row (Apple keeps `original_transaction_id` stable inside a subscription
  group). docs/ARCHIVE-PRODUCT-AND-PLATFORM.md → "THE APPLE PURCHASE CHAIN IS PROVEN". **What is still unexercised is a REAL
  `PRODUCTION` purchase**, carrying the two known gaps below.
- **iOS `1.0 (27)` IS BACK IN THE QUEUE — RESUBMITTED 2026-09-15, SIX ITEMS, NOTHING OUTSTANDING.**
  Apple rejected it that morning on **3.1.2**, no Terms of Use (EULA) link in the App Store
  metadata — an AUTOMATED pre-check, so **nothing about the app was adjudicated** for the third
  submission running. The description genuinely carried no ToU, EULA or Privacy link at all
  (checked, not conceded), and the requirement did not exist before the four IAP products joined a
  submission, so nothing regressed. Fixed with two lines in one field; `src/lib/store-listing.test.mts`
  guards it. Submission `e77ec119-c61f-4e2c-87d0-da4f98859958`, all six **Waiting for Review**,
  same binary. **There is no console work pending — do not go looking for any.**
  - **ONE UNREAD SIGNAL QUALIFIES THAT SENTENCE, AND ONLY THE OWNER CAN SETTLE IT.** An Apple email
    dated **Sep 15**, *"There's an issue with your CampHawk: Campsite Alerts (iOS) submission"*,
    sits against a build submitted **Sep 14 21:35 PT**. On the dates it is most likely the 3.1.2
    rejection already described above arriving by mail — but it could equally be newer, and
    **nobody in a session can open App Store Connect to tell the two apart.** One look at the
    submission's state answers it. Recorded rather than resolved; do not guess a verdict into the
    docs. (The store consoles are the SIDE lane's surface.)
  - **THE STEP THAT IS NOT OBVIOUS, AND WHICH §2e PREDICTED WRONG: saving the Description does NOT
    enable `Resubmit to App Review`.** The version has to be pushed back into the submission with
    **`Update Review`** (top right of the version page; Apple's help calls that slot *Add for
    Review* — **match on POSITION, not the label**). Resubmit went live the instant it was pressed.
    docs/ARCHIVE-PRODUCT-AND-PLATFORM.md → "SAVING THE METADATA DOES NOT RESOLVE THE ITEM".
  - **`Update Review` IS A ONE-SHOT** (*"you can edit items in a submission only once before
    resubmission"*) and **Remove is irreversible** (*"removed items cannot be added back to the same
    submission"*). Both are Apple's own words; the second would make the 09-14 draft trap permanent.
  - **The Description counter reads REMAINING**: 3,714 pasted shows as **286**, which looks exactly
    like a truncated paste and is not one.
  - **`www.apple.com` IS PROXY-BLOCKED** — the EULA URL cannot be verified from a session; take it
    from the letter's own hyperlink. (`developer.apple.com` IS reachable and settled the resubmit
    question in two calls — **but serves its "Page Not Found" with HTTP 200**, so grep the body.)
  - **The plausible NEXT rejection is the in-app disclosure**, deliberately not touched: 3.1.2 also
    wants title, length, price and Privacy/Terms links in the BINARY, and `StorePaywall` plus the
    `(app)` footer put all five on screen **by layout rather than by design**, guarded by nothing.
    It is `1.0 (27)`'s web layer, so a push fixes it with no rebuild.
  - **WHAT IS STILL UNVERIFIED AND MATTERS IF IT PASSES:** build 27 has **zero installs**, so
    nobody has walked the paywall on the binary the reviewer gets. Worth doing while it queues.
  Standing facts, unchanged — and read docs/ARCHIVE-PRODUCT-AND-PLATFORM.md → "THE SUBMISSION STATE, WRITTEN DOWN BECAUSE IT
  LIVED ONLY IN A CHAT" before touching anything: **SBP approved at 15%** (no price change needed
  — the four products were already on the 15% column), **§4e is 7-of-7** while that file still
  says `GATED ON SBP`, and **Sign-In Information points at the clean account**.
  - **`NODE_USE_ENV_PROXY=1 npx tsx scripts/app-review-precheck.mts iamtylerflores12345@yahoo.com`
    reads CLEAN.** Run it before any submission; the default argument is the OLD account and reads
    NOT CLEAN by design, because it is a live grandfathered Stripe subscriber that must not be
    deleted to pass a check.
  - **EVERY STEP OF THAT LIST IS DONE.** The chain was proven by a real TestFlight purchase, the
    row it wrote was deleted, the replacement review notes were pasted, the Resolution Center reply
    was posted (Messages 11, 2026-09-15 04:11 UTC), and the six-item submission went in 24 minutes
    later. **After APPROVAL, not submission:** clear `REVENUECAT_SANDBOX_USER_IDS` and delete the
    row the reviewer's own purchase writes.
  - **THE SUBMISSION WENT IN ONCE WITH ONE ITEM AND HAD TO BE CANCELLED AND REDONE.** The four
    subscriptions were in a separate draft that ASC refuses to submit without an app version, and
    resubmitting the version from the rejection page did not pick them up. **`Items Submitted (1)`
    is the tell.** Full account, including why `Cancel Submission` is safe and where the control
    hides, in CLAUDE.md under the heading above.
  - **THE REVIEW NOTES IN `docs/APP-STORE.md` §2d ARE THE 08-22 BLOCK AND MUST NOT BE PASTED.**
    They never mention In-App Purchase, lead with the external purchase link, and describe the
    demo account as subscribed — all three are now false and the last rejection was 3.1.1 IAP.
    The replacement leads with numbered steps to the StoreKit sheet; it was handed to the owner
    on 2026-09-15 and is not in the repo (it carries no secrets, but §2d is the side lane's file).
  - **A SUCCESSFUL TEST PURCHASE RE-CREATES THE 08-22 REJECTION.** It makes the demo account a
    subscriber, and a subscriber sees no paywall. Let the store subscription lapse (TestFlight
    renews at most six times, so ~30 minutes), THEN delete the row — deleting earlier is futile
    because the next renewal writes it back.
  - **Signing out does NOT reveal the paywall any more.** `/pricing` needs signed in AND not
    subscribed. `docs/APP-STORE.md` §2d's sign-out steps and §5's "the demo account has an active
    subscription" are both now reasons to be rejected — side lane's file, named not edited.
  - **Do NOT clear `REVENUECAT_SANDBOX_USER_IDS` before APPROVAL.** App Review buys in SANDBOX, so
    a cleared allowlist means the reviewer's purchase unlocks nothing.
  - **The attached BUILD must be dated 2026-08-29 or later** (`8818544`). **Match on upload DATE,
    never on build number** — ASC's number is `PROJECT_BUILD_NUMBER`, project-wide across both
    workflows, so "TestFlight #12" (a Codemagic run number) is not ASC build 12.
  - **`api.clerk.com` is `connect_rejected` at the proxy**, so §2a's password check is no longer
    available from a session. The owner signs in at camphawk.app with the exact ASC string.
- **Play production release 25 was IN REVIEW as of 2026-09-01, and nobody in a session can read
  the Play console — treat that as a date, not as current state.** Ask the owner before acting on
  it.
- **The release-window Routine self-disables 2026-09-12**, ~2 firings left.
- **A NUMERIC TEST FIXTURE IS VISIBLE TO PRODUCTION, AND ONE HALF OF IT HAS A NARROW SAFE FIX.**
  `REAL = '0'` passes `REAL_UNIT`, so for the length of any `npm test` run both `nextHoldRelease`
  and `holdAtRisk` return a phantom `carted` hold — which reddens `autocart.rc_session`, can spend
  a `maybeAutoLogin` turn, and in `hold-fixture-invisibility` (which borrows
  `SELECT id FROM users LIMIT 1`) returns **a real account's phone**. The safe repair is to give
  that suite its own inserted user with no phone, as `health-hold-counts` already does — it
  touches neither the assertion nor the release timing. **Do NOT instead push the fixture's
  `release_at` out**; the near release is load-bearing and moving it makes the guard flaky in the
  direction that reads green. It is `worker/**`, so verifying restarts all three pollers.
- **`hold-line.test.mts` FAILS 4-11 TESTS AGAINST PRODUCTION AND THE DIFF IS USUALLY INNOCENT
  (2026-09-16).** A docs-only branch came back `# fail 4`; the same suite alone gave **8 on
  master, then 0 on the very next run**, with different test NAMES each time. The failing names
  are all `dueHolds` and `rankHoldLine` — **both of which run in production against the same
  table** (`rankHoldLine` every poller cycle, `dueHolds` every 15s from the box), so this is the
  `reclaimLapsedHolds` test-versus-production class and serializing the lanes cannot prevent it.
  - **I NEARLY FILED #343 AS THE CAUSE and the evidence was excellent** — the commit before it
    passed 28/28 while master failed 8, and #343 touches `auth.ts`, `poller.ts` and adds a
    migration. **Master then passed 28/28 on the next run.** One extra command separated a
    regression from timing. Re-run before believing a pairing.
  - **Do NOT loosen the assertions.** They cover the 08-26 double-cart, where the bot carted one
    campsite twice for two different users. Why it got heavier is **not established** — the
    obvious candidate is live hold rows, and nobody looked.

- **Recorded, not fixed — do not drive-by any of these:** neither containment arm can fire during
  a ramp; the RDR request burst (69,060 asks, zero answers of any kind); the fixed-sentinel test
  fixtures in `sync-claim`/`ridb-photos`/the hold suites; a pre-migration-070 watch silently
  covering less of a park than its name suggests; `autocart.bot_version` armed by a comment.

---

## 4. Serial rules — one production database, one box

From `docs/LANES.md`. Announce and wait before: `npm test`, `scripts/rc-test-hold.mts`, anything
that restarts the box, `sms-link-test.mts --send`.

- **A merge IS a test run**, and so is a second push.
- **One push starts TWO runs** (`push` + `pull_request`) which overlap for **3-301 seconds**,
  measured. Nothing a lane can do prevents it. A red run whose job started within that window of a
  push has a named cause: re-run in a clean window rather than hunting.
- **A third writer no lane starts:** the Nightly RIDB Sync writes the catalog for ~38 minutes and
  is started by nobody. Check `actions_list` before reading a red CI as a regression.
- **AND THE TWO LANES' CI RUNS OVERLAP FOR THE FULL SUITE — MEASURED 2026-09-16, 9m09s.**
  Different branches are different concurrency groups, so **nothing cancels either**: a side-lane
  run (16:22:07→16:33:07) and a main-lane run (16:21:54→16:31:16) both ran `npm test` against the
  production DB start to finish, and mine came back `# fail 1` of 2207 on a **one-Markdown-file
  diff**. The same tree passed **2207/2207 locally in a clean window**, and the re-run was green.
  - **This is the branch-vs-branch case**, not the push-vs-pull_request one above and not the
    Nightly Sync — check `actions/runs?per_page=12` for the OTHER lane's window before blaming
    either. **Both lanes being active is the normal state**, so this is not an edge case.
  - **The failing NAME was below `get_job_logs`' cap** (the visible window opened at `ok 2160`),
    so the name is unreachable through CI and `npm test > log 2>&1` locally is the only route —
    which doubles as the clean-window evidence a legitimate re-run needs.
- **Two sessions can be the SAME lane** — the branch name does not distinguish them and
  `ListAgents` cannot see a sibling elsewhere. An empty list is not exclusive use of the database.

---

## 5. Traps that have actually fired

- **Never read an exit code through a pipe** — `| tail` reports `tail`'s status and cuts every
  `not ok` line. Two false greens from one command.
- **Read the instrument before reasoning about the code.** The failures here are overwhelmingly
  instruments that were running and unread.
- **Check a Sentry issue's TIMESTAMP before reading it as live.** CAMPHAWK-N (*"no unique or
  exclusion constraint matching the ON CONFLICT specification"* on `/api/webhooks/revenuecat`) is
  dated **Sep 14 — before #340 added the partial-index predicate that fixes it.** CAMPHAWK-M and
  CAMPHAWK-K are Server Action staleness, the ordinary consequence of a deploy. **`sentry` is an
  unauthorized MCP server here** — it needs an interactive `/mcp` authorization, so those readings
  came from the web UI and cannot be re-taken in a session.
- **Compute elapsed time in SQL**, never by subtracting a rendered label from a clock read
  elsewhere. This produced a wrong "1h50m" against a true 6.09h on 09-10.
- **`GITHUB_TOKEN` is a 14-character placeholder and `/user` returns 200** — a false positive.
  Public `/repos/` **reads** work unauthenticated; anything scoped or written goes through MCP.
- **A red CI's failing test name can be unreachable** — `get_job_logs` caps at ~5,000 lines and
  `not ok` can appear zero times over a job reporting `# fail 1`. Reproduce locally with
  `npm test > log 2>&1` and grep `^not ok`.
- **RC's `Lock`/`release_at` is a zone-less PACIFIC wall clock.** Use `pacificWallClockToUtcMs`
  (`worker/held-cadence.ts`) in JS, `AT TIME ZONE 'America/Los_Angeles'` in SQL.
- **A guard can pass vacuously and a mutation can fail to apply.** Grep for the mutation as well
  as running the suite. This has caught ~28 guards anchored on the wrong thing.
- **`git checkout -- <file>` reverts to HEAD**, so during mutation testing it deletes the
  uncommitted fix under test. Commit before mutating.
- **`git rebase --onto origin/master <old-tip>`** for a branch cut from a squash-merged branch.
- **A column aliased `t` makes `query()` return scalars, not row objects** — it collides with
  `exec_select`'s own wrapper subquery alias, so `json_agg(t)` resolves to that COLUMN. Every
  field reads `undefined` with a plausible row count. **`AS` is irrelevant in both directions;
  the alias being `t` is everything.** Hit again on 09-17, the day it was recorded.
- **`sqlit` interpolates, it does not bind**, and throws on a plain object — stringify jsonb.
- **No non-ASCII in `.ps1`**, no `\"` inside a `powershell -Command` string in a `.bat`, no
  backticks in a SQL comment inside a template literal.
