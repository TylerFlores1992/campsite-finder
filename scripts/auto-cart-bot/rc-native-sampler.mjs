/**
 * NAME THE ALLOCATION. Every other instrument here has narrowed the leak from outside; this
 * one asks Chromium what it actually allocated, and gets a symbolized C++ stack back.
 *
 * ## What is already known, and the hole this fills
 *
 * The ramp is triggered by the Okta navigation — a controlled comparison, not a correlation
 * (2026-08-18: three token-less renewals ten minutes apart, and only the one that clicked
 * through to Okta cost anything). It lands in the RENDERER (+1,237 MB) plus the browser
 * process (+545 MB), with GPU, utility and crashpad flat. And the JS heap is flat at 15-18 MB
 * while the process reaches gigabytes.
 *
 * What has NEVER been observed is what allocates. "Network/IPC buffering" is written into
 * three separate entries as the leading explanation and has never been tested. Five
 * instruments, twenty ramps, and the candidate space has never been cut by direct evidence.
 *
 * ## Why the heap trail could not have found it, demonstrated
 *
 * Measured locally before this was written, because the alternative is another inference:
 * 640 MB of `Uint8Array` allocated in a page reports **`JSHeapUsedSize` = 0.0 MB**. External
 * memory — ArrayBuffers, decoded images, network buffers — is simply not in that number.
 *
 * So "the JS heap is flat while the process is 25 GB" eliminates far LESS than it appears to.
 * It rules out ordinary JS retention (an array nobody trims, our fetch wrapper holding `init`)
 * and rules out nothing else. That reading has been treated here as though it eliminated the
 * whole JavaScript-adjacent family; it does not.
 *
 * ## Why a sampler and not a heap snapshot
 *
 * `rc-heap.mjs` already records why a snapshot is the wrong instrument at these sizes: a
 * snapshot of a 25 GB heap is itself many GB, written to disk on a box that at that moment
 * cannot spawn a process — the cure arriving as part of the disease. This has the opposite
 * shape. It is a Poisson sampler: the response scales with the number of DISTINCT STACKS, not
 * with bytes allocated, so a 2.3 GB ramp produces a few dozen rows. Measured: 640 MB of
 * ArrayBuffer came back as 43 samples totalling 642 MB — attribution accurate to 0.3%, in a
 * response of a few kilobytes.
 *
 * ## The two properties that make it usable at all
 *
 * **IT IS STARTED AT LAUNCH, WHILE THE BROWSER IS HEALTHY.** The same lesson as
 * `attachHeapProbe`: CDP goes quiet as the ramp peaks, twice measured — `newCDPSession` failed
 * on the first firing and `Performance.getMetrics` on the second, which together established
 * that the reading cannot be taken at the trip at all. Sampling accumulates from launch, so
 * the expensive call is made when nothing is wrong and only the cheap read has to land.
 *
 * **IT IS READ AFTER THE TRIP RETURNS, NOT AT THE GUARD.** The renewals that ramp 2.3 GB
 * mostly COMPLETE; it is only the RAM-guard kills that do not. Reading immediately after the
 * Okta round trip returns catches the common case, and the guard's existing heap facts stay
 * as the fallback for the case that dies.
 *
 * ## Known limits, stated rather than discovered later
 *
 * **THE BROWSER PROCESS CANNOT BE PROFILED THIS WAY.** `Memory.startSampling` is not present
 * on the browser target — verified, not assumed: `'Memory.startSampling' wasn't found`. So the
 * renderer's share is reachable and the browser process's +545 MB is not. That is the larger
 * half but not the whole, and a reading here that accounts for only part of a ramp is EXPECTED
 * rather than a fault. Say so in the output; a number that silently describes two thirds of
 * the growth is how "the biggest process" became a whole explanation once already.
 *
 * **Symbolization is partial, and on WINDOWS it is absent.** The 1,083-of-1,733 figure this
 * header used to quote was measured against the Chromium in the Linux dev container. The first
 * real reading off the mini-PC, 2026-08-22 19:34 PT, symbolized almost nothing:
 *
 *     43 MB while free RAM moved -161 MB
 *       22 MB  <V8 Heap>
 *       14 MB  0x7ffc499b1707 <- 0x7ffc4375aa42
 *        4 MB  0x7ffc499b1707 <- 0x7ffc44ec485f
 *
 * Playwright's Windows Chromium exports no internal symbols, so the frames that matter arrive
 * as bare addresses. "Partial" was a fair description of Linux and a wrong one about production
 * — the same measured-on-the-wrong-platform trap as `cap sync`'s plugin path and the headless
 * RC login. A ramp read this way would have named nothing, after days of waiting for one.
 *
 * **So addresses are resolved to `module+offset`, from the `modules` array CDP already returns**
 * alongside `samples` and which this file previously discarded. Two things that buys:
 *
 *   * **A STABLE IDENTITY.** Module bases move per process under ASLR, so a raw address groups
 *     within one profile and nowhere else — two readings of the same site are two rows. The
 *     offset is fixed for a build, so `chrome.dll+0x4a12b30` is the same site tomorrow.
 *   * **AN OFFLINE SECOND STEP.** Each module carries a `uuid` identifying the exact binary, so
 *     an offset can be symbolized later against that build's symbols. The reading stops being a
 *     dead end even when nothing on the box can name it.
 *
 * **WHAT THIS DOES NOT BUY, said plainly:** on Windows almost all of Chromium lives in one
 * `chrome.dll`, so the module NAME alone discriminates little — the value is the offset. The
 * exception is worth watching for: a frame landing in a SYSTEM dll (`ws2_32`, `winhttp`,
 * `mswsock`) would be a finding on its own, since that is the network stack the buffering
 * candidate names, and it is the one thing the name can tell us for free.
 */

