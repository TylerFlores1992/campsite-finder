---
name: rc-status
description: Answer "is the RC 8am auto-cart flow healthy, and will tomorrow's hold cart?" Runs the health endpoint and the hold readout, then applies the reading rules that decide what each state actually means. Use when asked about RC holds, the mini-PC, the auto-cart bot, whether a queued hold will fire, or before/after an 08:00 PT release.
---

# RC status — the daily check

Two Routines already cover the scheduled cases (07:40 PT pre-flight, 08:15 PT outcome).
This is for the ad-hoc question, and its real job is the **reading rules**: nearly every
wrong call in this system's history came from misreading a state that *looks* alarming and
isn't, or one that looks fine and isn't. Getting those backwards at 07:50 is expensive.

## Run both, in this order

```bash
NODE_USE_ENV_PROXY=1 curl -s https://camphawk.app/api/health/status \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f\"{c['level'].upper():5} {c['name']:24} {c['detail'][:160]}\") for c in d['checks'] if c['name'].startswith('autocart.') or c['level']!='ok']; print('overall:', d['status'])"
```

```bash
NODE_USE_ENV_PROXY=1 npx tsx scripts/rc-holds-readout.mts
```

The endpoint is deliberately enough on its own — it needs no repo and no DB, which is why
the pre-flight Routine uses it. The readout adds the per-hold detail.

## Reading the holds table

| status | means | is it a fault? |
| --- | --- | --- |
| `offered` | nobody tapped it | **No.** Not a fault. Say so plainly. |
| `requested`, release still ahead | queued and waiting | No — this is the normal overnight state |
| `requested`, **release time already past** | **the one broken state** | **Yes.** See below |
| `carted` / `claiming` / `released` / `claimed` | it worked | No — say which, and how far it got |
| `failed` | attempted and refused | Yes, but it is recorded; read the note |

**`requested` with the release past is the only genuinely broken state.** Read
`last_attempt_note`, which the readout prints per row. Two different faults hide there and
they need different fixes:

- *"the runner TRIED 3m ago — RC session is dead"* → the runner is alive; the session is the
  problem.
- *"NOTHING has tried to act on this hold at all"* → the runner never picked it up. Before
  2026-08-08 these two were the same silence.

Neither is fixable from a web session — the bot is on the owner's mini-PC. Ask them to run
`mini-pc\rc-check.bat`, or `mini-pc\rc-login.bat` if the session is the problem.

**TWO ROWS FOR ONE UNIT AT ONE RELEASE IS THE FAIRNESS LINE, NOT A DUPLICATE.** Several
users can watch the same park, so one campsite can be offered to more than one of them.
Since #201 `dueHolds` serves ONE live hold per (release, unit): the winner carts and the
rival's row stays `requested` and uncarted. **That is the line working** — and it looks
exactly like the broken state above, so read `last_attempt_note` before calling it a fault.
Before #201 the de-dupe was per QUERY and both rivals were served 14 seconds apart, so two
people were told the same site was held.

**THE ALERT NAMES THE NIGHTS, NOT THE CHECKOUT DATE.** `end_date` is exclusive, so a watch
for Sep 4 → Sep 6 is two nights and the text reads `Sep 4-5`. A user reporting *"I don't
have a watch for those dates"* is almost always this. Check `nights` and `arrival_date` on
the row — a 4→6 watch stores `arrival_date 2026-09-04, nights 2` — before treating it as a
bug. Reported and investigated 2026-08-27; nothing was wrong.

**A WATCH CREATED BEFORE MIGRATION 070 COVERS LESS OF A PARK THAN ITS NAME SUGGESTS.** Park
watches expand through `watch_campgrounds`; an older watch has no rows there and so covers
its single division only. That is why one Morro Bay watch can get an offer while another
with a wider date range gets nothing — the site was in the division the second one does not
watch. Nothing on the watches screen distinguishes them.

## Reading the health checks — where people get it wrong

**A stale session verdict is not a dead one, and only `dead` matters near a release.**
The access token lives ~1 hour, so the session is *legitimately dead most of the day* and
`maybeAutoLogin` signs in unattended at T−30. The two faults are different:

- `dead` — the keep-warm is alive and reporting honestly. **The repair is scheduled.** This
  only fails within `RC_SESSION_CRITICAL_MIN` of the release.
- `stale` — the keep-warm is not reporting at all, and `maybeAutoLogin` lives *inside* it,
  so the repair is **absent** rather than pending. This fails on any hold ahead. That is
  2026-08-10, where a wedged keep-warm sat amber for ten hours and the 08:00 cart failed.

**Do not tell anyone to sign in by hand just because the session reads dead.** On 2026-08-09
that advice was given over a session that carted a site fifteen minutes later. The manual
instruction is only right once the auto-login has had its turn and the session is *still*
dead.

**`autocart.bot` being green says nothing about RC.** That is the rec.gov bot — a different
process. It stayed green through both the 08-07 and 08-11 RC outages. Read
`autocart.rc_runner` and `autocart.rc_session` separately; they are different failures.

**`autocart.bot_version` warn is usually not a problem.** Drift is normal for part of every
day: Vercel deploys on push, the box waits for a quiet window (02:00–05:00 PT) or a human.
Only a `fail` — missing bot-side code *with* a hold queued — is worth acting on.

**Auto-cart checks never page** (`pages: false`), so `overall: degraded` from these alone is
not an alerting outage. Alerting runs on Fly and is independent.

## Answering

Say what will happen at the next release and what, if anything, a human must do. If nothing
is wrong, say that in one line — a queued hold with a live runner and a scheduled repair is
a healthy system, and padding it with caveats is how the real warnings get skimmed.
