// Why does ReserveCalifornia render a blank page in OUR browser and not in yours?
//
// WHAT THIS EXISTS FOR (2026-08-14). RC's app mounts, shows its own loading spinner, and
// never finishes - in the bot's Playwright Chromium. In the same person's normal Chrome, on
// the same machine and the same IP, it loads fine. Every cheap explanation has been tested
// and killed:
//
//   - NOT RC changing:      their bundle's last-modified is 12 Aug and the bot carted
//                           against that exact build on 13 Aug.
//   - NOT a service worker: /service-worker.js and /sw.js both 403; there isn't one.
//   - NOT the JS syntax:    the most modern thing in the bundle is Object.hasOwn (Chrome 93+).
//   - NOT the profile:      a brand-new profile is blank too, so it is not stale cookies,
//                           cache, Code Cache or corruption.
//   - NOT Playwright moving: the lockfile pins 1.61.1 both before and after the update that
//                           straddles the last working cart.
//   - NOT the WAF:          the failure screenshot is RC's own spinner, not an Access Denied
//                           page or a challenge.
//
// What is left is what the page itself is doing, and nobody has looked. A blank SPA that has
// mounted is waiting on a request or has thrown - and both are visible from the console and
// the network, neither of which any existing tool on this box captures.
//
// NON-DESTRUCTIVE BY CONSTRUCTION. It uses a THROWAWAY profile in the temp directory, so it
// cannot touch .rc-bot-profile, cannot take the profile lock the keep-warm and hold runner
// hand between themselves, and cannot cost a session. It signs into nothing and types no
// credential. Run it any time, including while the bots are up.
//
// HEADFUL, like everything else here: RC/Okta fingerprint headless Chromium, and a headless
// failure proves nothing (see the 2026-08-06 probe finding). Pass --headless only to compare
// the two deliberately.
//
//   node rc-diag.mjs              # the real question
//   node rc-diag.mjs --headless   # only to contrast; never as the answer
//
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = 'https://www.reservecalifornia.com/';
const HEADLESS = process.argv.includes('--headless');
// Long enough that a slow API call is not mistaken for a hung one. The spinner has been
// observed sitting for minutes, so 25s is generous rather than optimistic.
const SETTLE_MS = 25_000;

const consoleErrors = [];
const pageErrors = [];
const failed = [];
const httpErrors = [];
const slow = new Map();

const short = (s, n = 150) => (s.length > n ? s.slice(0, n) + '…' : s);

console.log(`RC blank-page diagnostic - ${HEADLESS ? 'HEADLESS (contrast only)' : 'headful'}`);
console.log('Throwaway profile; .rc-bot-profile is not touched and no credential is typed.\n');

// A plain fetch FIRST, from this same machine and IP. If this succeeds and the browser does
// not, the network is exonerated in one line and the question is entirely about the browser.
try {
  const res = await fetch(HOME, { redirect: 'follow' });
  const body = await res.text();
  console.log(`node fetch:  HTTP ${res.status}, ${body.length} bytes of shell`);
} catch (e) {
  console.log(`node fetch:  FAILED - ${e.message}`);
  console.log('             The network cannot reach RC from this box at all, which is a');
  console.log('             different and larger problem than the blank page.');
}

const profile = mkdtempSync(join(tmpdir(), 'rc-diag-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: HEADLESS,
  viewport: null,
  args: ['--hide-crash-restore-bubble'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

page.on('pageerror', (e) => pageErrors.push(short(String(e), 300)));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(short(m.text(), 300));
});
page.on('request', (r) => slow.set(r, Date.now()));
page.on('requestfailed', (r) => {
  failed.push(`${short(r.url(), 110)}  <- ${r.failure()?.errorText ?? 'unknown'}`);
  slow.delete(r);
});
page.on('response', (r) => {
  if (r.status() >= 400) httpErrors.push(`${r.status()}  ${short(r.url(), 110)}`);
  slow.delete(r.request());
});

try {
  await page.goto(HOME, { waitUntil: 'load', timeout: 60_000 });
} catch (e) {
  console.log(`\ngoto FAILED: ${short(e.message, 200)}`);
}
await page.waitForTimeout(SETTLE_MS);

const ua = await page.evaluate(() => navigator.userAgent).catch(() => '(unreadable)');
const text = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).trim();
const nodes = await page.evaluate(() => document.body?.querySelectorAll('*').length ?? 0).catch(() => 0);
// The exact selectors rc-autologin.mjs hunts for, so this answers ITS question and not a
// similar-looking one of my own.
const loginLinks = await page
  .locator('a:has-text("Log in"), button:has-text("Log in"), a:has-text("Sign In"), button:has-text("Sign In")')
  .count()
  .catch(() => -1);

console.log(`\nchromium:    ${ctx.browser()?.version() ?? '(unknown)'}`);
console.log(`user agent:  ${ua}`);
console.log(`title:       ${JSON.stringify(await page.title().catch(() => ''))}`);
console.log(`DOM nodes:   ${nodes}`);
console.log(`body text:   ${text.length} chars`);
console.log(`  ${JSON.stringify(short(text, 220))}`);
console.log(`"Log in" controls found: ${loginLinks}   <- rc-autologin needs >= 1`);

// STILL IN FLIGHT is the headline for a permanent spinner: a request that never came back is
// invisible to every other category here, and it is the single most likely cause.
const pending = [...slow.keys()].map((r) => `${short(r.url(), 110)}  (${Date.now() - slow.get(r)}ms and counting)`);

const section = (title, rows, empty) => {
  console.log(`\n--- ${title} (${rows.length}) ---`);
  if (!rows.length) console.log(`  ${empty}`);
  else rows.slice(0, 15).forEach((r) => console.log('  ' + r));
  if (rows.length > 15) console.log(`  ... and ${rows.length - 15} more`);
};

section('uncaught page errors', pageErrors, 'none - the app did not throw');
section('console errors', consoleErrors, 'none');
section('requests STILL IN FLIGHT', pending, 'none - nothing is hanging');
section('failed requests', failed, 'none');
section('HTTP >= 400', httpErrors, 'none');

const shot = 'logs\\rc-diag.png';
await page.screenshot({ path: shot }).catch(() => {});
console.log(`\nscreenshot: ${shot}`);

console.log('\nHOW TO READ IT');
console.log('  page errors / console errors  -> the app threw; the message names the cause.');
console.log('  requests still in flight      -> it is waiting on that URL. That is the spinner.');
console.log('  HTTP >= 400 on an RC api call -> RC is refusing this browser specifically.');
console.log('  all five empty but 0 nodes    -> it never booted; suspect the browser build.');
console.log('  all five empty and it RENDERS -> the throwaway profile works and the real one');
console.log('                                   does not, which contradicts the fresh-profile');
console.log('                                   test and is worth re-running before believing.');

await ctx.close();
