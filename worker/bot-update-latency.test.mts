// "UPDATE NOW" MUST NOT TAKE TWENTY MINUTES — the two fixes, pinned.
//
// The anatomy of the 20 minutes: a poller claims within 15s and spawns the updater; when the
// GUARD refuses (a release within 6h, the feed unreachable), the run ends — but the claim
// sat until its 20-minute TTL, so every retry path answered `SKIP - another process holds
// the update claim` at a dead record. And on the happy path, `npm ci` was one to three
// minutes on every update, though most pushes never touch a dependency.
//
// Fix 1 (server, instant): a reported guard refusal releases the claim.
// Fix 2 (box): npm ci runs only when package-lock.json actually changed between the shas.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const UPDATE_TS = readFileSync('src/lib/bot-update.ts', 'utf8');
const GUARD = readFileSync('scripts/auto-cart-bot/update-guard.mjs', 'utf8');
const PS1 = readFileSync('scripts/auto-cart-bot/mini-pc/auto-update.ps1', 'utf8');
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l)).join('\n');

test('a guard refusal releases the claim, and the bystander refusal does NOT', () => {
  const body = code(UPDATE_TS);
  const at = body.indexOf('export async function noteBotUpdateAttempt');
  assert.ok(at > -1);
  const fn = body.slice(at, body.indexOf('\n}', at));
  // The release: SKIP notes clear the claim so the next 15-second poll can retry...
  assert.match(fn, /claimed_at = CASE WHEN \$1 LIKE '%SKIP%' AND \$1 NOT LIKE '%claim%' THEN NULL/,
    'a finished refusal must free the claim — that dead record was the whole 20 minutes');
  assert.match(fn, /claimed_by = CASE WHEN \$1 LIKE '%SKIP%' AND \$1 NOT LIKE '%claim%' THEN NULL/,
    'both columns, or the claim reads half-held');
  // ...except the one that means a REAL updater is running elsewhere. Releasing on that one
  // lets a second updater claim while the first owns the checkout — the two-updaters race
  // the claim exists to prevent.
  assert.match(fn, /NOT LIKE '%claim%'/,
    "the bystander's own refusal must never free a live updater's claim");
});

test("the discriminator matches update-guard's ACTUAL strings, both directions", () => {
  // The SQL keys on note content, so the two files can drift apart silently. Pin them
  // against each other: the claim-held refusal must contain both tokens (never releases),
  // and at least one real refusal must contain SKIP without 'claim' (can release).
  const guardBody = code(GUARD);
  assert.match(guardBody, /SKIP - another process holds the update claim/,
    'the bystander refusal must keep the word "claim", or it starts releasing live claims');
  // The generic refusals are `SKIP - ${verdict.reason}`, so the reasons are what to pin.
  assert.match(guardBody, /SKIP'\} - \$\{verdict\.reason\}/,
    'the guard must still print SKIP with the verdict reason — the release keys on that word');
  const reasons = [...guardBody.matchAll(/reason: [`']([^`']+)/g)].map((m) => m[1]);
  assert.ok(reasons.length >= 3, 'the guard must have refusal reasons for this to be about');
  assert.ok(reasons.some((r) => /hold releases in|cannot reach/.test(r) && !/claim/i.test(r)),
    'the refusals that fire on-demand must stay claim-free, or the release clause never fires');
});

test('npm ci is skipped when the lockfile did not move — and the rollback agrees', () => {
  const ps = code(PS1);
  assert.match(ps, /\$lockChanged = @\(& git diff --name-only \$before \$after\) -match '\^package-lock\\\.json\$'/,
    'the question is the diff between the two shas, nothing fuzzier');
  // Computed BEFORE the reset, while both shas exist to compare.
  assert.ok(ps.indexOf('$lockChanged =') < ps.indexOf('git reset --hard $after'),
    'computed before the checkout moves');
  // Both installs are conditional — forward and rollback — on the SAME variable: same pair
  // of shas, same answer. An unconditional rollback install would reintroduce the wait on
  // exactly the path where the box is already in trouble.
  const installs = [...ps.matchAll(/npm ci --omit=dev/g)];
  assert.equal(installs.length, 2, 'both install sites must still exist');
  for (const m of installs) {
    const before = ps.slice(Math.max(0, m.index! - 220), m.index!);
    assert.match(before, /if \(\$lockChanged\)/, 'every npm ci must sit behind the lockfile check');
  }
  // And the skip says so out loud — a fast update that never says why reads as one that
  // forgot the install.
  assert.match(PS1, /skipping npm ci/, 'the skip must be visible in the log');
});
