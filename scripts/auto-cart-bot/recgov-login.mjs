// Shared recreation.gov login automation, used by BOTH the remote broker (broker.mjs,
// when the user submits credentials) and the bot's auto-relogin (bot.mjs, when a saved
// session dies). rec.gov has no /sign-in page — login is a MODAL opened from the header
// "Sign Up / Log In" — so we open that, fill, and submit. Best-effort selectors; callers
// fall back to a manual/streamed sign-in when this can't complete (e.g. CAPTCHA / 2FA).
//
// ================================================================================
// THE SELECTORS MUST BE VISIBLE-ONLY, AND THAT IS NOT TIDINESS (2026-09-18).
//
// `input[name="email"]` matches a HIDDEN input on recreation.gov's own page, and it comes
// FIRST in DOM order — so `.first()` resolved to it and `waitFor({state:'visible'})` could
// never succeed. Straight off logs/broker.log on the mini-PC, three attempts in one morning:
//
//     couldn't fill the login form for user_…: locator.waitFor: Timeout 8000ms exceeded.
//       - waiting for locator('input[type="email"], input[name="email"], …').first() to be visible
//         19 x locator resolved to hidden <input value="" name="email" type="hidden"/>
//
// It had been failing that way for every attempt, with correct credentials. THE COST IS BOTH
// HALVES OF THE REPORT: the same helper is `bot.mjs`'s auto-relogin (via
// attemptLoginWithCreds), so a saved session that drops can never be repaired, the ready
// marker goes, the app says "reconnect auto-cart for rec.gov" — and reconnecting runs THIS
// function and fails identically. One selector, a closed loop, and from the outside it reads
// as "my password is wrong".
//
// So every clause carries `:not([type="hidden"]):visible`, which makes `.first()` the first
// VISIBLE candidate rather than the first in the document. The raw selectors are kept beside
// them ONLY to census the page when nothing visible turns up — see the error messages below:
// "the modal never opened" and "the modal opened and every field is hidden" need different
// fixes and used to print the same eight-second timeout.
//
// NOTHING HERE MAY REPORT A VALUE. The census reads tag/type/name/id — markup, not user data
// — and never `.value`. This repo has published a credential twice by collecting a field it
// then had to filter (an OAuth code on 2026-08-09, a password on 2026-08-16).
//
// ================================================================================
// THE FIX WORKED AND THE FAILURE MOVED ONE STEP (2026-09-20).
//
// The email field is found and submitted now. What refuses is the step after it, straight
// off logs/broker.log on the mini-PC at 19:05 and again at 15:51:
//
//     couldn't fill the login form: no VISIBLE recreation.gov password field
//     after submitting the email. password inputs on the page: 0 match(es), 0 visible
//
// `census()` is called with PW_SEL, so it reports how many PASSWORD inputs exist (none) and
// NOTHING ABOUT WHAT IS THERE. "0 match(es), 0 visible" is equally consistent with rec.gov
// having moved to a second step we do not wait for, with a challenge interposed, with the
// email submit never taking, and with the modal having closed under us. Those need different
// fixes and today print one identical sentence — the absent-reading-as-a-negative shape, in
// the refusal written to end the previous instance of it.
//
// So the refusal NAMES THE PAGE: `pageCensusInPage` reports the visible interactive
// landscape. It still reads MARKUP — tag/type/name/id, whether a placeholder EXISTS (a
// boolean, never its text), the accessible names of buttons and links, origin+pathname, and
// the PRESENCE of error/challenge selectors by CLASS rather than by quoting a word of the
// page's own copy.
//
// THE ONE WAY A CONTROL'S LABEL CAN CARRY USER DATA is a second step that echoes the address
// back ("Continue as a@b.c"). An email-shaped token is replaced INSIDE THE PAGE, before the
// string is ever returned — not filtered on the way out, which is how both credentials above
// got out of this repo. `scripts/recgov-login-probe.mjs` proves it on a real DOM: its
// no-password fixture labels a button with the address and the probe FAILS if the address
// survives into the refusal.
// ================================================================================
import { recgovLoginState } from './session.mjs';

const EMAIL_CLAUSES = [
  'input[type="email"]', 'input[name="email"]',
  'input[autocomplete="username"]', 'input[autocomplete="email"]', 'input#email',
];
const PW_CLAUSES = [
  'input[type="password"]', 'input[name="password"]',
  'input[autocomplete="current-password"]', 'input#password',
];
/** Raw — for the census only. `.first()` on this is what resolved to a hidden input. */
const EMAIL_SEL = EMAIL_CLAUSES.join(', ');
const PW_SEL = PW_CLAUSES.join(', ');
/** What we actually act on. `:visible` is a Playwright pseudo-class, not standard CSS. */
const visibleOnly = (clauses) => clauses.map((c) => `${c}:not([type="hidden"]):visible`).join(', ');
const EMAIL_SEL_VISIBLE = visibleOnly(EMAIL_CLAUSES);
const PW_SEL_VISIBLE = visibleOnly(PW_CLAUSES);

