'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { StatusMark, type Level } from '@/components/admin/status-mark';
// Values from the PURE module only. `subscribers.ts` pulls in the database client and
// Stripe, so from there this file takes types and nothing else.
import { SUBSCRIBER_GROUPS, sourceLabel, type SubscriberGroup } from '@/app/admin/users/subscriber-group';
import type { Subscriber, SubscribersData } from '@/app/admin/users/subscribers';

/**
 * Every subscriber — current, trialing, cancelling and lapsed — one row per person.
 *
 * Each state carries a SHAPE and a WORD through `StatusMark` (the owner is colour-blind):
 * a tick for Active/Trialing, a triangle for Cancelling, a cross for Lapsed, with the
 * word always printed. Lapsed prints the real status (`canceled`, `expired`, `past_due`)
 * rather than one catch-all, because those call for different replies.
 *
 * The interval, renewal date and trial end exist ONLY in Stripe. When Stripe could not
 * be read, or the row is a store purchase, they say "unknown" — never a dash that reads
 * as "does not renew".
 */

const GROUP_LEVEL: Record<SubscriberGroup, Level> = {
  active: 'ok',
  trialing: 'ok',
  cancelling: 'warn',
  lapsed: 'fail',
};

/** Pacific, like every other date on the admin page — Vercel runs UTC. */
const PACIFIC_DAY: Intl.DateTimeFormatOptions = {
  timeZone: 'America/Los_Angeles',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
};

function day(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', PACIFIC_DAY);
}

function statusWord(s: Subscriber): string {
  if (s.group !== 'lapsed') return SUBSCRIBER_GROUPS.find((g) => g.key === s.group)!.label;
  const w = s.status.replace(/_/g, ' ');
  return `Lapsed · ${w}`;
}

function planLabel(s: Subscriber): string {
  const tier = s.tier === 'autocart' ? 'Auto-Cart' : s.tier === 'base' ? 'Alerts' : s.tier;
  const ivl = s.stripe?.interval;
  const interval =
    ivl === 'monthly' ? 'monthly' : ivl === 'yearly' ? 'yearly' : ivl === 'other' ? 'other interval' : 'interval unknown';
  return `${tier} · ${interval}`;
}

/**
 * The date that matters for this row, worded for its state. A missing Stripe answer is
 * "unknown", said out loud; a cancellation with no date still says it is ending.
 */
function keyDate(s: Subscriber): string {
  const f = s.stripe;
  if (s.group === 'cancelling') {
    const d = day(s.cancel_at) ?? day(f?.cancel_at) ?? day(f?.current_period_end);
    return d ? `Ends ${d}` : 'Ending — no date recorded';
  }
  if (s.group === 'lapsed') {
    const d = day(f?.ended_at) ?? day(f?.canceled_at);
    return d ? `Ended ${d}` : `Last updated ${day(s.updated_at) ?? 'unknown'}`;
  }
  const renews = day(f?.current_period_end);
  return renews ? `Renews ${renews}` : 'Renewal date unknown';
}

function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="rounded-full border border-ch-line bg-ch-paper px-2 py-0.5 text-[11px] font-medium text-ch-muted"
    >
      {children}
    </span>
  );
}

export default function SubscribersBox({ data }: { data: SubscribersData }) {
  const [filter, setFilter] = useState<SubscriberGroup | 'all'>('all');
  const shown = filter === 'all' ? data.rows : data.rows.filter((r) => r.group === filter);
  const total = data.rows.length;

  const stripeNote =
    data.stripe_state === 'ok' || data.db_failed
      ? null
      : data.stripe_state === 'unconfigured'
        ? 'Stripe is not configured here, so interval, renewal and trial dates are unknown.'
        : 'Stripe could not be read just now, so interval, renewal and trial dates are unknown. The groups below are from our database and are unaffected.';

  return (
    <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-ch-display text-ch-h font-bold">Subscribers</h2>
        <span className="text-ch-fine text-ch-muted">{total} with a subscription on record</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter subscribers">
        {([['all', 'All', total]] as Array<[SubscriberGroup | 'all', string, number]>)
          .concat(SUBSCRIBER_GROUPS.map((g) => [g.key, g.label, data.counts[g.key]]))
          .map(([key, label, n]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={`rounded-lg border px-2.5 py-1.5 text-ch-fine font-medium transition-colors ${
                filter === key
                  ? 'border-ch-green bg-ch-green text-white'
                  : 'border-ch-line text-ch-muted hover:text-ch-ink'
              }`}
            >
              {label} {n}
            </button>
          ))}
      </div>

      {stripeNote ? (
        <p className="mb-3 rounded-ch-sm border border-ch-line bg-ch-paper px-3 py-2 text-ch-fine text-ch-muted">
          {stripeNote}
        </p>
      ) : null}

      {data.db_failed ? (
        <p className="py-2 text-ch-fine text-ch-muted">
          <StatusMark level="fail" label="Could not read subscriptions" /> — the query failed
          (logged on the server). This is not the same as having none.
        </p>
      ) : shown.length === 0 ? (
        <p className="py-2 text-ch-fine text-ch-muted">
          {total === 0 ? 'No subscriptions on record.' : 'Nobody in this group.'}
        </p>
      ) : (
        <ul className="divide-y divide-ch-line">
          {shown.map((s) => (
            <li key={s.user_id}>
              <Link
                href={`/admin/users/${encodeURIComponent(s.user_id)}`}
                className="flex items-center gap-3 py-2.5 hover:bg-ch-green-soft/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="min-w-0 truncate text-ch-body text-ch-ink">
                      {s.email ?? <span className="text-ch-faint">no email on file</span>}
                    </span>
                    <span className="text-ch-fine">
                      <StatusMark level={GROUP_LEVEL[s.group]} label={statusWord(s)} />
                    </span>
                  </span>
                  <span className="mt-0.5 block text-ch-fine text-ch-muted">
                    {planLabel(s)} · {sourceLabel(s.provider)}
                  </span>
                  <span className="mt-0.5 block text-ch-fine text-ch-muted">
                    Started {day(s.started_at) ?? 'unknown'} · {keyDate(s)}
                    {s.stripe?.trial_end ? ` · trial ends ${day(s.stripe.trial_end)}` : ''}
                    {s.stripe && !s.stripe.found ? ' · not returned by Stripe' : ''}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {s.autocart_entitled ? <Chip title="Per lib/auth.hasAutocartEntitlement">Auto-Cart entitled</Chip> : null}
                    {s.grandfathered ? <Chip>Grandfathered</Chip> : null}
                    {s.is_beta ? <Chip>Beta</Chip> : null}
                    {s.autocart_trial_until ? (
                      <Chip title="Comped Auto-Cart trial (autocart_trial_until)">
                        {new Date(s.autocart_trial_until) > new Date() ? 'Comp trial until' : 'Comp trial ended'}{' '}
                        {day(s.autocart_trial_until)}
                      </Chip>
                    ) : null}
                    {s.rc_hold_beta ? <Chip title="On the RC hold beta allowlist">RC hold beta</Chip> : null}
                    {s.other_rows > 0 ? (
                      <Chip>
                        +{s.other_rows} older subscription{s.other_rows === 1 ? '' : 's'}
                      </Chip>
                    ) : null}
                  </span>
                </span>
                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ch-faint" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-ch-fine text-ch-muted">
        One row per person, using their live subscription when they have one. Cancelling
        means either of Stripe&rsquo;s cancel fields is set on a live row; those people are
        still paying until the end date. Beta testers without a subscription are not
        listed here (see Users).
      </p>
    </div>
  );
}
