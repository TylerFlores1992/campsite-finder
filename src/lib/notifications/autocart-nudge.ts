import { sendEmail } from './email';

/**
 * "Finish connecting auto-cart" — sent when a user has auto-cart turned on but no
 * working rec.gov connection behind it, so their watches are silently falling back to
 * normal alerts instead of the auto-cart they turned on. Two triggers, one email (the
 * copy already covers both): `/api/auto-cart/enrollment` fires it the moment the bot
 * reports a live connection going dead, and `/api/cron/autocart-nudge` fires it the
 * morning after someone enables auto-cart and never finishes /connect at all. See
 * migration 052 for the columns that dedupe both paths.
 *
 * Reuses the wording already on AutoCartSettings/`/connect` ("encrypted, on a private
 * machine we run... never on CampHawk's web servers or database") rather than writing
 * a second description of how the connection works. Style matches beta-invite.ts, the
 * only other transactional email in this repo — same green, same inline styles (no
 * react-email here; Gmail/Outlook/Apple Mail only agree on inline styles on block
 * elements).
 */
export function autocartNudgeHtml(appUrl: string): string {
  const base = appUrl.replace(/\/$/, '');
  const connect = `${base}/connect`;

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto;color:#22301f;line-height:1.55">

  <p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7b8a79">CampHawk auto-cart</p>
  <h1 style="font-size:22px;line-height:1.25;margin:0 0 14px">Auto-cart is on, but it isn't connected yet</h1>

  <p style="margin:0 0 14px">
    Your account has auto-cart turned on for Recreation.gov, but the one-time sign-in
    that lets us actually hold a site for you was never finished — or the connection
    dropped and didn't come back. Right now, if a site you're watching opens up, we
    can only send you the normal alert. You'd still need to book it yourself, in the
    few minutes before it's gone.
  </p>

  <div style="border:1px solid #d8e2d5;background:#f4f8f2;border-radius:12px;padding:16px 18px;margin:0 0 22px">
    <p style="margin:0 0 6px;font-weight:700">Your watches are still working.</p>
    <p style="margin:0;font-size:14px;color:#4a5a48">
      This only affects auto-cart. You'll keep getting alerted the moment a site opens —
      connecting just adds the "it's already in your cart" step on top.
    </p>
  </div>

  <p style="margin:0 0 8px"><strong>Takes about a minute:</strong></p>
  <ol style="margin:0 0 22px;padding-left:20px">
    <li style="margin-bottom:8px">
      Enter your recreation.gov email and password once.
    </li>
    <li style="margin-bottom:8px">
      It's saved, <strong>encrypted, on a private machine we run</strong> — never on
      CampHawk's web servers or database — so it can sign back in on its own if the
      session ever drops again.
    </li>
    <li style="margin-bottom:8px">
      If recreation.gov asks for a security check, you'll see it live in your browser
      and can clear it yourself, right then.
    </li>
  </ol>

  <p style="margin:0 0 26px">
    <a href="${connect}" style="background:#1f6b45;color:#fff;text-decoration:none;padding:13px 24px;border-radius:9px;font-weight:700;display:inline-block">
      Finish connecting auto-cart
    </a>
  </p>

  <p style="margin:0 0 14px;font-size:14px;color:#4a5a48">
    Didn't mean to turn auto-cart on, or have a question first? Reply straight to this
    email, or write to alerts@camphawk.app.
  </p>

  <p style="margin:0;font-size:12px;color:#7b8a79">
    You're getting this because auto-cart is enabled on your CampHawk account but isn't
    currently connected. You can turn auto-cart off any time in Settings.
  </p>
</div>`;
}

export const AUTOCART_NUDGE_SUBJECT = "Auto-cart is on, but it's not connected — one minute to fix";

export async function sendAutocartNudge(email: string, appUrl: string): Promise<void> {
  await sendEmail({
    to: email,
    subject: AUTOCART_NUDGE_SUBJECT,
    html: autocartNudgeHtml(appUrl),
  });
}
