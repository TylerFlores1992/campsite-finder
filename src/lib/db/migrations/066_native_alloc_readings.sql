-- THE SAMPLER WORKS AND ITS READINGS KEEP AGEING OUT BEFORE ANYONE CAN READ THEM.
--
-- `rc-native-sampler.mjs` is the instrument built to answer the one question five other
-- instruments could not: WHAT allocates during an Okta trip. It runs on the box, it works,
-- and its output goes to exactly one place — `logs\rc-keepwarm.log` — which `tail-log`
-- returns the last 16,000 characters of.
--
-- ── WHAT THAT COST, MEASURED 2026-08-23 ───────────────────────────────────────────────────
-- Two nine-gigabyte ramps in thirty-two hours, the sampler running for both:
--
--     08-22 23:12 -> 23:23   rc 8,983 MB   free RAM 6,744 -> 3,191   COMMIT 82%
--     08-23 07:31 -> 07:41   rc 9,180 MB   free RAM 5,960 -> 3,328   COMMIT 88%
--
-- Both attributions are GONE. By the time anybody looked, the log had rolled past them, and
-- the only sampler lines still readable were from navigations that did not ramp (7 MB, 9 MB,
-- 53 MB) — which the three-way verdict correctly refuses to draw conclusions from.
--
-- That is this project's oldest failure shape wearing new clothes: an instrument whose
-- output is unavailable at the moment it matters. `chromium_memory_samples` survives those
-- same events because it is in Postgres. This is the missing half of that pair — the series
-- says a ramp HAPPENED and how big; this says what was allocating while it did.
--
-- ── ONLY RAMPS ARE STORED, AND THAT IS THE WHOLE DESIGN ───────────────────────────────────
-- The renewal makes an Okta trip roughly hourly and almost all of them cost 50-350 MB. Storing
-- every reading would be thousands of rows a week of confirmed nothing, and the interesting
-- rows would be as hard to find here as they are in the log. The bot gates on the free-RAM
-- delta it already measures for the three-way verdict, so a row existing at all means the
-- machine lost memory during that trip.
--
-- `ram_delta_mb` is NEGATIVE for a ramp (free RAM fell). Stored as measured rather than
-- flipped, because a sign flip is the kind of tidying that later reads as growth.
--
-- ── SITES IS jsonb, AND IT IS ALREADY AGGREGATED ──────────────────────────────────────────
-- Not raw samples — the bot aggregates by allocation site before sending, so a 9 GB ramp is a
-- handful of rows rather than thousands. `[{site, bytes}]`, largest first, capped by the
-- sender. On Windows a site reads `chrome.dll.pdb+0x9961707 <- chrome.dll.pdb+0x370aa42`,
-- which is stable for a build and symbolizable offline against that binary.
--
-- STORED AS NULL, NEVER `{}`, when there is nothing to record — the rule migration 062 needed
-- and `[object Object]` broke. An empty reading and a missing one are different facts.
--
-- ── RENDERER ONLY, AND THE COLUMN NAME SAYS SO ────────────────────────────────────────────
-- `Memory.startSampling` is absent on the browser target (verified). On the 08-23 ramp the
-- renderer held 8,245 MB of 9,180 — most of it, and not all of it. `renderer_bytes` is named
-- for what it is so a later reader cannot mistake it for the whole event, which is how "the
-- biggest process" became a whole explanation once already.

CREATE TABLE IF NOT EXISTS native_alloc_readings (
  id            bigserial PRIMARY KEY,
  taken_at      timestamptz NOT NULL DEFAULT NOW(),
  -- Which trip this was: the hourly renewal, the T-30 auto-login, or the nightly rehearsal.
  -- They have different shapes and different stakes, and the 9.4 GB events are auto-logins.
  context       text,
  -- Free RAM after minus before, in MB. NEGATIVE means the machine lost memory.
  ram_delta_mb  integer,
  -- What the renderer's sampler attributed across the trip. NOT the whole process family.
  renderer_bytes bigint,
  -- [{site, bytes}], largest first. NULL when nothing was attributable.
  sites         jsonb,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

-- The only query this table has: "show me the ramps, newest first."
CREATE INDEX IF NOT EXISTS native_alloc_readings_taken_idx
  ON native_alloc_readings (taken_at DESC);

ALTER TABLE native_alloc_readings ENABLE ROW LEVEL SECURITY;
