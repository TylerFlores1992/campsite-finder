'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

/** Soft-refreshes the admin server component on an interval (no full reload). */
export default function AdminAutoRefresh({ intervalMs = 30000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [spinning, setSpinning] = useState(false);

  function refresh() {
    setSpinning(true);
    router.refresh();
    setSecondsAgo(0);
    setTimeout(() => setSpinning(false), 600);
  }

  useEffect(() => {
    const tick = setInterval(() => setSecondsAgo((s) => s + 1), 1000);
    const refreshTimer = setInterval(refresh, intervalMs);
    return () => {
      clearInterval(tick);
      clearInterval(refreshTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs]);

  return (
    <button
      onClick={refresh}
      className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-green-700 transition-colors"
      title="Refresh now"
    >
      <RefreshCw size={13} className={spinning ? 'animate-spin' : ''} />
      <span>updated {secondsAgo}s ago · auto every 30s</span>
    </button>
  );
}
