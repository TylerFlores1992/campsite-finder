import { NextResponse } from 'next/server';

export async function GET() {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  return NextResponse.json({
    length: key.length,
    prefix: key.slice(0, 12),
    last8: key.slice(-8),
    hasLeadingWhitespace: /^\s/.test(key),
    hasTrailingWhitespace: /\s$/.test(key),
  });
}
