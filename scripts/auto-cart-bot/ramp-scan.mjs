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
 *   VMMAP2M   (added 2026-09-08) the 2-4M mapped population described three ways, because
 *   VMPROT    every ramp so far has cost a round trip of five to twenty-eight hours to answer
 *   VMNAME    ONE question. `AllocationBase` is already in the MEMORY_BASIC_INFORMATION the
 *             walk reads, so counting distinct bases is free and settles what the histogram
 *             cannot: 16k regions with 16k bases is 16k separate sections, 16k regions over
 *             four bases is a few large mappings carved into views, and those are different
 *             bugs. The protection histogram comes from the same struct. And
 *             `K32GetMappedFileNameW` on a BOUNDED sample asks the one question that needs
 *             nobody's cooperation: is there a FILE behind these mappings? Anonymous is what
 *             base::SharedMemory, discardable segments and mojo data pipes all are, so it
 *             hands the question to the memory dump; a named one names the creator outright.
 *             Together with the dump's owner column that closes BOTH branches in one ramp.
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
  "  ' [DllImport(' + $q + 'kernel32.dll' + $q + ', SetLastError=true)] public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr a, out MBI m, IntPtr l);' +",
  // K32GetMappedFileNameW names the FILE behind a mapping, and returns 0 for one that has no
  // file — which is the whole question. A pagefile-backed anonymous section is what
  // `base::SharedMemory`, discardable segments and mojo data pipes all are; a NAMED one is a
  // font cache, a driver's data file or a DLL, and names the creator outright without anybody
  // having to ask Chromium. It needs PROCESS_VM_READ on top of QUERY_INFORMATION, which is
  // why the open below asks for 0x410 first and reports which access it actually got.
  "  ' [DllImport(' + $q + 'kernel32.dll' + $q + ', CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint K32GetMappedFileNameW(IntPtr h, IntPtr a, System.Text.StringBuilder b, uint n); }';",
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
  // 0x410 = PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, which is what GetMappedFileName
  // needs. The two narrower rights still walk the address space, so a refusal costs the NAMES
  // and never the walk — and `access=` says which we got, so an absent VMNAME explains itself
  // instead of reading as `no region has a file behind it`.
  '  $acc = 1040; $h = [ChMem]::OpenProcess(1040, $false, $tp.Pid);',
  '  if ($h -eq [IntPtr]::Zero) { $acc = 1024; $h = [ChMem]::OpenProcess(1024, $false, $tp.Pid) };',
  '  if ($h -eq [IntPtr]::Zero) { $acc = 4096; $h = [ChMem]::OpenProcess(4096, $false, $tp.Pid) };',
  "  if ($h -eq [IntPtr]::Zero) { 'VMWALK pid=' + $tp.Pid + ' status=open-failed err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error(); continue };",
  // The try starts AFTER the open and ends BEFORE the close, so a throw inside the walk costs
  // one process's reading and never the handle, the other process, or the END marker.
  // $ok is what stops a caught throw printing a success line beneath its own error line.
  // Without it a failed walk emits `status=ok regions=` with empty totals, which the readout
  // would read as a completed walk that found nothing — an absent reading wearing an answer's
  // clothes, which is the one shape this whole instrument exists to refuse.
  '  $ok = $true;',
  '  try {',
  "  $mbi = New-Object 'ChMem+MBI';",
  '  $sz = [IntPtr][Runtime.InteropServices.Marshal]::SizeOf($mbi);',
  '  $addr = [IntPtr]::Zero; $it = 0; $cap = 400000; $regions = 0; $capped = $false;',
  '  $tot = @{}; $cnt = @{}; $hist = @{}; $hcnt = @{}; $big = @();',
  // The 2-4M mapped bucket is the population under investigation (31-33 GB of it, 15-16k
  // regions, twice). Three facts about it, all from fields VirtualQueryEx already returns or
  // one bounded extra call, so a ramp answers every branch at once instead of one per event.
  '  $ab = @{}; $prot = @{}; $nm = @{}; $n2m = 0; $nSamp = 0; $nNamed = 0; $nAnon = 0; $lo2m = 0; $hi2m = 0;',
  '  $sb = New-Object System.Text.StringBuilder 300;',
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
  // MEM_MAPPED (262144) in the 2-4M band. AllocationBase is the discriminator that costs
  // nothing: 16k DISTINCT bases is 16k separate MapViewOfFile calls against 16k sections,
  // while a handful of bases would mean a few big mappings carved into 2 MB views - a
  // different bug with a different fix, and the walk has never distinguished them.
  // The bounds are the histogram's `d 2-4M` bucket EXACTLY, so `VMMAP2M regions` and
  // `VMHIST ... d 2-4M count` are the same population and a reader can diff them. A band
  // that merely looked similar would make two lines about one bucket disagree by design.
  '        if ($mbi.Type -eq 262144 -and $rs -ge 2097152 -and $rs -le 4194304) {',
  '          $n2m++;',
  // THE ADDRESS SPAN, and it costs one comparison per region on data already in hand.
  // 16k sections scattered across a 128 TB address space are ordinary shared memory, taken
  // one at a time from wherever the allocator landed. 16k sections packed into a span of a
  // few tens of GB are sub-allocations of ONE reservation - a cage, a pool, a sandbox - and
  // that is a different creator with a different fix. `VMTOP` already prints the big
  // reservations, so a span that falls inside one of them names which.
  '          if ($n2m -eq 1) { $lo2m = $ba; $hi2m = $ba } else { if ($ba -lt $lo2m) { $lo2m = $ba }; if ($ba -gt $hi2m) { $hi2m = $ba } };',
  "          $abk = '0x' + $mbi.AllocationBase.ToInt64().ToString('x');",
  '          if (-not $ab.ContainsKey($abk)) { $ab[$abk] = 0 }; $ab[$abk] = $ab[$abk] + 1;',
  "          $pk = '0x' + $mbi.Protect.ToString('x');",
  '          if (-not $prot.ContainsKey($pk)) { $prot[$pk] = 0 }; $prot[$pk] = $prot[$pk] + 1;',
  // BOUNDED. One call per region over 16k regions would turn a diagnostic into a cost on a
  // box that is already at 40% commit; 64 is enough to tell an all-anonymous population from
  // a named one, and the sample size is printed so the reader knows it is a sample.
  '          if ($acc -ge 1040 -and $nSamp -lt 64) {',
  '            $nSamp++; [void]$sb.Clear();',
  '            $ln = [ChMem]::K32GetMappedFileNameW($h, $mbi.BaseAddress, $sb, 300);',
  '            if ($ln -gt 0) { $nNamed++; $nk = $sb.ToString();',
  '              if (-not $nm.ContainsKey($nk)) { $nm[$nk] = 0 }; $nm[$nk] = $nm[$nk] + 1 } else { $nAnon++ };',
  '          };',
  '        };',
  '      };',
  '      if ($rs -ge 268435456) { $big += New-Object PSObject -Property @{ Base = $ba; Size = [double]$rs; St = $st; Ty = $ty2 } };',
  '    };',
  // A region that does not advance the cursor is a walk that would spin for ever against a
  // process the box cannot afford to be asked twice.
  '    $next = $ba + $rs; if ($next -le $addr.ToInt64()) { break }; $addr = [IntPtr]$next;',
  '  };',
  "  } catch { $ok = $false; 'VMWALK pid=' + $tp.Pid + ' status=error ' + $_.Exception.Message };",
  '  [void][ChMem]::CloseHandle($h);',
  // `capped` is printed on the healthy path too: a truncated walk and a complete one must
  // never read the same, which is the absent-reading-as-a-negative shape this file exists to
  // avoid. Same for `regions` and `iters`.
  '  if ($ok) {',
  "  'VMWALK pid=' + $tp.Pid + ' type=' + $tp.Ty + ' privateMB=' + [int]($tp.Priv / 1MB) + ' status=ok regions=' + $regions + ' iters=' + $it + ' capped=' + $capped;",
  "  foreach ($k in ($tot.Keys | Sort-Object)) { 'VMREGION pid=' + $tp.Pid + ' ' + $k + ' count=' + $cnt[$k] + ' totalMB=' + [int]($tot[$k] / 1MB) };",
  "  foreach ($k in ($hist.Keys | Sort-Object)) { 'VMHIST pid=' + $tp.Pid + ' commit ' + $k + ' count=' + $hcnt[$k] + ' totalMB=' + [int]($hist[$k] / 1MB) };",
  '  $bt = @($big | Sort-Object -Property Size -Descending | Select-Object -First 10);',
  "  foreach ($bg in $bt) { 'VMTOP pid=' + $tp.Pid + ' base=0x' + $bg.Base.ToString('x') + ' sizeMB=' + [int]($bg.Size / 1MB) + ' ' + $bg.St + '/' + $bg.Ty };",
  // The 2-4M mapped population, described three ways. `sampled` and `access` are printed on
  // the healthy path too: a name census that could not run and one that ran and found every
  // region anonymous are opposite readings, and without both numbers they render identically.
  "  'VMMAP2M pid=' + $tp.Pid + ' regions=' + $n2m + ' allocBases=' + $ab.Keys.Count + ' access=' + $acc + ' sampled=' + $nSamp + ' named=' + $nNamed + ' anon=' + $nAnon;",
  // Printed only when there IS a population, because a span over zero regions is not a span.
  // `spanMB` against `regions * 2 MB` is the whole reading: equal-ish means one packed
  // reservation, orders of magnitude larger means scattered.
  "  if ($n2m -gt 0) { 'VMSPAN pid=' + $tp.Pid + ' lo=0x' + $lo2m.ToString('x') + ' hi=0x' + $hi2m.ToString('x') + ' spanMB=' + [int](($hi2m - $lo2m) / 1MB) + ' packedMB=' + [int]($n2m * 2) };",
  "  foreach ($pk in ($prot.Keys | Sort-Object)) { 'VMPROT pid=' + $tp.Pid + ' protect=' + $pk + ' count=' + $prot[$pk] };",
  '  $nt = @($nm.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 10);',
  "  foreach ($ne in $nt) { 'VMNAME pid=' + $tp.Pid + ' count=' + $ne.Value + ' name=' + $ne.Key };",
  '  };',
  '};',
  // ── WHICH THREAD IS BUSY, AND IS IT BUSY AT ALL? ────────────────────────────────────────
  // The one question every CDP instrument is structurally unable to answer. A ramping
  // renderer answers NO memory dump at any level - `detailed`, `background` and `light` were
  // each measured against a wedged renderer in the dev container and all three time out, and
  // a wedged renderer blocks the WHOLE global dump so its healthy peers go missing too. The
  // alloc trail says the same from the other side: `[resident]: EMPTY - that renderer
  // answered no CDP call at all`, for a whole browser life. So there is no "ask it before it
  // goes quiet" window either; it is quiet from birth.
  //
  // This asks WINDOWS instead, and needs nothing from the process. Two snapshots of every
  // thread's CPU time, 1.2 s apart:
  //
  //   • one thread with ~1200 ms of delta  -> it is SPINNING, and `main=True` says whether
  //     the spin is on the renderer's main thread (Blink/JS, the command-buffer client, the
  //     allocator) or on a worker.
  //   • no thread with meaningful delta    -> it is BLOCKED, not looping, and `wait=` names
  //     what on. Nothing has ever distinguished these two and they need opposite fixes.
  //
  // PREDICTED READING on the known 9 GB event (the rule from 2026-09-08): the renderer holds
  // 19 threads and answered no CDP call for 165 s, so either one thread reads ~1200 ms of
  // delta or none does. Neither branch reads ~0, which is why this is worth building where a
  // dump trail was not.
  //
  // NO P/INVOKE, DELIBERATELY. `GetThreadDescription` would name the thread (`CrRendererMain`)
  // and needs three more DllImports in a C# blob that cannot be tested from the dev container
  // - and PowerShell parses the WHOLE script before running any of it, so a syntax error here
  // costs the region walk too. `StartTime` identifies the main thread for free: the earliest
  // thread in a process is the one it started on.
  '$busyMs = 0;',
  'try {',
  '  $t1 = @{};',
  '  foreach ($tp in $targets) { $t1[$tp.Pid] = @{};',
  '    try { $pr = Get-Process -Id $tp.Pid -ErrorAction Stop;',
  '      foreach ($th in $pr.Threads) { try { $t1[$tp.Pid][[string]$th.Id] = [double]$th.TotalProcessorTime.TotalMilliseconds } catch { } } } catch { } };',
  '  Start-Sleep -Milliseconds 1200;',
  '  foreach ($tp in $targets) {',
  '    $pr = $null; try { $pr = Get-Process -Id $tp.Pid -ErrorAction Stop } catch { };',
  "    if ($pr -eq $null) { 'VMTHREAD pid=' + $tp.Pid + ' status=gone'; continue };",
  '    $rows = @(); $mainId = 0; $mainAt = [DateTime]::MaxValue; $busyMs = 0;',
  '    foreach ($th in $pr.Threads) {',
  '      $tid = [string]$th.Id; $cpu = -1; $dl = -1;',
  '      try { $cpu = [double]$th.TotalProcessorTime.TotalMilliseconds } catch { };',
  '      $prev = -1; if ($t1[$tp.Pid].ContainsKey($tid)) { $prev = $t1[$tp.Pid][$tid] };',
  '      if ($cpu -ge 0 -and $prev -ge 0) { $dl = $cpu - $prev };',
  "      $stn = 'unknown'; try { $stn = [string]$th.ThreadState } catch { };",
  "      $wtn = '-'; try { if ($stn -eq 'Wait') { $wtn = [string]$th.WaitReason } } catch { };",
  '      try { if ($th.StartTime -lt $mainAt) { $mainAt = $th.StartTime; $mainId = $th.Id } } catch { };',
  '      if ($dl -gt 0) { $busyMs = $busyMs + $dl };',
  '      $rows += New-Object PSObject -Property @{ Tid = $th.Id; Cpu = $cpu; Dl = $dl; St = $stn; Wt = $wtn };',
  '    };',
  // `windowMs` is printed so a delta can be read as a fraction of a core rather than as a
  // bare number, and `threads` so a truncated top-6 is never mistaken for the whole process.
  "    'VMTHREAD pid=' + $tp.Pid + ' type=' + $tp.Ty + ' status=ok threads=' + $rows.Count + ' windowMs=1200 busyMs=' + [int]$busyMs + ' mainTid=' + $mainId;",
  '    $rt = @($rows | Sort-Object -Property Dl -Descending | Select-Object -First 6);',
  "    foreach ($rw in $rt) { 'VMTHREADTOP pid=' + $tp.Pid + ' tid=' + $rw.Tid + ' main=' + ($rw.Tid -eq $mainId) + ' cpuMs=' + [int]$rw.Cpu + ' deltaMs=' + [int]$rw.Dl + ' state=' + $rw.St + ' wait=' + $rw.Wt };",
  '  };',
  "} catch { 'VMTHREAD unavailable: ' + $_.Exception.Message };",
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
