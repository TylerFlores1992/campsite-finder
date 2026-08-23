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

/**
 * EVERY ANCHOR BELOW OCCURS TWICE, SO EVERY TEST IS SCOPED TO ONE CALL SITE.
 *
 * There are two now — the renewal's tab and the auto-login's — and `maybeAutoLogin` comes
 * FIRST in the file. `startNativeSampling(sampler)`, `ctx.newCDPSession(tab)`, `profBefore`
 * and `renderProfile(` are each present in both, so a bare `indexOf` reads the auto-login's
 * copy while claiming to test the renewal's, and the renewal guards pass against a renewal
 * that no longer samples anything.
 *
 * That is the twenty-first instance of a guard anchoring on a token that occurs twice — and
 * this time the second occurrence was added BY the change these guards exist to protect,
 * which is precisely how the shape keeps recurring. Verified: without the scoping, all three
 * renewal tests pass with the renewal's sampling deleted.
 */
function scope(label: string, from: string, to: string | null): string {
  const a = code.indexOf(from);
  assert.ok(a > -1, `${label}: start anchor not found (${from}) — re-anchor, do not delete`);
  const b = to ? code.indexOf(to, a + from.length) : -1;
  assert.ok(!to || b > a, `${label}: end anchor not found (${to})`);
  return code.slice(a, b > a ? b : undefined);
}

/** `maybeAutoLogin`'s body: its declaration to the first `}` in column 0. */
const AUTOLOGIN = scope('maybeAutoLogin', 'async function maybeAutoLogin(', '\n}\n');
/** The renewal's tab block. `mark('renew:open-tab')` is unique to it. */
const RENEWAL = scope('the renewal', "mark('renew:open-tab')", null);

test('the two call sites are genuinely distinct regions', () => {
  // If this ever fails, the scoping above has silently collapsed and every test below is
  // reading one call site twice.
  assert.ok(!AUTOLOGIN.includes("mark('renew:open-tab')"),
    'the auto-login region must not swallow the renewal');
  assert.ok(!RENEWAL.includes('async function maybeAutoLogin('),
    'the renewal region must not swallow the auto-login');
});

for (const [label, region, trip] of [
  ['the renewal', RENEWAL, 'withNetworkTrace(tab,'],
  ['the auto-login', AUTOLOGIN, 'attemptLogin(ctx, tab,'],
] as const) {
  test(`${label}: sampling starts on the TAB, before the trip`, () => {
    // `Memory.startSampling` is per-renderer and the trip runs in the throwaway tab, not on
    // the resident page. Starting it on the wrong page profiles a renderer where nothing
    // happens.
    const start = region.indexOf('startNativeSampling(sampler)');
    const at = region.indexOf(trip);
    assert.ok(start > -1, 'sampling must be started');
    assert.ok(at > -1, `could not find the trip (${trip})`);
    assert.ok(at > start, 'and started BEFORE the Okta trip, not after it');
    const attach = region.indexOf('ctx.newCDPSession(tab)');
    assert.ok(attach > -1 && attach < start, 'the CDP session must be bound to the tab');
  });

  test(`${label}: a BEFORE reading is taken and diffed`, () => {
    // Whether a new tab gets its own renderer or shares the resident page's is NOT
    // established. If it shares one, an all-time profile carries hours of the resident page's
    // history and would report it as this trip's. Diffing is correct either way.
    const before = region.indexOf('profBefore');
    const at = region.indexOf(trip);
    assert.ok(before > -1 && before < at, 'the before-reading must precede the trip');
    assert.match(region, /diffProfiles\(profBefore, profAfter\)/,
      'the two readings must be diffed, or the line reports the browser\'s whole life');
  });

  test(`${label}: the reading is printed pass or fail`, () => {
    // The trips that ramp are the FAILING ones — all five guard firings were mid-renewal, and
    // the 9.4 GB auto-login ended in a guard kill. A reading logged only on success would
    // miss every event it was built for.
    //
    // PIN THE CONDITION, NOT A LIST OF SHAPES IT MIGHT TAKE. An earlier version scanned the
    // 400 characters before the call for guessed patterns and PASSED against
    // `if (sampling.ok && r?.renewed === true)` — the exact regression it exists for. The
    // honest assertion is that the render is gated on whether we SAMPLED and nothing else.
    const at = region.indexOf('renderProfile(');
    assert.ok(at > -1, 'the profile must be rendered');
    const ifAt = region.lastIndexOf('if (', at);
    assert.ok(ifAt > -1 && ifAt < at, 'the render must sit inside a conditional we can read');
    const cond = region.slice(ifAt + 4, region.indexOf(') {', ifAt));
    assert.equal(cond.trim(), 'sampling.ok',
      'the profile line may be gated ONLY on whether sampling started — gating it on the '
      + `login or renewal succeeding would miss every event it was built for. Found: ${cond}`);
  });
}

