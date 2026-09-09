// `watches.notify_sms` / `notify_email` / `notify_push` ARE DEAD COLUMNS.
//
// FOUND 2026-09-09, while asking why a subscriber's watches all read `notify_sms = false`
// while SMS was going out and being delivered. The answer is that the three columns appear in
// migration 001 and NOWHERE ELSE IN THE REPOSITORY — nothing writes them, nothing reads them,
// and every row therefore carries 001's defaults for ever. The real channel gates are
// elsewhere and are per USER, not per watch: `users.email_alerts_opt_in` for email and
// `users.phone IS NOT NULL` for SMS, both read in `lib/notifications/index.ts`.
//
// SO A READING OF THOSE COLUMNS MEANS NOTHING, and that is the whole cost. They look exactly
// like per-watch channel preferences. Anyone diagnosing a delivery question — as happened —
// finds `notify_sms = false` next to a delivered text and has to disprove it from scratch.
//
// THIS GUARD IS BIDIRECTIONAL, the same shape as `worker/watch-filters.test.mts`. It fails if
// a control ever starts COLLECTING a per-watch channel choice while nothing honours it (the
// site_type defect, which shipped and alerted RV watchers for tent sites), and it tells you to
// delete this test and build the UI if an implementation ever lands. Either way the decision
// is taken deliberately rather than by whoever notices first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Comments stripped — every column name below appears in the notes explaining it. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const COLUMNS = /\bnotify_(sms|email|push)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`;
    if (e === 'node_modules' || e === '.next') continue;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|mts)$/.test(e)) out.push(rel);
  }
  return out;
}

/** Every source file that mentions a per-watch notify column — migrations and this test aside. */
function usersOfTheColumns(): string[] {
  return [...walk('src'), ...walk('worker')]
    .filter((f) => !f.endsWith('notify-columns.test.mts'))
    .filter((f) => COLUMNS.test(code(read(f))));
}

test('nothing reads or writes the per-watch notify columns', () => {
  const users = usersOfTheColumns();
  assert.deepEqual(
    users,
    [],
    `A per-watch notify column now has a consumer: ${users.join(', ')}.\n` +
      'That is a real change, not a tidy-up. Either finish it — collect the choice on /new and\n' +
      'in /manage, and honour it in lib/notifications alongside email_alerts_opt_in and phone —\n' +
      'or drop the columns. Then delete this test. What must NOT happen is one half landing:\n' +
      'a control nothing honours is the site_type defect, and a column nothing sets reading\n' +
      'as a preference is what cost a diagnosis on 2026-09-09.'
  );
});

test('the columns really do still exist, so this test is not guarding nothing', () => {
  // A vacuous guard is indistinguishable from a passing one. If 001 is ever edited or the
  // columns are dropped, this fails and the whole file should go with them.
  const initial = read('src/lib/db/migrations/001_initial.sql');
  for (const c of ['notify_push', 'notify_sms', 'notify_email']) {
    assert.ok(initial.includes(c), `${c} is gone from 001 — delete this test with it`);
  }
});

test('the REAL channel gates are per user and still wired', () => {
  // Named here so the next reader finds the live mechanism in one step rather than grepping
  // for a column that means nothing.
  const dispatch = code(read('src/lib/notifications/index.ts'));
  assert.match(dispatch, /email_alerts_opt_in/, 'email is gated on the user-level opt-in');
  assert.match(dispatch, /getUserPhone/, 'SMS is gated on a number being on file');
});
