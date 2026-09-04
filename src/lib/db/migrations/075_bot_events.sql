-- BOT EVENTS: things the mini-PC OBSERVES that no existing series can hold.
--
-- Two instruments, same reason, same shape as migration 066:
--
--   1. A RAMP SCAN. Every one of the eleven Chromium ramps since 2026-09-01 shows the same
--      first sample: Windows COMMIT goes from ~7.5 GB to ~46 GB inside ONE two-minute tick,
--      while the chrome.exe private bytes the sampler sums account for ~3.5 GB of it. Then
--      both climb together, ~450 MB/min, to ~52 GB / ~9.4 GB, and the browser is replaced.
--      Roughly 35 GB of commit appears at the onset and is attributed to NOTHING in
--      `chromium_memory_samples` — which sums private bytes over our chrome.exe only. The one
--      instrument that could name it is the `memory` command's full scan (every process, the
--      pagefile, the top consumers), and it runs only when a human asks; the ramps arrive
--      every 5-6 hours and nobody is at a keyboard for one. So `bot.mjs` takes that scan
--      ITSELF, once, the first time the periodic sample sees the rc family past 3 GB, and
--      stores it here. See scripts/auto-cart-bot/ramp-scan.mjs.
--
--   2. A TAB-CLOSE TIMING. The throwaway-tab cure (PR #142) closes the renewal's tab in a
--      `finally` with `await tab.close()` — UNBOUNDED. A renderer that is eating the machine
--      may never acknowledge a close, and Playwright launches Chromium with the hang monitor
--      off. A close that hangs for ten minutes and a renewal whose body takes ten minutes end
--      the same way in the memory series (a browser replacement) and differ only in one
--      number nothing recorded. Every tab close now reports how long the trip took and how
--      long the close took, and whether it had to be given up on.
--
-- WHY ONE TABLE. Both are "the bot noticed something, here is what it saw", both are rare
-- (a few rows a day), both need the newest few side by side. A column per field would be a
-- migration per instrument; a kind plus a jsonb detail is one table for the next one too.
--
-- WHY A TABLE AND NOT THE LOG. `tail-log` returns the last 16,000 characters of a log the
-- keep-warm writes continuously, and the 09-03 17:59 and 09-04 05:13 teardown lines had rolled
-- out of it before anyone could read them. `chromium_memory_samples` and
-- `native_alloc_readings` survived the same events by being in Postgres.
--
-- WHAT IS NEVER STORED. `text` is the scan's own output: process NAMES, pids, sizes, our
-- profile DIRECTORIES. No command lines (Chromium argv carries URLs), no tokens, no cookies —
-- the same rule the `memory` command already follows.

CREATE TABLE IF NOT EXISTS bot_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT NOW(),
  -- Which process reported: 'bot' (the rec.gov bot, which samples memory) or 'rc-keepwarm'.
  source      text,
  -- Allow-listed on the way in (see src/lib/bot-events.ts). Anything else is stored as NULL,
  -- never as whatever the caller sent — this renders on an admin readout.
  kind        text,
  -- Small structured facts: trigger values, durations, flags. Capped in size at the recorder.
  detail      jsonb,
  -- The scan's text, when there is one. Capped at 64 KB; control characters stripped
  -- (Postgres text cannot hold a NUL, and a NUL is how the tail-log answer went unstorable
  -- on 2026-08-11).
  text        text,
  created_at  timestamptz NOT NULL DEFAULT NOW()
);

-- The only query: "the newest N of this kind."
CREATE INDEX IF NOT EXISTS bot_events_kind_at_idx ON bot_events (kind, at DESC);

ALTER TABLE bot_events ENABLE ROW LEVEL SECURITY;
