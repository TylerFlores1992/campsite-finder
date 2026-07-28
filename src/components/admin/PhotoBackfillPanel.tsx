'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@/components/ui/Button';

/**
 * Runs the RIDB photo backfill from the admin page.
 *
 * WHY A BUTTON AND NOT JUST THE SCRIPT. `scripts/backfill-ridb-photos.ts` needs a
 * checkout, Node and RIDB_API_KEY on the machine running it. The key is on Vercel,
 * which means the environment that already holds the credential is this app — and
 * the device the owner actually has to hand is a phone. So the work runs server-side
 * where the key is, and this drives it.
 *
 * THE LOOP LIVES HERE, IN THE CLIENT, on purpose. A serverless request can't walk
 * 4,469 facilities inside its budget, so the route does 40 and returns a cursor.
 * Keeping the loop in the browser means progress is visible, the run is interruptible
 * (close the tab and nothing is corrupted — the cursor is just lost), and pressing
 * the button again resumes from the start of whatever is still empty.
 */
export default function PhotoBackfillPanel() {
  const [counts, setCounts] = useState<{ total: number; empty: number } | null>(null);
  const [running, setRunning] = useState(false);
  // A REF, not state: the loop below needs the value as of *this* iteration, and a
  // state variable captured in the closure would still read false after the user
  // pressed Stop. `running` stays state because it drives the render.
  const stopRef = useRef(false);
  const [log, setLog] = useState<{ updated: number; noMedia: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/backfill-photos');
      if (r.ok) setCounts(await r.json());
    } catch {
      /* the panel just shows nothing rather than throwing */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(async () => {
    setRunning(true);
    stopRef.current = false;
    setError(null);
    const totals = { updated: 0, noMedia: 0, failed: 0 };
    setLog({ ...totals });

    let cursor: string | null = null;
    let stopped = false;
    try {
      for (;;) {
        const url = cursor
          ? `/api/admin/backfill-photos?after=${encodeURIComponent(cursor)}`
          : '/api/admin/backfill-photos';
        const r: Response = await fetch(url, { method: 'POST' });
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? `Backfill failed (${r.status})`);
        }
        const j = (await r.json()) as {
          updated: number;
          noMedia: number;
          failed: number;
          nextCursor: string | null;
          done: boolean;
        };
        totals.updated += j.updated;
        totals.noMedia += j.noMedia;
        totals.failed += j.failed;
        setLog({ ...totals });
        if (j.done || !j.nextCursor) break;
        cursor = j.nextCursor;
        if (stopRef.current) {
          stopped = true;
          break;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backfill failed');
    } finally {
      setRunning(false);
      if (stopped) setError((prev) => prev ?? 'Stopped. Press Run again to carry on.');
      void refresh();
    }
  }, [refresh]);

  const filled = counts ? counts.total - counts.empty : 0;

  return (
    <div>
      <p className="text-ch-meta leading-normal text-ch-muted">
        RIDB serves photos from a separate endpoint the sync never called, so these rows stored
        an empty list. The sync is fixed; this fills in the rows that already exist. Safe to
        run more than once, and safe to interrupt.
      </p>

      {counts && (
        <p className="mt-2 text-ch-body">
          <span className="font-bold">{filled.toLocaleString()}</span> of{' '}
          {counts.total.toLocaleString()} RIDB campgrounds have photos.
        </p>
      )}

      {log && (
        <p className="mt-1 text-ch-meta text-ch-muted">
          This run: {log.updated.toLocaleString()} filled · {log.noMedia.toLocaleString()} have no
          media in RIDB · {log.failed.toLocaleString()} failed
        </p>
      )}

      {error && <p className="mt-2 text-ch-meta text-ch-alert">{error}</p>}

      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={running} onClick={() => void run()}>
          {running ? 'Running…' : 'Run backfill'}
        </Button>
        {running && (
          <Button size="sm" variant="quiet" onClick={() => { stopRef.current = true; }}>
            Stop
          </Button>
        )}
      </div>

      {running && (
        <p className="mt-2 text-ch-fine text-ch-muted">
          Keep this page open — it works through the catalog in batches. Closing it is fine;
          nothing is lost and Run picks up where it left off.
        </p>
      )}
    </div>
  );
}
