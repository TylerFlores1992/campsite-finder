/**
 * SAMPLE THIS BOX'S CHROMIUM MEMORY, ON A TIMER, AND SEND IT TO THE SERVER.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 * On 2026-08-12 one chrome.exe on one of our profiles reached 9.4 GB private, growing about
 * 395 MB/min, and took Windows COMMIT to 99% of 50 GB. `supervise.ps1` could then not start a
 * shell, so the process whose whole job is recovery failed at the one moment it exists for —
 * and every remote lever with it. The box had to be power-cycled by hand. WHICH PROFILE FAMILY
 * DID IT HAS NEVER BEEN ESTABLISHED; it was guessed twice and wrong both times.
 *
 * The `memory` command answers "right now", and a human has to be there to ask. That is not a
 * small inconvenience, it is the reason this is still unattributed after three sightings:
 *
 *   * `keepSessionsWarm` opens a rec.gov Chromium per enrolled user every THIRTY MINUTES and
 *     closes it again — so the family that has never been ruled out is EPISODIC, and a
 *     five-minute pair of readings has about one chance in ten of overlapping one.
 *   * Run on 2026-08-14 the prescribed two readings produced exactly that: eight processes,
 *     every one on the RC profile, a NEGATIVE rate, and not a single rec.gov process sampled.
 *     A clean answer to a question it could not have reached.
 *
 * So the sampling is automated and the series is kept server-side. Same remedy as
 * `recgov_rate_profile` for the 429 question and `rc_app_session_probes` for the RC session.
 *
 * ── WHY SERVER-SIDE AND NOT A LOG FILE ─────────────────────────────────────────────────────
 * A local log is the cheaper build and the wrong one, by measurement. On 2026-08-12 the
 * keep-warm's log FROZE at 15:56:38 through Windows file locking while the process went on
 * reporting to the server perfectly — and the standing rule from that night is to check the
 * thing that reports to the SERVER before believing two local diagnostics.
 *
 * ── WHAT IT CANNOT DO, SAID OUT LOUD ───────────────────────────────────────────────────────
 * Taking a sample spawns PowerShell, and spawning anything is precisely what fails at 99%
 * commit — the `supervise.ps1` failure above IS this failure. So the last few samples before
 * the box dies will be missing, and the series will end in a gap rather than a peak. That is
 * honest and still useful: the ramp is the signature, and a gap that begins mid-ramp is itself
 * evidence of where it got to. It is NOT a reading of zero, and the readout must never show it
 * as one.
 */
import { execFile } from 'node:child_process';

/** How often a sample is taken. At ~395 MB/min this is ~800 MB of resolution on the ramp. */
export const SAMPLE_EVERY_MS = 2 * 60_000;

/** The three families, in the fixed order the readout prints them. */
export const FAMILIES = ['rc', 'recgov', 'other'];

/**
 * Which family owns a `--user-data-dir`.
 *
 * ORDER IS LOAD-BEARING AND IS THE WHOLE BUG THIS FILE IS ABOUT. The RC profile lives INSIDE
 * the rec.gov one's parent directory:
 *
 *     RC       ...\scripts\auto-cart-bot\.rc-bot-profile
 *     rec.gov  ...\scripts\auto-cart-bot\profiles\<userId>
 *
 * so testing `auto-cart-bot` first files every RC process under rec.gov — which is exactly the
 * misattribution that has already been made twice by hand. The specific path is tested first.
 *
 * `worker/chromium-memory.test.mts` checks this agrees with the PowerShell classifier in
 * bot-commands.mjs on the canonical paths, because two implementations of one rule is two
 * chances to fix one and forget the other.
 */
export function classifyProfile(dir) {
  const d = String(dir ?? '');
  if (/\.rc-bot-profile/.test(d)) return 'rc';
  if (/auto-cart-bot/.test(d)) return 'recgov';
  return 'other';
}

/**
 * The reading, as PowerShell.
 *
 * Emits INTEGERS in a pipe-delimited shape rather than JSON or `{0:N1}`. `N1` inserts a
 * thousands separator and both it and a decimal point are locale-dependent, so "9,123.4" or
 * "9123,4" would arrive from a box configured differently and be silently mis-parsed — and a
 * memory figure wrong by a factor of a thousand is the kind of number somebody acts on. A
 * Windows path cannot contain `|`, so the delimiter is safe. Megabyte granularity is far finer
 * than a leak measured in hundreds of MB per minute needs.
 *
 * No double quote has to survive Node -> execFile -> powershell, same rule as bot-commands.mjs.
 */
