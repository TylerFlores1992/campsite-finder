// THE INSTRUMENT THAT NAMES THE ALLOCATION MUST NOT INVENT ONE.
//
// Five instruments have narrowed this leak from outside — the memory series, the heap trail,
// the RAM trail, the process type, the network trace — and none has ever said WHAT allocates.
// "Network/IPC buffering" is written into three separate entries as the leading explanation
// and has never been tested. This one asks Chromium directly and gets a symbolized C++ stack.
//
// Verified against a real Chromium before it was written, not assumed:
//
//     640 MB of Uint8Array allocated in a page
//     -> JSHeapUsedSize reads 0.0 MB          <- why the heap trail could never see it
//     -> the sampler attributes 628 MB to
//        partition_alloc::PartitionRoot::Alloc<>() <- ArrayBufferAllocator::Allocate()
//
// That 0.0 MB is worth keeping in mind: "the JS heap is flat while the process is 25 GB"
// eliminates ordinary JS retention and eliminates NOTHING ELSE. It has been read here as
// though it ruled out the whole JavaScript-adjacent family.
//
// The failure modes this guards are the house ones: a reading that cannot be taken coming back
// as zero rather than null, and a partial measurement presented as a whole one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  attributionOf, summarise, diffProfiles, renderProfile, moduleResolver,
} from '../scripts/auto-cart-bot/rc-native-sampler.mjs';

const MB = 1048576;

// The mini-PC's real shape, from the 2026-08-22 19:34 PT reading: a 64-bit base under ASLR,
// and the frames that matter carrying no symbol at all.
const CHROME_DLL = { name: 'C:\\pw-browsers\\chromium\\chrome.dll', uuid: 'B3F1-DEADBEEF', baseAddress: '0x7ffc40000000', size: 0x10000000 };
const WS2 = { name: 'C:\\Windows\\System32\\ws2_32.dll', uuid: 'WS2-UUID', baseAddress: '0x7ffd00000000', size: 0x100000 };

// ── 1. Attribution ────────────────────────────────────────────────────────────────────────

test('the profiler\'s own frames are never the answer', () => {
  // The first local run printed six identical rows of `SamplingHeapProfiler::CaptureStackTrace`
  // — the capture function sits on top of EVERY stack it records, so grouping on the literal
  // top frame puts all memory under one meaningless label and reports nothing.
  const stack = [
    '0x1 base::SamplingHeapProfiler::CaptureStackTrace()',
    '0x2 base::SamplingHeapProfiler::CaptureNativeStack()',
    '0x3 base::PoissonAllocationSampler::DoRecordAllocation()',
    '0x4 partition_alloc::PartitionRoot::Alloc<>()',
    '0x5 namespace)::ArrayBufferAllocator::Allocate()',
  ];
  const a = attributionOf(stack);
  assert.ok(!/SamplingHeapProfiler|PoissonAllocationSampler/.test(a),
    `the profiler's own frames must be skipped, got: ${a}`);
  assert.match(a, /PartitionRoot::Alloc/, 'the real allocator must lead');
  assert.match(a, /ArrayBufferAllocator/,
    'and its CALLER must be carried — PartitionRoot::Alloc alone is every allocation in '
    + 'Chromium, and the frame above it is what makes a reading a finding');
});

test('addresses are stripped so the same site groups across runs', () => {
  // Addresses differ between runs and between processes; the symbol is the stable identity.
  // Without this, one allocation site becomes N rows of one sample each and the top-N is noise.
  const mk = (addr: string) => [`${addr} base::SamplingHeapProfiler::CaptureStackTrace()`, `${addr} net::HttpCache::Transaction::Read()`];
  assert.equal(attributionOf(mk('0xdead')), attributionOf(mk('0xbeef')));
});

test('a stack with nothing but profiler frames says so, rather than claiming a site', () => {
  const a = attributionOf(['0x1 base::SamplingHeapProfiler::CaptureStackTrace()']);
  assert.match(a, /no attributable frame/);
});

test('an empty or missing stack does not throw', () => {
  for (const s of [undefined, null, []]) {
    assert.equal(typeof attributionOf(s as string[] | undefined), 'string');
  }
});

