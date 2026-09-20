/**
 * GUARDS FOR THE rec.gov LOGIN REFUSAL'S PAGE CENSUS.
 *
 * #363 fixed the hidden-input trap and the failure moved one step: the email submits and no
 * password field ever appears. The refusal for that said only how many PASSWORD inputs there
 * were — zero — which is equally consistent with a second step we do not wait for, with a
 * challenge, with the submit never taking, and with the modal closing under us. Four faults,
 * one sentence. The census exists so the refusal names the page instead.
 *
 * WHAT IS PINNED HERE IS WHAT A READING MEANS, and what it may never carry. A census that
 * could not run must not render as an empty page (this repo's most repeated error); a page
 * with buttons nobody named must not render as a page with no buttons; and NOTHING may
 * report a value — the address a second step echoes back into a button label is redacted
 * INSIDE the page, not filtered on the way out, because collected-then-filtered is how an
 * OAuth code (2026-08-09) and a password (2026-08-16) both got out of this repo.
 *
 * THE BEHAVIOURAL HALF OF THE REDACTION LIVES IN `scripts/recgov-login-probe.mjs`, which
 * drives the real helper against a real DOM whose button label carries the address and fails
 * unless it is gone. Nothing runs that probe, so the rules it cannot see are pinned here.
 *
 * UNDER `src/`, NOT `worker/`, CHECKED AGAINST `worker-deploy.yml` RATHER THAN REMEMBERED:
 * `worker/**` is the FIRST entry in that workflow's `paths:`, so a guard placed there would
 * restart all three pollers over a diagnostic. Neither `scripts/**` nor a new file under
 * `src/lib/` appears anywhere in the list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// A plain .mjs bot helper. Imported rather than re-implemented: a test asserting a copy of
// the census would assert the copy, which is the rule `claim.ts` was extracted under.
import { pageCensusInPage, describePageCensus } from '../../scripts/auto-cart-bot/recgov-login.mjs';

const SRC = readFileSync('scripts/auto-cart-bot/recgov-login.mjs', 'utf8');
/** Comments are stripped so a guard cannot pass on the prose that explains it. */
const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const CODE = code(SRC);

/** Bound a slice at BOTH ends, and fail loudly when an anchor moves — `indexOf` returns -1
 *  and `slice(-1)` is the last character of the file, which passes everything vacuously. */
function between(hay: string, from: string, to: string): string {
  const a = hay.indexOf(from);
  assert.ok(a > -1, `anchor moved, this guard is measuring nothing: ${from}`);
  const b = hay.indexOf(to, a + from.length);
  assert.ok(b > -1, `closing anchor moved, this guard is measuring nothing: ${to}`);
  return hay.slice(a, b);
}

/** A census with something in every field, for the renderings that matter. */
const full = () => ({
  url: 'https://www.recreation.gov/sign-in',
  inputs: [{ tag: 'input', type: 'text', name: 'code', id: 'code', placeholder: true }],
  inputsTotal: 1,
  names: ['Continue', 'Back'],
  controlsTotal: 2,
  trouble: ['alertx1'],
  hosts: [] as string[],
});

/* ── WHAT A READING MEANS ─────────────────────────────────────────────────────────────── */

test('a census that could not run is NOT an empty page', () => {
  const nothing = describePageCensus(null);
  const empty = describePageCensus({ ...full(), inputs: [], inputsTotal: 0, names: [], controlsTotal: 0 });
  assert.match(nothing, /could not read the page/);
  // The dangerous direction: "we could not look" rendering as "there is nothing there" is
  // what sends the next reader to the wrong half of the system.
  assert.doesNotMatch(nothing, /NO visible input/);
  assert.notEqual(nothing, empty);
  assert.match(empty, /NO visible input of any kind/);
  assert.match(empty, /NO visible button or link/);
});

