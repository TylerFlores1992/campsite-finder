'use client';

import { useState } from 'react';
import { Check, ExternalLink, Loader2, Tent } from 'lucide-react';
import { formatStayDates } from '@/lib/notifications/dates';
import type { HoldPreview } from '@/lib/notifications/actions';

/**
 * "Do you want THIS one?" — the confirm step before a hold is booked.
 *
 * The alert link used to hold the site the instant it was tapped. On a push notification
 * that means the decision was made before the owner had seen the campground, the site
 * number, the nights or the release time. This screen shows all four and a way to go and
 * LOOK at the site on the provider first, because "site #SC29" means nothing until you
 * have seen where it is.
 *
 * WHY A FORM POST AND NOT A LINK. The hold is the one alert action that cannot be undone
 * — it commits the bot to taking a real site off the market at 08:00. A GET can be fired
 * by an email scanner or a link preview with nobody involved; a POST cannot. Same reason
 * the parent route special-cases this action and leaves the reversible ones one-tap.
 *
 * The "open on ReserveCalifornia" link is deliberately a NEW TAB: this page's URL carries
 * the only token that authorises the hold, so navigating away loses it.
 */
export default function HoldConfirm({ preview }: { preview: HoldPreview }) {
  const [busy, setBusy] = useState(false);

  if (preview.alreadyRequested) {
    return (
      <Shell>
        <Check className="text-ch-green-deep" size={32} />
        <h1 className="mt-3 text-xl font-bold text-ch-ink">You&rsquo;re already down for this one</h1>
        <p className="mt-2 text-ch-muted">
          {preview.unitLabel} at {preview.campgroundName} — we&rsquo;ll grab it at{' '}
          {formatRelease(preview.releaseAt)}. Tapping again changes nothing.
        </p>
        <p className="mt-4 text-sm text-ch-muted">
          You&rsquo;ll get an alert the moment it&rsquo;s in the cart, with a link to take it.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <Tent className="text-ch-green-deep" size={32} />
      <h1 className="mt-3 text-xl font-bold text-ch-ink">Hold this site for you?</h1>

      {/* The four facts the decision needs, at a size they can be read at on a phone. */}
      <dl className="mt-5 w-full rounded-xl border border-ch-line text-left">
        <Row label="Campground" value={preview.campgroundName ?? 'this campground'} />
        <Row label="Site" value={preview.unitLabel} strong />
        <Row label="Nights" value={stayLabel(preview.arrivalDate, preview.nights)} />
        <Row label="Releases" value={`${formatRelease(preview.releaseAt)} PT`} last />
      </dl>

      {preview.bookingUrl && (
        <a
          href={preview.bookingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-ch-green-deep underline"
        >
          Look at {preview.unitLabel} on ReserveCalifornia
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      )}

      <p className="mt-5 text-sm text-ch-ink">
        If you say yes, our bot carts this exact site the second it opens and holds it
        until you claim it. Only say yes if you actually want it — while we&rsquo;re
        holding it, nobody else can book it.
      </p>

      <form method="POST" action="/api/w/hold" className="w-full">
        <input type="hidden" name="token" value={preview.token} />
        <button
          type="submit"
          disabled={busy}
          onClick={() => setBusy(true)}
          className="mt-4 w-full rounded-xl bg-ch-green-deep px-6 py-4 text-lg font-bold text-white disabled:opacity-60"
        >
          {busy ? <Loader2 className="mx-auto animate-spin" size={20} /> : 'Yes — hold it for me'}
        </button>
      </form>

      <p className="mt-3 text-sm text-ch-muted">
        Do nothing and we won&rsquo;t hold it. You&rsquo;ll still get the normal alert when
        it opens.
      </p>
    </Shell>
  );
}

function Row({ label, value, strong, last }: { label: string; value: string; strong?: boolean; last?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 px-4 py-3 ${last ? '' : 'border-b border-ch-line'}`}>
      <dt className="shrink-0 text-ch-fine font-bold tracking-[.08em] text-ch-muted uppercase">{label}</dt>
      <dd className={`text-right ${strong ? 'text-lg font-bold text-ch-ink' : 'text-ch-ink'}`}>{value}</dd>
    </div>
  );
}

/**
 * "Sep 4 · 1 night". Dates are stepped in UTC and re-serialised, never `new Date(iso)`
 * plus local arithmetic — a bare date parses as midnight UTC and renders a day early for
 * everyone west of Greenwich, which on this screen would name the wrong night.
 */
function stayLabel(arrival: string, nights: number): string {
  const n = Math.max(1, nights || 1);
  const start = Date.parse(`${arrival}T00:00:00Z`);
  if (Number.isNaN(start)) return arrival;
  const dates = Array.from({ length: n }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
  return `${formatStayDates(dates)} · ${n} night${n === 1 ? '' : 's'}`;
}

/** RC's `release_at` is zone-less Pacific wall-clock. Sliced, never parsed — parsing it
 *  into a Date reinterprets it in the viewer's zone and shifts the hour. */
function formatRelease(releaseAt: string): string {
  const [date, time] = releaseAt.split('T');
  const hhmm = (time ?? '').slice(0, 5);
  const [y, m, d] = (date ?? '').split('-').map(Number);
  if (!y || !m || !d) return releaseAt;
  const label = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  return `${label} at ${hhmm}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
      {children}
    </main>
  );
}
