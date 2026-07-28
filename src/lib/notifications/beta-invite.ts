import { sendEmail } from './email';

/**
 * The email a beta tester gets when they're added to the list.
 *
 * Without it, being "added as a beta tester" was silent: the row went into
 * `beta_emails` and the person was never told, so they either never signed up or
 * signed up and wondered why nothing looked different. The whole point of a beta
 * list is that someone uses it.
 *
 * WHAT IT MUST GET RIGHT: the account has to be created with THIS email address.
 * Beta access is matched on the address in the list, so signing up with a
 * different one silently lands them on the paywall — which is exactly the
 * confusing outcome this email exists to prevent. Hence the address is stated in
 * the body rather than assumed.
 *
 * No price appears anywhere: it's a free-access invite, and quoting a figure a
 * tester will never pay is just noise.
 */
export async function sendBetaInvite(email: string, appUrl: string): Promise<void> {
  const signUp = `${appUrl.replace(/\/$/, '')}/sign-up`;

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#22301f;line-height:1.55">
  <h1 style="font-size:20px;margin:0 0 14px">You're in the CampHawk beta</h1>

  <p style="margin:0 0 14px">
    CampHawk watches campgrounds that are already fully booked and texts, emails or
    pushes you within seconds of a cancellation, so you can grab the site before
    anyone else notices.
  </p>

  <p style="margin:0 0 14px">
    Your beta access is <strong>free</strong> — no card, no trial to start, nothing to cancel.
  </p>

  <p style="margin:0 0 8px"><strong>Setting up takes about two minutes:</strong></p>
  <ol style="margin:0 0 20px;padding-left:20px">
    <li style="margin-bottom:6px">
      Create your account using <strong>${email}</strong> — beta access is tied to this
      exact address, so a different one won't be recognised.
    </li>
    <li style="margin-bottom:6px">Search for somewhere you actually want to camp.</li>
    <li style="margin-bottom:6px">
      Booked solid? That's the point — press <strong>Start a watch</strong>.
    </li>
    <li style="margin-bottom:6px">
      Add your phone number in Settings if you want texts. They're the fastest way to hear.
    </li>
  </ol>

  <p style="margin:0 0 24px">
    <a href="${signUp}" style="background:#1f6b45;color:#fff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:700;display:inline-block">
      Set up your account
    </a>
  </p>

  <p style="margin:0 0 14px;font-size:14px;color:#4a5a48">
    Tell us what breaks or annoys you — that's the whole reason you're here. Just reply
    to this email, or write to alerts@camphawk.app.
  </p>

  <p style="margin:0;font-size:12px;color:#7b8a79">
    You're getting this because your address was added to the CampHawk beta list. If that
    wasn't you, ignore it — nothing has been created in your name.
  </p>
</div>`;

  await sendEmail({
    to: email,
    subject: "You're in the CampHawk beta — here's how to set it up",
    html,
  });
}