test('a page with unnamed controls is not a page with no controls', () => {
  const unnamed = describePageCensus({ ...full(), names: [], controlsTotal: 4 });
  const none = describePageCensus({ ...full(), names: [], controlsTotal: 0 });
  assert.match(unnamed, /controls \(4\)/);
  assert.match(unnamed, /none of them named/);
  assert.match(none, /NO visible button or link/);
  assert.notEqual(unnamed, none);
});

test('trouble says "none" rather than going silent — this is a probe that RAN', () => {
  // A missing line reads as a census that did not look for a challenge. It looked.
  assert.match(describePageCensus({ ...full(), trouble: [] }), /trouble: none/);
  assert.match(describePageCensus({ ...full(), trouble: ['captchax1'] }), /trouble: captchax1/);
});

test('a truncated list says it is truncated', () => {
  const c = { ...full(), inputsTotal: 40, controlsTotal: 30, names: ['a', 'b'] };
  const out = describePageCensus(c);
  // The total is the reading; the shown count is what stops "1 input" being read off a page
  // carrying forty. Both, or a capped list understates the page it is describing.
  assert.match(out, /inputs \(40, showing 1\)/);
  assert.match(out, /controls \(30, showing 2\)/);
});

test('third-party frames are reported when present and absent when not', () => {
  // A frame host is the one thing that names an unrecognised challenge vendor, and an empty
  // list is not an interesting absence — `trouble` already reports that it looked.
  assert.match(describePageCensus({ ...full(), hosts: ['www.google.com'] }), /third-party frames: www\.google\.com/);
  assert.doesNotMatch(describePageCensus(full()), /third-party frames/);
});

test('the rendering stays inside one log line', () => {
  // It goes to logs/broker.log, read by a person whose reconnect is failing — not to a dump.
  const c = {
    url: `https://www.recreation.gov/${'p'.repeat(60)}`,
    inputs: Array.from({ length: 5 }, (_, i) => ({
      tag: 'input', type: 'password', name: `field-name-${i}`, id: `field-id-${i}`, placeholder: true,
    })),
    inputsTotal: 400,
    names: Array.from({ length: 6 }, () => 'x'.repeat(25)),
    controlsTotal: 400,
    trouble: ['alertx9', 'invalid-fieldx9', 'error-stylingx9', 'captchax9'],
    hosts: ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)],
  };
  // THE BOUND IS THE PATHOLOGICAL MAXIMUM, NOT A TYPICAL PAGE. Derived from the caps:
  // 5 inputs x (tag 8 + type 25 + name 25 + id 25 + markup 27) = 550, 6 labels x 27 = 162,
  // a 120-char url, 4 trouble classes, 3 hosts of 40, plus the separators — ~1,200. A real
  // rec.gov refusal measures ~330. This fixture maxes every field at once precisely because
  // a bound that only holds for plausible input is not a bound.
  assert.ok(describePageCensus(c).length < 1200, 'the census has stopped being one line');
});

test('every FIELD is capped in the page, not merely every list', () => {
  // The list caps were the whole bound until 2026-09-20 and they are not sufficient: an id,
  // a name and a pathname are as long as the page that generated them, so a framework
  // emitting long generated ids turns one log line into a paragraph with every list cap
  // still reading as satisfied. Measured: an uncapped worst case is unbounded, a capped one
  // is ~1,200.
  const longest = 'z'.repeat(300);
  const c = {
    url: `https://www.recreation.gov/${longest}`,
    inputs: [{ tag: 'input', type: longest, name: longest, id: longest, placeholder: true }],
    inputsTotal: 1,
    names: [longest],
    controlsTotal: 1,
    trouble: [],
    hosts: [longest],
  };
  // The RENDERER is deliberately not the place that cuts: it renders what it is given, and
  // what it is given crossed the bridge already. So this asserts the collector's caps rather
  // than the formatter's — the same reason the address is redacted in the page.
  assert.ok(describePageCensus(c).length > 1200, 'the formatter must not be doing the capping');
  // PER FIELD, not "the constant is mentioned somewhere". The first version of this asserted
  // `maxIdent` appeared in the census body — and it survived a mutation dropping the cap from
  // `name` alone, because `type` and `id` still referenced it. Presence is not liveness, one
  // more time, and the surviving field is the one carrying a generated id.
  for (const field of ['type', 'name', 'id']) {
    assert.match(CENSUS, new RegExp(`${field}: ident\\(`), `input.${field} is not capped`);
  }
  assert.match(CENSUS, /ident = \(s\) => cut\(clean\(s\), maxIdent\)/);
  assert.match(CENSUS, /hosts\.push\(cut\(h, maxHost\)\)/, 'a frame host is not capped');
  assert.match(CENSUS, /url: cut\([^\n]*, maxUrl\)/, 'the pathname is not capped');
});

