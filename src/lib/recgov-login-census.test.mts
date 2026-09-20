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
import { pageCensusInPage, describePageCensus, framePaths } from '../../scripts/auto-cart-bot/recgov-login.mjs';

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
  inputs: [{
    tag: 'input', type: 'text', name: 'code', id: 'code', placeholder: true,
    dialog: true, form: '',
  }],
  inputsTotal: 1,
  dialogsTotal: 1,
  dialogsVisible: 1,
  names: ['Continue', 'Back'],
  controlsTotal: 2,
  trouble: ['alertx1'],
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

test('frames: none, a list, and UNREADABLE are three different readings', () => {
  // (b) — the form is in an iframe — is only separable from (a) if "we could not look" never
  // renders as "there are none". An absent reading standing in for a negative one is this
  // repo's most-repeated failure, and here it would send the reader after a modal that was
  // never going to open.
  assert.match(describePageCensus(full(), []), /frames: none/);
  assert.match(describePageCensus(full(), ['https://x.test/f']), /frames: 1 — https:\/\/x\.test\/f/);
  assert.match(describePageCensus(full(), null), /frames: unreadable/);
  // And the DEFAULT is the honest one: a caller that does not pass a frame list has not
  // looked, so it must not claim the page has none.
  assert.match(describePageCensus(full()), /frames: unreadable/);
});

test('a page with NO dialog says so, as a statement rather than a silence', () => {
  // "No [role=dialog]" is the fact that rules (a) IN — the modal never opened, so whatever
  // email box was filled was not the login one — and it is worthless as an omission.
  assert.match(describePageCensus({ ...full(), dialogsTotal: 0, dialogsVisible: 0 }), /NO \[role="dialog"\] on the page/);
  assert.match(describePageCensus({ ...full(), dialogsTotal: 2, dialogsVisible: 1 }), /dialogs: 2 present, 1 visible/);
  // PRESENT BUT NOT VISIBLE IS ITS OWN READING and must not collapse into either.
  assert.match(describePageCensus({ ...full(), dialogsTotal: 1, dialogsVisible: 0 }), /dialogs: 1 present, 0 visible/);
});

