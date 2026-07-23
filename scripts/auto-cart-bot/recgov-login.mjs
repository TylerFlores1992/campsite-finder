// Shared recreation.gov login automation, used by BOTH the remote broker (broker.mjs,
// when the user submits credentials) and the bot's auto-relogin (bot.mjs, when a saved
// session dies). rec.gov has no /sign-in page — login is a MODAL opened from the header
// "Sign Up / Log In" — so we open that, fill, and submit. Best-effort selectors; callers
// fall back to a manual/streamed sign-in when this can't complete (e.g. CAPTCHA / 2FA).
import { recgovLoginState } from './session.mjs';

const EMAIL_SEL =
  'input[type="email"], input[name="email"], input[autocomplete="username"], input[autocomplete="email"], input#email';
const PW_SEL =
  'input[type="password"], input[name="password"], input[autocomplete="current-password"], input#password';

/** Open the login modal and fill/submit email+password. Throws if the form never appears. */
export async function openLoginModalAndFill(page, email, password) {
  // Open the modal from the header (button, then link, then a text match).
  let opener = page.getByRole('button', { name: /log ?in/i }).first();
  if (!(await opener.isVisible().catch(() => false))) opener = page.getByRole('link', { name: /log ?in/i }).first();
  if (!(await opener.isVisible().catch(() => false))) opener = page.locator('button:has-text("Log In"), a:has-text("Log In")').first();
  if (await opener.isVisible().catch(() => false)) { await opener.click().catch(() => {}); await page.waitForTimeout(1500); }

  const em = page.locator(EMAIL_SEL).first();
  await em.waitFor({ state: 'visible', timeout: 8000 });
  await em.fill(email);

  let pw = page.locator(PW_SEL).first();
  if (!(await pw.isVisible().catch(() => false))) {
    // Two-step forms: submit the email, then the password field appears.
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1200);
    pw = page.locator(PW_SEL).first();
    await pw.waitFor({ state: 'visible', timeout: 8000 });
  }
  await pw.fill(password);

  // Submit from INSIDE the modal/form — not the header "Log In", which would toggle it.
  const submit = page.locator('[role="dialog"] button:has-text("Log In"), [role="dialog"] button:has-text("Sign In"), form button[type="submit"]').first();
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
  } catch {
    return false;
  }
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    if ((await recgovLoginState(ctx)) === 'in') return true;
  }
  return false;
}
