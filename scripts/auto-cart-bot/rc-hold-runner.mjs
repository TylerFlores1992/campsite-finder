/**
 * RC day-before holds — the bot half.
 *
 * CampHawk tells a subscriber the night before that a site releases at 8am. If they tap
 * "hold it for me", this carts that exact unit at that exact minute and hands it over.
 *
 * Two jobs, one pass, both from `GET /api/auto-cart/rc-holds`:
 *   cart[]    holds that were REQUESTED and are due now
 *   release[] holds we carted that nobody claimed — the bot must LET GO
 *
 * The release half is not housekeeping. Sitting on a site the user never came for takes
 * it off the market for every other camper, which is the exact behaviour the opt-in
 * design exists to avoid. It is as much the job as the carting is.
 *
 * RUN IT ON THE MINI-PC, next to rc-keepwarm.mjs:
 *   AUTOCART_TOKEN=... node rc-hold-runner.mjs
 *   AUTOCART_TOKEN=... node rc-hold-runner.mjs --once   # one pass, for a smoke test
 *
 * IT DOES NOT LOG IN. It drives the profile rc-keepwarm.mjs keeps alive, and if that
 * session is dead it says so and skips. RC now serves a reCAPTCHA on sign-in, so an
 * automatic login is not available — and attempting one is what we believe provoked the
 * challenge in the first place.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { precartInPage, findCartEntry, releaseEntry, NO_CART } from './rc-cart.mjs';
import {
  waitForProfileLock, releaseProfileLockIfMine, renewProfileLock, profileLockHolder, forceProfileLock,
  requestProfile, clearProfileRequest,
} from './profile-lock.mjs';
import { installTokenCapture, primeToken, tokenSecondsLeft } from './rc-token.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { loadEnv, envSource, looksLikePlaceholder } from './load-env.mjs';
import { exitWhenDrained } from './exit-clean.mjs';
import { makeControlChannel } from './control-channel.mjs';

// The token lives in scripts/auto-cart-bot/.env alongside the rec.gov bot's. Without
// this the runner answered `feed 401` — which reads exactly like a wrong token, not a
// config file nobody opened — and start-all.bat, which passes no environment of its own,
// would have failed that way on every boot.
loadEnv(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RC_HOME = 'https://www.reservecalifornia.com/';
const PROFILE_DIR = path.resolve(HERE, process.env.RC_PROFILE_DIR || '.rc-bot-profile');

const CAMPHAWK_URL = (process.env.CAMPHAWK_URL || 'https://camphawk.app').replace(/\/$/, '');
const TOKEN = process.env.AUTOCART_TOKEN;
/**
 * How often to ask for work. RC releases on the minute and the feed already looks 90s
 * ahead, so this only has to be tight enough that we are always inside the window with
 * time to open a browser. Tighter than this would just add requests from an address that
 * has been 403'd once.
 *
 * 15s, matching the poller's own cycle. The number that actually matters for a contested
 * site is the RETRY gap after a failed cart, and the feed drives that separately (see
 * `pollMs` in the route) — the idle cadence is not the thing standing between a user and
 * their site.
 */
const POLL_MS = Number(process.env.RC_HOLD_POLL_MS || 15_000);
/** Overridden by the feed's `pollMs` while a claim is outstanding. */
let nextPollMs = POLL_MS;
// The update hand-off and the diagnostics queue live in control-channel.mjs, shared with
// bot.mjs. The retry window and the spawn's hard-won Windows details went with them.
const HEADLESS = process.env.RC_HEADLESS === 'true';

