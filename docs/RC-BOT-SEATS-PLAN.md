# RC hold capacity: more than one bot seat — the plan

*Written 2026-09-25, main lane. Status: **PLAN, nothing built.** Owner asked for it after the
09-25 release, where three holds shared one release on one box.*

## 1. Why — what one box can carry today

A **seat** is one ReserveCalifornia bot account, signed in, on one browser profile, on one
machine with its **own public IP**. (Not "unit": in RC's vocabulary a unit is a campsite, and
`rc_hold_requests.unit_id` already means that.) Today there is exactly one seat: the mini-PC.

| limit | number | source |
|---|---|---|
| holds one seat can carry for one release | **20** | `RC_HOLD_CAPACITY` = `RC_SITES_PER_CART` (2) × `RC_MAX_CARTS` (10), both measured, in `src/lib/limits.ts`. The poller stops offering past it (`roomToHold`, `worker/poller.ts`). |
| holds that get the full fast burst at T | **4** | `CART_CONCURRENCY` (4, `rc-hold-runner.mjs`). `BURST_BUDGET` 40 / `BURST_RELEASE_RESERVE` 25 / `BURST_LEAD_MS` 5s are sized together for exactly 4 slots: `(4 + 15) / 4 × 1.1s` = 5.2s of asking against a 5.0s lead. `worker/cart-burst.test.mts` fails if any one of them moves alone. |
| holds 5..20 | carted later | They wait for one of the first four `pMap` slots to finish. By then the shared pool is mostly spent, so they fall to the ~12s slow lane, and at busy parks sites go in seconds. |

**So the honest capacity is 4 holds per 08:00 release with the best odds, and up to 20 with
decreasing ones.**

## 2. What actually limits it — and why "turn the numbers up" is the wrong answer

1. **Requests per IP.** Every attempt leaves the household IP, and RC's WAF has blocked that
   address for twelve hours (2026-08-06). `BURST_BUDGET` exists to refuse this trade. Raising
   `CART_CONCURRENCY` to 6 also breaks the lead/reserve sizing (3.9s of cover against a 5s
   lead), and a guard fails on it.
2. **Per account.** 20 is RC's cart limit per account, measured.
3. **Sign-in is human.** RC serves a reCAPTCHA (2026-08-07), and this project uses no solver.
   Every seat needs one human sign-in, plus another whenever its session dies. **It died after
   both of the last two box updates** (09-24, 09-25: `okta=GONE`, and a CAPTCHA at the
   rehearsal).

**Capacity is bought with ADDRESSES**, the same lesson as rec.gov (`SHARD_COUNT`): each new
seat brings its own IP, its own 40-attempt budget, its own 4 fast slots and its own 20 holds.
N seats = **4N best-odds holds, 20N total**.

## 3. The design

### 3a. Data — one migration

**Migration 079 is main's LAST number.** This design needs one migration, so it spends it.
**Claim a new main block in `docs/LANES.md` in the same PR**, and never take 080 (side lane).

```sql
-- 079_rc_bot_seats.sql
CREATE TABLE IF NOT EXISTS rc_bot_seats (
  id           text PRIMARY KEY,           -- 'box-1', 'box-2' … human-readable, stable
  token_sha256 text NOT NULL,              -- the seat's own bearer token, hashed; never the token
  enabled      boolean NOT NULL DEFAULT true,  -- the owner's off-switch, read live
  beat_at      timestamptz,                -- the runner's heartbeat for THIS seat
  session_ok   boolean,                    -- NULL = unknown, never "fine"
  session_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT NOW()
);
ALTER TABLE rc_hold_requests ADD COLUMN IF NOT EXISTS seat_id text;   -- NULL = not yet placed
INSERT INTO rc_bot_seats (id, token_sha256) VALUES ('box-1', '<sha256 of AUTOCART_TOKEN>')
  ON CONFLICT DO NOTHING;
UPDATE rc_hold_requests SET seat_id = 'box-1'
 WHERE seat_id IS NULL AND status IN ('requested','carted','claiming');
```

