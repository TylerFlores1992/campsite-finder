import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// TEMPORARY probe: can Vercel's datacenter IPs reach ReserveAmerica? Gated by the
// sync secret. Delete after we read the result.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('secret') !== process.env.SYNC_SECRET) {
    return NextResponse.json({ error: 'nope' }, { status: 404 });
  }
  const host = 'newyorkstateparks.reserveamerica.com';
  const out: Record<string, unknown> = {};
  try {
    const land = await fetch(`https://${host}/`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    const cookie = ((land.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0]).join('; ');
    out.landing = land.status;
    const arr = new Date(Date.now() + 12 * 864e5);
    const cal = `${arr.getUTCMonth() + 1}/${arr.getUTCDate()}/${arr.getUTCFullYear()}`;
    const mat = await fetch(
      `https://${host}/campsiteCalendar.do?page=matrix&contractCode=NY&parkId=404&calarvdate=${encodeURIComponent(cal)}&sitepage=true`,
      { headers: { 'User-Agent': UA, Accept: 'text/html', Cookie: cookie } }
    );
    const body = await mat.text();
    out.matrix = mat.status;
    out.hasSummary = /\d+\s*site\(s\)\s*available\s*out of/i.test(body);
    out.bodyLen = body.length;
  } catch (e) {
    out.error = (e as Error).message;
  }
  return NextResponse.json(out);
}
