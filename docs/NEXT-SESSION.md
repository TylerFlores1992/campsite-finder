# Next session — start here

*Rewritten 2026-08-25, evening. Supersedes the 11:45 version entirely.*

> ## THE TRACK A TRAIL IS BUILT AND SHIPPED. The next session's job is to READ IT.
>
> The owner's instruction was *"start track a trail do whatever we need to fix leak. Update box
> when needed and do tests to stress test."* The trail is built, mutation-guarded, proven
> end-to-end against a real Chromium, merged, and on the box. **It is an INSTRUMENT, not a
> cure.** Track B (§5) is still unstarted and still wants its own word.
>
> **There is nothing to build until a ramp is read.** Ramps arrive ~3x a day unprompted. Do NOT
> queue a test hold to force one — see §2.

*Delete this file once the trail has captured a real ramp AND the App Store version has a
decision. It is a handover, not a permanent doc, and a stale one reads like current state.*

---

## 0. Ground yourself — in this order

### 0a. Can you reach production?

```bash
curl -sS "$HTTPS_PROXY/__agentproxy/status"        # recentRelayFailures names blocked hosts
curl -sS -m 12 -o /dev/null -w '%{http_code}\n' https://camphawk.app/
```

**Egress was healthy all session 2026-08-25.** Only `flyctl-metrics.fly.dev`, `mcp.vercel.com`
and `mcp.sentry.dev` are denied. **It has been revoked mid-session before** (08-23/08-24). If it
is blocked: **report the hosts and stop.** Do not route around it.

### 0b. `NODE_USE_ENV_PROXY=1` OR NOTHING REACHES SUPABASE — INCLUDING `npm test`

This cost half an hour on 08-25 and it looks exactly like a revoked allowlist:

```
DB query error: Host not in allowlist: mraeprivokvmxbvhwbbj.supabase.co
```

That is **not** a revocation. `npm run verify` does not set the variable, so in this sandbox it
must be run as `NODE_USE_ENV_PROXY=1 npm run verify` or ~150 real-DB tests fail at once, across
files that have nothing to do with each other. CI is unaffected — it is not behind this proxy.

**And do not read an exit code through a pipe.** `npm run verify 2>&1 | tail -25` reports
`tail`'s status, which is always 0, and the tail also cuts every `not ok` line. Redirect to a
file and check `$?`. That is two separate readings of "green" that were neither.

### 0c. The four readings

```bash
NODE_USE_ENV_PROXY=1 npx tsx scripts/native-alloc-readout.mts    # Track A — THE ONE THAT MATTERS
NODE_USE_ENV_PROXY=1 npx tsx scripts/chromium-memory-readout.mts # did a ramp happen at all?
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts        # the 8am flow
NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-ask.mts git-status      # what the box is running
```

---

## 1. THE ASSIGNMENT — read the next ramp

`scripts/auto-cart-bot/rc-alloc-trail.mjs` samples the allocation profile **on the watchdog
tick**, keeps a 20-minute window, and reports a segment's peak when it ends (plus a flush at
teardown and in the runaway bail). Four renderers: `resident`, `renewal`, `auto-login`,
`warmup`, each under its own context.

### What to look for, and what each answer means

| reading | what it says |
|---|---|
| `trail-resident` carries the gigabytes | **The allocation is on the resident page.** PR #142's throwaway-tab cure is aimed at the wrong renderer, which explains why ramps continued after it shipped. The cure is a different change. |
| `trail-renewal` / `trail-warmup` carries them | The cure is aimed correctly and something else keeps the memory. Track B becomes the question. |
| a ramp in `chromium_memory_samples`, nothing in `native_alloc_readings` | **Still a reading.** The trigger is wrong, and the next move is the trigger, not the sampler. |
| `net::` frames or a SYSTEM dll (`ws2_32`, `winhttp`, `mswsock`) | the buffering candidate, asserted three times and never shown, finally confirmed. |

**The renderer share is NOT the whole ramp.** `Memory.startSampling` is absent on the
browser-process target — verified — and on 08-24 the browser process held 779 MB of 9,338. So
~90% is the ceiling of what any of this can attribute, and the rendered line says so.

