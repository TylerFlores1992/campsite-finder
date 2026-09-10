/**
 * User-visible copy is written in AMERICAN English. Comments are not.
 *
 * ## The finding (2026-09-10)
 *
 * The owner, reading the app on a phone: *"Favorites is spelt wrong."* They were right.
 * `src/app/admin/users/[id]/page.tsx` rendered `<Row label="Favourites">` — the British
 * form, in a product whose every other favorites label is American, and which is sold on
 * the United States storefront only.
 *
 * A sweep for the rest of the family found five more, all in copy a person reads:
 * `honour` and `authorise`/`authorised` on `/auto-cart`, `organised` on the
 * hardest-to-book landing page, `normalised monthly` on the admin MRR tile, and
 * `a developer enrolment` in the Costs panel. Every one of them was invisible to
 * `tsc`, to `next build` and to the whole test suite — the same blind spot the
 * `jsx-spacing` gate exists for, which is why this is a gate and not a one-off fix.
 *
 * ## Why comments are STRIPPED, and this is the load-bearing decision
 *
 * This repo writes its comments in British English on purpose — `colour`, `behaviour`,
 * `favourite`, `serialised` and `recognise` appear hundreds of times in prose that no
 * customer will ever see. A version of this guard that flagged those would produce
 * four hundred hits, bury the one label that is genuinely wrong, and be deleted by the
 * next person it inconveniences — taking the real finding with it. That has happened
 * here before (`hold-fixture-safety`'s whole-file scan was tried, measured noisy, and
 * rejected on exactly this reasoning).
 *
 * ## Why `cancelled` is NOT in the list, and must not be added
 *
 * It is the single most tempting addition and it would be a mistake:
 *
 *   1. **It is not a misspelling.** Merriam-Webster records `cancelled`/`cancelling` as
 *      an accepted American variant; `canceled` is merely the more common one.
 *   2. **The product already uses it consistently** — roughly fifteen user-visible
 *      strings, including every "was just cancelled" alert.
 *   3. **The SMS bodies feed the A2P 10DLC registered samples.** `docs/a2p-campaign.md`
 *      records that those samples are generated from `smsBody()` precisely so live
 *      traffic cannot drift away from what is registered, and drift between the two is
 *      the thing the 30007 filtering investigation spent a week on. Rewording alert
 *      copy for a spelling preference spends that risk for nothing.
 *
 * `BANNED_ADDITIONS` asserts it stays out, so the decision is re-taken deliberately
 * rather than by whoever notices the inconsistency next.
 *
 * ## The allow-list is bidirectional
 *
 * An entry needs a reason, and a STALE entry fails too — otherwise the list rots into a
 * blanket permission nobody re-reads. The three real entries are worth reading: one is
 * geocoding DATA (`centre` matches real place names like "Visitor Centre"; americanising
 * it would break the lookup), and two are identifiers rather than copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

/** British forms plausible in product copy, mapped to what to write instead. */
const BRITISH: Record<string, string> = {
  favourite: 'favorite',
  favourites: 'favorites',
  favourited: 'favorited',
  favouriting: 'favoriting',
  colour: 'color',
  colours: 'colors',
  coloured: 'colored',
  behaviour: 'behavior',
  behaviours: 'behaviors',
  authorise: 'authorize',
  authorised: 'authorized',
  authorises: 'authorizes',
  authorisation: 'authorization',
  organise: 'organize',
  organised: 'organized',
  organisation: 'organization',
  recognise: 'recognize',
  recognised: 'recognized',
  unrecognised: 'unrecognized',
  normalise: 'normalize',
  normalised: 'normalized',
  optimise: 'optimize',
  optimised: 'optimized',
  summarise: 'summarize',
  summarised: 'summarized',
  serialise: 'serialize',
  serialised: 'serialized',
  capitalise: 'capitalize',
  capitalised: 'capitalized',
  analyse: 'analyze',
  analysed: 'analyzed',
  apologise: 'apologize',
  customise: 'customize',
  customised: 'customized',
  prioritise: 'prioritize',
  personalise: 'personalize',
  personalised: 'personalized',
  licence: 'license',
  defence: 'defense',
  offence: 'offense',
  enrolment: 'enrollment',
  fulfil: 'fulfill',
  honour: 'honor',
  honoured: 'honored',
  favour: 'favor',
  favoured: 'favored',
  neighbour: 'neighbor',
  neighbours: 'neighbors',
  neighbouring: 'neighboring',
  labour: 'labor',
  centre: 'center',
  centres: 'centers',
  grey: 'gray',
  catalogue: 'catalog',
  dialogue: 'dialog',
  programme: 'program',
  travelling: 'traveling',
  travelled: 'traveled',
  whilst: 'while',
  amongst: 'among',
  sceptical: 'skeptical',
  storey: 'story',
  tyre: 'tire',
};

/** Words that must never join the list, with the reason. See the header. */
const BANNED_ADDITIONS = ['cancelled', 'cancelling', 'cancellation', 'cancellations'];

