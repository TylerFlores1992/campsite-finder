// Email delivery via Resend (https://resend.com) — free tier: 3k emails/month.
// Set RESEND_API_KEY in .env.local to enable. Falls back to console.log in dev.

interface EmailParams {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(params: EmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    // Dev fallback — log the email instead of sending it
    console.log('[email] RESEND_API_KEY not set — would have sent:');
    console.log(`  To: ${params.to}`);
    console.log(`  Subject: ${params.subject}`);
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? 'CampHawk <alerts@camphawk.app>',
      to: [params.to],
      subject: params.subject,
      html: params.html,
    }),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => '');
    throw new Error(`Resend error ${response.status}: ${error}`);
  }
}
