-- PostgreSQL parity for Google Classroom OAuth, registration, and push dedupe
-- metadata. No raw OAuth state, verifier, token, provider payload, or work data.

CREATE TABLE learning_google_oauth_states (
  connection_id INTEGER PRIMARY KEY
    REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  state_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
  session_hash bytea NOT NULL CHECK (octet_length(session_hash) = 32),
  actor_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  connection_revision INTEGER NOT NULL CHECK (connection_revision BETWEEN 1 AND 2147483647),
  redirect_uri TEXT NOT NULL CHECK (
    redirect_uri = trim(redirect_uri) AND octet_length(redirect_uri) BETWEEN 49 AND 2048 AND
    redirect_uri LIKE 'https://%/admin/learning/google/callback' AND
    position('@' in substring(redirect_uri from 9)) = 0 AND
    position('?' in redirect_uri) = 0 AND position('#' in redirect_uri) = 0
  ),
  verifier_ciphertext bytea NOT NULL
    CHECK (octet_length(verifier_ciphertext) BETWEEN 16 AND 16384),
  verifier_nonce bytea NOT NULL CHECK (octet_length(verifier_nonce) = 12),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  key_version INTEGER NOT NULL CHECK (key_version BETWEEN 1 AND 2147483647),
  envelope_version INTEGER NOT NULL CHECK (envelope_version IN (1,2)),
  expires_at TEXT NOT NULL CHECK (octet_length(expires_at) BETWEEN 19 AND 40),
  claim_marker TEXT UNIQUE CHECK (claim_marker IS NULL OR length(claim_marker) = 36),
  created_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (octet_length(created_at) BETWEEN 19 AND 40)
);

CREATE INDEX idx_learning_google_oauth_expiry
  ON learning_google_oauth_states(expires_at, connection_id);

CREATE TABLE learning_google_registrations (
  connection_id INTEGER NOT NULL,
  external_course_id TEXT NOT NULL CHECK (
    external_course_id = trim(external_course_id) AND octet_length(external_course_id) BETWEEN 1 AND 255
  ),
  feed_type TEXT NOT NULL CHECK (feed_type IN ('COURSE_ROSTER_CHANGES','COURSE_WORK_CHANGES')),
  registration_id TEXT NOT NULL UNIQUE CHECK (
    registration_id = trim(registration_id) AND octet_length(registration_id) BETWEEN 1 AND 255
  ),
  topic_name TEXT NOT NULL CHECK (
    topic_name = trim(topic_name) AND octet_length(topic_name) BETWEEN 20 AND 512 AND
    topic_name LIKE 'projects/%/topics/%'
  ),
  expiry_time TEXT NOT NULL CHECK (octet_length(expiry_time) BETWEEN 19 AND 40),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (octet_length(updated_at) BETWEEN 19 AND 40),
  PRIMARY KEY (connection_id, external_course_id, feed_type),
  FOREIGN KEY (connection_id, external_course_id)
    REFERENCES learning_courses(connection_id, external_course_id) ON DELETE CASCADE
);

CREATE INDEX idx_learning_google_registrations_renewal
  ON learning_google_registrations(expiry_time, connection_id, external_course_id, feed_type);

CREATE TABLE learning_google_notification_receipts (
  subscription_name TEXT NOT NULL CHECK (
    subscription_name = trim(subscription_name) AND octet_length(subscription_name) BETWEEN 28 AND 512 AND
    subscription_name LIKE 'projects/%/subscriptions/%'
  ),
  message_id TEXT NOT NULL CHECK (message_id = trim(message_id) AND octet_length(message_id) BETWEEN 1 AND 255),
  registration_id TEXT NOT NULL CHECK (
    registration_id = trim(registration_id) AND octet_length(registration_id) BETWEEN 1 AND 255
  ),
  external_course_id TEXT NOT NULL CHECK (
    external_course_id = trim(external_course_id) AND octet_length(external_course_id) BETWEEN 1 AND 255
  ),
  collection_name TEXT NOT NULL CHECK (collection_name IN (
    'courses.students','courses.teachers','courses.courseWork',
    'courses.courseWork.studentSubmissions'
  )),
  received_at TEXT NOT NULL CHECK (octet_length(received_at) BETWEEN 19 AND 40),
  PRIMARY KEY (subscription_name, message_id)
);

CREATE INDEX idx_learning_google_receipts_retention
  ON learning_google_notification_receipts(received_at, subscription_name, message_id);

ALTER TABLE learning_google_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_google_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_google_notification_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  learning_google_oauth_states,
  learning_google_registrations,
  learning_google_notification_receipts
FROM PUBLIC;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE
        learning_google_oauth_states,
        learning_google_registrations,
        learning_google_notification_receipts
      FROM %I', client_role);
    END IF;
  END LOOP;
END
$$;
