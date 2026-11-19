-- Registration party flow (Phase 2). Postgres twin: migrations-supabase/0043_registration_party.sql.
-- A registration can now cover a small party (reg_attendees already holds one row per person),
-- carries the registrant's language and phone, and has a private manage link whose token is
-- stored only as a SHA-256 hash. Everything here is a new nullable or defaulted column, so
-- existing rows need no backfill: every event keeps max_party_size 1 (single-person
-- registration) and self-service on, and existing registrations simply have no manage link.

ALTER TABLE reg_events ADD COLUMN max_party_size INTEGER NOT NULL DEFAULT 1 CHECK (max_party_size BETWEEN 1 AND 20);
ALTER TABLE reg_events ADD COLUMN allow_self_edit INTEGER NOT NULL DEFAULT 1 CHECK (allow_self_edit IN (0,1));

ALTER TABLE reg_event_i18n ADD COLUMN notes TEXT;

ALTER TABLE registrations ADD COLUMN manage_token_hash TEXT;
CREATE UNIQUE INDEX idx_registrations_manage_token ON registrations(manage_token_hash)
  WHERE manage_token_hash IS NOT NULL;
-- SQLite accepts a foreign key on an added column when its default is NULL.
ALTER TABLE registrations ADD COLUMN locale TEXT REFERENCES supported_locales(code);
ALTER TABLE registrations ADD COLUMN phone TEXT;
ALTER TABLE registrations ADD COLUMN confirmation_sent_at TEXT;
ALTER TABLE registrations ADD COLUMN cancelled_at TEXT;

-- The guest continuation keeps the party (phone + attendee names) next to the answers and
-- digests it into the intent, so the guest path is immutable like the rest of its payload.
ALTER TABLE identity_registration_continuations ADD COLUMN party_json TEXT;
DROP TRIGGER identity_registration_continuation_identity_immutable;
CREATE TRIGGER identity_registration_continuation_identity_immutable
BEFORE UPDATE OF intent_id,event_id,amount_cents,currency,locale,answers_json,question_digest,checkout_request_id,party_json
ON identity_registration_continuations
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_immutable'); END;