// ── 1b. Windows: no symbols at all, so addresses must resolve to module+offset ─────────────
//
// The header's "1,083 of 1,733 frames carried a symbol" was measured in the Linux dev
// container. The first real reading off the box symbolized none of the interesting frames:
//
//     14 MB  0x7ffc499b1707 <- 0x7ffc4375aa42
//
// A ramp read that way names nothing, which is where this instrument started.

test('an unsymbolized frame resolves to module+offset', () => {
  const resolve = moduleResolver([CHROME_DLL]);
  const a = attributionOf(['0x7ffc499b1707', '0x7ffc4375aa42'], resolve);
  assert.equal(a, 'chrome.dll+0x99b1707 <- chrome.dll+0x375aa42',
    'the path must be dropped and the offset taken from the module base');
});

test('the offset is what makes two runs group — the raw address never could', () => {
  // Module bases move per process under ASLR. Without the subtraction the same allocation site
  // is a different row in every reading, so the top-N is noise and the diff attributes nothing.
  const runA = moduleResolver([{ ...CHROME_DLL, baseAddress: '0x7ffc40000000' }]);
  const runB = moduleResolver([{ ...CHROME_DLL, baseAddress: '0x1a2b00000000' }]);
  // Both are base + 0x99b1707, i.e. the same site loaded at two different bases.
  const a = attributionOf(['0x7ffc499b1707'], runA);
  const b = attributionOf(['0x1a2b099b1707'], runB);
  assert.equal(a, b, 'the same site in two processes must produce the same label');
  assert.match(a, /^chrome\.dll\+0x99b1707$/,
    'and it must be the offset that matches, not both falling back to a bare address');
});

test('a SYSTEM dll is named, which is the one thing the module name buys for free', () => {
  // Almost all of Chromium is one chrome.dll, so the name rarely discriminates. A frame in the
  // OS network stack would — that is the buffering candidate, three times asserted, never shown.
  const resolve = moduleResolver([CHROME_DLL, WS2]);
  assert.match(attributionOf(['0x7ffd00001234'], resolve), /^ws2_32\.dll\+0x1234$/);
});

test('a real symbol still wins over the address', () => {
  // Symbols are identical across builds, offsets only within one. When the build has a symbol
  // it is the better identity and resolution must not override it.
  const resolve = moduleResolver([CHROME_DLL]);
  assert.equal(attributionOf(['0x7ffc499b1707 net::HttpCache::Read()'], resolve),
    'net::HttpCache::Read()');
});

test('an address in NO reported module stays a bare address', () => {
  // JIT code and anything the browser did not report. "In no module" and "we had no module
  // list" must both survive as visibly unresolved rather than being attributed to a neighbour.
  const resolve = moduleResolver([CHROME_DLL]);
  assert.equal(attributionOf(['0xdeadbeef00'], resolve), '0xdeadbeef00');
});

test('module bases above 2^53 are not rounded', () => {
  // A Number cannot hold a 64-bit address exactly, and rounding an address does not throw — it
  // yields a plausible, wrong offset. That is the silent-corruption shape, so BigInt.
  const resolve = moduleResolver([{ name: 'high.dll', uuid: 'U', baseAddress: '0xfffffffff0000000', size: 0x10000 }]);
  assert.equal(attributionOf(['0xfffffffff0000abc'], resolve), 'high.dll+0xabc');
});

test('a garbled module list degrades to the old behaviour, and never throws', () => {
  // This crosses CDP from a browser that is by assumption misbehaving.
  const resolve = moduleResolver([
    null, {}, { name: 'x', baseAddress: 'not-an-address', size: 10 },
    { name: 'y', baseAddress: '0x10', size: 0 },
  ] as never[]);
  assert.equal(attributionOf(['0x7ffc499b1707'], resolve), '0x7ffc499b1707');
});

test('a decimal baseAddress is accepted — the protocol permits either', () => {
  // "Encoded as a decimal or hexadecimal (0x prefixed) string", per the CDP Module type.
  const resolve = moduleResolver([{ name: 'd.dll', uuid: 'U', baseAddress: String(0x7ffc40000000), size: 0x1000 }]);
  assert.equal(attributionOf(['0x7ffc40000abc'], resolve), 'd.dll+0xabc');
});