/**
 * WHAT CODE IS THIS BOX RUNNING? Reported on every feed poll so the server can answer it
 * without anybody asking.
 *
 * `autocart.rc_runner` proves this process can reach camphawk.app and `autocart.rc_session`
 * proves RC accepts our token. Neither says whether the checkout is current — and the
 * halves of this system deploy by different routes, which is the most expensive recurring
 * failure in the log. `bot_commands`' `git-status` can answer it, but only when somebody
 * asks; a header on a poll that already happens is passive and continuous.
 *
 * COMPUTED ONCE, AT STARTUP, NOT PER POLL. This loop runs every 15 seconds and spawning
 * two git processes each time would be pure waste on the hot path that carts a site. It is
 * also CORRECT to cache: the checkout cannot change under a running process without the
 * updater stopping it first — that is what auto-update.ps1 does, and the restart is what
 * re-reads this.
 *
 * A FAILURE HERE IS SILENT AND MUST BE. git missing, a shallow clone, a detached HEAD, no
 * repo at all: every one of those leaves the headers off, the server records NULL, and the
 * check says "we do not know what code the box runs". That is a warn. What it must never
 * do is take down the runner — a diagnostic that can stop a cart is not worth having, the
 * same rule the report channel and the diagnostics queue already follow.
 */
function botCommit() {
  const git = (...a) => execFileSync('git', a, { cwd: HERE, encoding: 'utf8', timeout: 5_000 }).trim();
  try {
    return { sha: git('rev-parse', 'HEAD'), at: git('log', '-1', '--format=%cI') };
  } catch {
    return { sha: null, at: null };
  }
}
const BOT_COMMIT = botCommit();

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Now, as an RC-style Pacific wall-clock string — the same shape as `release_at`. */
function pacificNow() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
}

/**
 * Milliseconds until a hold's release, from a zone-less Pacific `release_at`.
 *
 * Both sides are parsed AS IF UTC, which is correct because both are wall-clock in the
 * same zone and the offset cancels. It would only mislead across a DST transition, and
 * this is only ever asked about gaps of a few minutes.
 *
 * Never parse `release_at` with `new Date()` directly: a zone-less string is read as local
 * time on a box whose timezone we do not control, which silently shifts the hour — the
 * same trap that made an alert say "Sep 3" for a Sep 4 stay.
 */
