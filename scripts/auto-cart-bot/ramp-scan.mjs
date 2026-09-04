/**
 * TAKE THE FULL MEMORY SCAN DURING A RAMP, WITHOUT A HUMAN AT THE KEYBOARD.
 *
 * ── THE QUESTION ────────────────────────────────────────────────────────────────────────────
 * Every Chromium ramp in `chromium_memory_samples` since 2026-09-01 (eleven of them) has the
 * same first sample: Windows COMMIT goes from ~7.5 GB to ~46 GB inside ONE two-minute tick,
 * while the chrome.exe private bytes the sampler sums account for ~3.5 GB of it. Both then
 * climb together at ~450 MB/min to ~52 GB / ~9.4 GB and the browser is replaced. So about
 * 35 GB of commit appears at the onset and is attributed to nothing the series can see —
 * the series sums PRIVATE bytes over OUR chrome.exe only.
 *
 * Three readings fit, and they need different fixes: the commit really is somewhere (a
 * pagefile-backed shared section a renderer created, which private bytes never count; or
 * kernel pool, which no process owns); or `Win32_OperatingSystem`'s virtual-memory figures
 * are a proxy that does not mean what the column says; or the process scan is blind to some
 * of it. One full scan taken DURING a ramp separates them — and the `memory` command only
 * runs when somebody asks, while the ramps arrive every five to six hours.
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────────────────────
 * `bot.mjs` already samples every two minutes. The moment a periodic sample reads the rc
 * family past `RAMP_SCAN_MB`, this runs the full scan ONCE (a cooldown longer than a ramp
 * keeps it to one per event), and posts it as a `ramp-scan` bot event. It reports:
 *
 *   OS        commit used/limit and free RAM from the SAME class the sampler reads, so the
 *             two are comparable;
 *   PERF      `Win32_PerfRawData_PerfOS_Memory` — CommittedBytes and CommitLimit from the
 *             performance counters (an independent measure of the same thing), plus
 *             nonpaged and paged POOL, which is the kernel's share and belongs to no process;
 *   PAGEFILE  allocated / current / peak;
 *   ALLPROC   the SUM of private bytes over EVERY process on the box. If it is close to the
 *             commit figure, the commit is process-attributable and TOP names the owner. If
 *             it is far below, the commit is in shared sections or the kernel;
 *   CHROME    per process on our profiles: type, private, working set, virtual size, pool
 *             charges, handle count and thread count. A renderer holding tens of thousands
 *             of handles is a renderer holding shared-memory sections open;
 *   TOP       the fifteen largest processes by private bytes, whoever owns them.
 *
 * ── RULES ──────────────────────────────────────────────────────────────────────────────────
 * • Runs at the ONSET, not the peak. At 3 GB the box is at ~40% commit and a PowerShell
 *   spawn still works; at 99% it does not, which is how every remote lever died on 08-12.
 * • Every perf-counter read is wrapped: the CIM perf classes can be disabled on a box, and
 *   a scan that dies on one class would lose the rest. A missing class prints as itself.
 * • The PowerShell is a FIXED script: no interpolation, no double quotes (nothing has to
 *   survive Node -> execFile -> powershell.exe), ASCII only.
 * • It never throws into the sampler. A failed scan is a log line and nothing stored — an
 *   absence, which the readout shows as one.
 */

/** The rc family total at which the periodic sample triggers a scan. Baseline is ~300 MB. */
export const RAMP_SCAN_MB = Number(process.env.RAMP_SCAN_MB || 3000);

/**
 * Longer than a ramp (10-12 minutes onset to browser replacement) so one ramp yields one
 * scan, and shorter than the gap between ramps (5-6 hours) so the next one is not missed.
 */
export const RAMP_SCAN_COOLDOWN_MS = Number(process.env.RAMP_SCAN_COOLDOWN_MS || 20 * 60_000);

