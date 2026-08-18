/**
 * WHAT IS THE RUNAWAY BROWSER ACTUALLY HOLDING?
 *
 * The leak is attributed — `rc` family, one process, ~2,400 MB/min of real memory, twenty
 * times in five days — and the allocation site inside the page is still unknown. This module
 * exists to narrow that from the outside, because the alternative is guessing, and this file
 * has a long record of guesses hardening into false premises.
 *
 * ## Why metrics and not a heap snapshot
 *
 * The obvious instrument is `HeapProfiler.takeHeapSnapshot`. At the sizes involved it is the
 * wrong one: a snapshot of a 25 GB heap is itself many GB, streamed in chunks over CDP, and
 * written to disk on a box that is at that moment unable to spawn a process. The cure would
 * arrive as part of the disease.
 *
 * `Performance.getMetrics` is one call with a tiny response and it answers the question that
 * actually splits the candidate space:
 *
 *   • JSHeapUsedSize huge          -> JavaScript is retaining it. A retry loop, an array
 *                                     nobody trims, our own fetch wrapper holding `init` per
 *                                     pending request.
 *   • JSHeapUsedSize small         -> it is NOT JavaScript. That eliminates every candidate
 *     while the process is 25 GB      above at a stroke and points at external memory —
 *                                     ArrayBuffers, decoded images, network buffers, or
 *                                     something in Chromium's own handling of the window.
 *   • Nodes / LayoutObjects huge   -> the DOM is growing, which is a different bug again.
 *   • JSEventListeners climbing    -> listeners registered per retry and never removed.
 *
 * One reading of those four numbers is worth more than another week of reasoning, and it costs
 * a few hundred bytes.
 *
 * ## The snapshot is still available, but EARLY
 *
 * If the metrics do point at the JS heap, the next question is which objects — and that does
 * need a real snapshot. The trick is to take it at the START of a ramp rather than the end:
 * the size bound trips at 1,500 MB, where a snapshot is an ordinary file and the growing
 * objects are already present. `RC_HEAP_SNAPSHOT=1` enables it there. It is off by default
 * because writing a large file is a side effect nobody asked for on a box that carts campsites.
 *
 * ## Nothing here may delay the exit
 *
 * Every function is bounded and every failure is a null. The guard's job is to save the box;
 * a diagnostic that can hold it up has inverted the priority. A CDP call that times out is
 * itself a reading — "the browser would not answer" — and is reported as one rather than
 * thrown.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Bound on every CDP round trip. Short: the browser is by assumption in trouble. */
const CDP_TIMEOUT_MS = Number(process.env.RC_HEAP_CDP_TIMEOUT_MS || 3_000);

/** Metrics worth carrying. Everything else in `Performance.getMetrics` is timing noise here. */
const WANTED = [
  'JSHeapUsedSize',
  'JSHeapTotalSize',
  'Nodes',
  'Documents',
  'JSEventListeners',
  'LayoutObjects',
  'Resources',
];

const mb = (bytes) => (typeof bytes === 'number' ? Math.round(bytes / (1024 * 1024)) : null);

/**
 * Race a promise against a timer.
 *
 * A REJECTION AND A TIMEOUT MUST NOT LOOK THE SAME. `reason` distinguishes "the browser
 * refused" from "the browser never answered", which is exactly the distinction that made
 * `stage: 'none'` versus `no-signin-control` worth having in the renewal.
 */
function within(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: `${label}: no answer in ${ms}ms` }), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ ok: true, value }),
      (err) => ({ ok: false, reason: `${label}: ${err?.message ?? String(err)}` }),
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

/**
 * Ask the page's renderer what it is holding.
 *
 * Returns `{ ok: true, facts }` or `{ ok: false, reason }` — never throws, never hangs past
 * `CDP_TIMEOUT_MS` per step.
 *
 * CDP GOES THROUGH PLAYWRIGHT, NOT A DEBUGGING PORT, deliberately. `--remote-debugging-port`
 * would open a local socket with full control of the browser holding a live
 * ReserveCalifornia session, on a machine that is routinely screen-shared, to buy a
 * diagnostic. If Playwright's own channel turns out to be jammed at the moment we need it,
 * that will show up as `no answer` here and the port becomes a decision made on evidence
 * rather than for convenience.
 */
