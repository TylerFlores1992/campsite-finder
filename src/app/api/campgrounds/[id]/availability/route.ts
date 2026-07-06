import { NextRequest, NextResponse } from 'next/server';
import { ridbSource } from '@/lib/sources/ridb';
import { getRCAvailabilityForMonth } from '@/lib/availability/reservecalifornia';
import { isRcCampgroundId } from '@/lib/sources/reservecalifornia/client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const month =
    request.nextUrl.searchParams.get('month') ??
    new Date().toISOString().slice(0, 7); // default to current month

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });
  }

  try {
    const availability = isRcCampgroundId(id)
      ? await getRCAvailabilityForMonth(id, month)
      : await ridbSource.getAvailability(id, month);
    return NextResponse.json(availability);
  } catch (err) {
    console.error('[availability] Error:', err);
    return NextResponse.json({ error: 'Failed to fetch availability' }, { status: 500 });
  }
}
