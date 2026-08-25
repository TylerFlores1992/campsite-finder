/**
 * THE ALLOCATION TRAIL — sample the allocation profile WHILE the ramp is happening, because
 * the existing reading has now missed six of them and the reason is WHEN it is taken.
 *
 * ## Why the return-path reading cannot see a ramp
 *
 * Established 2026-08-25 and written up in CLAUDE.md. `reportNativeAlloc` fires on the RETURN
 * path — after `attemptLogin`/`renewSession` returns — and is gated at `ramΔ ≤ −400 MB`. A trip
 * killed mid-ramp never returns, so it never reports, and the instrument therefore records **by
 * selection** the cheap retry that FOLLOWS a ramp. Three ramps arrived unprompted in thirty
 * hours; Track A has three stored readings, one per ramp hour, and every one says "this
 * navigation did NOT ramp" and sits outside its ramp window.
 *
 * ## And the leading candidate for the rest: WE MAY BE SAMPLING THE WRONG RENDERER
 *
 * On 2026-08-25 02:31 the renewal's throwaway tab reported **17 MB** while the family's
 * renderers reached **8,052 MB**, and the climb continued for eight minutes after the reading
 * was stored. Every existing `startNativeSampling` call site is on the TRIP's own tab; the
 * RESIDENT RC page — the one the keep-warm holds open for the life of the browser — has never
 * been sampled by anything.
 *
 * **That is a CANDIDATE, not a finding, and it is what this trail settles.** If the gigabytes
 * are on the resident page's renderer, then PR #142's cure — move the Okta trip into a
 * throwaway tab so the renderer dies at close — is aimed at the wrong renderer, which would
 * explain why ramps continued after it shipped. `createAllocTrail` samples both and reports
 * them under separate contexts, so a reading says which.
 *
 * ## A NEGATIVE WORTH KEEPING: the profile reset is NOT the explanation for RC
 *
 * The obvious first hypothesis for 17 MB against 8,052 MB is that CDP's all-time profile is
 * reset by the navigation. It IS — and not by RC's. Measured locally against a real Chromium,
 * because the alternative was another inference:
 *
 *     a.test          -> b.test               298 MB ->   1 MB   RENDERER SWAPPED
 *     www.rc.test     -> signin.rc.test       284 MB -> 284 MB   same renderer
 *     www.rc.test     -> signin.rc.test *     332 MB -> 333 MB   same renderer
 *                                          (* with a resident page held open, as in production)
 *
 * Chromium isolates by SITE — scheme + eTLD+1 — and not by origin. RC's trip is
 * `www.reservecalifornia.com` -> `signin.reservecalifornia.com`, a SUBDOMAIN hop, which keeps
 * its renderer and its profile. So the reset is real, is easy to reproduce with two genuinely
 * different sites, and **does not apply to the navigation this project cares about.**
 *
 * This is recorded rather than deleted because it was written into this file as fact for
 * several hours, on the strength of an experiment that used `a.test`/`b.test`, and only
 * `alloc-trail-probe.mjs` refusing a verdict caught it. The next person to reach for it will
 * reach for the same experiment.
 *
 * ## What this is
 *
 * The same move the heap trail and the RAM trail already make, one slot over: sample on the
 * watchdog tick — the only code proven to keep executing while the loop is stalled — keep a
 * window of readings, and report the peak. Four things it has to get right, each of which is a
 * way this quietly buys nothing:
 *
 *   * **IT SAMPLES THE RESIDENT RENDERER AS WELL AS THE TRIP'S.** See above; that is the open
 *     question, and an instrument on only the tab cannot answer it.
 *   * **IT IS SIZED FOR THE EVENT, NOT COPIED FROM `TRAIL_KEEP`.** The heap trail keeps 12
 *     samples, which at a 10s tick is TWO MINUTES; these ramps run TEN. That is how the heap
 *     trail came to print twelve byte-identical samples whose newest was already 123s stale.
 *     This window is bounded by TIME.
 *   * **IT REPORTS ON A TRIGGER THAT FIRES.** Not the RAM arm — six consecutive ramps, closest
 *     approach 144 MB, never fired. Not the post-Okta recycle, which since the throwaway-tab
 *     change fires only for the rehearsal. A segment ENDING is the trigger, plus a flush at
 *     teardown and in the runaway bail, which are the two ways a ramp ends without one.
 *   * **IT SEGMENTS ON A COLLAPSE, NOT ON ANY DECREASE.** See `splitSegments`: the all-time
 *     total is very nearly monotonic and not quite, and a strict comparison cut a real
 *     1,271 MB ramp in half.
 *
 * ## Known limit, stated rather than discovered later
 *
 * `Memory.startSampling` is absent on the BROWSER-process target — verified, and recorded in
 * `rc-native-sampler.mjs`. So everything here covers renderers only. On the one event where
 * both were measured the renderer was 1,237 MB of 2,046, and on 2026-08-24 it was 8,406 of
 * 9,338. Most of a ramp, and not all of it. Every line this renders says so.
 */