test('with no module list at all, nothing changes from before', () => {
  // The degradation path: an older Chromium, or a target that reports no modules. It must be
  // exactly the previous behaviour, not an error and not an empty label.
  assert.equal(attributionOf(['0x7ffc499b1707'], null), '0x7ffc499b1707');
  assert.equal(attributionOf(['0x1 net::Foo()'], null), 'net::Foo()');
});

// ── 2. Aggregation ────────────────────────────────────────────────────────────────────────

test('samples sharing a site are summed, and the largest leads', () => {
  const net = ['0x1 base::PoissonAllocationSampler::DoRecordAllocation()', '0x2 net::Foo()', '0x3 net::Bar()'];
  const arr = ['0x1 base::PoissonAllocationSampler::DoRecordAllocation()', '0x2 blink::Baz()'];
  const r = summarise([
    { total: 10 * MB, stack: net },
    { total: 30 * MB, stack: net },
    { total: 25 * MB, stack: arr },
  ]);
  assert.equal(r.totalBytes, 65 * MB);
  assert.equal(r.sites.length, 2);
  assert.match(r.sites[0].site, /net::Foo/, 'the biggest site must lead');
  assert.equal(r.sites[0].bytes, 40 * MB, 'and its samples must be summed');
});

test('a malformed sample cannot poison the total', () => {
  // This crosses CDP from a browser that is by assumption misbehaving.
  const r = summarise([
    { total: 'lots' as unknown as number, stack: ['0x1 a::b()'] },
    { total: 5 * MB, stack: ['0x1 a::b()'] },
    null as unknown as { total: number },
  ]);
  assert.equal(r.totalBytes, 5 * MB, 'non-numeric totals count as zero, never NaN');
});

// ── 3. The diff — this is what attributes ONE navigation ──────────────────────────────────

test('the diff attributes the trip, not the browser\'s whole life', () => {
  // The profile is all-time, so a bare reading after a ramp is dominated by everything since
  // launch. Same reasoning as the memory sampler's max_pid pairing rule: an absolute number
  // and a delta answer different questions, and only one of them is about the event.
  const before = summarise([{ total: 100 * MB, stack: ['0x1 x::y()'] }]);
  const after = summarise([{ total: 900 * MB, stack: ['0x1 x::y()'] }]);
  const d = diffProfiles(before, after)!;
  assert.equal(d.totalBytes, 800 * MB);
  assert.equal(d.sites[0].bytes, 800 * MB);
});

test('a site that appears only after the trip is reported whole', () => {
  const before = summarise([{ total: 10 * MB, stack: ['0x1 old::site()'] }]);
  const after = summarise([
    { total: 10 * MB, stack: ['0x1 old::site()'] },
    { total: 500 * MB, stack: ['0x1 net::New()'] },
  ]);
  const d = diffProfiles(before, after)!;
  assert.equal(d.sites.length, 1, 'the unchanged site contributes nothing and is dropped');
  assert.match(d.sites[0].site, /net::New/);
  assert.equal(d.sites[0].bytes, 500 * MB);
});

test('a shrinking site is dropped, never reported negative', () => {
  // This is a sampler over an all-time total, so a decrease is noise — and a negative row
  // invites reading it as memory being handed back, which it is not evidence of.
  const before = summarise([{ total: 500 * MB, stack: ['0x1 a::b()'] }]);
  const after = summarise([{ total: 200 * MB, stack: ['0x1 a::b()'] }]);
  const d = diffProfiles(before, after)!;
  assert.equal(d.sites.length, 0);
});

test('a missing AFTER reading is null, never an empty result', () => {
  // "We could not ask" and "nothing was allocated" are different facts. The distinction this
  // codebase keeps having to re-learn — `status = 'sent'`, `claimBotCommands` returning [],
  // the memory sampler recording a zero it had not measured.
  assert.equal(diffProfiles(summarise([]), null), null);
});

