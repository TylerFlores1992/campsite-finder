import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { currentUserIsAdmin } from '@/lib/admin';
import { getAdminUser, type AdminUserWatch } from '../queries';

/**
 * One account, in full.
 *
 * `notFound()` and not a 403, matching /admin itself: a 404 does not reveal that the
 * page exists. The check is here in the page rather than only in middleware because
 * this route reads another user's email, watches and alert history — the kind of thing
 * that must not depend on a route pattern staying correctly enumerated.
 */

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'User — CampHawk admin',
  robots: { index: false, follow: false },
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

const fmtDateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** A watch's date span, including the flex spec when there is one. */
function watchDates(w: AdminUserWatch): string {
  const base = `${w.start_date} → ${w.end_date}`;
  if (w.flex_nights && w.flex_days) return `${base} · any ${w.flex_nights}n in ${w.flex_days}d`;
  return `${base} · ${w.min_nights}n min`;
}

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUserIsAdmin())) notFound();

  const { id } = await params;
  const detail = await getAdminUser(decodeURIComponent(id));
  if (!detail) notFound();

  const { user, watches, channels, recentAlerts, holds, favorites, pushTokens } = detail;

  return (
    <main className="mx-auto max-w-[var(--ch-max)] px-5 py-6 font-ch-body text-ch-ink">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-ch-fine font-bold text-ch-green hover:text-ch-green-deep"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" /> Back to admin
      </Link>

      <h1 className="mt-3 font-ch-display text-ch-title font-extrabold tracking-[-.02em]">
        {user.email ?? 'No email on file'}
      </h1>
      <p className="mt-1 font-mono text-ch-fine break-all text-ch-muted">{user.id}</p>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Panel title="Account">
          <Row label="Signed up" value={fmtDate(user.created_at)} />
          {/* Named "Last seen", never "Updated". syncUser bumps users.updated_at on
              every authenticated page load, which is exactly what makes it a decent
              activity proxy and a terrible settings-change timestamp — and CLAUDE.md
              records that being read the wrong way round once already. */}
          <Row label="Last seen" value={fmtDateTime(user.last_seen_at)} hint="Last authenticated page load" />
          <Row label="Finished onboarding" value={fmtDate(user.onboarded_at)} />
          <Row label="Beta tester" value={user.is_beta ? 'yes' : 'no'} />
          <Row label="Favourites" value={String(favorites)} />
          <Row label="Push tokens" value={String(pushTokens)} hint="Devices registered for push" />
        </Panel>

        <Panel title="Access">
          {/* Both lines are the SAME predicates lib/auth uses, not a reading of the
              subscriptions table — a user can hold a canceled row beside a live one. */}
          <Row label="Can create watches" value={user.subscribed ? 'yes' : 'no'} />
          <Row label="Auto-cart entitled" value={user.autocart_entitled ? 'yes' : 'no'} />
          <Row label="Subscription" value={user.sub_status ?? 'none'} />
          <Row label="Tier" value={user.sub_tier ?? '—'} />
          <Row label="Grandfathered" value={user.grandfathered ? 'yes' : 'no'} />
          {user.stripe_customer_id ? (
            <a
              href={`https://dashboard.stripe.com/customers/${user.stripe_customer_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-ch-meta font-bold text-ch-green hover:text-ch-green-deep"
            >
              Open in Stripe
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          ) : null}
        </Panel>

        <Panel title="Alerting setup">
          <Row label="Phone on file" value={user.has_phone ? 'yes' : 'no'} />
          <Row label="SMS consent" value={fmtDate(user.sms_consent_at)} />
          <Row label="Email alerts" value={user.email_alerts_opt_in ? 'on' : 'off'} />
          <Row label="Auto-cart switch" value={user.autocart_enabled ? 'on' : 'off'} />
          <Row label="Rec.gov connected" value={user.autocart_connected ? 'yes' : 'no'} />
          <Row label="Connection verified" value={fmtDate(user.autocart_verified_at)} />
        </Panel>

        <Panel title="Alerts by channel">
          {channels.length === 0 ? (
            <p className="text-ch-fine text-ch-muted">No alerts sent to this account.</p>
          ) : (
            <table className="w-full text-ch-fine">
              <thead className="text-ch-muted">
                <tr className="text-left">
                  <th className="py-1 font-medium">Channel</th>
                  <th className="py-1 text-right font-medium">Sent</th>
                  <th className="py-1 text-right font-medium">Failed</th>
                  <th className="py-1 text-right font-medium">Delivered</th>
                  <th className="py-1 text-right font-medium">Dropped</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.channel} className="border-t border-ch-line">
                    <td className="py-1.5">{c.channel}</td>
                    <td className="py-1.5 text-right">{c.sent.toLocaleString()}</td>
                    <td className="py-1.5 text-right">{c.failed || '—'}</td>
                    <td className="py-1.5 text-right">{c.delivered || '—'}</td>
                    <td className="py-1.5 text-right">{c.dropped || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {/* "Sent" is ours and "Delivered"/"Dropped" are the carrier's — two columns
              on purpose. Collapsing them destroys the only distinction that makes the
              receipt data worth storing, and SMS is the only channel that has one, so
              zeros elsewhere are "no receipt exists", not "nothing arrived". */}
          <p className="mt-2 text-ch-fine text-ch-muted">
            Sent is what we handed the provider. Delivered and dropped are carrier
            receipts, which only SMS has.
          </p>
        </Panel>
      </div>

      <Panel title={`Watches (${watches.length})`} className="mt-4">
        {watches.length === 0 ? (
          <p className="text-ch-fine text-ch-muted">No watches on this account.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-ch-fine">
              <thead className="text-ch-muted">
                <tr className="text-left">
                  <th className="py-1 font-medium">Campground</th>
                  <th className="py-1 font-medium">Dates</th>
                  <th className="py-1 font-medium">State</th>
                  <th className="py-1 text-right font-medium">Muted</th>
                </tr>
              </thead>
              <tbody>
                {watches.map((w) => (
                  <tr key={w.id} className="border-t border-ch-line align-top">
                    <td className="py-1.5 pr-3">
                      <Link
                        href={`/campground/${encodeURIComponent(w.campground_id)}`}
                        className="text-ch-green hover:text-ch-green-deep"
                      >
                        {w.campground_name ?? w.campground_id}
                      </Link>
                      <span className="block text-ch-muted">{w.source ?? 'unknown source'}</span>
                    </td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">{watchDates(w)}</td>
                    <td className="py-1.5 pr-3">
                      {/* Expired and paused are different states and the poller treats
                          them differently, so they are never merged into "inactive". */}
                      {w.expired ? 'expired' : w.active ? 'running' : 'paused'}
                      {w.auto_cart ? ' · auto-cart' : ''}
                      {w.site_type ? ` · ${w.site_type}` : ''}
                    </td>
                    <td className="py-1.5 text-right">{w.muted_count || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {holds.length > 0 && (
        <Panel title="ReserveCalifornia holds" className="mt-4">
          <table className="w-full text-ch-fine">
            <thead className="text-ch-muted">
              <tr className="text-left">
                <th className="py-1 font-medium">Campground</th>
                <th className="py-1 font-medium">Unit</th>
                <th className="py-1 font-medium">Release</th>
                <th className="py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {holds.map((h) => (
                <tr key={h.id} className="border-t border-ch-line">
                  <td className="py-1.5 pr-3">{h.campground_name ?? '—'}</td>
                  <td className="py-1.5 pr-3">{h.unit_id ?? '—'}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDateTime(h.release_at)}</td>
                  <td className="py-1.5">{h.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title="Recent alerts" className="mt-4">
        {recentAlerts.length === 0 ? (
          <p className="text-ch-fine text-ch-muted">Nothing sent yet.</p>
        ) : (
          <ul className="divide-y divide-ch-line">
            {recentAlerts.map((a, i) => (
              <li key={`${a.created_at}-${i}`} className="flex flex-wrap gap-x-3 py-1.5 text-ch-fine">
                <span className="text-ch-muted">{fmtDateTime(a.created_at)}</span>
                <span className="font-medium">{a.channel}</span>
                <span>{a.kind ?? '—'}</span>
                <span className="text-ch-muted">
                  {a.status}
                  {a.delivery_status ? ` · ${a.delivery_status}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </main>
  );
}

function Panel({
  title,
  children,
  className = '',
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card ${className}`}>
      <h2 className="mb-3 font-ch-display text-ch-h font-bold">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-ch-line py-1.5 last:border-b-0">
      <span className="text-ch-fine text-ch-muted" title={hint}>
        {label}
      </span>
      <span className="text-ch-fine font-medium">{value}</span>
    </div>
  );
}