import { readNativeProfile, diffProfiles } from './rc-native-sampler.mjs';

/**
 * How far back the trail reaches. The ramps run about ten minutes (2026-08-23: 11 minutes at
 * ~400 MB/min; 08-24: eleven at ~840), so twenty gives a baseline BEFORE the onset as well as
 * the whole climb. Bounded by time and not by count deliberately — see the header.
 */
export const ALLOC_WINDOW_MS = Number(process.env.RC_ALLOC_WINDOW_MS || 20 * 60_000);

/**
 * The sub-cadence. The watchdog ticks every 10s; this need not. `getAllTimeSamplingProfile`
 * grows with the number of DISTINCT STACKS, and a renderer that has been running an SPA for
 * an hour accumulates plenty — so asking half as often halves a cost that buys nothing at 20s
 * resolution against a ten-minute event. Thirty samples across a ramp is ample.
 */
export const ALLOC_SAMPLE_MS = Number(process.env.RC_ALLOC_SAMPLE_MS || 20_000);

/**
 * How much growth in one segment counts as a ramp worth storing.
 *
 * Matched to `NATIVE_ALLOC_RAMP_MB` (400) on purpose: the same bar the return-path report
 * already uses, so the two instruments agree about what a ramp is and a reader comparing them
 * is not comparing two different definitions. An ordinary Okta trip costs 40-350 MB — measured
 * again on the box at 15:45 and 15:57 on 2026-08-25, at 47 MB and 39 MB — so this is well
 * clear of the noise floor without being tuned to any one event.
 */
export const ALLOC_RAMP_BYTES = Number(process.env.RC_ALLOC_RAMP_MB || 400) * 1048576;

/** Bytes as MB, for a log line a human reads at 07:30. */
const mb = (b) => `${(b / 1048576).toFixed(0)} MB`;

/**
 * A COLLAPSE, not merely a decrease, starts a new segment.
 *
 * A renderer swap resets the all-time profile to almost nothing — measured at 274 MB -> 1 MB
 * and 298 MB -> 1 MB, i.e. under half a percent of what it held. So a swap is unmistakable and
 * a ratio is the right test.
 *
 * A STRICT `<` WAS THE FIRST VERSION AND IT WAS WRONG, on the reasoning that an all-time total
 * is monotonic by construction. It is not, quite: `alloc-trail-probe.mjs` recorded a real
 * sequence stepping 955.4 -> 955.2 MB between two consecutive reads. Fractions of a megabyte,
 * invisible in a rounded log line — and enough to cut a 1,271 MB ramp into segments of 954 and
 * 319 and report the larger half as the event. A guard that halves the number it exists to
 * report is worse than no guard, and it was found by running the thing rather than by review.
 */
const SWAP_RATIO = 0.5;

/**
 * Split a target's samples into per-renderer segments.
 *
 * PURE, so the part that decides what a ramp is can be tested without a browser — the same
 * split every decision module here makes, and the reason `claim.ts` is not inside `poller.ts`.
 *
 * WHEN A SWAP ACTUALLY HAPPENS HERE, since the answer is narrower than it first looks.
 * Chromium isolates by SITE (scheme + eTLD+1), NOT by origin, so RC's own
 * `www.reservecalifornia.com` -> `signin.reservecalifornia.com` navigation is same-site and
 * keeps its renderer — measured, and it is why this file no longer claims the Okta trip resets
 * the profile. What DOES produce a new renderer here is a browser recycle between one
 * registration and the next, and a genuinely cross-site hop if Okta ever makes one. Segmenting
 * is what stops those being read as a ramp of negative size.
 *
 * THE ONE WAY THIS UNDER-SEGMENTS, said rather than left to be found: if a swap happens and the
 * new renderer allocates past half the old total before the next sample, the boundary is missed
 * and two segments merge. At a 20s cadence and the observed ~840 MB/min that needs a prior
 * total under ~560 MB. The failure direction is a merged segment reporting MORE growth, never
 * a ramp lost — the safe way round, since this instrument's whole purpose is not missing one.
 *
 * @param {Array<{at:number, freeMb:number, profile:{totalBytes:number, sites:Array}}>} samples
 * @returns {Array<Array<object>>} segments, oldest first, each with its samples in order
 */
