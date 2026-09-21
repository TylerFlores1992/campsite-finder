# The CLAUDE.md prune ledger — what moved where, and the proof nothing was lost

*Written 2026-09-21, on branch `claude/claude-md-prune`.*

`CLAUDE.md` was **20,414 lines / 1,606,968 bytes ≈ 400,000 tokens**, injected into context on
**every turn of every session** — about 52% of an orchestrating session's token bill. Two
sections were 96% of it: `## Web-session gotchas (this environment)` (12,376 lines) and
`## Open / next session` (7,145 lines).

**NOTHING WAS DELETED. EVERYTHING WAS MOVED.** That is not a promise, it is a checkable
property: every original line **1–20,415** is assigned to exactly one destination, the
assignment is contiguous with no gap and no overlap, and each destination's body was compared
**line for line** against the original text it came from. The verification is reproduced below
and re-runs in seconds.

**Why the rule is absolute.** This repository's most expensive recurring failure is a finding
that vanished and was re-derived — the Feature E correction was rediscovered from scratch
three separate times because two docs PRs carrying it sat open and nobody folded them in.
`docs/LANES.md` states it plainly: *"A finding deleted in a merge reads precisely like a
finding nobody ever wrote — there is no diff to notice, no test to fail, and the next session
re-runs the experiment that produced it."* So a block whose value was genuinely spent was
**still moved**, and anything undecidable was moved rather than judged.

---

## Result

| | |
|---|---|
| `CLAUDE.md` before | **20,414 lines** |
| `CLAUDE.md` after | **1,309 lines** (–93.6%) |
| Blocks relocated | **216**, all classified **MOVED** |
| Ranges kept in place | **4** (965 lines, verbatim) |
| SUPERSEDED-AND-FOLDED / TRANSIENT / DUPLICATE | **0 / 0 / 0** |
| Lines deleted | **0** |

**Every row is MOVED and that is the strongest available outcome.** The brief permitted
`SUPERSEDED-AND-FOLDED`, `TRANSIENT` and `DUPLICATE` as classifications, each of which ends in
text ceasing to exist. None was used. No judgement call resolved to a deletion, so no future
reader has to trust this session's judgement about what was safe to lose — only its
arithmetic, which is checkable.

### Where the 20,415 lines went

| dest | file | ranges | lines | what it is |
|---|---|---:|---:|---|
| `C` | `CLAUDE.md` | 4 | 965 | orientation map, product sections, the alerting/SMS/deploy rules, and the `## Web-session gotchas` preamble — **kept verbatim** |
| `L` | `docs/CHROMIUM-LEAK.md` | 65 | 9,318 | the Chromium memory leak, the RC keep-warm browser, token/Okta renewal, and every instrument built to measure any of them |
| `R` | `docs/ARCHIVE-RC-AUTOCART.md` | 79 | 4,597 | the RC auto-cart flow, the 08:00 hold path, the claim hand-off, the mini-PC |
| `O` | `docs/ARCHIVE-OPEN-BLOCKS.md` | 1 | 1,655 | the blockquoted dated handover blocks, 2026-09-11 → 2026-09-01, newest first |
| `P` | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | 71 | 3,880 | stores and IAP, billing, alerting/SMS history, CI and real-DB concurrency, the web app and SEO, the session harness |

**Four archives rather than the two the brief named, and that is a deliberate deviation worth
challenging.** The brief specified `docs/CHROMIUM-LEAK.md` and `docs/ARCHIVE-OPEN-BLOCKS.md`.
Filing the RC hand-off findings or the five App Store rejections into a file named
*ARCHIVE-OPEN-BLOCKS* would misname them — and **a finding in a misnamed file is a finding
nobody finds**, which is the same failure the no-deletion rule exists to prevent, reached by a
different route. `ARCHIVE-OPEN-BLOCKS.md` therefore holds exactly what its name says: the
dated handover blocks that were genuinely state snapshots.

---

## The proof

Reproduce it with `python3` from the repo root against the pre-prune `CLAUDE.md`
(`git show 07dcd41:CLAUDE.md`). The script asserts three things:

1. **Contiguity.** Sorting the 220 ranges by start line, each begins exactly where the previous
   one ended: `coverage 1..20415`, against an original of 20,415 lines including the trailing
   empty element `split('\n')` produces for a newline-terminated file. **No gap, no overlap** —
   so no line is unassigned and no line is claimed twice.
2. **Verbatim reproduction.** Each archive's body, read past its `---` header, is compared
   segment by segment with `orig[s-1:e]` in ascending original order. Every comparison is an
   exact list equality, and each archive is **fully consumed with zero non-blank lines left
   over**, so nothing was added either.
3. **The kept ranges survive.** All four `C` ranges are located verbatim, in order, in the new
   `CLAUDE.md`.

```
verbatim OK      1-245   ( 245 lines) at new:1
verbatim OK    415-891   ( 477 lines) at new:265
verbatim OK    892-1132  ( 241 lines) at new:742
verbatim OK  13269-13270 (   2 lines) at new:1259
kept-ranges verbatim: PASS
coverage 1..20415  (original has 20415 lines incl. trailing)
  L consumed   9318 of   9318 body lines, 0 non-blank left over
  R consumed   4597 of   4597 body lines, 0 non-blank left over
  O consumed   1655 of   1655 body lines, 0 non-blank left over
  P consumed   3880 of   3880 body lines, 0 non-blank left over
reassembly: PASS
```

**Every range is heading-aligned.** Ranges were cut at `##`/`###`/`####` boundaries derived
from the file's own 513 headings, never at an arbitrary line, so **no block was split
mid-argument** and no sub-section was separated from the heading that frames it.

---

## The strike-through audit — 137 lines, and why a naive pass would have been harmful

`CLAUDE.md` contained **137 lines carrying `~~`**. The obvious reading is that struck text is
dead text. **It is not, and several of these are load-bearing**, because in this repo a
strike-through is how a *tempting wrong answer* is preserved next to its refutation. Deleting
the struck claim leaves the correction standing over nothing, and the next reader re-derives
the wrong answer because nothing records that it was already tried. The file says so itself:
`~~THE JIT BRANCH IS CLOSED~~` is struck precisely so a later session does not close that fork
again, and `~~THE 22:49 REHEARSAL IS WHAT STOPPED THE RAMPS~~` is struck because the tidy
story it carries is the one somebody will otherwise re-invent.

**Not one strike-through was touched as a strike-through.** No struck text was removed,
rewritten, un-struck, or separated from its correction. Because ranges are heading-aligned and
every block moved whole, **every struck line landed adjacent to exactly the same correcting
text it was adjacent to before.**

