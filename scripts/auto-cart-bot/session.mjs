// Reliable recreation.gov login detection, shared by the bot and the broker.
//
// The old check watched the URL ("/account/profile stays put when logged in,
// bounces to /sign-in when out"). That is WRONG: rec.gov signs you in through a
// MODAL, so the URL never becomes /sign-in — a logged-out browser sits on
// /account/profile showing a login prompt, and the URL check falsely reports
// "logged in." That let the bot cart while signed out (rec.gov silently no-ops)
// and let the keepalive report a dead session as warm.
//
// The trustworthy DOM signal: the header shows a "Sign Up or Log In" button ONLY
// when logged out; once you're in, it's replaced by the account menu. So the
// presence of that button = logged out, its absence (on a loaded page) = logged in.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The exact header CTA rec.gov shows when logged out (a few label variants).
const LOGIN_LABELS = /^(log\s?in|sign\s?in|sign\s?up or log\s?in|log\s?in or sign\s?up|sign\s?up \/ log\s?in)$/i;

// Returns 'in' | 'out' | 'unknown'. 'unknown' only when the page didn't load, so
// callers can avoid acting on a transient failure (e.g. don't clear a login on it).
export async function recgovLoginState(ctx) {
  let p;
  try {
    p = await ctx.newPage();
    await p.goto('https://www.recreation.gov/account/profile', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(3500); // let the SPA render the header (login button vs account menu)
    const u = (p.url() || '').toLowerCase();
    if (/\/sign-?in|\/login/.test(u)) return 'out';
    return await p.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const labels = Array.from(document.querySelectorAll('button, a')).map((e) => (e.textContent || '').trim());
      if (!labels.length) return 'unknown';
      return labels.some((t) => re.test(t)) ? 'out' : 'in';
    }, LOGIN_LABELS.source);
  } catch {
    return 'unknown';
  } finally {
    if (p) await p.close().catch(() => {});
  }
}
