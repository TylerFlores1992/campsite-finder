/**
 * DOES THE BAIL ARM ACTUALLY GET THE READING? — the trigger path, driven off-box.
 *
 *   node scripts/auto-cart-bot/ramp-arm-probe.mjs
 *
 * ## Why this exists
 *
 * `alloc-trail-probe.mjs` and `mem-dump-probe.mjs` drive a real Chromium to validate the
 * INSTRUMENTS. Nothing has ever driven the TRIGGER — and every one of the four missed ramps
 * was in the trigger, not the instrument:
 *
 *   09-07 02:03  the memory reading was about the browser that had just died
 *   09-07 20:42  the bail arm raced the dump away on the same tick
 *   09-08 02:03  no sampler tick landed between the two thresholds
 *   09-08 07:47  the grace stopped holding the instant the dump STARTED
 *
 * The dump itself has never once failed when it was allowed to run: six baselines, 209-332 ms,
 * ownership edges resolving on Linux and on Windows. So the ramp has been the test of the
 * plumbing, and the ramp costs 5-28 hours.
 *
 * ## What this can and cannot answer, stated up front
 *
 * The glue — `maybeMemoryDump` and the arm — is a closure inside `warmResident` and cannot be
 * imported. THIS DOES NOT RE-IMPLEMENT THE DECISION: `rampBailDecision`, `rampDumpGrace` and
 * `takeMemoryDump` are the REAL exports, and the glue's SHAPE is pinned structurally in
 * `worker/rc-mem-dump.test.mts` (the call site passes `dumpInFlight`, the trigger precedes the
 * arms, the dump is never inside `reportAndBail`). A rig that asserted the shape here would be
 * asserting a copy, which is the trap this repo has paid for.
 *
 * What it answers instead is the three questions that are properties of a REAL browser and
 * that no unit test can reach:
 *
 *   1. HOW LONG does a real `takeMemoryDump` take, against the grace it is given?
 *   2. Does `inFlight` really clear only AFTER the reporting callback resolves? The whole
 *      in-flight hold rests on `.finally` waiting for the `.then` chain, which is an async
 *      semantics claim nobody has tested.
 *   3. Against a browser that has GONE AWAY, does the dump RETURN or HANG? A hang inside the
 *      dump leaves `inFlight` set for ever, which would make the instrument fire once per
 *      browser life and report nothing after — the failure `MEM_DUMP_CLEANUP_MS` was added for.
 *
 * ## It imports playwright-core, like its siblings, and that is deliberate
 *
 * Dev sandbox only; never the mini-PC. Do not "fix" the import to match its neighbours.
 */
import { chromium } from 'playwright-core';
import { takeMemoryDump, MEM_DUMP_TIMEOUT_MS } from './rc-mem-dump.mjs';
import { rampDumpGrace, rampBailDecision, MEM_DUMP_GRACE_MS_DEFAULT, writeLatestMemory, readLatestMemory } from './ramp-bail.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXECUTABLE = process.env.RAMP_ARM_PROBE_CHROMIUM || undefined;
const TICK_MS = 10_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ramp-arm-'));
const MEM_FILE = path.join(dir, '.memory-latest.json');

let verdict = 1;
const fail = (msg) => { console.log(`x ${msg}`); };
const pass = (msg) => { console.log(`+ ${msg}`); };