const PS = [
  '$os = Get-CimInstance Win32_OperatingSystem;',
  // These CIM figures are in KILOBYTES, hence /1024 for MB.
  '$cLim = [double]$os.TotalVirtualMemorySize / 1024;',
  '$cFree = [double]$os.FreeVirtualMemory / 1024;',
  '$ramFree = [double]$os.FreePhysicalMemory / 1024;',
  "'M|{0}|{1}|{2}' -f [int]($cLim - $cFree), [int]$cLim, [int]$ramFree;",
  // Fetched ONCE and filtered twice, so the two counts below cannot come from two different
  // instants — an ours/blind pair taken a second apart is not a pair.
  "$all = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' });",
  "$ours = @($all | Where-Object { $_.CommandLine -match '--user-data-dir=\\S*(\\.rc-bot-profile|auto-cart-bot)' });",
  // HOW MANY CHROMIUM WE COULD NOT READ AT ALL - the third state (2026-08-15).
  //
  // An UNELEVATED WMI query returns $null for CommandLine on a process in another security
  // context, so `-match` drops it silently. That is not "none of ours are running", it is
  // "this scan could not see". Measured the day this went in: at 05:12:24 an unelevated
  // bot.mjs scanned and recorded `rc 0`, while the SAME filter from the elevated process
  // seconds either side reported NINE - identical PowerShell, opposite answers, differing
  // only in elevation. The row that got stored said zero.
  //
  // `C|` was added to separate "found none" from "never ran". This is the state that reports
  // identically to the first and is neither: the same bug, one level in. stop-all.ps1 counts
  // exactly this and for exactly this reason.
  "$blind = @($all | Where-Object { -not $_.CommandLine });",
  "'B|{0}' -f $blind.Count;",
  // HOW MANY THE SCAN MATCHED, emitted BEFORE the per-process loop.
  //
  // Without this, "the scan completed and found no Chromium of ours" and "the scan never
  // completed" are the same evidence: no `P|` lines. Both are real - 2026-08-14 had a reading
  // with genuinely zero of our browsers running - so the absence cannot be interpreted, and
  // `parseSample` was resolving the ambiguity by assuming the happy one and recording 0.
  //
  // It also localises the failure. A `C|9` with no `P|` lines means the loop is what broke; no
  // `C|` at all means PowerShell stopped before reaching it. Same idea as the RcReport channel
  // and as `--once` being made to go through `withRC`: an instrument that cannot say which of
  // two things happened is only half an instrument.
  "'C|{0}' -f $ours.Count;",
  'foreach ($o in $ours) {',
  "  $dir = ''; if ($o.CommandLine -match '--user-data-dir=(\\S+)') { $dir = $Matches[1] };",
  // WHICH KIND OF CHROMIUM PROCESS. The heap trail settled that the leak is not the JS heap
  // (16 MB, flat, while the process reached 4,903 MB), and the next fork is which process is
  // growing: a renderer, the GPU process, a utility process or the browser itself are four
  // different investigations. Chromium already puts it on the command line we are reading.
  //
  // THE BROWSER PROCESS CARRIES NO `--type` AT ALL, so an absent match is the parent and is
  // recorded as such rather than as unknown - that distinction is the whole point here.
  "  $ty = 'browser'; if ($o.CommandLine -match '--type=([a-zA-Z-]+)') { $ty = $Matches[1] };",
  // Chrome re-quotes the path for its renderer/GPU/utility children, so most processes report
  // it wrapped in quotes. Left in, the same profile would classify and group as two.
  '  $dir = $dir.Trim([char]34);',
  '  $q = Get-Process -Id $o.ProcessId -ErrorAction SilentlyContinue;',
  '  $mb = 0; if ($q) { $mb = [int]([double]$q.PrivateMemorySize64/1MB) };',
  // TYPE BEFORE DIR, because the directory is a path that may itself contain `|` and is
  // therefore joined from the remainder by the parser. A field appended after it would be
  // swallowed by that join.
  "  'P|{0}|{1}|{2}|{3}' -f $o.ProcessId, $mb, $ty, $dir;",
  '};',
].join(' ');

