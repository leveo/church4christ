-- PostgreSQL parity for migrations/0030_identity_security_cutover.sql.
UPDATE tokens SET used_at=datetime('now') WHERE purpose='email_change' AND used_at IS NULL;
UPDATE people SET pending_email=NULL WHERE pending_email IS NOT NULL;

ALTER TABLE identity_challenges ADD COLUMN expected_session_epoch INTEGER
  CHECK (expected_session_epoch IS NULL OR expected_session_epoch BETWEEN 0 AND 2147483646);
ALTER TABLE tokens ADD COLUMN expected_session_epoch INTEGER
  CHECK (expected_session_epoch IS NULL OR expected_session_epoch BETWEEN 0 AND 2147483646);
ALTER TABLE identity_session_delivery_claims ADD COLUMN session_epoch INTEGER
  CHECK (session_epoch IS NULL OR session_epoch BETWEEN 0 AND 2147483646);
ALTER TABLE identity_account_operations ADD COLUMN result_session_epoch INTEGER
  CHECK (result_session_epoch IS NULL OR result_session_epoch BETWEEN 0 AND 2147483646);
UPDATE identity_challenges c SET expected_session_epoch=p.session_epoch FROM people p WHERE p.id=c.person_id AND c.expected_session_epoch IS NULL;
UPDATE tokens t SET expected_session_epoch=p.session_epoch FROM people p WHERE p.id=t.person_id AND t.purpose='login' AND t.expected_session_epoch IS NULL;
CREATE FUNCTION identity_challenge_epoch_consumption_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND OLD.person_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM people p WHERE p.id=OLD.person_id AND p.session_epoch=OLD.expected_session_epoch AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL) THEN
    RAISE EXCEPTION 'identity_credential_epoch_stale';
  END IF; RETURN NEW;
END; $$;
CREATE TRIGGER identity_challenge_epoch_consumption_guard BEFORE UPDATE OF consumed_at ON identity_challenges
FOR EACH ROW EXECUTE FUNCTION identity_challenge_epoch_consumption_guard_fn();
CREATE FUNCTION legacy_login_token_epoch_consumption_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL AND OLD.purpose='login' AND NOT EXISTS
    (SELECT 1 FROM people p WHERE p.id=OLD.person_id AND p.session_epoch=OLD.expected_session_epoch AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL) THEN
    RAISE EXCEPTION 'identity_credential_epoch_stale';
  END IF; RETURN NEW;
END; $$;
CREATE TRIGGER legacy_login_token_epoch_consumption_guard BEFORE UPDATE OF used_at ON tokens
FOR EACH ROW EXECUTE FUNCTION legacy_login_token_epoch_consumption_guard_fn();
CREATE FUNCTION identity_session_delivery_epoch_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity_account_operations op WHERE op.operation_id=NEW.operation_id
    AND op.result_person_id=NEW.person_id AND op.result_session_epoch=NEW.session_epoch) THEN
    RAISE EXCEPTION 'identity_session_delivery_epoch_stale';
  END IF; RETURN NEW;
END; $$;
CREATE TRIGGER identity_session_delivery_epoch_guard BEFORE INSERT ON identity_session_delivery_claims
FOR EACH ROW EXECUTE FUNCTION identity_session_delivery_epoch_guard_fn();

CREATE FUNCTION identity_legacy_email_change_token_retired_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purpose='email_change' THEN RAISE EXCEPTION 'identity_legacy_email_change_retired'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER identity_legacy_email_change_token_insert_retired
BEFORE INSERT ON tokens
FOR EACH ROW EXECUTE FUNCTION identity_legacy_email_change_token_retired_fn();
CREATE TRIGGER identity_legacy_email_change_token_update_retired
BEFORE UPDATE OF purpose ON tokens
FOR EACH ROW EXECUTE FUNCTION identity_legacy_email_change_token_retired_fn();
CREATE FUNCTION identity_legacy_pending_email_retired_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pending_email IS NOT NULL THEN RAISE EXCEPTION 'identity_legacy_pending_email_retired'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER identity_legacy_pending_email_insert_retired
BEFORE INSERT ON people
FOR EACH ROW EXECUTE FUNCTION identity_legacy_pending_email_retired_fn();
CREATE TRIGGER identity_legacy_pending_email_update_retired
BEFORE UPDATE OF pending_email ON people
FOR EACH ROW EXECUTE FUNCTION identity_legacy_pending_email_retired_fn();