| destination | strike-through lines | correction preserved? |
|---|---:|---|
| `docs/CHROMIUM-LEAK.md` | 51 | yes — in-block, unchanged |
| `docs/ARCHIVE-OPEN-BLOCKS.md` | 32 | yes — in-block, unchanged |
| `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | 29 | yes — in-block, unchanged |
| `docs/ARCHIVE-RC-AUTOCART.md` | 23 | yes — in-block, unchanged |
| `CLAUDE.md` (kept in place) | 2 | yes — lines 939–940, untouched inside the verbatim env-gotchas preamble |
| **total** | **137** | **137** |

**How many needed their correction preserved: all 137**, and the mechanism that preserved them
is structural rather than editorial — moving whole heading-aligned blocks cannot sever a
correction from the claim it corrects. Struck headings confirmed moved intact include
`#### ~~THE COMMAND BUFFER IS OFF NOW, GATED~~` (→ leak), `#### ~~THE 22:49 REHEARSAL IS WHAT
STOPPED THE RAMPS~~` (→ leak), `### ~~"CANCELLATIONS DON'T START UNTIL TWO WEEKS OUT"…~~`
(→ product), `### A TypeError PUBLISHED A USER'S PASSWORD … ~~and the feature is REVERTED~~`
(→ RC), and `#### ~~`exec_select` SILENTLY RETURNS A SCALAR…~~` (→ product).

---

## What stayed in `CLAUDE.md`, and why those four ranges

| orig lines | what | why it stayed |
|---|---|---|
| 1–245 | the orientation map and the product sections | the fast map a fresh session needs before it can read anything else |
| 415–891 | alerting/the claim, SMS delivery + domain + segment, expired watches, the admin colour rule, the egress watchdog, rec.gov 429s, Empty ≠ booked, the typecheck rule, the rec.gov scheduler, catalog syncs, sharding, tests, provider resilience, Deploy | these are **live operating rules** for code that runs every 15 seconds, not history |
| 892–1132 | the `## Web-session gotchas (this environment)` preamble | the most universally useful content in the file — the proxy rule, the `GITHUB_TOKEN` placeholder, blocked hosts, the CI-filter trap, `AS t`, `tail-log <name>:400`, "there is no `.env` file" |
| 13269–13270 | the `## Open / next session` heading | retained; its contents were relocated and replaced with a current list |

**The env-gotchas preamble was kept verbatim rather than compressed on purpose.** Compression
is deletion unless the full text lands somewhere, and this is the block a session is most
likely to need on turn one.

Three sections are **new prose** rather than relocated text, and each is a summary of material
that survives in full elsewhere:

- `## ReserveCalifornia auto-cart — SETTLED` — an 18-line router entry replacing the 169-line
  original, which moved verbatim to `docs/ARCHIVE-RC-AUTOCART.md`.
- `## The house failure shapes` — the six recurring shapes stated once. Every instance that
  taught them survives in the archives.
- `## Where the detail lives — the router` — eleven entries. **A router entry is not a
  filename**: each carries the CONCLUSION and the standing prohibitions, so a reader who never
  opens the archive still cannot re-run a dead experiment.

---

## Known limitations — stated rather than discovered later

1. **Cross-references can now span files.** `CLAUDE.md` interleaved its subjects
   chronologically, so a block that says *"the entry above"* may now sit in a different
   archive from the entry it means. Blocks are intact and in their original relative order;
   only their neighbours changed. **Every archive header says so**, and the tables below map
   each block to its original line range, so a reference that has lost its target is one
   lookup away. **Checked in the kept text**: only four such phrases survive in the new
   `CLAUDE.md`, and all four point at text that is still in the new `CLAUDE.md`.
2. **Four archives rather than the two named in the brief** — reasoned above.
3. **1,309 lines rather than the ~1,200 target.** The overshoot is entirely preserved
   verbatim text (the 965 kept lines) plus a router that carries conclusions rather than
   filenames. Cutting to 1,200 would have meant compressing the env-gotchas preamble, which is
   deletion unless the full text lands elsewhere.
4. **No test reads `CLAUDE.md` from disk**, so this change cannot break one by content.
   Thirty files under `worker/` and `src/` mention `CLAUDE.md` — all in prose comments; a grep
   of those same lines for `readFile|readFileSync|resolve|join(|path.|open(` returns **zero**.
   The only `.md` files any test reads are `docs/PLATFORM-PARITY.md` and `docs/APP-STORE.md`,
   neither touched. `NODE_USE_ENV_PROXY=1 npm run typecheck` passes on **both** configs.

### Final line counts

