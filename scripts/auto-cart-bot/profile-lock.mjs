import fs from 'node:fs';
import path from 'node:path';

/**
 * A cross-process lock on one user's Chromium profile directory.
 *
 * WHY THIS EXISTS. The bot and the broker are separate Node processes that compute
 * the SAME profile path (`profiles/<userId>`) and both call
 * `chromium.launchPersistentContext` on it. Chromium does not expect two instances
 * on one user-data-dir, and the result is not a clean error — it is two browsers
 * disagreeing about what is in the profile.
 *
 * Observed 2026-07-29, which is what prompted this: at 00:19:01 the bot's keepalive
 * reported "rec.gov session kept warm" for the account, while the broker — holding
 * the same profile open since 00:18:40 — was showing that account a logged-OUT
 * rec.gov and could not confirm a sign-in for 45 seconds. One profile, two
 * processes, opposite views of the session.
 *
 * The bot already had an `inUse` Set, but that is in-process and cannot see the
 * broker at all.
 *
 * The lock is advisory and deliberately simple: a JSON file inside the profile
 * directory. It is allowed to go stale, because the alternative — a crashed process
 * locking a user out of auto-cart forever — is worse than the race it prevents.
 */

const LOCK_FILE = '.camphawk-profile-lock';
/** A lock older than this is treated as abandoned (a crash, a killed window). */
const STALE_MS = 10 * 60 * 1000;

const lockPath = (profileDir) => path.join(profileDir, LOCK_FILE);

/**
 * Is the process that wrote this lock still running?
 *
 * `process.kill(pid, 0)` sends nothing — it only asks the OS whether the pid exists. ESRCH is
 * the one answer that means "no such process"; anything else (EPERM above all: it exists and
 * belongs to someone else) is treated as ALIVE, and so is a pid we cannot read. Failing
 * towards "still held" is the safe direction: the worst it costs is the old wait, while
 * failing the other way would open a second Chromium on a profile somebody is using.
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code !== 'ESRCH'; }
}

/**
 * Who holds this profile right now, or null. Stale locks read as free — and so do locks
 * whose writer is PROVABLY GONE.
 *
 * ## A DEAD HOLDER'S LOCK USED TO HOLD FOR UP TO TEN MINUTES, AND IT COST TWICE
 *
 * The lock is renewed by its holder's own timer, so when the holder dies the only thing that
 * ever freed it was STALE_MS. Everything in between was a wait on nobody:
 *
 *   - **2026-09-16**: the keep-warm died at 00:03 UTC, was restarted at 00:04, and printed
 *     `profile busy (rc-keepwarm)` five times over seven and a half minutes — against its OWN
 *     predecessor's lock — with the RC session down the whole time.
 *   - **2026-09-24**: a user pressed claim at 15:12:24 UTC and the hold runner then waited out
 *     its full 60s lock wait before forcing a lock held by `rc-keepwarm (pid 10928, already
 *     gone)`. The site was handed over at 15:13:27, sixty-five seconds after the user asked,
 *     and the user did not get it.
 *
 * STALE_MS is right for a holder we cannot see. A pid the OS says does not exist is not that:
 * it is a fact, and a dead process cannot be corrupted by a second Chromium. So it is free now.
 */
export function profileLockHolder(profileDir) {
  try {
    const raw = fs.readFileSync(lockPath(profileDir), 'utf8');
    const { owner, at, pid } = JSON.parse(raw);
    if (!at || Date.now() - new Date(at).getTime() > STALE_MS) return null;
    if (pid && pid !== process.pid && !pidAlive(pid)) return null;
    return { owner, pid, at };
  } catch {
    return null; // no file, unreadable, or garbage — treat as free
  }
}