test('a missing BEFORE reading still yields a usable diff', () => {
  // A before-read that failed must not throw away the after-read: the whole reading is still
  // worth having, it is simply an upper bound.
  const after = summarise([{ total: 42 * MB, stack: ['0x1 a::b()'] }]);
  const d = diffProfiles(null, after)!;
  assert.equal(d.totalBytes, 42 * MB);
});

// ── 4. The rendered line states its own coverage ──────────────────────────────────────────

test('the line says the browser process is NOT included', () => {
  // On the one event where both were measured, the renderer held 1,237 MB of 2,046. A figure
  // that silently accounts for two thirds of a ramp is how "the biggest process" became a
  // whole explanation once already, and `Memory.startSampling` is genuinely absent on the
  // browser target — verified, not assumed.
  const d = diffProfiles(null, summarise([{ total: 900 * MB, stack: ['0x1 net::Foo()'] }]))!;
  const line = renderProfile(d, -900);
  assert.match(line, /renderer only/i);
  assert.match(line, /browser process is NOT sampled/i);
  assert.match(line, /net::Foo/, 'and it must actually name the site');
});

test('an unavailable reading says so instead of printing a zero', () => {
  const line = renderProfile(null, null);
  assert.match(line, /unavailable/);
  assert.ok(!/0 MB/.test(line), 'an absent reading must not render as "0 MB allocated"');
});

test('an empty diff is distinguishable from an unavailable one', () => {
  // "The browser answered and nothing was attributable" and "the browser did not answer" are
  // different readings and must not print the same sentence.
  const empty = renderProfile({ totalBytes: 0, sites: [] }, null);
  assert.ok(!/unavailable/.test(empty));
  assert.match(empty, /nothing attributable/);
});

// ── 4b. The footer that makes an unsymbolized reading actionable later ────────────────────

test('an unsymbolized reading names the binary to symbolize against', () => {
  // Without this the offset is stable and unresolvable — a better dead end is still a dead end.
  const d = diffProfiles(null, summarise([{ total: 900 * MB, stack: ['0x7ffc499b1707'] }], 6,
    moduleResolver([CHROME_DLL])))!;
  const line = renderProfile({ ...d, modules: [CHROME_DLL] }, -900);
  assert.match(line, /chrome\.dll\+0x99b1707/, 'the row must carry the offset');
  assert.match(line, /B3F1-DEADBEEF/, 'and the footer the uuid of the exact build');
});

test('a fully symbolized reading gets NO footer', () => {
  // This prints on every renewal. A permanent epilogue about symbol servers is how a log stops
  // being read, which costs more than the footer buys.
  const d = diffProfiles(null, summarise([{ total: 900 * MB, stack: ['0x1 net::Foo()'] }]))!;
  const line = renderProfile(d, -900);
  assert.ok(!/symbolize offline/.test(line), `an all-symbol reading needs no epilogue:\n${line}`);
});

test('a bare-address row is called out as naming nothing, not as merely unsymbolized', () => {
  // "Named a binary and an offset" and "named nothing at all" are the two outcomes this change
  // exists to separate. One sentence covering both would hide whether it worked.
  const d = diffProfiles(null, summarise([{ total: 900 * MB, stack: ['0xdeadbeef00'] }]))!;
  const line = renderProfile(d, -900);
  assert.match(line, /NO reported module/);
  assert.ok(!/symbolize offline/.test(line), 'there is no module to symbolize against');
});

// ── 5. The wiring ─────────────────────────────────────────────────────────────────────────

test('readNativeProfile resolves with the modules CDP returns beside the samples', async () => {
  // The half this file discarded. Pinned through the real entry point rather than through
  // `moduleResolver` alone: the pure function can be perfect while nothing passes it a list,
  // which is the inert-fix shape this repo has paid for three times.
  const { readNativeProfile } = await import('../scripts/auto-cart-bot/rc-native-sampler.mjs');
  const cdp = {
    send: async () => ({
      profile: {
        samples: [{ total: 900 * MB, stack: ['0x7ffc499b1707', '0x7ffc4375aa42'] }],
        modules: [CHROME_DLL],
      },
    }),
  };
  const r = (await readNativeProfile(cdp))!;
  assert.match(r.sites[0].site, /chrome\.dll\+0x99b1707 <- chrome\.dll\+0x375aa42/,
    'the resolver must actually reach the aggregation');
  assert.deepEqual(r.modules, [CHROME_DLL], 'and the list must survive for the footer');
});