const FIELD_TIMEOUT_MS = 6000;
// Two rounds of FIELD_TIMEOUT_MS plus the password wait has to finish inside broker.mjs's
// 30s Promise.race, or the hand-off to the streamed window loses its reason.
const OPENER_ATTEMPTS = 2;

const waitVisible = async (locator, ms) => {
  try { await locator.waitFor({ state: 'visible', timeout: ms }); return true; } catch { return false; }
};

/** Names and visibility of everything the RAW selector matches. Never values. */
async function census(page, sel) {
  const rows = await page.locator(sel).evaluateAll((els) => els.map((e) => ({
    hidden: e.getAttribute('type') === 'hidden' || !(e.offsetParent || e.getClientRects().length),
    type: e.getAttribute('type') || '',
    name: e.getAttribute('name') || '',
    id: e.id || '',
  }))).catch(() => null);
  if (!rows) return 'could not census the page';
  const shape = (r) => `${r.hidden ? 'hidden' : 'visible'} input`
    + (r.type ? `[type=${r.type}]` : '') + (r.name ? `[name=${r.name}]` : '') + (r.id ? `#${r.id}` : '');
  const visible = rows.filter((r) => !r.hidden).length;
  return `${rows.length} match(es), ${visible} visible`
    + (rows.length ? ` — ${rows.slice(0, 6).map(shape).join(', ')}` : '');
}

/* ── NAMING THE PAGE WHEN THE FIELD IS ABSENT ──────────────────────────────────────────────
 * `census()` above answers "how many of the thing I wanted are there?". These answer the
 * question that is left when that number is zero: WHAT IS THERE INSTEAD.
 *
 * Bounds, because this lands in ONE log line somebody reads while their reconnect is
 * failing — not in a dump. EVERY field is capped, not merely every list: an `id`, a `name`
 * or a pathname is as unbounded as the page that generated it, and a framework that emits
 * long generated ids would otherwise turn "one log line" into a paragraph while every list
 * cap still read as satisfied. A real page is ~330 characters; the pathological maximum the
 * caps below permit is ~1,200, which is what the guard asserts.
 */
const PAGE_MAX_INPUTS = 5;
const PAGE_MAX_CONTROLS = 6;
const PAGE_MAX_LABEL_CHARS = 24;
const PAGE_MAX_IDENT_CHARS = 24;
const PAGE_MAX_FRAME_HOSTS = 3;
const PAGE_MAX_HOST_CHARS = 40;
const PAGE_MAX_URL_CHARS = 120;

/**
 * Selectors that say "something went wrong" or "prove you are human" WITHOUT reading a word
 * of what they say. The LABEL is what gets reported; the selector is how it is found. A
 * banner's text is the page's own copy and is never quoted — presence and class is the whole
 * reading, and it is enough to tell a validation error from a challenge.
 */
const TROUBLE = [
  ['alert', '[role="alert"], [role="alertdialog"], [aria-live="assertive"]'],
  ['invalid-field', '[aria-invalid="true"]'],
  ['error-styling', '[class*="error" i], [data-testid*="error" i]'],
  ['captcha', 'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], [class*="captcha" i], #px-captcha'],
];

/**
 * The census, as it runs INSIDE the page. Exported so the guard can read it and the probe can
 * drive it; kept free of anything outside its own scope because Playwright ships it across as
 * a string.
 *
 * EVERY FIELD IS MARKUP. No `.value`, ever. `placeholder` is a BOOLEAN — whether the
 * attribute exists — because the text of a placeholder is copy, and copy on a login form is
 * the one place an address gets echoed back.
 */