test('an input says whether it is in the dialog and WHICH FORM holds it', () => {
  // This single row is what makes (a) a statement instead of an inference: an email input
  // outside any dialog, in `#newsletter`, IS the report.
  const c = {
    ...full(),
    inputs: [{ tag: 'input', type: 'email', name: 'email', id: 'nl-email', placeholder: true, dialog: false, form: '#newsletter' }],
  };
  const out = describePageCensus(c, []);
  assert.match(out, /input\[type=email\]\[name=email\]#nl-email/);
  assert.match(out, /\[form=#newsletter\]/);
  assert.doesNotMatch(out, /\(modal\)/, 'a field outside the dialog must not be reported inside it');
  assert.match(describePageCensus(full(), []), /\(modal\)/);
});

test('framePaths keeps origin+pathname, dedupes, caps, and never invents a reading', () => {
  // NULL IN, NULL OUT. `page.frames()` can throw on a context that is going away, and a
  // caught throw that returned [] would render as "frames: none" — the one sentence that
  // rules out (b) — over a page nobody managed to ask.
  assert.equal(framePaths(null, 3, 48), null);
  assert.equal(framePaths(undefined, 3, 48), null);
  // A frame URL carries a site key or a session id in its query. The pathname is what names
  // a vendor; the query is a field we would then have to filter.
  assert.deepEqual(framePaths(['https://www.google.com/recaptcha/api2/anchor?k=SITEKEY'], 3, 48),
    ['https://www.google.com/recaptcha/api2/anchor']);
  // Fifteen identical challenge frames is one fact, not fifteen.
  assert.deepEqual(framePaths(['https://a.test/f', 'https://a.test/f'], 3, 48), ['https://a.test/f x2']);
  const many = framePaths(['https://a.test/1', 'https://b.test/2', 'https://c.test/3', 'https://d.test/4'], 3, 48);
  assert.deepEqual(many, ['https://a.test/1', 'https://b.test/2', 'https://c.test/3', '…+1 more']);
  // A `data:` URL's PATHNAME IS ITS CONTENT, so a scheme we do not recognise reports the
  // scheme and nothing else. `about:blank` is the frame Chromium gives a script-written
  // iframe and is worth naming, so it is kept.
  assert.deepEqual(framePaths(['data:text/html,<h1>secret</h1>'], 3, 48), ['data:…']);
  assert.deepEqual(framePaths(['about:blank'], 3, 48), ['about:blank']);
  assert.deepEqual(framePaths(['not a url'], 3, 48), ['unparseable']);
  for (const one of framePaths(['https://x.test/' + 'p'.repeat(200)], 3, 48)!) {
    assert.ok(one.length <= 49, 'a frame path is cut');
  }
});

test('the rendering stays inside one log line', () => {
  // It goes to logs/broker.log, read by a person whose reconnect is failing — not to a dump.
  const c = {
    url: `https://www.recreation.gov/${'p'.repeat(60)}`,
    inputs: Array.from({ length: 5 }, (_, i) => ({
      tag: 'input', type: 'password', name: `field-name-${i}`, id: `field-id-${i}`,
      placeholder: true, dialog: true, form: `form-ident-${i}`,
    })),
    inputsTotal: 400,
    dialogsTotal: 40,
    dialogsVisible: 40,
    names: Array.from({ length: 6 }, () => 'x'.repeat(25)),
    controlsTotal: 400,
    trouble: ['alertx9', 'invalid-fieldx9', 'error-stylingx9', 'captchax9'],
  };
  // THE BOUND IS THE PATHOLOGICAL MAXIMUM, NOT A TYPICAL PAGE. Derived from the caps:
  // 5 inputs x (tag 8 + type 25 + name 25 + id 25 + form 33 + markup 34) = 750, 6 labels x 27
  // = 162, a 120-char url, 4 trouble classes, 3 frames of 49, a dialogs clause, plus the
  // separators — ~1,430. A real rec.gov refusal measures ~450. This fixture maxes every field
  // at once precisely because a bound that only holds for plausible input is not a bound.
  const worst = describePageCensus(c, ['a'.repeat(49), 'b'.repeat(49), 'c'.repeat(49)]);
  assert.ok(worst.length < 1600, `the census has stopped being one line (${worst.length})`);
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
    inputs: [{ tag: 'input', type: longest, name: longest, id: longest, placeholder: true,
      dialog: false, form: longest }],
    inputsTotal: 1,
    dialogsTotal: 0,
    dialogsVisible: 0,
    names: [longest],
    controlsTotal: 1,
    trouble: [],
  };
  // The RENDERER is deliberately not the place that cuts: it renders what it is given, and
  // what it is given crossed the bridge already. So this asserts the collector's caps rather
  // than the formatter's — the same reason the address is redacted in the page.
  assert.ok(describePageCensus(c, [longest]).length > 1600, 'the formatter must not be doing the capping');
  // PER FIELD, not "the constant is mentioned somewhere". The first version of this asserted
  // `maxIdent` appeared in the census body — and it survived a mutation dropping the cap from
  // `name` alone, because `type` and `id` still referenced it. Presence is not liveness, one
  // more time, and the surviving field is the one carrying a generated id.
  for (const field of ['type', 'name', 'id', 'form']) {
    assert.match(CENSUS, new RegExp(`${field}: ident\\(`), `input.${field} is not capped`);
  }
  assert.match(CENSUS, /ident = \(s\) => cut\(clean\(s\), maxIdent\)/);
  assert.match(CENSUS, /url: cut\([^\n]*, maxUrl\)/, 'the pathname is not capped');
  // The frame list is capped in `framePaths`, which is a pure function and is driven above
  // rather than pattern-matched — the one part of the census that can be, because it takes
  // its input from Playwright and not from the page.
  assert.match(CODE, /const cut = \(s\) => \(s\.length > maxChars/, 'a frame path is not capped');
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

test('the frames are read from PLAYWRIGHT, never from the page', () => {
  // An in-page scan can only see `iframe[src]`: blind to a frame written by script, and to
  // one whose document was replaced — which is the wrong instrument for the exact question
  // being asked, because (b) is "there is a frame we cannot reach". `page.frames()` is the
  // browser's own list and crosses an origin.
  assert.doesNotMatch(CENSUS, /querySelectorAll\('iframe/, 'the page may not be asked about frames');
  const CALLER = between(CODE, 'async function pageCensus(page)', '\n}');
  assert.match(CALLER, /page\.frames\(\)/);
  assert.match(CALLER, /f !== main/, 'the main frame is the page, not a frame in it');
  assert.match(CALLER, /framePaths\(/, 'and the list is rendered by the tested function');
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
  assert.match(take, /describePageCensus\(c,/);
  // AND THE FRAME READ HAS ITS OWN CATCH, which must set `null` and not `[]`: `page.frames()`
  // throws on a context that is going away, and an empty list there would render "frames:
  // none" — the sentence that rules out (b) — over a page nobody managed to ask.
  assert.match(take, /catch \{ urls = null; \}/);
  assert.doesNotMatch(take, /catch \{ urls = \[\]/, 'a failed read is not an empty page');
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
    ['PAGE_MAX_LABEL_CHARS', 16, 60], ['PAGE_MAX_FRAMES', 2, 6],
    // An ident under ~16 cuts `input[name=…]` mid-word on a real rec.gov field, which is the
    // one thing the reader is matching against the page. A frame path under 40 truncates
    // `https://challenges.cloudflare.com/…`, i.e. the vendor this exists to name. A url under
    // 60 loses the pathname and keeps only the origin, which every line already implies.
    ['PAGE_MAX_IDENT_CHARS', 16, 60], ['PAGE_MAX_FRAME_CHARS', 40, 90],
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
  // `closest` is modelled rather than stubbed to a constant: the census asks it for BOTH the
  // dialog ancestor and the enclosing form, and a stand-in that answered the same thing to
  // both would make the two readings indistinguishable here while they differ in production.
  const el = (tag: string, attrs: Record<string, string>, text = '',
              ancestors: Record<string, unknown> = {}) => ({
    tagName: tag.toUpperCase(),
    id: attrs.id || '',
    src: attrs.src || '',
    textContent: text,
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k: string) => k in attrs,
    closest: (sel: string) => ancestors[sel] ?? null,
    getClientRects: () => [1],
    offsetParent: null,
  });
  const DIALOG = '[role="dialog"]';
  const newsletterForm = el('form', { id: 'newsletter' });
  const dialogEl = el('div', { role: 'dialog' });
  const actionForm = {
    ...el('form', { action: '/sign-in?next=%2Fprofile' }),
    id: '',
  };
  // A SECOND ACTION, SHORT ENOUGH THAT THE QUERY WOULD SURVIVE THE CUT. The long one above
  // is cut to `/sign-…` whether the pathname is taken or the whole action is — so it is the
  // realistic shape and it cannot see the bug, and the no-value assertion below was being
  // absorbed by `maxIdent` rather than by the code. `/q?s=1` is six characters, so a form
  // reported whole reaches the output verbatim.
  const shortActionForm = { ...el('form', { action: '/q?s=1' }), id: '' };
  // HIDDEN, and it is the whole premise of the census: `input[name=email]` in a newsletter
  // form ahead of the header is exactly the element PR #363 fixed `.first()` for, and a
  // census that reported it would put the 2026-09-18 bug back inside the diagnostic written
  // to explain its successor.
  const hidden = { ...el('input', { type: 'hidden', name: 'email' }), getClientRects: () => [], offsetParent: null };
  // THE 2026-09-20 ROW: a visible email box, outside any dialog, in the newsletter form.
  // Its rendering is what makes (a) a statement rather than an inference.
  const newsletterEmail = el('input', { type: 'email', name: 'email', id: 'nl-email' }, '',
    { form: newsletterForm });
  const actionInput = el('input', { type: 'text', name: 'q' }, '', { form: actionForm });
  const shortActionInput = el('input', { type: 'text', name: 'r' }, '', { form: shortActionForm });
  const inputs = [
    hidden,
    newsletterEmail,
    actionInput,
    shortActionInput,
    ...Array.from({ length: 6 }, (_, i) => el('input', { type: 'text', name: `n${i}`, placeholder: '' }, '',
      { [DIALOG]: dialogEl })),
  ];
  const controls = [
    el('button', {}, `Continue as somebody@example.invalid`),
    el('a', { href: '#x' }, '   Use   a different    address   '),
    el('button', {}, 'x'.repeat(80)),
    { ...el('button', {}, 'Invisible'), getClientRects: () => [], offsetParent: null },
  ];
  const g = globalThis as Record<string, unknown>;
  const saved = [g.document, g.location];
  g.location = {
    origin: 'https://www.recreation.gov', pathname: '/sign-in', host: 'www.recreation.gov',
    // `href` because a form `action` is resolved against it. The census must never REPORT
    // href — it carries the query — and it is entitled to resolve a relative action with it.
    href: 'https://www.recreation.gov/sign-in?next=%2Fprofile',
  };
  g.document = {
    querySelectorAll: (sel: string) => {
      if (sel.includes('textarea')) return inputs;
      if (sel.includes('a[href]')) return controls;
      if (sel.includes('iframe')) return [el('iframe', { src: 'https://www.google.com/recaptcha/api2/anchor?k=SITEKEY' })];
      if (sel.includes('role="alert"')) return [el('div', { role: 'alert' }, 'Something went wrong')];
      if (sel === DIALOG) return [dialogEl, { ...el('div', { role: 'dialog' }), getClientRects: () => [] }];
      return [];
    },
    getElementById: () => null,
  };
  try {
    const c = pageCensusInPage({
      maxInputs: 5, maxControls: 6, maxLabel: 24,
      // Passed, and the first version of this test omitted them — so `cut(s, undefined)` is
      // `s.length > undefined`, which is false, which uncapped every field while the test
      // went on passing. A stand-in that supplies fewer arguments than production exercises
      // a function production never calls.
      maxIdent: 6, maxUrl: 20,
      trouble: [['alert', '[role="alert"]'], ['captcha', 'iframe[src*="recaptcha" i]']],
    });
    const serialised = JSON.stringify(c);
    assert.ok(!serialised.includes('somebody@example.invalid'), 'the address must never leave the page');
    assert.ok(!serialised.includes('SITEKEY'), 'a frame query must never leave the page');
    assert.ok(!serialised.includes('next=%2Fprofile'), 'a form ACTION carries a query too');
    assert.ok(!serialised.includes('s=1'), 'and a SHORT action\'s query is not saved by the cap');
    assert.ok(!serialised.includes('Something went wrong'), 'the banner\'s words must never leave the page');
    assert.equal(c.inputsTotal, 9, 'a hidden input is not part of the visible landscape');
    assert.ok(!serialised.includes('hidden'), 'and it must not be listed either');
    assert.equal(c.controlsTotal, 3, 'nor is a hidden control');
    assert.ok(!c.names.includes('Invisible'));
    assert.equal(c.inputs.length, 5, 'the cap is applied where the page is, not where it is rendered');
    assert.equal(c.inputs[0].name, 'email', 'the hidden field must not be the one that is listed');
    // THE THREE FACTS THAT SEPARATE (a) FROM (b), each read off the element and not assumed.
    assert.equal(c.inputs[0].dialog, false, 'the newsletter box is not in the modal');
    assert.equal(c.inputs[0].form, '#newsl…', 'and the form that holds it is named');
    assert.equal(c.inputs[1].form, '/sign-…', 'an action contributes its PATHNAME, cut like any ident');
    assert.equal(c.inputs[2].form, '/q', 'a short action contributes its pathname and nothing else');
    assert.equal(c.inputs[3].dialog, true, 'a field inside the dialog says so');
    assert.equal(c.inputs[3].form, '', 'a field in no form reports no form, rather than guessing one');
    assert.equal(c.dialogsTotal, 2);
    assert.equal(c.dialogsVisible, 1, 'a dialog in the DOM is not a dialog on the screen');
    assert.ok(c.inputs.every((r: { name: string }) => r.name.length <= 7), 'an identifier is cut in the page');
    assert.equal(c.url, 'https://www.recreati…', 'the pathname is cut in the page');
    assert.ok(c.names.includes('Continue as [address]'));
    // Collapsed whitespace, or a label wraps the log line for no information.
    assert.ok(c.names.includes('Use a different address'));
    assert.ok(c.names.every((n: string) => n.length <= 25), 'a long label must be cut');
    assert.deepEqual(c.trouble, ['alertx1', 'captchax1']);
  } finally {
    [g.document, g.location] = saved;
  }
});

/* ── THE FIX: WHERE A FIELD IS LOOKED FOR ─────────────────────────────────────────────── */

const FILL = between(CODE, 'export async function openLoginModalAndFill', '\n}');

test('the email is looked for in the MODAL, and the page-wide selector is the fallback', () => {
  // The 2026-09-20 report. `:visible` alone cannot tell rec.gov's newsletter box from its
  // login box, and the newsletter comes first in document order — so `.first()` typed the
  // address into it, the Enter that follows submitted THAT, and the page went back to the
  // home screen with no modal and no password field.
  //
  // ORDER IS THE WHOLE FIX, so it is asserted as order and not as presence: a page-wide
  // selector consulted FIRST is satisfied on the opening peek, `scope` goes true, the opener
  // is never clicked, and the modal never opens. That version contains both selectors and
  // reads identically to this one in a diff.
  const modalAt = FILL.indexOf('EMAIL_SEL_MODAL');
  const pageAt = FILL.indexOf('EMAIL_SEL_VISIBLE');
  assert.ok(modalAt > -1, 'the modal-scoped email selector is gone');
  assert.ok(pageAt > -1, 'the page-wide fallback is gone — a modal with no role="dialog" now hard-refuses');
  assert.ok(modalAt < pageAt, 'the page-wide selector is consulted before the modal one');
  // …and AFTER the opener loop. Between the two there must be a click, or the fallback is
  // reached on a page whose modal was never asked to open.
  assert.ok(FILL.indexOf('clickOpener(page)') < pageAt, 'the fallback is consulted before the opener is tried');
  // AND THE FALLBACK MUST BE CONSULTED, NOT MERELY DECLARED. Deleting the one line that
  // reads `emPage` and sets the scope leaves `const emPage = page.locator(EMAIL_SEL_VISIBLE)`
  // standing — so every assertion above still passes while a login form outside a
  // `[role="dialog"]` hard-refuses. A guard on a selector's PRESENCE cannot see that; it is
  // presence-not-liveness, in the guard written for the fix.
  const fallbackAt = FILL.indexOf('scope = SCOPE_PAGE');
  assert.ok(fallbackAt > -1, 'the page-wide selector is declared and never acted on — the fallback is dead');
  assert.ok(pageAt < fallbackAt, 'the scope is set before the page-wide locator that justifies it');
});

test('the fallback is NAMED, so a scope is never silently assumed', () => {
  // "We found it in the login modal" and "we found it somewhere on the page" are different
  // facts about the same run, and a refusal that merges them cannot be acted on. Both
  // constants must reach the refusal via `notes`.
  assert.match(FILL, /notes\.push\(`email field taken from \$\{scope\}`\)/);
  assert.match(CODE, /const SCOPE_MODAL = /);
  assert.match(CODE, /const SCOPE_PAGE = /);
  assert.notEqual(
    CODE.match(/const SCOPE_MODAL = '([^']*)'/)?.[1],
    CODE.match(/const SCOPE_PAGE = '([^']*)'/)?.[1],
    'the two scopes must not read the same in a log line',
  );
});

test('the password is looked for WHERE THE EMAIL CAME FROM', () => {
  // A password box elsewhere on the page is not part of the form that was just filled, and
  // pairing one with the other is how a credential ends up split across two forms.
  assert.match(FILL, /const pwSel = scope === SCOPE_MODAL \? PW_SEL_MODAL : PW_SEL_VISIBLE/);
  // The raw, unscoped selector may be used for the CENSUS (which is meant to count what is
  // on the whole page) and never to act on.
  assert.doesNotMatch(FILL, /locator\(PW_SEL\)/, 'the raw selector must not be acted on');
  assert.match(FILL, /census\(page, PW_SEL\)/, 'and the census still counts the whole page');
});

test('the SUBMIT is scoped too — its third clause was the same bug', () => {
  // It read `, form button[type="submit"]:visible` with no scope, and `.first()` over a comma
  // list resolves in DOCUMENT ORDER rather than clause order. The newsletter's "Sign up" IS a
  // `form button[type=submit]` and comes first, so a run that filled the login modal
  // correctly went on to submit the NEWSLETTER — clearing the modal, returning the user to
  // the home screen, and throwing nothing. Two of three clauses were scoped and the third
  // carried the fault, which is why scoping the fields alone did not fix it.
  assert.match(FILL, /scope === SCOPE_MODAL \? SUBMIT_SEL_MODAL : SUBMIT_SEL_FORM/);
  for (const clause of between(CODE, 'const SUBMIT_SEL_MODAL', '].join').split('\n').slice(1)) {
    if (clause.trim().startsWith("'")) assert.match(clause, /\[role="dialog"\] /, `unscoped: ${clause.trim()}`);
  }
  for (const clause of between(CODE, 'const SUBMIT_SEL_FORM', '].join').split('\n').slice(1)) {
    // The page-wide arm is keyed on a form that CONTAINS a password, which a newsletter form
    // by definition does not. A bare `form button[type="submit"]` is the bug.
    if (clause.trim().startsWith("'")) assert.match(clause, /form:has\(input\[type="password"\]\) /, `unscoped: ${clause.trim()}`);
  }
});

test('Enter is pressed ON THE FIELD, never on the page', () => {
  // `page.keyboard.press` goes to whatever holds focus, and after a React re-render between
  // the fill and the press that can be `<body>` — which submits nothing and reads, five
  // seconds later, as a second step that never arrived.
  assert.match(FILL, /await em\.press\('Enter'\)/);
  assert.doesNotMatch(FILL, /page\.keyboard\.press/, 'focus is not a locator');
});

test('BOTH refusals carry the page census', () => {
  // The email refusal had two readings and they already read differently ("0 match(es)" vs
  // "N match(es), 0 visible"). Scoping the fields gave it a THIRD — a form inside an iframe,
  // which `page.locator()` cannot see at all and which also reports "0 match(es)" — and only
  // the frame list separates them. So it needs the census now, and did not before.
  const email = between(FILL, 'no VISIBLE recreation.gov email field', '  }');
  const pw = between(FILL, 'no VISIBLE recreation.gov password field', '  }');
  for (const [which, refusal] of [['email', email], ['password', pw]] as const) {
    assert.match(refusal, /pageCensus\(page\)/, `the ${which} refusal does not name the page`);
    assert.match(refusal, /notes\.join/, `the ${which} refusal does not say what it tried`);
  }
});

test('the opener is never clicked twice, and the budget is unchanged', () => {
  // The header control TOGGLES the modal and `getByRole('button', /log ?in/i)` matches it
  // before the modal's own "Log In" in document order, so a second click on a slow-but-working
  // modal shuts the thing being waited for. And the whole function is raced against 30s by
  // broker.mjs: 750ms + OPENER_ATTEMPTS x FIELD_TIMEOUT_MS + (FIELD_TIMEOUT_MS + 2000) has to
  // stay inside it, with room for the page load that precedes it.
  assert.match(FILL, /if \(clicked\) \{/, 'the second round no longer checks whether it already clicked');
  const field = Number(CODE.match(/const FIELD_TIMEOUT_MS = (\d+);/)![1]);
  const attempts = Number(CODE.match(/const OPENER_ATTEMPTS = (\d+);/)![1]);
  assert.ok(750 + attempts * field + field + 2000 <= 24000, 'the fill can now outlast broker.mjs\'s 30s race');
});
