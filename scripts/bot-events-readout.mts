/**
 * WHAT THE MINI-PC NOTICED — ramp scans and tab-close timings (migration 075).
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/bot-events-readout.mts [--hours 72] [--all]
 *
 * TWO QUESTIONS, ONE TABLE:
 *
 *   ramp-scan   Where is the ~35 GB of commit that appears at every ramp onset and that
 *               chrome.exe private bytes do not account for? Read ALLPROC privateSumMB
 *               against OS commitUsedMB first: close together means the commit is
 *               process-attributable and TOP names the owner; far apart means shared
 *               sections or kernel pool (PERF poolNonpagedMB / poolPagedMB). Then CHROME
 *               handles= for a renderer holding shared-memory sections open. Since
 *               2026-09-05 it also carries the COMMITTED-REGION WALK (VMWALK/VMREGION/
 *               VMHIST/VMTOP), which names the 32 GB rather than bounding it: read the
 *               bucket share — a handful of regions is ONE mapping, thousands of equal ones
 *               are per-object shared-memory sections — and read it against the CONTROL
 *               renderer walked beside it, because 32,780 MB is a difference.
 *
 *   request-counts  What was the RESIDENT page asking for? Top ten paths by rolling
 *               two-minute count, taken at a bail, at the teardown, or on a hung close
 *               (`reason`). The 09-04 ramp scan found ~35 GB of untouched shared-section
 *               commit on a renderer holding 18,705 handles; a top path at hundreds of hits
 *               in two minutes — Okta's /oauth2/v1/authorize, or an RC /SSO/ endpoint — is a
 *               REQUEST LOOP and names the trigger. Flat counts (tens, spread across RC's
 *               ordinary API) mean the sections are not per-request. Read the `bail` ones
 *               first: a `teardown` fires on every reopen and is mostly the healthy baseline.
 *
 *   mem-dump    WHO OWNS THE SHARED MEMORY? The walk names the class of the 32 GB — ~16k
 *               pagefile-backed sections of 2 MB — and cannot name what created them. This is
 *               Chromium's own answer: per-process allocator roots, a size histogram of its
 *               `shared_memory` mappings in THE SAME BUCKETS the walk uses, and the OWNER of
 *               each mapping from the dump's ownership graph. Read the `ramp` phase against
 *               the `baseline` from the same browser. A big `shared_memory` total with a named
 *               owner is the answer; a SMALL one beside a process the walk says holds 32 GB of
 *               mapped commit is also an answer — it means the sections are not base shared
 *               memory at all, which eliminates discardable, mojo and the GPU transfer path
 *               together. Absent until a ramp has happened on a box running rc-mem-dump.mjs.
 *
 *   tab-close   Is the throwaway tab's close hanging? `closeMs` beside `tripMs`, per trip.
 *               A healthy close is milliseconds. A close that took minutes — or `hung: true`
 *               — is the renderer refusing to answer, and it is why the throwaway-tab cure
 *               never handed anything back. Read the healthy baseline too: a bad number is
 *               only readable next to a good one.
 *
 * NO EVENTS IS THE ORDINARY STATE until the box has updated to code that sends them, and
 * for ramp scans until a ramp has happened since. The absence is an absence, not a reading.
 */
import {
  recentBotEvents, requestCountReason, loopAnswerReading, dumpJoinReading, mappedSwarmReading,
  mappedNameReading, busyThreadReading, mappedSpanReading, servicePairReading, spinSiteReading,
  type BotEventRow, type RequestCountReason, type BusyThreadKind,
} from '@/lib/bot-events';

/**
 * The three leak verdicts come from pure functions now, so they arrive as one long string
 * rather than hand-broken lines. Wrapping here keeps them readable in a terminal without the
 * function having to know about layout — and without a reader having to scroll a 300-char line
 * to reach the word VOID.
 */
const printVerdict = (indent: string, text: string, width = 92): void => {
  const words = text.split(' ');
  let line = '';
  const out: string[] = [];
  for (const w of words) {
    if (line && `${line} ${w}`.length > width) { out.push(line); line = w; } else { line = line ? `${line} ${w}` : w; }
  }
  if (line) out.push(line);
  out.forEach((l, i) => console.log(`${indent}${i === 0 ? '>>> ' : '    '}${l}`));
};

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const hours = Math.max(1, Number(arg('hours', '72')) || 72);
const showAll = process.argv.includes('--all');

const [scans, closes, counts, dumps] = await Promise.all([
  recentBotEvents('ramp-scan', hours, showAll ? 50 : 3),
  recentBotEvents('tab-close', hours, showAll ? 500 : 40),
  recentBotEvents('request-counts', hours, showAll ? 200 : 40),
  recentBotEvents('mem-dump', hours, showAll ? 50 : 6),
]);

