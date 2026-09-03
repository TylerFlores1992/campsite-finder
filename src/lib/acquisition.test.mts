/**
 * Guards for `src/lib/acquisition.ts`.
 *
 * UNDER `src/`, NOT `worker/`, DELIBERATELY. `npm test` globs both, but `worker/**` is the
 * FIRST entry in `worker-deploy.yml`'s `paths:` list — so a guard over two web modules placed
 * there would restart both poller machines on every merge. Checked against the workflow, not
 * remembered: this file records getting that claim wrong twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSource, parseSignupSource, SIGNUP_SOURCE_COOKIE } from './acquisition.ts';

const SELF = 'https://camphawk.app';

test('a same-origin referrer is dropped — the rule that makes the column mean anything', () => {
  // People browse before they sign up, so on any page but the first the referrer is our own
  // site. Without this, nearly every row would read "came from camphawk.app" — true, useless,
  // and indistinguishable from direct traffic recorded correctly.
  const s = captureSource({ href: `${SELF}/camping/cabins`, referrer: `${SELF}/search` });
  assert.ok(s);
  assert.equal(s.ref, undefined);
  assert.equal(s.path, '/camping/cabins');
});

test('a real external referrer is kept, as an ORIGIN and never a path', () => {
  const s = captureSource({
    href: `${SELF}/camping/cabins/california`,
    referrer: 'https://www.reddit.com/r/CampingGear/comments/abc123/some_thread/',
  });
  assert.equal(s?.ref, 'https://www.reddit.com');
  assert.ok(!s?.ref?.includes('CampingGear'), 'the referrer PATH must never be stored');
});

test('the landing query string is never stored', () => {
  // The whole reason this module exists as one function rather than three inline reads. A
  // query string is where a session token, an email address or an OAuth code ends up, and
  // this repo has published both an OAuth code and a password by collecting a field it then
  // had to filter.
  const s = captureSource({
    href: `${SELF}/welcome?token=SECRET-abc123&email=someone%40example.com`,
    referrer: '',
  });
  const blob = JSON.stringify(s);
  assert.equal(s?.path, '/welcome');
  assert.ok(!blob.includes('SECRET-abc123'), 'a token in the landing URL reached the record');
  assert.ok(!blob.includes('example.com'), 'an email in the landing URL reached the record');
});

test('only the five standard utm keys survive; click identifiers do not', () => {
  const s = captureSource({
    href: `${SELF}/?utm_source=reddit&utm_medium=post&utm_campaign=launch&gclid=CLICKID123&fbclid=FBID`,
    referrer: '',
  });
  assert.deepEqual(s?.utm, { source: 'reddit', medium: 'post', campaign: 'launch' });
  const blob = JSON.stringify(s);
  assert.ok(!blob.includes('CLICKID123'), 'gclid is a per-click identifier and must not be stored');
  assert.ok(!blob.includes('FBID'), 'fbclid is a per-click identifier and must not be stored');
});

test('direct traffic still records the landing PATH — the path is itself the finding', () => {
  // A signup that landed on /camping/cabins/california says something a signup that landed
  // on / does not, and losing that would make every direct arrival identical.
  const s = captureSource({ href: `${SELF}/camping/cabins/california`, referrer: '' });
  assert.equal(s?.path, '/camping/cabins/california');
  assert.equal(s?.ref, undefined);
});

test('a non-http referrer scheme is dropped rather than half-parsed', () => {
  const s = captureSource({ href: `${SELF}/`, referrer: 'android-app://com.google.android.gm' });
  assert.equal(s?.ref, undefined);
});

test('an unparseable landing URL yields null, not an empty record', () => {
  assert.equal(captureSource({ href: 'not a url', referrer: '' }), null);
});

// ── the server-side re-validation ────────────────────────────────────────────────────────

test('parse re-applies the query-string rule to a HAND-EDITED cookie', () => {
  // THIS IS THE POINT OF parseSignupSource. The cookie is client-written and can be edited
  // between capture and the POST, so a cap applied only at capture was never applied.
  const s = parseSignupSource(
    JSON.stringify({ ref: 'https://evil.test/x?token=LEAK', path: '/x?token=LEAK#frag' }),
  );
  assert.equal(s?.ref, 'https://evil.test');
  assert.equal(s?.path, '/x');
  assert.ok(!JSON.stringify(s).includes('LEAK'));
});

test('parse drops unknown keys instead of rejecting the whole record', () => {
  const s = parseSignupSource(
    JSON.stringify({ path: '/camping', evil: 'x'.repeat(50_000), utm: { source: 'reddit', junk: 'no' } }),
  );
  assert.deepEqual(s, { path: '/camping', utm: { source: 'reddit' } });
});

test('parse caps an oversized value rather than storing it', () => {
  const s = parseSignupSource(JSON.stringify({ path: '/' + 'a'.repeat(5000) }));
  assert.ok(s?.path && s.path.length <= 300, `path was ${s?.path?.length} chars`);
});

test('an absent or unparseable timestamp is dropped, NEVER defaulted to now', () => {
  // "when the first touch happened" and "when the row was written" are different facts. A
  // fabricated one silently turns a month-old cookie into a same-day arrival.
  assert.equal(parseSignupSource(JSON.stringify({ path: '/x', at: 'nonsense' }))?.at, undefined);
  assert.equal(parseSignupSource(JSON.stringify({ path: '/x' }))?.at, undefined);
});

test('parse returns null for nothing usable — not an empty object', () => {
  // `{}` in the column would make "direct signup" and "lost cookie" the same reading, which
  // is the absent-reading-as-a-value mistake this repo keeps paying for.
  assert.equal(parseSignupSource(undefined), null);
  assert.equal(parseSignupSource('not json'), null);
  assert.equal(parseSignupSource('[]'), null);
  assert.equal(parseSignupSource('{}'), null);
  assert.equal(parseSignupSource(JSON.stringify({ ref: 12, path: 34 })), null);
});

test('a captured record round-trips through the parser unchanged', () => {
  // The two run in different processes over a cookie, so a disagreement between them is
  // silent: the client would write a field the server always discards.
  const captured = captureSource({
    href: `${SELF}/camping/yurts?utm_source=newsletter`,
    referrer: 'https://news.ycombinator.com/item?id=1',
    now: new Date('2026-09-03T12:00:00.000Z'),
  });
  assert.deepEqual(parseSignupSource(JSON.stringify(captured)), captured);
});

test('the cookie name is stable', () => {
  // Renaming it orphans every cookie already in a browser, and the failure is invisible:
  // attribution simply goes quiet and reads as "nobody arrived from anywhere".
  assert.equal(SIGNUP_SOURCE_COOKIE, 'ch_src');
});
