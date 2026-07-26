-- Editable monthly cost line-items for the admin "Costs" tab. Fixed recurring costs
-- (hosting, data, auth, comms subscriptions) that have no easy billing API, so the
-- operator maintains them by hand in the admin UI. Usage-based costs (SMS/email) are
-- computed live from the notifications table and are NOT stored here.
CREATE TABLE IF NOT EXISTS cost_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label         TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'other',   -- hosting | data | auth | comms | other
  monthly_cents INTEGER NOT NULL DEFAULT 0,      -- monthly cost in US cents
  notes         TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: deny-all like every app table; the service role (admin API) bypasses it.
ALTER TABLE cost_items ENABLE ROW LEVEL SECURITY;

-- Seed the known providers at $0 so the operator just fills in amounts. Idempotent:
-- only seeds when the table is empty.
INSERT INTO cost_items (label, category, monthly_cents, notes, sort_order)
SELECT * FROM (VALUES
  ('Vercel',            'hosting', 0, 'Website hosting / deploys',          10),
  ('Fly.io worker',     'hosting', 0, 'Always-on cancellation poller',      20),
  ('Supabase',          'data',    0, 'Postgres + PostGIS',                 30),
  ('Clerk',             'auth',    0, 'Auth / user accounts',               40),
  ('Twilio number',     'comms',   0, 'A2P phone number (per-SMS is usage)',50),
  ('Mapbox',            'data',    0, 'Geocoding + maps (plan portion)',    60),
  ('Domain (camphawk.app)','other',0, 'Annual ÷ 12',                        70),
  ('Mini PC / misc',    'other',   0, 'Auto-cart bot host, power, etc.',    80)
) AS v(label, category, monthly_cents, notes, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM cost_items);
