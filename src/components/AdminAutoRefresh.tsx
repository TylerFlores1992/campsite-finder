'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

/**
 * Soft-refreshes the admin server component on an interval (no full reload).
 *
 * ICON ONLY. This used to render "updated 12s ago · auto every 30s" next to the
 * icon, which meant a state update and a re-render EVERY SECOND for a label nobody
 * acts on — and the page footer already says the figures refresh every 30s, so it
 * was saying it twice. Dropping the counter removes the header clutter and the
 * per-second render at the same time.
 */
export default function AdminAutoRefresh({ intervalMs = 30000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [spinning, setSpinning] = useState(false);

  function refresh() {
    setSpinning(true);
    router.refresh();
    setTimeout(() => setSpinning(false), 600);
  }

  useEffect(() => {
    const refreshTimer = setInterval(refresh, intervalMs);
    return () => clearInterval(refreshTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return (
    <button
      onClick={refresh}
      // The spin is the feedback that a manual click did something; without the
      // label there is nothing else to confirm it.
      className="cursor-pointer rounded-ch-input p-1 text-ch-muted transition-colors hover:text-ch-green-deep"
      title="Refresh now"
      aria-label="Refresh admin data now"
    >
      <RefreshCw size={15} className={spinning ? 'animate-spin' : ''} />
    </button>
  );
}