### DO NOT queue a test hold to force a ramp

Three arrived free of charge in thirty hours and the old instrument missed all three. A staged
one locks a real campsite and would be missed identically if the trigger is wrong. **Wait.**

---

## 2. What was corrected on 2026-08-25, so it is not re-derived

### 2a. THE PROFILE-RESET STORY IS WRONG ABOUT RC — and it was written in as fact first

The obvious explanation for the renewal tab reporting **17 MB** against an **8,052 MB** family
is that CDP's all-time profile is reset by the navigation. It IS reset — by a navigation that
swaps the **renderer** — and RC's does not. Measured:

```
a.probe2     -> b.probe2        (different SITE)   192 ->   1 MB   RENDERER SWAPPED
www.rc.probe -> signin.rc.probe (SUBDOMAIN)        216 -> 217 MB   same renderer
```

**Chromium isolates by SITE — scheme + eTLD+1 — not by origin.** `www.reservecalifornia.com` ->
`signin.reservecalifornia.com` is a subdomain hop and keeps its renderer.

It was asserted in three files for about an hour, on the strength of a first experiment using
`a.test`/`b.test` — two genuinely different sites, and not the navigation this product makes.
**Only `alloc-trail-probe.mjs` refusing a verdict caught it.** Reproduce it in one command:
`node scripts/auto-cart-bot/alloc-trail-probe.mjs` prints that table every run.

### 2b. The all-time total is NOT strictly monotonic

A real run stepped **955.4 -> 955.2 MB** between consecutive reads. Under a strict "any decrease
is a renderer swap" rule that cut a 1,271 MB ramp into 954 and 319 and reported the larger half
as the whole event. It splits on a **collapse** (under half) now. Do not "tidy" that back to a
strict comparison — an instrument that halves the number it exists to report is worse than none.

### 2c. The instrument was nearly part of the disease

`getAllTimeSamplingProfile`'s response grows **linearly with bytes ever allocated** (~1.7 KB per
MB, measured). The resident page is read every 20s for the life of the browser, so at 9 GB each
read would ask a dying renderer to serialize ~16 MB, repeatedly, at the peak. The long-lived
target samples at **8 MB** resolution (`LONG_LIVED_INTERVAL`); the trip tabs keep 1 MB. Pinned,
because reverting it looks like a tidy-up.

---

## 3. State

| | |
|---|---|
| Master | see `git log`; the trail merged as **PR #193** |
| Mini-PC | updated to the trail — confirm with `bot-ask git-status`, not `autocart.bot_version` |
| Open PRs | none |
| Open issues | **#76**, **#14** |
| Migrations | highest applied **068**; next main-lane number is **069** |
| Holds | one **untapped** offer for 08-26 08:00 PT as of 12:40 PT. `offered` does not block the update window or `npm test`; a TAP changes both. |

**Two check-ins are scheduled and enabled — do not create duplicates.**
`trig_01NdJC1SvSDwxZZroAooVKnU` fires **07:40 PT** into a fresh session;
`trig_01CzPKmDUz5MC3tbYFGMTS4a` fires **08:15 PT** with the outcome readout.

---

## 4. Serial rules — and the one I broke

From `docs/LANES.md`: no `npm test`, no second test hold, and nothing that restarts the box,
while a hold is live.

**AND DO NOT RUN `npm run verify` LOCALLY WHILE CI IS RUNNING.** I did, on 08-25, and CI failed
one test — `rc-holds.test.mts`, *"a carted hold records how to RELEASE it"*, `Cannot read
properties of null`. That suite sweeps `unit_id LIKE '__t%'`, i.e. **every** suite's fixtures,
so my local run deleted CI's live row. It is issue **#76** and it is entirely self-inflicted:
merging or pushing IS starting a test run. A re-run was legitimate here only because the diff
cannot touch that file, the suite passed alone, and the mechanism is named — any one of those
missing and it is a regression being waved through.

---

## 5. Track B — designed, NOT started, needs its own go-ahead