/**
 * WHO HOLDS THE PROFILE, WITH THE TWO FACTS THAT DECIDE WHAT TO DO ABOUT IT.
 *
 * The line this replaces read `profile busy (rc-keepwarm)` and nothing else, which is
 * reassuring in exactly the fatal case: it cannot tell "mid-pass, fine" from "the holder died
 * and we are waiting out STALE_MS" from "a live holder is wedged". `rc-check.bat` has the same
 * complaint recorded against it, one file over.
 *
 * MEASURED 2026-09-16: the keep-warm exited silently at 00:03 UTC taking its Chromium with it,
 * the supervisor restarted it at 00:04, and it then printed this line five times over seven and
 * a half minutes against a lock whose recorded pid no longer existed. The pid was in the lock
 * file the whole time — `profileLockHolder` returns it and this line threw it away — and so was
 * the age, which is the number that says "this is stale, it will clear itself".
 */
export function profileHolderNote(held) {
  if (!held) return 'another process';
  const bits = [held.owner ?? 'another process'];
  if (held.pid) bits.push(`pid ${held.pid}`);
  const ms = held.at ? Date.now() - new Date(held.at).getTime() : null;
  if (Number.isFinite(ms)) bits.push(`held ${Math.round(ms / 1000)}s`);
  return bits.join(', ');
}

