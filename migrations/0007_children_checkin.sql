-- Children's check-in: kiosk events and per-child check-in records.
-- Children are household_members rows with role='child' (see 0003_people.sql).

CREATE TABLE checkin_events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  weekday INTEGER CHECK (weekday BETWEEN 0 AND 6), -- 0=Sunday; NULL = offered every day
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE checkins (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES checkin_events(id),
  household_id INTEGER NOT NULL REFERENCES households(id),
  household_member_id INTEGER NOT NULL REFERENCES household_members(id),
  child_name TEXT NOT NULL,      -- snapshot; history survives renames/removals
  security_code TEXT NOT NULL,   -- shared per household+event+date
  checkin_date TEXT NOT NULL,    -- YYYY-MM-DD, church-local (todayInTz)
  checked_in_at TEXT NOT NULL DEFAULT (datetime('now')),
  checked_out_at TEXT
);

CREATE UNIQUE INDEX idx_checkins_once_per_day
  ON checkins(event_id, household_member_id, checkin_date);
CREATE INDEX idx_checkins_date ON checkins(checkin_date);
