// The New watch screen must not collect a filter the poller does not honour.
//
// THE DEFECT (measured 2026-08-15). `/new` rendered a fieldset legended "What counts as a
// match" offering Site type and a rig-length picker. `grep -rn "site_type\|siteType" worker/`
// returned ZERO hits and `loadWatches` did not even SELECT the column — so a user picked RV
// and was alerted for tent sites, by a control that looked like it worked. Only `siteType`
// was ever even transmitted; rvLength, electric, showers and pets were collected and dropped
// on submit.
//
// THIS GUARD IS BIDIRECTIONAL, which is the point. It fails if the promise comes back without
// the implementation, AND it tells you to restore the control if the implementation ever
// lands — so the decision gets revisited deliberately rather than by whoever notices first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Comments stripped — every string below appears in the note explaining it. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (e.endsWith('.ts') || e.endsWith('.mts')) out.push(rel);
  }
  return out;
}

/** Does anything the POLLER runs actually read a watch's site_type? */
function pollerReadsSiteType(): string[] {
  return walk('worker')
    .filter((f) => !f.endsWith('.test.mts'))
    .filter((f) => /\bsite_type\b|\bsiteType\b/.test(code(read(f))));
}

test('the New watch screen does not send a site type the poller ignores', () => {
  const honoured = pollerReadsSiteType();
  const newWatch = code(read('src/components/v2/NewWatch.tsx'));
  const sends = /siteType:/.test(newWatch);

  if (honoured.length === 0) {
    assert.equal(
      sends, false,
      'NewWatch is sending `siteType` again but nothing in worker/ reads it — that is the '
      + 'control that looks like it works and alerts RV watchers for tent sites. Either make '
      + 'the poller honour it, or do not collect it.',
    );
    return;
  }

  // THE OTHER DIRECTION. Someone has taught the poller about site_type; the screen that
  // collects it should come back, and this decision should be re-taken on purpose.
  assert.ok(
    sends,
    `worker/ now reads site_type (${honoured.join(', ')}), so the New watch control can be `
    + 'restored — see the note in NewWatch.tsx for what the taxonomy work has to answer, '
    + 'particularly whether a site with NO type on file is included or excluded.',
  );
});

test('the filter panel stays on Explore, where it genuinely filters', () => {
  // The defect was never the panel. Search resolves it to `p_site_type = ANY(c.site_types)`
  // against the campground catalog, which is real — removing it there would delete a working
  // feature in the name of fixing a broken one.
  assert.match(code(read('src/components/v2/Explore.tsx')), /siteType/);
  assert.match(code(read('src/lib/sources/ridb/index.ts')), /p_site_type/);
});

test('the watches API still accepts site_type for its one real consumer', () => {
  // Campflare's `campsite_kinds`, for non-flex rec.gov watches when CAMPFLARE_API_KEY is set.
  // Dropping the column would have broken that for no gain: with the picker gone the value is
  // simply absent, which is exactly what a user who left it blank already produced.
  //
  // NOTE the key's presence in production was NOT confirmed — Vercel's env is authoritative
  // and was not readable. That is why this path is left intact rather than reasoned away.
  const route = code(read('src/app/api/watches/route.ts'));
  assert.match(route, /campsite_kinds/);
  assert.match(route, /CAMPFLARE_API_KEY/);
});
