import { sendEmail } from './email';
import { COVERAGE, campgroundsRounded } from '@/lib/coverage';

/**
 * The email a beta tester gets when they're added to the list.
 *
 * Without it, being "added as a beta tester" was silent: the row went into
 * `beta_emails` and the person was never told, so they either never signed up or
 * signed up and wondered why nothing looked different. The whole point of a beta
 * list is that someone uses it.
 *
 * THE EVIDENCE THAT IT MATTERS (2026-08-05). Of the nine testers added between
 * 07-17 and 07-24 — before this email existed — **zero** ever signed up. Everyone
 * who did sign up was added in the first week, when they were being told in person.
 * A silent invite is not an invite.
 *
 * WHAT IT MUST GET RIGHT: the account has to be created with THIS email address.
 * Beta access is matched on the address in the list, so signing up with a
 * different one silently lands them on the paywall — which is exactly the
 * confusing outcome this email exists to prevent. Hence the address is stated in
 * the body rather than assumed, twice.
 *
 * No price appears anywhere: it's a free-access invite, and quoting a figure a
 * tester will never pay is just noise.
 *
 * STYLE CONSTRAINTS. Email clients are not browsers: no flexbox, no grid, no
 * external CSS, no web fonts. Everything here is inline styles on block elements,
 * which is the subset Gmail, Outlook and Apple Mail all render the same way.
 */
/** The body, separated from the send so it can be previewed and screenshotted
 *  without mailing a real tester. `scripts/preview-beta-invite.mts` renders it. */
export function betaInviteHtml(email: string, appUrl: string): string {
  const base = appUrl.replace(/\/$/, '');
  const signUp = `${base}/sign-up`;
  // Deliberately offered BEFORE the sign-up ask. Search is free and needs no
  // account, so the fastest way to show what this is worth is to let them look
  // something up first — a signup wall in front of an unproven product is how a
  // beta invite gets archived.
  const explore = `${base}/search`;

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto;color:#22301f;line-height:1.55">

  <p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7b8a79">CampHawk beta</p>
  <h1 style="font-size:22px;line-height:1.25;margin:0 0 14px">The campsite you wanted is booked. We wait for it to open.</h1>

  <p style="margin:0 0 14px">
    Good campgrounds sell out months ahead — then people cancel constantly. CampHawk
    watches the ones you care about <strong>every 15 seconds, around the clock</strong>, and
    tells you within seconds of a cancellation. Text, email and push, whichever reaches
    you fastest.
  </p>

  <p style="margin:0 0 20px">
    We cover <strong>${campgroundsRounded()} campgrounds</strong> — every Recreation.gov site in
    all ${COVERAGE.states} states, plus state parks in ${COVERAGE.stateParkStates} more.
  </p>

  <div style="border:1px solid #d8e2d5;background:#f4f8f2;border-radius:12px;padding:16px 18px;margin:0 0 22px">
    <p style="margin:0 0 6px;font-weight:700">Your beta access is free.</p>
    <p style="margin:0;font-size:14px;color:#4a5a48">
      No card, no trial clock, nothing to cancel. That includes the paid features —
      unlimited watches and auto-cart.
    </p>
  </div>

  <p style="margin:0 0 10px">
    <a href="${explore}" style="color:#1f6b45;font-weight:700">Have a look around first →</a>
    <span style="color:#7b8a79">&nbsp;searching is free and needs no account.</span>
  </p>

  <p style="margin:0 0 8px"><strong>When you're ready, setup takes two minutes:</strong></p>
  <ol style="margin:0 0 22px;padding-left:20px">
    <li style="margin-bottom:8px">
      Create your account with <strong>${email}</strong>. Beta access is tied to this exact
      address — a different one lands you on the paywall instead.
    </li>
    <li style="margin-bottom:8px">Search for somewhere you actually want to camp.</li>
    <li style="margin-bottom:8px">
      Fully booked? That's the point. Press <strong>Start a watch</strong> and pick your nights —
      exact dates, or &ldquo;any 2 nights in September&rdquo;.
    </li>
    <li style="margin-bottom:8px">
      Add your phone in <strong>Settings</strong>. Openings can last minutes, and a text is what
      actually wakes you up in time.
    </li>
  </ol>

  <p style="margin:0 0 26px">
    <a href="${signUp}" style="background:#1f6b45;color:#fff;text-decoration:none;padding:13px 24px;border-radius:9px;font-weight:700;display:inline-block">
      Set up your account
    </a>
  </p>

  <p style="margin:0 0 6px;font-weight:700;font-size:15px">What's worth knowing</p>
  <ul style="margin:0 0 22px;padding-left:20px;font-size:14px;color:#4a5a48">
    <li style="margin-bottom:6px">
      <strong>Flexible dates.</strong> You don't have to name exact nights — ask for any 3
      nights in a window and we'll watch the whole window.
    </li>
    <li style="margin-bottom:6px">
      <strong>Auto-cart</strong> (Recreation.gov). We can put an opening straight into your
      cart so it's held while you get to your phone.
    </li>
    <li style="margin-bottom:6px">
      <strong>One tap to stop.</strong> Every alert can pause the watch or mute a single site,
      so you're never stuck with a notification you don't want.
    </li>
  </ul>

  <p style="margin:0 0 14px;font-size:14px;color:#4a5a48">
    You're here to break it. Tell us what's confusing, slow, or wrong — reply straight to
    this email, or write to alerts@camphawk.app. Bug reports are more useful to us than
    compliments.
  </p>

  <p style="margin:0;font-size:12px;color:#7b8a79">
    You're getting this because your address was added to the CampHawk beta list. If that
    wasn't you, ignore it — nothing has been created in your name.
  </p>
</div>`;
}

export async function sendBetaInvite(email: string, appUrl: string): Promise<void> {
  await sendEmail({
    to: email,
    subject: "You're in the CampHawk beta — here's how to set it up",
    html: betaInviteHtml(email, appUrl),
  });
}
