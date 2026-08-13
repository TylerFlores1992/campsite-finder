-- HOW LONG DOES THE APP'S RESERVECALIFORNIA SESSION ACTUALLY LAST?
--
-- Nobody knows, and the claim that it persists has already cost a sign-in inside the 08:00
-- window (2026-08-12). The 2026-08-09 tests measured persistence across closing the webview
-- and force-closing the app, on the SAME DAY; nothing has ever measured days, and RC's own
-- lifetimes (~1h access token, ~12h Okta session) apply inside the app exactly as they do
-- to the bot.
--
-- The probe itself is cheap and already possible — `openRcHandoff` with no unitId opens RC,
-- injects, captures a token if one exists and carts nothing. What was missing is the part
-- that makes a series out of it. A reading that lives in a React state variable answers
-- "right now" and evaporates; the question here is a shape over days, and this file is the
-- difference between the two.
--
-- SAME ARGUMENT AS MIGRATION 050, which gave the hold hand-off a durable end for exactly
-- this reason, and as 047, whose first real reading falsified a confident hypothesis about
-- session lifetime within hours of being applied. This codebase has been burned twice by
-- treating one observation as a measurement; a table is what stops the third time.
--
-- A ROW PER PROBE RUN, not per report. `probe_id` is minted by the client for one run and
-- the row is upserted as reports arrive, so a run that reports three times is one
-- observation rather than three — and a webview closed early still leaves the row it had.
--
-- WHY `device_key` EXISTS AT ALL. The probe's marker lives in the WEBVIEW's storage, so an
-- ITP purge takes it. From inside, a purge and a first-ever run are the same silence. Only
-- a record of previous probes from the same device separates them, and this column is that
-- record — held in OUR OWN origin's storage, which the RC-origin wipe does not touch. If it
-- is ever lost too, a purge degrades to "first-open", which is the conservative direction:
-- never claim a purge you cannot prove.
--
-- CONTAINS NO CREDENTIAL. Stage names, counters, and token EXPIRIES as integers — never a
-- token, never a cart key, never a URL query (Okta signs in inside this webview, so its
-- callback query is an exchangeable authorization code). Enforced at the source in
-- lib/rc-precart-script and guarded by worker/rc-session-verdict.test.mts.

CREATE TABLE IF NOT EXISTS rc_app_session_probes (
  probe_id      text PRIMARY KEY,
  -- Who ran it, so probes from two people are never mistaken for one device's history.
  user_email    text,
  -- Stable per install, from our own origin's storage. See above.
  device_key    text,
  platform      text,
  app_build     text,

  -- The verdict is DERIVED (lib/rc-session-verdict) and stored anyway: the facts are what
  -- this table is for, but a readout that has to re-run the classifier to say what happened
  -- cannot show how the classifier's own answers changed when it was corrected.
  verdict       text NOT NULL,
  detail        text,
  -- Did this observation actually answer the renewal question? A working session proves
  -- persistence and nothing about renewal, and counting the two together is how "one
  -- observation" becomes "a measurement" without anybody deciding to say so.
  proves_renewal boolean NOT NULL DEFAULT false,

  -- The facts, denormalised for the readout. NULL means "not reported", never zero.
  marker            text,
  opens             integer,
  last_open_ago_sec integer,
  first_open_ago_sec integer,
  prev_token_expires_in_sec integer,
  stored_token      text,
  live_token_expires_in_sec integer,
  live_token_age_sec integer,

  -- Everything the webview said, verbatim, capped by the route. The useful field on the day
  -- RC changes something is the one nobody predicted a column for.
  reports       jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW()
);

-- The readout is always "this device, newest first".
CREATE INDEX IF NOT EXISTS rc_app_session_probes_device_idx
  ON rc_app_session_probes (device_key, created_at DESC);

-- Admin-only surface, written by the service role. RLS on, no policy: nothing reaches it
-- through the anon key. Same posture as the rest of migration 027's tables.
ALTER TABLE rc_app_session_probes ENABLE ROW LEVEL SECURITY;
