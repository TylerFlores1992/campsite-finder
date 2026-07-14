import crypto from 'node:crypto';

// Short-lived, HMAC-signed "connect" tokens for the remote rec.gov sign-in flow.
// Signed with AUTOCART_TOKEN — the same master secret the mini-PC bot already
// holds — so the broker can verify a token with zero extra key management.
//
// A token proves "the CampHawk app vouched that this browser is <userId>, until
// <exp>". The broker trusts it to stream ONLY that user's login browser. Tokens
// are minted only for the logged-in Clerk user (see /api/user/connect-token) and
// live ~5 minutes, so a leaked one is near-useless.

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(payloadB64: string, secret: string) {
  return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

export function mintConnectToken(userId: string, secret: string, ttlMs = 5 * 60 * 1000) {
  const payload = { uid: userId, exp: Date.now() + ttlMs };
  const payloadB64 = b64url(JSON.stringify(payload));
  return { token: `${payloadB64}.${sign(payloadB64, secret)}`, expiresAt: payload.exp };
}

// Returns the userId if the token is authentic and unexpired, else null.
export function verifyConnectToken(token: string, secret: string): string | null {
  try {
    const [payloadB64, sig] = String(token).split('.');
    if (!payloadB64 || !sig) return null;
    const expected = sign(payloadB64, secret);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(unb64url(payloadB64).toString('utf8'));
    if (!payload?.uid || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload.uid as string;
  } catch {
    return null;
  }
}
