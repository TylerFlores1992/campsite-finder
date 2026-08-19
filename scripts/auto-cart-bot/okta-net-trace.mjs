/**
 * WHAT DOES THE OKTA NAVIGATION ACTUALLY DOWNLOAD?
 *
 * ── WHY THIS EXISTS, AND WHY IT SHOULD HAVE EXISTED FIRST (2026-08-19) ─────────────────────
 * Five instruments have been built against this leak — a size guard, a RAM arm, a heap trail,
 * a post-Okta recycle, an orphan sweep — and not one of them stops the allocation. They are
 * all aftermath. This is the first thing that goes at the cause.
 *
 * The cause hunt is narrower than the instrument count suggests:
 *   • NOT the JS heap — 15-18 MB flat, twelve identical samples, against a 4,903 MB process,
 *     and V8's default old-space ceiling is ~4 GB while these have peaked at 27 GB.
 *   • The RENDERER and the BROWSER PROCESS, with GPU, utility and crashpad flat:
 *         baseline  {browser:42,  utility:24, renderer:103,  gpu-process:93} =   264MB
 *         ramp      {browser:587, utility:28, renderer:1340, gpu-process:89} = 2,046MB
 *   • Exactly on the OKTA NAVIGATION — three token-less renewals ten minutes apart split
 *     cleanly on whether the sign-in control was clicked: 2,331 MB versus nothing, with the
 *     identical clear, reload and prime on both sides.
 *
 * **"Network/IPC buffering" has been recorded as the leading candidate three times and never
 * once tested**, despite being directly observable. Non-JS memory growing by gigabytes in the
 * renderer AND the browser process is precisely the shape of a huge or looping response: the
 * browser process is where Chromium's network stack lives when the network service is not in
 * its own utility process, and utility did not move.
 *
 * So this counts the bytes. Either a response is enormous — which names the cause outright —
 * or the bytes are small, which ELIMINATES the whole buffering family at a stroke and makes
 * the next candidate worth building for. A negative is as useful as a positive here, which is
 * the property a diagnostic needs before it is worth shipping.
 *
 * ── IT MUST NOT BECOME THE THING IT MEASURES ───────────────────────────────────────────────
 * **Response bodies are NEVER read.** `response.body()` buffers the whole payload into this
 * process — on a page suspected of pulling hundreds of megabytes that is the cure arriving as
 * part of the disease, and it is the same mistake as writing a multi-GB heap snapshot at the
 * moment the box cannot spawn. Only `content-length` is consulted, from headers already in
 * hand, plus a count of the responses that declared none.
 *
 * ── AND IT MUST NOT LEAK A CREDENTIAL ──────────────────────────────────────────────────────
 * URLs are recorded as `origin + pathname`, never with the query. Okta's callback is
 * `/login/callback?code=…&state=…` and that code is exchangeable for the session — the precart
 * diagnostic published exactly that on 2026-08-09 by reporting `location.href`, and a
 * TypeError published a user's password on 08-16. **Do not collect a field you would then
 * have to filter.**
 */

import os from 'node:os';

/** Bytes, formatted for a log line a human reads at 08:00. */
function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `origin + pathname` — never the query, never the fragment. See the header.
 * A URL that will not parse is reported as the literal `(unparseable)` rather than raw,
 * because raw is exactly the case most likely to be carrying something.
 */
export function safeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

/**
 * A fall in free RAM big enough to be the leak rather than the box being a desktop.
 *
 * The measured allocations are 2,331 MB for one Okta trip and 4-5 GB for two, against
 * ordinary noise in the tens to low hundreds. 800 leaves a wide gap on both sides, and the
 * consequence of getting it wrong is only which sentence gets printed.
 */
const RAMP_MB = 800;

/** Bytes big enough that buffering could plausibly account for a multi-GB allocation. */
const BIG_BYTES = 200 * 1024 * 1024;

/**
 * Summarise what a run downloaded, and what it cost in RAM. PURE, so it is testable without a
 * browser — the same split as `parseSample` and `parseSweep`, and for the same reason: there
 * is no Chromium on the machine this repo is written from.
 *
 * @param {{ url: string, status: number, bytes: number|null }[]} responses
 * @param {{ top?: number, ram?: { beforeMb: number, afterMb: number }|null }} [opts]
 */
export function summariseTrace(responses, { top = 5, ram = null } = {}) {
  const known = responses.filter((r) => typeof r.bytes === 'number');
  const total = known.reduce((a, r) => a + r.bytes, 0);
  // BY PATH, not by response. Forty requests to one endpoint at 30 MB each is a LOOP, and it
  // looks nothing like one enormous download — but it is the shape that would explain a ramp
  // that grows steadily over ninety seconds rather than arriving all at once.
  const byPath = new Map();
  for (const r of known) {
    const cur = byPath.get(r.url) ?? { url: r.url, bytes: 0, hits: 0 };
    cur.bytes += r.bytes;
    cur.hits += 1;
    byPath.set(r.url, cur);
  }
  const biggest = [...byPath.values()].sort((a, b) => b.bytes - a.bytes).slice(0, top);
  return {
    responses: responses.length,
    unsized: responses.length - known.length,
    totalBytes: total,
    biggest,
    // MEASURED AROUND THE SAME CALL AS THE BYTES, which is the whole point — see
    // `describeTrace`. `null` when nobody measured, and that is not the same as zero.
    ram,
  };
}

