-- identity giving and registration continuations
--
-- Replaces the hard-coded CHECK (locale IN ('en','zh')) on identity_giving_checkout_continuations and identity_registration_continuations with a
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

-- identity_giving_checkout_continuations
CREATE TABLE _locale_bak_identity_giving_checkout_continuations AS SELECT intent_id, fund_id, amount_cents, currency, locale, checkout_request_id, stripe_session_id, stripe_session_url, state, claim_token_hash, claim_expires_at, created_at, updated_at FROM identity_giving_checkout_continuations;
DROP TABLE identity_giving_checkout_continuations;
CREATE TABLE identity_giving_checkout_continuations (
  intent_id TEXT PRIMARY KEY REFERENCES identity_business_intents(intent_id),
  fund_id INTEGER NOT NULL CHECK (fund_id > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency=lower(currency) AND length(currency)=3 AND currency NOT GLOB '*[^a-z]*'),
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  checkout_request_id TEXT NOT NULL UNIQUE CHECK (
    length(CAST(checkout_request_id AS BLOB))=36 AND checkout_request_id=lower(checkout_request_id)
    AND substr(checkout_request_id,9,1)='-' AND substr(checkout_request_id,14,1)='-'
    AND substr(checkout_request_id,19,1)='-' AND substr(checkout_request_id,24,1)='-'
    AND length(replace(checkout_request_id,'-',''))=32
    AND checkout_request_id NOT GLOB '*[^0-9a-f-]*'
  ),
  stripe_session_id TEXT UNIQUE,
  stripe_session_url TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','creating','attached','consumed','review','expired')),
  claim_token_hash TEXT CHECK (claim_token_hash IS NULL OR (length(claim_token_hash)=64 AND claim_token_hash NOT GLOB '*[^0-9a-f]*')),
  claim_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((stripe_session_id IS NULL)=(stripe_session_url IS NULL)),
  CHECK ((state IN ('attached','consumed'))=(stripe_session_id IS NOT NULL))
);
INSERT INTO identity_giving_checkout_continuations (intent_id, fund_id, amount_cents, currency, locale, checkout_request_id, stripe_session_id, stripe_session_url, state, claim_token_hash, claim_expires_at, created_at, updated_at)
  SELECT intent_id, fund_id, amount_cents, currency, locale, checkout_request_id, stripe_session_id, stripe_session_url, state, claim_token_hash, claim_expires_at, created_at, updated_at FROM _locale_bak_identity_giving_checkout_continuations;
CREATE INDEX idx_identity_giving_continuations_state
  ON identity_giving_checkout_continuations(state,claim_expires_at,updated_at);
CREATE TRIGGER identity_giving_continuation_identity_immutable
BEFORE UPDATE OF intent_id,fund_id,amount_cents,currency,locale,checkout_request_id
ON identity_giving_checkout_continuations
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_immutable'); END;
CREATE TRIGGER identity_giving_continuation_state_guard
BEFORE UPDATE OF state ON identity_giving_checkout_continuations
WHEN NEW.state<>OLD.state AND NOT ((OLD.state='pending' AND NEW.state IN ('ready','review','expired'))
  OR (OLD.state='ready' AND NEW.state IN ('creating','review','expired'))
  OR (OLD.state='creating' AND NEW.state IN ('ready','attached','review','expired'))
  OR (OLD.state='attached' AND NEW.state='consumed'))
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_transition_invalid'); END;
CREATE TRIGGER identity_giving_continuation_result_immutable
BEFORE UPDATE OF stripe_session_id,stripe_session_url ON identity_giving_checkout_continuations
WHEN (OLD.stripe_session_id IS NOT NULL AND NEW.stripe_session_id IS NOT OLD.stripe_session_id)
  OR (OLD.stripe_session_url IS NOT NULL AND NEW.stripe_session_url IS NOT OLD.stripe_session_url)
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_result_immutable'); END;
DROP TABLE _locale_bak_identity_giving_checkout_continuations;

-- identity_registration_continuations references registrations, a Supabase-only table that
-- does not exist on D1, so SQLite rejects every INSERT into it and it can never hold rows
-- here. It is recreated empty with the same schema instead of copied.

-- identity_registration_continuations
DROP TABLE identity_registration_continuations;
CREATE TABLE identity_registration_continuations (
  intent_id TEXT PRIMARY KEY REFERENCES identity_business_intents(intent_id),
  event_id INTEGER NOT NULL CHECK (event_id > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL CHECK (currency=lower(currency) AND length(currency)=3 AND currency NOT GLOB '*[^a-z]*'),
  locale TEXT NOT NULL REFERENCES supported_locales(code),
  answers_json TEXT NOT NULL CHECK (length(CAST(answers_json AS BLOB)) BETWEEN 2 AND 16000),
  question_digest TEXT NOT NULL CHECK (length(question_digest)=64 AND question_digest=lower(question_digest) AND question_digest NOT GLOB '*[^0-9a-f]*'),
  checkout_request_id TEXT UNIQUE,
  registration_id INTEGER UNIQUE REFERENCES registrations(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','creating','attached','consumed','review','expired')),
  claim_token_hash TEXT CHECK (claim_token_hash IS NULL OR (length(claim_token_hash)=64 AND claim_token_hash NOT GLOB '*[^0-9a-f]*')),
  claim_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (amount_cents=0 OR checkout_request_id IS NOT NULL),
  CHECK ((state IN ('attached','consumed'))=(registration_id IS NOT NULL))
);
CREATE INDEX idx_identity_registration_continuations_state
  ON identity_registration_continuations(state,claim_expires_at,updated_at);
CREATE TRIGGER identity_registration_continuation_identity_immutable
BEFORE UPDATE OF intent_id,event_id,amount_cents,currency,locale,answers_json,question_digest,checkout_request_id
ON identity_registration_continuations
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_immutable'); END;
CREATE TRIGGER identity_registration_continuation_state_guard
BEFORE UPDATE OF state ON identity_registration_continuations
WHEN NEW.state<>OLD.state AND NOT ((OLD.state='pending' AND NEW.state IN ('ready','review','expired'))
  OR (OLD.state='ready' AND NEW.state IN ('creating','review','expired'))
  OR (OLD.state='creating' AND NEW.state IN ('ready','attached','review','expired'))
  OR (OLD.state='attached' AND NEW.state='consumed'))
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_transition_invalid'); END;
CREATE TRIGGER identity_registration_continuation_result_immutable
BEFORE UPDATE OF registration_id ON identity_registration_continuations
WHEN OLD.registration_id IS NOT NULL AND NEW.registration_id IS NOT OLD.registration_id
BEGIN SELECT RAISE(ABORT,'identity_business_continuation_result_immutable'); END;
