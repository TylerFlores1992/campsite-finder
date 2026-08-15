'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search, ChevronRight } from 'lucide-react';
import type { AdminUserRow } from '@/app/admin/users/queries';

/**
 * Who has an account, and what have they actually done.
 *
 * `import type` from the queries module on purpose — that file pulls in the database
 * client, and a value import would drag it into this client bundle. The type is erased
 * at compile time; nothing from it ships.
 *
 * Rows are pre-sorted by last-seen from SQL. The three sort buttons re-sort in place
 * rather than refetching: 26 users today and a few hundred at any plausible scale, so
 * a round trip per click would buy nothing.
 */

/** Relative time from an ISO timestamp. Same vocabulary as AdminTabs' `ago`. */
function since(iso: string | null): string {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return 'never';
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * The access badge reports the REASON, not just the fact.
 *
 * Measured 2026-08-15: only 2 of 26 accounts have a Stripe subscription and 8 carry
 * `is_beta`, so a badge reading purely off `subscriptions` renders the owner's own
 * account — 6 watches, 530 alerts — as "no plan". Beta is shown first because it is
 * what is actually granting access to most of this list.
 */
function accessBadge(u: AdminUserRow): { label: string; cls: string } {
  if (u.is_beta) return { label: 'Beta', cls: 'bg-ch-blue/10 text-ch-blue border-ch-blue/30' };
  if (u.autocart_entitled)
    return { label: 'Auto-Cart', cls: 'bg-ch-green-soft text-ch-green-deep border-ch-green-soft' };
  if (u.subscribed)
    return { label: 'Alerts', cls: 'bg-ch-green-soft text-ch-green-deep border-ch-green-soft' };
  if (u.sub_status)
    return { label: u.sub_status, cls: 'bg-ch-paper text-ch-muted border-ch-line' };
  return { label: 'no plan', cls: 'bg-ch-paper text-ch-faint border-ch-line' };
}

type Sort = 'seen' | 'watches' | 'alerts';

const SORTS: Array<[Sort, string]> = [
  ['seen', 'Last seen'],
  ['watches', 'Watches'],
  ['alerts', 'Alerts'],
];

export default function UsersBox({
  users,
  excludedTestRows,
}: {
  users: AdminUserRow[];
  excludedTestRows: number;
}) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('seen');

  const q = search.trim().toLowerCase();
  const shown = useMemo(() => {
    const filtered = q
      ? users.filter(
          (u) => (u.email ?? '').toLowerCase().includes(q) || u.id.toLowerCase().includes(q),
        )
      : users;
    const copy = [...filtered];
    if (sort === 'watches') copy.sort((a, b) => b.live_watches - a.live_watches || b.total_watches - a.total_watches);
    else if (sort === 'alerts') copy.sort((a, b) => b.alerts_sent - a.alerts_sent);
    // 'seen' is the SQL order, so the unsorted copy is already correct.
    return copy;
  }, [users, q, sort]);

  return (
    <div className="rounded-ch-card border border-ch-line bg-ch-card p-4 shadow-ch-card">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-ch-display text-ch-h font-bold">Users</h2>
        <span className="text-ch-fine text-ch-muted">
          {q ? `showing ${shown.length} of ${users.length}` : `${users.length} accounts`}
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-ch-line p-0.5 text-ch-fine font-medium">
          {SORTS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSort(key)}
              aria-pressed={sort === key}
              className={`rounded-md px-2.5 py-1.5 transition-colors ${
                sort === key ? 'bg-ch-green text-white' : 'text-ch-muted hover:text-ch-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative min-w-[11rem] flex-1">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ch-faint"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search email or user id"
            aria-label="Search users by email or id"
            className="w-full rounded-lg border border-ch-line py-1.5 pl-8 pr-3 text-ch-fine focus:outline-none focus:ring-2 focus:ring-ch-green"
          />
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="py-2 text-ch-fine text-ch-muted">
          {q ? `No account matches "${search.trim()}".` : 'No accounts yet.'}
        </p>
      ) : (
        <ul className="max-h-[32rem] divide-y divide-ch-line overflow-y-auto overscroll-contain">
          {shown.map((u) => {
            const badge = accessBadge(u);
            return (
              <li key={u.id}>
                <Link
                  href={`/admin/users/${encodeURIComponent(u.id)}`}
                  className="flex items-center gap-3 py-2.5 hover:bg-ch-green-soft/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ch-body text-ch-ink">
                      {u.email ?? <span className="text-ch-faint">no email on file</span>}
                    </span>
                    <span className="mt-0.5 block text-ch-fine text-ch-muted">
                      {u.live_watches} live
                      {u.total_watches !== u.live_watches ? ` of ${u.total_watches}` : ''} ·{' '}
                      {u.alerts_sent.toLocaleString()} alerts · seen {since(u.last_seen_at)}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}
                  >
                    {badge.label}
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ch-faint" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-ch-fine text-ch-muted">
        &ldquo;Seen&rdquo; is the last authenticated page load, not the last settings
        change.
        {excludedTestRows > 0
          ? ` ${excludedTestRows} hand-inserted test row${excludedTestRows === 1 ? '' : 's'} excluded, as everywhere else on this page.`
          : ''}
      </p>
    </div>
  );
}
