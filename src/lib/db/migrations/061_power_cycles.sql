-- Every time we cut power to the mini-PC, and why.
--
-- WHY THIS EXISTS (2026-08-17). The box ran zero processes for over an hour and there was no
-- way to reach it. Every remote lever we have rides a process ON the box — `bot_commands`
-- needs `bot.mjs`, the watchdog needs Task Scheduler, `restart-rc` needs a poller — so with
-- nothing running there is nothing to receive an instruction. That is structural, and no
-- amount of software on that machine fixes "the machine is running nothing".
--
-- So the lever moved OFF the box: a cloud smart plug, called from our own servers. Same
-- argument that moved `expire-holds` to Fly, one level further out — a watchdog must not
-- ride the thing it watches, and a power switch must not ride the thing it power-cycles.
--
-- WHY IT IS LOGGED AT ALL. A hard power cut is the most destructive thing this system can
-- do. It can interrupt a cart, and it can corrupt the Chromium profile that holds the `DT`
-- device cookie — the thing that lets Okta skip the email step and makes unattended login
-- work at all. Losing that profile has cost a 12-hour IP block before. An act with that
-- blast radius must leave a record that is readable when the box cannot speak for itself,
-- which rules out any log file living on it.
--
-- AND THE RECORD IS WHAT MAKES THE RATE LIMIT HONEST. The limit is enforced by reading this
-- table, so "have we already tried this?" is answered by evidence rather than by memory in a
-- process that may itself have restarted. A reboot loop is strictly worse than a dark box:
-- a dark box is one trip to fix, a box being power-cycled every ten minutes may never finish
-- booting, and every cycle is another chance to corrupt the profile.
CREATE TABLE IF NOT EXISTS power_cycles (
  id          bigserial PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT NOW(),
  -- Who asked. Free text, since the only callers are an admin button and (later, maybe) an
  -- automatic gate, and telling those two apart afterwards is the whole point.
  requested_by text,
  -- The state that justified it, captured AT THE MOMENT OF THE DECISION. Reconstructing why
  -- somebody cut power from heartbeats read hours later is exactly the guesswork this
  -- codebase keeps paying for.
  reason      text,
  -- How long the box had been silent, in seconds. NULL means we could not tell — which is a
  -- refusal, not a reason, and should never appear next to a successful cycle.
  silent_s    integer,
  -- Did the plug accept it? A cut we THINK we made and did not is the worst of both worlds:
  -- the rate limit spends its budget and the box is still dark.
  ok          boolean,
  detail      text
);

ALTER TABLE power_cycles ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE power_cycles IS
  'Hard power cycles of the mini-PC via the cloud smart plug. Logged server-side because the box cannot be trusted to record its own power loss, and because the rate limit is enforced by reading this table.';