`session_ok` NULL means **we have not looked** and must never render as healthy (shape #1).

### 3b. Placement — where a hold goes, decided once

- **Placed at REQUEST, not at offer.** `requestHold` pins `seat_id` in the **same UPDATE** that
  sets `requested`. If another live hold already exists for the same (release, campsite), it
  goes to **that hold's seat** (see the fairness line below). Otherwise it picks the enabled,
  healthy seat with the fewest live holds for that `release_at`, tie-broken by id. One atomic statement, the same shape as the alerting claim
  and the shard lease, so two taps in the same second cannot both see "room" on one seat.
- **Spread, not fill.** Least-loaded means that with two seats the first eight holds of a
  release land 4 + 4. Each gets a best-odds slot, and the requests split across two IPs.
- **Offer gating becomes per fleet.** `roomToHold` = `load < healthySeats × RC_HOLD_CAPACITY`.
  With zero healthy seats there are no offers. `rcBotUsable` already gates this way for one box.
- **THE FAIRNESS LINE IS THE ONE PLACE A NAIVE SPLIT DOUBLE-CARTS.** "One live hold per
  (release, campsite)" is enforced **inside `dueHolds`**, by
  `SELECT DISTINCT ON (release_at, unit_id)` ordered by `line_rank` (`src/lib/rc-holds.ts`).
  - If each seat's feed simply adds `WHERE seat_id = $me`, the `DISTINCT ON` runs per seat.
    Two users' holds for ONE campsite, placed on two seats, would then **both** be served and
    both carted: the 2026-09-04 double-cart, rebuilt across boxes.
  - **Rule: pick the winner across ALL seats first, then filter the winners to the asking
    seat** (the `DISTINCT ON` in an inner query, `seat_id` in the outer one).
  - **Better still, place every hold for one (release, campsite) on the SAME seat**, so the
    line never spans boxes. That rule outranks least-loaded.
  - A real-DB guard must drive two seats and one campsite and assert exactly one is served.
    Written first (the drafting session nearly wrote "needs no change" here, having not read
    where the rule lives).

### 3c. The feed — each box sees only its own holds

- `GET /api/auto-cart/rc-holds` authenticates by **seat token**. It hashes the bearer, looks up
  `rc_bot_seats`, and serves only rows with that `seat_id` (`dueHolds`, `pendingClaims`, the
  release list).
- **BOTH WIRE SHAPES STAY LIVE**, because Vercel and the box deploy at different times (the
  `/api/rc-proxy` batch lesson). The existing `AUTOCART_TOKEN` keeps working and means
  `box-1`. A box that has not updated sees exactly what it sees today.
- **A claim goes to the seat that holds the cart.** The cart is bound to that seat's SESSION
  (proven 2026-08-06), so only that box can release it. Placement makes this automatic:
  `pendingClaims` filtered by `seat_id`.

### 3d. The singletons that assume one box — each becomes per seat

| table / check | today | becomes |
|---|---|---|
| `rc_runner_heartbeat` (`id = 1`) | one beat | `rc_bot_seats.beat_at` |
| session health (`recordSessionHealth`, `autocart.rc_session`) | one reading | per seat; health prints every seat |
| `rc_login_rehearsal` (`id = 1`) + its log | one rehearsal | per seat (`seat_id` on the log) |
| `bot_update_requests`, `bot_commands`, `bot_task_heartbeat` | one box | keyed by seat; `bot-ask --seat box-2` |
| `autocart.bot_version` | one sha | per seat |

**Order matters: do these BEFORE a second seat exists.** A second box writing into
`id = 1` would make one box's healthy session read as the other's (shape #6), on the check
that decides whether to offer holds at all.

### 3e. Failover — what can be automated, and the line it must not cross

- **Allowed:** a `requested` hold whose seat is disabled, stale (no beat in 10 min) or has a
  dead session, **more than 30 minutes before its release**, is moved to another healthy seat
  with room. One atomic UPDATE, logged as a `bot_events` row.
- **Forbidden: moving anything `carted` or `claiming`.** The cart lives in the old seat's
  session, and a second seat carting it would lock the campsite twice. That is the
  double-cart the fairness line exists to prevent.
- **Inside 30 minutes, nothing moves.** The seat is mid-sign-in or mid-burst, and a move would
  race it. Stale is reported, not acted on.

### 3f. The capacity gauge — adding a seat becomes a reading, not vigilance

A new `autocart.rc_capacity` in `/api/health/status`, modelled on `poller.capacity`:
- For each release in the next 36h: `load` against `healthySeats`.
- **warn** when `load > 4 × healthySeats`. Past best odds, the extra holds get the slow lane.
- **fail** when `load >= 20 × healthySeats`. Offers have stopped, so users are being turned away.
- Prints every seat by name with its health, so one sick seat among three is visible.

The status must say which case it is. Everything over 4 still works, just less well, and a
gauge that goes red for that would be crying wolf.

## 4. Adding a seat — what is automatic and what is not

**Automatic once built:** registering the seat (a script inserts the row and prints the token
once), placement, per-seat feed, failover of `requested` holds, the gauge, and per-seat health
and updates.

**Never automatic, by design:**
1. **A second RC account.** It is a real account with its own email, which the owner creates.
2. **A second public IP.** Another machine on another connection (another location, or a
   second ISP line). A VPN or a datacenter proxy puts the bot on an address with worse
   reputation than the household one. A residential proxy service is possible and not
   recommended without a trial.
3. **The first sign-in on that seat**, and every re-sign-in after its session dies (CAPTCHA,
   no solver).

**Target: adding a seat is ~15 minutes of the owner's time**, and one script does the rest:
`mini-pc\add-seat.ps1` installs, saves the password, writes the seat id and token, and
registers the scheduled tasks.

**Check RC's terms before the second account exists.** Holding sites for other people from
several bot accounts is more visible than from one. This is a policy question, not an
engineering one, and it is the owner's.

## 5. Build order — each step shippable alone, and harmless at one seat

| # | step | fires | risk at 1 seat |
|---|---|---|---|
| 1 | Migration 079 + `rc_bot_seats` seeded with `box-1`; backfill `seat_id`. **Claim the next main block in LANES.md.** | nothing | none: nothing reads it yet |
| 2 | `autocart.rc_capacity` gauge (read-only) | web only | none: it only reports |
| 3 | Per-seat singletons (3d), dual-written: `box-1` writes both old and new | worker deploy + box update | low: readers switch after a day of both agreeing |
| 4 | Placement at request + per-fleet `roomToHold` | worker deploy | none: every hold goes to `box-1` |
| 5 | Seat-token feed with the legacy token = `box-1` | web only | none: the box's view is unchanged |
| 6 | Failover of `requested` holds (3e) | worker deploy | none: there is nowhere to move to |
| 7 | `add-seat.ps1` + runbook | box | none until run |
| 8 | **Second seat**: owner creates the account and IP, runs the script, signs in once | — | this is the first time behaviour changes |

**Every step lands away from a release**: `update-guard`'s 6h rule for box steps, and after an
08:00 release for worker steps. **Steps 1-6 must be green and read back in production before
step 8.**

## 6. Tests each step needs (real DB where the correctness lives in SQL)

- **Placement:** least-loaded wins; ties are stable; a disabled or unhealthy seat is never
  chosen; **two concurrent `requestHold`s for the last free slot, only one placed** (the shard
  lease's race test, reused).
- **Feed isolation:** seat A's token never returns seat B's rows; the legacy token returns
  `box-1` only; an unknown token gets 401.
- **Failover:** moves `requested` only; never `carted`/`claiming`; never inside 30 min; never to
  a full or unhealthy seat. **Mutation-test each rule**, with each mutant confirmed applied.
- **The fairness line across two seats:** one campsite, two users, two seats → exactly one
  served by `dueHolds`, whichever seat asks. **This is the test to write first**: it is the
  one bug here that locks a real campsite twice.
- **The gauge:** warn at 4N+1, fail at 20N, and `unknown` session health renders as unknown,
  never as healthy.

## 7. Open decisions — the owner's, not engineering's

1. Where the second IP comes from (another location? a second line?).
2. The second RC account, and a read of RC's terms first.
3. Whether to build steps 1-6 now, while there is one seat, which is the recommendation: the
   plumbing gets proven with nothing at stake. The alternative is to wait for demand.
