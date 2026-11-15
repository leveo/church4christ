-- newcomer submissions
--
-- Replaces the hard-coded CHECK (locale IN ('en','zh')) on newcomer_submissions.locale with a
-- foreign key to supported_locales (0041), so a new language is an INSERT rather than a
-- schema change. Row data, column order, indexes and triggers are unchanged.
-- SQLite cannot alter a CHECK, so each table is rebuilt: its rows are copied aside, the
-- table is dropped and recreated under its own name (never renamed, so foreign keys and
-- triggers in other tables keep resolving), the rows are copied back, and every index and
-- trigger is recreated verbatim.
--
-- newcomer_answers, newcomer_notes and newcomer_activity reference newcomer_submissions with
-- ON DELETE CASCADE, so dropping the parent would delete their rows. Their rows are copied
-- aside first and restored after the parent is recreated.
--
-- D1 enforces foreign keys and ignores PRAGMA foreign_keys = OFF, so deferring the check
-- lets the parent be recreated inside this migration's transaction.
-- Back up before applying (docs/upgrade.md). There is no down migration.

PRAGMA defer_foreign_keys = ON;

-- newcomer_submissions
CREATE TABLE _locale_bak_newcomer_submissions AS SELECT id, name, email, phone, locale, visit_date, service_type_id, contact_consent_at, source, status_id, assignee_person_id, linked_person_id, next_follow_up_date, version, last_mutation_id, closed_at, deleted_at, created_at, updated_at, campus_id, identity_source_record_id FROM newcomer_submissions;
CREATE TABLE _locale_bak_newcomer_answers AS SELECT submission_id, field_id, value, campus_id FROM newcomer_answers;
CREATE TABLE _locale_bak_newcomer_notes AS SELECT id, submission_id, author_person_id, body, created_at, campus_id FROM newcomer_notes;
CREATE TABLE _locale_bak_newcomer_activity AS SELECT id, submission_id, actor_person_id, kind, metadata_json, operation_id, result_version, created_at, campus_id FROM newcomer_activity;
DROP TABLE newcomer_submissions;
CREATE TABLE newcomer_submissions (
  id TEXT PRIMARY KEY
    CHECK (
      instr(id,char(0)) = 0 AND length(CAST(id AS BLOB)) = 36 AND id = lower(id) AND
      substr(id,9,1) = '-' AND substr(id,14,1) = '-' AND
      substr(id,19,1) = '-' AND substr(id,24,1) = '-' AND
      length(replace(id,'-','')) = 32 AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  name TEXT CHECK (name IS NULL OR (
    instr(name,char(0)) = 0 AND name = trim(name) AND length(CAST(name AS BLOB)) BETWEEN 1 AND 200
  )),
  email TEXT CHECK (
    email IS NULL OR (
      email = lower(trim(email)) AND length(CAST(email AS BLOB)) BETWEEN 3 AND 254 AND
      instr(email,'@') BETWEEN 2 AND length(email) - 1 AND
      instr(substr(email,instr(email,'@') + 1),'@') = 0 AND
      substr(email,1,instr(email,'@') - 1) NOT GLOB '*[^a-z0-9.!#$%&''*+/=?^_`{|}~-]*' AND
      substr(email,1,instr(email,'@') - 1) NOT GLOB '.*' AND
      substr(email,1,instr(email,'@') - 1) NOT GLOB '*.' AND
      substr(email,1,instr(email,'@') - 1) NOT GLOB '*..*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*[^a-z0-9.-]*' AND
      substr(email,instr(email,'@') + 1) GLOB '*.*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '.*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*.' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '-*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*-' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*..*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*.-*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*-.*'
    )
  ),
  phone TEXT CHECK (
    phone IS NULL OR (
      instr(phone,char(0)) = 0 AND length(CAST(phone AS BLOB)) BETWEEN 8 AND 16 AND substr(phone,1,1) = '+' AND
      substr(phone,2,1) GLOB '[1-9]' AND substr(phone,2) NOT GLOB '*[^0-9]*'
    )
  ),
  locale TEXT NOT NULL CHECK (instr(locale,char(0)) = 0) REFERENCES supported_locales(code),
  visit_date TEXT NOT NULL
    CHECK (
      instr(visit_date,char(0)) = 0 AND length(CAST(visit_date AS BLOB)) = 10 AND
      substr(visit_date,5,1) = '-' AND substr(visit_date,8,1) = '-' AND
      substr(visit_date,1,4) BETWEEN '0001' AND '9999' AND
      substr(visit_date,6,2) BETWEEN '01' AND '12' AND substr(visit_date,9,2) BETWEEN '01' AND '31' AND
      (substr(visit_date,6,2) NOT IN ('04','06','09','11') OR substr(visit_date,9,2) <= '30') AND
      (substr(visit_date,6,2) <> '02' OR substr(visit_date,9,2) <= '29') AND
      (date(visit_date,'+0 days') = visit_date) IS TRUE
    ),
  service_type_id INTEGER REFERENCES service_types(id) ON DELETE SET NULL,
  contact_consent_at TEXT
    CHECK (contact_consent_at IS NULL OR (
      instr(contact_consent_at,char(0)) = 0 AND length(CAST(contact_consent_at AS BLOB)) = 19 AND
      substr(contact_consent_at,5,1) = '-' AND
      substr(contact_consent_at,8,1) = '-' AND substr(contact_consent_at,11,1) = ' ' AND
      substr(contact_consent_at,14,1) = ':' AND substr(contact_consent_at,17,1) = ':' AND
      substr(contact_consent_at,1,4) BETWEEN '0001' AND '9999' AND
      substr(contact_consent_at,12,2) BETWEEN '00' AND '23' AND
      substr(contact_consent_at,15,2) BETWEEN '00' AND '59' AND
      substr(contact_consent_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(contact_consent_at,1,10),'+0 days') = substr(contact_consent_at,1,10)) IS TRUE AND
      (datetime(contact_consent_at,'+0 seconds') = contact_consent_at) IS TRUE
    )),
  source TEXT NOT NULL CHECK (instr(source,char(0)) = 0 AND source IN ('public','staff')),
  status_id INTEGER NOT NULL DEFAULT 1 REFERENCES newcomer_statuses(id) ON DELETE RESTRICT,
  assignee_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  linked_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  next_follow_up_date TEXT
    CHECK (next_follow_up_date IS NULL OR (
      instr(next_follow_up_date,char(0)) = 0 AND length(CAST(next_follow_up_date AS BLOB)) = 10 AND
      substr(next_follow_up_date,5,1) = '-' AND substr(next_follow_up_date,8,1) = '-' AND
      substr(next_follow_up_date,1,4) BETWEEN '0001' AND '9999' AND
      substr(next_follow_up_date,6,2) BETWEEN '01' AND '12' AND substr(next_follow_up_date,9,2) BETWEEN '01' AND '31' AND
      (substr(next_follow_up_date,6,2) NOT IN ('04','06','09','11') OR substr(next_follow_up_date,9,2) <= '30') AND
      (substr(next_follow_up_date,6,2) <> '02' OR substr(next_follow_up_date,9,2) <= '29') AND
      (date(next_follow_up_date,'+0 days') = next_follow_up_date) IS TRUE
    )),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 2147483647),
  last_mutation_id TEXT CHECK (last_mutation_id IS NULL OR (
    instr(last_mutation_id,char(0)) = 0 AND length(CAST(last_mutation_id AS BLOB)) BETWEEN 1 AND 64
  )),
  closed_at TEXT
    CHECK (closed_at IS NULL OR (
      instr(closed_at,char(0)) = 0 AND length(CAST(closed_at AS BLOB)) = 19 AND
      substr(closed_at,5,1) = '-' AND substr(closed_at,8,1) = '-' AND
      substr(closed_at,11,1) = ' ' AND substr(closed_at,14,1) = ':' AND substr(closed_at,17,1) = ':' AND
      substr(closed_at,1,4) BETWEEN '0001' AND '9999' AND substr(closed_at,12,2) BETWEEN '00' AND '23' AND
      substr(closed_at,15,2) BETWEEN '00' AND '59' AND substr(closed_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(closed_at,1,10),'+0 days') = substr(closed_at,1,10)) IS TRUE AND
      (datetime(closed_at,'+0 seconds') = closed_at) IS TRUE
    )),
  deleted_at TEXT
    CHECK (deleted_at IS NULL OR (
      instr(deleted_at,char(0)) = 0 AND length(CAST(deleted_at AS BLOB)) = 19 AND
      substr(deleted_at,5,1) = '-' AND substr(deleted_at,8,1) = '-' AND
      substr(deleted_at,11,1) = ' ' AND substr(deleted_at,14,1) = ':' AND substr(deleted_at,17,1) = ':' AND
      substr(deleted_at,1,4) BETWEEN '0001' AND '9999' AND substr(deleted_at,12,2) BETWEEN '00' AND '23' AND
      substr(deleted_at,15,2) BETWEEN '00' AND '59' AND substr(deleted_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(deleted_at,1,10),'+0 days') = substr(deleted_at,1,10)) IS TRUE AND
      (datetime(deleted_at,'+0 seconds') = deleted_at) IS TRUE
    )),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (
      instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) = 19 AND
      substr(created_at,5,1) = '-' AND substr(created_at,8,1) = '-' AND
      substr(created_at,11,1) = ' ' AND substr(created_at,14,1) = ':' AND substr(created_at,17,1) = ':' AND
      substr(created_at,1,4) BETWEEN '0001' AND '9999' AND substr(created_at,12,2) BETWEEN '00' AND '23' AND
      substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(created_at,1,10),'+0 days') = substr(created_at,1,10)) IS TRUE AND
      (datetime(created_at,'+0 seconds') = created_at) IS TRUE
    ),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (
      instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) = 19 AND
      substr(updated_at,5,1) = '-' AND substr(updated_at,8,1) = '-' AND
      substr(updated_at,11,1) = ' ' AND substr(updated_at,14,1) = ':' AND substr(updated_at,17,1) = ':' AND
      substr(updated_at,1,4) BETWEEN '0001' AND '9999' AND substr(updated_at,12,2) BETWEEN '00' AND '23' AND
      substr(updated_at,15,2) BETWEEN '00' AND '59' AND substr(updated_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(updated_at,1,10),'+0 days') = substr(updated_at,1,10)) IS TRUE AND
      (datetime(updated_at,'+0 seconds') = updated_at) IS TRUE
    ), campus_id INTEGER NOT NULL DEFAULT 1, identity_source_record_id INTEGER REFERENCES identity_source_records(id),
  CHECK (name IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL)
) WITHOUT ROWID;
INSERT INTO newcomer_submissions (id, name, email, phone, locale, visit_date, service_type_id, contact_consent_at, source, status_id, assignee_person_id, linked_person_id, next_follow_up_date, version, last_mutation_id, closed_at, deleted_at, created_at, updated_at, campus_id, identity_source_record_id)
  SELECT id, name, email, phone, locale, visit_date, service_type_id, contact_consent_at, source, status_id, assignee_person_id, linked_person_id, next_follow_up_date, version, last_mutation_id, closed_at, deleted_at, created_at, updated_at, campus_id, identity_source_record_id FROM _locale_bak_newcomer_submissions;