Replay the Okta round trip over `ctx.request` following redirects and exchange the code
ourselves: no page load, no renderer, no gigabytes. Three pieces already exist
(`force-login-prompt.mjs` intercepts `/authorize`, `rc-token.mjs:108` reads `code_verifier`,
okta-auth-js's `okta-transaction-storage` is known to the code).

**Still deliberately unstarted.** It is surgery on the one path between a queued hold and a
missed cart, and the renderer-only sampler cannot see the browser-process share. **§1's reading
is what makes it decidable** — if the growth is on the resident page, `ctx.request` may be the
wrong lever entirely. Building it blind is how a repair gets credited to the wrong mechanism,
which has happened three times.

---

## 6. Recorded, not fixed — do not drive-by these

- **NEITHER CONTAINMENT ARM CAN FIRE DURING A RAMP, and 08-25 established why.** The size arm
  (`RC_MAX_FAMILY_MB = 1500`) sits in the LOOP BODY, and the ramp happens inside `renewSession`
  which the loop is awaiting — so for the ten minutes that matter, control is past the check.
  The RAM arm is exactly one condition short: the stall half is amply true, the **RAM** half
  never trips (troughs 2,144-3,328 MB against a 2,000 floor, six ramps, closest 144 MB). The
  size arm fires on the NEXT iteration once the renewal returns, which is the **leading
  candidate** for the browser replacement that ends every ramp.
  **Still a QUESTION, not a patch.** Moving the size scan into the timer would spawn PowerShell
  there, and spawning is what fails first at 99% COMMIT; lowering the RAM floor is what killed a
  working repair on 08-19 (`keepwarm-recycle.test.mts` bounds it 1500-3000 with the reasoning).
  **The trail's reading is what should decide it** — and note the trail already reports from
  exactly the moment the size arm breaks the loop, because the teardown flush takes the OPEN
  segment.
- **A CI run can turn `autocart.rc_session` RED.** The health route carries its own inline
  `upcoming`/`imminent` counts that never got the `REAL_UNIT` filter. The phone is safe
  (`holdAtRisk` IS filtered); the dashboard is not, and while red it prints the destructive
  `rc-login.bat` remedy over a healthy session. **The honest fix is one definition, not three.**
- **Three test suites sweep each other's fixtures** (`unit_id LIKE '__t%'`) and `npm test` runs
  files concurrently. That is #76, and §4 above is what it looks like in practice.
- **The rec.gov `carted` SMS body overflows one segment for 19 campgrounds.**
- **A token rebroadcast can clear an `expired` verdict** in the claim gate.
- **The live manage token `EQO2oXcQ`** — unrotated, in git history. One DELETE. **Owner's call.**

---

## 7. Traps that have actually fired

- **`NODE_USE_ENV_PROXY=1`, and never read an exit code through a pipe.** See §0b — both cost
  real time on 08-25 and both produced confident wrong readings.
- **`GITHUB_TOKEN` is a 14-character placeholder and `/user` returns 200.** A false positive;
  anything repo-scoped 403s. Use the MCP tools.
- **Verify a push against the remote**, not local HEAD:
  `git fetch origin <branch> && git rev-parse origin/<branch>`.
- **A branch cut from another feature branch conflicts after that branch is SQUASH-merged.**
  Master carries one commit where the branch carries two, so a plain rebase replays both and
  conflicts. `git rebase --onto origin/master <old-tip>` replays only your own work.
- **Read the readout's `site` column.** `TEST · ` in `unit_name` is the one unambiguous fixture
  marker.
- **A guard can pass vacuously, and a mutation can fail to apply.** Grep for the mutation as
  well as running the suite. Two of this session's guards were wrong at baseline: one anchored
  on a comment line (and `code` strips comments), and one gave a ramp two samples so pruning
  left one — proving the segment became unreportable rather than that the key was stable.
- **`sqlit` interpolates, it does not bind**, and throws on a plain object. Stringify jsonb.
- **No non-ASCII in `.ps1`**, no `\"` inside a `powershell -Command` string in a `.bat`, no
  backticks in a SQL comment inside a template literal.
