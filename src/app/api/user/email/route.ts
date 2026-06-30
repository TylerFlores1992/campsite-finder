import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/client';

export async function POST(request: NextRequest) {
  const userId = request.headers.get('x-user-id');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  const { email } = await request.json();
  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
  }

  await query(
    `INSERT INTO users (id, email) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [userId, email.toLowerCase().trim()]
  );

  return NextResponse.json({ ok: true });
}
