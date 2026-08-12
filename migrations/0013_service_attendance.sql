-- Aggregate service attendance. Adult attendance is deliberately aggregate-only:
-- there is no adult roster, person identity, anonymous key, child count, or
-- newcomer count in this table. Child totals are derived from historical checkins.
CREATE TABLE service_attendance (
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  attendance_date TEXT NOT NULL
    CHECK (
      length(attendance_date) = 10 AND substr(attendance_date, 5, 1) = '-' AND substr(attendance_date, 8, 1) = '-' AND
      substr(attendance_date, 6, 2) BETWEEN '01' AND '12' AND substr(attendance_date, 9, 2) BETWEEN '01' AND '31' AND
      (substr(attendance_date, 6, 2) NOT IN ('04','06','09','11') OR substr(attendance_date, 9, 2) <= '30') AND
      (substr(attendance_date, 6, 2) <> '02' OR substr(attendance_date, 9, 2) <= '29') AND
      date(attendance_date, '+0 days') = attendance_date
    ),
  adult_count INTEGER NOT NULL CHECK (adult_count BETWEEN 0 AND 100000),
  recorded_by_person_id INTEGER NOT NULL REFERENCES people(id),
  updated_by_person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (service_type_id, attendance_date)
) WITHOUT ROWID;

-- Append/close-only history linking a service type to one or more children's
-- check-in events (rooms). Effective ranges are half-open [starts_on, ends_on).
-- A same-day zero-length row is a retained cancellation and is never effective.
CREATE TABLE service_type_checkin_events (
  id INTEGER PRIMARY KEY,
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  checkin_event_id INTEGER NOT NULL REFERENCES checkin_events(id),
  starts_on TEXT NOT NULL
    CHECK (
      length(starts_on) = 10 AND substr(starts_on, 5, 1) = '-' AND substr(starts_on, 8, 1) = '-' AND
      substr(starts_on, 6, 2) BETWEEN '01' AND '12' AND substr(starts_on, 9, 2) BETWEEN '01' AND '31' AND
      (substr(starts_on, 6, 2) NOT IN ('04','06','09','11') OR substr(starts_on, 9, 2) <= '30') AND
      (substr(starts_on, 6, 2) <> '02' OR substr(starts_on, 9, 2) <= '29') AND
      date(starts_on, '+0 days') = starts_on
    ),
  ends_on TEXT
    CHECK (ends_on IS NULL OR (
      length(ends_on) = 10 AND substr(ends_on, 5, 1) = '-' AND substr(ends_on, 8, 1) = '-' AND
      substr(ends_on, 6, 2) BETWEEN '01' AND '12' AND substr(ends_on, 9, 2) BETWEEN '01' AND '31' AND
      (substr(ends_on, 6, 2) NOT IN ('04','06','09','11') OR substr(ends_on, 9, 2) <= '30') AND
      (substr(ends_on, 6, 2) <> '02' OR substr(ends_on, 9, 2) <= '29') AND
      date(ends_on, '+0 days') = ends_on AND ends_on >= starts_on
    )),
  created_by_person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_by_person_id INTEGER REFERENCES people(id),
  closed_at TEXT,
  CHECK (
    (ends_on IS NULL AND closed_by_person_id IS NULL AND closed_at IS NULL) OR
    (ends_on IS NOT NULL AND closed_by_person_id IS NOT NULL AND closed_at IS NOT NULL)
  )
);

-- Service-level compare-and-swap state. A random per-request mutation id gates
-- every statement in a replacement batch, so two requests that read the same
-- revision cannot merge divergent target sets: exactly one owns the mutation.
CREATE TABLE service_checkin_link_state (
  service_type_id INTEGER PRIMARY KEY REFERENCES service_types(id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_mutation_id TEXT NOT NULL DEFAULT '' CHECK (length(last_mutation_id) <= 64)
) WITHOUT ROWID;

-- One range may begin for a pair on a date only once. This is also the
-- concurrency backstop for two same-day replacements racing to insert.
CREATE UNIQUE INDEX idx_service_checkin_links_start
  ON service_type_checkin_events(service_type_id, checkin_event_id, starts_on);
CREATE UNIQUE INDEX idx_service_checkin_links_one_open
  ON service_type_checkin_events(service_type_id, checkin_event_id)
  WHERE ends_on IS NULL;
CREATE INDEX idx_service_checkin_links_dates
  ON service_type_checkin_events(service_type_id, starts_on, ends_on, checkin_event_id);

CREATE TRIGGER service_checkin_links_no_overlap_insert
BEFORE INSERT ON service_type_checkin_events
WHEN NEW.ends_on IS NULL OR NEW.ends_on > NEW.starts_on
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM service_type_checkin_events existing
    WHERE existing.service_type_id = NEW.service_type_id
      AND existing.checkin_event_id = NEW.checkin_event_id
      AND (existing.ends_on IS NULL OR existing.ends_on > existing.starts_on)
      AND existing.starts_on < COALESCE(NEW.ends_on, '9999-12-31')
      AND (existing.ends_on IS NULL OR existing.ends_on > NEW.starts_on)
  ) THEN RAISE(ABORT, 'service_attendance_link_conflict') END;
END;

-- Existing history can only transition once from open to closed. Pair, start,
-- creator, and creation timestamp are immutable; reopening/moving is forbidden.
CREATE TRIGGER service_checkin_links_close_only
BEFORE UPDATE ON service_type_checkin_events
WHEN NOT (
  OLD.ends_on IS NULL AND NEW.ends_on IS NOT NULL AND
  NEW.id IS OLD.id AND
  NEW.service_type_id IS OLD.service_type_id AND
  NEW.checkin_event_id IS OLD.checkin_event_id AND
  NEW.starts_on IS OLD.starts_on AND
  NEW.created_by_person_id IS OLD.created_by_person_id AND
  NEW.created_at IS OLD.created_at AND
  NEW.closed_by_person_id IS NOT NULL AND NEW.closed_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'service_attendance_link_immutable');
END;

CREATE TRIGGER service_checkin_links_no_delete
BEFORE DELETE ON service_type_checkin_events
BEGIN
  SELECT RAISE(ABORT, 'service_attendance_link_immutable');
END;
