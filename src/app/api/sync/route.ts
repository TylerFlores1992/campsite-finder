import { NextRequest, NextResponse } from 'next/server';
import { runMigrations } from '@/lib/db/client';
import { syncRIDB } from '@/lib/sources/ridb/sync';

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-sync-secret');
  if (secret !== process.env.SYNC_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));

  try {
    // Run migrations first in case schema is out of date
    await runMigrations();

    const result = await syncRIDB({
      lat: body.lat,
      lng: body.lng,
      radiusMiles: body.radiusMiles ?? 300,
      maxFacilities: body.maxFacilities ?? 500,
      stateCode: body.stateCode,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[sync] Error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// Also expose a GET for quick health check (no secret needed)
export async function GET() {
  return NextResponse.json({ ok: true, message: 'POST to trigger a sync' });
}
