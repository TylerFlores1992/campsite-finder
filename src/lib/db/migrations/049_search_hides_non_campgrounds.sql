-- Search stops showing picnic shelters and day-use parking.
--
-- `search_campgrounds` is the RPC behind /api/search and the map, so it is where the
-- `hidden` flag from 048 has to be applied — the sitemap and the state landing pages
-- filter in their own queries, but the search path goes through here.
--
-- The function is REPLACED wholesale rather than patched because Postgres has no ALTER
-- FUNCTION for a body; this is 003's definition with one added predicate. If 003 changes,
-- this file has to be re-derived from it — there is no way to express "the same, plus a
-- WHERE clause" in SQL.
--
-- **Not applied to the poller.** Hiding is discovery-only; an existing watch on one of
-- these must keep alerting. See 048.
CREATE OR REPLACE FUNCTION search_campgrounds(
  p_lat double precision,
  p_lng double precision,
  p_radius_meters double precision,
  p_site_type text DEFAULT NULL,
  p_amenities text[] DEFAULT NULL,
  p_rv_length integer DEFAULT NULL,
  p_limit integer DEFAULT 100
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
LANGUAGE plpgsql STABLE AS $$
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
    AND c.hidden = false
    AND (p_site_type IS NULL OR p_site_type = ANY(c.site_types))
    AND (p_amenities IS NULL OR p_amenities <@ c.amenities)
    AND (p_rv_length IS NULL OR EXISTS (
      SELECT 1 FROM campsites cs
      WHERE cs.campground_id = c.id AND cs.max_vehicle_length >= p_rv_length
    ))
  ORDER BY distance_miles
  LIMIT p_limit;
END;
$$;
