/**
 * KILL ANY CHROMIUM LEFT ON THE RC PROFILE BY A PROCESS THAT NO LONGER EXISTS.
 *
 * ── WHY THIS EXISTS (2026-08-18) ───────────────────────────────────────────────────────────
 * A Chromium renderer reached 25 GB and took the box to 94% COMMIT — the level at which
 * Windows stops scheduling tasks, which has twice taken every recovery path down with it. The
 * size guard fired FIVE times during it and freed nothing:
 *
 *     20:02:40  rc  5,118 MB  pid 13004 renderer  64% COMMIT   free 4,361 MB
 *     20:06:45  rc 17,811 MB  pid 13004           83%          free   982 MB
 *     20:12:52  rc 25,307 MB  pid 13004           94%          free   163 MB
 *
 * `max_pid` is 13004 in EVERY sample, across three recycles. And at 20:02:40 — one second
 * after a browser opened at 20:02:39 — pid 13004 was already 4,953 MB. A renderer born that
 * second cannot be five gigabytes, so 13004 predates the reopen: it is an ORPHAN, left behind
 * when the keep-warm process restarted mid-login at 20:01:51.
 *
 * **`ctx.close()` is not a kill, and the guard measures a family it cannot act on.**
 * `rcFamilyMb()` totals every Chromium on the profile directory; the recycle closes only the
 * context THIS process owns. An orphan is fully visible to the measurement and invisible to
 * the remedy — so the guard recycled a healthy browser over and over while reporting the
 * corpse's memory as its reason. Fourth instance in this repo of a guard whose remedy does not
 * reach the thing it measures.
 *
 * It also meant a SECOND Chromium ran on one `user-data-dir`, which is the corruption case
 * `profile-lock.mjs` exists to prevent. The lock did not stop it because an orphan holds no
 * lock file: the dying process released it on the way out and the next keep-warm took it and
 * launched anyway.
 *
 * ── THE LOCK IS THE WHOLE SAFETY ARGUMENT. READ THIS BEFORE MOVING THE CALL ─────────────────
 * This must run AFTER the profile lock is acquired and BEFORE `launchPersistentContext`.
 *
 * `rc-hold-runner.mjs` drives the SAME profile directory. A sweep on plain process start could
 * therefore land at 08:00:00 on the Chromium that is carting a site — which is the single
 * worst thing this repo can do. Once WE hold the lock the runner does not, so anything still
 * on that profile is by definition owned by nobody. That is exactly the orphan, and nothing
 * else. "At startup" is a one-word edit that turns a fix into an incident.
 *
 * The lock also removes an ambiguity that has bitten `kill-chrome` twice: its re-check runs
 * three seconds after the kill, long enough for a supervisor to have opened a NEW browser, so
 * a clean kill followed by a healthy restart printed the same words as a kill that reached
 * nothing. Here nothing is permitted to open a browser on this profile while we hold the lock,
 * so a survivor is unambiguously a survivor.
 *
 * ── THE ONE PARTICIPANT THAT DOES NOT RESPECT THE LOCK ─────────────────────────────────────
 * `rc-diag.mjs --real-profile` opens `.rc-bot-profile` directly and takes no lock. Its own
 * header already says to stop the bots first, and CLAUDE.md records that the watchdog restarts
 * the RC pair within five minutes unless the scheduled task is DISABLED — so that session is
 * already required to hold the box still. What changes here is the failure mode if it is not:
 * today the restarted keep-warm merely fails to launch (`exitCode=21`, profile in use); with
 * this sweep it kills the diagnostic's browser instead. Disable the watchdog, as that
 * procedure already requires.
 *
 * `rc-probe.mjs` is NOT affected — it uses `.rc-probe-profile`, which this pattern cannot
 * match.
 *
 * ── WHY NOT IN THE HOLD RUNNER, AND WHY NOT IN THE TRIP PATH ───────────────────────────────
 * Both are deliberate, and both are about WHEN a PowerShell spawn is affordable.
 *
 *   * NOT in `rc-hold-runner.mjs`. Spawning costs a second or two on the one path where
 *     latency is the product — the measured carts are T+1.8s, T+43s, T+49s after a release.
 *     The keep-warm reopens constantly (every profile yield, every guard trip, every restart),
 *     so an orphan is reaped within minutes anyway, long before any 08:00. If the runner ever
 *     does need this, the right shape is a sweep on a FAILED launch — the remedy firing on the
 *     symptom — not a spawn before every cart.
 *   * NOT in the size guard's trip path. Spawning is precisely what fails as COMMIT passes
 *     ~95%: that is how `supervise.ps1` could not start a shell on 2026-08-12 and how the
 *     Scheduled Tasks stopped on 2026-08-17. An instrument that goes quiet as the emergency
 *     peaks reports the emergency as calm. Here we run while COMMIT is still normal.
 */
import { execFile } from 'node:child_process';

/**
 * The RC profile family, as a PowerShell regex — the SAME expression `kill-chrome rc` uses.
 *
 * `\S*` and not `[^"]*`: Playwright launches the PARENT with the path unquoted and Chrome
 * re-quotes it for its own renderer/GPU/utility children, so a class excluding `"` cannot
 * cross that opening quote and would match the parent alone. That bug shipped in both stop
 * scripts and left every child alive holding the real Chrome lock (2026-08-14).
 *
 * `worker/chromium-attribution.test.mts` asserts every `--user-data-dir` kill pattern in the
 * repo matches both shapes, this one included.
 */
export const RC_PROFILE_PATTERN = '--user-data-dir=\\S*\\.rc-bot-profile';

/**
 * A FIXED script. Nothing is interpolated into it from anywhere, which is the rule
 * `worker/bot-commands.test.mts` caught being broken once: the scope must choose between
 * constant strings and contribute not one character.
 */