export function pageCensusInPage(opts) {
  const { maxInputs, maxControls, maxLabel, maxIdent, maxHosts, maxHost, maxUrl, trouble } = opts;
  // `offsetParent` is null for a POSITION:FIXED element, which is exactly where a site puts
  // its header — so the rect is the half that catches a visible control in a fixed bar.
  const shown = (e) => !!(e.offsetParent || e.getClientRects().length);
  const clean = (s) => String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    // THE ONE WAY A LABEL CAN CARRY WHAT THE USER TYPED: a second step that echoes the
    // address back ("Continue as a@b.c"). Replaced HERE, in the page, so the address is
    // never in the string that crosses back — collected-then-filtered is the shape that
    // published an OAuth code and a password.
    .replace(/[^\s@]+@[^\s@]+/g, '[address]');
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  // Identifiers go through `clean` too. An `id` is markup rather than copy, so it is very
  // unlikely to carry an address — and "very unlikely" is the reasoning that put a password
  // in a log line once already, while running it through a replace that usually matches
  // nothing costs nothing.
  const ident = (s) => cut(clean(s), maxIdent);
  const label = (e) => {
    const by = e.getAttribute('aria-labelledby');
    let referenced = '';
    if (by) {
      for (const id of by.split(/\s+/)) {
        const t = document.getElementById(id);
        if (t) referenced += ` ${t.textContent || ''}`;
      }
    }
    return cut(clean(e.getAttribute('aria-label') || referenced || e.getAttribute('title') || e.textContent), maxLabel);
  };

  const inputs = [];
  const controls = [];
  for (const e of document.querySelectorAll('input, textarea, select')) if (shown(e)) inputs.push(e);
  for (const e of document.querySelectorAll('button, a[href], [role="button"], [role="link"]')) {
    if (shown(e)) controls.push(e);
  }

  const hosts = [];
  for (const f of document.querySelectorAll('iframe[src]')) {
    // The HOST only. A frame's URL can carry a site key or a session id in its query, and a
    // host is all that is needed to name an unrecognised challenge vendor.
    let h = '';
    try { h = new URL(f.src).host; } catch { h = ''; }
    if (h && h !== location.host && hosts.indexOf(h) === -1) hosts.push(cut(h, maxHost));
  }

  const hit = [];
  for (const pair of trouble) {
    let n = 0;
    // A selector the engine rejects is NOT "nothing wrong" — say so rather than counting 0.
    try { n = [...document.querySelectorAll(pair[1])].filter(shown).length; } catch { n = -1; }
    if (n > 0) hit.push(`${pair[0]}x${n}`);
    else if (n < 0) hit.push(`${pair[0]}=unreadable`);
  }

  return {
    // origin + pathname. NEVER the query or the fragment: a login flow puts a one-time code
    // there, and this string is written to a log file.
    url: cut(`${location.origin}${location.pathname}`, maxUrl),
    inputs: inputs.slice(0, maxInputs).map((e) => ({
      tag: e.tagName.toLowerCase(),
      type: ident(e.getAttribute('type')),
      name: ident(e.getAttribute('name')),
      id: ident(e.id),
      placeholder: e.hasAttribute('placeholder'),
    })),
    inputsTotal: inputs.length,
    // An unnamed control is still a control, so the TOTAL is counted separately from the
    // names — a page of icon buttons would otherwise read as a page with no buttons.
    names: controls.slice(0, maxControls).map(label).filter(Boolean),
    controlsTotal: controls.length,
    trouble: hit,
    hosts: hosts.slice(0, maxHosts),
  };
}

/**
 * Render it. PURE, so the readings that matter can be asserted without a browser.
 *
 * `null` is "we could not look", and it must never render as an empty page — those are
 * opposite facts and this repo's most expensive recurring error is merging them.
 */
export function describePageCensus(c) {
  if (!c) return 'could not read the page — that is no reading, not an empty page';
  const of = (shown, total) => (total > shown ? `, showing ${shown}` : '');
  const parts = [`page ${c.url}`];
  parts.push(c.inputsTotal
    ? `inputs (${c.inputsTotal}${of(c.inputs.length, c.inputsTotal)}): ` + c.inputs.map((r) => r.tag
      + (r.type ? `[type=${r.type}]` : '') + (r.name ? `[name=${r.name}]` : '')
      + (r.id ? `#${r.id}` : '') + (r.placeholder ? '(placeholder)' : '')).join(', ')
    : 'NO visible input of any kind');
  // `showing` rides the NAMES, so it is printed only when there are names to count — a page
  // of four icon buttons is "controls (4): none of them named", never "(4, showing 0)",
  // which reads as a list that was truncated to nothing rather than as a page with no
  // accessible names on it.
  parts.push(c.controlsTotal
    ? `controls (${c.controlsTotal}${c.names.length ? of(c.names.length, c.controlsTotal) : ''}): `
      + (c.names.length ? c.names.map((n) => `"${n}"`).join(', ') : 'none of them named')
    : 'NO visible button or link');
  // "none" rather than silence: this is a probe that RAN, and an absent line would read as a
  // census that did not look.
  parts.push(`trouble: ${c.trouble.length ? c.trouble.join(', ') : 'none'}`);
  if (c.hosts.length) parts.push(`third-party frames: ${c.hosts.join(', ')}`);
  return parts.join(' — ');
}

