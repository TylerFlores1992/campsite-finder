/**
 * The mini-PC's OWN list of diagnostics it is willing to run.
 *
 * ── THIS FILE IS THE SECURITY BOUNDARY ─────────────────────────────────────────────────
 * The server sends `{id, kind, arg}` and nothing else. It cannot send a command line, a
 * path, or a script. Every kind is implemented HERE, and anything not in this table is
 * refused by name. So the worst a wholly compromised server (or a leaked AUTOCART_TOKEN)
 * can do is trigger one of the read-only things below.
 *
 * That matters more than it usually would: this box holds the live ReserveCalifornia
 * session, the DPAPI credential store, and a residential IP that both rec.gov and RC have
 * already blocked once. A free-form command channel would make the feed token a shell on
 * someone's home network.
 *
 * ── AND THE OUTPUT IS SCRUBBED HERE, NOT ON THE SERVER ─────────────────────────────────
 * Logs are a mixture: bearer tokens, OAuth callbacks, email addresses. The rule this repo
 * keeps relearning - see the precart diagnostic that reported `location.href` and shipped
 * an OAuth authorization code - is that a field you have to filter is better not collected.
 * A log line is inherently mixed, so it is filtered at the one place where "not sent" is
 * still true: before it leaves the machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Hard ceiling on what any diagnostic may return. */
export const MAX_OUTPUT = 16_000;
/** Lines returned by tail-log unless a smaller count is asked for. */
export const DEFAULT_TAIL = 80;

/**
 * The box's own floor on how often it will restart the RC processes.
 *
 * Every restart drops the RC access token, and the token IS the session. A restart loop is
 * therefore a way to spend the one-login-per-release budget over and over from a residential
 * address that Okta has already served a reCAPTCHA and blocked for twelve hours. Enforced
 * HERE, on the machine, because this file is the security boundary - a rate limit that lives
 * only on the server is a rate limit a leaked token bypasses.
 *
 * Ten minutes is long enough that a flap is not free, short enough that a genuine "that
 * didn't work, try once more" is not an hour's wait.
 */
export const RESTART_MIN_GAP_MS = 10 * 60_000;

/**
 * The logs that may be read, by NAME - never by path.
 *
 * A path parameter would be a directory traversal waiting to happen, and the interesting
 * files are a known, short list anyway. `.env` and the profile directories are absent on
 * purpose and must stay that way: they are exactly what an attacker would ask for.
 */
export const LOGS = {
  'rc-holds': 'logs/rc-hold-runner.log',
  'rc-keepwarm': 'logs/rc-keepwarm.log',
  bot: 'logs/bot.log',
  broker: 'logs/broker.log',
  'auto-update': 'logs/auto-update.log',
  'update-spawn': 'logs/update-spawn.log',
  restarts: 'logs/restarts.log',
};

/**
 * Take secrets out of a log excerpt.
 *
 * Deliberately aggressive and deliberately dumb: it is a last line of defence, not a
 * parser. Anything that looks like a credential goes, and a query string goes whole -
 * `?code=…&state=…` on an Okta callback is exchangeable for a session, and the 08-09
 * precart leak happened because a scrubber that knew JWT shapes sailed straight past it.
 */
export function scrub(text) {
  return String(text)
    // NUL FIRST, unconditionally. A NUL is never legitimate output, and Postgres text
    // cannot store one - so a single stray byte makes the whole answer unwritable and the
    // command hangs forever as 'picked up, never finished'. The decoder above should stop
    // producing them; this is the belt, because the cost of being wrong is an invisible
    // failure rather than a garbled line.
    .replace(/\u0000/g, '')
    // Authorization headers: EAT THE REST OF THE LINE. The first version matched
    // `(bearer|authorization:?)\s+\S+`, which on "authorization: Bearer abc123" consumed
    // the word "Bearer" as its one token and left the credential in place - a redaction
    // that reads as if it worked. Erring toward removing too much is the correct direction
    // for a scrubber.
    .replace(/\bauthorization\s*:\s*.*/gi, 'authorization: [redacted]')
    .replace(/\bbearer\s+\S+/gi, 'bearer [redacted]')
    .replace(/\b(accesstoken|x-api-key|apikey)\s*[:=]\s*\S+/gi, '$1: [redacted]')
    // JWTs (three base64url segments).
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]')
    // Whole query strings. Not just `code`/`token` - naming the dangerous parameters is
    // how you miss the next one.
    .replace(/(https?:\/\/[^\s?]+)\?\S*/gi, '$1?[query removed]')
    // Email addresses, keeping just enough to tell two users apart.
    .replace(/\b([A-Za-z0-9._%+-]{1,3})[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)\b/g, '$1***@$2')
    // Long opaque runs: session ids, cart keys, hex blobs.
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[hex]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[opaque]');
}

