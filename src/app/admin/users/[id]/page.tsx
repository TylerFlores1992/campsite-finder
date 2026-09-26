import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { currentUserIsAdmin } from '@/lib/admin';
import { hasAutocartEntitlement } from '@/lib/auth';
import { RC_HOLD_BETA_OPEN, rcHoldBetaAllows } from '@/lib/autocart-beta';
import { describeHoldOutcome, holdOutcome, type HoldOutcome } from '@/lib/hold-outcome';
import { StatusMark, type Level } from '@/components/admin/status-mark';
import { getAdminUser, type AdminUserWatch } from '../queries';
import { getSubscriptionHistory, sourceLabel, type SubscriberGroup, type SubscriptionHistory } from '../subscribers';

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

/** Pacific day, for subscription and billing dates — Vercel runs UTC, and a date off by
 *  one is worse than none because it looks like an answer. */
const fmtPacific = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

const GROUP_MARK: Record<SubscriberGroup, { level: Level; word: string }> = {
  active: { level: 'ok', word: 'Active' },
  trialing: { level: 'ok', word: 'Trialing' },
  cancelling: { level: 'warn', word: 'Cancelling' },
  lapsed: { level: 'fail', word: 'Lapsed' },
};

/** `unresolved` is its OWN mark and word — never rounded to a win or a loss. */
const OUTCOME_MARK: Partial<Record<HoldOutcome, { level: Level; word: string }>> = {
  claimed: { level: 'ok', word: 'Claimed' },
  'client-carted': { level: 'ok', word: 'Carted by user' },
  'client-failed': { level: 'fail', word: 'Lost' },
  unresolved: { level: 'warn', word: 'Unresolved' },
};

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

  // Entitlement through lib/auth ITSELF, not a restatement: this is the function the
  // toggle API, the roster feed and the hold action call, so the page cannot disagree
  // with them. null = the read failed, which renders as unknown and never as "no".
  const [history, entitled] = await Promise.all([
    getSubscriptionHistory(user.id).catch((err): SubscriptionHistory | null => {
      console.error('[admin/user] subscription history failed', err);
      return null;
    }),
    hasAutocartEntitlement(user.id).catch((err): boolean | null => {
      console.error('[admin/user] entitlement read failed', err);
      return null;
    }),
  ]);
  const trialLive = !!user.autocart_trial_until && new Date(user.autocart_trial_until) > new Date();
  const liveRows = history?.rows.filter((r) => r.group !== 'lapsed') ?? [];
  const entitlementReasons = [
    user.is_beta ? 'beta flag' : null,
    trialLive ? `comped trial until ${fmtPacific(user.autocart_trial_until)}` : null,
    liveRows.some((r) => r.tier === 'autocart') ? 'live Auto-Cart subscription' : null,
    liveRows.some((r) => r.grandfathered) ? 'grandfathered live subscription' : null,
  ].filter(Boolean);
  const storeRow = history?.rows.find((r) => r.provider === 'apple' || r.provider === 'google');

  return (
    <main
      // SAFE-AREA INSET. This screen is outside the (app) route group, so V2Nav —
      // where every other screen's status-bar handling lives — never runs. Android 16
      // IGNORES Capacitor's `overlaysWebView: false`, so the webview draws under the
      // status bar and the control below lands in it, where taps go to the system and
      // not to the page. Resolves to 0px on the web, so nothing outside the app moves.
      // Rule and full mechanism: src/lib/safe-area-top.test.mts.
      style={{ paddingTop: "calc(env(safe-area-inset-top) + 1.5rem)" }}
      className="mx-auto max-w-[var(--ch-max)] px-5 pb-6 font-ch-body text-ch-ink"
    >
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
          <Row label="Favorites" value={String(favorites)} />
          <Row label="Push tokens" value={String(pushTokens)} hint="Devices registered for push" />
        </Panel>

        <Panel title="Access">
          {/* Both lines are the SAME predicates lib/auth uses, not a reading of the
              subscriptions table — a user can hold a canceled row beside a live one. */}
          <Row label="Can create watches" value={user.subscribed ? 'yes' : 'no'} />
          <Row label="Auto-cart entitled" value={user.autocart_entitled ? 'yes' : 'no'} />
          <Row label="Subscription" value={user.sub_status ?? 'none'} />
          <Row label="Tier" value={user.sub_tier ?? '—'} />
          {/* A cancelling subscriber reads `active` on the line above, with full
              entitlement, until the day it ends — so this row is the only thing on the
              panel that can show a churn in progress. A missing date still renders,
              because the flag is what says a cancellation is scheduled and hiding the
              row for want of a date would hide the churn itself. */}
          {user.cancelling ? (
            <Row
              label="Cancels"
              value={
                user.cancel_at
                  ? new Date(user.cancel_at).toLocaleDateString('en-US', {
                      timeZone: 'America/Los_Angeles',
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })
                  : 'scheduled — Stripe gave no date'
              }
            />
          ) : null}
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

      <Panel title="Subscription & entitlement" className="mt-4">
        <div className="grid gap-x-6 md:grid-cols-2">
          <div>
            <Row
              label="Auto-Cart entitled"
              value={entitled === null ? 'unknown — read failed' : entitled ? 'yes' : 'no'}
              hint="lib/auth.hasAutocartEntitlement, called live"
            />
            <Row
              label="Because"
              value={entitlementReasons.length ? entitlementReasons.join(', ') : entitled ? 'unknown' : '—'}
            />
            <Row
              label="Comped Auto-Cart trial"
              value={
                user.autocart_trial_until
                  ? `${trialLive ? 'until' : 'ended'} ${fmtPacific(user.autocart_trial_until)}`
                  : 'none'
              }
            />
            <Row
              label="RC hold beta"
              value={
                RC_HOLD_BETA_OPEN
                  ? 'open to everyone entitled'
                  : rcHoldBetaAllows(user.id)
                    ? 'on the allowlist'
                    : 'not on the allowlist'
              }
              hint="src/lib/autocart-beta.ts"
            />
          </div>
          <div>
            <Row label="Subscription rows" value={history ? String(history.rows.length) : 'unknown — read failed'} />
            {storeRow ? (
              <Row label="RevenueCat app user id" value={user.id} hint="RevenueCat is told our Clerk id" />
            ) : null}
            {user.signup_source ? (
              <Row label="Signup source" value={JSON.stringify(user.signup_source).slice(0, 80)} />
            ) : null}
            {history && history.stripe_state !== 'ok' ? (
              <Row
                label="Stripe details"
                value={history.stripe_state === 'unconfigured' ? 'unknown — not configured' : 'unknown — Stripe read failed'}
              />
            ) : null}
          </div>
        </div>

        {history && history.rows.length > 0 ? (
          <ul className="mt-3 space-y-3">
            {history.rows.map((r) => {
              const mark = GROUP_MARK[r.group];
              const f = r.stripe;
              const tierHow =
                r.provider === 'stripe'
                  ? f?.price_tier
                    ? `from Stripe price ${f.price_id} → ${f.price_tier}${f.price_tier !== r.tier ? ' — DISAGREES with the stored tier' : ''}`
                    : 'from the Stripe price id on each webhook (price not read here)'
                  : 'from the store product id on each RevenueCat event (not stored)';
              const unknown = r.provider === 'stripe' ? 'unknown' : 'unknown — store row';
              return (
                <li key={r.id} className="rounded-ch-sm border border-ch-line p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-ch-fine">
                      <StatusMark level={mark.level} label={`${mark.word} · ${r.status.replace(/_/g, ' ')}`} />
                    </span>
                    <span className="text-ch-fine text-ch-muted">{sourceLabel(r.provider)}</span>
                  </div>
                  <Row label="Plan" value={`${r.tier === 'autocart' ? 'Auto-Cart' : r.tier === 'base' ? 'Alerts' : r.tier} · ${f?.interval ?? unknown}`} />
                  <Row label="Tier derived" value={tierHow} />
                  <Row label="Grandfathered" value={r.grandfathered ? 'yes' : 'no'} />
                  <Row label="Started" value={fmtPacific(r.created_at) ?? '—'} />
                  <Row label="Row last updated" value={fmtDateTime(r.updated_at)} />
                  <Row label="Current period ends" value={fmtPacific(f?.current_period_end) ?? unknown} />
                  <Row label="Trial ends" value={f ? (fmtPacific(f.trial_end) ?? 'no trial') : unknown} />
                  {/* Both of Stripe's cancel fields, side by side, because they are
                      independent: a date with the flag false is the case that went
                      invisible, and seeing the two disagree is the point. */}
                  <Row
                    label="Cancel at period end (flag)"
                    value={r.cancel_flag ? 'yes' : 'no'}
                  />
                  <Row label="Cancel at (date)" value={fmtPacific(r.cancel_at) ?? 'none'} />
                  {r.cancelling && !r.cancel_flag && r.cancel_at ? (
                    <p className="py-1 text-ch-fine text-ch-muted">
                      Dated cancellation with the flag off. Still cancelling: either field is enough.
                    </p>
                  ) : null}
                  {f?.ended_at || f?.canceled_at ? (
                    <Row label="Ended / canceled (Stripe)" value={fmtPacific(f.ended_at) ?? fmtPacific(f.canceled_at) ?? '—'} />
                  ) : null}
                  {f && !f.found ? (
                    <Row label="In Stripe" value="not returned by Stripe — our record is shown" />
                  ) : null}
                  {f?.stripe_status && f.stripe_status !== r.status ? (
                    <Row label="Stripe says" value={`${f.stripe_status} (ours: ${r.status})`} />
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-ch-fine">
                    {r.stripe_subscription_id ? (
                      <a
                        href={`https://dashboard.stripe.com/subscriptions/${encodeURIComponent(r.stripe_subscription_id)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 break-all font-bold text-ch-green hover:text-ch-green-deep"
                      >
                        {r.stripe_subscription_id}
                        <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
                      </a>
                    ) : null}
                    {r.stripe_customer_id ? (
                      <a
                        href={`https://dashboard.stripe.com/customers/${encodeURIComponent(r.stripe_customer_id)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 break-all font-bold text-ch-green hover:text-ch-green-deep"
                      >
                        {r.stripe_customer_id}
                        <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
                      </a>
                    ) : null}
                    {r.store_transaction_id ? (
                      <span className="break-all font-mono text-ch-muted" title="Store original transaction id">
                        {r.store_transaction_id}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : history ? (
          <p className="mt-3 text-ch-fine text-ch-muted">No subscription rows for this account.</p>
        ) : null}
      </Panel>

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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-ch-fine">
              <thead className="text-ch-muted">
                <tr className="text-left">
                  <th className="py-1 font-medium">Campground</th>
                  <th className="py-1 font-medium">Unit / stay</th>
                  <th className="py-1 font-medium">Release</th>
                  <th className="py-1 font-medium">Status</th>
                  <th className="py-1 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {holds.map((h) => {
                  // lib/hold-outcome decides; `released` with no claim is UNRESOLVED
                  // and is shown as such, never as a win or a loss.
                  const outcome = holdOutcome(h);
                  const mark = OUTCOME_MARK[outcome];
                  return (
                    <tr key={h.id} className="border-t border-ch-line align-top">
                      <td className="py-1.5 pr-3">{h.campground_name ?? '—'}</td>
                      <td className="py-1.5 pr-3">
                        {h.unit_name ?? h.unit_id ?? '—'}
                        {h.arrival_date ? (
                          <span className="block text-ch-muted">
                            {h.arrival_date}
                            {h.nights ? ` · ${h.nights}n` : ''}
                          </span>
                        ) : null}
                      </td>
                      {/* release_at is RC's zone-less PACIFIC wall clock stored as text;
                          parsing it with Date would read it as UTC and move it 7 hours. */}
                      <td className="py-1.5 pr-3 whitespace-nowrap">{h.release_at ?? '—'}</td>
                      <td className="py-1.5 pr-3">
                        {h.status}
                        {h.error ? <span className="block text-ch-muted">{h.error.slice(0, 80)}</span> : null}
                      </td>
                      <td className="py-1.5" title={describeHoldOutcome(outcome)}>
                        {mark ? <StatusMark level={mark.level} label={mark.word} /> : 'no hand-off'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