/** file → word → why it stays. Every entry is checked to still be REACHED (see below). */
const ALLOWED: Record<string, Record<string, string>> = {
  'src/lib/sources/geocode.ts': {
    centre:
      'DATA, not copy: a token in GENERIC_NAME_WORDS that matches real published place ' +
      'names ("Visitor Centre"). Americanising it stops the name geocoder recognising them.',
  },
  'src/lib/native/purchases.ts': {
    recognised:
      'A diagnostic reason string ("no recognised products") returned to our own code. ' +
      'StorePaywall renders a fixed sentence, never this field.',
  },
  'src/lib/rc-token-liveness.ts': {
    unrecognised:
      'Readout prose for scripts/rc-holds-readout.mts — read by us at 08:15, never by a user.',
  },
  'src/app/api/rc-holds/claim/route.ts': {
    authorise:
      'An identifier: the route\'s local authorise() helper. Renaming a function on the ' +
      'release-critical claim path buys nothing a user can see.',
  },
  'src/components/admin/AdminTabs.tsx': {
    summarise: 'An identifier: the local summarise() helper that joins problem strings.',
  },
};

/** Comments stripped, line numbers kept. A guard must never fail on the prose explaining it. */
function copyOnly(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (l.trim().startsWith('//') ? '' : l));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.next')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    // Test files are skipped: this one names every British word it bans, and a guard
    // that fails on its own word list is a guard somebody deletes.
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.mts$/.test(e.name)) out.push(rel);
  }
  return out;
}

const PATTERN = new RegExp(`\\b(${Object.keys(BRITISH).join('|')})\\b`, 'gi');

interface Hit {
  file: string;
  line: number;
  word: string;
  text: string;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk('src')) {
    copyOnly(readFileSync(join(root, file), 'utf-8')).forEach((line, i) => {
      PATTERN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PATTERN.exec(line))) {
        hits.push({ file, line: i + 1, word: m[0], text: line.trim().slice(0, 120) });
      }
    });
  }
  return hits;
}

test('no British spelling reaches user-visible copy', () => {
  const offenders = scan().filter(
    (h) => !ALLOWED[h.file]?.[h.word.toLowerCase()],
  );
  assert.deepEqual(
    offenders.map((h) => `${h.file}:${h.line} "${h.word}" -> "${BRITISH[h.word.toLowerCase()]}"  | ${h.text}`),
    [],
    'British spelling in code a user reads. CampHawk ships to the United States ' +
      'storefront only and every other label is American — "Favourites" on the admin ' +
      'user page is what the owner reported on 2026-09-10. Either write the American ' +
      'form, or add an ALLOWED entry saying why this one is not copy.',
  );
});

test('every allow-list entry is still reached', () => {
  const seen = new Set(scan().map((h) => `${h.file}::${h.word.toLowerCase()}`));
  const stale: string[] = [];
  for (const [file, words] of Object.entries(ALLOWED)) {
    for (const word of Object.keys(words)) {
      if (!seen.has(`${file}::${word}`)) stale.push(`${file}: "${word}"`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    'An ALLOWED entry no longer matches anything. Delete it — a permission nobody can ' +
      'reach is a permission nobody re-reads, and the next word to land in that file ' +
      'inherits a reason that was written about something else.',
  );
});

test('every allow-list entry carries a reason', () => {
  for (const [file, words] of Object.entries(ALLOWED)) {
    for (const [word, why] of Object.entries(words)) {
      assert.ok(
        why.length > 40,
        `ALLOWED["${file}"]["${word}"] needs a real reason, not a label.`,
      );
    }
  }
});

test('cancelled stays out of the list, deliberately', () => {
  for (const banned of BANNED_ADDITIONS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(BRITISH, banned),
      false,
      `"${banned}" was added to BRITISH. It is an accepted American variant, it is used ` +
        'consistently across ~15 user-visible strings, and the alert bodies feed the A2P ' +
        '10DLC registered samples — docs/a2p-campaign.md exists because drift between ' +
        'live SMS copy and the registered samples cost a week of filtered alerts. Read ' +
        'this file\'s header before reversing it.',
    );
  }
});

test('the scan reads copy and not comments', () => {
  // The whole design rests on this: a British word in a comment must NOT fail the build,
  // and the same word one line down in a string MUST. Both directions, on one fixture.
  const lines = copyOnly(
    ['// this comment is about a favourite colour', 'const label = "Favourite";', '/* behaviour */'].join('\n'),
  );
  assert.equal(lines[0].includes('favourite'), false, 'a line comment was not stripped');
  assert.equal(lines[2].includes('behaviour'), false, 'a block comment was not stripped');
  assert.ok(lines[1].includes('Favourite'), 'the string literal was stripped — the guard would be blind');
});

test('the favorites label the owner reported is American', () => {
  // Pinned by name rather than left to the sweep: this is the reported defect, and a
  // future refactor that moves the label should have to notice it.
  const page = readFileSync(join(root, 'src/app/admin/users/[id]/page.tsx'), 'utf-8');
  assert.ok(page.includes('label="Favorites"'), 'the admin user page lost its Favorites label');
  assert.equal(page.includes('label="Favourites"'), false, 'the British spelling is back');
});