const browser = await chromium.launch({ headless: true, executablePath: EXECUTABLE });
try {
  const page = await browser.newPage();
  await page.goto('data:text/html,<title>rig</title><p>rig');
  // The box attaches this AT LAUNCH while the browser is healthy, precisely because
  // negotiating one at trip time produced `newCDPSession: no answer in 3000ms`.
  const heapProbe = await browser.newBrowserCDPSession();

  // ── 1. THE FORGED INPUTS ─────────────────────────────────────────────────────────────────
  // The arm reads exactly four things and three are forgeable: `stalledMs` is a local number,
  // the memory figure is a FILE WE WRITE, and only the CDP calls need a real browser. That is
  // the whole reason this is testable in a container and was never tested in one.
  const browserLifeSince = Date.now() - 60_000;
  writeLatestMemory(MEM_FILE, { rcMb: 9000, maxPid: 4242, maxType: 'renderer' });
  const memory = readLatestMemory(MEM_FILE, { notBefore: browserLifeSince });
  if (!memory.known) {
    fail(`THE QUESTION WAS NEVER REACHED — the forged reading did not read back: ${memory.why}`);
    process.exit(1);
  }
  const decision = rampBailDecision({ stalledMs: 139_000, memory });
  if (!decision.fire) {
    fail(`THE QUESTION WAS NEVER REACHED — the arm did not fire on the forged inputs: ${decision.why}`);
    process.exit(1);
  }
  pass(`the arm fires on forged inputs (${Math.round(memory.rcMb)} MB, 139s stalled) — 09-08 07:47 reproduced without a ramp`);

  // ── 2. THE REAL SEQUENCE, TICK BY TICK ───────────────────────────────────────────────────
  const memDump = { ramp: false, inFlight: false, landed: false, graceUntil: null };
  let reportResolved = false;
  let inFlightWhenReportResolved = null;
  const startDump = () => {
    memDump.ramp = true;
    memDump.inFlight = true;
    const t0 = Date.now();
    return takeMemoryDump(heapProbe)
      .then(async (r) => {
        // Stand in for `reportBotEvent`, which is what the real `.then` returns. The claim
        // being tested is that `.finally` waits for THIS before clearing `inFlight`.
        await new Promise((res) => setTimeout(res, 250));
        reportResolved = true;
        inFlightWhenReportResolved = memDump.inFlight;
        if (r.ok) memDump.landed = true;
        console.log(`    dump returned in ${Date.now() - t0}ms ok=${r.ok}${r.partial ? ` partial=${r.partial}` : ''}${r.why ? ` why=${r.why}` : ''}`);
      })
      .catch(() => {})
      .finally(() => { memDump.inFlight = false; });
  };

  let held = 0;
  let bailedAt = null;
  const t0 = Date.now();
  let inFlightPromise = null;
  for (let tick = 0; tick < 8 && bailedAt === null; tick++) {
    const now = Date.now();
    const g = rampDumpGrace({
      now,
      dumpStarted: memDump.ramp,
      dumpInFlight: memDump.inFlight,
      graceUntil: memDump.graceUntil,
      canDump: true,
    });
    console.log(`  tick ${tick} (+${Math.round((now - t0) / 1000)}s) hold=${g.hold} — ${g.why}`);
    if (g.hold) {
      held++;
      memDump.graceUntil = g.until;
      if (!memDump.ramp && !memDump.inFlight) inFlightPromise = startDump();
      await new Promise((r) => setTimeout(r, TICK_MS));
    } else {
      bailedAt = Date.now() - t0;
    }
  }
  if (inFlightPromise) await inFlightPromise;

  // ── 3. THE THREE QUESTIONS ───────────────────────────────────────────────────────────────
  let ok = true;
  if (!memDump.landed) { fail('the dump never landed inside the grace — the arithmetic does not hold on a real browser'); ok = false; }
  else pass(`the dump landed, and the bail waited ${Math.round((bailedAt ?? 0) / 1000)}s across ${held} held tick(s)`);

  if (reportResolved && inFlightWhenReportResolved !== true) {
    fail('`inFlight` was already clear when the reporting callback resolved — `.finally` does '
      + 'NOT wait for the `.then` chain, so the hold does not cover the POST');
    ok = false;
  } else if (reportResolved) {
    pass('`inFlight` was still set when the reporting callback resolved — the hold really does cover the POST');
  } else { fail('the reporting callback never resolved — nothing was measured'); ok = false; }

  if (MEM_DUMP_GRACE_MS_DEFAULT < MEM_DUMP_TIMEOUT_MS) {
    fail(`the grace (${MEM_DUMP_GRACE_MS_DEFAULT}ms) is under the dump's own timeout (${MEM_DUMP_TIMEOUT_MS}ms) — the bail can kill a dump that would have answered`);
    ok = false;
  } else pass(`the grace (${MEM_DUMP_GRACE_MS_DEFAULT}ms) covers the dump's own timeout (${MEM_DUMP_TIMEOUT_MS}ms)`);

  // ── 3b. THE SCENARIO THAT ACTUALLY REPRODUCES 09-08: A DUMP SLOWER THAN ONE TICK ─────────
  //
  // A healthy dump takes ~400ms and spends exactly one tick, so the fast path above cannot
  // tell the fixed grace from the broken one — it would pass against both. What killed the
  // 09-08 reading is a dump SLOWER than a tick, against a browser answering no CDP call in
  // 3000ms. That duration is a property of a struggling browser and cannot be reproduced in a
  // container, so it is FORCED here.
  //
  // THE DECISION IS STILL THE REAL ONE. Only the dump's duration is controlled; `rampDumpGrace`
  // is the shipped export, unmodified. Stubbing the decision would be asserting a copy.
  console.log('\n  slow-dump scenario: the dump takes longer than one tick (09-08 07:47)');
  const slow = { ramp: false, inFlight: false, landed: false, graceUntil: null };
  let slowHeld = 0;
  let slowBailedAfter = null;
  const slowStart = Date.now();
  let slowPromise = null;
  for (let tick = 0; tick < 8 && slowBailedAfter === null; tick++) {
    const g = rampDumpGrace({
      now: Date.now(),
      dumpStarted: slow.ramp,
      dumpInFlight: slow.inFlight,
      graceUntil: slow.graceUntil,
      canDump: true,
    });
    console.log(`  tick ${tick} (+${Math.round((Date.now() - slowStart) / 1000)}s) hold=${g.hold} — ${g.why}`);
    if (g.hold) {
      slowHeld++;
      slow.graceUntil = g.until;
      if (!slow.ramp && !slow.inFlight) {
        slow.ramp = true;
        slow.inFlight = true;
        slowPromise = new Promise((res) => setTimeout(res, 15_000)).then(() => {
          slow.landed = true;
        }).finally(() => { slow.inFlight = false; });
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    } else {
      slowBailedAfter = Date.now() - slowStart;
    }
  }
  if (slowPromise) await slowPromise;
  if (!slow.landed) {
    fail(`a 15s dump was killed after ${Math.round((slowBailedAfter ?? 0) / 1000)}s — THIS IS THE 09-08 BUG. `
      + 'The grace stopped holding while the dump was still in flight.');
    ok = false;
  } else if (slowHeld < 2) {
    fail(`the grace held only ${slowHeld} tick, so a dump slower than a tick cannot survive it`);
    ok = false;
  } else {
    pass(`a 15s dump survived: the grace held ${slowHeld} ticks and the bail waited `
      + `${Math.round((slowBailedAfter ?? 0) / 1000)}s — the 09-08 bug is caught by this probe`);
  }

  // ── 4. THE CONTROL: a browser that has gone away ─────────────────────────────────────────
  // A dump that HANGS leaves `inFlight` set for ever and the instrument reports nothing again
  // for the life of the browser. That is the failure MEM_DUMP_CLEANUP_MS exists for, and it
  // has never been exercised.
  console.log('\n  control: closing the browser, then asking it for a dump...');
  await browser.close();
  const deadStart = Date.now();
  const dead = await takeMemoryDump(heapProbe, { timeoutMs: 5_000 });
  const deadMs = Date.now() - deadStart;
  if (deadMs > 20_000) { fail(`a dump against a closed browser took ${deadMs}ms — it must fail fast, not hang`); ok = false; }
  else pass(`a dump against a closed browser RETURNED in ${deadMs}ms (ok=${dead.ok}) — it cannot strand the in-flight flag`);

  verdict = ok ? 0 : 1;
  console.log(ok
    ? '\n+ THE TRIGGER PATH HOLDS ON A REAL BROWSER. What it does under a real ramp — a renderer\n  that has stopped answering CDP — is still open; that needs the box.'
    : '\n x THE TRIGGER PATH DOES NOT HOLD. Read the failing line above before shipping anything.');
} finally {
  try { await browser.close(); } catch { /* already closed by the control */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(verdict);