function msUntilRelease(releaseAt) {
  const ms = Date.parse(`${releaseAt}Z`) - Date.parse(`${pacificNow()}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The feed serves a hold up to 90 seconds EARLY so the browser can be open and the token
 * in hand when the site frees. That lead is for getting READY — it is not permission to
 * submit. Carting early asks RC for a site it has not released yet, and RC answers, quite
 * correctly, "The unit is not available for the date(s) specified".
 *
 * On 2026-08-08 that is exactly what happened: the one attempt fired at 07:58:35 PT for an
 * 08:00:00 release, the server wrote it down as `failed`, and `failed` is terminal — so
 * there was never a second attempt. The server no longer treats an early failure as final
 * (see `reportCartFailure`), which alone would have carted this hold on a later pass; this
 * makes the first attempt the RIGHT one instead of relying on the retry.
 *
 * Capped so a malformed or mis-zoned timestamp can never park the pass — the claims and
 * releases have already been done by the time we get here, but a wedged runner is still
 * the failure mode this whole file exists to avoid.
 */
const MAX_RELEASE_WAIT_MS = 3 * 60_000;

/** Where AUTOCART_TOKEN came from — printed on any auth failure. See load-env.mjs. */
const TOKEN_SOURCE = envSource('AUTOCART_TOKEN');

if (!TOKEN) {
  console.error('No AUTOCART_TOKEN. Put it in scripts/auto-cart-bot/.env, next to the');
  console.error('rec.gov bot\'s — it is on Vercel under CampHawk → Settings → Environment Variables.');
  process.exit(2);
}
if (looksLikePlaceholder(TOKEN)) {
  // A pasted placeholder is set, so it passes the check above, and an exported one BEATS
  // the .env file by design — so the symptom is a 401 while the file on disk is perfect.
  console.error(`AUTOCART_TOKEN (from the ${TOKEN_SOURCE}) contains a bracket or a space, so it is`);
  console.error('almost certainly a placeholder pasted from instructions, not the real token.');
  if (TOKEN_SOURCE === 'shell') {
    console.error('It came from the shell, which overrides .env on purpose. Clear it and re-run:');
    console.error('  Remove-Item Env:AUTOCART_TOKEN        (PowerShell)');
  }
  process.exit(2);
}
if (!fs.existsSync(PROFILE_DIR)) {
  console.error(`No RC profile at ${PROFILE_DIR}. Run: node rc-keepwarm.mjs --login`);
  process.exit(2);
}

async function feed() {
  const res = await fetch(`${CAMPHAWK_URL}/api/auto-cart/rc-holds`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      // THIS is the poll `beat_at` is about, and saying so explicitly is what lets the other
      // callers of this feed be excluded. Stated rather than assumed: the server still
      // stamps for an unidentified caller, so an older runner keeps working, but a box
      // running this code makes the heartbeat mean what it claims to.
      'x-bot-role': 'rc-hold-runner',
      // Omitted entirely when unknown, rather than sent as a string saying so. An absent
      // header and a header reading "unknown" would both have to be handled server-side,
      // and only one of them cannot be mistaken for a value.
      ...(BOT_COMMIT.sha ? { 'x-bot-commit': BOT_COMMIT.sha } : {}),
      ...(BOT_COMMIT.at ? { 'x-bot-commit-at': BOT_COMMIT.at } : {}),
    },
  });
  // A bare `feed 401` says the token is wrong and nothing about WHICH token — and the
  // shell silently outranks .env, so the one you would go and check is not the one in
  // use. Name the source; that is the whole difference between a one-line fix and an
  // evening of pulling the repo again.
  if (res.status === 401) {
    throw new Error(
      `feed 401 — camphawk.app rejected AUTOCART_TOKEN (taken from the ${TOKEN_SOURCE})` +
        (TOKEN_SOURCE === 'shell'
          ? '. The shell overrides .env by design; `Remove-Item Env:AUTOCART_TOKEN` and re-run to use the file.'
          : '. Check it against Vercel → CampHawk → Settings → Environment Variables → AUTOCART_TOKEN.')
    );
  }
  if (!res.ok) throw new Error(`feed ${res.status}`);
  return res.json();
}

/** The shared control handler — same code bot.mjs runs off the roster feed. */
const control = makeControlChannel({
  dir: HERE, actor: 'rc-hold-runner', log, report: (body) => report(body),
});

async function report(body) {
  await fetch(`${CAMPHAWK_URL}/api/auto-cart/rc-holds`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e) => log(`  report failed for ${body.id}: ${e.message}`));
}

/** RC's rdApi wants the token in BOTH headers, plus two constants. */
const rcHeaders = (token) => ({
  'Content-Type': 'application/json',
  accesstoken: token,
  authorization: 'Bearer ' + token,
  installationsidentity: 'cali',
  storeid: '111',
});

const LOCK_OWNER = 'rc-hold-runner';
const RENEW_MS = 2 * 60_000;
/** Generous, because we are the process that must win. `rc-keepwarm` holds the profile
 *  for ~15s a pass and yields quickly; waiting that out beats colliding. */
const LOCK_WAIT_MS = Number(process.env.RC_PROFILE_LOCK_WAIT_MS || 60_000);

/**
 * `rc-keepwarm.mjs` opens the SAME profile directory every 20 minutes, and two Chromium
 * instances on one user-data-dir do not fail cleanly — they end up disagreeing about what
 * is in the profile (observed on the rec.gov bot, 2026-07-29; see profile-lock.mjs). On
 * this profile that means the session, which is the one thing here we cannot rebuild
 * without a human.
 *
 * If the lock never comes free we do NOT proceed anyway. Nothing is lost by skipping:
 * requested holds stay requested, the feed's 20-minute grace window still returns them,
 * and a claim is retried on the next pass a second later.
 */
/**
 * Returns `{ skipped: '<reason>' }` rather than a bare null, because the reason is the
 * whole point.
 *
 * ON 2026-08-07 THIS FUNCTION RETURNING NULL WAS INVISIBLE. Every path below leaves the
 * hold rows untouched — no status change, no `updated_at`, no error — while the runner
 * carries on polling the feed, which is what stamps the liveness beacon. So the process
 * looked healthy from the server, the row looked untouched, and a user lost a site. The
 * caller now reports the reason against the affected holds; see migration 046.
 */
async function withRC(fn) {
  // ASK FIRST. rc-keepwarm now holds the profile resident (it has to — RC only renews its
  // token while a page is loaded), so a plain wait would time out every single time, at
  // 08:00:00, on the one job that matters. The flag makes it stand down within a second.
  requestProfile(PROFILE_DIR, LOCK_OWNER);
  const requestedAt = Date.now();
  try {
    return await withRCLocked(fn, requestedAt);
  } finally {
    // ALWAYS, including the failure paths — a request left behind keeps the keep-warm
    // stood down indefinitely, which would kill the session it exists to preserve.
    clearProfileRequest(PROFILE_DIR);
  }
}

async function withRCLocked(fn, requestedAt = Date.now()) {
  let forced = null;
  if (!(await waitForProfileLock(PROFILE_DIR, LOCK_OWNER, LOCK_WAIT_MS))) {
    // COOPERATIVE PREEMPTION HAS FAILED. The holder has had the standing request for the
    // whole lock wait and has not stood down, which means its loop is not reading the flag
    // — the 2026-08-10 wedge, where the keep-warm renewed the lock from a timer for ten
    // hours while doing nothing. Take it by force: kill the recorded pid, then acquire.
    // See forceProfileLock for why killing first is the SAFE order.
    forced = forceProfileLock(PROFILE_DIR, LOCK_OWNER, requestedAt, LOCK_WAIT_MS);
    if (!forced) {
      const held = profileLockHolder(PROFILE_DIR);
      log(`⚠ profile held by ${held?.owner ?? 'another process'} — skipping this pass, work stays queued`);
      return { skipped: `Chromium profile held by ${held?.owner ?? 'another process'}` };
    }
    // LOUD IN THE LOG, and deliberately NOT posted: the feed has no wire shape for "a
    // thing happened that was not about a hold", and inventing one that the server quietly
    // ignores is the failure mode this whole morning was made of. The wedge that forces
    // this is already alarmed server-side by the stale-verdict dead-man's switch, which is
    // where it belongs — this line is for whoever reads the mini-PC log afterwards.
    log(`⚠ ${forced}`);
  }
  const renew = setInterval(() => renewProfileLock(PROFILE_DIR, LOCK_OWNER), RENEW_MS);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  }).catch((err) => {
    clearInterval(renew);
    releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER);
    throw err;
  });
  try {
    // BEFORE navigating. RC's real token is AES-encrypted by Okta and only decrypted in
    // page memory (rc-token.mjs) — the localStorage copy this used to read is not what the
    // app sends, so carting with it risks a 401 at 08:00:00 against a healthy session.
    await installTokenCapture(ctx);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(RC_HOME, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const { token, source } = await primeToken(page);
    if (token) log(`  RC token acquired (${source})`);
    if (!token) {
      log('⚠ RC session is dead — a human must run `node rc-keepwarm.mjs --login`.');
      log('  Skipping this pass. Nothing is lost: holds stay requested and retry.');
      // Tell the server too. Keep-warm is the process that normally reports this, so a
      // dead session showing up HERE also means keep-warm is not doing its job — which
      // is why the report carries its source.
      await reportSession(false, 'no RC token at all — neither live nor stored');
      return { skipped: 'RC session is dead — needs a human sign-in' };
    }
    // A working token is worth reporting as loudly as a broken one: it is the only
    // positive confirmation that comes from actually doing the job rather than probing.
    //
    // BUT "A TOKEN EXISTS" IS NOT "THE SESSION IS LIVE", and reporting it as such was a
    // FALSE GREEN — caught 2026-08-09 05:42:38Z. The access token had expired at ~05:36
    // and okta-auth-js had not yet cleared it, so `primeToken` returned the dead one from
    // localStorage and this line announced a healthy session. It overwrote keep-warm's
    // correct "dead" verdict, moved `session_live_since` (corrupting the very lifetime
    // measurement migration 047 exists to take), and would have told the 07:30 pre-flight
    // that everything was fine 80 seconds before keep-warm said otherwise. That is the
    // 2026-08-07 failure exactly: a green check over a dead session.
    //
    // Same family as `notifications.status = 'sent'` meaning only "Twilio returned 2xx",
    // and `IsSuccess: true` on a cart that held nothing. Presence is not liveness.
    //
    // The fix is a LOCAL expiry check, not a network probe. `tokenSecondsLeft` decodes the
    // JWT in memory — no round trip — because the reason this report is fire-and-forget
    // stands: at 08:00:00.000 nothing may go in front of the precart. An expired token now
    // reports what it is. `null` (undecodable) is NOT claimed as live either; keep-warm
    // asks RC properly every pass and is the authority on a positive verdict.
    const left = tokenSecondsLeft(token);
    if (left != null && left > 0) void reportSession(true, null);
    else if (left != null) void reportSession(false, `token expired ${Math.round(-left / 60)}m ago — the app has not renewed it`);
    // left == null: say nothing. An undecodable token is not evidence either way, and a
    // guess here overwrites a real measurement from keep-warm.
    return await fn(ctx, page, token);
  } finally {
    await ctx.close().catch(() => {});
    clearInterval(renew);
    releaseProfileLockIfMine(PROFILE_DIR, LOCK_OWNER);
  }
}

/** Fire-and-forget: a health report must never be able to break a cart. */
async function reportSession(live, why) {
  await fetch(`${CAMPHAWK_URL}/api/auto-cart/rc-holds`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session: { live, why }, source: 'runner' }),
  }).catch(() => {});
}

/**
 * `--once` WITH NOTHING QUEUED USED TO PROVE ALMOST NOTHING, AND SAID OTHERWISE.
 *
 * The line it printed was:
 *
 *     nothing to hand over, cart, or release. Feed reachable, token accepted.
 *
 * "Feed reachable" was true. **"token accepted" was never tested.** That message sat above
 * the early return, so on the quiet path — which is nearly every path, since holds are due
 * for about ninety seconds a day — `withRC` was never called: no profile opened, no browser
 * launched, no token read, no request made to RC. It asserted the one fact it had not
 * checked, which is `notifications.status = 'sent'` meaning only "Twilio returned 2xx", in
 * the diagnostic somebody runs BECAUSE they are worried.
 *
 * `rc-check.bat` runs exactly this as its step 1. Its step 2 (`rc-keepwarm --once`) does ask
 * RC a real question, so the whole check was never worthless — but step 2 is also the one
 * CLAUDE.md already records as reassuring in the fatal case, because "profile busy" reads as
 * fine. Two steps that can both look healthy while nothing was proven is how 2026-08-07
 * happened, and it is worth one browser launch to close.
 *
 * SO THE QUIET PASS NOW EXERCISES THE SESSION, which is the only part it leaves untested.
 * `withRC` already does the whole job — takes the profile (preempting the resident keep-warm,
 * cooperatively, or forcing a wedged one), launches Chromium, primes the real in-page token,
 * decodes its expiry locally and reports the verdict. A no-op callback is therefore a
 * complete rehearsal of everything up to the two cart POSTs, and those cannot be rehearsed:
 * exercising them needs a genuine held unit, and an invented one can collide with a real site
 * and lock it.
 *
 * IT MAY TAKE THE PROFILE FOR A FEW SECONDS, AND THAT IS ACCEPTABLE HERE because `--once` is
 * only ever run by a human — the 20-second loop never reaches this branch with `ONCE` set.
 * The hand-off is the same mechanism a real cart uses and the keep-warm reopens straight
 * after; a person asking "is this working?" is accepting that trade by asking.
 *
 * THREE OUTCOMES, KEPT APART. A pass, a dead session, and "could not get the profile" are
 * different facts with different next moves, and collapsing the third into either of the
 * others is the whole bug being fixed.
 */
async function smokeTest() {
  log('nothing to hand over, cart, or release — feed reachable.');
  log('Exercising the RC session, which is the only part a quiet pass leaves untested...');

  const out = await withRC(async (_ctx, _page, token) => ({
    left: tokenSecondsLeft(token),
  })).catch((err) => ({ error: err.message }));

  if (out?.error) {
    log(`✗ could not open the RC profile: ${out.error}`);
    log('  The SESSION was not tested. This is not a verdict on it either way.');
    return;
  }
  if (out?.skipped) {
    // withRC returns this for BOTH a dead session and a profile we could not take, and its
    // own strings already say which. Passing the reason through verbatim beats matching on
    // it here and getting the two backwards.
    log(`✗ ${out.skipped}`);
    return;
  }
  const left = out?.left;
  if (left == null) {
    // An undecodable token is not evidence either way — the same rule withRC applies before
    // it declines to report one. Do not round it up to a pass.
    log('? a token was acquired but will not decode — nothing proven. rc-keepwarm --once asks RC directly.');
    return;
  }
  if (left <= 0) {
    log(`✗ the token expired ${Math.round(-left / 60)}m ago — the app has not renewed it.`);
    log('  A hold due now would not cart. Run rc-login.bat.');
    return;
  }
  log(`✓ RC session works: token valid for ${Math.round(left / 60)}m, profile opened, feed reachable.`);
  log('  NOT tested: the two cart POSTs. Those need a real held unit and cannot be rehearsed.');
}

async function runPass() {
  let work;
  try {
    work = await feed();
  } catch (err) {
    log(`feed error: ${err.message}`);
    return;
  }
  const { claim = [], cart = [], release = [], expired = 0, pollMs, updateRequested, commands = [] } = work;

  // DIAGNOSTICS AND THE UPDATE FLAG, in the shared handler. Never awaited: a question
  // about a log file must not be able to delay a cart at 08:00:00.
  //
  // THE SAME BLOCK IS READ BY bot.mjs OFF THE ROSTER FEED. This process died at 09:36 PT on
  // 2026-08-11 and took every remote lever with it, while the rec.gov bot polled on quite
  // happily — so the channel now rides whichever feed is alive. One module, because the copy
  // that gets forgotten is by definition the one running when the other is dead.
  control({ commands, updateRequested });

  // The server sets pollMs while anything is claimable. Somebody is watching a spinner
  // and the site is about to sit unheld — the exposure window is our poll interval plus
  // the release, so this is the one time to come back fast.
  nextPollMs = pollMs || POLL_MS;
  if (expired) log(`(${expired} unanswered offer(s) expired)`);
  if (!claim.length && !cart.length && !release.length) {
    // Silence is right on the 20s loop and wrong for a smoke test: with nothing to do and
    // nothing printed, a successful pass looks exactly like a crash — which is how the
    // libuv exit assertion read on 2026-08-07.
    if (ONCE) await smokeTest();
    return;
  }

  log(`${claim.length} to hand over, ${cart.length} to cart, ${release.length} to release`);

  const outcome = await withRC(async (ctx, page, token) => {
    const headers = rcHeaders(token);

    // CLAIMS FIRST, ahead of everything. A user is on the claim page right now and
    // cannot take the site until we let go; every millisecond here is theirs, not ours.
    for (const h of claim) {
      if (!h.cartKey || !h.cartEntryKey) {
        log(`  ${h.unitName ?? h.unitId}: claim with no entry key — reporting released so the user is not stuck`);
        await report({ id: h.id, released: true, forClaim: true });
        continue;
      }
      const r = await releaseEntry(ctx.request, headers, h.cartKey, h.cartEntryKey);
      log(`  → handed over ${h.unitName ?? h.unitId} (HTTP ${r.status})`);
      // Report even on a non-2xx: if we cannot release, the user must not be left
      // watching a spinner over a site they will never get. Better they find it free
      // (or not) on RC than wait on us forever.
      await report({ id: h.id, released: true, forClaim: true });
    }

    // Then release the ones nobody came for. If the browser dies mid-pass, the thing we
    // most want already done is letting go — a hold we keep by accident is worse than a
    // cart we miss, because it denies the site to everyone including the person who
    // asked for it.
    for (const h of release) {
      if (!h.cartKey || !h.cartEntryKey) {
        log(`  ${h.unitName ?? h.unitId}: no cart/entry key recorded — cannot release precisely, leaving it`);
        continue;
      }
      const r = await releaseEntry(ctx.request, headers, h.cartKey, h.cartEntryKey);
      log(`  released ${h.unitName ?? h.unitId} → HTTP ${r.status}`);
      if (r.ok) await report({ id: h.id, released: true });
    }

    for (const h of cart) {
      try {
        // WAIT OUT THE LEAD. Browser open, token in hand — that was the point of being
        // handed this 90 seconds early. Submitting now would ask RC for a site it has not
        // released yet and get a "not available" that means nothing.
        const wait = Math.min(msUntilRelease(h.releaseAt), MAX_RELEASE_WAIT_MS);
        if (wait > 0) {
          log(`  ready for ${h.unitName ?? h.unitId} — holding ${(wait / 1000).toFixed(1)}s until ${h.releaseAt} PT`);
          await sleep(wait);
        }

        const existing = await page.evaluate(() => {
          try { return localStorage.getItem('shoppingCartKey'); } catch { return null; }
        });
        const result = await precartInPage(page, {
          unitId: Number(h.unitId),
          arrival: h.arrivalDate,
          nights: Number(h.nights) || 1,
          cartKey: existing || NO_CART,
        });

        // RC ANSWERS 200 WITH IsSuccess:false, and "cart is already added" is a REJECTED
        // submit on top of a site we already hold — proof, not failure. So the verdict
        // comes from reading the cart back, never from the flag.
        const cartKey = result?.submitted?.v?.cartKey || result?.finalKey || existing;
        const locked = (() => {
          try { return (JSON.parse(result.loadedFull)?.Result ?? {}).LockedShoppingCart ?? null; }
          catch { return null; }
        })();
        const check = cartKey
          ? await findCartEntry(ctx.request, headers, cartKey, {
              placeId: locked?.placeId, facilityId: locked?.facilityId, unitId: h.unitId,
            })
          : { found: false, entryKey: null };

        if (check.found) {
          log(`  ✓ held ${h.unitName ?? h.unitId} (${h.arrivalDate}) — entry ${check.entryKey}`);
          await report({ id: h.id, ok: true, cartKey, cartEntryKey: check.entryKey });
        } else {
          const why = result?.submitted?.v?.error || `HTTP ${result?.submitted?.status}`;
          log(`  ✗ could not hold ${h.unitName ?? h.unitId}: ${why}`);
          await report({ id: h.id, ok: false, error: String(why).slice(0, 300) });
        }
      } catch (err) {
        log(`  ✗ ${h.unitName ?? h.unitId} threw: ${err.message}`);
        await report({ id: h.id, ok: false, error: err.message.slice(0, 300) });
      }
    }
  });

  // THE PASS DID NOTHING AND NOBODY WOULD HAVE KNOWN. Record the reason against every
  // hold we were about to touch, WITHOUT changing their status — they retry next pass.
  // Without this the row is byte-identical to one no process has ever looked at, which is
  // exactly how 2026-08-07 read six hours after the fact.
  if (outcome?.skipped) {
    const ids = [...claim, ...cart, ...release].map((h) => h.id);
    await fetch(`${CAMPHAWK_URL}/api/auto-cart/rc-holds`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ skipped: true, reason: outcome.skipped, ids }),
    }).catch((e) => log(`  skip report failed: ${e.message}`));
  }
}

log(`RC hold runner → ${CAMPHAWK_URL}, every ${POLL_MS / 1000}s, profile ${PROFILE_DIR}`);
log('It never logs in; rc-keepwarm.mjs owns the session. Ctrl-C to stop.');

// else, NOT a bare if. `exitWhenDrained` sets the exit code and lets the loop finish; it
// does not stop execution the way process.exit() did, so a `--once` run would otherwise
// fall through into the forever loop below and never come back.
if (ONCE) {
  await runPass();
  log('single pass done.');
  exitWhenDrained(0);
} else for (;;) {
  await runPass().catch((err) => log(`pass error: ${err.message}`));
  await sleep(nextPollMs);
}
