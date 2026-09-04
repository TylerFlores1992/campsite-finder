/**
 * RC RELEASE-WINDOW READINGS (migration 076): the bracket rules survive the trip into a row,
 * and the script actually records.
 *
 * The reading rules are the whole value of the instrument — a bracket, never a midpoint; a
 * NULL for an absence; a split reported as a split. `facilityReading` is pure so those can be
 * driven without polling RC. The round trip is REAL-DB because the write is one INSERT with a
 * `::jsonb` cast, the shape `[object Object]` lives in. The script check is structural: the
 * danger is `--record` being present in the prompt and absent from the code, which is the
 * fix-present-and-inert shape, and a daily Routine would run it for a week reporting nothing.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mutate, query } from '../src/lib/db/client';
import {
  facilityReading, recordFacilityReading, recentReleaseReadings, type NightFlip,
} from '../src/lib/rc-release-readings';

// A release nobody will ever measure: the year 2001, so it cannot collide with a real run.
const RELEASE = '2001-01-01T08:00:00';
const FACILITY = `rc-__t${process.pid}`;
after(async () => {
  await mutate(`DELETE FROM rc_release_readings WHERE facility = $1`, [FACILITY]).catch(() => {});
});

const n = (name: string, lockedS: number | null, freeS: number | null, retakenS: number | null = null): NightFlip =>
  ({ name, date: '2026-12-01', lockedS, freeS, retakenS });

test('an atomic facility: the tightest bracket, split_brackets 1, retake measured from FREE', () => {
  const r = facilityReading('rc-583', [
    n('#86', -2.2, -0.2), n('#87', -2.2, -0.2), n('#88', -2.2, -0.2, 61.3),
  ], 194, 0);
  assert.equal(r.nightsTracked, 3);
  assert.equal(r.nightsFreed, 3);
  assert.equal(r.nightsRetaken, 1);
  assert.equal(r.bracketLoS, -2.2, 'the LATEST still-locked observation');
  assert.equal(r.bracketHiS, -0.2, 'the EARLIEST free observation');
  assert.equal(r.earliestFreeS, -0.2);
  assert.equal(r.latestFreeS, -0.2);
  assert.equal(r.quickestRetakeS, 61.5, 'retake is measured from the moment it was free, not from T');
  assert.equal(r.splitBrackets, 1);
});

test('a split facility is reported as a split, and the bracket is the tightest interval across nights', () => {
  const r = facilityReading('rc-542', [n('#1', -0.9, 1.1), n('#2', -0.9, 1.1), n('#3', 3.0, 5.1)], 100, 2);
  assert.equal(r.splitBrackets, 2, 'two distinct first-free instants is NOT atomic — the finding, not noise');
  assert.equal(r.bracketLoS, 3.0);
  assert.equal(r.bracketHiS, 1.1);
  assert.equal(r.earliestFreeS, 1.1);
  assert.equal(r.latestFreeS, 5.1);
  assert.equal(r.unreadable, 2);
});

test('NULL is an absence: a facility that never freed has no hi; a night never seen locked contributes no lo', () => {
  const r = facilityReading('rc-539', [n('#1', -1.6, null), n('#2', null, null)], 50, 0);
  assert.equal(r.nightsFreed, 0);
  assert.equal(r.bracketHiS, null);
  assert.equal(r.earliestFreeS, null);
  assert.equal(r.quickestRetakeS, null);
  assert.equal(r.bracketLoS, -1.6);
  assert.equal(r.splitBrackets, 1, 'nothing freed is not a split');
  const none = facilityReading('rc-539', [n('#1', null, null)], 50, 50);
  assert.equal(none.bracketLoS, null);
});

test('no midpoint anywhere in the row', () => {
  const r = facilityReading('rc-583', [n('#86', -2.2, -0.2)], 10, 0);
  const values = [r.bracketLoS, r.bracketHiS, r.earliestFreeS, r.latestFreeS];
  assert.ok(!values.includes(-1.2), 'a midpoint invents precision a 2-second cadence does not have');
});

test('round trip: a row is stored with its jsonb detail and read back numerically comparable', async () => {
  const r = facilityReading(FACILITY, [n('#86', -2.2, -0.2), n('#87', -2.2, -0.2, 61.3)], 194, 1);
  await recordFacilityReading(RELEASE, r);
  const rows = (await query<{ facility: string; bracket_lo_s: string | number; bracket_hi_s: string | number; split_brackets: number; polls: number; unreadable: number; detail: NightFlip[] }>(
    `SELECT facility, bracket_lo_s, bracket_hi_s, split_brackets, polls, unreadable, detail
       FROM rc_release_readings WHERE facility = $1 AND release_at = $2`, [FACILITY, RELEASE],
  ));
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].bracket_lo_s), -2.2);
  assert.equal(Number(rows[0].bracket_hi_s), -0.2);
  assert.equal(rows[0].split_brackets, 1);
  assert.equal(rows[0].polls, 194);
  assert.equal(rows[0].unreadable, 1);
  assert.equal(Array.isArray(rows[0].detail), true, 'jsonb came back as an array, not "[object Object]"');
  assert.equal(rows[0].detail[1].retakenS, 61.3);
  // And the readout's query sees it too (the year-2001 release is inside no real window, so
  // it is matched on run_at, which is now).
  const recent = (await recentReleaseReadings(1)).filter((x) => x.facility === FACILITY);
  assert.equal(recent.length, 1);
});

// ── THE SCRIPT ───────────────────────────────────────────────────────────────────────────

test('rc-release-window.mts records with --record, per facility, AFTER the printed verdict', () => {
  const src = readFileSync(new URL('../scripts/rc-release-window.mts', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(code, /import \{ facilityReading, recordFacilityReading, type NightFlip \} from '\.\.\/src\/lib\/rc-release-readings';/);
  assert.match(code, /const RECORD = process\.argv\.includes\('--record'\);/);
  const verdict = code.indexOf('FLIPPED FREE:');
  const record = code.indexOf('if (RECORD) {');
  assert.ok(verdict > -1 && record > verdict, 'persist AFTER the printout, never instead of it');
  const neverReached = code.lastIndexOf('THE QUESTION WAS NEVER REACHED');
  assert.ok(neverReached < record, 'every refused-verdict exit happens before recording: an unmeasured day records nothing');
  const block = code.slice(record);
  assert.match(block, /await recordFacilityReading\(RELEASE, reading\)/);
  assert.match(block, /if \(nights\.length === 0\) continue;/, 'a facility with nothing tracked records no row');
  assert.match(code, /perFacility\.get\(`rc-\$\{f\}`\)!\.polls\+\+;/, 'polls are counted per facility, or a facility that answered nothing all window hides in the run total');
});
