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
import { spawn } from 'node:child_process';
import { loadEnv, envSource, looksLikePlaceholder } from './load-env.mjs';
import { exitWhenDrained } from './exit-clean.mjs';

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
/** One hand-off per process life. The updater restarts us; a second spawn would mean two
 *  updaters racing over the same checkout. */
let updateStartedAt = 0;
// A HAND-OFF THAT ACHIEVED NOTHING MUST BE RETRIED. This was a boolean that latched for
// the life of the process: auto-update.ps1 exits 0 when its guard refuses (too close to a
// release, feed unreachable), nothing is applied, the request stays pending - and the
// runner never tried again. Observed 2026-08-11. Long enough that two updaters can never
// race over one checkout, short enough that "as soon as it is safe" means something.
const UPDATE_RETRY_MS = 15 * 60_000;
const HEADLESS = process.env.RC_HEADLESS === 'true';

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
    headers: { authorization: `Bearer ${TOKEN}` },
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

async function runPass() {
  let work;
  try {
    work = await feed();
  } catch (err) {
    log(`feed error: ${err.message}`);
    return;
  }
  const { claim = [], cart = [], release = [], expired = 0, pollMs, updateRequested } = work;

  // AN UPDATE ASKED FOR FROM THE ADMIN PAGE. The box has no inbound path, so the request
  // rides this poll — see migration 051. All this does is hand off to auto-update.ps1,
  // which re-checks the release guard itself: "now" means "as soon as it is safe", because
  // an update ends the RC session and doing that minutes before a cart loses the site.
  //
  // Fire-and-forget and NOT awaited: the updater kills this very process on its way
  // through, so waiting for it would be waiting to be killed. `detached` so being killed
  // does not take the updater down with us — the mistake that would leave the box halfway
  // between two commits.
  if (updateRequested && Date.now() - updateStartedAt > UPDATE_RETRY_MS) {
    updateStartedAt = Date.now();
    // HERE (this file's own directory), NEVER process.cwd(). The two happen to agree when start-all launches us,
    // and diverge the moment anything else does — and a wrong -File path makes PowerShell
    // exit immediately with a message we throw away, so the symptom is total silence: no
    // auto-update.log, no report, and this line still claiming the hand-off happened.
    const script = path.join(HERE, 'mini-pc', 'auto-update.ps1');
    log(`→ update requested — handing off to ${script}`);
    // SAY IT IS MISSING RATHER THAN LAUNCHING AT NOTHING. Checked here because the failure
    // is otherwise indistinguishable from the script running and doing nothing.
    if (!fs.existsSync(script)) {
      log(`  ✗ ${script} does not exist — cannot update`);
      updateStartedAt = 0;
    } else try {
      // stdio TO A FILE, NEVER 'ignore'. With output discarded, a PowerShell that starts
      // and dies immediately - a bad -File path, a policy refusal, a parse error - is
      // indistinguishable from one that never started, and that ambiguity is what made
      // this take all night. Whatever the child says now lands on disk.
      //
      // The marker is written BEFORE the spawn, so the file exists even if the launch
      // itself is what fails. "No file" can then only mean the runner never got here.
      const spawnLog = path.join(HERE, 'logs', 'update-spawn.log');
      try {
        fs.mkdirSync(path.dirname(spawnLog), { recursive: true });
        fs.appendFileSync(spawnLog, `\n=== ${new Date().toISOString()} launching ${script}\n`);
      } catch { /* best effort - never block the hand-off on logging it */ }
      const out = fs.openSync(spawnLog, 'a');
      const ps = spawn('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      ], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
      // spawn() reports ENOENT via an 'error' EVENT, not by throwing — so the try/catch
      // below never sees it, and an 'error' with no listener takes the whole runner down.
      // Two failure modes, both invisible, both fixed by listening.
      ps.on('error', (e) => {
        log(`  ✗ could not start powershell: ${e.message}`);
        updateStartedAt = 0;
      });
      ps.unref();
      // The parent's copy is closed straight away; the child keeps its own handles, which
      // is what lets this survive the updater killing us.
      try { fs.closeSync(out); } catch { /* the child owns it now */ }
    } catch (err) {
      log(`  update hand-off failed: ${err.message}`);
      updateStartedAt = 0;
    }
  }
  // The server sets pollMs while anything is claimable. Somebody is watching a spinner
  // and the site is about to sit unheld — the exposure window is our poll interval plus
  // the release, so this is the one time to come back fast.
  nextPollMs = pollMs || POLL_MS;
  if (expired) log(`(${expired} unanswered offer(s) expired)`);
  if (!claim.length && !cart.length && !release.length) {
    // Silence is right on the 20s loop and wrong for a smoke test: with nothing to do and
    // nothing printed, a successful pass looks exactly like a crash — which is how the
    // libuv exit assertion read on 2026-08-07.
    if (ONCE) log('nothing to hand over, cart, or release. Feed reachable, token accepted.');
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