export function splitSegments(samples) {
  const out = [];
  let cur = [];
  for (const s of samples ?? []) {
    const prev = cur[cur.length - 1];
    if (prev && s.profile.totalBytes < prev.profile.totalBytes * SWAP_RATIO) {
      out.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * What one segment says: how much that renderer grew, what the machine's free RAM did over
 * the same window, and where the bytes went.
 *
 * THE RAM PAIR COMES FROM THE SAME SAMPLES, which is what keeps the three-way verdict honest.
 * `reportNativeAlloc` refuses a reading with no delta, and on 2026-08-19 a trace of a
 * navigation that never ramped was one sentence away from being written up as retiring the
 * buffering candidate. A delta measured over a DIFFERENT window than the profile would be
 * that mistake with extra steps.
 *
 * `freeMb` FALLS when the machine loses memory, so the delta is negative during a ramp —
 * matching what `withNetworkTrace` produces and what `reportNativeAlloc` tests for. Written as
 * `last - first` rather than an abs() for the reason recorded there: a trip that FREED a
 * gigabyte is not a ramp and must not be stored as one.
 *
 * @returns {{startAt:number, endAt:number, growthBytes:number, ramDeltaMb:number,
 *            sites:Array<{site:string, bytes:number}>}|null}
 */
export function rampOf(segment) {
  if (!segment || segment.length < 2) return null;
  const first = segment[0];
  const last = segment[segment.length - 1];
  const diff = diffProfiles(first.profile, last.profile);
  return {
    startAt: first.at,
    endAt: last.at,
    growthBytes: last.profile.totalBytes - first.profile.totalBytes,
    ramDeltaMb: Math.round(last.freeMb - first.freeMb),
    sites: diff?.sites ?? [],
  };
}

/**
 * Render a target's trail for the log.
 *
 * Printed by the RUNAWAY arm beside the heap and RAM trails. IT STATES ITS OWN COVERAGE for
 * the reason `renderProfile` does: the browser process is not sampled, and a number that
 * silently accounts for two thirds of a ramp is how "the biggest process" became a whole
 * explanation once already.
 *
 * AN EMPTY TRAIL IS ITS OWN READING and says so. "The browser answered no CDP call at all"
 * and "the renderer allocated nothing" are different facts, and a blank line merges them —
 * the mistake `describeTrail` had to be written carefully to avoid.
 */
export function describeAllocTrail(byTarget, now) {
  const names = [...(byTarget?.keys?.() ?? [])];
  if (!names.length) return 'alloc trail: EMPTY — no renderer was registered for sampling';
  const lines = [];
  for (const name of names) {
    const samples = byTarget.get(name) ?? [];
    if (!samples.length) {
      lines.push(`alloc trail [${name}]: EMPTY — that renderer answered no CDP call at all`);
      continue;
    }
    const segs = splitSegments(samples);
    const parts = segs.map((seg) => {
      const r = rampOf(seg);
      const age = Math.round((now - seg[seg.length - 1].at) / 1000);
      if (!r) return `${age}s ago ${mb(seg[0].profile.totalBytes)} (one sample only)`;
      return `${age}s ago ${mb(r.growthBytes)} over ${Math.round((r.endAt - r.startAt) / 1000)}s`
        + ` (RAM ${r.ramDeltaMb > 0 ? '+' : ''}${r.ramDeltaMb} MB)`;
    });
    // Newest first, matching the heap and RAM trails so three lines printed together read the
    // same way round. A reader comparing them at 03:00 should not have to check each one.
    lines.push(`alloc trail [${name}], renderer only, newest first: ${parts.reverse().join(' · ')}`);
  }
  lines.push('  (renderers only — Memory.startSampling is absent on the browser-process target)');
  return lines.join('\n  ');
}

/**
 * The stateful edge: registered targets, their sample buffers, and which ramps have been
 * reported.
 *
 * `read` IS INJECTED so the decisions above can be exercised against a scripted browser. The
 * alternative is a test asserting against a COPY of this logic, which is the `rc-holds-readout`
 * lesson: the defect is in the real thing or it is nowhere.
 */
export function createAllocTrail({ read = readNativeProfile, windowMs = ALLOC_WINDOW_MS,
  sampleMs = ALLOC_SAMPLE_MS, rampBytes = ALLOC_RAMP_BYTES } = {}) {
  /** @type {Map<string, {cdp: object|null, samples: Array, inFlight: boolean, lastAt: number}>} */
  const targets = new Map();
  /**
   * Segments already reported, per target, keyed on the segment's LAST sample time.
   *
   * NOT AN INDEX, because the window prunes from the front and segment indexes shift as it
   * does — a counter would re-report a ramp every time an old sample aged out.
   *
   * AND NOT THE SEGMENT'S START EITHER, which was the first version and was wrong for exactly
   * the same reason one layer in: pruning removes the segment's own first sample, so its start
   * MOVES, the key changes, and the ramp is reported a second time under a new one. The END of
   * an ended segment is fixed — nothing more is ever appended to it — which is the property a
   * key needs. An OPEN segment's end does advance, and that is safe because an open segment is
   * only ever taken with `final: true`, which happens at teardown and in the bail: after both,
   * this target takes no further samples.
   */
  const reported = new Map();

  const bufOf = (name) => targets.get(name)?.samples ?? [];

  return {
    /**
     * Register a renderer to sample. Idempotent on the name: a trip that re-registers after a
     * retry must not accumulate two entries for one tab, or the tick reads it twice and the
     * in-flight flag protects neither.
     */
    register(name, cdp) {
      if (!name || !cdp) return;
      // `-Infinity` AND NOT 0 for "never sampled". Zero only reads as "long ago" because
      // `Date.now()` is huge, and this module takes its clock from the caller — the idiom that
      // works in `rc-keepwarm.mjs` silently skips the first reading under an injected clock,
      // which is a whole ramp's baseline lost to an epoch assumption.
      targets.set(name, { cdp, samples: bufOf(name), inFlight: false, lastAt: -Infinity });
    },

    /**
     * Stop sampling a target. THE BUFFER IS KEPT until the caller has taken its ramp — a tab
     * that closes at the end of a trip is exactly the case whose peak we want, and dropping
     * the samples here would discard the reading at the moment it becomes final.
     */
    unregister(name) {
      const t = targets.get(name);
      if (t) t.cdp = null;
    },

    /** Registered names, for the caller and for tests. */
    names: () => [...targets.keys()],
    samplesOf: (name) => bufOf(name).slice(),

    /**
     * Take one reading per target, if it is due.
     *
     * FIRE AND FORGET WITH A PER-TARGET IN-FLIGHT FLAG. The watchdog timer must never await —
     * that is its whole value, being the one thing still executing while the loop is stalled —
     * and once the browser goes quiet every attempt costs its full CDP timeout, so without the
     * flag they pile up one per tick. Per-target rather than global, or one slow renderer
     * would starve the other of readings for the length of the event.
     *
     * NOT AWAITED BY THE CALLER, and it returns nothing for that reason.
     */
    sample(now, freeMb) {
      for (const [name, t] of targets) {
        if (!t.cdp || t.inFlight || now - t.lastAt < sampleMs) continue;
        t.inFlight = true;
        t.lastAt = now;
        void Promise.resolve(read(t.cdp))
          .then((profile) => {
            // NULL IS NOT ZERO. `readNativeProfile` returns null for "we could not ask", and
            // storing a zero there would look to `splitSegments` exactly like a renderer swap
            // — cutting a real segment in half and halving the growth it reports. The rule
            // this codebase keeps having to re-learn, and here it corrupts rather than blanks.
            if (!profile || typeof profile.totalBytes !== 'number') return;
            // STAMPED WITH THE TICK'S OWN CLOCK, not the clock at completion. The reading and
            // the free-RAM figure beside it must describe one instant, or the RAM delta the
            // report is gated on is measured over a different window than the profile — which
            // is the 2026-08-19 false elimination in miniature.
            t.samples.push({ at: now, freeMb, profile });
            const cutoff = now - windowMs;
            while (t.samples.length && t.samples[0].at < cutoff) t.samples.shift();
          })
          .catch(() => {})
          .finally(() => { t.inFlight = false; });
      }
    },

    /**
     * Ramps not yet reported.
     *
     * ON AN ORDINARY TICK this returns only segments that have ENDED — a later segment exists,
     * so a renderer swap has happened and the peak is final. That is the trigger, and it is
     * the moment the number would otherwise be discarded.
     *
     * WITH `final: true` the OPEN segment is included too. Used at teardown and in the runaway
     * bail, which are the two ways a ramp ends without our ever seeing the swap: the browser is
     * replaced by a recycle (the loop breaks and this whole trail goes with it) or the process
     * exits. Without it a nine-gigabyte ramp that kills the box reports nothing, which is the
     * failure this file exists to end.
     */
    takeRamps({ final = false } = {}) {
      const out = [];
      for (const [name, t] of targets) {
        const segs = splitSegments(t.samples);
        const done = reported.get(name) ?? new Set();
        segs.forEach((seg, i) => {
          const isOpen = i === segs.length - 1 && t.cdp !== null;
          if (isOpen && !final) return;
          const r = rampOf(seg);
          if (!r || r.growthBytes < rampBytes) return;
          if (done.has(r.endAt)) return;
          done.add(r.endAt);
          out.push({ name, ...r });
        });
        reported.set(name, done);
      }
      return out;
    },

    /** For the log line. Exposed as a Map so `describeAllocTrail` stays pure. */
    buffers() {
      return new Map([...targets].map(([name, t]) => [name, t.samples]));
    },
  };
}
