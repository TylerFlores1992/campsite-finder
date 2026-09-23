/**
 * A PENDING CANCELLATION HAS TO REACH THE SCREEN.
 *
 * The owner found out a subscriber had cancelled by opening Stripe, days late. Nothing
 * in the product was broken: a cancelling subscriber keeps `status = 'active'`, keeps
 * full entitlement, and keeps paying until the period ends — so the admin's status
 * breakdown filed them under Active and the MRR tile counted their money, both
 * correctly. Between them they hid the only fact worth acting on.
 *
 * Migration 078 stores it and the webhook writes it. What this guards is the CHAIN
 * between the column and a human's eye, because every link in it fails silently:
 *
 *   LIVE_SUB drops the column      -> `cancelling` is undefined, badge never renders
 *   the badge is computed, unused  -> the fix-present-and-inert shape, eight times here
 *   the badge keys on the DATE     -> a cancellation with no date reads as healthy
 *   the count reads dead rows      -> a churn from months ago is reported as in progress
 *
 * None of those throws, none turns a page red, and all four look exactly like "nobody
 * has cancelled". That is the same reading the product gave on 2026-09-15.
 *
 * SOURCE ASSERTIONS, because the alternative is rendering a React tree against a live
 * database. Under `src/` rather than `worker/` deliberately: `worker/**` is the first
 * entry in worker-deploy.yml's `paths:`, and a guard over the admin UI has no business
 * restarting three poller machines. Read out of that workflow, not remembered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CANCELLING } from '@/app/admin/users/queries';

/** Comments stripped. Every rule below is quoted in the note explaining it — including
 *  the mistakes — so a comment-blind scan would fail on its own explanation. */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
    .join('\n');

const QUERIES = code('src/app/admin/users/queries.ts');
const USERS_BOX = code('src/components/admin/UsersBox.tsx');
const ADMIN_PAGE = code('src/app/admin/page.tsx');
const USER_DETAIL = code('src/app/admin/users/[id]/page.tsx');

test('LIVE_SUB carries the cancellation, or nothing downstream can see it', () => {
  const start = QUERIES.indexOf('const LIVE_SUB');
  assert.ok(start > -1, 'LIVE_SUB not found — re-anchor this test');
  const end = QUERIES.indexOf(') sub ON true', start);
  assert.ok(end > start, 'could not find the end of LIVE_SUB');
  const lateral = QUERIES.slice(start, end);
  assert.match(lateral, /s\.cancel_at_period_end/, 'LIVE_SUB must select cancel_at_period_end.');
  assert.match(lateral, /s\.cancel_at\b/, 'LIVE_SUB must select cancel_at.');
});

test('both user queries project it, not just the one somebody was looking at', () => {
  // The list and the detail page are two separate SELECTs over the same lateral. Wiring
  // one and missing the other is the recorded shape: the fix is present, the page it was
  // reported against still says nothing.
  const projections = QUERIES.match(/AS cancelling/g) ?? [];
  assert.equal(
    projections.length,
    2,
    'Both the list query and the detail query must project `cancelling`.'
  );
});