const pt = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
const d = (row: BotEventRow) => (row.detail ?? {}) as Record<string, unknown>;

console.log(`BOT EVENTS — last ${hours}h\n`);

console.log(`RAMP SCANS: ${scans.length}${showAll ? '' : ' (newest 3; --all for more)'}`);
if (scans.length === 0) {
  console.log('  none. Ordinary until a ramp has happened on a box running ramp-scan.mjs —');
  console.log('  check chromium_memory_samples for a ramp since the box updated before reading this as silence.');
}
for (const s of scans) {
  const x = d(s);
  // WHICH TRIGGER FIRED DECIDES HOW TO READ THE WHOLE SCAN, so it leads the line. The 32 GiB
  // arrives in a burst of <=34 s while private bytes are still ~1.9 GB, so a scan that fired
  // on `rcMb` (3 GB of PRIVATE bytes) is describing the finished state — that is every walk
  // on file before 2026-09-10, and why they all agree and none names an allocator. A scan
  // that fired on `commitUsedMb` landed while the mapping was still being made, and its
  // thread census is the one that can say WHICH thread was doing it.
  // A row written before the second trigger existed carries no `trigger` at all: that is an
  // absence and says so, rather than being folded into `rcMb` and quietly claiming a reading.
  const trig = x.trigger == null
    ? 'trigger not reported (a box older than the commit trigger)'
    : x.trigger === 'commitUsedMb'
      ? `trigger COMMIT ${x.commitUsedMb} MB — fired DURING the burst, private bytes only ${x.rcMb ?? '?'} MB`
      : x.trigger === 'both'
        ? `trigger both (rc ${x.rcMb} MB and commit ${x.commitUsedMb} MB in one sample)`
        : `trigger rc ${x.rcMb} MB — AFTER the burst; the mapping was already complete`;
  console.log(`\n  ${pt(s.at)} PT  ${trig}  commit ${x.commitUsedMb}/${x.commitLimitMb} MB  free RAM ${x.ramFreeMb} MB  max pid ${x.maxPid} ${x.maxType ?? ''}${x.complete === false ? '  ⚠ scan INCOMPLETE (no END line)' : ''}`);
  const lines = (s.text ?? '').split('\n');
  // The discriminator first, then everything.
  const os = lines.find((l) => l.startsWith('OS '));
  const all = lines.find((l) => l.startsWith('ALLPROC '));
  const perf = lines.find((l) => l.startsWith('PERF '));
  if (os && all) {
    const commit = Number(/commitUsedMB=(\d+)/.exec(os)?.[1]);
    const priv = Number(/privateSumMB=(\d+)/.exec(all)?.[1]);
    if (Number.isFinite(commit) && Number.isFinite(priv)) {
      const gap = commit - priv;
      console.log(`  >>> commit ${commit} MB vs private bytes over EVERY process ${priv} MB — gap ${gap} MB: `
        + (gap < 4000
          ? 'the commit IS process-attributable; read TOP for the owner.'
          : 'the commit is NOT in any process\'s private bytes — shared sections or kernel pool. Read PERF pool figures and CHROME handles.'));
    }
  }
  if (perf) console.log(`  ${perf}`);

  // ── THE COMMITTED-REGION WALK ─────────────────────────────────────────────────────────
  // The gap verdict above says the commit is NOT in any process's private bytes. This says
  // what it IS. Two questions, and the walk answers both: ONE ~32 GB region or ~16k of 2 MB
  // (the histogram), and MEM_MAPPED or MEM_PRIVATE (the region totals). Absent for any event
  // from a box predating the walk, which is an absence and is reported as one.
  const walks = lines.filter((l) => l.startsWith('VMWALK '));
  const refused = lines.filter((l) => l.startsWith('VMWALK unavailable') || / status=open-failed/.test(l));
  if (walks.length === 0) {
    console.log(`  >>> region walk: ${x.vmwalk === undefined
      ? 'this scan predates it (box on older ramp-scan.mjs) — an absence, not a reading.'
      : 'did NOT run. It refuses rather than answering small; the reason is in the text below.'}`);
  }
  for (const r of refused) console.log(`  >>> region walk REFUSED — ${r}`);
  const walked = walks.filter((l) => / status=ok/.test(l));
  const num = (re: RegExp, on: string) => Number(re.exec(on)?.[1]);
  const committedByPid: Array<{ pid: string, role: string, mb: number }> = [];
  /** The TARGET renderer's census verdict, for the service pairing after the loop. */
  let rendererBusy: BusyThreadKind | undefined;
  for (const [i, w] of walked.entries()) {
    const pid = /pid=(\d+)/.exec(w)?.[1];
    if (!pid) continue;
    const mine = (pfx: string) => lines.filter((l) => l.startsWith(`${pfx} pid=${pid} `));
    const commit = mine('VMREGION').filter((l) => / commit\//.test(l));
    const totalMb = commit.reduce((a, l) => a + (num(/totalMB=(\d+)/, l) || 0), 0);
    const count = commit.reduce((a, l) => a + (num(/count=(\d+)/, l) || 0), 0);
    const by = commit.map((l) => `${/ commit\/(\w+)/.exec(l)?.[1]} ${num(/totalMB=(\d+)/, l)} MB`).join(' · ');
    // The control is walked second and exists precisely so this line is a comparison rather
    // than a number: 'the ramping one holds a 32 GB mapping' and 'every renderer does' are
    // different findings and one figure cannot tell them apart.
    const role = i === 0 ? 'TARGET (largest by private bytes — the ramping one at the trigger)' : 'CONTROL (an ordinary renderer)';
    console.log(`  >>> region walk ${role}`);
    console.log(`      ${w.replace('VMWALK ', '')}`);
    console.log(`      committed: ${totalMb} MB across ${count} region(s) — ${by || 'none'}`);
    if (/capped=True/i.test(w)) console.log('      ⚠ CAPPED — the walk hit its iteration bound, so these totals are a FLOOR, not a total.');
    const hist = mine('VMHIST')
      .map((l) => ({ b: /commit ([a-z] [\w-]+)/.exec(l)?.[1] ?? '?', mb: num(/totalMB=(\d+)/, l) || 0, n: num(/count=(\d+)/, l) || 0 }))
      .sort((a, b) => b.mb - a.mb);
    for (const h of hist.slice(0, 3)) console.log(`      ${h.b.slice(2).padEnd(9)} ${String(h.mb).padStart(7)} MB across ${h.n} region(s)`);
    const lead = hist[0];
    if (lead && totalMb > 0) {
      // THE SHARE GATE IS THE WHOLE VERDICT. Without it the leading bucket is named whatever
      // it carries, so a perfectly ordinary renderer with 18% in one bucket was told it held
      // 'a SWARM of per-object shared-memory sections' — caught by rendering the control and
      // reading it. A verdict that fires on every input is the cry-wolf failure, and it would
      // be worse here than useless: it would fire on the CONTROL, which exists to be normal.
      const share = Math.round((lead.mb / totalMb) * 100);
      console.log(`      >>> ${share}% of the committed bytes sit in the ${lead.b.slice(2)} bucket, ${lead.n} region(s): `
        + (share < 60
          ? 'no bucket dominates, so the commit is spread — an ordinary address space.'
          : lead.n <= 4
            ? 'ONE mapping, not a swarm — look for what maps a single region that size.'
            : 'a SWARM of same-sized regions — the shape of per-object shared-memory sections.'));
    }
    for (const t of mine('VMTOP').slice(0, 5)) console.log(`      ${t.replace(`VMTOP pid=${pid} `, 'largest: ')}`);
    /**
     * THE 2-4M MAPPED POPULATION, DESCRIBED THREE WAYS.
     *
     * The histogram above says 15-16k regions of 2 MB carry 31-33 GB. These three lines say
     * whether they are 16k SEPARATE mappings or a few carved up (AllocationBase), what they
     * are mapped for (protection), and whether anything on disk is behind them (the name
     * census). Together with the memory dump they close BOTH branches in one ramp instead of
     * one per event, which is the whole reason they exist.
     */
    const map2m = mine('VMMAP2M')[0];
    const swarm = mappedSwarmReading({
      present: !!map2m,
      regions: map2m && num(/regions=(\d+)/, map2m),
      allocBases: map2m && num(/allocBases=(\d+)/, map2m),
    });
    printVerdict('      ', swarm.text);
    if (swarm.kind !== 'absent' && swarm.kind !== 'none') {
      const prots = mine('VMPROT').map((l) => `${/protect=(\w+)/.exec(l)?.[1]}x${num(/count=(\d+)/, l)}`);
      if (prots.length) console.log(`      >>> 2-4M protection: ${prots.join(' ')}  (0x4 READWRITE, 0x2 READONLY, 0x1 NOACCESS)`);
      const names = mappedNameReading({
        access: num(/access=(\d+)/, map2m!),
        sampled: num(/sampled=(\d+)/, map2m!),
        named: num(/named=(\d+)/, map2m!),
      });
      printVerdict('      ', names.text);
      if (names.kind === 'file-backed') {
        for (const n of mine('VMNAME').slice(0, 6)) console.log(`          ${n.replace(`VMNAME pid=${pid} `, '')}`);
      }
      // WHERE the population sits, which separates one reservation from 16k independent
      // mappings — a different creator with a different fix, and free from a field the walk
      // already reads.
      const span = mine('VMSPAN')[0];
      printVerdict('      ', mappedSpanReading({
        spanMb: span && num(/spanMB=(\d+)/, span),
        packedMb: span && num(/packedMB=(\d+)/, span),
        regions: map2m && num(/regions=(\d+)/, map2m),
      }).text);
    }
    /**
     * SPINNING OR BLOCKED — the one question no CDP instrument can reach.
     *
     * Printed for the CONTROL too. A busy main thread in an ordinary renderer would mean the
     * census measures something every renderer does, and the target's reading would say
     * nothing; that is the same argument that put a control renderer in the walk at all.
     */
    const th = mine('VMTHREAD')[0];
    const tops = mine('VMTHREADTOP');
    const busy = busyThreadReading({
      threads: th && num(/threads=(\d+)/, th),
      windowMs: th && num(/windowMs=(\d+)/, th),
      busyMs: th && num(/busyMs=(\d+)/, th),
      topDeltaMs: tops[0] && num(/deltaMs=(-?\d+)/, tops[0]),
      topIsMain: tops[0] && /main=True/i.test(tops[0]),
      topWait: tops[0] && /wait=(\S+)/.exec(tops[0])?.[1],
    });
    printVerdict('      ', busy.text);
    // Kept so the GPU-process census below can be PAIRED with it. The pairing is the reading:
    // an idle service beside a spinning client is a different fact from an idle service beside
    // an idle client, and one verdict on its own cannot tell them apart.
    if (i === 0) rendererBusy = busy.kind;
    for (const t of tops.slice(0, 4)) console.log(`          ${t.replace(`VMTHREADTOP pid=${pid} `, '')}`);
    committedByPid.push({ pid, role: i === 0 ? 'target' : 'control', mb: totalMb });
  }
  // THE DIFFERENCE, STATED. Printing two blocks and leaving the reader to subtract is how the
  // control stops doing its job: 32,780 MB is an EXCESS over a healthy renderer, and the whole
  // reason a second process is walked is to have both terms on one line.
  if (committedByPid.length === 2) {
    const [t, c] = committedByPid;
    console.log(`  >>> TARGET pid ${t.pid} committed ${t.mb} MB against CONTROL pid ${c.pid} ${c.mb} MB — EXCESS ${t.mb - c.mb} MB.`);
    console.log('      Compare that with the OS commit step at the onset: if they agree, the walk has named the 35 GB.');
  }
  if (walked.length === 1) {
    console.log('  >>> NO CONTROL in this scan — there was only one chrome.exe to walk, so the figures above');
    console.log('      are a measurement and not yet a difference. Do not read them as abnormal on their own.');
  }

  /**
   * THE SERVICE BESIDE THE CLIENT (2026-09-09).
   *
   * The census runs on a THIRD subject — the GPU process of the target's own browser
   * generation — and it is not walked, so nothing in the loop above would ever print it. A
   * reading produced and never rendered is the fix-present-and-inert shape this file has now
   * paid for seven times, so the render is here and it is pinned by a test.
   *
   * The pairing is the point. `MappedMemoryManager` predicts a service nobody is pumping,
   * because the command buffer's tokens cannot advance while the renderer's main thread never
   * returns to its message loop. An idle GPU process is what that predicts; a busy one is a
   * different investigation. Neither is proof, and the verdict says so.
   */
  const gpuTh = lines.find((l) => l.startsWith('VMTHREAD pid=') && / type=gpu-process /.test(l));
  const gpuPid = gpuTh && /pid=(\d+)/.exec(gpuTh)?.[1];
  const gpuTops = gpuPid ? lines.filter((l) => l.startsWith(`VMTHREADTOP pid=${gpuPid} `)) : [];
  const gpuBusy = gpuTh
    ? busyThreadReading({
      threads: num(/threads=(\d+)/, gpuTh),
      windowMs: num(/windowMs=(\d+)/, gpuTh),
      busyMs: num(/busyMs=(\d+)/, gpuTh),
      topDeltaMs: gpuTops[0] && num(/deltaMs=(-?\d+)/, gpuTops[0]),
      topIsMain: gpuTops[0] && /main=True/i.test(gpuTops[0]),
      topWait: gpuTops[0] && /wait=(\S+)/.exec(gpuTops[0])?.[1],
    })
    : undefined;
  if (gpuTh) {
    console.log(`  >>> GPU process (the service beside the ramping renderer)`);
    console.log(`      ${gpuTh.replace('VMTHREAD ', '')}`);
    printVerdict('      ', gpuBusy!.text);
    for (const t of gpuTops.slice(0, 3)) console.log(`          ${t.replace(`VMTHREADTOP pid=${gpuPid} `, '')}`);
  }
  // A scan that looked and found no GPU process in the target's generation says so in its own
  // words, and that sentence is carried into the verdict — `we could not look` and `the service
  // was idle` point in opposite directions and must never render alike.
  const gpuMiss = lines.find((l) => l.startsWith('VMTHREAD gpu-process not found'));
  printVerdict('  ', servicePairReading({
    renderer: rendererBusy,
    gpu: gpuBusy?.kind,
    gpuNote: gpuMiss?.replace('VMTHREAD ', ''),
  }).text);

  /**
   * WHERE THE SPINNING THREAD IS EXECUTING — the step past the census.
   *
   * The census says the main thread is in a loop; this says whether that loop is Chromium's
   * code or the page's, which are different bugs with different fixes. It renders BELOW the
   * pairing on purpose: the pairing is about the candidate, and this is about the cause.
   */
  const stk = lines.find((l) => l.startsWith('VMSTACK pid='));
  // Read the status VALUE rather than testing for one of them: `not-spinning` and `unmeasured`
  // both stand the sampler down and only one is a statement about the thread.
  const stkStatus = stk && / status=(\S+)/.exec(stk)?.[1];
  const stkNote = lines.find((l) => l.startsWith('VMSTACK unavailable') || l.startsWith('VMSTACK no '));
  const stkExec = lines.find((l) => l.startsWith('VMSTACKEXEC'));
  const stkMod = lines.find((l) => l.startsWith('VMSTACKMOD'));
  const stkClass = lines.find((l) => l.startsWith('VMSTACKCLASS'));
  const stkSpread = lines.find((l) => l.startsWith('VMSTACKSPREAD'));
  const stkTops = lines.filter((l) => l.startsWith('VMSTACKTOP'));
  const stkBuild = lines.find((l) => l.startsWith('VMSTACKBUILD'));
  if (stk || stkNote) {
    console.log('  >>> where the spinning thread is executing');
    if (stk) console.log(`      ${stk.replace('VMSTACK ', '')}`);
    // The per-address lines are the payload: on the module branch these ARE the offsets to
    // symbolize, and printing only the verdict would leave a reader with a conclusion and
    // nothing to act on.
    for (const t of stkTops.slice(0, 6)) console.log(`          ${t.replace(/^VMSTACKTOP pid=\d+ /, '')}`);
  }
  printVerdict('  ', spinSiteReading({
    present: Boolean(stk),
    status: stkStatus,
    read: stk && num(/ read=(\d+)/, stk),
    executable: stkExec && num(/ executable=(\d+)/, stkExec),
    notExecutable: stkExec && num(/ notExecutable=(\d+)/, stkExec),
    module: stkClass && num(/ module=(\d+)/, stkClass),
    anonExec: stkClass && num(/ anonExec=(\d+)/, stkClass),
    distinct: stkSpread && num(/ distinct=(\d+)/, stkSpread),
    topAt: stkTops[0] && / at=(.+)$/.exec(stkTops[0])?.[1],
    topCount: stkTops[0] && num(/ count=(\d+)/, stkTops[0]),
    build: stkBuild && / chrome\.dll=(\S+)/.exec(stkBuild)?.[1],
    modules: stkMod && num(/ modules=(\d+)/, stkMod),
    note: stkNote?.replace('VMSTACK ', ''),
  }).text);

  for (const l of lines) console.log(`    ${l}`);
}

/**
 * MEMORY DUMPS. The reading the region walk cannot take: Chromium's own attribution of the
 * shared-memory mappings whose 2 MB swarm the walk measured from the outside.
 *
 * Ramp phase first — it is the event — then the baseline it is a change from.
 */
const SHM_ANSWER_MB = 4_000;
/**
 * How far apart a memory dump and a region walk may be and still describe one event.
 *
 * Both ride the SAME 3 GB trigger, so in practice they land within a minute of each other
 * (09-07: scan 02:03:24, dump 02:04:03). Thirty minutes is generous enough to survive a slow
 * scan and short enough that the next ramp — five hours away at the tightest observed gap —
 * can never be joined to the previous one's walk.
 */
const JOIN_WINDOW_MS = 30 * 60_000;
console.log(`\nMEMORY DUMPS: ${dumps.length}${showAll ? '' : ' (newest 6; --all for more)'}`);
if (dumps.length === 0) {
  console.log('  none. Ordinary until the box runs rc-mem-dump.mjs AND a ramp has happened since —');
  console.log('  the baseline needs a browser three minutes old, the ramp reading needs the rc family');
  console.log('  past the bar. Check chromium_memory_samples for a ramp before reading this as silence.');
} else {
  const showDump = (row: BotEventRow) => {
    const x = d(row);
    const lead = (x.lead ?? null) as null | Record<string, any>;
    console.log(`\n  ${pt(row.at)} PT  ${String(x.phase ?? '?')}  ${x.processes ?? '?'} process(es)  ${x.ms ?? '?'}ms`
      + `${x.partial ? `  ⚠ PARTIAL (${x.partial})` : ''}${x.edgesCapped ? '  ⚠ ownership edges CAPPED' : ''}`);
    if (!lead) {
      console.log('  >>> no process reported allocators — the dump ran and Chromium said nothing.');
      console.log('      That is a refusal wearing a reading\'s clothes; read the box log for the reason.');
    } else {
      console.log(`      lead pid ${lead.pid} (${lead.mainThread ?? 'thread unknown'}) — shared_memory `
        + `${lead.shmMb} MB across ${lead.shmCount} mapping(s)`);
      if (lead.topBucket) {
        console.log(`      biggest bucket ${lead.topBucket.bucket}: ${lead.topBucket.mb} MB across ${lead.topBucket.n} mapping(s)`);
      }
      console.log(`      biggest owner  ${lead.topOwner
        ? `${lead.topOwner.owner} — ${lead.topOwner.mb} MB across ${lead.topOwner.n}`
        : 'none: no ownership edge named one'}`);
      if (lead.unownedMb) console.log(`      unowned        ${lead.unownedMb} MB — mapped, with no edge claiming it`);
      // AN ARRAY, biggest first. It was an object until a rendered fixture showed jsonb had
      // re-sorted the keys by LENGTH, putting the largest allocator third.
      const roots = (Array.isArray(lead.roots) ? lead.roots : []) as Array<{ name: string; mb: number | null }>;
      const shown = roots.map((r) => `${r.name} ${r.mb === null ? 'notReported' : `${r.mb}MB`}`).join(' · ');
      if (shown) console.log(`      roots          ${shown}`);
      // A CROSS-CHECK, PRINTED ONLY WHEN IT FAILS. Chromium's own `shared_memory` root total
      // and our sum over its per-mapping children describe the same population; a gap means
      // the fold missed mappings, and on Windows this is the only check available.
      if (typeof lead.shmRootMb === 'number' && Math.abs(lead.shmRootMb - Number(lead.shmMb)) > Math.max(8, lead.shmRootMb * 0.05)) {
        console.log(`      ⚠ Chromium's own shared_memory root reads ${lead.shmRootMb} MB against our ${lead.shmMb} MB —`);
        console.log('        the fold is missing mappings, so treat the owner attribution as partial.');
      }
      /**
       * THE VERDICT, AND BOTH BRANCHES ARE ANSWERS. This is the whole reason the dump is worth
       * taking on the reading where it attributes nothing: the walk has already established
       * that the ramping renderer holds ~32 GB of MAPPED commit, so a `shared_memory` total in
       * the tens of MB is not a failure — it says those sections never went through
       * `base::SharedMemoryMapping`, which retires discardable, mojo and the GPU transfer path
       * in one line. Only the `ramp` phase is entitled to either verdict; a baseline is a
       * control and is supposed to look ordinary.
       */
      if (x.phase === 'ramp') {
        /**
         * ── THE JOIN, DONE HERE RATHER THAN ASKED FOR ──────────────────────────────────────
         *
         * The dump is coordinated by the browser process, so a renderer that will not answer
         * is MISSING from it rather than empty — and missing, read as small, is the one false
         * elimination this instrument can manufacture. It did exactly that on 2026-09-07: a
         * `bail:ramp` killed the ramping generation, the supervisor restarted within seconds,
         * and the dump measured the replacement — lead pid 7316 against the walk's target
         * 9912, with 7316 turning up as the BASELINE's lead three minutes later.
         *
         * That readout told a human to check the pid themselves. Nobody can be relied on to,
         * so it is checked here: the verdict below is not printed at all unless the ramping
         * renderer is in the dump.
         *
         * A SECOND WAY IT GOES VOID, AND IT IS NOT THIS ONE. On 2026-09-08 21:43 the dump
         * reached the RIGHT generation — seven pids, every one in the scan's own CHROME list —
         * and spent its whole 20,000 ms waiting for the eighth, the ramping renderer. Passing
         * the generation is what lets the text say which happened; asserting the 09-07
         * mechanism on that event sent the reader to fix a trigger that had just worked.
         */
        const near = scans
          .map((sc) => ({ sc, gap: Math.abs(Date.parse(sc.at) - Date.parse(row.at)) }))
          .filter((c) => c.gap <= JOIN_WINDOW_MS)
          .sort((a, b) => a.gap - b.gap)[0]?.sc ?? null;
        const join = dumpJoinReading({
          walkTargetPid: near ? /^VMWALK pid=(\d+) .*status=ok/m.exec(near.text ?? '')?.[1] ?? null : null,
          dumpPids: [...String(row.text ?? '').matchAll(/^MDPROC pid=(\d+)/gm)].map((m) => m[1]),
          // Every chrome.exe the scan saw — the browser GENERATION. Without it, "the dump
          // measured a different browser" and "this browser answered minus the ramping
          // renderer" are the same line, and those need opposite fixes.
          walkGenerationPids: near ? [...String(near.text ?? '').matchAll(/^ *CHROME pid=(\d+)/gm)].map((m) => m[1]) : null,
          // Processes Chromium's coordinator timed out — present, contributing nothing. The
          // fold records these now, so without this the ramping renderer would read as having
          // ANSWERED and the small-shared-memory verdict would print over an empty dump.
          dumpEmptyPids: [...String(row.text ?? '').matchAll(/^MDPROC pid=(\d+)[^\n]*\bempty=yes/gm)].map((m) => m[1]),
          walkNearby: !!near,
        });
            printVerdict('  ', join.text);
        // THE VERDICT IS NOT PRINTED AT ALL ON A VOID JOIN. Qualifying it would leave the
        // sentence a reader quotes ('only 2 MB of tracked shared memory') on the page.
        if (join.kind === 'void') {
          // nothing further: the reading is about a different browser generation.
        } else if (Number(lead.shmMb) >= SHM_ANSWER_MB) {
          console.log(`  >>> the sections ARE base shared memory (${lead.shmMb} MB of it), so the OWNER column`);
          console.log(`      names the subsystem that created them${lead.topOwner ? `: ${lead.topOwner.owner}` : ' — and none is named, which is itself the next question'}.`);
        } else {
          console.log(`  >>> only ${lead.shmMb} MB of tracked shared memory on the lead process. Read that against`);
          console.log('      the region walk in the ramp-scan for the SAME event: if the walk says ~32 GB of');
          console.log('      commit/mapped and this says tens of MB, the sections are NOT base shared memory —');
          console.log('      which eliminates discardable, mojo and the GPU transfer path together.');
          // The join above has already established that the ramping renderer answered, so
          // this reading is about that process and not about a bystander. What is left is
          // what a small figure MEANS, and it is an answer rather than a gap.
          console.log('      The join above confirms the ramping renderer answered, so this is not the');
          console.log('      missing-process case — it is a real small reading. Next: the 2-4M name census in');
          console.log('      the ramp-scan. All-anonymous plus a small shared_memory total puts the creator');
          console.log('      outside Chromium\'s tracked allocators; a file-backed name says who it is outright.');
        }
      }
    }
    if (showAll && row.text) for (const l of row.text.split('\n')) console.log(`    ${l}`);
  };
  const ramps = dumps.filter((r) => d(r).phase === 'ramp');
  const bases = dumps.filter((r) => d(r).phase !== 'ramp');
  for (const r of ramps) showDump(r);
  if (bases.length) {
    console.log(`\n  baselines (the control${showAll ? '' : ', newest 2'}):`);
    for (const r of (showAll ? bases : bases.slice(0, 2))) showDump(r);
  }
  if (!showAll) console.log('\n  (--all prints the per-process roots, histogram and owners.)');
}

console.log(`\nTAB CLOSES: ${closes.length}${showAll ? '' : ' (newest 40; --all for more)'}`);
if (closes.length === 0) {
  console.log('  none. Ordinary until the box runs tab-close.mjs and a trip has happened since.');
} else {
  const hung = closes.filter((c) => d(c).hung === true).length;
  const slow = closes.filter((c) => Number(d(c).closeMs) > 5_000 && d(c).hung !== true).length;
  console.log(`  ${hung} given up on (hung), ${slow} slow (>5s but closed), ${closes.length - hung - slow} prompt.`);
  console.log('  time (PT)            trip        tripMs   closeMs  hung  ramMb');
  for (const c of closes) {
    const x = d(c);
    console.log(`  ${pt(c.at).padEnd(20)} ${String(x.label ?? '?').padEnd(11)} ${String(x.tripMs ?? '?').padStart(7)}  ${String(x.closeMs ?? '?').padStart(7)}  ${x.hung ? 'YES ' : ' no '}  ${x.ramMb ?? '-'}`);
  }
  if (hung) {
    console.log('\n  >>> A hung close is the renderer not answering. The keep-warm recycles the browser on');
    console.log('      the next loop pass; the memory series should show the ramp ending at that moment.');
  } else if (closes.some((c) => Number(d(c).tripMs) > 300_000)) {
    console.log('\n  >>> Closes are prompt but a trip took over five minutes: the time is in the renewal');
    console.log('      BODY (its bounded waits timing out in series), not in the close. Different fix.');
  }
}

/**
 * REQUEST COUNTS. Bails first — they are the reading taken during a ramp — then hung closes,
 * then the newest few teardowns as the baseline to read them against.
 */
type TopRow = { key: string; recent: number; lifetime: number; statuses?: Record<string, number> };
const LOOP_HITS = 100;
console.log(`\nREQUEST COUNTS: ${counts.length}${showAll ? '' : ' (newest 40; --all for more)'}`);
if (counts.length === 0) {
  console.log('  none. Ordinary until the box runs rc-request-count.mjs and the resident browser has been');
  console.log('  torn down or bailed since. A teardown happens on every reopen, so this stays empty only');
  console.log('  while the box has not updated.');
} else {
  // ONE classifier, not two filters that can drift apart — which is exactly how they did.
  // The bail arms name themselves (`bail:ramp`), so an equality test on 'bail' matched none of
  // them: the summary read `0 at a bail` over real bails and they printed last, below the
  // teardowns. See `requestCountReason`.
  const byReason = (r: RequestCountReason) => counts.filter((c) => requestCountReason(d(c).reason) === r);
  const bails = byReason('bail');
  const hungs = byReason('hung-close');
  const tears = byReason('teardown');
  const other = byReason('other');
  console.log(`  ${bails.length} at a bail, ${hungs.length} on a hung close, ${tears.length} at a teardown${other.length ? `, ${other.length} other` : ''}.`);
  const show = (c: BotEventRow, full: boolean) => {
    const x = d(c);
    const top = (Array.isArray(x.top) ? x.top : []) as TopRow[];
    const win = Math.round(Number(x.windowMs ?? 120_000) / 1000);
    const lower = x.windowOverflowed ? '≥' : '';
    console.log(`\n  ${pt(c.at)} PT  ${String(x.reason ?? '?')}  browser ${Math.round(Number(x.ageMs ?? 0) / 60_000)}m old  `
      + `${lower}${x.recentTotal ?? '?'} in ${win}s / ${x.lifetimeTotal ?? '?'} lifetime  ${x.distinct ?? '?'} path(s)${x.capped ? ' (capped)' : ''}`);
    const rows = full ? top : top.slice(0, 3);
    // ALL OR NOTHING PER EVENT: a bundle that reports statuses gives every row at least `{}`.
    // So when none has them the event predates the change, and the ANSWERS line below says so
    // once — repeating "statuses not reported" on ten rows is the noise that buries the line
    // worth reading, which is the same argument the teardown's compact form is built on.
    const reported = top.some((r) => r.statuses);
    for (const r of rows) {
      // `no answers` and a missing field are DIFFERENT states, so an empty mix is never blank.
      const mix = reported
        ? `  ${Object.entries(r.statuses ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(' ') || 'no answers'}`
        : '';
      console.log(`      ${String(r.recent).padStart(6)} in ${win}s  ${String(r.lifetime).padStart(7)} lifetime  ${r.key}${mix}`);
    }
    const lead = top[0];
    if (full && lead) {
      if (lead.recent >= LOOP_HITS) {
        console.log(`  >>> ${lead.recent} hits on one path in ${win}s is a REQUEST LOOP: ${lead.key}`);
        // NOT "the trigger is named", which is what this line said until 2026-09-05 and what a
        // single bail talked me into. Two ramps hours apart carry the IDENTICAL 32 GB mapping
        // signature (virtualMB 3,727,55x against a healthy renderer's 3,694,7xx, paged pool
        // ~66.5 MB, ~17-19k handles) and one of them had 18,392 hits on one path while the other
        // had 197 requests in ELEVEN HOURS. A loop cannot be the cause of an event it is absent
        // from. Report the loop as a real observation and refuse the causal claim.
        console.log('      A LOOP IS NOT THE RAMP\'S CAUSE — a ramp with a flat counter (09-05 07:31, 197 requests');
        console.log('      in 11h) carried the same 32 GB mapping. Worth fixing on its own; do not credit the ramp to it.');
        // WHICH KIND of loop, which is the field page.on('request') could never see.
        console.log(`      ANSWERS: ${loopAnswerReading(lead).text}`);
        if (/oauth2|\/authorize|\/SSO\//i.test(lead.key)) {
          console.log('      That is the SPA\'s own silent renewal. Blocking prompt=none on the resident page is a cure to');
          console.log('      weigh — known cost: the silent self-renewal that works most hours is the same mechanism.');
        }
      } else {
        console.log(`  >>> flat: the busiest path had ${lead.recent} hits in ${win}s, so no loop ran here.`);
        console.log('      Ramps happen with and without one — see the 32 GB mapping entry in CLAUDE.md.');
      }
    }
  };
  for (const c of bails) show(c, true);
  for (const c of hungs) show(c, true);
  const baseline = showAll ? tears : tears.slice(0, 3);
  if (baseline.length) {
    console.log(`\n  teardowns (baseline${showAll ? '' : ', newest 3'}):`);
    for (const c of baseline) show(c, false);
  }
  for (const c of other) show(c, true);
}