/**
 * Turn the reading into a sample.
 *
 * Kept separate from the spawning so it can be tested on a machine with no PowerShell — which
 * is every machine this repo is written from, and the reason the last two PowerShell bugs
 * (`\"` is not a cmd escape; the op_Addition rollup) shipped and ran broken for weeks.
 *
 * An unparseable or absent M line returns nulls rather than zeros. Zero commit is a reading
 * nobody could ever take, and a plausible zero is worse than a blank — that is the whole
 * lesson of the family rollup printing `rc 0 MB` while the RC profile held 312 MB.
 */
export function parseSample(text) {
  // THE FAMILY COUNTS START AS null, NOT 0 (2026-08-14).
  //
  // They started at 0, and that made the sampler lie on its first day in production. Every
  // sample recorded `rc 0 procs, 0 MB` while the `memory` command - interleaved with it,
  // seconds apart, on the same box, through a BYTE-IDENTICAL filter - was reporting NINE
  // Chromium processes on `.rc-bot-profile`. The commit figures in the same rows were correct,
  // so PowerShell was running and only the process scan was coming back empty.
  //
  // The header of this file already states the rule those zeros broke: an absent reading
  // returns nulls rather than zeros, because a plausible zero is worse than a blank. It was
  // applied to the `M|` line and not to the scan - the same half-application that let the
  // sibling `memory` rollup print `FAMILY rc 0 MB` over a profile holding 312 MB.
  //
  // A zero is only written when the `C|` line proves the scan actually ran. See PS above.
  const out = {
    commitUsedMb: null,
    commitLimitMb: null,
    ramFreeMb: null,
    rcProcs: null, rcMb: null,
    recgovProcs: null, recgovMb: null,
    otherProcs: null, otherMb: null,
    maxPid: null, maxMb: null, maxFamily: null,
    /**
     * Which KIND of Chromium process the biggest one is: `browser`, `renderer`, `gpu-process`,
     * `utility`. Null means the box is running a build that predates this field — NOT that the
     * type is unknowable, and the readout must not print it as a measured absence.
     */
    maxType: null,
    /** Per-type MB within the `rc` family, e.g. `{ renderer: 3052, 'gpu-process': 890 }`. */
    rcByType: {},
    /**
     * Did the scan report a count? Only then is "no processes" a reading rather than a gap.
     *
     * NOT a column - `recordMemorySample` reads named fields and ignores this. It exists so
     * the caller can say out loud that the scan did not report, which is the difference
     * between a quiet box and a broken instrument.
     */
    scanned: false,
    /**
     * Chromium the scan could not read at all - see the `B|` line in PS above. Also not a
     * column; it decides whether an empty scan is a measurement or a blindfold.
     */
    blind: 0,
  };
  const num = (s) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('M|')) {
      const [, used, limit, ramFree] = line.split('|');
      out.commitUsedMb = num(used);
      out.commitLimitMb = num(limit);
      out.ramFreeMb = num(ramFree);
    } else if (line.startsWith('C|')) {
      // THE SCAN COMPLETED. From here a family with no processes is a measured zero rather
      // than an absence, so the counters are baselined - including for families the scan
      // legitimately found none of, which is the common and healthy case.
      if (num(line.split('|')[1]) === null) continue;
      out.scanned = true;
      for (const f of FAMILIES) {
        out[`${f}Procs`] ??= 0;
        out[`${f}Mb`] ??= 0;
      }
    } else if (line.startsWith('B|')) {
      out.blind = num(line.split('|')[1]) ?? 0;
    } else if (line.startsWith('P|')) {
      // The directory may itself be empty if the match failed; split with a limit so a path
      // is never truncated at a character it cannot contain anyway.
      const parts = line.split('|');
      const pid = num(parts[1]);
      const mb = num(parts[2]);
      // BACKWARD COMPATIBLE ON PURPOSE. A box running the previous build emits the four-field
      // form, and this parser is shared with it for as long as the update takes. An older row
      // must read as "type not reported" rather than being mis-parsed into the directory —
      // which would classify every process as `other` and silently empty the rc family.
      const hasType = parts.length >= 5;
      const type = hasType ? (parts[3] || null) : null;
      const dir = parts.slice(hasType ? 4 : 3).join('|');
      if (pid === null || mb === null) continue;
      const fam = classifyProfile(dir);
      // A `P|` without its `C|` still counts - losing a real process because the count line
      // went missing would be the opposite mistake, and worse.
      out[`${fam}Procs`] = (out[`${fam}Procs`] ?? 0) + 1;
      out[`${fam}Mb`] = (out[`${fam}Mb`] ?? 0) + mb;
      // The largest single process, because the 08-12 event was ONE process at 9.4 GB and a
      // family total cannot tell that apart from thirty ordinary ones.
      if (out.maxMb === null || mb > out.maxMb) {
        out.maxMb = mb;
        out.maxPid = pid;
        out.maxFamily = fam;
        out.maxType = type;
      }
      // Per-type totals for the family under suspicion. `max` alone said 3,052 of 4,903 MB —
      // so most of a ramp sits OUTSIDE the biggest process, and naming only the biggest would
      // describe under two thirds of it.
      if (fam === 'rc' && type) out.rcByType[type] = (out.rcByType[type] ?? 0) + mb;
    }
  }

  // A BLINDFOLDED SCAN IS NOT A MEASURED ZERO (2026-08-15).
  //
  // Saw nothing of ours AND there was Chromium it could not read: that is the one
  // combination where the zero is indistinguishable from the blindness, so it reverts to
  // null - which the readout already prints as a dash and excludes from every verdict. The
  // file header's rule, applied to the state it did not yet know about.
  //
  // A PARTIAL reading (saw some, blind to others) deliberately keeps its numbers. Nulling
  // it would throw away real processes to express a doubt, and an undercount that is present
  // still shows a ramp; the log line below is what carries the doubt. Erring the other way
  // would delete data on any box where the owner's own browser runs as another user.
  if (out.scanned && out.blind > 0 && !FAMILIES.some((f) => (out[`${f}Procs`] ?? 0) > 0)) {
    for (const f of FAMILIES) {
      out[`${f}Procs`] = null;
      out[`${f}Mb`] = null;
    }
  }
  return out;
}

