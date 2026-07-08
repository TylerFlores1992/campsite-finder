-- Security lockdown (Supabase advisor: rls_disabled_in_public).
-- The app talks to Postgres exclusively through the service role (which
-- bypasses RLS), so: enable RLS everywhere with NO policies (deny-all for
-- anon/authenticated), and restrict the SECURITY DEFINER executor functions
-- to service_role only — left open, they'd allow arbitrary SQL to anyone
-- holding the anon key.

DO $do$ DECLARE r record; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $do$;

REVOKE ALL ON FUNCTION exec_select(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION exec_dml(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION search_campgrounds_nearby(double precision, double precision, double precision, integer, text, text[], integer) FROM PUBLIC, anon, authenticated;

-- spatial_ref_sys stays RLS-off: PostGIS system reference data, not app data.