test('a profile with no modules field still reads, unresolved', async () => {
  const { readNativeProfile } = await import('../scripts/auto-cart-bot/rc-native-sampler.mjs');
  const cdp = { send: async () => ({ profile: { samples: [{ total: 5 * MB, stack: ['0x7ffc499b1707'] }] } }) };
  const r = (await readNativeProfile(cdp))!;
  assert.equal(r.sites[0].site, '0x7ffc499b1707');
  assert.equal(r.modules, null, 'null, so the footer can tell "absent" from "empty"');
});

const KW = readFileSync('scripts/auto-cart-bot/rc-keepwarm.mjs', 'utf8');
const code = KW.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('sampling starts on the TAB, before the trip', () => {
  // `Memory.startSampling` is per-renderer and the trip runs in the throwaway tab, not on the
  // resident page. Starting it on the wrong page profiles a renderer where nothing happens.
  const start = code.indexOf('startNativeSampling(sampler)');
  const trip = code.indexOf('withNetworkTrace(tab,');
  assert.ok(start > -1, 'sampling must be started');
  assert.ok(trip > start, 'and started BEFORE the Okta trip, not after it');
  const attach = code.indexOf('ctx.newCDPSession(tab)');
  assert.ok(attach > -1 && attach < start, 'the CDP session must be bound to the tab');
});

test('a BEFORE reading is taken and diffed', () => {
  // Whether a new tab gets its own renderer or shares the resident page's is NOT established.
  // If it shares one, an all-time profile carries hours of the resident page's history and
  // would report it as this trip's. Diffing is correct either way.
  const before = code.indexOf('profBefore');
  const trip = code.indexOf('withNetworkTrace(tab,');
  assert.ok(before > -1 && before < trip, 'the before-reading must precede the trip');
  assert.match(code, /diffProfiles\(profBefore, profAfter\)/,
    'the two readings must be diffed, or the line reports the browser\'s whole life');
});

test('the reading is printed pass or fail', () => {
  // The failing renewals are the ones that ramp — all five guard firings were mid-renewal — so
  // a reading logged only on success would miss every event it was built for. Same rule the
  // network trace above it already follows.
  //
  // PIN THE CONDITION, NOT A LIST OF SHAPES IT MIGHT TAKE. The first version scanned the 400
  // characters before the call for a handful of guessed patterns, and PASSED against
  // `if (sampling.ok && r?.renewed === true)` — the exact regression it exists for, because
  // that shape was not one of the ones guessed (verified). Twenty-first time a guard here has
  // anchored on the wrong thing. The honest assertion is that the render is gated on whether
  // we SAMPLED and on nothing else.
  const at = code.indexOf('renderProfile(');
  assert.ok(at > -1, 'the profile must be rendered');
  const ifAt = code.lastIndexOf('if (', at);
  assert.ok(ifAt > -1 && ifAt < at, 'the render must sit inside a conditional we can read');
  const cond = code.slice(ifAt + 4, code.indexOf(') {', ifAt));
  assert.equal(cond.trim(), 'sampling.ok',
    'the profile line may be gated ONLY on whether sampling started — gating it on the '
    + 'renewal succeeding would miss every event it was built for, since the renewals that '
    + `ramp are the failing ones. Found: ${cond}`);
});

test('a browser that will not sample says so, and does not stop the renewal', () => {
  // The whole feature is diagnostic. A browser that refuses to start sampling must not take
  // the keep-warm down with it.
  assert.match(code, /native allocation: not sampled/,
    'a failure to start sampling must be reported, not silent');
  const src = readFileSync('scripts/auto-cart-bot/rc-native-sampler.mjs', 'utf8');
  assert.match(src, /export async function startNativeSampling/);
  assert.ok(!/throw /.test(src.slice(src.indexOf('export async function startNativeSampling'))),
    'nothing in the sampler may throw into the renewal path');
});
