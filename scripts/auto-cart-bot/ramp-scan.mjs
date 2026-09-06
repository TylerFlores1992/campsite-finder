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
 *   TOP       the fifteen largest processes by private bytes, whoever owns them;
 *   VMWALK    (added 2026-09-05, after the four scans below answered) the committed-region
 *   VMREGION  walk. Those four found the ramping renderer's VIRTUAL size exceeding a healthy
 *   VMHIST    one's by a FIXED 32,780 MB — four readings within 7 MB of each other, present
 *   VMTOP     in a ramp with 18,392 requests on one path AND in a ramp with 197 requests in
 *             eleven hours. One ~32 GiB mapping, committed and untouched (the pagefile
 *             reports 40 GB charged and under 200 MB ever written). `VirtualQueryEx` over
 *             the whole address space answers the two questions left: ONE 32 GB region or
 *             ~16k of 2 MB (VMHIST), and MEM_MAPPED or MEM_PRIVATE (VMREGION). It walks the
 *             largest process by private bytes — which at the trigger IS the ramping
 *             renderer — and an ordinary renderer as a CONTROL, because 32,780 MB is a
 *             difference and a difference needs both terms.
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
 * • The walk goes LAST. `execFile` hands back the stdout it buffered even when it kills the
 *   child on timeout, so a walk that hangs costs the walk and never the readings above it.
 * • The walk REFUSES rather than answers small. A 32-bit host, a failed `Add-Type` and a
 *   refused `OpenProcess` each print themselves; none of them yields an empty region list,
 *   which would read as `there is no 32 GB mapping` — the absent-reading-as-a-negative shape
 *   this file has paid for more than any other.
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
  // ── THE COMMITTED-REGION WALK ───────────────────────────────────────────────────────────
  // The four scans above answered WHERE the commit is not: the ramping renderer's virtual
  // size exceeds a healthy one's by a FIXED 32,780 MB (four readings agreeing to within
  // 7 MB), while its private bytes account for ~3 GB and the pagefile reports 40 GB charged
  // with under 200 MB ever written. That is one ~32 GiB mapping, committed and untouched —
  // the one class private bytes never count, free RAM never reflects and the CDP sampling
  // profiler cannot see. This asks the process itself: `VirtualQueryEx` over its whole
  // address space, bucketed by state and type with a size histogram. One 32 GB region or
  // ~16k of 2 MB, and MEM_MAPPED or MEM_PRIVATE — a yes/no question, not a fishing trip.
  //
  // LAST IN THE SCRIPT ON PURPOSE. `execFile` hands back whatever stdout it buffered even
  // when it kills the child on timeout, so every reading above is already printed and safe
  // by the time this runs; a walk that hangs costs the walk and nothing else.
  //
  // ADD-TYPE COMPILES C# THROUGH csc.exe, WHICH IS A SPAWN. At the onset the box is at ~40%
  // commit and a spawn works; at the peak it does not, which is how every remote lever died
  // on 2026-08-12. That is the whole reason this rides the existing 3 GB trigger.
  //
  // NO LITERAL DOUBLE QUOTE, still: C#'s DllImport needs a string literal, so the quote is
  // spliced in as [char]34 rather than written. Same rule, same reason.
  '$q = [char]34;',
  "$cs = 'using System; using System.Runtime.InteropServices; public class ChMem {' +",
  "  ' [StructLayout(LayoutKind.Sequential)] public struct MBI { public IntPtr BaseAddress;' +",
  "  ' public IntPtr AllocationBase; public uint AllocationProtect; public uint Align1;' +",
  "  ' public IntPtr RegionSize; public uint State; public uint Protect; public uint Type;' +",
  "  ' public uint Align2; }' +",
  "  ' [DllImport(' + $q + 'kernel32.dll' + $q + ', SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, int p);' +",
  "  ' [DllImport(' + $q + 'kernel32.dll' + $q + ', SetLastError=true)] public static extern bool CloseHandle(IntPtr h);' +",
  "  ' [DllImport(' + $q + 'kernel32.dll' + $q + ', SetLastError=true)] public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr a, out MBI m, IntPtr l); }';",
  '$vmOk = $true;',
  // A 32-bit PowerShell can only see a 32-bit slice of a 64-bit process, so its walk would
  // report a small address space and no 32 GB region — a false negative that reads exactly
  // like an answer. It refuses instead.
  "if (-not [Environment]::Is64BitProcess) { $vmOk = $false; 'VMWALK unavailable: 32-bit PowerShell cannot walk a 64-bit address space' };",
  "if ($vmOk) { try { Add-Type -TypeDefinition $cs -ErrorAction Stop } catch { $vmOk = $false; 'VMWALK unavailable: Add-Type ' + $_.Exception.Message } };",
  // THE TARGET IS THE LARGEST BY PRIVATE BYTES, which at the trigger IS the ramping renderer
  // (3,061 MB against ~100 MB for every other process in the same scan) — selected inside
  // PowerShell so nothing has to be interpolated in from Node. THE CONTROL IS AN ORDINARY
  // RENDERER, because 32,780 MB is a DIFFERENCE and a difference needs both terms: without
  // it, 'the ramping one holds a 32 GB mapping' cannot be told from 'every renderer does'.
  '$cand = @();',
  'foreach ($o in $ours) { $pr = Get-Process -Id $o.ProcessId -ErrorAction SilentlyContinue;',
  "  if ($pr) { $ty = 'browser'; if ($o.CommandLine -match '--type=([a-zA-Z-]+)') { $ty = $Matches[1] };",
  '    $cand += New-Object PSObject -Property @{ Pid = $o.ProcessId; Priv = [double]$pr.PrivateMemorySize64; Ty = $ty } } };',
  '$cand = @($cand | Sort-Object -Property Priv -Descending);',
  '$targets = @();',
  'if ($cand.Count -gt 0) { $targets += $cand[0] };',
  "$ctl = @($cand | Where-Object { $_.Ty -eq 'renderer' } | Select-Object -Last 1);",
  'if ($ctl.Count -gt 0 -and $targets.Count -gt 0 -and $ctl[0].Pid -ne $targets[0].Pid) { $targets += $ctl[0] };',
  "if ($cand.Count -eq 0) { 'VMWALK no chrome.exe on our profiles to walk' };",
  'foreach ($tp in $targets) { if (-not $vmOk) { break };',
  // PROCESS_QUERY_INFORMATION (0x400), then PROCESS_QUERY_LIMITED_INFORMATION (0x1000).
  // These are our own children under our own user, so the first should be granted; a refusal
  // is REPORTED with its error code and never rounded to an empty walk. The elevation
  // blindness that has corrupted three readings here reads as $null, and $null is not zero.
  '  $h = [ChMem]::OpenProcess(1024, $false, $tp.Pid);',
  '  if ($h -eq [IntPtr]::Zero) { $h = [ChMem]::OpenProcess(4096, $false, $tp.Pid) };',
  "  if ($h -eq [IntPtr]::Zero) { 'VMWALK pid=' + $tp.Pid + ' status=open-failed err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error(); continue };",
  // The try starts AFTER the open and ends BEFORE the close, so a throw inside the walk costs
  // one process's reading and never the handle, the other process, or the END marker.
  '  try {',
  "  $mbi = New-Object 'ChMem+MBI';",
  '  $sz = [IntPtr][Runtime.InteropServices.Marshal]::SizeOf($mbi);',
  '  $addr = [IntPtr]::Zero; $it = 0; $cap = 400000; $regions = 0; $capped = $false;',
  '  $tot = @{}; $cnt = @{}; $hist = @{}; $hcnt = @{}; $big = @();',
  '  while ($true) {',
  '    if ($it -ge $cap) { $capped = $true; break };',
  '    $it++;',
  '    $r = [ChMem]::VirtualQueryEx($h, $addr, [ref]$mbi, $sz);',
  '    if ($r -eq [IntPtr]::Zero) { break };',
  '    $ba = $mbi.BaseAddress.ToInt64(); $rs = $mbi.RegionSize.ToInt64();',
  '    if ($rs -le 0) { break };',
  // MEM_FREE (0x10000) is most of a 128 TB address space and is not an allocation.
  '    if ($mbi.State -ne 65536) {',
  '      $regions++;',
  "      $st = 'other'; if ($mbi.State -eq 4096) { $st = 'commit' } elseif ($mbi.State -eq 8192) { $st = 'reserve' };",
  "      $ty2 = 'other'; if ($mbi.Type -eq 131072) { $ty2 = 'private' } elseif ($mbi.Type -eq 262144) { $ty2 = 'mapped' } elseif ($mbi.Type -eq 16777216) { $ty2 = 'image' };",
  "      $k = $st + '/' + $ty2;",
  '      if (-not $tot.ContainsKey($k)) { $tot[$k] = [double]0; $cnt[$k] = 0 };',
  '      $tot[$k] = $tot[$k] + $rs; $cnt[$k] = $cnt[$k] + 1;',
  // The histogram is COMMIT only: the OS commit charge is what stepped 35 GB, so reserved
  // address space is not the quantity in question. Labels sort, so the output reads in size
  // order without the reader having to reorder it.
  '      if ($mbi.State -eq 4096) {',
  "        $b = 'h gt1G';",
  "        if ($rs -lt 65536) { $b = 'a lt64K' } elseif ($rs -lt 1048576) { $b = 'b 64K-1M' } elseif ($rs -lt 2097152) { $b = 'c 1-2M' } elseif ($rs -le 4194304) { $b = 'd 2-4M' } elseif ($rs -le 16777216) { $b = 'e 4-16M' } elseif ($rs -le 268435456) { $b = 'f 16-256M' } elseif ($rs -le 1073741824) { $b = 'g 256M-1G' };",
  '        if (-not $hist.ContainsKey($b)) { $hist[$b] = [double]0; $hcnt[$b] = 0 };',
  '        $hist[$b] = $hist[$b] + $rs; $hcnt[$b] = $hcnt[$b] + 1;',
  '      };',
  '      if ($rs -ge 268435456) { $big += New-Object PSObject -Property @{ Base = $ba; Size = [double]$rs; St = $st; Ty = $ty2 } };',
  '    };',
  // A region that does not advance the cursor is a walk that would spin for ever against a
  // process the box cannot afford to be asked twice.
  '    $next = $ba + $rs; if ($next -le $addr.ToInt64()) { break }; $addr = [IntPtr]$next;',
  '  };',
  "  } catch { 'VMWALK pid=' + $tp.Pid + ' status=error ' + $_.Exception.Message };",
  '  [void][ChMem]::CloseHandle($h);',
  // `capped` is printed on the healthy path too: a truncated walk and a complete one must
  // never read the same, which is the absent-reading-as-a-negative shape this file exists to
  // avoid. Same for `regions` and `iters`.
  "  'VMWALK pid=' + $tp.Pid + ' type=' + $tp.Ty + ' privateMB=' + [int]($tp.Priv / 1MB) + ' status=ok regions=' + $regions + ' iters=' + $it + ' capped=' + $capped;",
  "  foreach ($k in ($tot.Keys | Sort-Object)) { 'VMREGION pid=' + $tp.Pid + ' ' + $k + ' count=' + $cnt[$k] + ' totalMB=' + [int]($tot[$k] / 1MB) };",
  "  foreach ($k in ($hist.Keys | Sort-Object)) { 'VMHIST pid=' + $tp.Pid + ' commit ' + $k + ' count=' + $hcnt[$k] + ' totalMB=' + [int]($hist[$k] / 1MB) };",
  '  $bt = @($big | Sort-Object -Property Size -Descending | Select-Object -First 10);',
  "  foreach ($bg in $bt) { 'VMTOP pid=' + $tp.Pid + ' base=0x' + $bg.Base.ToString('x') + ' sizeMB=' + [int]($bg.Size / 1MB) + ' ' + $bg.St + '/' + $bg.Ty };",
  '};',
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
        // 90s, not 45: the region walk adds an Add-Type compile (csc.exe, a spawn) and two
        // address-space walks. The sampler's own in-flight guard covers it, so the cost of a
        // slow scan is at most one skipped two-minute tick, once per ramp.
        run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', RAMP_SCAN_PS],
          { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
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
          // Separate from `complete`: the walk can refuse (32-bit host, Add-Type, OpenProcess)
          // while everything above it succeeds, and a scan missing only the walk is a
          // different fact from a scan that was cut off.
          vmwalk: text.includes('VMWALK '),
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