| file | lines |
|---|---:|
| `CLAUDE.md` | 1,309 |
| `docs/CHROMIUM-LEAK.md` | 9,340 |
| `docs/ARCHIVE-RC-AUTOCART.md` | 4,618 |
| `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | 3,906 |
| `docs/ARCHIVE-OPEN-BLOCKS.md` | 1,677 |
| `docs/PRUNE-LEDGER.md` | this file |

*(Archive totals exceed their moved-line counts by each file's ~16-line header.)*

---

## Moved blocks — 216 rows, every one MOVED

| block (heading + line count) | destination | classification | evidence |
|---|---|---|---|
| ## ReserveCalifornia auto-cart — SETTLED 2026-08-06, and still OFF<br>*(169 lines, orig 246–414)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **246–414** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### CONCURRENT CART MINTING IS SAFE, MEASURED (2026-08-17) — and carting is parallel now<br>*(72 lines, orig 1133–1204)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **1133–1204** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### RC AUTO-HOLD IS LABELLED BETA, AND THE ENTITLEMENT WAS NEVER THE GATE (2026-08-17)<br>*(41 lines, orig 1205–1245)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **1205–1245** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE HOLD RUNNER WAS DOWN 2.5 HOURS AND THE WATCHDOG NEVER NOTICED (2026-08-17)<br>*(48 lines, orig 1246–1293)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **1246–1293** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE WATCHDOG NEVER RAN — WINDOWS STOPPED SCHEDULING (2026-08-17, second pass)<br>*(60 lines, orig 1294–1353)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **1294–1353** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE KEEP-WARM WEDGES ~HOURLY IN THE NEAR-EXPIRY RENEWAL (2026-08-17) — STILL OPEN<br>*(32 lines, orig 1354–1385)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **1354–1385** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE CHROMIUM LEAK IS FULLY ATTRIBUTED (2026-08-17, third pass) — 20 RAMPS IN 5 DAYS<br>*(104 lines, orig 1386–1489)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **1386–1489** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THREE INSTRUMENTS FOR THE UNCURED HALF (2026-08-17, fourth pass)<br>*(45 lines, orig 1490–1534)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **1490–1534** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE FIRST REAL FIRING, AND WHAT IT COST (2026-08-18)<br>*(127 lines, orig 1535–1661)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **1535–1661** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### FOURTH FIRING, 2026-08-18 23:12 PT — BOTH INSTRUMENTS ANSWERED<br>*(25 lines, orig 1662–1686)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **1662–1686** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### STOP RENEWING AT NEAR-EXPIRY (2026-08-18) — BUILT, awaiting a box update<br>*(41 lines, orig 1687–1727)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **1687–1727** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **4 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### A THREE-DAY-OLD TOKEN KEEPS COMING BACK (2026-08-19) — the session cannot exit the loop<br>*(125 lines, orig 1728–1852)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **1728–1852** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### `npm test` KILLED THE PRODUCTION RC SESSION (2026-08-19) — fixed in the FEED<br>*(23 lines, orig 1853–1875)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **1853–1875** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### A BLANK RC APP IS NOT A FAILED LOGIN — in the release path too (2026-08-19)<br>*(15 lines, orig 1876–1890)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **1876–1890** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE NIGHTLY UPDATE IS STRUCTURALLY IMPOSSIBLE ON ANY NIGHT WITH AN 08:00 HOLD (2026-09-20)<br>*(70 lines, orig 1891–1960)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **1891–1960** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### "UPDATE NOW" IS FAST NOW (2026-08-19) — and the ~20-minute note below is superseded<br>*(16 lines, orig 1961–1976)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **1961–1976** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### A REMOTE `test-login`, AND WHY NOT A SHELL (2026-08-19)<br>*(22 lines, orig 1977–1998)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **1977–1998** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE RENEWAL RUNS IN A THROWAWAY TAB NOW (2026-08-19) — the first CURE, and what it rests on<br>*(41 lines, orig 1999–2039)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **1999–2039** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### FIVE INSTRUMENTS AND NONE OF THEM STOPS IT — so COUNT THE BYTES (2026-08-19)<br>*(69 lines, orig 2040–2108)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **2040–2108** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE RAM GUARD KILLED THE REPAIR IT WAS PROTECTING (2026-08-19) — floor 4000 → 2000<br>*(52 lines, orig 2109–2160)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **2109–2160** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### TWO CONCURRENT `npm test` RUNS RACE ON A GLOBAL SWEEP (2026-08-18)<br>*(94 lines, orig 2161–2254)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **2161–2254** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE SESSION RENEWS ITSELF ONCE WE STOP TOUCHING IT (2026-08-18, first 2.5 hours)<br>*(35 lines, orig 2255–2289)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **2255–2289** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### IT IS THE OKTA NAVIGATION, AND THAT IS A CONTROLLED COMPARISON (2026-08-18, fifth pass)<br>*(65 lines, orig 2290–2354)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **2290–2354** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### A 25 GB RUNAWAY, FIVE RECYCLES, AND THE GUARD CLOSED THE WRONG BROWSER (2026-08-18)<br>*(96 lines, orig 2355–2450)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **2355–2450** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### `npm test` MADE THE PRODUCTION BOT SIGN IN TO RC (2026-08-18) — CI does it on every PR<br>*(46 lines, orig 2451–2496)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **2451–2496** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### OUR OWN LIVENESS CHECK KEEPS THE OKTA SESSION ALIVE — MEASURED, 12 FOR 12 (2026-08-18)<br>*(92 lines, orig 2497–2588)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **2497–2588** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE LOGIN IS THE OPEN RISK, NOT THE LEAK (2026-08-18)<br>*(57 lines, orig 2589–2645)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **2589–2645** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE UPDATER DIED INSIDE ITS OWN `stop-all` — a JOB OBJECT, fixed and PROVEN (2026-08-20)<br>*(48 lines, orig 2646–2693)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **2646–2693** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### `loadEnv` RESOLVED RELATIVE TO THE CALLER, AND A 401 READ AS A BAD TOKEN (2026-08-20)<br>*(23 lines, orig 2694–2716)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **2694–2716** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE IN-APP OKTA FILL: REACT'S `_valueTracker` (2026-08-20)<br>*(27 lines, orig 2717–2743)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **2717–2743** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### "PLATFORM NOT REPORTED" WAS THE TRIM, NOT A MISSING FEATURE (migration 064, 2026-08-20)<br>*(14 lines, orig 2744–2757)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **2744–2757** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE AUTO-LOGIN WAS THE BIGGEST OKTA TRIP NOBODY HAD MEASURED (2026-08-20)<br>*(43 lines, orig 2758–2800)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **2758–2800** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### `worker-deploy.yml`'s PATH LIST HAD DRIFTED FROM WHAT THE WORKER IMPORTS (2026-08-20)<br>*(17 lines, orig 2801–2817)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **2801–2817** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE OKTA SESSION'S STATE IS A COLUMN NOW (migration 065, 2026-08-21)<br>*(43 lines, orig 2818–2860)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **2818–2860** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE EXPENSIVE SIGN-IN WAS PINNED TO THE RELEASE-CRITICAL WINDOW (2026-08-21)<br>*(38 lines, orig 2861–2898)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **2861–2898** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### #203 DOES NOT COVER A FIXED SENTINEL, AND I PROVED IT BY BREAKING THE RULE (2026-08-28)<br>*(169 lines, orig 2899–3067)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **2899–3067** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE TRAIL'S SILENCE IS INSTRUMENTED, AND THE BOX HAS IT (2026-08-28)<br>*(47 lines, orig 3068–3114)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **3068–3114** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE TRAIL ANSWERED, AND IT IS THE PROFILER — TRACK A CANNOT SEE THESE BYTES (2026-09-04)<br>*(107 lines, orig 3115–3221)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **3115–3221** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE LEAK — WHERE IT ACTUALLY STANDS (2026-08-22)<br>*(58 lines, orig 3222–3279)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **3222–3279** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### TRACK A'S FIRST READING NAMED NOTHING — IT WAS VALIDATED ON THE WRONG PLATFORM (2026-08-22)<br>*(39 lines, orig 3280–3318)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **3280–3318** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE STALE TOKEN COMES FROM THE SERVER (2026-08-22) — every local candidate is eliminated<br>*(17 lines, orig 3319–3335)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **3319–3335** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE RENEWAL HAS FAILED 20 TIMES RUNNING AND IS IN BACKOFF (2026-08-22)<br>*(12 lines, orig 3336–3347)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **3336–3347** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### RAMPS ARE MUCH RARER NOW — AN OBSERVATION, NOT A CURE (2026-08-22)<br>*(12 lines, orig 3348–3359)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **3348–3359** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE OKTA CAP DID NOT RESET ACROSS A PASSWORD SIGN-IN (2026-08-16, folded in 2026-08-22)<br>*(16 lines, orig 3360–3375)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **3360–3375** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE RAMP IS AN ELEVEN-MINUTE CLIMB, NOT A SPIKE (2026-08-23)<br>*(52 lines, orig 3376–3427)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **3376–3427** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### NEITHER 9 GB RAMP TRIPPED THE RAM ARM (2026-08-24, folded from side-lane §24b)<br>*(36 lines, orig 3428–3463)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **3428–3463** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE HAND-OFF LANDS IN THE CART NOW, AND THE SIGN-IN NEVER PRESSED ANYTHING (2026-08-23)<br>*(65 lines, orig 3464–3528)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **3464–3528** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### `cart read back` NEVER PROVED THE OWNER COULD REACH THE CART (2026-08-29)<br>*(76 lines, orig 3529–3604)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **3529–3604** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### A CAMPSITE WAS LOST TO A TWO-SECOND MARGIN, AND THE FIXES FOR IT CAUSED TWO MORE (2026-08-30)<br>*(381 lines, orig 3605–3985)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **3605–3985** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE RETEST CARTED NOTHING AND SAID IT HAD — THE MARKER COULD NOT NAME ITS SITE (2026-08-29)<br>*(61 lines, orig 3986–4046)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **3986–4046** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### A REAL CAMPSITE IS LOCKED AND WE CANNOT RELEASE IT (2026-08-29)<br>*(16 lines, orig 4047–4062)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **4047–4062** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE FIXTURE COUNT IN THE HEALTH ROUTE WAS NEVER FILTERED (2026-08-23, evening)<br>*(38 lines, orig 4063–4100)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **4063–4100** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### AND THE GUARD FOR THAT COULD NOT SEE THE FIXTURE THE FIX SHIPPED (2026-08-27)<br>*(41 lines, orig 4101–4141)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **4101–4141** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### A REAL TEST HOLD IS QUEUED FOR 2026-08-24 07:58:47 PT — to MANUFACTURE a ramp (2026-08-23)<br>*(61 lines, orig 4142–4202)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **4142–4202** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE MANUFACTURED RAMP WAS NEVER READ — EGRESS IS STILL BLOCKED (2026-08-24 08:15 PT)<br>*(40 lines, orig 4203–4242)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **4203–4242** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### BOTH FIXES ARE DEPLOYED, AND THE THIRD DOOR IS INSTRUMENTED (2026-08-24, evening)<br>*(74 lines, orig 4243–4316)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **4243–4316** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE RAMP WAS ORDERED, IT ARRIVED ON CUE, AND TRACK A HAD NO INSTRUMENT ON IT (2026-08-24 13:00 PT)<br>*(130 lines, orig 4317–4446)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **4317–4446** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### 26 TEXTS IN AN HOUR: A PER-CAMPGROUND KEY IN A SINGLE-VALUED COLUMN (2026-08-24)<br>*(97 lines, orig 4447–4543)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **4447–4543** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. **3 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### TWO PEOPLE WERE PROMISED ONE CAMPSITE, AND A LINE DECIDES IT NOW (migration 068, 2026-08-24)<br>*(34 lines, orig 4544–4577)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **4544–4577** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### AN OFFER CAN BE DECLINED NOW, AND IT IS NOT COSMETIC (2026-08-24)<br>*(19 lines, orig 4578–4596)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **4578–4596** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### RC AUTO-HOLD SAYS WHAT IT IS NOW, IN THE WORDS THE MODULE ALREADY HAD (2026-08-24)<br>*(14 lines, orig 4597–4610)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **4597–4610** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### A POLLER ROW IS A (WATCH, CAMPGROUND), AND FIVE MAPS STILL THOUGHT IT WAS A WATCH (2026-08-24)<br>*(26 lines, orig 4611–4636)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **4611–4636** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THREE SITES AT ONE PARK IS ONE TEXT NOW (2026-08-24)<br>*(26 lines, orig 4637–4662)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **4637–4662** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### `npm test` RUNS FILES CONCURRENTLY AND FIVE SUITES SWEPT EACH OTHER'S FIXTURES (2026-08-24)<br>*(12 lines, orig 4663–4674)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **4663–4674** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE CONTENTION TEST RAN ITSELF, AND TRACK A WAS POINTED THE WRONG WAY (2026-08-25)<br>*(86 lines, orig 4675–4760)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **4675–4760** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE TRACK A TRAIL — BUILT 2026-08-25, and it corrected me twice on the way<br>*(150 lines, orig 4761–4910)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **4761–4910** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### "SEP 4-5" FOR A 4-6 WATCH IS CORRECT — the alert names the NIGHTS (2026-08-27)<br>*(28 lines, orig 4911–4938)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **4911–4938** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### A DISPLAY CONVENTION IS NOT A TIME-ARITHMETIC CONVENTION (2026-08-26)<br>*(58 lines, orig 4939–4996)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **4939–4996** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE FIRST TWO-TAPPED CONTEST IS QUEUED FOR 2026-08-26 08:00 PT — outcome UNREAD<br>*(25 lines, orig 4997–5021)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **4997–5021** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE FAIRNESS LINE SERVED BOTH RIVALS — 14 SECONDS APART (2026-08-26)<br>*(89 lines, orig 5022–5110)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **5022–5110** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### A DEAD SESSION STILL STRANDS A CARTED SITE (2026-08-26) — the 08-13 leak, recurring<br>*(111 lines, orig 5111–5221)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **5111–5221** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### A PASSWORD SIGN-IN CAN BE CHEAP — 32 SECONDS AND ZERO MEMORY (2026-08-26)<br>*(635 lines, orig 5222–5856)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **5222–5856** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **3 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE DUMP CAN NEVER ANSWER — A WEDGED RENDERER IS *PRESENT AND EMPTY* (2026-09-09)<br>*(205 lines, orig 5857–6061)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **5857–6061** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **3 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### VMTHREAD ANSWERED ON ITS FIRST RAMP: THE MAIN THREAD IS SPINNING (2026-09-09)<br>*(197 lines, orig 6062–6258)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **6062–6258** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE SPINNING THREAD IS SAMPLED NOW (2026-09-09) — VMSTACK, built, awaiting a box update<br>*(2383 lines, orig 6259–8641)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **6259–8641** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **15 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE METHOD WAS THE PROBLEM, NOT THE LEAK (2026-09-08) — asked "why do we keep missing things?"<br>*(136 lines, orig 8642–8777)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **8642–8777** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **3 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### `reclaimLapsedHolds` KEPT `cart_key` AND NEVER USED IT — the premise it rested on is retired (2026-08-28)<br>*(52 lines, orig 8778–8829)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **8778–8829** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### ONE ACCOUNT ALWAYS GETS FIRST DIBS (migration 069, 2026-08-28) — a deliberate thumb on the scale<br>*(95 lines, orig 8830–8924)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **8830–8924** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### iOS AND ANDROID DIVERGED ON ONE CAMPSITE EACH, AND THE INSTRUMENTS SAID THEY MATCHED (2026-09-01)<br>*(116 lines, orig 8925–9040)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **8925–9040** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### RC'S SIGN-IN IS TWO STEPS, AND EVERY CLOSE RULE WE EVER SHIPPED RACED THE SECOND (2026-09-01, #249)<br>*(66 lines, orig 9041–9106)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **9041–9106** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE ANDROID HAND-OFF IS FIXED, AND A HUMAN FINALLY LOOKED AT THE CART (2026-09-02)<br>*(35 lines, orig 9107–9141)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **9107–9141** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE RUNNER HUNG IN THE PRE-RELEASE WAIT, ALIVE AND POLLING NOTHING (2026-09-02)<br>*(44 lines, orig 9142–9185)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **9142–9185** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### A CHALLENGE BETWEEN THE EMAIL AND THE PASSWORD ABANDONED THE SIGN-IN (2026-09-02)<br>*(20 lines, orig 9186–9205)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **9186–9205** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE SIGN-IN'S "LONG PAUSE" WAS US HUNTING RC'S CONTROL ON OKTA'S PAGE (2026-09-02, #252)<br>*(49 lines, orig 9206–9254)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **9206–9254** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### #249 WAS NECESSARY AND NOT SUFFICIENT: OUR SIGN-IN SCRIPT WAS CLICKING "LOG IN" ON THE CALLBACK PAGE (2026-09-01, #250)<br>*(39 lines, orig 9255–9293)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **9255–9293** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### WHERE iOS AND ANDROID ACTUALLY DIFFER — AUDITED, AND THE ANSWER REFRAMES THE QUESTION (2026-09-01)<br>*(38 lines, orig 9294–9331)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **9294–9331** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### `trialing` COULD NEVER APPEAR, AND IT MADE TWO CORRECT NUMBERS LOOK LIKE THEFT (2026-09-02)<br>*(38 lines, orig 9332–9369)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **9332–9369** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### A CHURN WAS INVISIBLE UNTIL THE DAY IT LANDED, AND EVERY NUMBER WAS RIGHT (migration 078, 2026-09-16)<br>*(152 lines, orig 9370–9521)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **9370–9521** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### DATES ARE EDITABLE ON `/manage/<token>` NOW — and the form was never the hard part (2026-09-02)<br>*(44 lines, orig 9522–9565)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **9522–9565** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### `subscriptions` CAN BE RECONCILED AGAINST STRIPE NOW (2026-09-02)<br>*(38 lines, orig 9566–9603)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **9566–9603** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### A HOLD-SUITE TEST ASSERTS A GLOBAL, SO A LIVE TEST HOLD FAILS IT (2026-09-02)<br>*(48 lines, orig 9604–9651)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **9604–9651** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### A HOLD OFFER WAS ONE ROW PER CAMPSITE, FOR EVER (migration 074, 2026-09-04)<br>*(37 lines, orig 9652–9688)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **9652–9688** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### HOLDS MOVED INTO THE WATCH CARD, AND A QUEUED ONE CAN BE CALLED OFF (2026-09-04)<br>*(45 lines, orig 9689–9733)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **9689–9733** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE DEAD-MAN'S SWITCH IS GONE (2026-09-04)<br>*(24 lines, orig 9734–9757)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **9734–9757** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### A CAMPSITE WAS LOST TO A 12-SECOND RETRY GAP, AND THE FIX IS A BURST (2026-09-03, #261)<br>*(33 lines, orig 9758–9790)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **9758–9790** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### "RC NEVER RELEASES EARLY" IS UNPROVABLE WITH THE INSTRUMENT WE HAVE (2026-09-03)<br>*(26 lines, orig 9791–9816)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **9791–9816** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE RELEASE WINDOW IS BEING MEASURED DIRECTLY (2026-09-04, #264) — AND IT ANSWERED<br>*(200 lines, orig 9817–10016)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **9817–10016** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE THIRD SHARD (2026-09-04, #262)<br>*(13 lines, orig 10017–10029)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **10017–10029** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### I READ A STALE CHECKOUT AS PRODUCTION DRIFT, AND BROKE THE HOLD BUTTON FOR SIXTEEN MINUTES (2026-09-04)<br>*(35 lines, orig 10030–10064)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **10030–10064** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### RC'S OWN LOAD IS INSTRUMENTED NOW (2026-09-04)<br>*(74 lines, orig 10065–10138)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **10065–10138** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE RDR LOOP IS A LOAD-TIME BURST AT ~800 REQ/S, NOT A 150/S POLL (2026-09-06)<br>*(150 lines, orig 10139–10288)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **10139–10288** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### ~~"CANCELLATIONS DON'T START UNTIL TWO WEEKS OUT" IS FOLK WISDOM AND OUR DATA SAYS OTHERWISE~~ — I MEASURED THE WRONG WINDOW (2026-09-04)<br>*(74 lines, orig 10289–10362)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **10289–10362** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### TWO PROBLEM-INTENT PAGES, AND THEY ARE NOT THE FALSIFIED BET (2026-09-04)<br>*(22 lines, orig 10363–10384)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **10363–10384** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE ONSET IS A 35 GB COMMIT STEP, THE TAB HAS ITS OWN RENDERER, AND THE INSTRUMENTS FOR BOTH ARE BUILT (2026-09-04)<br>*(881 lines, orig 10385–11265)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **10385–11265** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **5 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### SUPABASE EGRESS WAS 2.1x THE FREE LIMIT AND 60% OF IT WAS `bot.mjs` POLLING EVERY 2s (side-lane §27, 2026-08-24; folded 2026-09-04)<br>*(30 lines, orig 11266–11295)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **11266–11295** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### A TOOL-CALL PARAMETER LEAKED ITS OWN CLOSING TAGS INTO MASTER'S HISTORY (2026-09-04)<br>*(17 lines, orig 11296–11312)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **11296–11312** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE TWO NEW SUBSCRIBERS PAID FOR THREE FINDINGS (2026-09-09)<br>*(133 lines, orig 11313–11445)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **11313–11445** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### ANDROID 16 IGNORES `overlaysWebView: false`, AND EIGHTEEN SCREENS DREW UNDER THE STATUS BAR (2026-09-10)<br>*(69 lines, orig 11446–11514)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **11446–11514** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### "FAVORITES IS SPELT WRONG" — IT WAS, AND FIVE MORE WERE (2026-09-10)<br>*(45 lines, orig 11515–11559)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **11515–11559** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE STAND-DOWN LOG FLOODED THE WINDOW SOMEBODY READS AT 08:00 (2026-09-16)<br>*(75 lines, orig 11560–11634)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **11560–11634** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE KEEP-WARM DIED SILENTLY AND THE LOCK OUTLIVED IT BY EIGHT MINUTES (2026-09-16)<br>*(97 lines, orig 11635–11731)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **11635–11731** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE RAMPS STOPPED BEFORE THE CURE DID, AND THE RENEWAL NEVER REACHES OKTA (2026-09-17)<br>*(1143 lines, orig 11732–12874)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **11732–12874** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **6 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE 08:00 FAST LANE HAS NEVER ONCE BEEN OBSERVED RUNNING (2026-09-17)<br>*(127 lines, orig 12875–13001)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **12875–13001** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### "RECONNECT AUTO-CART FOR REC.GOV" WAS ONE HIDDEN INPUT, AND THE LOOP WAS CLOSED (2026-09-18)<br>*(127 lines, orig 13002–13128)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **13002–13128** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### A HANG MAKES EVERY ASSERTION IN ITS FILE SILENT, WHATEVER THE ORDER (2026-09-20)<br>*(37 lines, orig 13129–13165)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13129–13165** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### A BETA TESTER'S "MANAGE BILLING" COULD NEVER WORK, ON BOTH SURFACES (#380, 2026-09-20)<br>*(51 lines, orig 13166–13216)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13166–13216** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### GOOGLE CLOUD CANNOT CHARGE US, AND THE HEALTH ROUTE HAD SAID SO ALL ALONG (2026-09-16, folded 2026-09-20)<br>*(52 lines, orig 13217–13268)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13217–13268** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| #### 2026-09-20 (evening) — THE OTHER SESSION DOES NOT HOLD THE APPLE REJECTION<br>*(27 lines, orig 13271–13297)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13271–13297** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| #### 2026-09-20 (evening) — A CHILD CANNOT PUSH, THE FIX WORKS (+2 sub-blocks)<br>*(100 lines, orig 13298–13397)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13298–13397** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| #### 2026-09-20 — ONE SESSION CAN DISPATCH ANOTHER (+2 sub-blocks)<br>*(120 lines, orig 13398–13517)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13398–13517** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| #### 2026-09-20 — CLAUDE HAS HANDS ON THE SITE NOW (+1 sub-block)<br>*(62 lines, orig 13518–13579)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13518–13579** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| #### 2026-09-18 — THE rec.gov RECONNECT IS FIXED, MERGED, AND LIVE (+1 sub-block)<br>*(60 lines, orig 13580–13639)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **13580–13639** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| #### 2026-09-18 — THE DELIVERY CANARY HAS BEEN QUIET (+1 sub-block)<br>*(36 lines, orig 13640–13675)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13640–13675** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| #### 2026-09-17 — THE CART BURST RECORDS ITSELF NOW<br>*(26 lines, orig 13676–13701)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **13676–13701** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| #### THE CAPTCHA BLOCK IS OVER — DO NOT ACT ON IT<br>*(9 lines, orig 13702–13710)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **13702–13710** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| #### STATE, READ RATHER THAN REMEMBERED (2026-09-17 17:46 UTC)<br>*(14 lines, orig 13711–13724)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13711–13724** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| #### A CANCELLED CI TWIN LEAVES A FIXTURE ROW<br>*(17 lines, orig 13725–13741)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13725–13741** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| #### AND I BROKE THE LANES RULE WHILE ENFORCING IT — AGAIN<br>*(8 lines, orig 13742–13749)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13742–13749** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| #### STILL OPEN, UNCHANGED<br>*(14 lines, orig 13750–13763)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13750–13763** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| #### THE BOX'S `wedge-recycle` EVENT IS NEARLY EMPTY (+tail-log/drought/Monitor)<br>*(169 lines, orig 13764–13932)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **13764–13932** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE CANCELLATION BADGE MISSES THE ONLY CANCELLING SUBSCRIBER (2026-09-16)<br>*(37 lines, orig 13933–13969)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **13933–13969** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE COMMIT RESIDUAL: THE PAGEFILE TRACKS (+option B/bail arm/real lever)<br>*(187 lines, orig 13970–14156)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **13970–14156** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| #### ~~`exec_select` SILENTLY RETURNS A SCALAR~~ — IT IS THE ALIAS `t`<br>*(51 lines, orig 14157–14207)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **14157–14207** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. **3 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| [BLOCKQUOTED HANDOVERS] 2026-09-11 down to 2026-09-01 — 34 dated handover blocks<br>*(1655 lines, orig 14208–15862)* | `docs/ARCHIVE-OPEN-BLOCKS.md` | MOVED | Original lines **14208–15862** reproduce **verbatim** in `docs/ARCHIVE-OPEN-BLOCKS.md`; the reassembly proof above covers them. **32 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE APP'S RC SESSION IS BEING MEASURED NOW — no renewal built yet (migration 058, 2026-08-13)<br>*(89 lines, orig 15863–15951)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **15863–15951** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### "What counts as a match" DID NOT COUNT FOR ANYTHING (2026-08-15)<br>*(31 lines, orig 15952–15982)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **15952–15982** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### MUTING IS ON THE NEW WATCH SCREEN NOW, AND IT IS ONE COMPONENT (2026-08-15)<br>*(61 lines, orig 15983–16043)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **15983–16043** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### ONE WATCH CAN COVER A WHOLE PARK (migration 070, 2026-08-15) — DORMANT UNTIL SOMEONE MAKES ONE<br>*(82 lines, orig 16044–16125)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **16044–16125** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. **4 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE UI ROUND, 2026-08-15 evening — all three found by USING the app<br>*(27 lines, orig 16126–16152)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **16126–16152** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### FILTERS: TWO WERE UNUSABLE ON THE DATA (2026-08-15)<br>*(24 lines, orig 16153–16176)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **16153–16176** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### `npm run verify` GATES ON jsx-spacing NOW (2026-08-15)<br>*(17 lines, orig 16177–16193)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **16177–16193** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE 08:00 HAND-OFF WORKED END TO END (2026-08-16) — and the alarm that fired was ours<br>*(49 lines, orig 16194–16242)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **16194–16242** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### A TypeError PUBLISHED A USER'S PASSWORD (2026-08-16) — ~~and the feature is REVERTED~~<br>*(57 lines, orig 16243–16299)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **16243–16299** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **4 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### "ALREADY SIGNED IN" IS NOT "COVERED" — the 08:00 cart lost to a one-line short-circuit (2026-08-15)<br>*(81 lines, orig 16300–16380)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **16300–16380** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### `npm test` TOLD THE PRODUCTION BOT TO CART A REAL CAMPSITE (2026-08-15)<br>*(46 lines, orig 16381–16426)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **16381–16426** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE FORCED KEEPALIVE SAMPLE NEVER RAN, AND THE BOX HAD BEEN ON STALE CODE FOR FOUR HOURS (2026-08-15)<br>*(63 lines, orig 16427–16489)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **16427–16489** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### `query()` CANNOT WRITE — the routing bug class (2026-08-11)<br>*(20 lines, orig 16490–16509)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **16490–16509** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### The control channel rides the ROSTER feed (migration 055, 2026-08-11)<br>*(30 lines, orig 16510–16539)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **16510–16539** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### The nightly RC login rehearsal (migration 054, 2026-08-11)<br>*(28 lines, orig 16540–16567)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **16540–16567** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE RENEWAL RUNS ON THE BOX — CONFIRMED 2026-08-16 01:53 UTC<br>*(41 lines, orig 16568–16608)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **16568–16608** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE LOGIN REHEARSAL PASSED — FOR THE FIRST TIME IN ITS LIFE (2026-08-16 03:00 UTC)<br>*(25 lines, orig 16609–16633)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **16609–16633** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE LOGIN REHEARSAL HAS NEVER PASSED, AND IT DID NOT FIRE ON 08-12<br>*(45 lines, orig 16634–16678)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **16634–16678** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE RENEWAL QUESTION IS ANSWERED (2026-08-15 evening) — and the answer is "stop renewing"<br>*(47 lines, orig 16679–16725)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **16679–16725** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### WHY THE RELOAD FAILED: A PLAIN LOAD IS NOT THE BOOTSTRAP — THE CLICK IS (2026-08-15, later)<br>*(81 lines, orig 16726–16806)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **16726–16806** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE RENEWAL WAS MEASURING ITSELF (2026-08-12) — the keep-warm question is REOPENED<br>*(75 lines, orig 16807–16881)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **16807–16881** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### Never offer a hold when there is no bot to honour it (2026-08-11)<br>*(12 lines, orig 16882–16893)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **16882–16893** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### MUTING A SITE DID NOTHING TO ITS COMING-SOON ALERTS (2026-08-13)<br>*(25 lines, orig 16894–16918)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **16894–16918** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### Auto-cart alerts lost the site id and the kind (2026-08-11)<br>*(19 lines, orig 16919–16937)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **16919–16937** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### "The auto-login has had its turn" was said 15 minutes early (2026-08-12)<br>*(21 lines, orig 16938–16958)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **16938–16958** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### Health severity — two false alarms that would have paged all night (2026-08-11)<br>*(16 lines, orig 16959–16974)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **16959–16974** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### Diagnostics that fail invisibly — three from one evening (2026-08-11)<br>*(30 lines, orig 16975–17004)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **16975–17004** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### `update.bat` reported the wrong commit, and node still crashes on the way out<br>*(16 lines, orig 17005–17020)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17005–17020** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### `autocart.bot_version` — does the box run the code master has? (migration 056, 2026-08-12)<br>*(77 lines, orig 17021–17097)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17021–17097** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE ON-DEMAND UPDATE DEADLOCKED ITSELF (2026-08-12) — read before pressing "Update now"<br>*(54 lines, orig 17098–17151)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17098–17151** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE ON-DEMAND UPDATE WROTE NO LOG AT ALL, AND NEITHER DID ITS SPAWNER (2026-08-14)<br>*(29 lines, orig 17152–17180)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17152–17180** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### `tail-log` RETURNED THE NEWEST LINES AS MOJIBAKE, EVERY TIME (2026-08-14)<br>*(21 lines, orig 17181–17201)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17181–17201** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### `rc-login.bat`'s KILL HAD NEVER RUN — `\"` IS NOT A CMD ESCAPE (2026-08-14)<br>*(37 lines, orig 17202–17238)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17202–17238** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### `restart-rc` RELAUNCHED THE RC PAIR AS BARE `node` REPLs (2026-08-14)<br>*(32 lines, orig 17239–17270)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17239–17270** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE RUNNER HEARTBEAT WAS KEPT GREEN BY THE UPDATER (2026-08-14)<br>*(25 lines, orig 17271–17295)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17271–17295** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### RC WENT BLANK IN THE BOT'S BROWSER, AND IT WAS THE CHROMIUM PROFILE (2026-08-14)<br>*(43 lines, orig 17296–17338)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **17296–17338** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE STOP SCRIPTS COULD NEVER KILL CHROME'S CHILD PROCESSES (2026-08-14)<br>*(22 lines, orig 17339–17360)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17339–17360** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE WATCHDOG ASKED "IS ANYTHING RUNNING?" — RESTARTS THE BOTS, NEVER THE PC<br>*(31 lines, orig 17361–17391)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17361–17391** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### A Chromium ate 41 GB of COMMIT, and nothing could kill it remotely (2026-08-12)<br>*(38 lines, orig 17392–17429)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **17392–17429** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE CHROMIUM LEAK IS RECORDED NOW, BECAUSE IT CANNOT BE CAUGHT BY HAND (migration 059, 2026-08-14)<br>*(187 lines, orig 17430–17616)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **17430–17616** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THREE DIAGNOSTICS LIED AT ONCE, AND THE HEARTBEAT WAS RIGHT (2026-08-12)<br>*(14 lines, orig 17617–17630)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17617–17630** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### Front-of-flow: sign in to RC BEFORE the release (2026-08-12)<br>*(26 lines, orig 17631–17656)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17631–17656** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **1 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE RELEASED SCREEN HAD NO SIGN-IN STEP — FIXED 2026-08-13 evening<br>*(36 lines, orig 17657–17692)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17657–17692** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### DON'T THROW A REVISITING USER INTO RC (2026-08-13 evening)<br>*(12 lines, orig 17693–17704)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17693–17704** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE CART POSTS NEVER FIRE — AND IT IS NOT THE TOKEN (2026-08-13; FIXED AND PROVEN THE SAME DAY — see the sub-section two below)<br>*(98 lines, orig 17705–17802)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17705–17802** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### RESERVECALIFORNIA CAPS THE BOT'S CART AT 2 (2026-08-13)<br>*(167 lines, orig 17803–17969)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17803–17969** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### THE HAND-OFF UI OVERHAUL, AND TWO BUGS IN THE INSTRUMENT (2026-08-13 evening)<br>*(98 lines, orig 17970–18067)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **17970–18067** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### Stripe is constructed lazily, in ONE place (2026-08-12)<br>*(20 lines, orig 18068–18087)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **18068–18087** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### The box ran out of COMMIT, and both diagnostics looked the other way (2026-08-12)<br>*(29 lines, orig 18088–18116)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **18088–18116** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### `--once` asserted the one thing it never checked (2026-08-12)<br>*(11 lines, orig 18117–18127)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **18117–18127** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### Retry a DB call only when it never left (2026-08-12)<br>*(11 lines, orig 18128–18138)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **18128–18138** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### Supabase's "CRITICAL" RLS email was a false positive (2026-08-11)<br>*(6 lines, orig 18139–18144)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **18139–18144** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### The first 8am hold FAILED — and the recovery worked (2026-08-07)<br>*(60 lines, orig 18145–18204)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **18145–18204** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### 2026-08-10 08:00 MISSED — a WEDGED keep-warm held the Chromium profile<br>*(27 lines, orig 18205–18231)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **18205–18231** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### THE MINI-PC SUPERVISES AND UPDATES ITSELF NOW (2026-08-10) — needs ONE last update.bat<br>*(68 lines, orig 18232–18299)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **18232–18299** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### The rec.gov auto-relogin never retried — a log line that lied (2026-08-11)<br>*(34 lines, orig 18300–18333)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **18300–18333** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### PowerShell scripts must be pure ASCII (2026-08-11)<br>*(17 lines, orig 18334–18350)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **18334–18350** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### The auto-login lead is T−30 now, and "covered" is DERIVED (2026-08-11)<br>*(29 lines, orig 18351–18379)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **18351–18379** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### UNATTENDED LOGIN WORKS — first clean production run, 2026-08-10 18:35Z<br>*(10 lines, orig 18380–18389)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **18380–18389** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### `update.bat` ENDS the RC session — update FIRST, log in AFTER (2026-08-10)<br>*(8 lines, orig 18390–18397)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **18390–18397** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### Twilio A2P ticket #28871693 — ANSWERED 2026-08-11, and the answer is DON'T EDIT<br>*(154 lines, orig 18398–18551)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **18398–18551** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### The 8am flow could never have worked — the cart fired BEFORE the release (2026-08-08)<br>*(18 lines, orig 18552–18569)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **18552–18569** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. |
| ### The RC keep-warm was never renewing anything (2026-08-08)<br>*(166 lines, orig 18570–18735)* | `docs/CHROMIUM-LEAK.md` | MOVED | Original lines **18570–18735** reproduce **verbatim** in `docs/CHROMIUM-LEAK.md`; the reassembly proof above covers them. |
| ### A dead RC session is NOT "alerting is broken" (2026-08-08)<br>*(9 lines, orig 18736–18744)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **18736–18744** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### If a hold is queued: did the 8am cart fire? (the daily check)<br>*(286 lines, orig 18745–19030)* | `docs/ARCHIVE-RC-AUTOCART.md` | MOVED | Original lines **18745–19030** reproduce **verbatim** in `docs/ARCHIVE-RC-AUTOCART.md`; the reassembly proof above covers them. **6 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### iOS 1.0 WAS REJECTED 2026-08-14 — GUIDELINE 2.1, AND THE REVIEWER NEVER GOT IN<br>*(43 lines, orig 19031–19073)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **19031–19073** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### iOS 1.0 was SUBMITTED — the queue, for the record (2026-08-08)<br>*(47 lines, orig 19074–19120)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **19074–19120** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### iOS 1.0 (5) REJECTED 2026-08-19 — GUIDELINE 3.1.1, and 3.1.3(b) WAS NEVER THE DEFENCE<br>*(38 lines, orig 19121–19158)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **19121–19158** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### THE 3.1.1 FIX WAS LIVE AND THE REVIEWER COULD NOT SEE IT (2026-08-22)<br>*(532 lines, orig 19159–19690)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **19159–19690** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### A WEB DEPLOY CANNOT ADD PURCHASE CAPABILITY — folded in 2026-08-30, written 08-24<br>*(26 lines, orig 19691–19716)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **19691–19716** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE SIDE LANE'S NOTES ARE REFERENCED BY NOTHING — read them before trusting this file<br>*(11 lines, orig 19717–19727)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **19717–19727** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### PLAY IN-APP PURCHASE WORKS — a real purchase, read back out of RevenueCat (2026-08-30)<br>*(70 lines, orig 19728–19797)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **19728–19797** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### THE REVENUECAT WEBHOOK HAS 401'd EVERY EVENT IT HAS EVER RECEIVED (2026-09-14)<br>*(159 lines, orig 19798–19956)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **19798–19956** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### APPLE IAP WAS DECIDED ON 2026-08-24, AND THIS FILE DID NOT CARRY IT FOR SIX DAYS<br>*(97 lines, orig 19957–20053)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **19957–20053** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. **8 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### DO THIS THE MOMENT THE APP IS LIVE<br>*(24 lines, orig 20054–20077)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **20054–20077** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### Play REJECTED 2026-08-03 — Misleading Claims, missing government source links<br>*(23 lines, orig 20078–20100)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **20078–20100** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### Play target API 36 — Capacitor 8 BUILT AND ON TESTFLIGHT (build 8, 2026-08-08)<br>*(51 lines, orig 20101–20151)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **20101–20151** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ### ANDROID DEVELOPER VERIFICATION — REGISTERED, 3 KEYS, ALL VERIFIED (confirmed 2026-09-16)<br>*(87 lines, orig 20152–20238)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **20152–20238** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### Mobile app — everything below needs `npm install && npx cap sync` + a REBUILD<br>*(8 lines, orig 20239–20246)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **20239–20246** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### Verified since / still unverified<br>*(36 lines, orig 20247–20282)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **20247–20282** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### Known, not urgent<br>*(38 lines, orig 20283–20320)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **20283–20320** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |
| ### TEN THINGS THAT LIVED ONLY IN THE HANDOVER (folded 2026-09-10)<br>*(95 lines, orig 20321–20415)* | `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md` | MOVED | Original lines **20321–20415** reproduce **verbatim** in `docs/ARCHIVE-PRODUCT-AND-PLATFORM.md`; the reassembly proof above covers them. |

