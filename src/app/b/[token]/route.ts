import { NextResponse } from 'next/server';
import { resolveBooking } from '@/lib/notifications/actions';

// Booking short-link (feature D): 302 to the real booking URL. Lets a text carry
// camphawk.app/b/<token> instead of a long rec.gov / GoingToCamp URL.
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const url = await resolveBooking(token);
  if (!url) {
    return NextResponse.redirect(new URL('/', process.env.NEXT_PUBLIC_APP_URL || 'https://camphawk.app'));
  }
  return NextResponse.redirect(url, 302);
}
