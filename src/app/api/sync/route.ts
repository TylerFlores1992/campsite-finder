import { NextRequest, NextResponse } from 'next/server';
import { syncRIDB } from '@/lib/sources/ridb/sync';

export async function POST(request: NextRequest) {
  // Accept secret via header OR body.secret
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const secret = (request.headers.get('x-sync-secret') ?? body.secret) as string | null;

  if (secret !== process.env.SYNC_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await syncRIDB({
      lat: body.lat as number | undefined,
      lng: body.lng as number | undefined,
      radiusMiles: (body.radiusMiles as number) ?? 300,
      maxFacilities: (body.maxFacilities as number) ?? 500,
      stateCode: body.stateCode as string | undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[sync] Error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: 'POST to trigger a sync' });
}