## Kept in place — 4 ranges, verbatim in the new `CLAUDE.md`

| block (heading + line count) | destination | classification | evidence |
|---|---|---|---|
| [HEAD] orientation map + product sections (front-end rewrite, SEO, Roadmap A-E, Feature E, /api/rc-proxy batch, Auto-Cart tier, RC reCAPTCHA)<br>*(245 lines, orig 1–245)* | `CLAUDE.md` | KEPT IN PLACE | Present **verbatim** in the new `CLAUDE.md` (verified line-for-line). |
| [HEAD] alerting/claim, SMS delivery+domain+segment, expired watches, admin colour, egress watchdog, rec.gov 429s, Empty!=booked, typecheck, scheduler, catalog syncs, sharding, tests, resilience, Deploy<br>*(477 lines, orig 415–891)* | `CLAUDE.md` | KEPT IN PLACE | Present **verbatim** in the new `CLAUDE.md` (verified line-for-line). |
| [PREAMBLE] ## Web-session gotchas (this environment) — universal environment traps, kept VERBATIM<br>*(241 lines, orig 892–1132)* | `CLAUDE.md` | KEPT IN PLACE | Present **verbatim** in the new `CLAUDE.md` (verified line-for-line). **2 strike-through line(s)** moved WITH the text that corrects them (block moved whole, correction never severed). |
| ## Open / next session (heading retained; contents rewritten)<br>*(2 lines, orig 13269–13270)* | `CLAUDE.md` | KEPT IN PLACE | Present **verbatim** in the new `CLAUDE.md` (verified line-for-line). |
