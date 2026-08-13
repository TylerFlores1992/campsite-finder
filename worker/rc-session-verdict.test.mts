/**
 * The RC app-session probe — the part that decides what the evidence means.
 *
 * These exist because the classifier is where this question has gone wrong before, twice,
 * in the same shape both times: a token that EXISTED was read as a session that WORKED
 * (2026-08-09, a false green over a session that had expired six minutes earlier), and a
 * renewal was declared measured when the measurement had never asked RC anything
 * (2026-08-12, `renewByReload` comparing a token against itself). Both were single wrong
 * answers to a single question, sitting inside code that was otherwise fine — which is
 * exactly what a pure function pulled out and pinned is for.
 *
 * Every test below was verified failing against the mutation it describes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyRcAppSession,
  factsFromReports,
  type RcAppSessionFacts,
} from '../src/lib/rc-session-verdict';
import { buildPrecartScript, sessionProbe, reporter } from '../src/lib/rc-precart-script';

/**
 * The CODE, with its comments removed.
 *
 * A "this string must be ABSENT" assertion fails on the comment explaining why to keep it
 * absent — which is how "must not kill by image name" once failed on the sentence saying
 * not to. Every prohibition below is about what the script DOES, so it is asked of the code
 * alone; the comments are where the reasons live and must stay quotable.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(['"`]?\s*)?\/\//.test(l))
    .join('\n');
}

const base: RcAppSessionFacts = {
  marker: 'present',
  opens: 4,
  lastOpenAgoSec: 3600,
  firstOpenAgoSec: 86_400,
  prevTokenExpiresInSec: null,
  storedToken: 'none',
  storedExpiresInSec: null,
  liveTokenCaptured: false,
  liveTokenExpiresInSec: null,
  liveTokenAgeSec: null,
};
const facts = (o: Partial<RcAppSessionFacts>): RcAppSessionFacts => ({ ...base, ...o });

test('a token that merely EXISTS is never a working session', () => {
  // THE 2026-08-09 BUG, in its new home. The hold runner reported health because *a* token
  // was in storage; it had expired six minutes earlier. A stored copy is not even evidence
  // — rc-token.mjs exists because that copy is routinely stale — so the strongest thing it
  // can produce here is "we could not tell".
  const stale = classifyRcAppSession(
    facts({ storedToken: 'jwt', storedExpiresInSec: 900, liveTokenCaptured: false }),
    { priorProbes: 3 },
  );
  assert.equal(stale.verdict, 'inconclusive');
  assert.equal(stale.provesRenewal, false);

  // And a LIVE token past its expiry is a dead session, not a live one.
  const expired = classifyRcAppSession(
    facts({ liveTokenCaptured: true, liveTokenExpiresInSec: -400, storedToken: 'jwt' }),
    { priorProbes: 3 },
  );
  assert.equal(expired.verdict, 'expired');
});

test('a renewal is only claimed when we arrived with nothing usable', () => {
  // THE QUESTION THE WHOLE PROBE EXISTS TO ANSWER. The previous open recorded a token that
  // has since expired, and RC handed us a live one anyway — so the Okta session cookie
  // survived and the SPA re-authenticated with no credential typed.
  const renewed = classifyRcAppSession(
    facts({
      prevTokenExpiresInSec: -7200,
      lastOpenAgoSec: 10_800,
      liveTokenCaptured: true,
      liveTokenExpiresInSec: 3500,
      liveTokenAgeSec: 4,
    }),
    { priorProbes: 5 },
  );
  assert.equal(renewed.verdict, 'renewed');
  assert.equal(renewed.provesRenewal, true);

  // Arrived holding a live one: the session persisted, and that is ALL it shows. Counting
  // this as evidence of renewal is how "one observation" quietly becomes "a measurement".
  const persisted = classifyRcAppSession(
    facts({
      prevTokenExpiresInSec: 1200,
      liveTokenCaptured: true,
      liveTokenExpiresInSec: 1100,
      liveTokenAgeSec: 2400,
    }),
    { priorProbes: 5 },
  );
  assert.equal(persisted.verdict, 'live');
  assert.equal(persisted.provesRenewal, false, 'a working session proves nothing about renewal');
});

test('a token minted long ago is a replay, not a re-mint', () => {
  // `renewByReload` reported a renewal it had not performed for three days. The guard is
  // the token's own `iat`: if it was minted well before this open, the marker and the token
  // disagree and the strong claim is not available.
  const r = classifyRcAppSession(
    facts({
      prevTokenExpiresInSec: -60,
      liveTokenCaptured: true,
      liveTokenExpiresInSec: 900,
      liveTokenAgeSec: 4000,
    }),
    { priorProbes: 5 },
  );
  assert.equal(r.verdict, 'live');
  assert.equal(r.provesRenewal, false);

  // An UNKNOWN age must not veto it, though — an opaque token would otherwise turn every
  // real renewal into a false negative. Unknown is not a no.
  const opaque = classifyRcAppSession(
    facts({ prevTokenExpiresInSec: -60, liveTokenCaptured: true, liveTokenExpiresInSec: 900 }),
    { priorProbes: 5 },
  );
  assert.equal(opaque.verdict, 'renewed');
});

test('a purge and a first run are told apart by the server, not the device', () => {
  // A wipe takes our marker with it, so from inside the webview these are the same silence.
  // Only the record of earlier probes from this device separates them — and they need
  // different responses, because renewing cannot fix a purge.
  const missing = facts({ marker: 'absent', opens: 0, lastOpenAgoSec: null });
  assert.equal(classifyRcAppSession(missing, { priorProbes: 0 }).verdict, 'first-open');
  assert.equal(classifyRcAppSession(missing, { priorProbes: 6 }).verdict, 'purged');
});

test('storage intact with no token at all is signed-out, and nothing reported is unknown', () => {
  // okta-auth-js deletes the tokens when its silent renew fails, so an intact marker beside
  // an empty store is that failure — a credential is genuinely needed.
  assert.equal(
    classifyRcAppSession(facts({ storedToken: 'none', liveTokenCaptured: false }), { priorProbes: 2 }).verdict,
    'signed-out',
  );

  // "WE COULD NOT TELL" IS NOT "THERE IS NO SESSION". Rounding the first up to the second is
  // what sent a human to the mini-PC over a session that repaired itself.
  assert.equal(classifyRcAppSession(null, { priorProbes: 9 }).verdict, 'unknown');
  assert.equal(classifyRcAppSession(facts({ marker: null }), { priorProbes: 9 }).verdict, 'unknown');
});

test('the FIRST session report is the one that describes what we arrived to', () => {
  // A run can navigate inside the webview and re-report. By then this same run has already
  // written the marker, so a later report compares against itself — the precise shape of
  // the renewal that measured itself. Taking the last one would report every probe as
  // "arrived healthy".
  const f = factsFromReports([
    { n: 1, stage: 'session', detail: { marker: 'present', opens: 3, prevTokenExpiresInSec: -900, storedToken: 'none' } },
    { n: 2, stage: 'token', detail: { captured: true, length: 939, decodable: true, expiresInSec: 3400, ageSec: 7 } },
    { n: 3, stage: 'session', detail: { marker: 'present', opens: 4, prevTokenExpiresInSec: 3400, storedToken: 'jwt' } },
  ]);
  assert.equal(f?.prevTokenExpiresInSec, -900, 'must read the arrival report, not the later one');
  assert.equal(f?.liveTokenExpiresInSec, 3400);
  assert.equal(f?.liveTokenAgeSec, 7);
  assert.equal(classifyRcAppSession(f, { priorProbes: 2 }).verdict, 'renewed');
});

test('a presence-only token repeat never erases the timings', () => {
  // The probe puts the timings ONLY on the first sighting of each distinct token, so the
  // countdown does not defeat the duplicate collapse. Reading the last `token` report would
  // therefore find `{captured, length}` and lose the expiry — reporting a live session as
  // one whose liveness is unknown.
  const f = factsFromReports([
    { n: 1, stage: 'session', detail: { marker: 'present', opens: 1, prevTokenExpiresInSec: 500, storedToken: 'jwt' } },
    { n: 2, stage: 'token', detail: { captured: true, length: 939, decodable: true, expiresInSec: 3400, ageSec: 5 } },
    { n: 3, stage: 'token', detail: { captured: true, length: 939 } },
    { n: 4, stage: 'token', detail: { captured: true, length: 939 } },
  ]);
  assert.equal(f?.liveTokenExpiresInSec, 3400);
  assert.equal(classifyRcAppSession(f, { priorProbes: 1 }).verdict, 'live');
});

test('the probe never reports a token, a cart key, or a URL query', () => {
  // THE RULE THAT SURVIVED A NEAR MISS. The first version of this diagnostic reported
  // `location.href`, and Okta signs in INSIDE this webview — so mid-flow that is
  // `/login/callback?code=…`, an authorization code exchangeable for the session. Reports
  // cross out of RC's origin, so a field added here without thinking is a credential leaving
  // the device.
  const probe = code(sessionProbe());
  const rep = code(reporter());

  // The marker records an EXPIRY, a number. Nothing may put the token itself on the wire.
  assert.ok(!/send\([^)]*token:\s*t\b/.test(probe), 'the probe must never send a token value');
  assert.match(probe, /expiresInSec/, 'it reports the expiry, which is the liveness');
  assert.ok(
    !/location\.href|location\.search/.test(probe + rep),
    'URLs are origin+pathname only — Okta’s callback query is an authorization code',
  );

  // The whole served bundle, not just the fragment: the guarantee is about what the phone
  // can REPORT, and a future addition anywhere in it would break the same promise. Only the
  // reporting path is constrained — content-rc.js legitimately reads the page's own URL to
  // find its job, and never sends one.
  const bundle = code(buildPrecartScript());
  assert.ok(
    !/send\(\s*["'][^"']*["']\s*,\s*\{[^}]*location\.href/.test(bundle),
    'no full URL may be put into a report',
  );
  assert.match(bundle, /location\.origin \+ location\.pathname/);
});

test('a repeated token reports presence only, so the flood still collapses', () => {
  // rc-inject.js rebroadcasts the token on every RC API call — dozens of identical lines in
  // a quiet minute, which the reporter folds into one plus a count. `expiresInSec` COUNTS
  // DOWN, so putting it on a repeat makes every replay a distinct payload, defeats that
  // collapse, and buries the cart's own status at 08:00:00 — the exact failure the collapse
  // was added for. Only the first sighting of a distinct token may carry timings.
  const sends = code(reporter())
    .split('\n')
    .filter((l) => /send\("token"/.test(l));
  assert.equal(sends.length, 2, 'one report for a new token, one for a repeat');
  assert.equal(
    sends.filter((l) => /expiresInSec|ageSec/.test(l)).length,
    1,
    'exactly one of them may carry the countdown',
  );
  assert.match(sends[1], /captured: true, length: t\.length \}/, 'the repeat is presence only');
  // KEYED ON THE TOKEN'S VALUE, not on "have we ever seen one". A renewal that happens while
  // the webview is open replaces the token, and that event IS the measurement — keying on
  // first-sighting-only would swallow it as a duplicate, which is the observation this whole
  // probe exists to catch.
  assert.match(code(reporter()), /if \(t !== seenToken\)/, 'a different token reports afresh');
});

test('the probe is installed once per document and cannot cart', () => {
  const probe = sessionProbe();
  // WITHOUT THE GUARD, a navigation inside the webview counts a second "open" seconds after
  // the first — and the gap between opens is the entire days-long measurement it exists to
  // take. It would silently read as "the session survived 0 seconds", every time.
  assert.match(probe, /__camphawkRcProbed/, 'must install once per document');
  // Nothing in the probe may touch RC's cart. The two cart POSTs are unproven and an
  // invented unit id can lock a real site — the standing "carting is harmful without a
  // hand-off" rule.
  assert.ok(!/precart|shoppingcart|cartentry/i.test(probe), 'the probe must not touch the cart');
});

test('the marker is written before any token arrives', () => {
  // An open that finds nothing must still record that it HAPPENED. Otherwise a run of
  // signed-out opens is invisible and the next successful one compares itself against an
  // expiry from days earlier — which would read as a renewal that never occurred.
  const probe = sessionProbe();
  const firstSave = probe.indexOf('save(null)');
  const onToken = probe.indexOf('R.onToken');
  assert.ok(firstSave > 0, 'the open is recorded unconditionally');
  assert.ok(firstSave < onToken, 'and before the token handler that may overwrite it');
});

test('the probe actually RUNS, and a second open reads back the first', async () => {
  // EXECUTED, NOT GREPPED. Everything above checks what the script says; this checks that it
  // does anything at all. A script that throws on line 1 and one that ran and found nothing
  // are the same silence — the exact failure the report channel was built for, and it would
  // be absurd for the instrument measuring it to be assumed working.
  //
  // Two opens against one store, which is the whole mechanism: open 1 records a token's
  // expiry, open 2 must read that back and describe what it ARRIVED to.
  const vm = await import('node:vm');
  const store = new Map<string, string>();
  const posted: Array<{ stage: string; detail: Record<string, unknown> }> = [];

  // Nothing in the range Okta issues, so the marker's expiry is unambiguous in the assertions.
  const jwt = (expIn: number, iatAgo: number) =>
    `h.${Buffer.from(JSON.stringify({
      exp: Math.round(Date.now() / 1000) + expIn,
      iat: Math.round(Date.now() / 1000) - iatAgo,
    })).toString('base64url')}.s`;

  function open(liveToken: string | null) {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const s: Record<string, unknown> = {
      console: { log() {} },
      atob: (b: string) => Buffer.from(b, 'base64').toString('binary'),
      location: { origin: 'https://www.reservecalifornia.com', pathname: '/', hash: '' },
      sessionStorage: { getItem: () => null },
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      },
      addEventListener: (k: string, fn: (e: unknown) => void) => { (listeners[k] ??= []).push(fn); },
      cordova_iab: {
        postMessage: (m: string) => {
          const j = JSON.parse(m);
          posted.push({ stage: j.stage, detail: j.detail });
        },
      },
    };
    s.window = s;
    vm.createContext(s);
    new vm.Script(reporter()).runInContext(s);
    new vm.Script(sessionProbe()).runInContext(s);
    if (liveToken) {
      const ctxWindow = vm.runInContext('window', s);
      listeners.message.forEach((fn) => fn({ source: ctxWindow, data: { __camphawk_token: liveToken } }));
    }
  }

  // FIRST OPEN: nothing in the store, and RC hands us a token.
  open(jwt(3600, 5));
  const first = posted.find((p) => p.stage === 'session')!;
  assert.equal(first.detail.marker, 'absent', 'a fresh store has no marker');
  assert.equal(first.detail.opens, 0);
  assert.equal(first.detail.prevTokenExpiresInSec, null, 'nothing to compare against yet');
  assert.equal(first.detail.storedToken, 'none');
  assert.equal(
    classifyRcAppSession(factsFromReports(posted.map((p, i) => ({ n: i + 1, ...p }))), { priorProbes: 0 }).verdict,
    'first-open',
  );

  // SECOND OPEN, later: the marker survives, and it remembers a token that has since died.
  // RC hands us a fresh one anyway — which is the renewal this whole probe exists to catch.
  const saved = JSON.parse(store.get('camphawk_rc_probe')!);
  store.set('camphawk_rc_probe', JSON.stringify({
    ...saved,
    last: Date.now() - 26 * 3600_000,
    tokenExp: Math.round(Date.now() / 1000) - 22 * 3600,
  }));
  posted.length = 0;
  open(jwt(3500, 3));

  const second = posted.find((p) => p.stage === 'session')!;
  assert.equal(second.detail.marker, 'present', 'the marker written by the first open survived');
  assert.equal(second.detail.opens, 1, 'and it counted that open');
  assert.ok((second.detail.prevTokenExpiresInSec as number) < -70_000, 'the recorded token was long dead');
  assert.ok((second.detail.lastOpenAgoSec as number) > 90_000, 'and the gap is the days-long axis');

  const reading = classifyRcAppSession(
    factsFromReports(posted.map((p, i) => ({ n: i + 1, ...p }))),
    { priorProbes: 1 },
  );
  assert.equal(reading.verdict, 'renewed');
  assert.equal(reading.provesRenewal, true);

  // AND THE STORE NOW CARRIES THE NEW TOKEN'S EXPIRY, not the dead one — without this the
  // next open compares against an expiry from days ago and reports a renewal that did not
  // happen, on every single visit.
  const after = JSON.parse(store.get('camphawk_rc_probe')!);
  assert.ok(after.tokenExp > Date.now() / 1000, 'the live token"s expiry replaced the dead one');
  assert.equal(after.opens, 2);

  // THE SESSION REPORT MUST FIT THROUGH THE NARROWER OF THE TWO ROUTES IT TRAVELS.
  // `/api/rc-holds/report` — the path a REAL 8am hold uses — truncates a report's detail at
  // a fixed number of keys and says nothing when it does. So an eighth fact added here would
  // keep working on the admin probe and silently vanish from the only readings taken during
  // an actual release, which is the half that matters. Read off the route so the two cannot
  // drift apart unnoticed.
  const cap = Number(
    /Object\.keys\(out\)\.length >= (\d+)/.exec(
      readFileSync('src/app/api/rc-holds/report/route.ts', 'utf8'),
    )?.[1],
  );
  assert.ok(Number.isFinite(cap), 'found the hold report route’s detail cap');
  assert.ok(
    Object.keys(second.detail).length <= cap,
    `the session report has ${Object.keys(second.detail).length} facts and the hold route keeps ${cap}`,
  );
});

test('the probe reads the arrival state before anything else runs', () => {
  // It must sit immediately after the reporter (whose channel and JWT decoder it needs) and
  // BEFORE rc-inject/content-rc — every line below it is a chance for RC's SPA to change the
  // state being measured. Same failure as injecting at loadstop and calling the stored token
  // evidence: by then the SDK may already have re-minted.
  const src = readFileSync('src/lib/rc-precart-script.ts', 'utf8');
  const order = ['reporter()', 'sessionProbe()', 'inject,', 'content,'];
  let at = src.indexOf('export function buildPrecartScript');
  assert.ok(at > 0);
  for (const piece of order) {
    const next = src.indexOf(piece, at);
    assert.ok(next > at, `${piece} must come after the previous step in buildPrecartScript`);
    at = next;
  }
});
