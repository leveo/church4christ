-- Registration event builder (Phase 3). Postgres twin: migrations-supabase/0044_registration_builder.sql.
-- Questions can be asked once per registration or once per person, carry show-if conditions,
-- help text, placeholders and translated option labels; events can sell ticket types with their
-- own price and limit; an event can be a reusable template. Everything is a new nullable or
-- defaulted column or table, so existing events, questions and answers keep working unchanged.

ALTER TABLE reg_events ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0 CHECK (is_template IN (0,1));

ALTER TABLE reg_questions ADD COLUMN scope TEXT NOT NULL DEFAULT 'registration' CHECK (scope IN ('registration','attendee'));
ALTER TABLE reg_questions ADD COLUMN condition TEXT;          -- JSON {"q":<id>,"op":...,"value"?:...} or NULL
ALTER TABLE reg_questions ADD COLUMN max_length INTEGER CHECK (max_length IS NULL OR max_length BETWEEN 1 AND 5000);

ALTER TABLE reg_question_i18n ADD COLUMN help TEXT;
ALTER TABLE reg_question_i18n ADD COLUMN placeholder TEXT;
ALTER TABLE reg_question_i18n ADD COLUMN option_labels TEXT;  -- JSON object { optionKey: label }

-- Options now carry stable keys: reg_questions.options stays a JSON array, now of keys. Every
-- existing option string becomes its own key and is copied into option_labels for each language
-- that already has a label row, so stored answers (which hold the option string) stay valid with
-- no answer rewrite. A row whose options are not a JSON array of strings is left untouched.
UPDATE reg_question_i18n
SET option_labels = (
  SELECT json_group_object(o.value, o.value)
  FROM reg_questions q, json_each(q.options) o
  WHERE q.id = reg_question_i18n.question_id
)
WHERE question_id IN (
  SELECT q.id FROM reg_questions q
  WHERE q.options IS NOT NULL AND json_valid(q.options) AND json_type(q.options) = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(q.options) x WHERE x.type != 'text')
);

CREATE TABLE reg_ticket_types (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES reg_events(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),   -- NULL = unlimited
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  campus_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_reg_ticket_types_event ON reg_ticket_types(event_id, sort);

CREATE TABLE reg_ticket_type_i18n (
  ticket_type_id INTEGER NOT NULL REFERENCES reg_ticket_types(id) ON DELETE CASCADE,
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  label TEXT NOT NULL,
  description TEXT,
  campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ticket_type_id, locale)
);

-- SQLite accepts a foreign key on an added column when its default is NULL.
ALTER TABLE reg_attendees ADD COLUMN ticket_type_id INTEGER REFERENCES reg_ticket_types(id) ON DELETE SET NULL;
CREATE INDEX idx_reg_attendees_ticket_type ON reg_attendees(ticket_type_id);

-- Answers to attendee-scope questions: one row per person and question.
CREATE TABLE reg_attendee_answers (
  attendee_id INTEGER NOT NULL REFERENCES reg_attendees(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES reg_questions(id) ON DELETE CASCADE,
  value TEXT NOT NULL,               -- checkbox answers JSON-encoded array; terms = UTC acceptance time
  campus_id INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (attendee_id, question_id)
);
CREATE INDEX idx_reg_attendee_answers_question ON reg_attendee_answers(question_id);
