// SMS delivery via Twilio. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_FROM_NUMBER in .env.local to enable.

interface SmsParams {
  to: string;
  body: string;
}

export async function sendSms(params: SmsParams): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !from) {
    console.log('[sms] Twilio not configured — would have sent:');
    console.log(`  To: ${params.to}`);
    console.log(`  Body: ${params.body}`);
    return;
  }

  if (!params.to) {
    console.log('[sms] No destination number — skipping');
    return;
  }

  const body = new URLSearchParams({ To: params.to, From: from, Body: params.body });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    }
  );

  if (!response.ok) {
    const error = await response.text().catch(() => '');
    throw new Error(`Twilio error ${response.status}: ${error}`);
  }
}