/**
 * Read a text file that may be UTF-16LE.
 *
 * Windows PowerShell 5.1's Tee-Object wrote these logs as UTF-16 for months, which is what
 * made `findstr` answer "input file is in Unicode format" mid-diagnosis on 2026-08-11.
 * Older log files on this box still are, so decoding by BOM rather than assuming UTF-8 is
 * the difference between a readable answer and mojibake.
 */
export function readTextFile(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  // BOM-LESS UTF-16LE, which is what actually broke tail-log (2026-08-11). Redirected
  // PowerShell output is UTF-16 with no BOM, so every branch above misses it and the file is
  // decoded as UTF-8 - yielding a NUL between every character. Postgres text cannot hold
  // \u0000, so the answer was unstorable and the command hung as 'picked up, never
  // finished' - twice, identically, while list-processes in the same batch came back fine.
  //
  // ASCII text in UTF-16LE is 'X\0Y\0': NULs on odd offsets. Sampling the head is enough
  // and cannot false-positive on real UTF-8, which never contains a NUL at all.
  const head = buf.subarray(0, Math.min(buf.length, 512));
  let odd = 0;
  for (let i = 1; i < head.length; i += 2) if (head[i] === 0) odd++;
  if (head.length >= 8 && odd > head.length / 4) return buf.toString('utf16le');
  return buf.toString('utf8');
}

const tail = (text, n) => text.replace(/\r\n/g, '\n').split('\n').slice(-n).join('\n');

const run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd: HERE, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve(`${stdout || ''}${stderr || ''}`.trim() || (err ? String(err.message) : '')));
  });

/**
 * kind -> implementation. `arg` is whatever the server sent; every handler validates it
 * itself and no handler may interpolate it into a command line.
 */