/**
 * One line, stating a VERDICT — and refusing to state one it has not earned.
 *
 * ── THE THIRD CASE IS WHY THE RAM READING IS HERE (2026-08-19) ─────────────────────────────
 * The first trace read `112 response(s), 8.7 MB` and was very nearly written up as retiring
 * the buffering candidate. It was not entitled to: the 2-minute memory sampler bracketed that
 * renewal (05:05:56 and 05:07:56 either side of a run from 05:06:13 to 05:07:12), and the
 * post-Okta recycle freed everything twelve seconds after it ended — so **whether that
 * navigation ramped at all was unobserved**, and a trace of a non-ramping trip says nothing
 * about a leak.
 *
 * Two instruments had made each other useless, which is a failure this file has recorded
 * before in other clothes. `os.freemem()` around the SAME call fixes it: both facts come from
 * one event and neither depends on a sampler's cadence. It is a syscall, so it keeps answering
 * under exactly the pressure that stops `rcFamilyMb()` spawning PowerShell.
 *
 * FREE RAM IS NOISY — this is somebody's desktop — which is why the bar is `RAMP_MB` and not
 * "went down". At gigabyte scale the noise does not matter; below it, no verdict is offered.
 */
export function describeTrace(t) {
  if (!t || t.responses === 0) return 'network trace: nothing observed — the trace did not run';
  const head = `network trace: ${t.responses} response(s), ${mb(t.totalBytes)} declared`
    + `${t.unsized ? ` (+${t.unsized} with no content-length)` : ''}`;
  const list = t.biggest.length
    ? ' · ' + t.biggest.map((b) => `${b.url}${b.hits > 1 ? ` x${b.hits}` : ''} ${mb(b.bytes)}`).join(' · ')
    : '';

  // NO RAM READING, NO VERDICT. Bytes alone cannot distinguish "the network is innocent" from
  // "this trip never allocated", and conflating them is the mistake this exists to prevent.
  if (!t.ram || typeof t.ram.beforeMb !== 'number' || typeof t.ram.afterMb !== 'number') {
    return `${head}${list} · RAM not measured ⇒ no verdict: bytes alone cannot say whether this `
      + 'navigation allocated anything';
  }

  const used = t.ram.beforeMb - t.ram.afterMb;
  const ramText = ` · RAM ${t.ram.beforeMb} → ${t.ram.afterMb} MB `
    + `(${used >= 0 ? '−' : '+'}${Math.abs(Math.round(used))})`;

  if (used < RAMP_MB) {
    return `${head}${list}${ramText} ⇒ this navigation did NOT ramp, so the byte count says `
      + 'nothing about the leak — wait for one that does';
  }
  return t.totalBytes > BIG_BYTES
    ? `${head}${list}${ramText} ⇒ it ramped AND the network moved enough to explain it — `
      + 'buffering is now a LEAD, not a candidate'
    : `${head}${list}${ramText} ⇒ it ramped while the network moved almost nothing, so `
      + 'buffering does NOT explain the leak';
}

/**
 * Run `fn` with every response on `page` counted.
 *
 * Returns `{ result, trace }`. Never throws, never reads a body, and detaches in a `finally`
 * — the listener sits on the RESIDENT page, and one left attached would accumulate a record
 * per response for the life of the browser, which is a small leak added by the thing
 * investigating a large one.
 *
 * @param {import('playwright').Page} page
 * @param {() => Promise<any>} fn
 */
export async function withNetworkTrace(page, fn) {
  /** @type {{ url: string, status: number, bytes: number|null }[]} */
  const responses = [];
  let armed = true;

  const onResponse = (res) => {
    // The flag first, for the same reason the authorize route has one: a listener that
    // outlives its `finally` must be inert rather than merely unreferenced.
    if (!armed) return;
    // BOUNDED. A pathological loop is exactly what we are looking for, and an unbounded array
    // of records is how the instrument joins in. 2,000 is far more than a sign-in produces.
    if (responses.length >= 2000) return;
    try {
      const len = res.headers()['content-length'];
      responses.push({
        url: safeUrl(res.url()),
        status: res.status(),
        bytes: len == null ? null : Number(len),
      });
    } catch {
      // A response that cannot be read about is not worth failing a renewal over.
    }
  };

  // A SYSCALL, NOT A CHILD PROCESS. `rcFamilyMb()` spawns PowerShell and spawning is exactly
  // what fails as COMMIT passes ~95% — an instrument that goes quiet as the emergency peaks
  // reports the emergency as calm. `os.freemem()` answers under any load.
  const beforeMb = Math.round(os.freemem() / (1024 * 1024));

  page.on('response', onResponse);
  try {
    const result = await fn();
    return {
      result,
      // READ AFTER `fn` RETURNS AND BEFORE ANY RECYCLE. The post-Okta recycle frees the
      // allocation within seconds, which is precisely what made the 2-minute sampler blind to
      // the first trace's event. Taking it here is what keeps the two facts about one event.
      trace: summariseTrace(responses, {
        ram: { beforeMb, afterMb: Math.round(os.freemem() / (1024 * 1024)) },
      }),
    };
  } finally {
    armed = false;
    try { page.off('response', onResponse); } catch { /* best effort */ }
  }
}