export async function collectHeapFacts(ctx, page) {
  if (!ctx || !page) return { ok: false, reason: 'no page to ask' };
  const session = await within(ctx.newCDPSession(page), CDP_TIMEOUT_MS, 'newCDPSession');
  if (!session.ok) return { ok: false, reason: session.reason };
  const cdp = session.value;
  try {
    const enabled = await within(cdp.send('Performance.enable'), CDP_TIMEOUT_MS, 'Performance.enable');
    if (!enabled.ok) return { ok: false, reason: enabled.reason };
    const got = await within(cdp.send('Performance.getMetrics'), CDP_TIMEOUT_MS, 'Performance.getMetrics');
    if (!got.ok) return { ok: false, reason: got.reason };

    const byName = new Map((got.value?.metrics ?? []).map((m) => [m.name, m.value]));
    const facts = {};
    for (const name of WANTED) if (byName.has(name)) facts[name] = byName.get(name);

    // `Runtime.getHeapUsage` is a second opinion on the same number from a different code
    // path. Two instruments disagreeing about the JS heap would itself be the finding — this
    // repo has twice had one measurement quietly reporting another measurement's value.
    const usage = await within(cdp.send('Runtime.getHeapUsage'), CDP_TIMEOUT_MS, 'Runtime.getHeapUsage');
    if (usage.ok) {
      facts.RuntimeUsedSize = usage.value?.usedSize;
      facts.RuntimeTotalSize = usage.value?.totalSize;
    }
    return { ok: true, facts };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  } finally {
    // Detaching is best-effort: we are usually about to exit, and a failed detach must not
    // become the thing that stops us exiting.
    await within(cdp.detach(), 1_000, 'detach').catch(() => {});
  }
}

/**
 * One line, readable in `tail-log rc-keepwarm`, that says which category is growing.
 *
 * THE VERDICT IS STATED, NOT LEFT TO THE READER. A row of raw counters at the bottom of a log
 * is a row of raw counters; the whole point is the JS-versus-not split, so the line says which
 * one it saw. `processMb` is passed in because the renderer cannot see its own process size —
 * comparing the two IS the discriminator and neither number means much alone.
 */
export function describeHeapFacts(result, processMb) {
  if (!result?.ok) return `heap facts unavailable (${result?.reason ?? 'unknown'})`;
  const f = result.facts ?? {};
  const jsMb = mb(f.JSHeapUsedSize ?? f.RuntimeUsedSize);
  const parts = [
    `JS heap ${jsMb == null ? '?' : `${jsMb} MB`}`,
    `nodes ${f.Nodes ?? '?'}`,
    `docs ${f.Documents ?? '?'}`,
    `listeners ${f.JSEventListeners ?? '?'}`,
    `layout ${f.LayoutObjects ?? '?'}`,
  ];
  let verdict = '';
  if (jsMb != null && typeof processMb === 'number' && processMb > 0) {
    const share = jsMb / processMb;
    verdict = share >= 0.5
      ? ` — JS heap is ${Math.round(share * 100)}% of the process, so JAVASCRIPT is retaining it`
      : ` — JS heap is only ${Math.round(share * 100)}% of ${Math.round(processMb)} MB, so it is `
        + 'NOT the JS heap (external buffers, decoded media, or Chromium itself)';
  }
  return `${parts.join(', ')}${verdict}`;
}

/**
 * Write a real heap snapshot. OFF unless `RC_HEAP_SNAPSHOT=1`.
 *
 * ONLY WORTH CALLING EARLY IN A RAMP. At 1,500 MB the file is ordinary; at 25 GB it is not,
 * and the box is by then unable to spawn a process, so writing gigabytes is the last thing it
 * needs. That is why this is wired to the size bound and never to the RAM-pressure arm.
 *
 * `maxBytes` is a hard stop rather than a suggestion: a truncated snapshot is useless, but an
 * unbounded write that fills the disk takes the box down in a new way, and this file already
 * has one entry about a fix that promoted junk by making a failing path succeed.
 */
export async function writeHeapSnapshot(ctx, page, dir, { maxBytes = 512 * 1024 * 1024 } = {}) {
  if (process.env.RC_HEAP_SNAPSHOT !== '1') return { ok: false, reason: 'not enabled' };
  if (!ctx || !page) return { ok: false, reason: 'no page to ask' };
  const session = await within(ctx.newCDPSession(page), CDP_TIMEOUT_MS, 'newCDPSession');
  if (!session.ok) return { ok: false, reason: session.reason };
  const cdp = session.value;
  // Timestamp comes from the caller's clock, formatted here — the file name is the only way
  // to pair a snapshot with a row in `chromium_memory_samples` afterwards.
  const file = path.join(dir, `rc-heap-${new Date().toISOString().replace(/[:.]/g, '-')}.heapsnapshot`);
  let out = null;
  let written = 0;
  let overflowed = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    out = fs.createWriteStream(file);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => {
      if (overflowed) return;
      written += Buffer.byteLength(chunk);
      if (written > maxBytes) { overflowed = true; return; }
      out.write(chunk);
    });
    // No timeout on this one: a snapshot legitimately takes a while, and cutting it off part
    // way produces a file that cannot be opened. The caller decides whether it is a good
    // moment to ask at all — which is why this is the EARLY trip only.
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
    await new Promise((resolve) => out.end(resolve));
    if (overflowed) {
      fs.rmSync(file, { force: true });
      return { ok: false, reason: `snapshot exceeded ${Math.round(maxBytes / (1024 * 1024))} MB — discarded` };
    }
    return { ok: true, file, bytes: written };
  } catch (err) {
    try { out?.end(); fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    return { ok: false, reason: err?.message ?? String(err) };
  } finally {
    await within(cdp.detach(), 1_000, 'detach').catch(() => {});
  }
}
