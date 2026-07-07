import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db/client';

// The poller beats every ~15s; 5 minutes of silence means it's down or wedged.
const STALE_AFTER_MS = 5 * 60 * 1000;

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const row = await queryOne<{ beat_at: string; watches_checked: number }>(
      `SELECT beat_at::text, watches_checked FROM worker_heartbeat WHERE id = 1`
    );

    if (!row) {
      return NextResponse.json({ ok: false, error: 'no heartbeat row' }, { status: 503 });
    }

    const ageMs = Date.now() - new Date(row.beat_at).getTime();
    const stale = ageMs > STALE_AFTER_MS;

    return NextResponse.json(
      {
        ok: !stale,
        lastBeat: row.beat_at,
        ageSeconds: Math.round(ageMs / 1000),
        watchesChecked: row.watches_checked,
      },
      { status: stale ? 503 : 200 }
    );
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
