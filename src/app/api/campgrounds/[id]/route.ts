import { NextRequest, NextResponse } from 'next/server';
import { ridbSource } from '@/lib/sources/ridb';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const campground = await ridbSource.getDetail(id);
    if (!campground) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const campsites = await ridbSource.getCampsites(id);
    return NextResponse.json({ campground, campsites });
  } catch (err) {
    console.error('[campground detail] Error:', err);
    return NextResponse.json({ error: 'Failed to fetch campground' }, { status: 500 });
  }
}
