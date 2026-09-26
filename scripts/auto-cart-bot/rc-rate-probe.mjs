#!/usr/bin/env node
/*
 * rc-rate-probe.mjs — measure how much RC's edge/WAF lets the cart BURST send, from a
 * THROWAWAY connection, without risking the household IP that holds the live session.
 *
 * WHY THIS EXISTS. The cart burst is capped at BURST_BUDGET (40) attempts across a release
 * group — a number we CHOSE cautiously, not one RC has ever shown us. No burst on record
 * (109 holds) has drawn a 403/429. Before raising it we want one honest reading of where
 * RC's per-IP edge actually pushes back. The catch is that the only address that matters —
 * the mini-PC's household line — is the one we cannot afford to get blocked (it ate a 12h
 * CloudFront 403 once, and it holds the live Okta session). So this runs from a DIFFERENT,
 * expendable connection.
 *
 * WHAT IT MEASURES, AND WHAT IT CANNOT. It sends UNAUTHENTICATED POSTs to the same precart
 * URLs the burst hits (rdapi.reservecalifornia.com). Those 401 at the application tier but
 * still traverse the CloudFront edge, where a per-IP rate rule counts every request whatever
 * its path or auth (general AWS behaviour — NOT measured here). So this reads the EDGE, not
 * RC's logged-in booking-tier limits.
 *   - A PASS is necessary but NOT sufficient for the household IP: a different IP does not
 *     carry the household line's history, and a mobile-carrier IP may be metered differently.
 *   - A FAIL (a 403/429/5xx below this request pattern) DOES prove a limit exists there.
 *   - If the 2026-08-06 block was caused by the LOGIN pattern rather than request rate, no
 *     rate measurement addresses it. This never signs in and never sends a token — by design.
 *
 * IT NEVER: signs in, sends an auth token, touches cookies, or runs an open-ended ramp.
 * It sends ONE step per invocation, hard-stops on the first non-401, and exits.
 *
 * USAGE (on the SECOND mini-PC, on a throwaway connection whose loss for 12-24h is fine):
 *   node rc-rate-probe.mjs --selftest              # offline; sends nothing; checks the classifier
 *   node rc-rate-probe.mjs --dry-run --step=1      # prints exactly what it WOULD send; sends nothing
 *   node rc-rate-probe.mjs --step=1 --i-understand # step 1 (budget 40 pattern): ~92 POSTs over ~8.5s
 *   node rc-rate-probe.mjs --step=2 --i-understand # budget 50 pattern
 *   node rc-rate-probe.mjs --step=3 --i-understand # budget 60 pattern (the guard's cap)
 *
 * See docs/RC-RATE-MEASUREMENT.md for the full protocol, stop conditions, and how to read it.
 */

import { PRECART_LOAD, PRECART_SUBMIT, NO_CART } from './rc-cart.mjs';

// ── the burst shape we are mirroring ────────────────────────────────────────────────────
// Production burst: CART_CONCURRENCY workers, each doing load+submit, a ~500ms gap, until the
// budget is spent. Measured per-hold cycle 1.03-1.41s. We mirror that so the edge sees the
// same request rate a real release produces, not a synthetic hammer.
const WORKERS = 6;              // = CART_CONCURRENCY after the 4→6 change (peak concurrency)
const GAP_MS = 500;            // = BURST_GAP_MS
// attempts per step ≈ budget; each attempt is a load POST + a submit POST.
const STEP_ATTEMPTS = { 1: 46, 2: 56, 3: 66 };  // budgets 40 / 50 / 60 (+ the free first attempts)

// ── stop-condition classifier (pure; covered by --selftest) ─────────────────────────────
// The ONLY acceptable per-request outcome is a clean 401 from the app tier. Anything else —
// a 403/429/5xx, a status 0 (connection reset / TLS / DNS), or a CloudFront edge-error
// marker in the headers — means the edge is unhappy and we STOP immediately.
export function classifyResponse({ status, headers }) {
  // An edge-error marker is a stop whatever the status code carries (a 401 can ride a
  // CloudFront error) — so check it FIRST, before the clean-401 fast path.
  const xcache = String((headers && (headers['x-cache'] || headers['X-Cache'])) || '').toLowerCase();
  if (xcache.includes('error from cloudfront')) {
    return { ok: false, reason: `CloudFront edge error (x-cache: ${xcache})` };
  }
  if (status === 401) return { ok: true, reason: 'app-tier 401 (passed the edge, as expected)' };
  if (status === 0) return { ok: false, reason: 'no HTTP response (connection reset / TLS / DNS)' };
  if (status === 403) return { ok: false, reason: 'HTTP 403 — edge/WAF refused' };
  if (status === 429) return { ok: false, reason: 'HTTP 429 — rate limited' };
  if (status >= 500) return { ok: false, reason: `HTTP ${status} — server/edge error` };
  // A 200/4xx-other is unexpected for an unauthenticated call but is not itself a block.
  // Treat anything that is not a clean 401 as a stop, so we never keep pushing into a
  // response we do not understand.
  return { ok: false, reason: `unexpected HTTP ${status} (not the expected 401) — stopping to be safe` };
}

