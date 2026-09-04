/**
 * Guards for the mention monitor.
 *
 * Under `src/`, not `worker/` — `worker/**` is the first entry in `worker-deploy.yml`'s
 * `paths:` list, so a guard over web modules there restarts both poller machines.
 *
 * THE FIRST TEST IS THE IMPORTANT ONE. Everything else here is correctness; that one is the
 * design.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { scoreCandidate, dedupeKey, SURFACE_THRESHOLD } from './score';
import { parseListing, REDDIT_QUERIES } from './sources/reddit';
import { parseAlertFeed, unwrapAlertUrl, unescapeAlertText } from './sources/google-alerts';
import { facebookGroupsSource } from './sources/facebook-groups';
import { runSources, partition, SOURCES } from './run';
import type { Candidate, MentionSource, SourceContext } from './types';

const here = new URL('.', import.meta.url);
const readSrc = (p: string) => readFileSync(new URL(p, here), 'utf8');
/** Comments quote the very shapes these tests forbid, so scan the CODE. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ctx = (over: Partial<SourceContext> = {}): SourceContext => ({
  fetch: (async () => { throw new Error('no network in tests'); }) as unknown as typeof fetch,
  since: new Date('2026-09-01T00:00:00Z'),
  env: {},
  limit: 10,
  ...over,
});

// ── the design constraint ────────────────────────────────────────────────────────────────

test('NOTHING under mentions/ can post, submit or authenticate anywhere', () => {
  // Reddit enforces its self-promotion and automation rules at the DOMAIN level. A
  // shadowban on camphawk.app makes every link invisible sitewide — including a genuine
  // recommendation from a real customer — with no meaningful appeal. That trades the whole
  // channel, permanently, for a few weeks of comments. It is also astroturfing.
  //
  // A COMMENT SAYING "THIS NEVER POSTS" IS NOT A GUARD. This is, and it is why a later
  // session that decides to "just add a quick reply here" fails the build instead.
  const dir = new URL('sources/', here);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.mts'));
  assert.ok(files.length >= 3, `only ${files.length} source files scanned — the glob has rotted`);

  const forbidden: [RegExp, string][] = [
    [/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i, 'a writing HTTP method'],
    [/\/api\/(submit|comment|compose)/i, 'a Reddit write endpoint'],
    [/oauth\.reddit\.com/i, 'the authenticated Reddit API — the read-only host needs no token'],
    [/client_secret|refresh_token|access_token/i, 'a credential that could author content'],
    [/graph\.facebook\.com/i, 'the Graph API — group content is not readable and this must stay manual'],
  ];
  for (const f of [...files, 'run.ts']) {
    const src = strip(f === 'run.ts' ? readSrc(f) : readSrc(`sources/${f}`));
    for (const [re, what] of forbidden) {
      assert.ok(!re.test(src), `${f} contains ${what} — the monitor must stay a READER`);
    }
  }
});

test('the Facebook source performs no request at all', () => {
  // Meta removed group-content reads from the Graph API in 2024, so the only remaining route
  // is a logged-in scraper — which violates the terms, needs the owner's own session, and
  // risks the account that holds every group membership this channel depends on. Pinned so
  // "finishing" it is a failing build rather than a quiet ship.
  const src = strip(readSrc('sources/facebook-groups.ts'));
  assert.ok(!/ctx\.fetch|globalThis\.fetch|await fetch\(/.test(src), 'it made a request');
  assert.equal(facebookGroupsSource.kind, 'manual');
});

test('a manual source contributes a checklist and never a candidate', async () => {
  // Counting places-to-look as findings would make every run report a dozen hits and take
  // the meaning out of the word.
  const r = await facebookGroupsSource.fetch(ctx());
  assert.equal(r.candidates.length, 0);
  assert.ok((r.checklist?.length ?? 0) >= 8);
});

// ── scoring ──────────────────────────────────────────────────────────────────────────────

const post = (over: Partial<Candidate> = {}): Candidate => ({
  source: 'reddit', externalId: 't3_x', url: 'https://www.reddit.com/x', title: 'title', ...over,
});

test('a strong term is a GATE, not points — camping talk never qualifies', () => {
  // Without the gate, "fully booked" plus a question clears any threshold worth setting and
  // every post in r/camping is a hit. A signal that fires on everything is not a signal.
  const s = scoreCandidate(post({
    title: 'Anywhere good to camp this weekend? Everything is fully booked and sold out',
    body: 'no availability anywhere, booked solid, impossible to get',
  }));
  assert.equal(s.score, 0);
  assert.equal(s.surfaced, false);
});

test('somebody stuck and asking, naming a competitor, surfaces', () => {
  const s = scoreCandidate(post({
    title: 'Is campnab worth it? Everything at Big Sur is fully booked',
    body: 'looking for a campsite cancellation alert of some kind',
  }));
  assert.ok(s.surfaced, `scored ${s.score}, needs ${SURFACE_THRESHOLD}`);
  assert.ok(s.reasons.some((r) => r.includes('campnab')));
  assert.ok(s.reasons.some((r) => /question/.test(r)));
});

test('an anti-term is a penalty, not a veto', () => {
  // "promo code" appears in plenty of honest threads, so a veto would lose real posts. The
  // penalty is sized to sink a bare strong match and to be survivable by a post that fits on
  // every other axis.
  const bare = scoreCandidate(post({ title: 'campnab', body: 'selling my reservation, venmo me' }));
  assert.equal(bare.surfaced, false);
  assert.ok(bare.reasons.some((r) => r.startsWith('⚠')), 'the warning must reach the digest');

  const strong = scoreCandidate(post({
    title: 'How do I get a spot at Yosemite? Everything is sold out',
    body: 'tried campnab and campflare, need a campsite cancellation alert, no availability, booked solid',
  }));
  assert.ok(strong.surfaced);
});

test('a question is judged on the TITLE only', () => {
  // Bodies are full of rhetorical questions; a body match would qualify nearly everything.
  const inTitle = scoreCandidate(post({ title: 'Anyone used campnab?', body: 'x' }));
  const inBody = scoreCandidate(post({ title: 'campnab thoughts', body: 'is it any good?' }));
  assert.ok(inTitle.score > inBody.score);
});

test('the dedupe key is the source id, never the URL', () => {
  // Reddit serves one post under several URLs (slug/no-slug, old./www., share suffixes), so
  // a URL key re-surfaces the same thread under a different spelling and reads as a find.
  const a = post({ url: 'https://www.reddit.com/r/camping/comments/abc/some_slug/' });
  const b = post({ url: 'https://old.reddit.com/comments/abc' });
  assert.equal(dedupeKey(a), dedupeKey(b));
  assert.equal(dedupeKey(a), 'reddit:t3_x');
});

// ── reddit parsing ───────────────────────────────────────────────────────────────────────

const listing = (over: Record<string, unknown> = {}) => ({
  data: { children: [{ kind: 't3', data: {
    name: 't3_abc', id: 'abc', title: 'Campsite cancellation alerts?',
    selftext: 'anything like campnab', author: 'someone', subreddit: 'camping',
    permalink: '/r/camping/comments/abc/campsite/', created_utc: 1788000000, ...over,
  } }] },
});

test('created_utc is read as SECONDS', () => {
  // Read as milliseconds it lands in 1970, every post looks older than any `since`, and the
  // monitor silently returns nothing for ever — a fault indistinguishable from a quiet week.
  const [c] = parseListing(listing(), new Date('2000-01-01'));
  assert.equal(c.createdAt?.getUTCFullYear(), 2026);
});

test('a post older than `since` is dropped, and a post with no timestamp is kept', () => {
  assert.equal(parseListing(listing(), new Date('2030-01-01')).length, 0);
  // No timestamp is "the source did not say", which must not round to "too old".
  const [c] = parseListing(listing({ created_utc: undefined }), new Date('2030-01-01'));
  assert.equal(c.createdAt, undefined);
});

test('an entry with no stable id is dropped rather than given a synthetic one', () => {
  // A synthetic key changes every run, so the post is "new" for ever.
  assert.equal(parseListing(listing({ name: undefined, id: undefined }), new Date(0)).length, 0);
});

test('NSFW is skipped and junk shapes yield nothing rather than throwing', () => {
  assert.equal(parseListing(listing({ over_18: true }), new Date(0)).length, 0);
  for (const junk of [null, undefined, {}, { data: {} }, { data: { children: 'no' } }, []]) {
    assert.deepEqual(parseListing(junk, new Date(0)), []);
  }
});

test('every reddit query is non-empty and the set is not silently shrinking', () => {
  assert.ok(REDDIT_QUERIES.length >= 8, `only ${REDDIT_QUERIES.length} queries`);
  for (const q of REDDIT_QUERIES) assert.ok(q.trim().length > 2, `empty query: "${q}"`);
});

// ── google alerts parsing ────────────────────────────────────────────────────────────────

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>tag:google.com,2013:googlealerts/feed:111</id>
<title type="html">Best &lt;b&gt;campsite cancellation&lt;/b&gt; tools &amp; apps</title>
<link href="https://www.google.com/url?rct=j&amp;url=https://example.test/post%3Fa%3D1&amp;ct=ga"/>
<published>2026-09-02T10:00:00Z</published>
<content type="html">We compared &lt;b&gt;campnab&lt;/b&gt; and others</content></entry>
<entry><id>tag:google.com,2013:googlealerts/feed:222</id>
<title type="html">Old news</title><link href="https://example.test/old"/>
<published>2020-01-01T00:00:00Z</published></entry></feed>`;

test('an Atom entry becomes a candidate with the redirect unwrapped and markup stripped', () => {
  const got = parseAlertFeed(ATOM, 'Google Alerts', new Date('2026-09-01'));
  assert.equal(got.length, 1, 'the 2020 entry should be out of range');
  assert.equal(got[0].title, 'Best campsite cancellation tools & apps');
  assert.ok(!got[0].title.includes('<b>'), 'highlighting markup reached the digest');
  assert.equal(got[0].url, 'https://example.test/post?a=1', 'the google redirect was not unwrapped');
  assert.equal(got[0].externalId, 'tag:google.com,2013:googlealerts/feed:111');
});

test('&amp; is unescaped LAST', () => {
  // Unescaping it first turns "&amp;lt;" into "<" — the double-unescape, which here would
  // let markup out of a feed we do not control.
  assert.equal(unescapeAlertText('a &amp;lt;b&amp;gt; c'), 'a &lt;b&gt; c');
});

test('a non-google link is left exactly as it is', () => {
  assert.equal(unwrapAlertUrl('https://example.test/x?url=nope'), 'https://example.test/x?url=nope');
  assert.equal(unwrapAlertUrl('not a url'), 'not a url');
});

test('an unconfigured Google Alerts feed list is NOT an error', async () => {
  // Nobody having set it up yet is the ordinary starting state. A monitor that cries wolf on
  // its own configuration gets ignored along with its findings.
  const r = await SOURCES.find((s) => s.id === 'google-alerts')!.fetch(ctx({ env: {} }));
  assert.equal(r.error, undefined);
  assert.ok((r.checklist?.length ?? 0) > 0, 'it should offer the setup queries instead');
});

// ── the runner ───────────────────────────────────────────────────────────────────────────

const stub = (id: string, over: Partial<MentionSource> = {}): MentionSource => ({
  id, label: id, kind: 'automatic',
  fetch: async () => ({ candidates: [] }),
  ...over,
});

test('a source that could not answer is reported, never rendered as zero findings', async () => {
  const r = await runSources(ctx(), [stub('a', { fetch: async () => ({ candidates: [], error: 'HTTP 429' }) })]);
  assert.equal(r.reports[0].error, 'HTTP 429');
  assert.equal(r.degraded, true, 'the digest leads with this — silence is the expected reading');
});

test('one source throwing does not take the others findings with it', async () => {
  const boom = stub('boom', { fetch: async () => { throw new Error('kaboom'); } });
  const good = stub('good', { fetch: async () => ({ candidates: [post({ source: 'good', title: 'campnab?' })] }) });
  const r = await runSources(ctx(), [boom, good]);
  assert.match(r.reports[0].error ?? '', /kaboom/);
  assert.equal(r.scored.length, 1, 'the healthy source was discarded with the broken one');
});

test('a MANUAL source failing is not degradation', async () => {
  // It makes no request, so it cannot fail in a way that hides findings. Marking it degraded
  // would put a permanent warning on every digest and train the reader past it.
  const r = await runSources(ctx(), [stub('m', { kind: 'manual', fetch: async () => ({ candidates: [], error: 'x' }) })]);
  assert.equal(r.degraded, false);
});

test('the first source to find something keeps it', async () => {
  const same = () => post({ source: 'reddit', externalId: 't3_dupe', title: 'campnab?' });
  const r = await runSources(ctx(), [
    stub('one', { fetch: async () => ({ candidates: [same()] }) }),
    stub('two', { fetch: async () => ({ candidates: [same()] }) }),
  ]);
  assert.equal(r.scored.length, 1);
  assert.equal(r.reports[1].found, 0, 'the duplicate must not be counted twice');
});

test('everything scored is recorded; only what cleared the bar is surfaced', () => {
  // The near-misses are the ONLY evidence about whether the threshold is right, and without
  // them lowering it dumps a month of backlog into one digest as a burst of interest.
  const hi = { ...post({ externalId: 'hi', title: 'campnab? sold out, how do i get a spot' }), key: 'reddit:hi' };
  const lo = { ...post({ externalId: 'lo', title: 'campnab' }), key: 'reddit:lo' };
  const scored = [hi, lo].map((c) => ({ ...c, scoring: scoreCandidate(c) }));
  const { surface, record } = partition(scored, new Set());
  assert.deepEqual(surface.map((c) => c.externalId), ['hi']);
  assert.equal(record.length, 2, 'the below-bar candidate must still be written down');
});

test('an already-seen candidate is not re-surfaced', () => {
  const c = { ...post({ title: 'campnab? sold out, how do i get a spot' }), key: 'reddit:t3_x' };
  const scored = [{ ...c, scoring: scoreCandidate(c) }];
  assert.equal(partition(scored, new Set(['reddit:t3_x'])).surface.length, 0);
  assert.equal(partition(scored, new Set()).surface.length, 1);
});

test('the registry carries all three venues', () => {
  assert.deepEqual(SOURCES.map((s) => s.id).sort(), ['facebook-groups', 'google-alerts', 'reddit']);
});
