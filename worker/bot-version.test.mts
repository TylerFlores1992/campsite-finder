/**
 * DOES THE MINI-PC RUN THE CODE MASTER HAS? (migration 056)
 *
 * `autocart.rc_runner` proves the box can reach camphawk.app; `autocart.rc_session` proves
 * RC accepts its token. Neither says which CHECKOUT is doing either — and "the halves
 * deploy by different routes" is the most expensive recurring failure in this project's
 * log. It cost the T-30/T-25 alarm gap on 2026-08-11 (the Vercel half of a change shipped
 * instantly while the mini-PC half waited for a human), and an evening of reading
 * "37e1527, REFUSED" on the admin page while the box was happily running d1ab782.
 *
 * ── THE PART THAT NEEDED THINKING IS THE SEVERITY, NOT THE COMPARISON ──────────────────
 * Drift is the NORMAL state for part of every day: Vercel auto-deploys on a push to master
 * and the box waits for a quiet window (02:00-05:00 PT) or a human. A check that failed on
 * "different shas" would be red most mornings — which is the cry-wolf failure this project
 * has already had to fix twice, once when `autocart.rc_session` failed on any hold ahead
 * and once when the phone alarm fired half an hour before the repair that fixes it.
 *
 * So `fail` is reserved for the configuration where the halves can actually disagree at a
 * release: the box is missing BOT-SIDE code AND a hold is queued.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { botVersionVerdict } from '../src/lib/health-thresholds';

const DEPLOY = 'aaaaaaa1111111111111111111111111111111111';
const BOX = 'bbbbbbb2222222222222222222222222222222222';

const T = {
  botCodeChanged: '2026-08-11T20:00:00Z',
  boxBefore: '2026-08-11T10:00:00Z', // older than the bot-side change -> missing it
  boxAfter: '2026-08-11T23:00:00Z',  // newer -> has it
  deployNow: '2026-08-12T04:00:00Z',
};

test('same sha is the only thing reported as ok', () => {
  const v = botVersionVerdict({
    boxSha: DEPLOY, boxCommitAt: T.deployNow, deploySha: DEPLOY,
    deployCommitAt: T.deployNow, botCodeAt: T.botCodeChanged, holdsAhead: 3,
  });
  assert.equal(v.level, 'ok');
  assert.equal(v.state, 'current');
});

test('a box that never reported is a WARN, never an ok', () => {
  // A runner too old to send the header lands here, and that is itself the drift signal —
  // the first thing that fixes it is an update. Unknown is not healthy: same rule as
  // `untracked` SMS rows and a null availability reading.
  const v = botVersionVerdict({
    boxSha: null, boxCommitAt: null, deploySha: DEPLOY,
    deployCommitAt: T.deployNow, botCodeAt: T.botCodeChanged, holdsAhead: 5,
  });
  assert.equal(v.level, 'warn');
  assert.equal(v.state, 'unknown');
  assert.match(v.detail, /has not reported a commit/);
});

test('a deploy that cannot read its own sha is a WARN, not an ok', () => {
  // Vercel builds from a shallow clone and `git` can fail there. Comparing against nothing
  // must not silently pass.
  const v = botVersionVerdict({
    boxSha: BOX, boxCommitAt: T.boxAfter, deploySha: null,
    deployCommitAt: null, botCodeAt: null, holdsAhead: 0,
  });
  assert.equal(v.level, 'warn');
  assert.equal(v.state, 'unknown');
});

test('behind on web-only commits is a warn even with holds queued', () => {
  // THE ANTI-CRY-WOLF CASE. The box is behind, but everything in the gap is web code that
  // reached Vercel and never needed to reach the box. Failing here would be red on most
  // mornings and would train everyone to skim this check.
  const v = botVersionVerdict({
    boxSha: BOX, boxCommitAt: T.boxAfter, deploySha: DEPLOY,
    deployCommitAt: T.deployNow, botCodeAt: T.botCodeChanged, holdsAhead: 4,
  });
  assert.equal(v.level, 'warn');
  assert.equal(v.state, 'behind');
});

test('missing BOT-SIDE code with a hold queued FAILS — the acceptance criterion', () => {
  // "Done when: it reads red against a deliberately stale checkout." This is that, as a
  // value: the box's HEAD predates the last commit touching scripts/auto-cart-bot, and a
  // release is coming. That is precisely the T-30/T-25 configuration.
  const v = botVersionVerdict({
    boxSha: BOX, boxCommitAt: T.boxBefore, deploySha: DEPLOY,
    deployCommitAt: T.deployNow, botCodeAt: T.botCodeChanged, holdsAhead: 1,
  });
  assert.equal(v.level, 'fail');
  assert.equal(v.state, 'behind-bot-code');
  assert.match(v.detail, /MISSING bot-side changes/);
  assert.match(v.detail, /1 hold\(s\) queued/);
});

test('missing bot-side code with NOTHING queued is only a warn', () => {
  // Same drift, no release to disagree at — the ordinary wait for the quiet window. The
  // gate on a queued hold is what keeps this check worth reading.
  const v = botVersionVerdict({
    boxSha: BOX, boxCommitAt: T.boxBefore, deploySha: DEPLOY,
    deployCommitAt: T.deployNow, botCodeAt: T.botCodeChanged, holdsAhead: 0,
  });
  assert.equal(v.level, 'warn');
  assert.equal(v.state, 'behind-bot-code');
  assert.match(v.detail, /ordinary wait/);
});

test('a box sitting exactly ON the last bot-side commit is not "missing" it', () => {
  // Strictly older, not older-or-equal. Off by one here would report every box as stale the
  // moment it finished updating, which is the state we most want to read as healthy.
  const v = botVersionVerdict({
    boxSha: BOX, boxCommitAt: T.botCodeChanged, deploySha: DEPLOY,
    deployCommitAt: T.deployNow, botCodeAt: T.botCodeChanged, holdsAhead: 9,
  });
  assert.equal(v.level, 'warn');
  assert.equal(v.state, 'behind');
});

test('an unknown bot-code date never escalates, and says so', () => {
  // A shallow clone can legitimately fail to find the last commit over a path. Guessing
  // "must be fine" would hide the expensive case; guessing "must be broken" would fail
  // every deploy that clones shallowly. Warn, and name the gap in the evidence.
  const v = botVersionVerdict({
    boxSha: BOX, boxCommitAt: T.boxBefore, deploySha: DEPLOY,
    deployCommitAt: T.deployNow, botCodeAt: null, holdsAhead: 6,
  });
  assert.equal(v.level, 'warn');
  assert.match(v.detail, /could not read when bot code last changed/);
});

test('the build refuses to trust a bot-code date from a shallow boundary', () => {
  /**
   * A SHALLOW CLONE DOES NOT RETURN "UNKNOWN" — IT RETURNS A WRONG ANSWER, in the dangerous
   * direction. Measured by cloning this repo at both depths on 2026-08-12:
   *
   *   depth=1   HEAD 05:16:01   log -1 -- scripts/auto-cart-bot -> 05:16:01  (HEAD: wrong)
   *   depth=10  HEAD 05:16:01   log -1 -- scripts/auto-cart-bot -> 05:14:34  (right)
   *
   * Git treats a shallow BOUNDARY commit as parentless, so every file looks added there and
   * the path filter matches it unconditionally. CH_BOT_CODE_AT would then always equal
   * CH_DEPLOY_AT — and `boxCommitAt < botCodeAt` is true for a box behind by even one
   * commit, so EVERY ordinary drift would read "missing bot-side changes" and, with a hold
   * queued, FAIL. That is the cry-wolf failure this file's severity rules exist to prevent,
   * walked back in through the build environment rather than the logic.
   *
   * This is a source assertion because it cannot be exercised here: CI itself checks out at
   * depth 1, so a clone-based test would take a different branch in CI than locally — which
   * is precisely the class of test that passes where it does not matter.
   */
  const cfg = readFileSync('next.config.ts', 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(cfg, /rev-list["'],\s*["']--max-parents=0/,
    'the build must find the roots of the available history');
  assert.match(cfg, /!roots\.includes\(botSha\)/,
    'a bot-code commit that is a root is a shallow boundary and must not be trusted');
  // And the untrusted path must OMIT the variable rather than fall back to something —
  // the check renders a missing value as a warn that names the gap, which is the only
  // honest reading.
  const trustBlock = cfg.slice(cfg.indexOf('const botSha'));
  assert.ok(!/CH_BOT_CODE_AT\s*=\s*(at|sha)\b/.test(trustBlock),
    'never substitute the deploy date for an unknown bot-code date');
});

test('the detail always names both commits', () => {
  // The field exists to be read at 07:50 by someone deciding whether to run update.bat.
  // "Behind" without saying behind WHAT is the shape of message that sent me to the wrong
  // conclusion twice in one evening.
  for (const holds of [0, 2]) {
    const v = botVersionVerdict({
      boxSha: BOX, boxCommitAt: T.boxBefore, deploySha: DEPLOY,
      deployCommitAt: T.deployNow, botCodeAt: T.botCodeChanged, holdsAhead: holds,
    });
    assert.match(v.detail, new RegExp(BOX.slice(0, 7)));
    assert.match(v.detail, new RegExp(DEPLOY.slice(0, 7)));
  }
});