test('the badge is RENDERED, not merely computed', () => {
  // Eight recorded instances of a perfect function nothing calls. `indexOf` matches
  // inside a dead branch just as happily, so the call and the render are pinned apart.
  assert.match(USERS_BOX, /function cancellingBadge/, 'the helper must exist');
  assert.match(
    USERS_BOX,
    /const ending = cancellingBadge\(u\);/,
    'it must be CALLED per row, not merely defined.'
  );
  assert.match(
    USERS_BOX,
    /\{ending \?/,
    'and its result must reach the markup — a badge computed and dropped is the ' +
      'fix-present-and-inert shape this repo has paid for eight times.'
  );
});

test('the badge fires on the FLAG, and a missing date does not silence it', () => {
  // Stripe's types do not promise `cancel_at` is populated whenever the flag is set, and
  // it could not be checked from here (api.stripe.com is 403 at the agent proxy). Keyed
  // on the date, a cancelling subscriber with no date renders as perfectly healthy — an
  // absent reading standing in for a negative, on the one row that needs an answer.
  const start = USERS_BOX.indexOf('function cancellingBadge');
  const end = USERS_BOX.indexOf('\n}', start);
  const fn = USERS_BOX.slice(start, end);
  assert.match(fn, /if \(!u\.cancelling\) return null;/, 'the flag decides whether it renders.');
  assert.match(
    fn,
    /if \(!u\.cancel_at\) return 'Ending';/,
    'a missing date must still show the badge, wordlessly — never hide the churn.'
  );
});

test('EVERY date renders in PACIFIC, never the server zone', () => {
  // `cancel_at` is a real instant and Vercel runs UTC, so a cancellation at 02:00 UTC
  // reads as the following day to an owner in California. One day wrong on the date
  // somebody decides whether to write an email against — and a date that is off by one
  // is worse than none, because it looks like an answer. Same family as formatStayDates
  // rendering Sep 4 as Sep 3 in every US timezone.
  //
  // Counted rather than pattern-matched per site: a fourth render added without the zone
  // is exactly the drift this pins, and it would satisfy any per-site assertion written
  // today because the sites it names would still be correct.
  const ADMIN_TABS = code('src/components/admin/AdminTabs.tsx');
  for (const [name, src] of [
    ['UsersBox', USERS_BOX],
    ['the user detail page', USER_DETAIL],
    ['AdminTabs', ADMIN_TABS],
  ] as const) {
    // WHITESPACE IS COLLAPSED FIRST, and that is the point rather than a tidy-up. The
    // window has to reach PAST the call into its ARGUMENTS, which is where the zone
    // lives — the first version stopped at `toLocaleDateString` and so could never see
    // the thing it asserted about; the second reached far enough on two files and not on
    // the third, whose options block is indented twenty-two columns. A budget measured
    // in characters is a guess about layout, which this repo has already paid for in
    // `rehearsal.test.mts`. Collapsed, the budget is about the CODE.
    const flat = src.replace(/\s+/g, ' ');
    const renders =
      flat.match(/cancel(?:_at|ling\.soonest)[\s\S]{0,120}?toLocaleDateString\([^)]{0,160}\)/g) ?? [];
    assert.ok(renders.length > 0, `${name}: no cancellation date render found — re-anchor this test`);
    for (const r of renders) {
      assert.ok(
        /America\/Los_Angeles/.test(r) || /PACIFIC_DAY/.test(r),
        `${name} renders a cancellation date without a timeZone — it will use the ` +
          `server's, which is UTC on Vercel.`
      );
    }
  }
  assert.match(
    USERS_BOX,
    /timeZone: 'America\/Los_Angeles'/,
    'the shared PACIFIC_DAY options must actually name the zone.'
  );
});

test('the detail page shows it too, and shows it without a date', () => {
  assert.match(USER_DETAIL, /user\.cancelling \?/, 'the detail panel must branch on the flag.');
  assert.match(
    USER_DETAIL,
    /Stripe gave no date/,
    'and must render the row when Stripe gave the flag and no date.'
  );
});

test('THE COUNT IS OVER LIVE ROWS, NOT THE WHOLE TABLE', () => {
  // Stripe's own wording, from stripe@22.3.0's types: cancel_at_period_end is "whether
  // this subscription will (if status=active) or DID (if status=canceled) cancel at the
  // end of the current billing period." So a long-dead row keeps the flag from the
  // cancellation that killed it, and an unfiltered count reports every churn that has
  // ever happened as one in progress — for ever, growing, and never actionable.
  //
  // RE-ANCHORED 2026-09-23, AND THE MOVE IS THE REASON. This pinned the literal
  // `status IN ('active','trialing') AND cancel_at_period_end` inside admin/page.tsx.
  // The liveness clause then moved INTO the `CANCELLING` definition — a strictly
  // stronger arrangement, since no caller can now forget it — and this failed over a
  // change that made its own subject safer. Its anchor assertion did exactly its job:
  // `cancel_at_period_end` is no longer in that file at all, so it said "re-anchor this
  // test" rather than reporting something false.
  //
  // The property is unchanged: the count cannot see a dead row. It is asserted where the
  // rule now lives.
  assert.match(
    CANCELLING('s'),
    /status IN \('active','trialing'\)/,
    'the definition must exclude dead rows itself.'
  );
  assert.match(
    CANCELLING('s'),
    /status IN[\s\S]*AND[\s\S]*cancel_at/,
    'liveness must GATE the cancellation fields, not merely sit beside them.'
  );
  assert.match(
    ADMIN_PAGE,
    /FROM subscriptions s\s+WHERE \$\{CANCELLING\('s'\)\}/,
    'and the count must reach it through the definition rather than restating it.'
  );
});

