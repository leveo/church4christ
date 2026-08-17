-- Google Classroom OAuth, expiring registration, and Pub/Sub delivery metadata.
-- Raw state, PKCE verifier, OAuth tokens, provider payloads, and student work are
-- deliberately absent. The verifier uses the existing AES-256-GCM envelope.

CREATE TABLE learning_google_oauth_states (
  connection_id INTEGER PRIMARY KEY
    REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  state_hash BLOB NOT NULL UNIQUE
    CHECK (typeof(state_hash) = 'blob' AND length(state_hash) = 32),
  session_hash BLOB NOT NULL
    CHECK (typeof(session_hash) = 'blob' AND length(session_hash) = 32),
  actor_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  connection_revision INTEGER NOT NULL CHECK (
    typeof(connection_revision) = 'integer' AND connection_revision BETWEEN 1 AND 2147483647
  ),
  redirect_uri TEXT NOT NULL CHECK (
    instr(redirect_uri,char(0)) = 0 AND redirect_uri = trim(redirect_uri) AND
    length(CAST(redirect_uri AS BLOB)) BETWEEN 49 AND 2048 AND
    substr(redirect_uri,1,8) = 'https://' AND
    redirect_uri GLOB 'https://*/admin/learning/google/callback' AND
    instr(substr(redirect_uri,9),'@') = 0 AND instr(redirect_uri,'?') = 0 AND
    instr(redirect_uri,'#') = 0
  ),
  verifier_ciphertext BLOB NOT NULL CHECK (
    typeof(verifier_ciphertext) = 'blob' AND length(verifier_ciphertext) BETWEEN 16 AND 16384
  ),
  verifier_nonce BLOB NOT NULL
    CHECK (typeof(verifier_nonce) = 'blob' AND length(verifier_nonce) = 12),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  key_version INTEGER NOT NULL CHECK (
    typeof(key_version) = 'integer' AND key_version BETWEEN 1 AND 2147483647
  ),
  envelope_version INTEGER NOT NULL CHECK (
    typeof(envelope_version) = 'integer' AND envelope_version IN (1,2)
  ),
  expires_at TEXT NOT NULL CHECK (
    instr(expires_at,char(0)) = 0 AND length(CAST(expires_at AS BLOB)) BETWEEN 19 AND 40
  ),
  claim_marker TEXT UNIQUE CHECK (
    claim_marker IS NULL OR (instr(claim_marker,char(0)) = 0 AND length(claim_marker) = 36)
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (
    instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) BETWEEN 19 AND 40
  )
) WITHOUT ROWID;

CREATE INDEX idx_learning_google_oauth_expiry
  ON learning_google_oauth_states(expires_at, connection_id);

CREATE TABLE learning_google_registrations (
  connection_id INTEGER NOT NULL,
  external_course_id TEXT NOT NULL CHECK (
    instr(external_course_id,char(0)) = 0 AND external_course_id = trim(external_course_id) AND
    length(CAST(external_course_id AS BLOB)) BETWEEN 1 AND 255
  ),
  feed_type TEXT NOT NULL CHECK (
    feed_type IN ('COURSE_ROSTER_CHANGES','COURSE_WORK_CHANGES')
  ),
  registration_id TEXT NOT NULL UNIQUE CHECK (
    instr(registration_id,char(0)) = 0 AND registration_id = trim(registration_id) AND
    length(CAST(registration_id AS BLOB)) BETWEEN 1 AND 255
  ),
  topic_name TEXT NOT NULL CHECK (
    instr(topic_name,char(0)) = 0 AND topic_name = trim(topic_name) AND
    length(CAST(topic_name AS BLOB)) BETWEEN 20 AND 512 AND
    topic_name GLOB 'projects/*/topics/*'
  ),
  expiry_time TEXT NOT NULL CHECK (
    instr(expiry_time,char(0)) = 0 AND length(CAST(expiry_time AS BLOB)) BETWEEN 19 AND 40
  ),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (
    instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) BETWEEN 19 AND 40
  ),
  PRIMARY KEY (connection_id, external_course_id, feed_type),
  FOREIGN KEY (connection_id, external_course_id)
    REFERENCES learning_courses(connection_id, external_course_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_learning_google_registrations_renewal
  ON learning_google_registrations(expiry_time, connection_id, external_course_id, feed_type);

CREATE TABLE learning_google_notification_receipts (
  subscription_name TEXT NOT NULL CHECK (
    instr(subscription_name,char(0)) = 0 AND subscription_name = trim(subscription_name) AND
    length(CAST(subscription_name AS BLOB)) BETWEEN 28 AND 512 AND
    subscription_name GLOB 'projects/*/subscriptions/*'
  ),
  message_id TEXT NOT NULL CHECK (
    instr(message_id,char(0)) = 0 AND message_id = trim(message_id) AND
    length(CAST(message_id AS BLOB)) BETWEEN 1 AND 255
  ),
  registration_id TEXT NOT NULL CHECK (
    instr(registration_id,char(0)) = 0 AND registration_id = trim(registration_id) AND
    length(CAST(registration_id AS BLOB)) BETWEEN 1 AND 255
  ),
  external_course_id TEXT NOT NULL CHECK (
    instr(external_course_id,char(0)) = 0 AND external_course_id = trim(external_course_id) AND
    length(CAST(external_course_id AS BLOB)) BETWEEN 1 AND 255
  ),
  collection_name TEXT NOT NULL CHECK (collection_name IN (
    'courses.students','courses.teachers','courses.courseWork',
    'courses.courseWork.studentSubmissions'
  )),
  received_at TEXT NOT NULL CHECK (
    instr(received_at,char(0)) = 0 AND length(CAST(received_at AS BLOB)) BETWEEN 19 AND 40
  ),
  PRIMARY KEY (subscription_name, message_id)
) WITHOUT ROWID;

CREATE INDEX idx_learning_google_receipts_retention
  ON learning_google_notification_receipts(received_at, subscription_name, message_id);