export const RAMP_SCAN_PS = [
  '$os = Get-CimInstance Win32_OperatingSystem;',
  "'TIME {0:yyyy-MM-dd HH:mm:ss} box local' -f (Get-Date);",
  "'OS commitUsedMB={0} commitLimitMB={1} ramFreeMB={2} ramTotalMB={3}' -f [int](([double]$os.TotalVirtualMemorySize - [double]$os.FreeVirtualMemory) / 1024), [int]([double]$os.TotalVirtualMemorySize / 1024), [int]([double]$os.FreePhysicalMemory / 1024), [int]([double]$os.TotalVisibleMemorySize / 1024);",
  // The performance counters, through their CIM class rather than Get-Counter: counter PATHS
  // are localised and a French or German Windows would answer nothing, while the class and
  // its property names are not. Still wrapped, because the class itself can be disabled.
  'try { $m = Get-CimInstance Win32_PerfRawData_PerfOS_Memory -ErrorAction Stop;',
  "  'PERF committedMB={0} commitLimitMB={1} poolNonpagedMB={2} poolPagedMB={3} availableMB={4} cacheMB={5} sysDriverTotalMB={6}' -f [int]($m.CommittedBytes / 1MB), [int]($m.CommitLimit / 1MB), [int]($m.PoolNonpagedBytes / 1MB), [int]($m.PoolPagedBytes / 1MB), [int]($m.AvailableBytes / 1MB), [int]($m.CacheBytes / 1MB), [int]($m.SystemDriverTotalBytes / 1MB)",
  "} catch { 'PERF unavailable: ' + $_.Exception.Message };",
  'try { $pf = @(Get-CimInstance Win32_PageFileUsage -ErrorAction Stop);',
  "  foreach ($p in $pf) { 'PAGEFILE {0} allocatedMB={1} currentMB={2} peakMB={3}' -f $p.Name, $p.AllocatedBaseSize, $p.CurrentUsage, $p.PeakUsage };",
  "  if ($pf.Count -eq 0) { 'PAGEFILE none in use' }",
  "} catch { 'PAGEFILE unavailable: ' + $_.Exception.Message };",
  // THE DISCRIMINATOR. Private bytes over every process, compared with the commit figure.
  '$all = @(Get-Process -ErrorAction SilentlyContinue); $sumPriv = [double]0; $sumWs = [double]0;',
  'foreach ($q in $all) { $sumPriv += $q.PrivateMemorySize64; $sumWs += $q.WorkingSet64 };',
  "'ALLPROC count={0} privateSumMB={1} workingSetSumMB={2}' -f $all.Count, [int]($sumPriv / 1MB), [int]($sumWs / 1MB);",
  // Our Chromium, per process, with the figures the periodic sample does not carry.
  "$ours = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match '--user-data-dir=\\S*(\\.rc-bot-profile|auto-cart-bot)' });",
  'foreach ($o in $ours) {',
  "  $ty = 'browser'; if ($o.CommandLine -match '--type=([a-zA-Z-]+)') { $ty = $Matches[1] };",
  "  $dir = ''; if ($o.CommandLine -match '--user-data-dir=(\\S+)') { $dir = $Matches[1].Trim([char]34) };",
  "  $fam = 'other'; if ($dir -match '\\.rc-bot-profile') { $fam = 'rc' } elseif ($dir -match 'auto-cart-bot') { $fam = 'recgov' };",
  '  $q = Get-Process -Id $o.ProcessId -ErrorAction SilentlyContinue;',
  "  if ($q) { 'CHROME pid={0} fam={1} type={2} privateMB={3} wsMB={4} virtualMB={5} pagedPoolKB={6} nonpagedPoolKB={7} handles={8} threads={9}' -f $o.ProcessId, $fam, $ty, [int]($q.PrivateMemorySize64 / 1MB), [int]($q.WorkingSet64 / 1MB), [int]($q.VirtualMemorySize64 / 1MB), [int]($q.PagedSystemMemorySize64 / 1KB), [int]($q.NonpagedSystemMemorySize64 / 1KB), $q.HandleCount, $q.Threads.Count }",
  '};',
  '$top = @($all | Sort-Object -Property PrivateMemorySize64 -Descending | Select-Object -First 15);',
  "foreach ($t in $top) { 'TOP {0} pid={1} privateMB={2} wsMB={3}' -f $t.ProcessName, $t.Id, [int]($t.PrivateMemorySize64 / 1MB), [int]($t.WorkingSet64 / 1MB) };",
  "'END';",
].join(' ');

/**
 * @param {{
 *   post: (event: { kind: string, detail: Record<string, unknown>, text: string }) => Promise<unknown>,
 *   log?: (line: string) => void,
 *   exec?: Function,
 *   platform?: string,
 *   now?: () => number,
 *   thresholdMb?: number,
 *   cooldownMs?: number,
 * }} opts
 * @returns {(sample: Record<string, unknown> | null | undefined) => Promise<boolean>}
 *   Resolves true when a scan was taken and posted.
 */
export function createRampScan({
  post, log = () => {}, exec = null, platform = process.platform, now = () => Date.now(),
  thresholdMb = RAMP_SCAN_MB, cooldownMs = RAMP_SCAN_COOLDOWN_MS,
} = {}) {
  let lastAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  return async function maybeScan(sample) {
    const rcMb = Number(sample?.rcMb);
    if (!Number.isFinite(rcMb) || rcMb < thresholdMb) return false;
    if (inFlight) return false;
    if (now() - lastAt < cooldownMs) return false;
    if (platform !== 'win32') return false;
    inFlight = true;
    // Stamped BEFORE the scan, so a scan that throws or hangs is not retried on the very
    // next tick against a box that is already struggling.
    lastAt = now();
    try {
      const run = exec ?? (await import('node:child_process')).execFile;
      const text = await new Promise((resolve) => {
        run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', RAMP_SCAN_PS],
          { timeout: 45_000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => resolve(`${String(stdout || '')}${stderr ? `\nSTDERR ${String(stderr)}` : ''}${err ? `\n[${err.message}]` : ''}`.trim()));
      });
      if (!text) {
        log('  (ramp scan: PowerShell printed nothing)');
        return false;
      }
      await post({
        kind: 'ramp-scan',
        detail: {
          trigger: 'rcMb', rcMb: Math.round(rcMb), thresholdMb,
          commitUsedMb: sample?.commitUsedMb ?? null,
          commitLimitMb: sample?.commitLimitMb ?? null,
          ramFreeMb: sample?.ramFreeMb ?? null,
          maxPid: sample?.maxPid ?? null,
          maxType: sample?.maxType ?? null,
          complete: text.includes('END'),
        },
        text,
      });
      log(`  ✎ ramp scan stored — rc family at ${Math.round(rcMb)} MB, commit ${sample?.commitUsedMb ?? '?'} MB`);
      return true;
    } catch (e) {
      // Never let the measurement break the thing being measured — same rule as the sampler.
      log(`  (ramp scan failed: ${e?.message ?? e})`);
      return false;
    } finally {
      inFlight = false;
    }
  };
}
