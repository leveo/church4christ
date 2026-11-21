-- Missions (the optional `missions` module). Postgres twin: migrations-supabase/0048_missions.sql.
-- Mission trips shown on a public world map, timeline, and story pages. Only published trips are ever read for
-- public pages. Coordinates are optional: a trip without them is listed but gets no map pin, which is the way
-- to show a trip to a sensitive place without revealing where it was. Photos are media keys from the existing
-- upload store. campus_id mirrors 0027_multi_campus.sql (a plain column with a default, no foreign key).

CREATE TABLE mission_trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  year INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2200),
  start_date TEXT,                          -- YYYY-MM-DD, optional
  end_date TEXT,                            -- YYYY-MM-DD, optional
  country_code TEXT,                        -- ISO 3166-1 alpha-2, optional
  latitude REAL CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
  longitude REAL CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
  team_size INTEGER CHECK (team_size IS NULL OR team_size >= 0),
  cover_media_key TEXT,
  video_url TEXT,
  fund_id INTEGER,                         -- Giving fund for "Support this mission" (read only while Giving is on. No FK: D1 has no funds table)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1,
  UNIQUE (campus_id, slug)
);
CREATE INDEX idx_mission_trips_public ON mission_trips(status, year);

CREATE TABLE mission_trip_i18n (
  trip_id INTEGER NOT NULL REFERENCES mission_trips(id) ON DELETE CASCADE,
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  title TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  story_md TEXT NOT NULL DEFAULT '',
  team_note TEXT NOT NULL DEFAULT '',       -- leaders or a note about who went, as the church wants it shown
  campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (trip_id, locale)
);

CREATE TABLE mission_trip_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL REFERENCES mission_trips(id) ON DELETE CASCADE,
  media_key TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  campus_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_mission_trip_photos_trip ON mission_trip_photos(trip_id, sort);

-- Missions stays off until an administrator turns it on in Settings -> Modules. A fresh database has no module
-- rows and no people yet, so setup's own module choices apply there (setup writes every module row, and no
-- preset includes this one). An explicit row is never changed.
INSERT INTO settings (key, value)
SELECT 'module.missions', '0'
WHERE EXISTS (SELECT 1 FROM settings WHERE key LIKE 'module.%')
   OR EXISTS (SELECT 1 FROM people)
ON CONFLICT(key) DO NOTHING;
