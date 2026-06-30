-- Enable PostGIS for geospatial queries
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Campgrounds (facility level — synced from RIDB and other sources)
CREATE TABLE IF NOT EXISTS campgrounds (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'ridb',
  name TEXT NOT NULL,
  description TEXT,
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  address JSONB NOT NULL DEFAULT '{}',
  amenities TEXT[] NOT NULL DEFAULT '{}',
  activities TEXT[] NOT NULL DEFAULT '{}',
  environment_tags TEXT[] NOT NULL DEFAULT '{}',
  site_types TEXT[] NOT NULL DEFAULT '{}',
  reservable BOOLEAN NOT NULL DEFAULT true,
  reservations_url TEXT,
  phone TEXT,
  email TEXT,
  ada_accessible BOOLEAN NOT NULL DEFAULT false,
  pets_allowed BOOLEAN NOT NULL DEFAULT false,
  photos JSONB NOT NULL DEFAULT '[]',
  raw_data JSONB,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campgrounds_location ON campgrounds USING GIST(location);
CREATE INDEX IF NOT EXISTS idx_campgrounds_source ON campgrounds(source);
CREATE INDEX IF NOT EXISTS idx_campgrounds_amenities ON campgrounds USING GIN(amenities);
CREATE INDEX IF NOT EXISTS idx_campgrounds_activities ON campgrounds USING GIN(activities);
CREATE INDEX IF NOT EXISTS idx_campgrounds_env_tags ON campgrounds USING GIN(environment_tags);
CREATE INDEX IF NOT EXISTS idx_campgrounds_site_types ON campgrounds USING GIN(site_types);

-- Campsites (individual site level)
CREATE TABLE IF NOT EXISTS campsites (
  id TEXT PRIMARY KEY,
  campground_id TEXT NOT NULL REFERENCES campgrounds(id) ON DELETE CASCADE,
  name TEXT,
  type TEXT,
  loop TEXT,
  max_occupants INTEGER,
  max_vehicle_length INTEGER,
  ada_accessible BOOLEAN NOT NULL DEFAULT false,
  pets_allowed BOOLEAN NOT NULL DEFAULT false,
  reservable BOOLEAN NOT NULL DEFAULT true,
  attributes JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campsites_campground_id ON campsites(campground_id);
CREATE INDEX IF NOT EXISTS idx_campsites_type ON campsites(type);

-- Cached availability (populated on-demand, short TTL managed at app layer)
CREATE TABLE IF NOT EXISTS availability (
  campsite_id TEXT NOT NULL REFERENCES campsites(id) ON DELETE CASCADE,
  campground_id TEXT NOT NULL REFERENCES campgrounds(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'reserved', 'closed', 'not_available')),
  min_stay INTEGER,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campsite_id, date)
);

CREATE INDEX IF NOT EXISTS idx_availability_campground_date ON availability(campground_id, date);
CREATE INDEX IF NOT EXISTS idx_availability_status ON availability(date, status);

-- Users (simple for v1 — no passwords, identity via email magic link or similar)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Favorites
CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campground_id TEXT NOT NULL REFERENCES campgrounds(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, campground_id)
);

-- Availability watches
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campground_id TEXT NOT NULL REFERENCES campgrounds(id) ON DELETE CASCADE,
  campsite_ids TEXT[],
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  min_nights INTEGER NOT NULL DEFAULT 1,
  site_type TEXT,
  notify_push BOOLEAN NOT NULL DEFAULT true,
  notify_sms BOOLEAN NOT NULL DEFAULT false,
  notify_email BOOLEAN NOT NULL DEFAULT true,
  auto_cart BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watches_user ON watches(user_id);
CREATE INDEX IF NOT EXISTS idx_watches_campground ON watches(campground_id);
CREATE INDEX IF NOT EXISTS idx_watches_active ON watches(active, start_date) WHERE active = true;

-- Sync log (track nightly sync runs)
CREATE TABLE IF NOT EXISTS sync_log (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  facilities_synced INTEGER,
  campsites_synced INTEGER,
  error TEXT,
  metadata JSONB
);
