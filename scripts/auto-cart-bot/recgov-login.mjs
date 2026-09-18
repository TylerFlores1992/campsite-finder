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
      throw new Error(
        `no VISIBLE recreation.gov password field after submitting the email. `
        + `password inputs on the page: ${await census(page, PW_SEL)}`,
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
