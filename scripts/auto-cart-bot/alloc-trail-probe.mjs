/**
 * DOES THE TRAIL SEE WHAT THE RETURN-PATH READING CANNOT?
 *
 * Every other guard around `rc-alloc-trail.mjs` is a source scan or a scripted unit test.
 * Neither can answer the question the trail was built for, because both ways the old
 * instrument goes blind are properties of a REAL browser. So this drives the real
 * `createAllocTrail` against a real Chromium, and runs the OLD reading as a control on the
 * SAME event.
 *
 *   node scripts/auto-cart-bot/alloc-trail-probe.mjs
 *
 * IT RUNS IN THE DEV SANDBOX, NOT ON THE MINI-PC, and that is why it imports `playwright-core`
 * where every sibling here imports `playwright`. The repo's own devDependency is
 * `playwright-core`; the box has the full package. Do not "fix" the import to match its
 * neighbours — it would stop running in the one place this probe is useful, which is a machine
 * with a spare Chromium and no live RC session to disturb. `ALLOC_PROBE_CHROMIUM` overrides the
 * binary; the default is the sandbox's pre-installed one.
 *
 * ## The two cases, and why these two
 *
 * **A — THE RAMP IS IN A RENDERER THE TRIP DOES NOT OWN.** Every existing `startNativeSampling`
 * call site is on the trip's own tab; the resident RC page has never been sampled. On
 * 2026-08-25 02:31 the renewal's tab reported 17 MB while the family's renderers reached
 * 8,052 MB, which is what that would look like. Here the resident page allocates and the tab
 * does a quiet trip, so the old reading is looking at the wrong renderer by construction.
 *
 * **B — THE TRIP NEVER RETURNS.** `reportNativeAlloc` fires on the return path, so a browser
 * killed mid-ramp reports nothing at all — that is the established reason Track A has three
 * readings for three ramps and every one sits outside its ramp window. Here the return-path
 * read is simply never taken, which is what a kill amounts to.
 *
 * ## And a negative it keeps measuring, because it was believed for several hours
 *
 * CDP's all-time profile IS reset by a navigation that swaps the renderer — and RC's
 * `www.reservecalifornia.com` -> `signin.reservecalifornia.com` is not one. Chromium isolates
 * by SITE (scheme + eTLD+1), so a subdomain hop keeps its renderer. The table below is printed
 * every run because "the navigation resets the profile" is the obvious first hypothesis for
 * 17 MB against 8,052 MB, it is easy to confirm with two genuinely different sites, and it is
 * wrong about the navigation this project actually makes.
 *
 * ## It refuses a verdict it has not earned
 *
 * Each case checks its CONTROL first. A trail that reports the ramp proves nothing unless the
 * old reading demonstrably missed it on the same event — otherwise this is a browser in which
 * the blindness does not reproduce, and the trail's success is about this machine rather than
 * about the instrument. Same rule as `--concurrent-mint` printing THE QUESTION WAS NEVER
 * REACHED rather than a race it never tested.
 */
import http from 'node:http';
import { chromium } from 'playwright-core';
import { startNativeSampling, readNativeProfile, diffProfiles } from './rc-native-sampler.mjs';
import { createAllocTrail, describeAllocTrail } from './rc-alloc-trail.mjs';

const PORT = Number(process.env.ALLOC_PROBE_PORT || 18921);
const RAMP_MB = Number(process.env.ALLOC_PROBE_RAMP_MB || 800);
const EXE = process.env.ALLOC_PROBE_CHROMIUM || '/opt/pw-browsers/chromium';
const MB = 1048576;
const mbOf = (b) => Math.round((b ?? 0) / MB);

const PAGE = `<!doctype html><meta charset=utf-8><title>probe</title><script>
  window.__k = [];
  window.__eat = (n) => { for (let i = 0; i < n; i++) { const a = new Uint8Array(1048576); a.fill(i & 255); window.__k.push(a); } return window.__k.length; };
</script>probe`;

const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE); });
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

// Two hostnames under ONE registrable domain, which is what RC actually navigates between.
const WWW = `http://www.rc.probe:${PORT}/`;
const SIGNIN = `http://signin.rc.probe:${PORT}/`;
// And two genuinely different SITES, for the isolation table only.
const SITE_A = `http://a.probe2:${PORT}/`;
const SITE_B = `http://b.probe2:${PORT}/`;

const ctx = await chromium.launchPersistentContext('/tmp/alloc-trail-probe', {
  headless: true,
  executablePath: EXE,
  args: [
    '--host-resolver-rules=MAP *.probe 127.0.0.1,MAP *.probe2 127.0.0.1',
    '--site-per-process',
  ],
});
const settle = () => new Promise((r) => setTimeout(r, 400));
const armed = async (page) => {
  const cdp = await ctx.newCDPSession(page);
  const a = await startNativeSampling(cdp);
  return a.ok ? cdp : null;
};

