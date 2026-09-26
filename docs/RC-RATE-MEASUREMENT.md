# Measuring RC's per-IP burst headroom — the protocol

*Written 2026-09-25. Tool: `scripts/auto-cart-bot/rc-rate-probe.mjs`.*

## Why, and the one thing to understand first

The cart burst is capped at `BURST_BUDGET` (40 attempts across a release group). **That number
is ours, chosen cautiously — RC has never shown us a limit.** No burst on record (109 holds,
9 `cart-burst` rows) has drawn a 403 or 429. Before raising the budget we want one honest
reading of where RC's edge actually pushes back.

**The reading can only come from a throwaway connection**, because the address that matters —
the mini-PC's household line — is the one we cannot afford to get blocked. It holds the live
Okta session, and it ate a 12-hour CloudFront 403 once (2026-08-06). So the probe runs from a
**different, expendable** connection, and the result transfers to the household IP only
partially. Be honest about that:

- The probe hits `rdapi.reservecalifornia.com`'s precart URLs **unauthenticated**. Those
  `401` at the application tier but still cross the **CloudFront edge**, where a per-IP rate
  rule counts every request whatever its path or auth. So this measures the **edge**, not RC's
  logged-in booking-tier limits.
- A **PASS** is necessary but **not sufficient** for the household IP: a different IP does not
  carry the household line's history, and a mobile-carrier IP may be metered more leniently.
- A **FAIL** (a 403/429/5xx below this pattern) **does** prove a limit exists there.
- If the 2026-08-06 block was caused by the **login** pattern rather than request **rate**, no
  rate measurement addresses it — the probe never signs in and never sends a token, by design.

## Before you touch it

- **Free evidence you already have.** Production bursts have sent ~90-170 POSTs in ~14s from
  the household IP (09-23, 09-25) with zero pushback. Concurrency 6 at budget 40 does **not**
  change the per-5-minute total a rate rule counts; it only raises the peak from ~7-15 to
  ~11-22 req/s. So at today's volume (≤3 holds/release) the budget is not the binding
  constraint — this measurement is for planning a *higher* budget, not for shipping
  concurrency 6.
- **At current volume you may not need this at all.** Consider running it only once releases
  actually carry 5+ holds.

## The connection

Use the **second mini-PC** on a connection whose loss for 12-24h is acceptable:

- **Best:** a dedicated prepaid-SIM hotspot.
- **NOT your own phone** — mobile carriers share one IP across many customers, so a block hits
  strangers and a "pass" may be someone else's good reputation.
- **NOT** the household line, **NOT** this cloud sandbox (shared proxy IP, and the only place
  the release-window instrument runs), **NOT** Fly, **NOT** Vercel.
- **Never sign in to RC from the probe IP.** A new-device Okta login is the leading 08-06
  suspect. The probe sends no token and touches no cookie; keep it that way.

## The protocol

One step per sitting. Steps at least 30 minutes apart. Never within 2h of an 08:00 PT release
(the tool refuses inside 2h and if it can't read the public IP).

```
node scripts/auto-cart-bot/rc-rate-probe.mjs --selftest        # offline; proves the classifier
node scripts/auto-cart-bot/rc-rate-probe.mjs --dry-run --step=1 # prints what it would send; sends nothing
node scripts/auto-cart-bot/rc-rate-probe.mjs --step=1 --i-understand   # budget 40 pattern (~92 POSTs / ~8.5s)
# wait ≥30 min, only if step 1 was clean:
node scripts/auto-cart-bot/rc-rate-probe.mjs --step=2 --i-understand   # budget 50
node scripts/auto-cart-bot/rc-rate-probe.mjs --step=3 --i-understand   # budget 60 (the guard's cap)
```

Each step mirrors the real burst: 6 workers, each doing a load POST + a submit POST, a 500ms
gap, repeated until the step's attempt count is spent. **No open-ended ramp.**

## Stop conditions (the tool enforces all of these and exits non-zero)

- Any response other than a clean `401`: a 403, 429, 5xx, or status 0 (connection reset).
- A CloudFront edge-error marker in the headers (`x-cache: Error from cloudfront`) — even on
  a 401.
- Median latency doubling versus the first few requests.
- The public IP changing mid-run (the reading is discarded).

On a stop it captures the status and the `server`, `via`, `x-cache`, `x-amz-cf-pop`,
`x-amz-cf-id`, `age`, `retry-after` headers plus the first 300 bytes of the body. **Re-check
the same IP once at +1h and once at +12h** before concluding it is blocked long-term.

## What a result justifies

- **All three steps clean:** budget 50 with reserve 25 at 6 slots is defensible (the burst
  guards already pass at those values). Go past 50 only after a clean *production* morning at
  50.
- **Any step fails:** a limit exists at or below that pattern. Do **not** raise `BURST_BUDGET`.
  A different-IP fail is a strong signal the household IP would fail the same way; a
  different-IP *pass* is not proof the household IP is safe.

## The cheaper alternative that risks nothing

Roughly a third of burst POSTs are avoidable: the runner fires a **second** cart submit on
every refusal at a unit with extras (`rc-cart.mjs`). Skipping that fallback submit when RC
answers "not available" would cut burst POSTs with zero IP risk — and buys headroom without a
measurement. Worth doing regardless of what the probe finds. (Out of scope for the
concurrency-6 change; a separate, safe follow-up.)