// Median latency doubling vs the first few requests is also a stop.
export function latencyDoubled(baselineMs, currentMs) {
  return baselineMs > 0 && currentMs >= baselineMs * 2;
}

const HEADERS_TO_CAPTURE = ['server', 'via', 'x-cache', 'x-amz-cf-pop', 'x-amz-cf-id', 'age', 'retry-after'];

function captureHeaders(res) {
  const out = {};
  for (const k of HEADERS_TO_CAPTURE) {
    const v = res.headers.get(k);
    if (v != null) out[k] = v;
  }
  return out;
}

// The production precart body, MINUS the token and any occupant name. The unit/dates are
// syntactically valid placeholders; the app tier 401s before validating them, so they only
// need to parse. NO accesstoken / authorization header is ever set.
function probeBody() {
  return {
    arrivalDate: '2099-01-01', nights: 1, confirmation_number: null, reservationId: 0,
    unitId: 0, IsReservationDrawing: false, accessTypeId: 0, accountPassNumber: null,
    adults: 1, allowSpecialBenefits: false, children: 0, customerClassificationId: 1,
    discountPromoCode: null, dynamicOccupancyByNight: {}, extraValues: [],
    fdUsageClassificationId: 1, fdUsageClassificationName: 'Regular', isCheckIn: false,
    isDiscount: false, isModifyPreCart: false, isOrganization: false,
    occupantName: '', occupantPhoneNumber: null, optionalAuthorizedPerson: null,
    padLength: '0', preCartReservationComments: null, precartComments: null,
    prevSelectedClassification: null, promoCode: null, reservationVehicles: [],
    selectedClassification: null, shoppingCartKey: NO_CART,
    sleepingUnit: null, timeDuration: null, unitPriceType: 1, vehicleCount: 0,
    vehicleLength: '0', vehiclePlates: null, vehicleTypeIds: null, vehicles: [],
  };
}
function probeHeaders() {
  // Deliberately NO accesstoken and NO authorization — this must stay unauthenticated.
  return { 'Content-Type': 'application/json', installationsidentity: 'cali', storeid: '111' };
}

async function publicIp() {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return j.ip || null;
  } catch { return null; }
}

// Refuse to run within 2h of an 08:00 PT release.
function hoursToNext0800PT(now = new Date()) {
  // Compute "now" in America/Los_Angeles wall time.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const h = Number(parts.hour) + Number(parts.minute) / 60;
  // hours until the next 08:00 on the PT clock
  const untilToday = 8 - h;
  return untilToday > 0 ? untilToday : untilToday + 24;
}

async function oneAttempt(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST', headers: probeHeaders(), body: JSON.stringify(probeBody()),
      signal: AbortSignal.timeout(15000),
    });
    // drain the body so the connection is reusable and we can peek at it on a stop.
    const raw = await res.text().catch(() => '');
    return { status: res.status, headers: captureHeaders(res), raw, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, headers: {}, raw: '', ms: Date.now() - t0, netError: String((e && e.message) || e) };
  }
}