/**
 * Take one reading. Resolves to null if PowerShell could not be run at all.
 *
 * STDERR IS READ NOW, and only to be logged (2026-08-14). It was discarded, so when the
 * process scan came back empty on a box with nine of our browsers running, the reason was
 * thrown away at the point it was produced - and the row that got stored said `0`. A
 * diagnostic that drops the one line explaining itself is the failure this whole table
 * exists to stop happening elsewhere.
 */
/**
 * @param {{ exec?: Function, platform?: string, log?: (msg: string) => void }} [opts]
 */
export async function takeSample(opts = {}) {
  const { exec = execFile, platform = process.platform, log = () => {} } = opts;
  if (platform !== 'win32') return null;
  const { text, errText } = await new Promise((resolve) => {
    exec(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS],
      { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
      // A failure to read memory must never become a failure of the bot. An empty string
      // parses to nulls, which the readout shows as "not reported".
      (err, stdout, stderr) => resolve({
        text: err && !stdout ? '' : String(stdout || ''),
        errText: `${String(stderr || '')}${err ? ` [${err.message}]` : ''}`.trim(),
      }),
    );
  });
  if (!text.includes('M|')) return null;
  const sample = parseSample(text);
  // SAY SO. `scanned === false` means the reading carries commit figures and no process
  // evidence at all, which the row now records as null rather than as zero - and this is the
  // only place the reason is still in hand.
  if (!sample.scanned) {
    log(`  (memory sample: the Chromium scan did not report${errText ? ` - ${errText.slice(0, 300)}` : ' and PowerShell printed nothing'})`);
  } else if (sample.blind > 0) {
    // ALWAYS SAID, even on a partial reading where the numbers were kept. This is the only
    // place the reason is still in hand, and "recorded as unknown" and "recorded, possibly
    // short" are different facts about the row that was just stored.
    const kept = sample.rcProcs !== null;
    log(`  (memory sample: ${sample.blind} Chromium had an unreadable command line - this ` +
      `process may not be elevated; ${kept ? 'the counts below may be short' : 'the families are recorded as UNKNOWN, not zero'})`);
  }
  return sample;
}

