-- identity recovery notification outbox
--
-- Replaces the hard-coded CHECK (locale IN ('en','zh')) on identity_recovery_notification_outbox.locale with a
-- foreign key to supported_locales (0041), so a new language is an INSERT rather than a
-- schema change. Row data, column order, indexes and triggers are unchanged.
-- SQLite cannot alter a CHECK, so each table is rebuilt: its rows are copied aside, the
-- table is dropped and recreated under its own name (never renamed, so foreign keys and
-- triggers in other tables keep resolving), the rows are copied back, and every index and
-- trigger is recreated verbatim.
--
-- D1 enforces foreign keys and ignores PRAGMA foreign_keys = OFF, so deferring the check
-- lets the parent be recreated inside this migration's transaction.
-- Back up before applying (docs/upgrade.md). There is no down migration.

PRAGMA defer_foreign_keys = ON;

-- identity_recovery_notification_outbox
CREATE TABLE _locale_bak_identity_recovery_notification_outbox AS SELECT id, case_id, category, contact_point_id, recipient_hash, locale, payload_key_id, payload_ciphertext, state, attempt_count, lease_token_hash, lease_expires_at, last_error_code, created_at, sent_at FROM identity_recovery_notification_outbox;
DROP TABLE identity_recovery_notification_outbox;
CREATE TABLE identity_recovery_notification_outbox (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES identity_recovery_cases(id),
  category TEXT NOT NULL CHECK (category IN ('request_old_contact','hold_old_contact','completed_old_contact')),
  contact_point_id INTEGER NOT NULL REFERENCES contact_points(id),
  recipient_hash TEXT NOT NULL CHECK (length(recipient_hash)=64 AND recipient_hash=lower(recipient_hash) AND recipient_hash NOT GLOB '*[^0-9a-f]*'),
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  payload_key_id TEXT,
  payload_ciphertext TEXT CHECK (payload_ciphertext IS NULL OR length(payload_ciphertext) BETWEEN 32 AND 1024),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','sent','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  lease_token_hash TEXT CHECK (lease_token_hash IS NULL OR (length(lease_token_hash)=64 AND lease_token_hash=lower(lease_token_hash) AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
  lease_expires_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code IN ('send_failed','payload_invalid')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  UNIQUE(case_id,category,contact_point_id),
  UNIQUE(case_id,category,recipient_hash),
  CHECK ((state='claimed')=(lease_token_hash IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state='sent')=(sent_at IS NOT NULL)),
  CHECK ((category='hold_old_contact')=(payload_ciphertext IS NOT NULL AND payload_key_id IS NOT NULL))
);
INSERT INTO identity_recovery_notification_outbox (id, case_id, category, contact_point_id, recipient_hash, locale, payload_key_id, payload_ciphertext, state, attempt_count, lease_token_hash, lease_expires_at, last_error_code, created_at, sent_at)
  SELECT id, case_id, category, contact_point_id, recipient_hash, locale, payload_key_id, payload_ciphertext, state, attempt_count, lease_token_hash, lease_expires_at, last_error_code, created_at, sent_at FROM _locale_bak_identity_recovery_notification_outbox;
CREATE INDEX idx_identity_recovery_notification_outbox_ready ON identity_recovery_notification_outbox(state,lease_expires_at,case_id,id);
CREATE TRIGGER identity_recovery_notification_outbox_insert_receipt AFTER INSERT ON identity_recovery_notification_outbox
BEGIN INSERT INTO identity_recovery_notification_receipts(outbox_id,event,attempt) VALUES(NEW.id,'pending',0); END;
CREATE TRIGGER identity_recovery_notification_outbox_transition_guard BEFORE UPDATE ON identity_recovery_notification_outbox
WHEN OLD.case_id IS NOT NEW.case_id OR OLD.category IS NOT NEW.category OR OLD.contact_point_id IS NOT NEW.contact_point_id
  OR OLD.recipient_hash IS NOT NEW.recipient_hash OR OLD.locale IS NOT NEW.locale OR OLD.payload_key_id IS NOT NEW.payload_key_id
  OR OLD.payload_ciphertext IS NOT NEW.payload_ciphertext
  OR OLD.created_at IS NOT NEW.created_at OR NOT (
    (OLD.state IN ('pending','failed') AND NEW.state='claimed' AND NEW.attempt_count=OLD.attempt_count+1)
    OR (OLD.state='claimed' AND OLD.lease_expires_at<=datetime('now') AND NEW.state='claimed' AND NEW.attempt_count=OLD.attempt_count+1)
    OR (OLD.state='claimed' AND NEW.state IN ('sent','failed') AND NEW.attempt_count=OLD.attempt_count)
  )
BEGIN SELECT RAISE(ABORT,'identity_recovery_notification_transition_guard'); END;
CREATE TRIGGER identity_recovery_notification_outbox_transition_receipt AFTER UPDATE OF state ON identity_recovery_notification_outbox
BEGIN INSERT INTO identity_recovery_notification_receipts(outbox_id,event,attempt,error_code)
  VALUES(NEW.id,NEW.state,NEW.attempt_count,NEW.last_error_code); END;
CREATE TRIGGER identity_recovery_notification_outbox_delete_guard BEFORE DELETE ON identity_recovery_notification_outbox
BEGIN SELECT RAISE(ABORT,'identity_recovery_notification_outbox_delete_guard'); END;
DROP TABLE _locale_bak_identity_recovery_notification_outbox;
