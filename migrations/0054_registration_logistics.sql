-- Event logistics (Registration Phase 5, the optional `event-logistics` module). Postgres twin:
-- migrations-supabase/0046_registration_logistics.sql.
-- Per-event switches for housing, table seating and small groups, whether registrants see their assignments,
-- and the per-person choice question whose options group people for single-gender rooms; staff tags; venues,
-- room types, rooms and room assignments; tables and seats; small groups and their members. Every addition is
-- a new defaulted or nullable column or a new table, so existing events and registrations keep working.
-- One room, one seat and one group per person: each assignment table is keyed by the person (attendee), and a
-- person belongs to exactly one registration and so to one event. Leaders and hosts are people on the event
-- (attendee ids), not member accounts. campus_id mirrors 0027_multi_campus.sql (a plain column, no foreign key).

ALTER TABLE reg_events ADD COLUMN housing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (housing_enabled IN (0,1));
ALTER TABLE reg_events ADD COLUMN seating_enabled INTEGER NOT NULL DEFAULT 0 CHECK (seating_enabled IN (0,1));
ALTER TABLE reg_events ADD COLUMN groups_enabled INTEGER NOT NULL DEFAULT 0 CHECK (groups_enabled IN (0,1));
ALTER TABLE reg_events ADD COLUMN show_assignments INTEGER NOT NULL DEFAULT 0 CHECK (show_assignments IN (0,1));
-- SQLite accepts a foreign key on an added column when its default is NULL.
ALTER TABLE reg_events ADD COLUMN gender_question_id INTEGER REFERENCES reg_questions(id) ON DELETE SET NULL;
-- Moves on every logistics change (the guarded batches claim it, see src/lib/regLogistics.ts); the seating
-- planner's preview stamp includes it, so an apply refuses a plan made from older data.
ALTER TABLE reg_events ADD COLUMN logistics_version INTEGER NOT NULL DEFAULT 0;

-- Staff labels for people on one event (no built-in meanings); they drive optional seating rules.
CREATE TABLE reg_tags (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1,
  event_id INTEGER NOT NULL REFERENCES reg_events(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  color_token TEXT NOT NULL DEFAULT 'neutral',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, label)
);

CREATE TABLE reg_attendee_tags (
  attendee_id INTEGER NOT NULL REFERENCES reg_attendees(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES reg_tags(id) ON DELETE CASCADE,
  campus_id INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (attendee_id, tag_id)
);
CREATE INDEX idx_reg_attendee_tags_tag ON reg_attendee_tags(tag_id);

-- Housing: venues hold room types and rooms. A hard capacity rule refuses an extra bed; a soft one asks.
CREATE TABLE reg_venues (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1,
  event_id INTEGER NOT NULL REFERENCES reg_events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('hotel','dorm','campsite','other')),
  capacity_rule TEXT NOT NULL DEFAULT 'soft' CHECK (capacity_rule IN ('hard','soft')),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, name)
);

CREATE TABLE reg_room_types (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1,
  venue_id INTEGER NOT NULL REFERENCES reg_venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  beds INTEGER NOT NULL CHECK (beds > 0),
  UNIQUE (venue_id, name)
);

-- Beds = beds_override, else the room type's beds. Rooms start unconfirmed; only confirmed rooms take people.
CREATE TABLE reg_rooms (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1,
  venue_id INTEGER NOT NULL REFERENCES reg_venues(id) ON DELETE CASCADE,
  room_type_id INTEGER REFERENCES reg_room_types(id),
  label TEXT NOT NULL,
  floor TEXT,
  notes TEXT,
  beds_override INTEGER CHECK (beds_override IS NULL OR beds_override > 0),
  policy TEXT NOT NULL DEFAULT 'any' CHECK (policy IN ('any','single_gender','one_party')),
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)),
  leader_attendee_id INTEGER REFERENCES reg_attendees(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (room_type_id IS NOT NULL OR beds_override IS NOT NULL),
  UNIQUE (venue_id, label)
);
CREATE INDEX idx_reg_rooms_room_type ON reg_rooms(room_type_id);

CREATE TABLE reg_room_assignments (
  attendee_id INTEGER PRIMARY KEY REFERENCES reg_attendees(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES reg_rooms(id) ON DELETE CASCADE,
  campus_id INTEGER NOT NULL DEFAULT 1,
  assigned_by INTEGER REFERENCES people(id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reg_room_assignments_room ON reg_room_assignments(room_id);

-- Seating: tables on one event and one seat per person.
CREATE TABLE reg_tables (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1,
  event_id INTEGER NOT NULL REFERENCES reg_events(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  seats INTEGER NOT NULL CHECK (seats > 0),
  host_attendee_id INTEGER REFERENCES reg_attendees(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, label)
);

CREATE TABLE reg_table_seats (
  attendee_id INTEGER PRIMARY KEY REFERENCES reg_attendees(id) ON DELETE CASCADE,
  table_id INTEGER NOT NULL REFERENCES reg_tables(id) ON DELETE CASCADE,
  campus_id INTEGER NOT NULL DEFAULT 1,
  seated_by INTEGER REFERENCES people(id) ON DELETE SET NULL,
  seated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reg_table_seats_table ON reg_table_seats(table_id);

-- Small groups on one event and one group per person. capacity NULL = no limit (a full group asks first).
CREATE TABLE reg_groups (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1,
  event_id INTEGER NOT NULL REFERENCES reg_events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  leader_attendee_id INTEGER REFERENCES reg_attendees(id) ON DELETE SET NULL,
  notes TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, name)
);

CREATE TABLE reg_group_members (
  attendee_id INTEGER PRIMARY KEY REFERENCES reg_attendees(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES reg_groups(id) ON DELETE CASCADE,
  campus_id INTEGER NOT NULL DEFAULT 1,
  added_by INTEGER REFERENCES people(id) ON DELETE SET NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reg_group_members_group ON reg_group_members(group_id);

-- Keep the identity merge inventory exhaustive: who placed a person stays with the person who acted.
DROP TRIGGER person_merge_registry_keys_append_only_insert;
INSERT INTO person_merge_registry_keys(reference_key,policy) VALUES
  ('reg_room_assignments.assigned_by','historical_preserve'),
  ('reg_table_seats.seated_by','historical_preserve'),
  ('reg_group_members.added_by','historical_preserve');
CREATE TRIGGER person_merge_registry_keys_append_only_insert BEFORE INSERT ON person_merge_registry_keys
BEGIN SELECT RAISE(ABORT,'person_merge_registry_keys_append_only'); END;

-- Event logistics stays off until an administrator turns it on in Settings -> Modules. A fresh database has no
-- module rows and no people yet, so setup's own module choices apply there (setup writes every module row,
-- and no preset includes this one). An explicit row is never changed.
INSERT INTO settings (key, value)
SELECT 'module.event-logistics', '0'
WHERE EXISTS (SELECT 1 FROM settings WHERE key LIKE 'module.%')
   OR EXISTS (SELECT 1 FROM people)
ON CONFLICT(key) DO NOTHING;