// ─── the isolation table, measured rather than asserted ───────────────────────────────────
console.log('\n  ── which navigations swap the renderer (and so reset the profile) ──\n');
for (const [label, from, to] of [
  ['a.probe2      -> b.probe2       (different SITE)', SITE_A, SITE_B],
  ['www.rc.probe  -> signin.rc.probe (SUBDOMAIN, RC\'s shape)', WWW, SIGNIN],
]) {
  const p = await ctx.newPage();
  await p.goto(from, { waitUntil: 'load' });
  const cdp = await armed(p);
  await p.evaluate(() => window.__eat(200));
  const before = (await readNativeProfile(cdp))?.totalBytes ?? 0;
  await p.goto(to, { waitUntil: 'load' });
  const after = (await readNativeProfile(cdp))?.totalBytes ?? 0;
  const swapped = after < before / 2;
  console.log(`  ${label.padEnd(58)} ${String(mbOf(before)).padStart(4)} -> ${String(mbOf(after)).padStart(4)} MB   `
    + `${swapped ? 'RENDERER SWAPPED' : 'same renderer'}`);
  await p.close();
}
console.log('\n  RC makes the SUBDOMAIN hop, so the profile reset is not why its readings are small.\n');

// ─── the trail, wired as the keep-warm wires it ──────────────────────────────────────────
const resident = await ctx.newPage();
await resident.goto(WWW, { waitUntil: 'load' });
const residentCdp = await armed(resident);
const tab = await ctx.newPage();
await tab.goto(WWW, { waitUntil: 'load' });
const tabCdp = await armed(tab);

const trail = createAllocTrail({ sampleMs: 0 });
if (residentCdp) trail.register('resident', residentCdp);
if (tabCdp) trail.register('renewal', tabCdp);
if (!residentCdp || !tabCdp) {
  console.log('  ✗ THE QUESTION WAS NEVER REACHED — a sampler would not arm on this browser.\n');
  await ctx.close(); srv.close(); process.exit(2);
}

// The watchdog tick, compressed. In production this is every 10s across a ten-minute ramp;
// here it is every 150ms across a few seconds, exercising the identical code path.
let free = 9000;
const ticking = setInterval(() => trail.sample(Date.now(), (free -= 40)), 150);

// ─── CASE A: the ramp is in the RESIDENT renderer, which nothing used to sample ──────────
const tabBefore = await readNativeProfile(tabCdp);
await settle();
await tab.goto(SIGNIN, { waitUntil: 'load' });
for (let i = 0; i < 4; i++) {
  // The resident page is what grows. The trip tab does its round trip and allocates little,
  // which is the shape that produced 17 MB against 8,052 MB in production.
  await resident.evaluate((n) => window.__eat(n), Math.round(RAMP_MB / 4));
  await settle();
}
await tab.goto(`${WWW}?callback`, { waitUntil: 'load' });
await settle();
const tabAfter = await readNativeProfile(tabCdp);
const caseAControl = mbOf(diffProfiles(tabBefore, tabAfter)?.totalBytes);
trail.unregister('resident');
const caseATrail = mbOf(trail.takeRamps({ final: true }).find((r) => r.name === 'resident')?.growthBytes);

// ─── CASE B: the trip ramps and the return-path read is never taken ──────────────────────
for (let i = 0; i < 4; i++) {
  await tab.evaluate((n) => window.__eat(n), Math.round(RAMP_MB / 4));
  await settle();
}
// NO `readNativeProfile(tabCdp)` HERE, deliberately — that is what a browser killed mid-ramp
// amounts to, and the return-path report is the one that never happens.
clearInterval(ticking);
await settle();
trail.unregister('renewal');
const caseBTrail = mbOf(trail.takeRamps({ final: true }).find((r) => r.name === 'renewal')?.growthBytes);

console.log(`  ${describeAllocTrail(trail.buffers(), Date.now())}\n`);
for (const [name, samples] of trail.buffers()) {
  const t0 = samples[0]?.at ?? 0;
  console.log(`  raw [${name}]: ${samples.map((x) =>
    `${((x.at - t0) / 1000).toFixed(1)}s=${mbOf(x.profile.totalBytes)}`).join(' ')}`);
}

await ctx.close();
srv.close();

console.log(`\n  CASE A — ${RAMP_MB} MB allocated in the RESIDENT renderer during a tab trip`);
console.log(`     return-path reading on the tab (the old instrument):  ${caseAControl} MB`);
console.log(`     trail reading on the resident renderer:               ${caseATrail} MB`);
console.log(`\n  CASE B — ${RAMP_MB} MB allocated in the tab, return-path read never taken`);
console.log(`     return-path reading:                                  none, by construction`);
console.log(`     trail reading on the trip renderer:                   ${caseBTrail} MB\n`);

const bar = RAMP_MB / 2;
if (caseAControl >= bar) {
  console.log(`  ✗ THE QUESTION WAS NEVER REACHED — case A's control saw ${caseAControl} MB, so the`);
  console.log('    tab and the resident page are sharing a renderer here and the blindness this');
  console.log('    case exists to demonstrate did not reproduce. Nothing follows about the trail.\n');
  process.exit(2);
}
const failures = [];
if (caseATrail < bar) failures.push(`case A: the trail saw only ${caseATrail} MB of ${RAMP_MB}`);
if (caseBTrail < bar) failures.push(`case B: the trail saw only ${caseBTrail} MB of ${RAMP_MB}`);
if (failures.length) {
  console.log('  ✗ THE TRAIL MISSED IT:');
  for (const f of failures) console.log(`      ${f}`);
  console.log();
  process.exit(1);
}
console.log('  ✓ THE TRAIL SEES BOTH KINDS THE RETURN-PATH READING CANNOT.');
console.log(`    A: a ramp in a renderer the trip does not own — ${caseAControl} MB against ${caseATrail} MB.`);
console.log('    B: a ramp whose trip never comes back to be read at all.');
console.log('    Both are sampled on the watchdog tick, which is the only code proven to keep');
console.log('    executing while the loop is stalled — and a ramp IS the loop stalled.\n');