/**
 * Call this from a poller's tick. It samples at most once per SAMPLE_EVERY_MS and never
 * throws.
 *
 * The interval is held in memory rather than a file on purpose — the cost of a restart is one
 * extra row, which is nothing, whereas `restart-rc`'s marker is a file because the cost of
 * ITS limit resetting is an RC login from an address that has already been blocked once.
 * Match the guard to what a mistake costs.
 *
 * ── A FORCED SAMPLE, FOR A FAMILY THE INTERVAL CANNOT SEE (2026-08-15) ────────────────────
 * The interval cannot measure the rec.gov keepalive family, and the reason is arithmetic
 * rather than luck. `keepSessionsWarm` opens a browser per enrolled user every thirty
 * minutes and closes it again in a few SECONDS — measured from the box's own log against
 * these sample timestamps:
 *
 *     [04:01:23] interval fires   [04:01:27] user A warmed   [04:01:49] user B warmed
 *     samples at 03:59:34, 04:01:35, 04:03:35 — the one inside the window fell in the GAP
 *
 * That is under 1% coverage, so 175 consecutive samples reporting `recgov 0` is the EXPECTED
 * reading and not a lead. Worse, a verdict needs a rate, the rate rule pairs two samples of
 * the same pid, and the cadence is two minutes — so a rate would need the process to outlive
 * two minutes. A five-second browser cannot produce one rarely; it cannot produce one at all.
 *
 * So the caller that KNOWS the browser is open — because it opened it — asks for a sample
 * then. Same rule as `rc-keepwarm` posting its own verdict rather than a watcher inferring
 * it: the process that knows is the process that reports.
 *
 * A forced sample deliberately does NOT reset the interval clock. The periodic series is the
 * backbone and its cadence should stay even; and leaving it alone means a periodic sample can
 * land shortly after a forced one, which is the only way this instrument ever pairs two
 * readings of a keepalive browser — it happens exactly when the browser FAILED to close,
 * which is the runaway case.
 *
 * @typedef {Record<string, number | string | boolean | null | Record<string, number>>} MemorySample
 *   Flat scalars, plus `rcByType` — a per-process-type MB map added with migration 062.
 * @param {{
 *   post: (sample: MemorySample, source?: string) => Promise<unknown>,
 *   log?: (msg: string) => void,
 *   now?: () => number,
 *   take?: () => Promise<MemorySample | null>,
 * }} opts
 */
export function createSampler({ post, log = () => {}, now = () => Date.now(), take }) {
  // The default reader gets THIS sampler's log, so a scan that does not report has somewhere
  // to say so. Tests pass their own `take` and are unaffected.
  const readOne = take ?? (() => takeSample({ log }));
  // -Infinity, not 0, so the FIRST tick always samples whatever the clock reads. With 0 the
  // behaviour depended on the epoch being far from zero, which is true of Date.now() and of
  // nothing else - so the series would have started an interval late, or not at all under a
  // monotonic clock. The first sample dates the beginning of the series and is worth having.
  let last = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  /**
   * @param {{ force?: boolean, source?: string }} [opts]
   *   `force` skips the interval (see the header). `source` is stored on the row, so a
   *   forced reading is never mistaken for the periodic series when the two are compared.
   */
  return async function maybeSample({ force = false, source } = {}) {
    if (inFlight) {
      // SAY SO WHEN A FORCED SAMPLE IS LOST. The interval can afford to skip a tick; a forced
      // one is the only sighting of a browser that exists for about five seconds, and a
      // silent miss is indistinguishable from a family that was not running.
      if (force) log('  (memory sample: a reading was already in flight — keepalive not sampled)');
      return false;
    }
    if (!force && now() - last < SAMPLE_EVERY_MS) return false;
    inFlight = true;
    if (!force) last = now();
    try {
      const sample = await readOne();
      if (!sample) return false;
      await post(sample, source);
      return true;
    } catch (e) {
      // Never let the measurement break the thing being measured. This is fire-and-forget by
      // design: reaching camphawk.app is not this process's job, carting campsites is.
      log(`  (could not record a memory sample: ${e.message})`);
      return false;
    } finally {
      inFlight = false;
    }
  };
}
