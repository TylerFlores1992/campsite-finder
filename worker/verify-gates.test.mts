// What `npm run verify` actually gates on.
//
// `verify` is the one command a session is told to run before pushing, so a gate silently
// dropped from it is a gate that stops existing — with no test failing and nothing to notice.
// This pins the membership, not the order of the whole string, so adding a gate is easy and
// losing one is loud.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
const verify: string = pkg.scripts.verify;

test('verify runs the typecheck, the jsx-spacing check, the tests and the build', () => {
  for (const gate of ['npm run typecheck', 'npm run jsx-spacing', 'npm test', 'npm run build']) {
    assert.ok(verify.includes(gate), `\`npm run verify\` must run \`${gate}\` — got: ${verify}`);
  }
});

test('typecheck covers BOTH tsconfigs', () => {
  // The root tsconfig EXCLUDES worker/ and scripts/, so for a long time the poller — the most
  // consequential code in the repo — was typechecked by nothing, and a hard type error passed
  // both `tsc` and `next build`.
  assert.match(pkg.scripts.typecheck, /tsc --noEmit && tsc --noEmit -p tsconfig\.worker\.json/);
});

test('the static gates run BEFORE the slow ones', () => {
  // jsx-spacing is a source scan that finishes in under a second; `npm test` hits the
  // production DB and takes about two minutes. Ordering the cheap check first is the
  // difference between finding a broken user-visible string immediately and finding it after
  // the DB suite has already run.
  assert.ok(
    verify.indexOf('npm run jsx-spacing') < verify.indexOf('npm test'),
    'jsx-spacing must run before the test suite',
  );
  assert.ok(
    verify.indexOf('npm test') < verify.indexOf('npm run build'),
    'the build is the slowest gate and goes last',
  );
});

test('the gates are chained with && so the first failure stops the run', () => {
  // With `;` a failing typecheck would still be followed by a green build line, and the last
  // thing printed is what people read.
  assert.ok(!/;\s*npm/.test(verify), `verify must chain with && only — got: ${verify}`);
});

test('lint is deliberately NOT a verify gate', () => {
  // Recorded so it is not "fixed" by someone tidying. The repo's lint has a standing backlog
  // of non-defects; a gate that is red for reasons nobody intends to act on is one people
  // learn to bypass, and it takes the real gates with it. jsx-spacing earns its place because
  // only its unambiguous tier exits non-zero — the "eyeball" tier prints and passes.
  assert.ok(!/npm run lint/.test(verify), 'lint must stay out of verify — see the comment');
});
