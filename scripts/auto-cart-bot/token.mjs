import crypto from 'node:crypto';

// Verify the short-lived connect tokens CampHawk mints (see src/lib/autocart-token.ts).
// Same HMAC-SHA256 scheme, same secret (AUTOCART_TOKEN), so the broker can trust a
// token without any extra key exchange. Returns the userId or null.

const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function verifyConnectToken(token, secret) {
  try {
    const [payloadB64, sig] = String(token).split('.');
    if (!payloadB64 || !sig) return null;
    const expected = b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(unb64url(payloadB64).toString('utf8'));
    if (!payload?.uid || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload.uid;
  } catch {
    return null;
  }
}
