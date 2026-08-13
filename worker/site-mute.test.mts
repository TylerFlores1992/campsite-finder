/**
 * A muted site must be muted on EVERY path that can alert about it.
 *
 * ── THE BUG (2026-08-13) ───────────────────────────────────────────────────────────────
 * `findRCOpenUnit` has taken an exclusion list since site-mute shipped. `findRCHeldUnits`
 * — the coming-soon path, which announces a unit the night before it releases — never
 * did, and the poller never passed one. So muting a site silenced its availability alerts
 * and did nothing whatever to the coming-soon alerts for the same site.
 *
 * Reported by the owner as "an alert for a muted site at Carpinteria". Unit 4667 (#C218)
 * was one of 41 muted on that watch and still sent push, SMS and email; #C203 had done
 * the same the day before. Coming-soon is the NOISIER of the two paths, because a held
 * unit re-announces itself ahead of every release — so the half of the feature that
 * silently did nothing was the half that mattered more.
 *
 * ── WHY IT SURVIVED VERIFICATION ───────────────────────────────────────────────────────
 * The mute list was verified end to end on 2026-08-09 and recorded as working. That check
 * proved the WRITE persisted and that `/manage/<token>` listed it back. **Nothing checked
 * that a reader honoured it.** A feature whose write half works and whose read half is
 * missing looks identical to a working feature until someone gets the alert — the house
 * failure shape (`status = 'sent'` meaning only "Twilio returned 2xx").
 *
 * ── WHAT THIS HOLDS ────────────────────────────────────────────────────────────────────
 * Both finders take an exclusion list, and the poller passes `muted_site_ids` to BOTH.
 * The unit id is a NUMBER and `muted_site_ids` is `text[]`, so the comparison must be
 * stringified — an untyped compare silently never matches, which reads as "no mutes set".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rc = readFileSync(new URL('../src/lib/availability/reservecalifornia.ts', import.meta.url), 'utf8');
const poller = readFileSync(new URL('./poller.ts', import.meta.url), 'utf8');

/** Comments describe the rule at length; they must not be able to satisfy it. */
const strip = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const rcCode = strip(rc);
const pollerCode = strip(poller);

/** The body of one exported function, up to the next top-level `export`. */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} not found — did it get renamed?`);
  const next = src.indexOf('\nexport ', start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

for (const fn of ['findRCOpenUnit', 'findRCHeldUnits']) {
  test(`${fn} skips muted units`, () => {
    const body = bodyOf(rcCode, fn);
    assert.ok(
      /excludeUnitIds/.test(body),
      `${fn} takes no exclusion list, so every site it finds is alertable even when muted.`,
    );
    assert.ok(
      /muted\.has\(String\(unit\.UnitId\)\)/.test(body),
      `${fn} must skip on \`muted.has(String(unit.UnitId))\`. The id is a number and ` +
      'muted_site_ids is text[]; an unstringified compare never matches and looks like no ' +
      'mutes being set.',
    );
    assert.ok(
      /continue;/.test(body),
      `${fn} must SKIP the unit and keep looking — a mute hides one site, not the campground.`,
    );
  });
}

/**
 * Every WATCH-SCOPED call must pass that watch's mutes.
 *
 * Scoped deliberately: `findRCOpenUnit` is also called from the plain "is anything free in
 * this range?" helper, which has no watch and correctly has no mute list. Asserting on
 * every call site would fail on that one — as the first version of this test did, which is
 * a reminder that a guard written from the shape of the bug can be wrong about the rule.
 * A call is watch-scoped iff it passes `w.campground_id`.
 */
test('the poller passes muted_site_ids on every watch-scoped finder call', () => {
  for (const fn of ['findRCOpenUnit', 'findRCHeldUnits']) {
    const calls: string[] = [];
    for (let i = pollerCode.indexOf(`await ${fn}(`); i !== -1; i = pollerCode.indexOf(`await ${fn}(`, i + 1)) {
      const rest = pollerCode.slice(i);
      calls.push(rest.slice(0, rest.indexOf(');') + 2));
    }
    assert.ok(calls.length, `no call to ${fn} found — renamed?`);
    const scoped = calls.filter((c) => c.includes('w.campground_id'));
    assert.ok(scoped.length, `no watch-scoped call to ${fn} — the alerting path is what this guards`);
    for (const args of scoped) {
      assert.ok(
        /w\.muted_site_ids/.test(args),
        `the poller calls ${fn} for a watch without w.muted_site_ids, so the exclusion ` +
        `list is never populated and the parameter is decoration:\n${args}`,
      );
    }
  }
});
