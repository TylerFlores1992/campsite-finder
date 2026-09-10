# Next session — start here

*Rewritten from scratch **2026-09-10** (main lane). It had reached 1,603 lines of stacked dated
blocks, which is the opposite of a handover.*

**This is a HANDOVER, not a permanent doc. `CLAUDE.md` owns every finding.** Nothing here is the
only copy of anything — the eight items that were, got folded into `CLAUDE.md` before this rewrite
(see "EIGHT THINGS THAT LIVED ONLY IN THE HANDOVER"). **Keep it this way: when a block here goes
stale, delete it rather than striking it through.** Strikethrough belongs in `CLAUDE.md`, where the
correction is itself the record; here it is just weight.

---

## 0. Ground yourself — four commands, in this order

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

## 1. State — 2026-09-10 05:00 PT

| | |
|---|---|
| master | `52d6e74` (#319) — **verify against `origin/master`, this line ages** |
| mini-PC | `52d6e74`, i.e. box and web agree (read from `git-status`) |
| health | **18 of 19 ok**, one documented-benign warn |
| fleet | 3/3 shards held, heartbeat 1s, 12 watches, capacity 8/12 |
| holds | **none live**, so the 02:00-05:00 PT update window is open |
| migrations | highest `076`; **main's block `077-079`, side lane `080+`** |

**The one warn is `autocart.rc_session`, and it is the ORDINARY between-releases state.** The RC
token lives ~1h and `maybeAutoLogin` restores it at T−30 of a real release. **Do not act on it, and
above all do not run `rc-login.bat`** — that force-kills the Chromium the token lives in. This
exact reading has sent people to the box twice over sessions that repaired themselves.

---

## 2. The leak — where it actually stands

**Nothing is assigned. There is one lead and it needs your word before it is taken.**

**ESTABLISHED, and none of it needs re-deriving:**

- The ramping renderer maps **~16,384 regions of 2 MiB = 32 GiB exactly**, one allocation base
  each, all anonymous, all READWRITE, pagefile-backed and largely untouched. Nine walks: the top
  cluster lands within **0.02% of 16,384** and the three lower readings are consistent with
  catching a fill in progress. So it is a **ceiling**, not a runaway — "what has a 32 GiB budget?"
  is a sharper question than "what leaks?".
- Its **main thread spins at 100% of a core** while a control renderer in the same scan burns 0 ms
  — which is why three instruments on three different CDP calls all got silence. CDP is serviced
  on that thread.
- **VMSTACK put the loop in native code**, 42 of 48 samples inside `chrome.dll`, so RC's own
  JavaScript is not the loop and there is no fix on our side of the page.
- The **RAM arm has not fired since August** — 15+ consecutive ramps, because untouched commit
  never lowers free RAM, so it watches the one resource that is not running out. (It *did* fire,
  three times on 08-18/19, with its own `RUNAWAY` line; "never fired" is wrong and gets quoted.)
  What ends a ramp now is `bail:ramp`, 3-35 s after the scan. Containment is holding at
  **3.4-4.6 GB** against 8-9 GB untreated.

**REFUTED — do not re-run these:**

- **The command buffer / `MappedMemoryManager`.** The GPU-off trial ramped on trial one with the
  identical 32 GiB signature and a GPU process flat at 20 MB. One counterexample refutes; it came
  with the whole walk attached. The 2 MiB match was a coincidence — 2 MiB is a very common
  granularity.
- **Symbols.** The one reachable symbol server 404s our exact key, controlled three ways. Its
  near-neighbours share our TimeDateStamp with a different `SizeOfImage`, so borrowing one would
  name the wrong function confidently.

**THE ONE OPEN LEAD:** match the disassembled fingerprint against Chromium source.
`raw.githubusercontent.com` is reachable (200, controlled), so this needs **no ramp, no box update
and no symbols**. The shape, stated precisely because the shorthand is ambiguous: a linear
search-and-erase over an array of 8-byte pointers; flag byte on the **element** (`elem+0x5c`);
non-zero checks on its **pointee** (`(*elem)+0x10`, `(*elem)+0x1c`); sampled comparison
`**(elem+0x20)` against `*(*elem)`; `rsi` carries two containers (scan reads `+0x24`/`+0x18`, erase
touches `+0x14`/`+0x8`).

**It is deliberately not taken.** It reads a repository outside the session's scope, and this
project's record is three mechanisms guessed with each one costing a session. **Ask before
starting it.**

### Do not do these, each for a recorded reason

- **Do not force a ramp out of impatience.** Odds are 3-in-6, it spends the warm-up's one turn per
  Okta lifetime, and it costs a password submission from an address that has eaten a twelve-hour
  block. Natural ramps arrive every **2.3-18.6 h** (median ~5.4) and every instrument is armed.
- **Do not lower `LOW_RAM_MB`** — that killed a working repair on 08-19.
- **Do not lower `MEM_DUMP_STALL_MS`** — 90 s was measured against 133 tab-closes, and a wedged
  renderer contributes zero allocator dumps anyway, so it would fire more often and learn nothing.
- **Do not build Track B** — the renewal's Okta trip is measured flat at −4 MB.
- **Do not park the resident page** — refused by `checkAndReport`'s localStorage rule, which would
  silence `autocart.rc_session` and the phone alarm.
- **Do not rebuild the heap trail, Track A, the RAM arm, or the dump's ownership graph.** Each is
  blind to this allocation for a reason that was knowable before it was built — `JSHeapUsedSize`
  excludes external memory; the sampling profiler reads 1-74 MB against 8-9 GB; untouched commit
  never lowers free RAM; and a wedged renderer contributes zero allocator dumps at every level.

---

## 3. Other things open — all detail is in `CLAUDE.md`

- **One screenshot outstanding.** The Android 16 safe-area fix is deployed and web-side, but
  `env()` is 0 in headless Chromium and this container cannot reach the live site, so **nothing has
  seen it on a phone.** Open `/claim` or `/privacy` on the Pixel; the CampHawk mark should clear
  the clock. Ten seconds.
- **Apple IAP was decided on 2026-08-24 and is not built.** RevenueCat is already compiled into
  the iOS binary; what remains is console work plus one env var. `docs/STOREKIT-PLAN.md` is the
  authority — **not** `docs/APP-STORE.md` §2c, which still frames it as an open question.
- **Play production release 25 was IN REVIEW as of 2026-09-01 — nine days ago, and nobody in a
  session can read the Play console, so treat that as a date and not as current state.** Ask the
  owner before acting on it. Whenever it lands, the first REAL purchase is what exercises
  webhook → row → entitlement for the first time, carrying two known gaps (HMAC is reported, not
  enforced; out-of-order delivery unhandled). A licence-tester purchase does NOT exercise it —
  `ignoreReason` correctly drops every non-PRODUCTION event, so an absent `subscriptions` row is
  the guard working, not a broken webhook.
- **The release-window Routine self-disables 2026-09-12**, ~2 firings left.
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
- **Two sessions can be the SAME lane** — the branch name does not distinguish them and
  `ListAgents` cannot see a sibling elsewhere. An empty list is not exclusive use of the database.

---

## 5. Traps that have actually fired

- **Never read an exit code through a pipe** — `| tail` reports `tail`'s status and cuts every
  `not ok` line. Two false greens from one command.
- **Read the instrument before reasoning about the code.** The failures here are overwhelmingly
  instruments that were running and unread.
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
- **`sqlit` interpolates, it does not bind**, and throws on a plain object — stringify jsonb.
- **No non-ASCII in `.ps1`**, no `\"` inside a `powershell -Command` string in a `.bat`, no
  backticks in a SQL comment inside a template literal.
