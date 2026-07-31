// rec.gov throttle breaker: half-open probing and cooldown escalation.
//
// This is the state machine that decides whether rec.gov watches get checked at all,
// and its predecessor SHIPPED A LIE — the comment said "one call probes (half-open)
// and a success closes it" while the code reopened the gate for everyone at once. All
// four of the poller's concurrent fetches then hit a still-throttled rec.gov, three
// 429'd, and it slammed shut again: six OPEN/CLOSED cycles in thirteen minutes on
// 2026-07-30, with rec.gov watches unchecked ~40% of the time.
//
// No mocks and no network dependence on rec.gov ANSWERING: a 1ms timeout makes every
// request fail, and `isThrottleError` counts a timeout as a throttle, which is the
// exact code path a 429 storm takes. Break the breaker and watch these fail.
import test from 'node:test';
import assert from 'node:assert/strict';

// Read at module load, so these must be set before the import below.
process.env.RECGOV_TIMEOUT_MS = '1';
process.env.RECGOV_BREAKER_TRIP = '3';
process.env.RECGOV_BREAKER_COOLDOWN_MS = '400';
process.env.RECGOV_BREAKER_MAX_COOLDOWN_MS = '1600';

const { getAvailabilityFromRecGov, recgovBreakerOpen, __recgovBreakerState, __recgovBreakerReset } =
  await import('../src/lib/availability/recgov');

const CG = '232447';
const MONTH = '2026-09';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('rec.gov breaker', async (t) => {
  await t.test('stays closed below the trip count', async () => {
    for (let i = 0; i < 2; i++) await getAvailabilityFromRecGov(CG, MONTH);
    assert.equal(recgovBreakerOpen(), false, 'two throttles must not open it');
    assert.equal(__recgovBreakerState().consecutive, 2);
  });

  await t.test('opens on the third consecutive throttle, at the base cooldown', async () => {
    await getAvailabilityFromRecGov(CG, MONTH);
    assert.equal(recgovBreakerOpen(), true);
    assert.equal(__recgovBreakerState().cooldownMs, 400, 'first open uses the base cooldown');
  });

  await t.test('short-circuits without touching the network while open', async () => {
    const started = Date.now();
    const res = await getAvailabilityFromRecGov(CG, MONTH);
    // A real attempt costs DNS + connect even with a 1ms timeout; a short-circuit is
    // a synchronous return. 20ms separates them by an order of magnitude.
    assert.ok(Date.now() - started < 20, 'open breaker must not make a request');
    assert.deepEqual(res.campsites, [], 'short-circuit returns empty = "unknown"');
  });

  await t.test('in-flight failures that land after it opens do NOT escalate', async () => {
    // The bug this catches shipped and was caught in production the same evening
    // (2026-07-30 23:12:55): the poller's fourth paced fetch had already crossed a
    // closed gate when the first three opened the breaker, so its failure was read as
    // a failed recovery probe and doubled 60s to 120s in the same second. The earlier
    // subtests miss it because their failures are sequential; a real cycle's overlap.
    // Must start CLOSED — with the breaker open every call is denied at the gate,
    // reaches no network, records nothing, and the test proves nothing. (The first
    // version of this test did exactly that and passed against the bug.)
    __recgovBreakerReset();
    assert.equal(recgovBreakerOpen(), false, 'precondition: breaker closed');

    // All five cross the gate synchronously before any await resolves — exactly how
    // the poller's concurrent fetches behave. Three trip it; the last two then record
    // their failures against an already-open breaker.
    await Promise.all(Array.from({ length: 5 }, () => getAvailabilityFromRecGov(CG, MONTH)));

    assert.equal(recgovBreakerOpen(), true, 'five failures must have opened it');
    assert.equal(
      __recgovBreakerState().cooldownMs,
      400,
      'stale in-flight failures must not escalate; only a real probe may'
    );
  });

  await t.test('half-open admits exactly ONE prober, not the whole cycle', async () => {
    // Left OPEN at the base 400ms cooldown by the subtest above.
    assert.equal(__recgovBreakerState().cooldownMs, 400);
    await sleep(450); // cooldown elapsed
    assert.equal(recgovBreakerOpen(), true, 'still nominally open until a probe succeeds');

    // Four concurrent callers, exactly as the poller's rec.gov phase produces.
    let crossed = 0;
    const original = __recgovBreakerState().consecutive;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const started = Date.now();
        await getAvailabilityFromRecGov(CG, MONTH);
        if (Date.now() - started >= 20) crossed++;
      })
    );
    // The prober's failure is the only one that can have been recorded. If the gate had
    // reopened for everyone, consecutive would have jumped by 4 and the cooldown would
    // have escalated more than once.
    assert.ok(crossed <= 1, `at most one caller may cross while half-open, saw ${crossed}`);
    assert.equal(
      __recgovBreakerState().consecutive,
      original + 1,
      'exactly one failure recorded, not one per concurrent caller'
    );
  });

  await t.test('a failed probe doubles the cooldown instead of retrying every 400ms', async () => {
    assert.equal(__recgovBreakerState().cooldownMs, 800, 'one failed probe = one doubling');
    await sleep(850);
    await getAvailabilityFromRecGov(CG, MONTH); // second probe, also fails
    assert.equal(__recgovBreakerState().cooldownMs, 1600);
    await sleep(1650);
    await getAvailabilityFromRecGov(CG, MONTH); // third probe
    assert.equal(__recgovBreakerState().cooldownMs, 1600, 'escalation is capped');
    assert.equal(recgovBreakerOpen(), true);
  });
});
