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
 * **Symbolization is partial.** 1,083 of 1,733 frames carried a symbol in the local check.
 * Unsymbolized frames are raw addresses and are kept — a module+offset still groups.
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
 * The allocator frame for one sample: the first frame that is not the profiler's own.
 *
 * Two frames of context are kept, because an allocator alone is rarely enough to act on —
 * `PartitionRoot::Alloc` is every allocation in Chromium, and what makes it a finding is the
 * caller above it (`ArrayBufferAllocator::Allocate`, or `net::`, or `blink::ImageDecoder`).
 */
export function attributionOf(stack) {
  const frames = (stack ?? []).filter((f) => !PROFILER_FRAMES.test(f));
  if (!frames.length) return '(no attributable frame)';
  // Addresses differ between runs and between processes; the symbol is the stable identity.
  const clean = (f) => f.replace(/^0x[0-9a-f]+\s*/, '').trim() || f;
  return frames.slice(0, 2).map(clean).join(' <- ');
}

/**
 * Aggregate a raw sampling profile into allocation sites, largest first.
 *
 * PURE, so the interesting part is testable without a browser — the same split every decision
 * module here makes. `samples` is what CDP returns under `profile.samples`.
 */
export function summarise(samples, topN = TOP_N) {
  const by = new Map();
  let total = 0;
  for (const s of samples ?? []) {
    const bytes = Number(s?.total) || 0;
    total += bytes;
    const key = attributionOf(s?.stack);
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
 * @returns {Promise<{totalBytes: number, sites: Array<{site: string, bytes: number}>}|null>}
 *   `null` means we could not ask — never an empty result, which would read as "nothing was
 *   allocated". The distinction this codebase keeps having to re-learn.
 */
export async function readNativeProfile(cdp) {
  if (!cdp) return null;
  try {
    const r = await within(
      cdp.send('Memory.getAllTimeSamplingProfile'), CDP_TIMEOUT_MS, 'getAllTimeSamplingProfile');
    const samples = r?.profile?.samples;
    if (!Array.isArray(samples)) return null;
    return summarise(samples);
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
  return { totalBytes: after.totalBytes - (before?.totalBytes ?? 0), sites };
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
  const rows = diff.sites.slice(0, TOP_N)
    .map((s) => `    ${mb(s.bytes).padStart(9)}  ${s.site}`);
  return [head, ...rows].join('\n');
}
