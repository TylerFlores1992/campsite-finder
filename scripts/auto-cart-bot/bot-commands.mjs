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
  // ── THE TWO HUMAN-RUN SCRIPTS, ADDED 2026-08-19 ──────────────────────────────────────
  // `rc-test-login.bat` failed at 19:46 printing NO reason line, no rewrite count and no
  // stack — the console stopped dead after "Signing in with the stored password". The one
  // record that could say why is Tee'd to `rc-test-login.log`, and it was the only bot log
  // NOT reachable from here, so diagnosing a remote box needed a human to copy a file off
  // it. That is backwards: the runs worth reading remotely are exactly the ones nobody is
  // sitting in front of afterwards.
  //
  // STILL AN ENUMERATED LIST, NOT A PATH PARAMETER. "Everything" means every log this repo
  // writes, named here — never a path, which is a directory traversal waiting to happen.
  // `.env` and the profile directories stay absent on purpose: they are exactly what an
  // attacker holding AUTOCART_TOKEN would ask for. `worker/log-allowlist.test.mts` keeps
  // this list from falling behind in either direction.
  'rc-test-login': 'logs/rc-test-login.log',
  'rc-cart-cap': 'logs/rc-cart-cap.log',
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
  // ASCII text in UTF-16LE is 'X\0Y\0': NULs on odd offsets. Real UTF-8 never contains a NUL
  // at all, so the test itself cannot false-positive.
  //
  // ── BUT IT SAMPLED THE HEAD, AND THESE LOGS ARE MIXED (fixed 2026-08-14) ───────────────
  // A log on this box is APPEND-ONLY and has outlived an encoding change: PowerShell 5.1's
  // Tee-Object wrote UTF-16LE for months, and everything appended after `supervise.ps1`
  // started setting [Console]::OutputEncoding is UTF-8. So one file holds BOTH — UTF-16LE
  // at the front, UTF-8 at the back — and a whole-file decision made from the head decodes
  // the back wrongly.
  //
  // That is the worst possible half to lose, because `tail-log` returns ONLY the back. Asked
  // for `auto-update` on 2026-08-14 while diagnosing a stuck update, it came back as solid
  // CJK mojibake — every line of it — which reads as a corrupted log rather than as an
  // encoding bug, on the one diagnostic CLAUDE.md says to consult before trusting the update
  // path. A confident wrong answer, in the house shape.
  //
  // SO THE FILE IS SPLIT AT THE BOUNDARY RATHER THAN DECODED AS ONE THING. Sampling the tail
  // instead of the head was the first attempt and is only mostly right: a fixed window still
  // straddles the join while the UTF-8 part is shorter than the window, so a log that changed
  // encoding a few lines ago still comes back wrong. Guessing at a better window size is not
  // an answer, it is a smaller version of the same guess.
  //
  // UTF-8 CANNOT CONTAIN A NUL AT ALL. So the last NUL in the file is the last byte of the
  // UTF-16LE region, and everything after it is UTF-8 — which makes the boundary exact rather
  // than estimated, and needs no threshold:
  //
  //   * no NUL anywhere      -> the whole file is UTF-8 (the common case now)
  //   * NUL at/near the end  -> the whole file is UTF-16LE (an old, untouched log)
  //   * NUL in the middle    -> mixed; decode each side in its own encoding
  //
  // Alignment falls out of this for free: ASCII in UTF-16LE puts its NULs on ODD offsets, so
  // splitting just after one leaves an even-length head, which is what utf16le requires. A
  // fixed-offset window had to reason about parity separately and got it wrong on a file of
  // odd length — the original bug wearing a hat.
  //
  // A stray NUL in a genuinely UTF-8 file (a truncated write) mis-decodes the part BEFORE it
  // and still returns the tail correctly, so the failure stays in the half nobody is reading.
  const lastNul = buf.lastIndexOf(0);
  if (lastNul === -1) return buf.toString('utf8');
  return buf.subarray(0, lastNul + 1).toString('utf16le') + buf.subarray(lastNul + 1).toString('utf8');
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

  /**
   * WHY THE BOX RAN OUT, and the blind spot it was hiding behind (2026-08-12).
   *
   * `supervise.ps1` could not start a shell at all:
   *
   *     Starting the CLR failed with HRESULT 80004005.
   *     Could not load file or assembly 'System.Management.Automation' ...
   *     The paging file is too small for this operation to complete. (0x800705AF)
   *     Exception of type 'System.OutOfMemoryException' was thrown.
   *
   * A supervisor that cannot launch a shell cannot restart anything, so this fails exactly
   * when its whole job begins - the same shape as `restarts.log` dropping its lines during
   * a stop.
   *
   * THE NUMBER THAT RAN OUT IS **COMMIT**, NOT DISK AND NOT FREE RAM. `disk-free` answered
   * 404 GB the same night, which reads as "not a space problem" and sent the question the
   * wrong way. "The paging file is too small" means Windows could not grow the page file to
   * cover a commit request, so the figure to watch is committed bytes against the commit
   * limit (RAM + page file), which nothing here reported.
   *
   * AND `list-processes` CANNOT SEE THE CULPRIT BY CONSTRUCTION. It matches our node and
   * PowerShell scripts only, so every Chromium on the box - the resident RC keep-warm tab,
   * the rec.gov per-user profiles, and any orphan a force-kill left behind - is invisible to
   * it. Those are the largest consumers by a wide margin, and a memory question answered
   * without them is answered about the wrong processes.
   *
   * Chromium is matched on OUR profile directories, the same rule stop-all.ps1 kills by, so
   * a person's own browser on this machine is never counted as ours. Every other chrome.exe
   * is reported as a COUNT and nothing else - enough to say "something else is using this
   * machine", never what they have open.
   */
  'memory': async () => {
    // A FIXED script, no interpolation - same rule as list-processes.
    //
    // Commit comes from Win32_OperatingSystem's *Virtual* figures rather than a performance
    // counter: perf-counter names are localised and the classes can be disabled outright, and
    // a diagnostic that returns nothing on some machines is the failure mode this whole file
    // exists to remove. The regex uses \S* rather than a character class over a quote, so no
    // double quote has to survive Node -> execFile -> powershell.exe.
    const ps = [
      '$os = Get-CimInstance Win32_OperatingSystem;',
      '$ramTot = [double]$os.TotalVisibleMemorySize * 1KB;',
      '$ramFree = [double]$os.FreePhysicalMemory * 1KB;',
      '$cLim = [double]$os.TotalVirtualMemorySize * 1KB;',
      '$cFree = [double]$os.FreeVirtualMemory * 1KB;',
      '$cUsed = $cLim - $cFree;',
      // The BOX's own clock, because a rate is a difference over a time and the only honest
      // denominator is the interval between the two samples - not the interval between the two
      // moments an agent happened to read the answers back.
      "'TIME     {0:yyyy-MM-dd HH:mm:ss} box local / {1:HH:mm:ss} UTC' -f (Get-Date), (Get-Date).ToUniversalTime();",
      "'RAM      {0:N1} GB total, {1:N1} GB free' -f ($ramTot/1GB), ($ramFree/1GB);",
      "'COMMIT   {0:N1} GB used of {1:N1} GB limit ({2:N0}%) <- this is what ran out' -f ($cUsed/1GB), ($cLim/1GB), (100*$cUsed/[Math]::Max($cLim,1));",
      '$pf = @(Get-CimInstance Win32_PageFileUsage);',
      "foreach ($p in $pf) { 'PAGEFILE {0} - {1:N1} GB allocated, peak {2:N1} GB' -f $p.Name, ($p.AllocatedBaseSize/1024), ($p.PeakUsage/1024) };",
      "if ($pf.Count -eq 0) { 'PAGEFILE none in use' };",
      '$st = @(Get-CimInstance Win32_PageFileSetting);',
      "foreach ($s in $st) { 'PAGEFILE setting {0} - initial {1} MB, max {2} MB' -f $s.Name, $s.InitialSize, $s.MaximumSize };",
      "if ($st.Count -eq 0) { 'PAGEFILE setting - system managed (Windows grows it lazily, which is what loses a burst)' };",
      "$ours = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match '--user-data-dir=\\S*(\\.rc-bot-profile|auto-cart-bot)' });",
      '$sum = 0; foreach ($o in $ours) { $q = Get-Process -Id $o.ProcessId -ErrorAction SilentlyContinue; if ($q) { $sum += $q.PrivateMemorySize64 } };',
      "'OURS     {0} chrome.exe on our profiles, {1:N1} GB private total' -f $ours.Count, ($sum/1GB);",
      // ── WHICH PROFILE, NAMED, PER PROCESS ────────────────────────────────────────────
      // A COUNT AND A TOTAL CANNOT ATTRIBUTE A LEAK, and this diagnostic reported nothing
      // else. The runaway Chromium of 2026-08-12 was guessed onto the wrong profile family
      // TWICE, and it could not have been settled by reading the regexes: the RC profile is
      //     ...\scripts\auto-cart-bot\.rc-bot-profile
      // and the rec.gov profiles are
      //     ...\scripts\auto-cart-bot\profiles\<userId>
      // so BOTH contain the substring `auto-cart-bot`. The only thing that separates them is
      // the tail of the path, which was never printed. A diagnostic that cannot tell apart
      // the two candidate causes of the failure it was written for is not yet a diagnostic.
      //
      // The family is decided by `.rc-bot-profile` FIRST, because it is the specific one;
      // testing `auto-cart-bot` first would classify every RC process as rec.gov, which is
      // exactly the mistake being fixed.
      //
      // The profile DIRECTORY is printed, never the whole command line: Chromium's argv
      // carries flags and occasionally URLs, and the rule this file is built on is that a
      // field you would have to filter is better not collected.
      "'';",
      "'Our Chromium by profile (the growth RATE across two readings is the signature,';",
      "'  not the absolute number - take a second reading about five minutes later):';",
      // THE ROLLUP ACCUMULATES IN SCALARS, NEVER AN ARRAY IN A HASHTABLE (fixed 2026-08-14).
      // It used to keep `@(count, mb)` per family and rewrite it as
      //     $byFam[$fam] = @($byFam[$fam][0] + 1, $byFam[$fam][1] + $mb)
      // which threw `[System.Object[]] does not contain a method named 'op_Addition'` once per
      // process, on every run since it shipped - so every FAMILY line read `0 process(es),
      // 0 MB` while the per-process list above it was perfectly correct. A reading that prints
      // a plausible zero is worse than one that prints nothing: the family totals are the line
      // you compare across two readings, and `rc 0 MB` reads as "the RC profile is innocent".
      //
      // The replacement is the idiom three lines above (`$sum += ...` for the OURS total),
      // which has always worked in this same script - so it is the evidenced choice rather
      // than a second guess at PowerShell's array semantics. There is no PowerShell on the
      // machine this file is written from, so the guard is `worker/chromium-attribution.test.mts`
      // forbidding the shape, and the proof is running `memory` on the box afterwards.
      '$rows = @();',
      'foreach ($o in $ours) {',
      "  $dir = ''; if ($o.CommandLine -match '--user-data-dir=(\\S+)') { $dir = $Matches[1] };",
      // Chrome re-quotes the path for its renderer/GPU children, so the captured directory
      // arrives as `"C:\...\.rc-bot-profile"` for most processes. Trim the quotes, or two
      // readings of the same profile look like two different profiles when they are compared.
      '  $dir = $dir.Trim([char]34);',
      "  $fam = 'other'; if ($dir -match '\\.rc-bot-profile') { $fam = 'rc' } elseif ($dir -match 'auto-cart-bot') { $fam = 'recgov' };",
      '  $q = Get-Process -Id $o.ProcessId -ErrorAction SilentlyContinue;',
      '  $mb = 0; if ($q) { $mb = [double]$q.PrivateMemorySize64/1MB };',
      '  $rows += [pscustomobject]@{ Fam = $fam; Mb = $mb; Ppid = $o.ProcessId; Dir = $dir };',
      '};',
      "foreach ($r in $rows) { '  {0,-7} {1,7:N0} MB  pid {2,-6} {3}' -f $r.Fam, $r.Mb, $r.Ppid, $r.Dir };",
      "if ($ours.Count -eq 0) { '  (none - no Chromium of ours is running)' };",
      // A FIXED family order, not $hash.Keys: hashtable enumeration order is unspecified, and
      // these lines exist to be diffed against a reading taken five minutes later.
      "foreach ($k in @('rc', 'recgov', 'other')) {",
      '  $g = @($rows | Where-Object { $_.Fam -eq $k });',
      '  if ($g.Count -gt 0) {',
      '    $fsum = 0; foreach ($x in $g) { $fsum += $x.Mb };',
      "    'FAMILY   {0,-7} {1} process(es), {2:N0} MB private' -f $k, $g.Count, $fsum;",
      '  }',
      '};',
      '$allC = @(Get-Process chrome -ErrorAction SilentlyContinue).Count;',
      "'CHROME   {0} chrome.exe on the box in total (the rest are somebody using this machine)' -f $allC;",
      "'';",
      "'Top 12 by private bytes (private is what counts against the commit limit):';",
      '$top = Get-Process | Sort-Object -Property PrivateMemorySize64 -Descending | Select-Object -First 12;',
      "foreach ($t in $top) { '  {0,-20} {1,7:N0} MB  pid {2}' -f $t.ProcessName, ($t.PrivateMemorySize64/1MB), $t.Id };",
    ].join(' ');
    return await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  },

  /**
   * KILL OUR CHROMIUM, by profile family.
   *
   * 2026-08-12: a browser on our profiles reached 9.4 GB and drove COMMIT to 99% of 50 GB,
   * growing ~395 MB/min. `restart-rc` killed two of that instance's nine processes and left
   * the rest - correctly, because it scopes to `.rc-bot-profile` and this one was on a
   * rec.gov profile. There was no remote way to end it; a person had to type `taskkill` into
   * a phone. At 99% commit `supervise.ps1` cannot start a shell, so the recovery path was
   * about to disappear too.
   *
   * WHY A WHOLE FAMILY AND NOT A PID. A pid from a `memory` reading is already stale by the
   * time anyone acts on it, and one Chromium is nine processes - killing "the big one" leaves
   * eight holding the profile lock, which is the failure `restart-rc` just demonstrated. The
   * profile dir is the identity that survives both problems.
   *
   * Matched on `--user-data-dir`, the same rule `memory` counts by and stop-all kills by, so
   * the owner's own browser is never in range. NEVER by image name.
   */
  'kill-chrome': async (arg) => {
    // The families, as regex alternatives against the command line. `rc` is the keep-warm and
    // hold-runner profile; `recgov` is the per-user auto-cart profiles under auto-cart-bot.
    //
    // FIXED LINES, SELECTED BY THE ARG - never built from it. `worker/bot-commands.test.mts`
    // caught the first draft interpolating `arg` into the script, and it was right to: the
    // server validates the arg, and the box must not depend on that being true. The arg
    // chooses which of three constant strings to use and contributes not one character.
    // `recgov` EXCLUDES THE RC PROFILE EXPLICITLY, and must (2026-08-14). Both families live
    // under the same directory:
    //     RC       ...\scripts\auto-cart-bot\.rc-bot-profile
    //     rec.gov  ...\scripts\auto-cart-bot\profiles\<userId>
    // so the old `--user-data-dir=\S*auto-cart-bot` matched the RC profile too, and
    // `kill-chrome recgov` - the lever you reach for precisely BECAUSE restart-rc leaves
    // rec.gov alone - would have taken the live RC session down with it. The whole point of
    // having three scopes is that two of them are survivable at 07:50.
    //
    // A negative lookahead rather than matching the `profiles\` subdirectory, so an
    // overridden PROFILES_DIR cannot quietly turn this back into "everything".
    const PAT = {
      rc: "$pat = '--user-data-dir=\\S*\\.rc-bot-profile';",
      recgov: "$pat = '--user-data-dir=(?!\\S*\\.rc-bot-profile)\\S*auto-cart-bot';",
      all: "$pat = '--user-data-dir=\\S*(\\.rc-bot-profile|auto-cart-bot)';",
    };
    const patLine = PAT[arg];
    // Defence in depth: this must not fall through to "kill everything" if that validation is
    // ever loosened. An unknown scope kills nothing.
    // The scope is NOT echoed back. `worker/bot-commands.test.mts` forbids `${arg}` anywhere
    // in these handlers, and that bluntness is the point — it cannot tell a harmless error
    // string from a command line, so the rule is "the arg never appears", full stop. Working
    // around it with string concatenation would satisfy the regex and defeat the test.
    if (!patLine) return 'unknown scope - expected rc, recgov or all. Nothing was killed.';
    const clearsRcLock = arg === 'rc' || arg === 'all';

    const ps = [
      patLine,
      "$ours = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match $pat });",
      // THE PIDS, NOT JUST A COUNT (2026-08-14). See the AFTER block below: a count cannot tell
      // a kill that failed from a kill that worked and was followed by a fresh browser, and
      // that is the entire difference between "go to the box" and "nothing to do".
      "'BEFORE   {0} chrome.exe matched' -f $ours.Count;",
      '$beforeIds = @($ours | ForEach-Object { $_.ProcessId });',
      "if ($beforeIds.Count -gt 0) { '         pids ' + ($beforeIds -join ', ') };",
      // Report the sizes we are about to reclaim, so the answer says what it achieved rather
      // than merely that it ran - the `status = 'sent'` lesson.
      '$sum = 0; foreach ($o in $ours) { $q = Get-Process -Id $o.ProcessId -ErrorAction SilentlyContinue; if ($q) { $sum += $q.PrivateMemorySize64 } };',
      "'         {0:N1} GB private across them' -f ($sum/1GB);",
      'foreach ($o in $ours) { Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue };',
      // Chromium takes a moment to actually go, and a kill that is merely ISSUED is not a
      // kill that happened - the same reason restart-rc re-checks before relaunching.
      'Start-Sleep -Seconds 3;',
      "$left = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match $pat });",
      // ── "SURVIVED" USED TO MEAN TWO OPPOSITE THINGS ───────────────────────────────────────
      // This re-check runs three seconds after the kill, and three seconds is long enough for
      // the keep-warm's supervisor to have opened a NEW browser on the same profile - which is
      // the system recovering exactly as designed. The old code matched the profile again and
      // called everything it found `SURVIVED`, so a clean kill followed by a healthy restart
      // printed the same words as a kill that reached nothing. On 2026-08-12 that read as
      // "7 before, 7 after, the lever is broken"; the pids were entirely different every time,
      // i.e. the kill had worked.
      //
      // A pid is what separates them, so the two sets are diffed rather than counted. Same
      // family as `status = 'sent'` meaning only "Twilio returned 2xx" - the fix is to report
      // the fact that distinguishes the outcomes, not a louder version of the ambiguous one.
      '$leftIds = @($left | ForEach-Object { $_.ProcessId });',
      '$surv = @($leftIds | Where-Object { $beforeIds -contains $_ });',
      '$fresh = @($leftIds | Where-Object { $beforeIds -notcontains $_ });',
      "'AFTER    {0} on this profile - {1} survived the kill, {2} started after it' -f $leftIds.Count, $surv.Count, $fresh.Count;",
      "foreach ($s in $surv) { '  SURVIVED pid {0} - the kill did NOT reach this one' -f $s };",
      "foreach ($f in $fresh) { '  fresh    pid {0} - opened after the kill; this is the supervisor reopening, NOT a failure' -f $f };",
      "if ($surv.Count -eq 0) { '  every process the kill targeted is gone' };",
      // A force kill never runs the profile lock's release, so the file survives and the
      // restarted keep-warm reads it as another process holding the profile - then waits 60s
      // and gives up, every pass, for ever. Same cleanup restart-rc does, for the same reason.
      ...(clearsRcLock
        ? [
            "Remove-Item '.rc-bot-profile\\.camphawk-profile-lock' -Force -ErrorAction SilentlyContinue;",
            "Remove-Item '.rc-bot-profile\\.camphawk-profile-wanted' -Force -ErrorAction SilentlyContinue;",
            "'cleared the RC profile lock so the keep-warm can reopen';",
          ]
        : []),
      '$os = Get-CimInstance Win32_OperatingSystem;',
      '$cLim = [double]$os.TotalVirtualMemorySize * 1KB; $cFree = [double]$os.FreeVirtualMemory * 1KB;',
      "'COMMIT   {0:N1} GB used of {1:N1} GB limit ({2:N0}%)' -f (($cLim-$cFree)/1GB), ($cLim/1GB), (100*($cLim-$cFree)/[Math]::Max($cLim,1));",
      // The processes are gone; nothing here restarts them. Say so, because a silent recovery
      // that did not happen is exactly the assumption that cost the 08-10 morning.
      "'';",
      "'This command restarted nothing itself. The supervisors should bring the payloads back -';",
      "'any pid listed as `fresh` above IS that happening. If none appears, run restart-rc.'",
    ].join(' ');
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

  /**
   * QUEUE THE LOGIN REHEARSAL, for the keep-warm to run — never run it HERE.
   *
   * This handler executes inside bot.mjs or the hold runner, and the rehearsal needs the
   * Chromium profile the keep-warm owns; running a login from a second process against that
   * profile is the two-browsers-one-user-data-dir corruption every mini-pc script warns
   * about. So the handler's whole job is a SIGNAL FILE, the same cooperative mechanism as
   * `.camphawk-profile-wanted`, and the keep-warm consumes it inside its own loop where the
   * profile, the gates and the recycle already live.
   *
   * THE RATION IS CHECKED IN BOTH PLACES. Here, so the asker gets an immediate honest
   * refusal instead of a queued request that silently dies; in the keep-warm, because THIS
   * check can be raced by two commands and the consumer's file-timestamp check is the one
   * that actually spends the ration. A login is not free: repeated sign-ins from this
   * address cost twelve hours of IP block on 2026-08-06, which is why the box refuses on
   * its own clock no matter who asks.
   */
  'test-login': async () => {
    const last = path.join(HERE, 'logs', '.rehearse-on-demand-at');
    const gapMs = 6 * 3600_000;
    try {
      const at = Number(fs.readFileSync(last, 'utf8'));
      if (Number.isFinite(at) && at > 0 && Date.now() - at < gapMs) {
        return `refused: an on-demand rehearsal ran ${Math.round((Date.now() - at) / 60_000)} min ago, `
          + 'and the box allows one per 6h. A login is the act that got this address blocked; '
          + 'the nightly rehearsal still runs at 20:00 PT.';
      }
    } catch { /* no record = no ration spent */ }
    fs.writeFileSync(path.join(HERE, '.camphawk-rehearse-asked'), String(Date.now()));
    return 'queued - the keep-warm picks this up within its poll cadence (about a minute) and '
      + 'runs the same rehearsal body as the nightly 20:00 PT run, prompt=login included. '
      + 'It still refuses within 6h of a release. Watch tail-log rc-keepwarm; the verdict '
      + 'lands in autocart.rc_login.';
  },

  /** Free space. "No space left on device" turns every other symptom into a mystery. */
  'disk-free': async () =>
    await run('powershell', ['-NoProfile', '-Command',
      "Get-PSDrive -PSProvider FileSystem | ForEach-Object { '{0}: {1} GB free of {2} GB' -f $_.Name, [math]::Round($_.Free/1GB,1), [math]::Round(($_.Used+$_.Free)/1GB,1) }"]),

  /**
   * ARE THE SCHEDULED TASKS ALIVE, AND IS THERE A SESSION FOR THEM TO RUN IN?
   *
   * Both mini-PC Scheduled Tasks went silent at ~05:31 PT on 2026-08-17 and the watchdog
   * that fires every five minutes said nothing for two and a half hours. **The one fact
   * nobody could obtain remotely was whether Windows had run them at all** — and the two
   * levers that would have answered it are on the box: RustDesk (which the same day failed
   * with "No displays") and physically sitting at it. Twice now the diagnosis has waited on
   * a human.
   *
   * `bot_task_heartbeat` (migration 060) answers "did it fire?" going forward, but only for
   * firings after the box updates, and it cannot say WHY a task stopped. This says why:
   * `Scheduled Task State`, `Last Run Time`, `Last Result` and `Logon Mode` are exactly the
   * four fields `docs/NEXT-SESSION.md` asks a human to read.
   *
   * THE SESSION LIST IS THE OTHER HALF, and it is what distinguishes the two failures that
   * look identical from here. `install-watchdog.bat` registers with no `/RU`, i.e. "run only
   * when the user is logged on" — so a task that stops because the session went away is a
   * different fault from one Windows disabled, and they need different fixes. A logoff also
   * kills the payloads, so `list-processes` plus this pins it down: processes alive with no
   * Active session means DISCONNECTED (RustDesk's "No displays"), and that is survivable;
   * no session at all means the tasks cannot run by construction.
   *
   * READ-ONLY, deliberately. It queries and reports; it never enables, re-registers or runs
   * a task. A diagnostic that changes the thing it measures is how "did the update land?"
   * became unanswerable, and re-registering a task is the sort of act that should be a
   * decision rather than a side effect of asking a question.
   */
  tasks: async () =>
    await run('powershell', ['-NoProfile', '-Command',
      // `2>$null` on each query: a task that is not registered is a legitimate ANSWER here,
      // not an error, and letting schtasks write to stderr would bury the other one.
      "$names = @('CampHawk watchdog','CampHawk auto-update'); " +
      "foreach ($n in $names) { " +
      "  $r = (schtasks /Query /TN $n /V /FO LIST 2>$null); " +
      "  if (-not $r) { \"$n : NOT REGISTERED\"; continue } " +
      "  $keep = 'Status|Scheduled Task State|Last Run Time|Last Result|Next Run Time|Logon Mode|Run As User'; " +
      "  \"=== $n ===\"; $r | Select-String $keep | ForEach-Object { $_.Line.Trim() } " +
      "} " +
      // quser is the plain-English answer to "is anybody logged on, and is it disconnected?"
      // It is absent on some SKUs, hence the fallback rather than a hard failure.
      "'=== sessions ==='; " +
      "$q = (quser 2>$null); if ($q) { $q } else { 'quser unavailable - Active session state unknown' }"]),
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
