/**
 * WHAT WAS ALLOCATING DURING THE RAMPS — the readout for migration 066.
 *
 * Run:  NODE_USE_ENV_PROXY=1 npx tsx scripts/native-alloc-readout.mts
 *
 * The memory series (`scripts/chromium-memory-readout.mts`) says a ramp HAPPENED and how big.
 * This says what the renderer was allocating while it did. They are meant to be read together:
 * a row here without a matching spike there is a threshold that wants raising, and a spike
 * there with nothing here means the sampler could not answer — which is itself a reading.
 *
 * IT REFUSES A VERDICT IT HAS NOT EARNED, the same posture as `recgov-429-profile.mts` waiting
 * for 24 hours of data. With no rows it says so and stops rather than reporting "no leak".
 */
import { query } from '../src/lib/db/client.ts';

/** Bytes as MB, for a line a human reads. */
const mb = (b: number) => `${(b / 1048576).toFixed(0)} MB`;

const pt = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

type Row = {
  taken_at: string;
  context: string | null;
  ram_delta_mb: number | null;
  renderer_bytes: string | number | null;
  sites: Array<{ site: string; bytes: number }> | null;
};

const rows = await query<Row>(
  `SELECT taken_at::text, context, ram_delta_mb, renderer_bytes, sites
     FROM native_alloc_readings
    WHERE taken_at > NOW() - interval '14 days'
    ORDER BY taken_at DESC
    LIMIT 40`,
);

console.log('\n=== NATIVE ALLOCATION READINGS (ramps only, last 14 days) ===\n');

if (!rows.length) {
  // NOT "no leak". The bot only sends a reading when a trip actually cost memory, so an empty
  // table means either no ramp has happened since this shipped, or the box has not updated.
  // Saying "none" and stopping is the honest form; the series is where you check which.
  console.log('  No readings yet.');
  console.log('  That is NOT "no leak" — the bot only sends a reading when a trip actually');
  console.log('  ramped. Check the memory series for whether a ramp happened at all:');
  console.log('    NODE_USE_ENV_PROXY=1 npx tsx scripts/chromium-memory-readout.mts');
  console.log('  and `autocart.bot_version` for whether the box has this code.\n');
  process.exit(0);
}

for (const r of rows) {
  const renderer = Number(r.renderer_bytes ?? 0);
  console.log(`${pt(r.taken_at)} PT  ${r.context ?? '(context not reported)'}`);
  console.log(
    `   free RAM moved ${r.ram_delta_mb ?? '?'} MB · renderer attributed ${mb(renderer)}`,
  );
  if (!r.sites?.length) {
    // The distinction the sampler is careful to preserve, carried through to the readout.
    console.log('   no attributable site — the browser answered with nothing usable');
  } else {
    for (const s of r.sites.slice(0, 6)) {
      console.log(`     ${mb(s.bytes).padStart(9)}  ${s.site}`);
    }
  }
  console.log('');
}

/**
 * THE ONE QUESTION THIS TABLE EXISTS TO ANSWER, asked across every reading rather than one.
 *
 * A single ramp names a site; several naming the SAME site is what turns it into a finding.
 * Summed across readings, largest first.
 */
const total = new Map<string, { bytes: number; seen: number }>();
for (const r of rows) {
  for (const s of r.sites ?? []) {
    const cur = total.get(s.site) ?? { bytes: 0, seen: 0 };
    cur.bytes += s.bytes;
    cur.seen += 1;
    total.set(s.site, cur);
  }
}

if (total.size) {
  console.log('--- ACROSS ALL READINGS, largest first ---\n');
  for (const [site, v] of [...total.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8)) {
    console.log(`  ${mb(v.bytes).padStart(9)}  in ${String(v.seen).padStart(2)} reading(s)  ${site}`);
  }
  console.log('');
  // WHAT THE NAMES CAN AND CANNOT TELL YOU — stated here so a reader does not over-read them.
  console.log('  On Windows nearly all of Chromium is one chrome.dll, so the module NAME');
  console.log('  discriminates little — the OFFSET is the identity, and it is stable for a');
  console.log('  build. A frame in a SYSTEM dll (ws2_32, winhttp, mswsock) would be the');
  console.log('  exception worth acting on: that is the network stack, i.e. the buffering');
  console.log('  candidate this project has asserted three times and never shown.\n');
  console.log('  These figures are the RENDERER ONLY. Memory.startSampling is absent on the');
  console.log('  browser target, and on the 08-23 ramp the renderer held 8,245 MB of 9,180 —');
  console.log('  most of the event, and not all of it.\n');
}
