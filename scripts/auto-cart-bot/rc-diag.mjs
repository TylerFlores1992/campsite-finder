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
//   - the PROFILE is still open. It looked ruled out - "a brand-new profile is blank too" -
//                           but that test never ran: every `ren .rc-bot-profile` was typed
//                           from the wrong directory and answered "cannot find the file",
//                           so the "fresh" profile was the old one. Treat it as untested.
//   - NOT Playwright moving: the lockfile pins 1.61.1 both before and after the update that
//                           straddles the last working cart.
//   - NOT the WAF:          the failure screenshot is RC's own spinner, not an Access Denied
//                           page or a challenge.
//
// What is left is what the page itself is doing, and nobody has looked. A blank SPA that has
// mounted is waiting on a request or has thrown - and both are visible from the console and
// the network, neither of which any existing tool on this box captures.
//
// NON-DESTRUCTIVE BY DEFAULT. It uses a THROWAWAY profile in the temp directory, so it
// cannot touch .rc-bot-profile, cannot take the profile lock the keep-warm and hold runner
// hand between themselves, and cannot cost a session. It signs into nothing and types no
// credential either way. Run it any time, including while the bots are up.
//
// The ONE exception is --real-profile, which opens the bot's actual profile and therefore
// needs the RC pair stopped first. It still types no credential and signs into nothing.
//
// HEADFUL, like everything else here: RC/Okta fingerprint headless Chromium, and a headless
// failure proves nothing (see the 2026-08-06 probe finding). Pass --headless only to compare
// the two deliberately.
//
// IT MUST CHANGE ONE THING AT A TIME. The first version of this file launched a throwaway
// profile with NO token-capture hook, and it rendered RC perfectly - which looked like proof
// that the bot's profile was at fault. It was not proof of anything: it differed from the bot
// in TWO ways at once (the profile AND the hook), so a pass could not say which mattered.
// That is the same confound that made "2-segment messages get filtered" look certain when the
// real variable was the link domain. So both are flags now, and the answer needs the 2x2:
//
//   node rc-diag.mjs                        # throwaway profile, no hook   (renders, 2026-08-14)
//   node rc-diag.mjs --capture              # throwaway profile, WITH hook <- isolates the hook
//   node rc-diag.mjs --real-profile         # the bot's profile, no hook   <- isolates the profile
//   node rc-diag.mjs --real-profile --capture   # the bot exactly; must reproduce the blank page
//
// --real-profile TAKES THE REAL PROFILE, so stop the bots first or Chromium will refuse it:
//   powershell -ep Bypass -File mini-pc\stop-rc.ps1
//
//   node rc-diag.mjs --headless   # only to contrast; never as the answer
//
import { chromium } from 'playwright';
import { installTokenCapture } from './rc-token.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = 'https://www.reservecalifornia.com/';
const HEADLESS = process.argv.includes('--headless');
const CAPTURE = process.argv.includes('--capture');
const REAL_PROFILE = process.argv.includes('--real-profile');
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
console.log(`  profile:       ${REAL_PROFILE ? 'THE BOT\'S OWN .rc-bot-profile' : 'throwaway (temp dir)'}`);
console.log(`  token capture: ${CAPTURE ? 'INSTALLED (as the bot does)' : 'not installed'}`);
console.log('No credential is typed and nothing is signed into, either way.\n');

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

const here = dirname(fileURLToPath(import.meta.url));
const profile = REAL_PROFILE
  ? join(here, '.rc-bot-profile')
  : mkdtempSync(join(tmpdir(), 'rc-diag-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: HEADLESS,
  viewport: null,
  args: ['--hide-crash-restore-bubble'],
});
// BEFORE the first navigation, exactly as rc-keepwarm.mjs does it - installed afterwards it
// would miss the calls it exists to watch, and would also be a different experiment from the
// one the bot runs.
if (CAPTURE) await installTokenCapture(ctx);
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
console.log('\nTHE 2x2 - run all four before concluding anything');
console.log('  plain RENDERS, --capture BLANK        -> the token-capture hook is the cause.');
console.log('  plain RENDERS, --capture RENDERS,');
console.log('    --real-profile BLANK                -> the profile is the cause.');
console.log('  both --real-profile runs RENDER       -> it is neither, and the difference is');
console.log('                                           something the bot does after launch.');
console.log('  NOTHING is blank                      -> it has stopped reproducing; say so');
console.log('                                           rather than declaring it fixed.');

await ctx.close();