/** Bound on every CDP round trip. The browser may be in trouble; nothing here may hang. */
const CDP_TIMEOUT_MS = Number(process.env.RC_SAMPLER_CDP_TIMEOUT_MS || 5_000);

/**
 * Mean bytes between samples. 1 MB is coarse on purpose: the sampler's cost scales with the
 * rate, this runs continuously on the browser that carts campsites, and the events being
 * chased are measured in GIGABYTES — a megabyte of resolution is three orders of magnitude
 * finer than the signal.
 */
const SAMPLING_INTERVAL = Number(process.env.RC_SAMPLER_INTERVAL_BYTES || 1_048_576);

/** How many allocation sites to report. The tail is noise at these magnitudes. */
const TOP_N = 6;

/**
 * Frames belonging to the profiler itself. They sit on top of EVERY stack it captures, so
 * grouping on the literal top frame would put all memory under one meaningless label — which
 * is exactly what the first local run printed, six identical rows of
 * `SamplingHeapProfiler::CaptureStackTrace()`.
 */
const PROFILER_FRAMES = /SamplingHeapProfiler|PoissonAllocationSampler/;

/** Promise bound. A timeout is itself a reading — "the browser would not answer". */
function within(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in ${ms}ms`)), ms)),
  ]);
}

/**
 * Begin sampling. Call ONCE, at launch, on a healthy browser.
 *
 * @returns {Promise<{ok: boolean, why: string}>} Never throws: a browser that will not start
 *   sampling must not stop the keep-warm from running. The whole feature is diagnostic.
 */
export async function startNativeSampling(cdp) {
  if (!cdp) return { ok: false, why: 'no CDP session' };
  try {
    await within(
      cdp.send('Memory.startSampling', {
        samplingInterval: SAMPLING_INTERVAL,
        // NOT suppressed. Randomness is what makes a Poisson sampler unbiased; suppressing it
        // is a determinism aid for tests and would skew a production attribution.
        suppressRandomness: false,
      }),
      CDP_TIMEOUT_MS, 'Memory.startSampling',
    );
    return { ok: true, why: `sampling every ~${Math.round(SAMPLING_INTERVAL / 1024)} KB` };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

/**
 * Parse CDP's address field, which the protocol documents as "decimal or hexadecimal (0x
 * prefixed)". BigInt because these are 64-bit and a module base can sit above 2^53 — a Number
 * would round silently, which for an address means a wrong offset rather than an error.
 *
 * Returns null for anything unparseable. This crosses CDP from a browser that is, by the
 * assumption motivating the whole instrument, misbehaving.
 */
function toAddr(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^(0[xX][0-9a-fA-F]+|\d+)$/.test(s)) return null;
  try { return BigInt(s); } catch { return null; }
}

/** `C:\...\chrome.dll` -> `chrome.dll`. The path is noise; the binary is the fact. */
function moduleBasename(name) {
  const s = String(name ?? '').trim();
  if (!s) return '?';
  const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return cut >= 0 ? s.slice(cut + 1) : s;
}

/**
 * @typedef {{name: string, uuid: string, base: bigint}} ResolvedModule
 * @typedef {(addr: bigint) => ResolvedModule|null} Resolver
 * @typedef {{name?: string, uuid?: string, baseAddress?: string|number, size?: number}} CdpModule
 */

/**
 * Build an address -> module lookup from the `modules` array CDP returns beside `samples`.
 *
 * @param {CdpModule[]|null|undefined} modules
 * @returns {Resolver} — the lookup returns null for an address in no known module, which is a
 *   real case (JIT code, and anything the browser did not report) and must stay
 *   distinguishable from "we had no module list at all".
 */
export function moduleResolver(modules) {
  const mods = [];
  for (const m of modules ?? []) {
    const base = toAddr(m?.baseAddress);
    const size = Number(m?.size);
    if (base == null || !Number.isFinite(size) || size <= 0) continue;
    mods.push({ name: moduleBasename(m?.name), uuid: String(m?.uuid ?? ''), base, end: base + BigInt(Math.trunc(size)) });
  }
  // A handful to a few hundred modules, consulted a few thousand times per read. Linear is
  // fine and a binary search here would be a bug surface for no measurable gain.
  return (addr) => mods.find((m) => addr >= m.base && addr < m.end) ?? null;
}

/**
 * One stack frame, rendered as the most stable identity available for it.
 *
 * The ladder is deliberate, best first:
 *   1. a SYMBOL, when the build has one — identical across builds, let alone runs;
 *   2. `module+0xoffset`, which is fixed for a build and is what makes the Windows readings
 *      groupable at all, and symbolizable offline afterwards;
 *   3. the bare address, which groups within one profile and nowhere else. Kept rather than
 *      dropped: a row that says `0x7ffc499b1707` is poor, and losing the bytes entirely is
 *      worse — the total must still add up.
 *
 * @param {string} frame
 * @param {Resolver|null} resolve
 */
function renderFrame(frame, resolve) {
  const f = String(frame ?? '');
  const m = /^(0[xX][0-9a-fA-F]+)\s*(.*)$/.exec(f);
  if (!m) return f.trim() || f;                  // `<V8 Heap>` and other non-address labels
  const symbol = m[2].trim();
  if (symbol) return symbol;
  if (!resolve) return m[1];
  const addr = toAddr(m[1]);
  const mod = addr == null ? null : resolve(addr);
  if (!mod) return m[1];
  return `${mod.name}+0x${(addr - mod.base).toString(16)}`;
}

/**
 * The allocator frame for one sample: the first frame that is not the profiler's own.
 *
 * Two frames of context are kept, because an allocator alone is rarely enough to act on —
 * `PartitionRoot::Alloc` is every allocation in Chromium, and what makes it a finding is the
 * caller above it (`ArrayBufferAllocator::Allocate`, or `net::`, or `blink::ImageDecoder`).
 * That reasoning survives unsymbolized: the box's first reading showed four sites sharing one
 * top address and differing in the second, i.e. one allocator and four callers.
 *
 * @param {string[]|null|undefined} stack
 * @param {Resolver|null} [resolve]
 */
export function attributionOf(stack, resolve = null) {
  const frames = (stack ?? []).filter((f) => !PROFILER_FRAMES.test(f));
  if (!frames.length) return '(no attributable frame)';
  return frames.slice(0, 2).map((f) => renderFrame(f, resolve)).join(' <- ');
}

/**
 * Aggregate a raw sampling profile into allocation sites, largest first.
 *
 * PURE, so the interesting part is testable without a browser — the same split every decision
 * module here makes. `samples` is what CDP returns under `profile.samples`.
 *
 * @param {Array<{total?: number, stack?: string[]}>|null|undefined} samples
 * @param {number} [topN]
 * @param {Resolver|null} [resolve]
 * @returns {{totalBytes: number, sites: Array<{site: string, bytes: number}>,
 *            modules?: CdpModule[]|null}}
 */
export function summarise(samples, topN = TOP_N, resolve = null) {
  const by = new Map();
  let total = 0;
  for (const s of samples ?? []) {
    const bytes = Number(s?.total) || 0;
    total += bytes;
    const key = attributionOf(s?.stack, resolve);
    by.set(key, (by.get(key) ?? 0) + bytes);
  }
  const sites = [...by.entries()]
    .map(([site, bytes]) => ({ site, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, topN);
  return { totalBytes: total, sites };
}

/**
 * Read the accumulated profile.
 *
 * @returns {Promise<{totalBytes: number, sites: Array<{site: string, bytes: number}>,
 *   modules: CdpModule[]|null}|null>}
 *   `null` means we could not ask — never an empty result, which would read as "nothing was
 *   allocated". The distinction this codebase keeps having to re-learn. `modules` is null on
 *   the same principle: "the browser reported no module list" is not "the list was empty".
 */
export async function readNativeProfile(cdp) {
  if (!cdp) return null;
  try {
    const r = await within(
      cdp.send('Memory.getAllTimeSamplingProfile'), CDP_TIMEOUT_MS, 'getAllTimeSamplingProfile');
    const samples = r?.profile?.samples;
    if (!Array.isArray(samples)) return null;
    // The module list is the half this file used to discard, and on Windows it is the ONLY
    // thing standing between a reading and a column of bare addresses. Absent (an older
    // Chromium, or a target that does not report one) degrades to exactly the old behaviour.
    const modules = Array.isArray(r?.profile?.modules) ? r.profile.modules : null;
    return { ...summarise(samples, TOP_N, modules ? moduleResolver(modules) : null), modules };
  } catch {
    return null;
  }
}

/**
 * The difference between two readings, which is what attributes ONE navigation.
 *
 * The profile is all-time, so a bare reading after a ramp is dominated by whatever the browser
 * has done since launch. Diffing is what turns it into "this trip allocated X here" — the same
 * move as the memory sampler's `max_pid` pairing rule, and for the same reason: an absolute
 * number and a delta answer different questions and only one of them is about the event.
 *
 * A site present only in `after` is reported whole. A site that SHRANK is dropped rather than
 * reported negative: this is a sampler over an all-time total, so a decrease is noise, and a
 * negative row would invite reading it as memory being returned.
 */
export function diffProfiles(before, after) {
  if (!after) return null;
  const prior = new Map((before?.sites ?? []).map((s) => [s.site, s.bytes]));
  const sites = (after.sites ?? [])
    .map((s) => ({ site: s.site, bytes: s.bytes - (prior.get(s.site) ?? 0) }))
    .filter((s) => s.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  // Carried from AFTER, so `renderProfile` can name the exact binaries an offset belongs to
  // without the call site having to thread a second value through. `before`'s list describes
  // the same process and is redundant.
  return { totalBytes: after.totalBytes - (before?.totalBytes ?? 0), sites, modules: after.modules ?? null };
}

/** Bytes as MB, for a log line a human reads at 07:30. */
const mb = (b) => `${(b / 1048576).toFixed(0)} MB`;

/**
 * Render a diff for the log.
 *
 * IT STATES ITS OWN COVERAGE. The browser process cannot be sampled, so this figure describes
 * the renderer only — and on the one event where both were measured that was 1,237 MB of
 * 2,046. A number that silently accounts for two thirds of a ramp is how "the biggest process"
 * became a whole explanation once already, so the line says what it does not include.
 */
export function renderProfile(diff, ramMb) {
  if (!diff) return '  native allocation: unavailable (the browser did not answer)';
  if (!diff.sites.length) {
    return `  native allocation: nothing attributable in the renderer (${mb(diff.totalBytes)} total)`;
  }
  const head = `  native allocation, renderer only (browser process is NOT sampled — `
    + `Memory.startSampling is absent on that target): ${mb(diff.totalBytes)}`
    + (ramMb == null ? '' : ` while free RAM moved ${ramMb} MB`);
  const shown = diff.sites.slice(0, TOP_N);
  const rows = shown.map((s) => `    ${mb(s.bytes).padStart(9)}  ${s.site}`);
  return [head, ...rows, ...buildFooter(shown, diff.modules)].join('\n');
}

/**
 * The lines that make an unsymbolized reading actionable LATER.
 *
 * Only emitted when there is something unsymbolized to explain — this prints on every renewal
 * and a permanent two-line epilogue about symbol servers is how a log stops being read.
 *
 * A row that is still a BARE ADDRESS gets its own sentence, because it is the state this whole
 * change exists to leave behind: it means we had no module list, or the address was in none of
 * the modules the browser reported. Saying "unsymbolized" over that would hide the difference
 * between "named a binary and an offset" and "named nothing at all", which is the distinction
 * the reading turns on.
 */
function buildFooter(sites, modules) {
  const out = [];
  const named = new Set();
  let bare = false;
  for (const s of sites) {
    for (const m of String(s.site).matchAll(/([^\s<]+?)\+0x[0-9a-f]+/g)) named.add(m[1]);
    if (/(^|\s)0x[0-9a-f]+(\s|$)/.test(s.site)) bare = true;
  }
  if (named.size) {
    const uuidFor = (n) => (modules ?? [])
      .find((m) => moduleBasename(m?.name) === n && m?.uuid)?.uuid;
    const ids = [...named].map((n) => {
      const u = uuidFor(n);
      return u ? `${n} ${u}` : `${n} (no uuid reported)`;
    });
    out.push(`    <module>+<offset> is stable for a build — symbolize offline against: ${ids.join(', ')}`);
  }
  if (bare) {
    out.push('    rows still showing a bare address are in NO reported module — that is a '
      + 'reading, not a formatting fault: the module list was absent or did not cover them');
  }
  return out;
}