function runSelftest() {
  const cases = [
    [{ status: 401, headers: {} }, true],
    [{ status: 403, headers: {} }, false],
    [{ status: 429, headers: {} }, false],
    [{ status: 503, headers: {} }, false],
    [{ status: 0, headers: {} }, false],
    [{ status: 200, headers: { 'x-cache': 'Error from cloudfront' } }, false],
    [{ status: 401, headers: { 'x-cache': 'Error from cloudfront' } }, false], // edge error wins even on a 401
  ];
  let bad = 0;
  for (const [input, want] of cases) {
    const got = classifyResponse(input).ok;
    const pass = got === want;
    if (!pass) bad++;
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${JSON.stringify(input)} -> ok=${got} (want ${want})`);
  }
  const latOk = latencyDoubled(100, 200) === true && latencyDoubled(100, 199) === false && latencyDoubled(0, 9999) === false;
  console.log(`${latOk ? 'ok  ' : 'FAIL'}  latencyDoubled thresholds`);
  if (!latOk) bad++;
  console.log(bad === 0 ? '\nSELFTEST PASSED' : `\nSELFTEST FAILED (${bad})`);
  process.exit(bad === 0 ? 0 : 1);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const stepArg = [...args].find(a => a.startsWith('--step='));
  const step = stepArg ? Number(stepArg.split('=')[1]) : 1;
  const dryRun = args.has('--dry-run');

  if (args.has('--selftest')) return runSelftest();

  if (!STEP_ATTEMPTS[step]) {
    console.error(`Unknown --step=${step}. Use 1 (budget 40), 2 (budget 50) or 3 (budget 60).`);
    process.exit(2);
  }
  const attempts = STEP_ATTEMPTS[step];
  const totalPosts = attempts * 2; // load + submit each

  console.log('rc-rate-probe — mirrors the cart burst from a THROWAWAY connection.');
  console.log(`step ${step}: ${WORKERS} workers, ${attempts} attempts (~${totalPosts} POSTs), ${GAP_MS}ms gap, UNAUTHENTICATED.`);
  console.log(`targets:\n  ${PRECART_LOAD}\n  ${PRECART_SUBMIT}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing was sent. Example body/headers below.');
    console.log('headers:', JSON.stringify(probeHeaders()));
    console.log('body:', JSON.stringify(probeBody()));
    console.log('\nTo actually run: add --i-understand (and read docs/RC-RATE-MEASUREMENT.md first).');
    return;
  }

  if (!args.has('--i-understand')) {
    console.error('\nREFUSING: this sends real POSTs to ReserveCalifornia. Run only from a throwaway');
    console.error('connection (NOT the household line, NOT your own phone — carriers share IPs).');
    console.error('Re-run with --i-understand once you have read docs/RC-RATE-MEASUREMENT.md.');
    process.exit(2);
  }

  const hrs = hoursToNext0800PT();
  if (hrs < 2) {
    console.error(`\nREFUSING: ${hrs.toFixed(1)}h to the next 08:00 PT release — too close (need >2h).`);
    process.exit(2);
  }

  const ipBefore = await publicIp();
  if (!ipBefore) {
    console.error('\nREFUSING: could not determine the public IP. Cannot verify the throwaway line.');
    process.exit(2);
  }
  console.log(`\npublic IP before: ${ipBefore}  (hours to next 08:00 PT: ${hrs.toFixed(1)})`);
  console.log('Starting in 3s… Ctrl-C to abort.');
  await new Promise(r => setTimeout(r, 3000));

  const latencies = [];
  let stopped = null;
  let sent = 0;
  let baselineMs = 0;

  // WORKERS run in parallel; each does load then submit, then waits GAP_MS, repeating until
  // its share of `attempts` is spent or any worker signals a stop.
  const perWorker = Math.ceil(attempts / WORKERS);
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    for (let i = 0; i < perWorker; i++) {
      if (stopped) return;
      for (const url of [PRECART_LOAD, PRECART_SUBMIT]) {
        if (stopped) return;
        const r = await oneAttempt(url);
        sent++;
        latencies.push(r.ms);
        if (baselineMs === 0 && latencies.length >= 4) {
          baselineMs = [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)];
        }
        const verdict = classifyResponse(r);
        if (!verdict.ok) { stopped = { url, r, why: verdict.reason }; return; }
        if (baselineMs && latencyDoubled(baselineMs, r.ms)) {
          stopped = { url, r, why: `latency doubled (${r.ms}ms vs baseline ${baselineMs}ms)` };
          return;
        }
      }
      if (stopped) return;
      await new Promise(res => setTimeout(res, GAP_MS));
    }
  }));

  const ipAfter = await publicIp();
  const med = latencies.length ? [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : 0;
  console.log(`\nsent ${sent} POSTs. median latency ${med}ms. public IP after: ${ipAfter}`);
  if (ipAfter !== ipBefore) console.log(`⚠ public IP CHANGED during the run (${ipBefore} → ${ipAfter}) — DISCARD this reading.`);

  if (stopped) {
    console.log(`\n✗ STOPPED: ${stopped.why}`);
    console.log(`  at: ${stopped.url}`);
    console.log(`  status: ${stopped.r.status}`);
    console.log(`  headers: ${JSON.stringify(stopped.r.headers)}`);
    if (stopped.r.netError) console.log(`  netError: ${stopped.r.netError}`);
    console.log(`  body[0..300]: ${String(stopped.r.raw).slice(0, 300)}`);
    console.log('\nA limit exists at or below this pattern on THIS IP. Do NOT raise BURST_BUDGET.');
    console.log('Re-check this same IP at +1h and +12h before concluding it is blocked long-term.');
    process.exit(1);
  }

  console.log(`\n✓ CLEAN: all ${sent} requests returned the expected app-tier 401, no edge pushback.`);
  console.log('This step is clear on THIS throwaway IP. Necessary, not sufficient, for the household IP.');
  console.log('Next: wait ≥30 min, then the next step; never within 2h of a release; one step per sitting.');
}

main().catch(e => { console.error(e); process.exit(1); });
