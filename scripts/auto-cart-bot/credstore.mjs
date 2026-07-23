// Encrypted, at-rest storage for a user's recreation.gov login on the mini PC, so the
// bot can auto-relogin when the session dies instead of forcing a manual reconnect.
//
// SECURITY MODEL — read before touching:
//  - Windows (the real deployment): encrypted with **DPAPI, CurrentUser scope** via
//    PowerShell's ProtectedData. The blob can only be decrypted by the SAME Windows
//    user on the SAME machine — no key to manage, nothing usable if the file is copied
//    off the box. The plaintext is piped over stdin (never on a command line, which
//    would leak in process listings).
//  - Non-Windows (dev/Pi): AES-256-GCM with a random key in a 0600 file next to the
//    blob. WEAKER — filesystem-scoped, not login-scoped (anyone who can read the box
//    gets both key and ciphertext). Acceptable only for testing.
//  - Credentials NEVER leave the mini PC — they're used locally to log into rec.gov and
//    are not sent to CampHawk servers.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const isWin = process.platform === 'win32';
const CREDS_FILE = '.camphawk-creds';
const KEY_FILE = '.camphawk-credkey';
const FAILS_FILE = '.camphawk-relogin-fails';

// --- Windows DPAPI via PowerShell (no native module) --------------------------------
function dpapiProtect(plaintext) {
  const ps =
    "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
    "$b=[System.Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());" +
    "$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
    '[Console]::Out.Write([Convert]::ToBase64String($e))';
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { input: plaintext, encoding: 'utf8' });
}
function dpapiUnprotect(b64) {
  const ps =
    "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
    '$e=[Convert]::FromBase64String([Console]::In.ReadToEnd());' +
    "$b=[System.Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser');" +
    '[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($b))';
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { input: b64, encoding: 'utf8' });
}

// --- Non-Windows AES-256-GCM fallback -----------------------------------------------
function loadOrCreateKey(dir) {
  const f = path.join(dir, KEY_FILE);
  if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch {}
  return k;
}
function aesEncrypt(dir, plaintext) {
  const key = loadOrCreateKey(dir);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function aesDecrypt(dir, b64) {
  const key = loadOrCreateKey(dir);
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

// --- Public API ---------------------------------------------------------------------
/** Encrypt + persist {email,password} for a user. Best-effort; throws on failure. */
export function saveCreds(userDir, email, password) {
  fs.mkdirSync(userDir, { recursive: true });
  const payload = JSON.stringify({ email, password });
  const blob = isWin ? dpapiProtect(payload) : aesEncrypt(userDir, payload);
  fs.writeFileSync(path.join(userDir, CREDS_FILE), `${isWin ? 'dpapi' : 'aes'}:${blob}`, { mode: 0o600 });
}

/** Decrypt the stored creds, or null if none / undecryptable (wrong machine, corrupt). */
export function loadCreds(userDir) {
  try {
    const raw = fs.readFileSync(path.join(userDir, CREDS_FILE), 'utf8');
    const i = raw.indexOf(':');
    const scheme = raw.slice(0, i);
    const blob = raw.slice(i + 1);
    const payload = scheme === 'dpapi' ? dpapiUnprotect(blob) : aesDecrypt(userDir, blob);
    const { email, password } = JSON.parse(payload);
    return email && password ? { email, password } : null;
  } catch {
    return null;
  }
}

export function hasCreds(userDir) {
  return fs.existsSync(path.join(userDir, CREDS_FILE));
}

export function deleteCreds(userDir) {
  for (const f of [CREDS_FILE, KEY_FILE, FAILS_FILE]) {
    try { fs.unlinkSync(path.join(userDir, f)); } catch {}
  }
}

// Consecutive auto-relogin failures, so we can give up (and stop hammering rec.gov)
// after a couple of tries rather than retrying a bad password / CAPTCHA forever.
export function reloginFails(userDir) {
  try { return Number(fs.readFileSync(path.join(userDir, FAILS_FILE), 'utf8')) || 0; } catch { return 0; }
}
export function bumpReloginFails(userDir) {
  const n = reloginFails(userDir) + 1;
  try { fs.writeFileSync(path.join(userDir, FAILS_FILE), String(n)); } catch {}
  return n;
}
export function resetReloginFails(userDir) {
  try { fs.unlinkSync(path.join(userDir, FAILS_FILE)); } catch {}
}