INSERT INTO newcomer_answers (submission_id, field_id, value, campus_id)
  SELECT submission_id, field_id, value, campus_id FROM _locale_bak_newcomer_answers;
INSERT INTO newcomer_notes (id, submission_id, author_person_id, body, created_at, campus_id)
  SELECT id, submission_id, author_person_id, body, created_at, campus_id FROM _locale_bak_newcomer_notes;
INSERT INTO newcomer_activity (id, submission_id, actor_person_id, kind, metadata_json, operation_id, result_version, created_at, campus_id)
  SELECT id, submission_id, actor_person_id, kind, metadata_json, operation_id, result_version, created_at, campus_id FROM _locale_bak_newcomer_activity;
CREATE INDEX idx_newcomer_submissions_status_follow_up
  ON newcomer_submissions(status_id, next_follow_up_date, updated_at, id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_newcomer_submissions_assignee
  ON newcomer_submissions(assignee_person_id, status_id, updated_at, id)
  WHERE assignee_person_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_newcomer_submissions_visit_date
  ON newcomer_submissions(visit_date, created_at, id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_newcomer_submissions_email
  ON newcomer_submissions(email, id)
  WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_newcomer_submissions_phone
  ON newcomer_submissions(phone, id)
  WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_newcomer_submissions_linked_person
  ON newcomer_submissions(linked_person_id, id)
  WHERE linked_person_id IS NOT NULL;
CREATE UNIQUE INDEX idx_newcomer_submissions_last_mutation
  ON newcomer_submissions(last_mutation_id)
  WHERE last_mutation_id IS NOT NULL;
CREATE INDEX idx_newcomer_submissions_campus ON newcomer_submissions (campus_id);
CREATE UNIQUE INDEX idx_newcomer_submissions_identity_source ON newcomer_submissions(identity_source_record_id)
  WHERE identity_source_record_id IS NOT NULL;
CREATE TRIGGER identity_newcomer_submission_binding_guard
BEFORE INSERT ON newcomer_submissions WHEN NEW.identity_source_record_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM identity_source_records s WHERE s.id=NEW.identity_source_record_id AND s.campus_id=NEW.campus_id
    AND s.source='newcomer' AND s.attachment_policy='observation_only' AND s.state='unlinked'
    AND s.provisional_person_id=NEW.linked_person_id
)
BEGIN SELECT RAISE(ABORT,'identity_newcomer_submission_binding_invalid'); END;
CREATE TRIGGER identity_newcomer_submission_binding_update_guard
BEFORE UPDATE OF identity_source_record_id,linked_person_id,campus_id ON newcomer_submissions
WHEN ((OLD.identity_source_record_id IS NULL AND NEW.identity_source_record_id IS NOT NULL)
  OR (OLD.identity_source_record_id IS NOT NULL AND (
    NEW.identity_source_record_id IS NOT OLD.identity_source_record_id OR NEW.linked_person_id IS NOT OLD.linked_person_id
    OR NEW.campus_id IS NOT OLD.campus_id)))
AND NOT EXISTS (SELECT 1 FROM person_merge_operations op JOIN person_merge_mutation_receipts receipt
    ON receipt.operation_id=op.operation_id AND receipt.reference_key='newcomer_submissions.linked_person_id'
    JOIN person_merge_reference_facts fact ON fact.operation_id=op.operation_id
      AND fact.reference_key=receipt.reference_key AND fact.row_key_hash=receipt.row_key_hash
  WHERE op.state='executing' AND op.loser_person_id=OLD.linked_person_id
    AND op.canonical_person_id=NEW.linked_person_id
    AND NEW.identity_source_record_id IS OLD.identity_source_record_id AND NEW.campus_id=OLD.campus_id
    AND fact.side='loser' AND fact.local_row_id=OLD.id)
AND NOT EXISTS (SELECT 1 FROM person_merge_rollback_operations rollback
  JOIN person_merge_operations op ON op.operation_id=rollback.operation_id
  JOIN person_merge_rollback_receipts receipt ON receipt.rollback_id=rollback.rollback_id AND receipt.outcome='reverted'
  JOIN person_merge_reassignment_journal journal ON journal.operation_id=op.operation_id AND journal.journal_id=receipt.journal_id
  JOIN person_merge_journal_row_details detail ON detail.operation_id=journal.operation_id AND detail.journal_id=journal.journal_id
  WHERE rollback.state='executing' AND journal.reference_key='newcomer_submissions.linked_person_id'
    AND op.canonical_person_id=OLD.linked_person_id AND op.loser_person_id=NEW.linked_person_id
    AND NEW.identity_source_record_id IS OLD.identity_source_record_id AND NEW.campus_id=OLD.campus_id
    AND detail.after_local_row_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'identity_newcomer_submission_binding_immutable'); END;
DROP TABLE _locale_bak_newcomer_submissions;
DROP TABLE _locale_bak_newcomer_answers;
DROP TABLE _locale_bak_newcomer_notes;
DROP TABLE _locale_bak_newcomer_activity;
