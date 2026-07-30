import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@clerk/nextjs/server';
import { query, mutate } from '@/lib/db/client';
import { BILLING_PERIODS, COST_CATEGORIES, type CostItem } from '@/lib/costs';
import { isAdminEmail } from '@/lib/admin';

export const dynamic = 'force-dynamic';


// 404 (not 403) for non-admins so the endpoint's existence isn't revealed.
async function requireAdmin(): Promise<boolean> {
  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress?.toLowerCase();
  return isAdminEmail(email);
}

const notFound = () => NextResponse.json({ error: 'not found' }, { status: 404 });

async function listItems(): Promise<CostItem[]> {
  return query<CostItem>(
    `SELECT id, label, category, amount_cents, billing_period, notes, sort_order, started_at::text, ended_at::text
       FROM cost_items ORDER BY sort_order, label`
  );
}

export async function GET() {
  if (!(await requireAdmin())) return notFound();
  return NextResponse.json({ items: await listItems() });
}

// Create (no id) or update (with id) a single line item.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return notFound();
  const body = await req.json().catch(() => ({}));

  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) return NextResponse.json({ error: 'label required' }, { status: 400 });

  const category = COST_CATEGORIES.includes(body.category) ? body.category : 'other';
  // amount_cents is the billed amount, NOT a monthly figure — see lib/costs.ts.
  const cents = Math.max(0, Math.round(Number(body.amount_cents) || 0));
  const period = BILLING_PERIODS.includes(body.billing_period) ? body.billing_period : 'monthly';
  const notes = typeof body.notes === 'string' ? body.notes.trim() : null;
  const sortOrder = Math.round(Number(body.sort_order) || 0);
  // Dates are optional and stay NULL when blank — an unknown start date must remain
  // unknown rather than becoming today, which would invent lifetime spend. Anything
  // that isn't a plain YYYY-MM-DD is treated as absent rather than passed to Postgres.
  const asDate = (v: unknown): string | null =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
  const startedAt = asDate(body.started_at);
  const endedAt = asDate(body.ended_at);

  if (body.id) {
    const [row] = await mutate<CostItem>(
      `UPDATE cost_items
          SET label = $1, category = $2, amount_cents = $3, billing_period = $4,
              notes = $5, sort_order = $6, started_at = $7, ended_at = $8, updated_at = NOW()
        WHERE id = $9
        RETURNING id, label, category, amount_cents, billing_period, notes, sort_order, started_at::text, ended_at::text`,
      [label, category, cents, period, notes, sortOrder, startedAt, endedAt, body.id]
    );
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ item: row });
  }

  const [row] = await mutate<CostItem>(
    `INSERT INTO cost_items (label, category, amount_cents, billing_period, notes, sort_order, started_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, label, category, amount_cents, billing_period, notes, sort_order, started_at::text, ended_at::text`,
    [label, category, cents, period, notes, sortOrder, startedAt, endedAt]
  );
  return NextResponse.json({ item: row });
}

export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin())) return notFound();
  const { id } = await req.json().catch(() => ({}));
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await mutate(`DELETE FROM cost_items WHERE id = $1`, [id]);
  return NextResponse.json({ ok: true });
}
