/**
 * An SMS must never carry a camphawk.app link.
 *
 * This is not a style rule — it is measured behaviour. The A2P 10DLC campaign's
 * registered samples link only to recreation.gov and reservecalifornia.com, and a body
 * containing our own domain was filtered (30007) 10 for 10 on the same handset where
 * the identical text without it delivered.
 *
 * The alert path was fixed on 2026-08-05, but FOUR other senders were missed and stayed
 * broken for a day — including the "CampHawk DOWN" page, i.e. the one text whose whole
 * job is to arrive when everything else is failing. This test exists because "we fixed
 * the alerts" was not the same as "we fixed SMS", and nothing caught the difference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAppLink } from '../src/lib/notifications/sms';

test('findAppLink spots our domain in a body, and leaves provider links alone', () => {
  assert.equal(findAppLink('CampHawk: site open. Book: https://camphawk.app/b/abc123')?.startsWith('camphawk.app'), true);
  assert.ok(findAppLink('still want it? Keep: https://camphawk.app/w/04SdjVgf Stop: https://camphawk.app/w/-JuPplyN'));
  // The shapes we DO send must not trip it.
  assert.equal(findAppLink('CampHawk: Silver Lake is open 8/16. Book: https://www.recreation.gov/camping/campgrounds/232449'), null);
  assert.equal(findAppLink('CampHawk: open. https://www.reservecalifornia.com/Web/#!park/665'), null);
  assert.equal(findAppLink('CampHawk DOWN: recgov-canary. Details emailed.'), null);
});

/**
 * The static half: no source file may hand sendSms a template containing our domain.
 *
 * sendSms throws at runtime, which turns this into a loud failure rather than a silent
 * one — but a throw only fires when that code path actually runs, and the dead-man's
 * sweep runs daily while the DOWN page runs only during an outage. Catching it here
 * means the outage is not when we find out.
 */
test('no sendSms call site builds a body containing our domain', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', '.next', '.git', 'dist', 'android', 'ios'].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|mts)$/.test(entry)) continue;
      if (entry === 'sms.ts' || entry.endsWith('.test.mts')) continue; // the guard and this test

      const src = readFileSync(full, 'utf8');
      if (!src.includes('sendSms(')) continue;
      // Look at each sendSms(...) call's text, not the whole file — a file may legally
      // mention the domain elsewhere (an email body, a StatusCallback URL).
      for (const m of src.matchAll(/sendSms\(/g)) {
        const slice = src.slice(m.index!, m.index! + 400);
        const call = slice.slice(0, slice.indexOf('\n}') + 1 || 400);
        if (/camphawk\.app/i.test(call) || /\$\{(base|APP_URL|link|reopen|keepUrl|cancelUrl)\}/.test(call)) {
          offenders.push(`${full.replace(root + '/', '')}: ${call.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'scripts'));
  walk(join(root, 'worker'));

  assert.deepEqual(offenders, [], `these SMS bodies would be filtered by the carrier:\n${offenders.join('\n')}`);
});
