-- Event Registration on D1. The Postgres schema lives in
-- migrations-supabase/0003_registration.sql (+ 0005 group_reg_events, 0027 campus_id,
-- 0041 locale foreign keys, 0042 registration v2); this creates the same final shape
-- here so Registration no longer needs Supabase. campus_id mirrors
-- 0027_multi_campus.sql (plain column with a default, no foreign key). Locale columns
-- reference supported_locales (0041) like the rebuilt translation tables in 0045-0049.
-- Paid registration (Stripe) stays Postgres-only; free registration runs on both.

CREATE TABLE reg_events (
  id INTEGER PRIMARY KEY,
  starts_at TEXT NOT NULL,          -- YYYY-MM-DD HH:MM:SS (UTC, like the rest of the app)
  ends_at TEXT,
  location TEXT,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),   -- NULL = unlimited
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0), -- NULL/0 = free
  currency TEXT NOT NULL DEFAULT 'usd',
  opens_at TEXT,                    -- NULL = open immediately
  closes_at TEXT,                   -- NULL = open until start
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1,
  visible_from TEXT,                -- NULL = visible as soon as active
  waitlist_enabled INTEGER NOT NULL DEFAULT 1 CHECK (waitlist_enabled IN (0,1)),
  confirmation_prefix TEXT CHECK (confirmation_prefix IS NULL OR (length(confirmation_prefix) BETWEEN 1 AND 6 AND confirmation_prefix NOT GLOB '*[^A-Z0-9]*')),
  next_confirmation INTEGER NOT NULL DEFAULT 1,
  poster TEXT                       -- media reference
);
CREATE INDEX idx_reg_events_campus ON reg_events(campus_id);

CREATE TABLE reg_event_i18n (
  event_id INTEGER NOT NULL REFERENCES reg_events(id) ON DELETE CASCADE,
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  title TEXT NOT NULL,
  description TEXT,
  campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (event_id, locale)
);

CREATE TABLE reg_questions (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES reg_events(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL CHECK (type IN ('text','textarea','select','checkbox','yesno','section','number','date','email','phone','terms')),
  required INTEGER NOT NULL DEFAULT 0,
  options TEXT,                      -- JSON array of strings, select/checkbox only
  campus_id INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE reg_question_i18n (
  question_id INTEGER NOT NULL REFERENCES reg_questions(id) ON DELETE CASCADE,
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  label TEXT NOT NULL,
  campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (question_id, locale)
);

CREATE TABLE registrations (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES reg_events(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','review','confirmed','waitlist','declined','cancelled')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1,
  submission_key TEXT NOT NULL,      -- idempotency key, unique per event
  confirmation_no TEXT,              -- <prefix>-<NNNN>, unique per event
  party_size INTEGER NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 50)
);
CREATE UNIQUE INDEX registrations_session ON registrations(stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX registrations_event ON registrations(event_id, status);
CREATE INDEX idx_registrations_campus ON registrations(campus_id);
CREATE UNIQUE INDEX idx_registrations_submission ON registrations(event_id, submission_key);
CREATE UNIQUE INDEX idx_registrations_confirmation ON registrations(event_id, confirmation_no)
  WHERE confirmation_no IS NOT NULL;

CREATE TABLE reg_answers (
  registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES reg_questions(id) ON DELETE CASCADE,
  value TEXT NOT NULL,               -- checkbox answers JSON-encoded array
  campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (registration_id, question_id)
);

CREATE TABLE reg_attendees (
  id INTEGER PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1,
  registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reg_attendees_registration ON reg_attendees(registration_id);
CREATE INDEX idx_reg_attendees_person ON reg_attendees(person_id);

-- Link a group to registration events.
CREATE TABLE group_reg_events (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  reg_event_id INTEGER NOT NULL REFERENCES reg_events(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_gre_pair ON group_reg_events(group_id, reg_event_id);

-- Event admins (event-scope prayer moderation) belong to Registration and now exist
-- on D1 too, in the same shape as Postgres (0009 + the campus_id of 0027).
CREATE TABLE event_admins (
  id INTEGER PRIMARY KEY,
  reg_event_id INTEGER NOT NULL REFERENCES reg_events(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  campus_id INTEGER NOT NULL DEFAULT 1,
  UNIQUE (reg_event_id, person_id)
);

-- Keep the identity merge inventory exhaustive (registrations.person_id is already
-- registered by 0033).
DROP TRIGGER person_merge_registry_keys_append_only_insert;
INSERT INTO person_merge_registry_keys(reference_key,policy) VALUES
  ('reg_attendees.person_id','subject_repoint');
CREATE TRIGGER person_merge_registry_keys_append_only_insert BEFORE INSERT ON person_merge_registry_keys
BEGIN SELECT RAISE(ABORT,'person_merge_registry_keys_append_only'); END;

-- Existing installations keep Registration off until an administrator turns it on
-- in Settings -> Modules. A fresh database has no module rows and no people yet,
-- so setup's own module choices apply there. An explicit row is never changed.
INSERT INTO settings (key, value)
SELECT 'module.registration', '0'
WHERE EXISTS (SELECT 1 FROM settings WHERE key LIKE 'module.%')
   OR EXISTS (SELECT 1 FROM people)
ON CONFLICT(key) DO NOTHING;