// ── 5b. The auto-login's own constraints ──────────────────────────────────────────────────
//
// The sampler shipped wired to the RENEWAL only, which is the CHEAP Okta trip (140-350 MB
// normally, 2.3 GB at worst). This path is the expensive one — 9.4 GB over twelve minutes on
// 2026-08-20, because okta=GONE forces the full password form — and nothing was measuring it.

test('the auto-login reads the profile BEFORE closing the tab', () => {
  // `tab.close()` destroys the renderer whose profile this is. Reading after it asks a dead
  // target and returns null on every trip — an instrument silent exactly when it has something
  // to say, which is the shape this file has fixed four times.
  // THE **AFTER** READING, for the same reason as the test below: `readNativeProfile(` also
  // matches the before-reading taken up by the tab, hundreds of lines before any close, which
  // makes `read < close` trivially true and the guard inert. It survived exactly that mutation
  // once (verified) before being anchored properly — the twenty-second instance of this shape,
  // and the second in this file in one sitting.
  const read = AUTOLOGIN.indexOf('const profAfter = await readNativeProfile(');
  const close = AUTOLOGIN.indexOf('tab.close()');
  assert.ok(read > -1, 'the after-reading must be taken');
  assert.ok(close > -1, 'the tab must still be closed');
  assert.ok(read < close, 'the profile must be read while the renderer still exists');
});

test('the auto-login reading is in the finally, so a throw cannot skip it', () => {
  // Four verdict branches AND a login that can throw. The 08-20 event did not end in a tidy
  // return, and a reading placed after `attemptLogin` returns would miss the expensive trips.
  const fin = AUTOLOGIN.indexOf('} finally {');
  // THE **AFTER** READING SPECIFICALLY. `readNativeProfile(` appears twice in this region —
  // the before-reading is taken up by the tab, long before the finally — so a bare indexOf
  // matches the wrong one and the assertion inverts. Caught by it failing at baseline.
  const read = AUTOLOGIN.indexOf('const profAfter = await readNativeProfile(');
  assert.ok(fin > -1, 'the tab teardown must stay in a finally');
  assert.ok(read > -1, 'the after-reading must be taken');
  assert.ok(read > fin, 'the reading must sit inside it, not in a branch that a throw skips');
});

test('the auto-login pairs the reading with a RAM delta, taken from the trace', () => {
  // A sampler figure with no RAM pair is the artifact that nearly retired the buffering
  // candidate on 2026-08-19: a trace of a navigation that never ramped says nothing about the
  // leak, and without the pairing there is no way to tell which kind of reading you hold.
  //
  // FROM THE TRACE, which brackets `attemptLogin` alone. A tab-lifetime pair — which is what
  // this originally used — spans the resident-page reload in the `r.ok` branch, and that
  // navigation is in a DIFFERENT renderer that the tab's profile cannot see, so the wider
  // window counts RAM the profile does not and inflates the delta against it.
  assert.match(AUTOLOGIN, /const ram = trace\?\.ram \? trace\.ram\.afterMb - trace\.ram\.beforeMb : null;/,
    'the delta must come from the trace, which brackets the login');
  // ANCHORED ON THE PROPERTY, NOT THE EXPRESSION SHAPE. This required the diff to be built
  // INLINE — `renderProfile(diffProfiles(...), ram)` — and broke over unchanged behaviour the
  // moment that diff was hoisted into a `const` so it could also be sent to the server
  // (migration 066). What it actually cares about is that `ram` REACHES the render, which is
  // true either way. Twenty-second time a guard here has anchored on the wrong thing.
  assert.match(AUTOLOGIN, /renderProfile\([^;)]*,\s*ram\)/,
    'and it must actually be passed to the render, not merely computed — a RAM figure that is '
    + 'measured and dropped is the same reading as no RAM figure at all');
});

