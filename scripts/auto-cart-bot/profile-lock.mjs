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

/** Who holds this profile right now, or null. Stale locks read as free. */
export function profileLockHolder(profileDir) {
  try {
    const raw = fs.readFileSync(lockPath(profileDir), 'utf8');
    const { owner, at, pid } = JSON.parse(raw);
    if (!at || Date.now() - new Date(at).getTime() > STALE_MS) return null;
    return { owner, pid, at };
  } catch {
    return null; // no file, unreadable, or garbage — treat as free
  }
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