const PS = [
  `$pat = '${RC_PROFILE_PATTERN}';`,
  // Fetched ONCE and filtered twice, so the blind count and the match count cannot come from
  // two different instants. Same rule as memory-sample.mjs.
  "$all = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' });",
  // AN UNELEVATED WMI QUERY READS $null FOR CommandLine on a process in another security
  // context, so `-match` drops it silently. That is not "nothing of ours is running", it is
  // "this scan could not see" — the third state that reports identically to the first.
  // It is reported and it is SAFE: an unreadable process cannot match the pattern, so a blind
  // scan under-kills. It can never over-kill.
  "$blind = @($all | Where-Object { -not $_.CommandLine });",
  "'B|{0}' -f $blind.Count;",
  '$ours = @($all | Where-Object { $_.CommandLine -match $pat });',
  "'N|{0}' -f $ours.Count;",
  // PIDS, NOT JUST A COUNT. A count cannot tell a kill that failed from a kill that worked,
  // which is the "7 before, 7 after" misreading of 2026-08-12.
  "foreach ($o in $ours) { 'P|{0}' -f $o.ProcessId };",
  // What we are about to reclaim, so the log says what it ACHIEVED rather than that it ran.
  '$sum = 0; foreach ($o in $ours) { $q = Get-Process -Id $o.ProcessId -ErrorAction SilentlyContinue; if ($q) { $sum += $q.PrivateMemorySize64 } };',
  "'MB|{0}' -f [int]($sum/1MB);",
  // THE SLEEP AND THE RE-CHECK ONLY WHEN THERE IS SOMETHING TO KILL. This runs on every
  // reopen, and the overwhelmingly common case is zero — paying two seconds for that would be
  // a tax on the keep-warm's whole cadence for an event that happens a few times a day.
  'if ($ours.Count -gt 0) {',
  '  foreach ($o in $ours) { Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue };',
  // Chromium takes a moment to actually go, and a kill that is merely ISSUED is not a kill
  // that happened — the same reason restart-rc re-checks before relaunching.
  '  Start-Sleep -Seconds 2;',
  "  $left = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match $pat });",
  "  foreach ($o in $left) { 'S|{0}' -f $o.ProcessId };",
  '}',
  "'DONE';",
].join(' ');

/**
 * Parse the sweep's output.
 *
 * PURE, and separated from the spawning so it can be tested on a machine with no PowerShell —
 * which is every machine this repo is written from. Same split as `parseSample`.
 *
 * `ran: false` means the script did not complete, and it is NEVER the same as "found none".
 * That distinction is the one this codebase keeps having to re-learn: a zero recorded for a
 * scan that never ran reads as evidence of health.
 */
export function parseSweep(text) {
  const out = { ran: false, blind: 0, killed: [], survived: [], mb: 0 };
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (s === 'DONE') out.ran = true;
    else if (s.startsWith('B|')) out.blind = Number(s.slice(2)) || 0;
    else if (s.startsWith('P|')) out.killed.push(Number(s.slice(2)));
    else if (s.startsWith('S|')) out.survived.push(Number(s.slice(2)));
    else if (s.startsWith('MB|')) out.mb = Number(s.slice(3)) || 0;
  }
  // A pid that is still there was not killed, whatever the attempt reported.
  out.killed = out.killed.filter((p) => !out.survived.includes(p));
  return out;
}

/**
 * Sweep the RC profile. Returns the parsed result, or null when it could not run.
 *
 * NEVER THROWS AND NEVER BLOCKS FOR LONG. This sits between taking the lock and opening the
 * browser, so a sweep that hangs is a keep-warm that never comes back — which would be a
 * worse outage than the one it prevents. Every failure path returns null and the caller
 * carries on and launches, exactly as it does today.
 *
 * @param {{ exec?: Function, platform?: string, log?: (msg: string) => void }} [opts]
 */
export async function sweepOrphanChromium(opts = {}) {
  const { exec = execFile, platform = process.platform, log = () => {} } = opts;
  if (platform !== 'win32') return null;
  const { text, errText } = await new Promise((resolve) => {
    exec(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        text: err && !stdout ? '' : String(stdout || ''),
        errText: `${String(stderr || '')}${err ? ` [${err.message}]` : ''}`.trim(),
      }),
    );
  });
  const r = parseSweep(text);
  if (!r.ran) {
    // LOUD, because this is the guard failing rather than finding nothing — and stderr is the
    // one line that says why. memory-sample.mjs discarded it once and threw away the only
    // explanation it had.
    log(`  ⚠ orphan sweep did not complete${errText ? ` — ${errText.slice(0, 300)}` : ' and PowerShell printed nothing'}`);
    return null;
  }
  // SILENT ON THE ORDINARY PATH. This runs on every reopen — many times an hour — and a line
  // each time would bury the events worth reading. Speak only when something was there.
  if (r.killed.length) {
    log(`♻ orphan sweep: killed ${r.killed.length} Chromium left on the RC profile by a dead `
      + `owner (${r.mb} MB, pid ${r.killed.join(', ')}). Nothing else may hold this profile `
      + 'while we have the lock, so these were owned by nobody.');
  }
  if (r.survived.length) {
    log(`  ⚠ ${r.survived.length} would not die (pid ${r.survived.join(', ')}) — Chromium may `
      + 'refuse the profile. mini-pc\\stop-rc.ps1 is the stronger lever.');
  }
  if (r.blind > 0 && r.killed.length === 0) {
    log(`  (orphan sweep: ${r.blind} Chromium had an unreadable command line — this process `
      + 'may not be elevated, so the sweep may have under-killed. It cannot over-kill.)');
  }
  return r;
}