/** Take it. Never throws: a diagnostic that fails must report that, not replace the refusal. */
async function pageCensus(page) {
  const c = await page.evaluate(pageCensusInPage, {
    maxInputs: PAGE_MAX_INPUTS,
    maxControls: PAGE_MAX_CONTROLS,
    maxLabel: PAGE_MAX_LABEL_CHARS,
    maxIdent: PAGE_MAX_IDENT_CHARS,
    maxHosts: PAGE_MAX_FRAME_HOSTS,
    maxHost: PAGE_MAX_HOST_CHARS,
    maxUrl: PAGE_MAX_URL_CHARS,
    trouble: TROUBLE,
  }).catch(() => null);
  return describePageCensus(c);
}

/** Open the login modal from the header. Returns the strategy that matched, or null. */
async function clickOpener(page) {
  const strategies = [
    ['role=button', page.getByRole('button', { name: /log ?in/i }).first()],
    ['role=link', page.getByRole('link', { name: /log ?in/i }).first()],
    ['text', page.locator('button:has-text("Log In"), a:has-text("Log In")').first()],
  ];
  for (const [label, loc] of strategies) {
    if (await loc.isVisible().catch(() => false)) {
      await loc.click().catch(() => {});
      await page.waitForTimeout(1200);
      return label;
    }
  }
  return null;
}

/** Open the login modal and fill/submit email+password. Throws if the form never appears. */
export async function openLoginModalAndFill(page, email, password) {
  const em = page.locator(EMAIL_SEL_VISIBLE).first();
  const notes = [];

  // The modal may already be open (a retry, or a page that landed on it), so look before
  // clicking — clicking the header control again would TOGGLE it shut.
  let ready = await waitVisible(em, 750);
  let clicked = null;
  for (let attempt = 1; attempt <= OPENER_ATTEMPTS && !ready; attempt++) {
    if (clicked) {
      // NEVER CLICK THE OPENER TWICE. The header control TOGGLES the modal, and
      // `getByRole('button', /log ?in/i)` matches it before the modal's own "Log In"
      // in document order — so a second click on a slow-but-working modal would shut
      // the thing we are waiting for. A retry is only worth anything when the first
      // round found no control at all (a header that had not hydrated yet).
      notes.push(`attempt ${attempt}: already opened via ${clicked}, waiting longer`);
    } else {
      clicked = await clickOpener(page);
      notes.push(`opener attempt ${attempt}: ${clicked ?? 'no "Log In" control found'}`);
    }
    ready = await waitVisible(em, FIELD_TIMEOUT_MS);
  }
  if (!ready) {
    throw new Error(
      `no VISIBLE recreation.gov email field. ${notes.join('; ')}. `
      + `email inputs on the page: ${await census(page, EMAIL_SEL)}`,
    );
  }
  await em.fill(email);

  let pw = page.locator(PW_SEL_VISIBLE).first();
  if (!(await pw.isVisible().catch(() => false))) {
    // Two-step forms: submit the email, then the password field appears.
    await page.keyboard.press('Enter').catch(() => {});
    pw = page.locator(PW_SEL_VISIBLE).first();
    if (!(await waitVisible(pw, FIELD_TIMEOUT_MS + 2000))) {
      // The targeted census says the field is absent; the page census says WHAT IS THERE,
      // which is what separates "a second step we do not wait for" from "a challenge" from
      // "the submit never took" from "the modal closed". The email refusal below needs no
      // equivalent: its two cases already read differently there ("0 match(es)" is a modal
      // that never opened, "N match(es), 0 visible" is one that opened hidden).
      throw new Error(
        `no VISIBLE recreation.gov password field after submitting the email. `
        + `password inputs on the page: ${await census(page, PW_SEL)}. `
        + `${await pageCensus(page)}`,
      );
    }
  }
  await pw.fill(password);

  // Submit from INSIDE the modal/form — not the header "Log In", which would toggle it.
  const submit = page.locator(
    '[role="dialog"] button:has-text("Log In"):visible, [role="dialog"] button:has-text("Sign In"):visible, form button[type="submit"]:visible',
  ).first();
  if (await submit.isVisible().catch(() => false)) await submit.click().catch(() => {});
  else await pw.press('Enter').catch(() => {});
}

/**
 * Full headless-safe auto-relogin: land on the homepage, fill the modal, and wait for a
 * confirmed logged-in state. Returns true on success, false on any failure (form not
 * found, wrong password, CAPTCHA/2FA, or login just doesn't land within ~15s).
 */
export async function attemptLoginWithCreds(ctx, email, password) {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://www.recreation.gov/').catch(() => {});
  try {
    await openLoginModalAndFill(page, email, password);
  } catch (e) {
    // SAY WHY. This returned a bare `false` for every cause, so the one reason the
    // auto-relogin could never work — a selector that only ever matched a hidden input —
    // was invisible in bot.log for as long as it was broken.
    console.log(`  auto-relogin could not fill the rec.gov form: ${e?.message || e}`);
    return false;
  }
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    if ((await recgovLoginState(ctx)) === 'in') return true;
  }
  return false;
}