/* ── WHAT IT MAY NEVER CARRY ──────────────────────────────────────────────────────────── */

const CENSUS = between(CODE, 'export function pageCensusInPage', 'export function describePageCensus');

test('the census never reads a value', () => {
  // Scoped to the census rather than the module, so a future read-back of the email field —
  // which `rc-probe.mjs` does and this helper does not — cannot make this guard cry wolf.
  assert.doesNotMatch(CENSUS, /\.value\b/, 'the census must not read .value');
  assert.doesNotMatch(CENSUS, /getAttribute\(\s*['"]value['"]/, 'nor an input\'s value attribute');
});

test('placeholder is a BOOLEAN — the attribute exists, never what it says', () => {
  assert.match(CENSUS, /placeholder: e\.hasAttribute\(['"]placeholder['"]\)/);
  assert.doesNotMatch(CENSUS, /getAttribute\(\s*['"]placeholder['"]/,
    'a placeholder\'s text is copy, and copy on a login form is where an address gets echoed');
});

test('the reported URL is origin+pathname, never the query or the fragment', () => {
  assert.match(CENSUS, /url: cut\(`\$\{location\.origin\}\$\{location\.pathname\}`/);
  assert.doesNotMatch(CENSUS, /location\.(search|hash)/, 'a login flow puts a one-time code there');
  assert.doesNotMatch(CENSUS, /url: [^\n]*location\.href/, 'href carries the query with it');
});

test('a frame contributes its HOST and nothing else', () => {
  // A frame URL can carry a site key or a session id; the host is all that is needed to name
  // a vendor. Anchored on the extraction, not on the word "host" appearing somewhere.
  assert.match(CENSUS, /new URL\(f\.src\)\.host/);
  assert.doesNotMatch(CENSUS, /hosts\.push\(\s*f\./, 'only the parsed host may be pushed');
});

test('trouble is reported by CLASS, never by quoting the banner', () => {
  // `pair[0]` is the label we chose; `pair[1]` is the selector. Pushing the element's text
  // would put the page's own copy into a log line, which is the thing this avoids.
  //
  // SCOPED TO THE TROUBLE LOOP, and the first version was not — it banned `textContent`
  // across the whole census and so failed at baseline against `label()`, which reads it on
  // purpose to name a button. A guard has to anchor on the thing it names; banning a token
  // module-wide because one loop must not use it is how a correct guard gets deleted by the
  // next person it inconveniences.
  const LOOP = between(CENSUS, 'const hit = []', '\n  return {');
  assert.match(LOOP, /hit\.push\(`\$\{pair\[0\]\}/);
  assert.doesNotMatch(LOOP, /textContent/, 'the trouble probe must not read a banner\'s words');
  assert.doesNotMatch(LOOP, /innerText|innerHTML/, 'nor its markup');
  // A SELECTOR THE ENGINE REJECTS IS NOT "NOTHING WRONG". `catch { n = 0 }` reads as a clean
  // page, which is the absent-reading-as-a-negative shape — and it is the one branch of this
  // census that can report a clean bill of health it never took.
  assert.match(LOOP, /catch \{ n = -1; \}/, 'a rejected selector must not count as zero');
  assert.match(LOOP, /n < 0\) hit\.push\(`\$\{pair\[0\]\}=unreadable`\)/);
});

test('the address is redacted INSIDE the page, before the string crosses back', () => {
  // Not in describePageCensus. Collected-then-filtered is the shape that published an OAuth
  // code and a password, and a filter applied after the value has already left the page is
  // filtering a string that has already been collected.
  assert.match(CENSUS, /replace\(\/\[\^\\s@\]\+@\[\^\\s@\]\+\/g, '\[address\]'\)/);
  const DESCRIBE = between(CODE, 'export function describePageCensus', '\nasync function pageCensus');
  assert.doesNotMatch(DESCRIBE, /@/, 'the formatter must have nothing left to redact');
});

test('every list is capped in the page, so the output cannot grow with the page', () => {
  assert.match(CENSUS, /inputs\.slice\(0, maxInputs\)/);
  assert.match(CENSUS, /controls\.slice\(0, maxControls\)/);
  assert.match(CENSUS, /hosts\.slice\(0, maxHosts\)/);
  assert.match(CENSUS, /cut = \(s, n\) => \(s\.length > n \? `\$\{s\.slice\(0, n\)\}/);
});

/* ── AND IT HAS TO BE REACHED ─────────────────────────────────────────────────────────── */

test('the password refusal takes the page census', () => {
  // The whole change is inert if the census is perfect and nothing calls it — this repo has
  // shipped that shape nine times. Bounded to the throw, so a call anywhere else in the file
  // cannot satisfy it.
  const thrown = between(CODE, 'no VISIBLE recreation.gov password field', '\n    }');
  assert.match(thrown, /\$\{await pageCensus\(page\)\}/);
  // And the targeted census stays: "none of the field I wanted" and "here is what is there"
  // are both readings, and dropping either leaves the other ambiguous.
  assert.match(thrown, /await census\(page, PW_SEL\)/);
});

test('the census never throws in place of the refusal', () => {
  // A diagnostic that fails must report that it failed. Without the catch, a page that has
  // navigated away replaces "no password field, and here is the page" with a Playwright
  // stack — losing the refusal the caller is meant to act on.
  const take = between(CODE, 'async function pageCensus(page)', '\n}');
  assert.match(take, /\.catch\(\(\) => null\)/);
  assert.match(take, /describePageCensus\(c\)/);
});

test('the bounds are bounded from both sides', () => {
  const num = (name: string) => {
    const m = CODE.match(new RegExp(`const ${name} = (\\d+);`));
    assert.ok(m, `${name} is not a plain number any more`);
    return Number(m![1]);
  };
  // Below these the census stops naming the page; above them it stops being a log line.
  for (const [name, lo, hi] of [
    ['PAGE_MAX_INPUTS', 3, 12], ['PAGE_MAX_CONTROLS', 3, 12],
    ['PAGE_MAX_LABEL_CHARS', 16, 60], ['PAGE_MAX_FRAME_HOSTS', 2, 6],
    // An ident under ~16 cuts `input[name=…]` mid-word on a real rec.gov field, which is the
    // one thing the reader is matching against the page. A host under 30 truncates
    // `challenges.cloudflare.com`, i.e. the vendor name this exists to capture. A url under
    // 60 loses the pathname and keeps only the origin, which every line already implies.
    ['PAGE_MAX_IDENT_CHARS', 16, 60], ['PAGE_MAX_HOST_CHARS', 30, 80],
    ['PAGE_MAX_URL_CHARS', 60, 200],
  ] as const) {
    const v = num(name);
    assert.ok(v >= lo && v <= hi, `${name} is ${v}, outside ${lo}..${hi}`);
  }
});

/* ── THE COLLECTOR ITSELF, AGAINST A STAND-IN DOM ─────────────────────────────────────── */

test('the collector redacts, caps and counts', () => {
  // `pageCensusInPage` runs in the page, so it is driven here against the smallest stand-in
  // that exercises the rules — the probe drives it against a real DOM, which is where the
  // visibility and accessible-name behaviour is actually proven.
  const el = (tag: string, attrs: Record<string, string>, text = '') => ({
    tagName: tag.toUpperCase(),
    id: attrs.id || '',
    src: attrs.src || '',
    textContent: text,
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k: string) => k in attrs,
    getClientRects: () => [1],
    offsetParent: null,
  });
  // HIDDEN, and it is the whole premise of the census: `input[name=email]` in a newsletter
  // form ahead of the header is exactly the element PR #363 fixed `.first()` for, and a
  // census that reported it would put the 2026-09-18 bug back inside the diagnostic written
  // to explain its successor.
  const hidden = { ...el('input', { type: 'hidden', name: 'email' }), getClientRects: () => [], offsetParent: null };
  const inputs = [
    hidden,
    ...Array.from({ length: 9 }, (_, i) => el('input', { type: 'text', name: `n${i}`, placeholder: '' })),
  ];
  const controls = [
    el('button', {}, `Continue as somebody@example.invalid`),
    el('a', { href: '#x' }, '   Use   a different    address   '),
    el('button', {}, 'x'.repeat(80)),
    { ...el('button', {}, 'Invisible'), getClientRects: () => [], offsetParent: null },
  ];
  const g = globalThis as Record<string, unknown>;
  const saved = [g.document, g.location];
  g.location = { origin: 'https://www.recreation.gov', pathname: '/sign-in', host: 'www.recreation.gov' };
  g.document = {
    querySelectorAll: (sel: string) => {
      if (sel.includes('textarea')) return inputs;
      if (sel.includes('a[href]')) return controls;
      if (sel.includes('iframe')) return [el('iframe', { src: 'https://www.google.com/recaptcha/api2/anchor?k=SITEKEY' })];
      if (sel.includes('role="alert"')) return [el('div', { role: 'alert' }, 'Something went wrong')];
      return [];
    },
    getElementById: () => null,
  };
  try {
    const c = pageCensusInPage({
      maxInputs: 5, maxControls: 6, maxLabel: 24, maxHosts: 3,
      // Passed, and the first version of this test omitted them — so `cut(s, undefined)` is
      // `s.length > undefined`, which is false, which uncapped every field while the test
      // went on passing. A stand-in that supplies fewer arguments than production exercises
      // a function production never calls.
      maxIdent: 6, maxHost: 9, maxUrl: 20,
      trouble: [['alert', '[role="alert"]'], ['captcha', 'iframe[src*="recaptcha" i]']],
    });
    const serialised = JSON.stringify(c);
    assert.ok(!serialised.includes('somebody@example.invalid'), 'the address must never leave the page');
    assert.ok(!serialised.includes('SITEKEY'), 'a frame query must never leave the page');
    assert.ok(!serialised.includes('Something went wrong'), 'the banner\'s words must never leave the page');
    assert.equal(c.inputsTotal, 9, 'a hidden input is not part of the visible landscape');
    assert.ok(!serialised.includes('hidden'), 'and it must not be listed either');
    assert.equal(c.controlsTotal, 3, 'nor is a hidden control');
    assert.ok(!c.names.includes('Invisible'));
    assert.equal(c.inputs.length, 5, 'the cap is applied where the page is, not where it is rendered');
    assert.equal(c.inputs[0].name, 'n0', 'the hidden field must not be the one that is listed');
    assert.ok(c.inputs.every((r: { name: string }) => r.name.length <= 7), 'an identifier is cut in the page');
    assert.equal(c.url, 'https://www.recreati…', 'the pathname is cut in the page');
    assert.ok(c.names.includes('Continue as [address]'));
    // Collapsed whitespace, or a label wraps the log line for no information.
    assert.ok(c.names.includes('Use a different address'));
    assert.ok(c.names.every((n: string) => n.length <= 25), 'a long label must be cut');
    assert.deepEqual(c.hosts, ['www.googl…'], 'a frame host is cut in the page too');
    assert.deepEqual(c.trouble, ['alertx1', 'captchax1']);
  } finally {
    [g.document, g.location] = saved;
  }
});