/** Take the lock if it's free. Returns true on success. */
export function acquireProfileLock(profileDir, owner) {
  if (profileLockHolder(profileDir)) return false;
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      lockPath(profileDir),
      JSON.stringify({ owner, pid: process.pid, at: new Date().toISOString() }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for the lock, then take it. For the BROKER, which is driving a person
 * sitting in front of a page — the bot's jobs are short and retryable, so a brief
 * wait resolves almost every collision.
 *
 * Returns false if it never came free; the caller decides what to do, because
 * proceeding anyway is the exact bug this module exists to prevent.
 */
export async function waitForProfileLock(profileDir, owner, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (acquireProfileLock(profileDir, owner)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Refresh OUR lock's timestamp, so a long job does not read as abandoned while it is
 * still genuinely running.
 *
 * STALE_MS exists so a crash cannot lock a profile forever, but it cuts both ways: the
 * RC human sign-in waits up to ten minutes for a person to type a password and solve a
 * CAPTCHA, which lands exactly on the staleness boundary. A stale lock reads as FREE, so
 * without this the other process would open the same profile out from under a live
 * session — the precise collision this module exists to prevent.
 *
 * Only renews a lock we actually hold; renewing someone else's would be indistinguishable
 * from stealing it.
 */
export function renewProfileLock(profileDir, owner) {
  const held = profileLockHolder(profileDir);
  if (!held || held.owner !== owner || held.pid !== process.pid) return false;
  try {
    fs.writeFileSync(
      lockPath(profileDir),
      JSON.stringify({ owner, pid: process.pid, at: new Date().toISOString() }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Release only if WE still hold it. Used on the error path, where the failure may
 * have been "someone else holds this" — deleting the file blindly there would strip
 * the other process's lock and reintroduce the very race this prevents.
 */
export function releaseProfileLockIfMine(profileDir, owner) {
  const held = profileLockHolder(profileDir);
  if (held && held.owner === owner && held.pid === process.pid) releaseProfileLock(profileDir);
}

export function releaseProfileLock(profileDir) {
  try { fs.rmSync(lockPath(profileDir), { force: true }); } catch { /* best effort */ }
}

/**
 * ── PREEMPTION ──────────────────────────────────────────────────────────────────────
 *
 * The lock above assumes every holder is doing a short job. That stopped being true when
 * the RC keep-warm became RESIDENT — it holds the profile open more or less permanently,
 * because RC's SPA only renews its Okta token while a page is actually loaded, and a
 * process that opens a tab for eight seconds every twenty minutes will essentially never
 * be present when that renewal fires. (Measured: sign-in to death, 1h20m — about one
 * access token, i.e. what a never-renewed session looks like.)
 *
 * A permanent holder and a short-job holder cannot share a plain mutex: the runner would
 * time out every time, at 08:00:00, on the one job that matters.
 *
 * So the resident holder yields on request. The runner drops a flag file, the keep-warm
 * sees it within a second, closes its browser and releases; the runner takes the lock,
 * does its work, clears the flag, and the keep-warm reopens. Exactly one Chromium is ever
 * open on the profile — which is the invariant this whole module exists to protect, and
 * the reason two instances corrupting the session is not a risk we take.
 *
 * A flag file rather than a signal or a port: the two processes already share this
 * directory and nothing else, it survives either of them crashing (a stale request is
 * cleared by age, like the lock), and it needs no new configuration on the mini-PC.
 */
const REQUEST_FILE = '.camphawk-profile-wanted';
/** A request older than this is abandoned — the requester died before taking the lock.
 *  Short, because the cost of ignoring a live request is a missed cart. */
const REQUEST_STALE_MS = 2 * 60 * 1000;

const requestPath = (profileDir) => path.join(profileDir, REQUEST_FILE);

/** "I need the profile — resident holders please stand down." */
export function requestProfile(profileDir, owner) {
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(requestPath(profileDir), JSON.stringify({ owner, at: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

/** Is someone waiting for us to let go? Stale requests read as none. */
export function profileRequested(profileDir) {
  try {
    const { owner, at } = JSON.parse(fs.readFileSync(requestPath(profileDir), 'utf8'));
    if (!at || Date.now() - new Date(at).getTime() > REQUEST_STALE_MS) return null;
    return { owner, at };
  } catch {
    return null;
  }
}

/** Done — the resident may take it back. Safe to call when no request exists. */
export function clearProfileRequest(profileDir) {
  try { fs.unlinkSync(requestPath(profileDir)); } catch { /* not there is the goal */ }
}

/**
 * Take the profile from a holder that will not give it up.
 *
 * ── WHY THIS IS NEEDED AT ALL ───────────────────────────────────────────────────────
 * Preemption is COOPERATIVE: the requester drops `.camphawk-profile-wanted` and the
 * holder's loop is supposed to notice and stand down. On 2026-08-10 the keep-warm's loop
 * hung while its renew `setInterval` kept running, so the lock never went stale, the
 * request was never read, and the 08:00 hold failed against a profile nothing could take.
 * A cooperative protocol cannot survive a partner that has stopped cooperating.
 *
 * ── WHY IT KILLS RATHER THAN JUST TAKING ────────────────────────────────────────────
 * Two Chromium instances on one user-data-dir do not fail cleanly, they CORRUPT the
 * session — the exact thing the lock exists to prevent, and the thing we would be here to
 * rescue. So the only safe way to take a live holder's lock is to stop the holder first.
 * The lock file records the pid precisely so this is possible.
 *
 * ── WHY IT IS SAFE ENOUGH ───────────────────────────────────────────────────────────
 * It kills ONE recorded pid, only after the holder has ignored a standing request for
 * `afterMs`, and only a pid we wrote ourselves. It never touches `node.exe` broadly —
 * that would take the rec.gov bot and the broker down with it, which is the mistake
 * rc-login.bat documents.
 *
 * Returns a short reason string when it acted, or null when it did nothing — the caller
 * reports it, because a forced preemption is a fault that happened to be survivable and
 * should not pass silently.
 */
export function forceProfileLock(profileDir, owner, requestedAtMs, afterMs = 45_000) {
  if (Date.now() - requestedAtMs < afterMs) return null;
  const held = profileLockHolder(profileDir);
  if (!held) return null;                       // already free — nothing to force
  if (held.owner === owner) return null;        // ours
  if (!held.pid || held.pid === process.pid) return null;

  let killed = false;
  try {
    process.kill(held.pid, 'SIGKILL');
    killed = true;
  } catch (err) {
    // ESRCH = already gone, which is fine: the lock is simply stale and the release below
    // clears it. Anything else (EPERM) means we must NOT proceed to take the profile,
    // because the holder is still alive and a second Chromium would corrupt the session.
    if (err && err.code !== 'ESRCH') return null;
  }
  releaseProfileLock(profileDir);
  if (!acquireProfileLock(profileDir, owner)) return null;
  return `forced the profile from ${held.owner} (pid ${held.pid}${killed ? ', killed' : ', already gone'}) ` +
         `after it ignored the request for ${Math.round((Date.now() - requestedAtMs) / 1000)}s`;
}
