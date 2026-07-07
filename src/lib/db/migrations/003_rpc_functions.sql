-- RPC functions used by src/lib/db/client.ts (Supabase JS client, HTTPS-only —
-- needed because Vercel can't resolve Supabase's direct Postgres hostname).

-- Radius search using PostGIS, returns distance in miles.
CREATE OR REPLACE FUNCTION search_campgrounds_nearby(
  p_lat double precision,
  p_lng double precision,
  p_radius_meters double precision,
  p_limit integer DEFAULT 50,
  p_site_type text DEFAULT NULL,
  p_amenities text[] DEFAULT NULL
)
RETURNS TABLE (
  id text, source text, name text, description text,
  address jsonb, amenities text[], activities text[],
  environment_tags text[], site_types text[],
  reservable boolean, reservations_url text,
  ada_accessible boolean, pets_allowed boolean,
  photos jsonb, last_synced_at timestamptz,
  latitude double precision, longitude double precision,
  distance_miles double precision
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id, c.source, c.name, c.description,
    c.address, c.amenities, c.activities,
    c.environment_tags, c.site_types,
    c.reservable, c.reservations_url,
    c.ada_accessible, c.pets_allowed,
    c.photos, c.last_synced_at,
    ST_Y(c.location::geometry) AS latitude,
    ST_X(c.location::geometry) AS longitude,
    ST_Distance(c.location::geography, ST_MakePoint(p_lng, p_lat)::geography) / 1609.34 AS distance_miles
  FROM campgrounds c
  WHERE
    ST_DWithin(c.location::geography, ST_MakePoint(p_lng, p_lat)::geography, p_radius_meters)
    AND (p_site_type IS NULL OR p_site_type = ANY(c.site_types))
    AND (p_amenities IS NULL OR p_amenities <@ c.amenities)
  ORDER BY distance_miles
  LIMIT p_limit;
END;
$$;

-- Generic SELECT executor (service-role only, server-side use via mutate/query in db/client.ts).
CREATE OR REPLACE FUNCTION exec_select(query_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result jsonb;
BEGIN
  EXECUTE format('SELECT coalesce(json_agg(t), ''[]''::json) FROM (%s) t', query_text) INTO result;
  RETURN result;
END; $$;

-- Generic DML executor (INSERT/UPDATE/DELETE). Statements with RETURNING are
-- wrapped in a CTE (data-modifying CTEs support RETURNING; bare subqueries don't)
-- so the affected rows come back as JSON. Statements without RETURNING just run.
CREATE OR REPLACE FUNCTION exec_dml(query_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result jsonb;
BEGIN
  IF query_text ILIKE '%RETURNING%' THEN
    EXECUTE format('WITH __dml__ AS (%s) SELECT coalesce(json_agg(t), ''[]''::json) FROM __dml__ t', query_text) INTO result;
    RETURN COALESCE(result, '[]'::jsonb);
  ELSE
    EXECUTE query_text;
    RETURN '[]'::jsonb;
  END IF;
END; $$;