export const COMMANDS = {
  /** The whole reason this exists: read a log without asking a human to paste it. */
  'tail-log': async (arg) => {
    const [name, nRaw] = String(arg ?? '').split(':');
    const rel = LOGS[name];
    if (!rel) throw new Error(`unknown log '${name}' - allowed: ${Object.keys(LOGS).join(', ')}`);
    const n = Math.min(400, Math.max(1, Number(nRaw) || DEFAULT_TAIL));
    const file = path.join(HERE, rel);
    // A MISSING FILE IS AN ANSWER, not an error. "logs\auto-update.log does not exist" is
    // precisely what proved the script never ran.
    if (!fs.existsSync(file)) return `(${rel} does not exist)`;
    return tail(readTextFile(file), n);
  },

  /** Which of OUR processes are alive. Scoped to our own scripts - not a process list. */
  'list-processes': async () => {
    // A FIXED script with no interpolation anywhere. The moment `arg` reaches a command
    // line, this stops being an allowlist.
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match " +
      "'supervise\\.ps1|bot\\.mjs|broker\\.mjs|rc-keepwarm\\.mjs|rc-hold-runner\\.mjs|cloudflared' } | " +
      "ForEach-Object { '{0,-8} {1,-14} {2}' -f $_.ProcessId, $_.Name, " +
      "($_.CommandLine -replace '^.*(supervise\\.ps1|bot\\.mjs|broker\\.mjs|rc-keepwarm\\.mjs|rc-hold-runner\\.mjs|cloudflared)', '$1').Substring(0, [Math]::Min(70, " +
      "($_.CommandLine -replace '^.*(supervise\\.ps1|bot\\.mjs|broker\\.mjs|rc-keepwarm\\.mjs|rc-hold-runner\\.mjs|cloudflared)', '$1').Length)) }";
    return await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  },

  /** What commit is the box actually on - the question behind half of tonight. */
  'git-status': async () => {
    const head = await run('git', ['rev-parse', '--short', 'HEAD']);
    const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    const dirty = await run('git', ['status', '--short']);
    return `HEAD ${head} on ${branch}\n${dirty || '(working tree clean)'}`;
  },

  /**
   * THE ONE COMMAND THAT CHANGES SOMETHING, and the reason it is worth breaking this file's
   * read-only posture: on 2026-08-11 the RC hold runner died at 09:36 PT and every other
   * command here could only describe the problem.
   *
   * ── THE BOX'S HALF OF THE GUARD ──────────────────────────────────────────────────────
   * The server refuses to QUEUE this near a release, because it is the side that knows when
   * holds are due. This side refuses to RUN it more than once per RESTART_MIN_GAP_MS,
   * because this is the side that must hold even if the server is lying or the token has
   * leaked. Neither guard depends on the other being honest - that split is the whole
   * design, and this file's header is why: a leaked feed token must not become a way to
   * flap the RC session until the household IP is blocked again.
   *
   * The marker is a FILE, not a variable. The process running this is restarted by its own
   * supervisor, and an in-memory timestamp would reset with it - so a crash loop would lift
   * the rate limit exactly when it matters most.
   */
  'restart-rc': async () => {
    const marker = path.join(HERE, 'logs', '.restart-rc-at');
    const last = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
    const since = Date.now() - last;
    if (Number.isFinite(last) && last > 0 && since < RESTART_MIN_GAP_MS) {
      return `refused: restarted ${Math.round(since / 60_000)} min ago, and the limit is one ` +
        `per ${Math.round(RESTART_MIN_GAP_MS / 60_000)} min. Each restart drops the RC access token.`;
    }
    const script = path.join(HERE, 'mini-pc', 'restart-rc.ps1');
    // SAY IT IS MISSING rather than reporting a silent success. A wrong path makes
    // PowerShell exit immediately with a message nobody sees, which is indistinguishable
    // from a restart that ran and did nothing - the exact ambiguity that cost a night.
    if (!fs.existsSync(script)) throw new Error(`${script} does not exist - the box needs update.bat`);
    try { fs.mkdirSync(path.dirname(marker), { recursive: true }); } catch { /* best effort */ }
    fs.writeFileSync(marker, String(Date.now()));
    return await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
  },

  /** Free space. "No space left on device" turns every other symptom into a mystery. */
  'disk-free': async () =>
    await run('powershell', ['-NoProfile', '-Command',
      "Get-PSDrive -PSProvider FileSystem | ForEach-Object { '{0}: {1} GB free of {2} GB' -f $_.Name, [math]::Round($_.Free/1GB,1), [math]::Round(($_.Used+$_.Free)/1GB,1) }"]),
};

export const KINDS = Object.keys(COMMANDS);

/**
 * Run one command and return `{ok, output, error}`. Never throws: a diagnostic that can
 * take the runner down is worse than no diagnostic at all, and this runs on the process
 * that carts campsites.
 */
export async function runCommand(kind, arg) {
  const fn = COMMANDS[kind];
  if (!fn) return { ok: false, output: '', error: `unknown kind '${kind}' - this box only runs: ${KINDS.join(', ')}` };
  try {
    const raw = await fn(arg);
    let out = scrub(raw ?? '');
    if (out.length > MAX_OUTPUT) out = `${out.slice(-MAX_OUTPUT)}\n(truncated to the last ${MAX_OUTPUT} characters)`;
    return { ok: true, output: out, error: null };
  } catch (e) {
    return { ok: false, output: '', error: scrub(e?.message ?? String(e)).slice(0, 500) };
  }
}
