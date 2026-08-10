'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import Logo from '@/components/Logo';
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
  // Guards a double submit WITHOUT making the control unclickable — see the form below.
  const submitted = useRef(false);

  if (preview.alreadyRequested) {
    return (
      <Shell>
        <HomeMark />
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
      <HomeMark />
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

      {/*
        NEVER `disabled={busy}` ON A SUBMIT BUTTON WHOSE onClick SETS `busy`.

        That is what this was, and it meant the button could not submit AT ALL: React
        flushes state from a discrete click synchronously, so the re-render disabled the
        button BEFORE the browser performed the form's default submit action — and a
        disabled submit button cancels the submission. The spinner appeared, nothing was
        sent, and it span forever. Reported on both the app and mobile web 2026-08-09, on
        the one action the whole 8am flow depends on.

        The endpoint was healthy throughout (400 and 303 in ~0.5s from curl), which is why
        this looked like a server or network fault and was not one.

        So: busy is set in the form's onSubmit, by which point the submission is already
        in flight, and double-submits are stopped by a ref rather than by making the
        control unclickable.
      */}
      <form
        method="POST"
        action="/api/w/hold"
        className="w-full"
        onSubmit={(e) => {
          if (submitted.current) { e.preventDefault(); return; }
          submitted.current = true;
          setBusy(true);
        }}
      >
        <input type="hidden" name="token" value={preview.token} />
        <button
          type="submit"
          aria-busy={busy}
          className={`mt-4 w-full rounded-xl bg-ch-green-deep px-6 py-4 text-lg font-bold text-white ${busy ? 'opacity-60' : ''}`}
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

/**
 * THE WAY OUT. This screen is reached from an email or a push notification, so it is
 * often the first and only CampHawk page open — and it had no navigation at all: no nav
 * bar (it is outside the (app) route group), no back target, nothing to tap. A decorative
 * tent sat where every other page in the product puts the brand mark.
 *
 * The mark doubles as the exit, which is the convention the rest of the app already uses
 * (/sources, /not-found). Deliberately NOT a browser-back link: arriving from a push
 * notification there is no history to go back to.
 */
function HomeMark() {
  return (
    <Link href="/" aria-label="CampHawk home" className="mb-1 inline-block">
      <Logo markSize={36} />
    </Link>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
      {children}
    </main>
  );
}
