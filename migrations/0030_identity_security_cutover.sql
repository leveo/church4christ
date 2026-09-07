-- Retire the legacy pending_email/token email-change flow. New account changes
-- use identity_account_operations + contact ownership proofs instead.
UPDATE tokens SET used_at=datetime('now') WHERE purpose='email_change' AND used_at IS NULL;
UPDATE people SET pending_email=NULL WHERE pending_email IS NOT NULL;

-- Credential epoch snapshots linearize authentication with global sign-out.
ALTER TABLE identity_challenges ADD COLUMN expected_session_epoch INTEGER
  CHECK (expected_session_epoch IS NULL OR expected_session_epoch BETWEEN 0 AND 2147483646);
ALTER TABLE tokens ADD COLUMN expected_session_epoch INTEGER
  CHECK (expected_session_epoch IS NULL OR expected_session_epoch BETWEEN 0 AND 2147483646);
ALTER TABLE identity_session_delivery_claims ADD COLUMN session_epoch INTEGER
  CHECK (session_epoch IS NULL OR session_epoch BETWEEN 0 AND 2147483646);
ALTER TABLE identity_account_operations ADD COLUMN result_session_epoch INTEGER
  CHECK (result_session_epoch IS NULL OR result_session_epoch BETWEEN 0 AND 2147483646);
UPDATE identity_challenges SET expected_session_epoch=(SELECT p.session_epoch FROM people p WHERE p.id=identity_challenges.person_id)
  WHERE person_id IS NOT NULL AND expected_session_epoch IS NULL;
UPDATE tokens SET expected_session_epoch=(SELECT p.session_epoch FROM people p WHERE p.id=tokens.person_id)
  WHERE purpose='login' AND expected_session_epoch IS NULL;
CREATE TRIGGER identity_challenge_epoch_consumption_guard
BEFORE UPDATE OF consumed_at ON identity_challenges
WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND OLD.person_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id=OLD.person_id AND p.session_epoch=OLD.expected_session_epoch
    AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'identity_credential_epoch_stale'); END;
CREATE TRIGGER legacy_login_token_epoch_consumption_guard
BEFORE UPDATE OF used_at ON tokens
WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL AND OLD.purpose='login'
  AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id=OLD.person_id AND p.session_epoch=OLD.expected_session_epoch
    AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'identity_credential_epoch_stale'); END;
CREATE TRIGGER identity_session_delivery_epoch_guard
BEFORE INSERT ON identity_session_delivery_claims
WHEN NOT EXISTS (SELECT 1 FROM identity_account_operations op
  WHERE op.operation_id=NEW.operation_id AND op.result_person_id=NEW.person_id
    AND op.result_session_epoch=NEW.session_epoch)
BEGIN SELECT RAISE(ABORT, 'identity_session_delivery_epoch_stale'); END;

-- Defense in depth: old binaries, imports, or direct SQL cannot recreate the
-- retired flow after the data cleanup above.
CREATE TRIGGER identity_legacy_email_change_token_insert_retired
BEFORE INSERT ON tokens
WHEN NEW.purpose='email_change'
BEGIN SELECT RAISE(ABORT, 'identity_legacy_email_change_retired'); END;
CREATE TRIGGER identity_legacy_email_change_token_update_retired
BEFORE UPDATE OF purpose ON tokens
WHEN NEW.purpose='email_change'
BEGIN SELECT RAISE(ABORT, 'identity_legacy_email_change_retired'); END;
CREATE TRIGGER identity_legacy_pending_email_insert_retired
BEFORE INSERT ON people
WHEN NEW.pending_email IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'identity_legacy_pending_email_retired'); END;
CREATE TRIGGER identity_legacy_pending_email_update_retired
BEFORE UPDATE OF pending_email ON people
WHEN NEW.pending_email IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'identity_legacy_pending_email_retired'); END;