test('os.freemem is used, never a PowerShell process scan', () => {
  // `rcFamilyMb()` spawns a child, and spawning is exactly what fails as COMMIT passes ~95% —
  // an instrument that goes quiet as the emergency peaks reports the emergency as calm.
  // `withNetworkTrace` takes its pair with `os.freemem()`, a syscall, for that reason.
  const win = AUTOLOGIN.slice(AUTOLOGIN.indexOf('} finally {'));
  assert.ok(!/rcFamilyMb/.test(win),
    'the teardown must not spawn a process to measure memory');
});

// ── 5c. The network trace on the auto-login ───────────────────────────────────────────────
//
// "Network/IPC buffering" is the leading explanation in three CLAUDE.md entries and has never
// been tested. The renewal has been traced since 2026-08-19; this path — 9.4 GB over twelve
// minutes on 08-20, the largest event ever measured here — never was, which is the trip that
// makes the strongest case for the candidate.

test('the auto-login counts the bytes, on the TAB', () => {
  // On the tab so the listener dies with it. Attached to the resident page it would accumulate
  // a record per response for the life of the browser — a small leak added by the thing
  // investigating a large one.
  assert.match(AUTOLOGIN, /withNetworkTrace\(tab, \(\) => attemptLogin\(ctx, tab,/,
    'the login must be wrapped in the trace, on the tab it runs in');
});

test('the trace is logged pass or fail', () => {
  // The login that ramps 9.4 GB is by definition the one that did NOT return a healthy
  // session, so a trace logged only on success misses every event it was built for. It sits
  // in the finally with the sampler reading, above the close.
  const fin = AUTOLOGIN.indexOf('} finally {');
  const at = AUTOLOGIN.indexOf('describeTrace(trace)');
  assert.ok(at > -1, 'the trace must be rendered');
  assert.ok(at > fin, 'and from the finally, so no branch or throw can skip it');
  assert.ok(at < AUTOLOGIN.indexOf('tab.close()'), 'before the tab is closed');
  // PIN THE CONDITION, NOT JUST THE POSITION. Placement alone let a mutation gating the log on
  // `autoLogin.spent > 0` through this test (it was caught by a sibling, which is luck, not
  // coverage). The only thing the line may depend on is whether a trace EXISTS.
  assert.match(AUTOLOGIN, /log\(trace\s*\?\s*`\s*\$\{describeTrace\(trace\)\}`/,
    'the trace line may be gated only on the trace being present — gating it on the login '
    + 'succeeding would miss every event it was built for, since the trip that ramps 9.4 GB '
    + 'is the one that did not return a healthy session');
});

test('a throw leaves no trace, and the line says so rather than going silent', () => {
  // Silence here is indistinguishable from a trip that moved no bytes — which is the single
  // reading that would falsely eliminate the buffering candidate. Same rule as `unknown` never
  // rounding to `signed-out`.
  assert.match(AUTOLOGIN, /network trace: unavailable/,
    'the missing-trace case must announce itself');
  assert.match(AUTOLOGIN, /let trace = null;/,
    'and `trace` must be declared outside the try, or the finally cannot read it');
  const decl = AUTOLOGIN.indexOf('let trace = null;');
  const tryAt = AUTOLOGIN.indexOf('\n  try {');
  assert.ok(decl > -1 && tryAt > -1 && decl < tryAt, 'declared before the try, not inside it');
});

test('a thrown login is NOT converted into a failed one', () => {
  // The renewal wraps its trip in `.catch(() => null)`. Doing that here would route a thrown
  // login to the `dead` branch — and `dead` is the severity that rings the owner's phone and
  // prints `rc-login.bat`, which force-kills the Chromium the token lives in. Changing
  // release-critical behaviour is not an instrument's business; the throw propagates exactly
  // as it did before the trace was added.
  // PIN THE JOIN, NOT THE WHOLE CALL. A first version scanned the entire wrapped expression
  // for `.catch(` and failed at baseline on the `sufficient` callback's own
  // `readLiveToken(tab).catch(...)` — a legitimate inner guard on a different call. What must
  // be free of a catch is the point where `attemptLogin`'s options object closes into
  // `withNetworkTrace`'s paren.
  assert.match(AUTOLOGIN, /\}\)\);\s*\n\s*trace = t;/,
    'the options object must close straight into withNetworkTrace with nothing between — a '
    + '`.catch` there would turn a thrown login into `{ ok: false }` and route it to `dead`');
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