test('THE DEFINITION READS BOTH OF STRIPE\'S FIELDS — the bug it was written for', () => {
  // A non-null `cancel_at` does NOT imply `cancel_at_period_end`; they are independent.
  // Three gates read the flag alone, so they agreed with each other and were all wrong
  // about the same person. Measured across the whole table on 2026-09-23: exactly one row
  // carries a `cancel_at`, it is `active`, its flag is FALSE, and it leaves 2026-10-08.
  // Proved against production — flag-only counted 0, both-fields counted 1, and zero dead
  // rows were pulled in.
  const sql = CANCELLING();
  assert.match(sql, /cancel_at_period_end/, 'the flag must still count.');
  assert.match(sql, /cancel_at IS NOT NULL/, 'the DATED case is the one that was invisible.');
  assert.match(sql, /\bOR\b/, 'either field alone means cancelling — requiring both is the bug.');
  // `WHERE NULL` is unknown rather than false, and so is `NOT NULL`, so a bare column
  // reference in a boolean position silently drops rows in whichever direction.
  assert.match(sql, /COALESCE\([a-z]+\.cancel_at_period_end, false\)/, 'NULL is not false in SQL.');
});

test('ONE definition — no gate may read the flag on its own', () => {
  // This is the property that actually failed: `CANCELLING` can be perfect while a fourth
  // call site reads the column directly, which is precisely how three gates came to agree
  // and all be wrong. Accounted for by shape, so a projection cannot cover for a gate.
  const reads = [...QUERIES.matchAll(/cancel_at_period_end/g)].length;
  const definition = [...QUERIES.matchAll(/COALESCE\(\$\{t\}\.cancel_at_period_end, false\)/g)].length;
  const projection = [...QUERIES.matchAll(/s\.cancel_at_period_end, s\.cancel_at/g)].length;
  assert.equal(definition, 1, 'there must be exactly ONE definition.');
  assert.equal(projection, 1, 'and exactly one LIVE_SUB projection.');
  assert.equal(reads, definition + projection,
    `queries.ts reads cancel_at_period_end ${reads} times but ${definition + projection} are ` +
    'accounted for — the extra is a fourth gate, and it will disagree with the others.');
  assert.equal([...ADMIN_PAGE.matchAll(/cancel_at_period_end/g)].length, 0,
    'admin/page.tsx must reach the rule through CANCELLING, never by naming the column.');
});

test('the alias is a parameter, so one definition serves every caller', () => {
  assert.match(CANCELLING('s'), /\bs\.cancel_at_period_end\b/);
  assert.match(CANCELLING(), /\bsub\.cancel_at_period_end\b/, 'the LIVE_SUB lateral is the default.');
  assert.ok(!CANCELLING('s').includes('sub.'), 'an explicit alias must not leak the default.');
});

test('the count is reported beside the statuses, never AS one', () => {
  // The four StatusRows are Stripe statuses and they partition the table; a cancelling
  // subscription is `active` and is already counted there. A fifth row would double-count
  // it and stop the column summing, which is exactly the sort of number somebody
  // reconciles against Stripe and cannot make add up.
  const ADMIN_TABS = code('src/components/admin/AdminTabs.tsx');
  assert.doesNotMatch(
    ADMIN_TABS,
    /StatusRow label="Cancelling"/,
    'cancelling is not a Stripe status and must not join the breakdown.'
  );
  assert.match(
    ADMIN_TABS,
    /data\.cancelling\.n > 0 \?/,
    'it renders only when there is something to say — "Cancelling 0" every day is a ' +
      'line nobody reads by the end of the week, and its appearance IS the news.'
  );
});
