-- Provider-neutral Learning control-plane metadata. Providers remain
-- authoritative for content, submissions, answers, comments, files, and grades.
-- Soft deletion is intentionally limited to connections, programs, and courses;
-- credentials and person-scoped/operational rows are hard-deleted under the
-- disconnect, Person-deletion, and retention policies.

CREATE TABLE learning_provider_connections (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  provider TEXT NOT NULL
    CHECK (instr(provider,char(0)) = 0 AND provider IN ('google_classroom','canvas')),
  display_name TEXT NOT NULL CHECK (
    instr(display_name,char(0)) = 0 AND display_name = trim(display_name) AND
    length(CAST(display_name AS BLOB)) BETWEEN 1 AND 120
  ),
  base_url TEXT CHECK (
    base_url IS NULL OR (
      instr(base_url,char(0)) = 0 AND base_url = trim(base_url) AND
      length(CAST(base_url AS BLOB)) BETWEEN 9 AND 2048 AND
      substr(base_url,1,8) = 'https://' AND instr(substr(base_url,9),'@') = 0 AND
      instr(base_url,'?') = 0 AND instr(base_url,'#') = 0 AND substr(base_url,-1) <> '/'
    )
  ),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (instr(status,char(0)) = 0 AND status IN ('pending','active','error','disabled')),
  revision INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 2147483647),
  last_successful_sync_at TEXT CHECK (
    last_successful_sync_at IS NULL OR (
      instr(last_successful_sync_at,char(0)) = 0 AND
      length(CAST(last_successful_sync_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR (
      instr(last_error_code,char(0)) = 0 AND length(CAST(last_error_code AS BLOB)) BETWEEN 1 AND 64 AND
      substr(last_error_code,1,1) GLOB '[a-z]' AND last_error_code NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  created_by_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  updated_by_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) BETWEEN 19 AND 40),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) BETWEEN 19 AND 40),
  deleted_at TEXT CHECK (
    deleted_at IS NULL OR (
      instr(deleted_at,char(0)) = 0 AND length(CAST(deleted_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  UNIQUE (id, provider),
  UNIQUE (provider, base_url),
  CHECK (
    (provider = 'google_classroom' AND base_url IS NULL) OR
    (provider = 'canvas' AND base_url IS NOT NULL)
  ),
  CHECK (deleted_at IS NULL OR status = 'disabled')
);

CREATE INDEX idx_learning_connections_active_sync
  ON learning_provider_connections(provider, status, last_successful_sync_at, id)
  WHERE deleted_at IS NULL;

-- One current encrypted envelope per connection. Key material is supplied only
-- through Worker secrets; this table has no plaintext token/code/secret carrier.
CREATE TABLE learning_provider_credentials (
  connection_id INTEGER PRIMARY KEY
    REFERENCES learning_provider_connections(id) ON DELETE CASCADE,
  ciphertext BLOB NOT NULL
    CHECK (typeof(ciphertext) = 'blob' AND length(ciphertext) BETWEEN 16 AND 16384),
  nonce BLOB NOT NULL
    CHECK (typeof(nonce) = 'blob' AND length(nonce) BETWEEN 12 AND 32),
  algorithm TEXT NOT NULL
    CHECK (instr(algorithm,char(0)) = 0 AND algorithm = 'AES-256-GCM'),
  key_version INTEGER NOT NULL
    CHECK (typeof(key_version) = 'integer' AND key_version BETWEEN 1 AND 2147483647),
  envelope_version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(envelope_version) = 'integer' AND envelope_version = 1),
  expires_at TEXT CHECK (
    expires_at IS NULL OR (
      instr(expires_at,char(0)) = 0 AND length(CAST(expires_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) BETWEEN 19 AND 40)
) WITHOUT ROWID;

CREATE TABLE learning_programs (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  slug TEXT NOT NULL UNIQUE CHECK (
    instr(slug,char(0)) = 0 AND length(CAST(slug AS BLOB)) BETWEEN 1 AND 64 AND
    slug = lower(trim(slug)) AND substr(slug,1,1) GLOB '[a-z]' AND
    slug NOT GLOB '*[^a-z0-9-]*'
  ),
  display_name TEXT NOT NULL CHECK (
    instr(display_name,char(0)) = 0 AND display_name = trim(display_name) AND
    length(CAST(display_name AS BLOB)) BETWEEN 1 AND 200
  ),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (instr(status,char(0)) = 0 AND status IN ('active','archived')),
  created_by_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  updated_by_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) BETWEEN 19 AND 40),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) BETWEEN 19 AND 40),
  deleted_at TEXT CHECK (
    deleted_at IS NULL OR (
      instr(deleted_at,char(0)) = 0 AND length(CAST(deleted_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  CHECK (deleted_at IS NULL OR status = 'archived')
);

CREATE INDEX idx_learning_programs_active_name
  ON learning_programs(status, display_name, id)
  WHERE deleted_at IS NULL;

CREATE TABLE learning_courses (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  program_id INTEGER NOT NULL REFERENCES learning_programs(id) ON DELETE RESTRICT,
  connection_id INTEGER NOT NULL,
  provider TEXT NOT NULL
    CHECK (instr(provider,char(0)) = 0 AND provider IN ('google_classroom','canvas')),
  external_course_id TEXT NOT NULL CHECK (
    instr(external_course_id,char(0)) = 0 AND external_course_id = trim(external_course_id) AND
    length(CAST(external_course_id AS BLOB)) BETWEEN 1 AND 255
  ),
  display_name TEXT NOT NULL CHECK (
    instr(display_name,char(0)) = 0 AND display_name = trim(display_name) AND
    length(CAST(display_name AS BLOB)) BETWEEN 1 AND 200
  ),
  launch_url TEXT NOT NULL CHECK (
    instr(launch_url,char(0)) = 0 AND launch_url = trim(launch_url) AND
    length(CAST(launch_url AS BLOB)) BETWEEN 9 AND 2048 AND
    substr(launch_url,1,8) = 'https://' AND instr(substr(launch_url,9),'@') = 0 AND
    instr(launch_url,'#') = 0
  ),
  lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK (instr(lifecycle_state,char(0)) = 0 AND lifecycle_state IN ('active','archived','deleted')),
  provider_updated_at TEXT CHECK (
    provider_updated_at IS NULL OR (
      instr(provider_updated_at,char(0)) = 0 AND
      length(CAST(provider_updated_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  last_synced_at TEXT CHECK (
    last_synced_at IS NULL OR (
      instr(last_synced_at,char(0)) = 0 AND length(CAST(last_synced_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) BETWEEN 19 AND 40),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) BETWEEN 19 AND 40),
  deleted_at TEXT CHECK (
    deleted_at IS NULL OR (
      instr(deleted_at,char(0)) = 0 AND length(CAST(deleted_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  UNIQUE (id, connection_id),
  UNIQUE (connection_id, external_course_id),
  FOREIGN KEY (connection_id, provider)
    REFERENCES learning_provider_connections(id, provider) ON DELETE RESTRICT,
  CHECK (deleted_at IS NULL OR lifecycle_state IN ('archived','deleted'))
);

CREATE INDEX idx_learning_courses_program_state
  ON learning_courses(program_id, lifecycle_state, display_name, id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_learning_courses_connection_sync
  ON learning_courses(connection_id, lifecycle_state, last_synced_at, id)
  WHERE deleted_at IS NULL;

CREATE TABLE learning_identity_links (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  connection_id INTEGER NOT NULL
    REFERENCES learning_provider_connections(id) ON DELETE RESTRICT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  external_user_id TEXT NOT NULL CHECK (
    instr(external_user_id,char(0)) = 0 AND external_user_id = trim(external_user_id) AND
    length(CAST(external_user_id AS BLOB)) BETWEEN 1 AND 255
  ),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (instr(status,char(0)) = 0 AND status IN ('active','disabled','conflict')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) BETWEEN 19 AND 40),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) BETWEEN 19 AND 40),
  UNIQUE (id, connection_id),
  UNIQUE (id, connection_id, person_id),
  UNIQUE (connection_id, external_user_id),
  UNIQUE (connection_id, person_id)
);

CREATE INDEX idx_learning_identities_person_status
  ON learning_identity_links(person_id, status, id);

CREATE TABLE learning_enrollments (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  connection_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  identity_link_id INTEGER NOT NULL,
  external_enrollment_id TEXT NOT NULL CHECK (
    instr(external_enrollment_id,char(0)) = 0 AND external_enrollment_id = trim(external_enrollment_id) AND
    length(CAST(external_enrollment_id AS BLOB)) BETWEEN 1 AND 255
  ),
  role TEXT NOT NULL
    CHECK (instr(role,char(0)) = 0 AND role IN ('student','teacher','observer')),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (instr(state,char(0)) = 0 AND state IN ('active','invited','completed','inactive')),
  last_synced_at TEXT CHECK (
    last_synced_at IS NULL OR (
      instr(last_synced_at,char(0)) = 0 AND length(CAST(last_synced_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) BETWEEN 19 AND 40),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) BETWEEN 19 AND 40),
  UNIQUE (id, course_id),
  UNIQUE (id, course_id, connection_id, identity_link_id),
  UNIQUE (course_id, identity_link_id),
  UNIQUE (course_id, external_enrollment_id),
  FOREIGN KEY (course_id, connection_id)
    REFERENCES learning_courses(id, connection_id) ON DELETE CASCADE,
  FOREIGN KEY (identity_link_id, connection_id)
    REFERENCES learning_identity_links(id, connection_id) ON DELETE CASCADE
);

CREATE INDEX idx_learning_enrollments_course_state
  ON learning_enrollments(course_id, state, role, id);
CREATE INDEX idx_learning_enrollments_identity_state
  ON learning_enrollments(identity_link_id, state, course_id, id);

CREATE TABLE learning_activities (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  course_id INTEGER NOT NULL REFERENCES learning_courses(id) ON DELETE CASCADE,
  external_activity_id TEXT NOT NULL CHECK (
    instr(external_activity_id,char(0)) = 0 AND external_activity_id = trim(external_activity_id) AND
    length(CAST(external_activity_id AS BLOB)) BETWEEN 1 AND 255
  ),
  title TEXT NOT NULL CHECK (
    instr(title,char(0)) = 0 AND title = trim(title) AND
    length(CAST(title AS BLOB)) BETWEEN 1 AND 300
  ),
  kind TEXT NOT NULL
    CHECK (instr(kind,char(0)) = 0 AND kind IN ('material','assignment','quiz')),
  lifecycle_state TEXT NOT NULL DEFAULT 'published'
    CHECK (instr(lifecycle_state,char(0)) = 0 AND lifecycle_state IN ('draft','published','archived','deleted')),
  launch_url TEXT NOT NULL CHECK (
    instr(launch_url,char(0)) = 0 AND launch_url = trim(launch_url) AND
    length(CAST(launch_url AS BLOB)) BETWEEN 9 AND 2048 AND
    substr(launch_url,1,8) = 'https://' AND instr(substr(launch_url,9),'@') = 0 AND
    instr(launch_url,'#') = 0
  ),
  due_at TEXT CHECK (
    due_at IS NULL OR (
      instr(due_at,char(0)) = 0 AND length(CAST(due_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  published_at TEXT CHECK (
    published_at IS NULL OR (
      instr(published_at,char(0)) = 0 AND length(CAST(published_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  provider_updated_at TEXT CHECK (
    provider_updated_at IS NULL OR (
      instr(provider_updated_at,char(0)) = 0 AND
      length(CAST(provider_updated_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  last_synced_at TEXT CHECK (
    last_synced_at IS NULL OR (
      instr(last_synced_at,char(0)) = 0 AND length(CAST(last_synced_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) BETWEEN 19 AND 40),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) BETWEEN 19 AND 40),
  UNIQUE (id, course_id),
  UNIQUE (id, course_id, kind),
  UNIQUE (course_id, external_activity_id)
);

CREATE INDEX idx_learning_activities_course_due
  ON learning_activities(course_id, lifecycle_state, due_at, id);
CREATE INDEX idx_learning_activities_course_kind
  ON learning_activities(course_id, kind, provider_updated_at, id);

-- Direct activity purges are a retention operation. They are permitted only
-- after the owning course is soft-deleted or its connection is disabled/deleted;
-- hard course deletion still cascades through the foreign key.
CREATE TRIGGER learning_activities_no_delete
BEFORE DELETE ON learning_activities
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM learning_courses
    WHERE id = OLD.course_id AND deleted_at IS NULL AND EXISTS (
      SELECT 1 FROM learning_provider_connections
      WHERE id = learning_courses.connection_id AND deleted_at IS NULL AND status <> 'disabled'
    )
  ) THEN RAISE(ABORT, 'learning_activity_active_parent') END;
END;

CREATE TABLE learning_resources (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  activity_id INTEGER NOT NULL REFERENCES learning_activities(id) ON DELETE CASCADE,
  external_resource_id TEXT NOT NULL CHECK (
    instr(external_resource_id,char(0)) = 0 AND external_resource_id = trim(external_resource_id) AND
    length(CAST(external_resource_id AS BLOB)) BETWEEN 1 AND 255
  ),
  title TEXT NOT NULL CHECK (
    instr(title,char(0)) = 0 AND title = trim(title) AND
    length(CAST(title AS BLOB)) BETWEEN 1 AND 300
  ),
  kind TEXT NOT NULL
    CHECK (instr(kind,char(0)) = 0 AND kind IN ('youtube','provider_file','link')),
  launch_url TEXT NOT NULL CHECK (
    instr(launch_url,char(0)) = 0 AND launch_url = trim(launch_url) AND
    length(CAST(launch_url AS BLOB)) BETWEEN 9 AND 2048 AND
    substr(launch_url,1,8) = 'https://' AND instr(substr(launch_url,9),'@') = 0 AND
    instr(launch_url,'#') = 0
  ),
  youtube_video_id TEXT CHECK (
    youtube_video_id IS NULL OR (
      instr(youtube_video_id,char(0)) = 0 AND length(CAST(youtube_video_id AS BLOB)) = 11 AND
      youtube_video_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  mime_type TEXT CHECK (
    mime_type IS NULL OR (
      instr(mime_type,char(0)) = 0 AND mime_type = trim(mime_type) AND
      length(CAST(mime_type AS BLOB)) BETWEEN 1 AND 127
    )
  ),
  size_bytes INTEGER CHECK (
    size_bytes IS NULL OR (
      typeof(size_bytes) = 'integer' AND size_bytes BETWEEN 0 AND 2147483647
    )
  ),
  provider_updated_at TEXT CHECK (
    provider_updated_at IS NULL OR (
      instr(provider_updated_at,char(0)) = 0 AND
      length(CAST(provider_updated_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) BETWEEN 19 AND 40),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) BETWEEN 19 AND 40),
  UNIQUE (activity_id, external_resource_id),
  CHECK (
    (kind = 'youtube' AND youtube_video_id IS NOT NULL AND mime_type IS NULL AND size_bytes IS NULL) OR
    (kind = 'provider_file' AND youtube_video_id IS NULL) OR
    (kind = 'link' AND youtube_video_id IS NULL AND mime_type IS NULL AND size_bytes IS NULL)
  )
);

CREATE INDEX idx_learning_resources_activity_kind
  ON learning_resources(activity_id, kind, id);

-- Current state only: no grade, answer, comment, rubric, title, or file carrier.
CREATE TABLE learning_submission_snapshots (
  course_id INTEGER NOT NULL,
  activity_id INTEGER NOT NULL,
  activity_kind TEXT NOT NULL CHECK (
    instr(activity_kind,char(0)) = 0 AND activity_kind IN ('assignment','quiz')
  ),
  enrollment_id INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (instr(status,char(0)) = 0 AND status IN ('not_submitted','submitted','returned','excused')),
  late INTEGER NOT NULL DEFAULT 0 CHECK (typeof(late) = 'integer' AND late IN (0,1)),
  attempt_number INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(attempt_number) = 'integer' AND attempt_number BETWEEN 0 AND 1000),
  submitted_at TEXT CHECK (
    submitted_at IS NULL OR (
      instr(submitted_at,char(0)) = 0 AND length(CAST(submitted_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  returned_at TEXT CHECK (
    returned_at IS NULL OR (
      instr(returned_at,char(0)) = 0 AND length(CAST(returned_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  provider_updated_at TEXT CHECK (
    provider_updated_at IS NULL OR (
      instr(provider_updated_at,char(0)) = 0 AND
      length(CAST(provider_updated_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(synced_at,char(0)) = 0 AND length(CAST(synced_at AS BLOB)) BETWEEN 19 AND 40),
  PRIMARY KEY (activity_id, enrollment_id),
  FOREIGN KEY (activity_id, course_id, activity_kind)
    REFERENCES learning_activities(id, course_id, kind) ON DELETE CASCADE,
  FOREIGN KEY (enrollment_id, course_id)
    REFERENCES learning_enrollments(id, course_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_learning_snapshots_enrollment_state
  ON learning_submission_snapshots(enrollment_id, status, synced_at, activity_id);
CREATE INDEX idx_learning_snapshots_course_state
  ON learning_submission_snapshots(course_id, status, late, synced_at, activity_id);

-- Append-only normalized evidence. Stable Person, identity-link, and enrollment
-- identifiers are bound together declaratively so parent reassignment cannot
-- reattribute an event. IDs, allowlisted type, references, and times are the
-- complete event shape; raw provider payloads and display/content fields are
-- deliberately absent.
CREATE TABLE learning_activity_events (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    instr(id,char(0)) = 0 AND id = trim(id) AND length(CAST(id AS BLOB)) BETWEEN 1 AND 255
  ),
  connection_id INTEGER NOT NULL,
  provider TEXT NOT NULL
    CHECK (instr(provider,char(0)) = 0 AND provider IN ('google_classroom','canvas')),
  source_event_id TEXT NOT NULL CHECK (
    instr(source_event_id,char(0)) = 0 AND source_event_id = trim(source_event_id) AND
    length(CAST(source_event_id AS BLOB)) BETWEEN 1 AND 255
  ),
  event_type TEXT NOT NULL CHECK (
    instr(event_type,char(0)) = 0 AND event_type IN (
      'enrolled','resource_opened','assignment_submitted','quiz_submitted',
      'submission_returned','course_completed'
    )
  ),
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  identity_link_id INTEGER NOT NULL,
  enrollment_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  activity_id INTEGER,
  activity_kind TEXT CHECK (
    activity_kind IS NULL OR (
      instr(activity_kind,char(0)) = 0 AND activity_kind IN ('material','assignment','quiz')
    )
  ),
  occurred_at TEXT NOT NULL CHECK (
    instr(occurred_at,char(0)) = 0 AND length(CAST(occurred_at AS BLOB)) BETWEEN 19 AND 40
  ),
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (
    instr(ingested_at,char(0)) = 0 AND length(CAST(ingested_at AS BLOB)) BETWEEN 19 AND 40
  ),
  UNIQUE (connection_id, source_event_id),
  FOREIGN KEY (connection_id, provider)
    REFERENCES learning_provider_connections(id, provider) ON DELETE RESTRICT,
  FOREIGN KEY (course_id, connection_id)
    REFERENCES learning_courses(id, connection_id) ON DELETE CASCADE,
  FOREIGN KEY (identity_link_id, connection_id, person_id)
    REFERENCES learning_identity_links(id, connection_id, person_id) ON DELETE NO ACTION,
  FOREIGN KEY (enrollment_id, course_id, connection_id, identity_link_id)
    REFERENCES learning_enrollments(id, course_id, connection_id, identity_link_id)
    ON DELETE NO ACTION,
  FOREIGN KEY (activity_id, course_id, activity_kind)
    REFERENCES learning_activities(id, course_id, kind) ON DELETE CASCADE,
  CHECK (
    (event_type IN ('enrolled','course_completed') AND
      activity_id IS NULL AND activity_kind IS NULL) OR
    (event_type = 'resource_opened' AND
      activity_id IS NOT NULL AND activity_kind IN ('material','assignment','quiz')) OR
    (event_type = 'assignment_submitted' AND
      activity_id IS NOT NULL AND activity_kind = 'assignment') OR
    (event_type = 'quiz_submitted' AND
      activity_id IS NOT NULL AND activity_kind = 'quiz') OR
    (event_type = 'submission_returned' AND
      activity_id IS NOT NULL AND activity_kind IN ('assignment','quiz'))
  )
);

CREATE INDEX idx_learning_events_enrollment_time
  ON learning_activity_events(enrollment_id, occurred_at, id);
CREATE INDEX idx_learning_events_person_time
  ON learning_activity_events(person_id, occurred_at, id);
CREATE INDEX idx_learning_events_course_time
  ON learning_activity_events(course_id, occurred_at, id);
CREATE INDEX idx_learning_events_activity_time
  ON learning_activity_events(activity_id, occurred_at, id)
  WHERE activity_id IS NOT NULL;
CREATE INDEX idx_learning_events_connection_ingested
  ON learning_activity_events(connection_id, ingested_at, id);

CREATE TRIGGER learning_activity_events_no_update
BEFORE UPDATE ON learning_activity_events
BEGIN
  SELECT RAISE(ABORT, 'learning_event_append_only');
END;

CREATE TRIGGER learning_activity_events_no_delete
BEFORE DELETE ON learning_activity_events
BEGIN
  SELECT CASE WHEN
    EXISTS (SELECT 1 FROM people WHERE id = OLD.person_id) AND
    EXISTS (SELECT 1 FROM learning_identity_links WHERE id = OLD.identity_link_id) AND
    EXISTS (SELECT 1 FROM learning_enrollments WHERE id = OLD.enrollment_id) AND
    EXISTS (SELECT 1 FROM learning_courses WHERE id = OLD.course_id AND deleted_at IS NULL) AND
    EXISTS (SELECT 1 FROM learning_provider_connections
      WHERE id = OLD.connection_id AND deleted_at IS NULL AND status <> 'disabled')
    THEN RAISE(ABORT, 'learning_event_append_only') END;
END;

-- Bounded operational facts only; no provider response, URL, name, token, or
-- submission carrier is permitted in a run row.
CREATE TABLE learning_sync_runs (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  connection_id INTEGER NOT NULL,
  course_id INTEGER,
  trigger_type TEXT NOT NULL CHECK (
    instr(trigger_type,char(0)) = 0 AND trigger_type IN ('manual','scheduled','notification')
  ),
  status TEXT NOT NULL DEFAULT 'running' CHECK (
    instr(status,char(0)) = 0 AND status IN ('running','succeeded','failed','cancelled')
  ),
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (instr(started_at,char(0)) = 0 AND length(CAST(started_at AS BLOB)) BETWEEN 19 AND 40),
  finished_at TEXT CHECK (
    finished_at IS NULL OR (
      instr(finished_at,char(0)) = 0 AND length(CAST(finished_at AS BLOB)) BETWEEN 19 AND 40
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 1 AND 10),
  scanned_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(scanned_count) = 'integer' AND scanned_count BETWEEN 0 AND 100000),
  changed_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(changed_count) = 'integer' AND changed_count BETWEEN 0 AND 100000),
  removed_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(removed_count) = 'integer' AND removed_count BETWEEN 0 AND 100000),
  event_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(event_count) = 'integer' AND event_count BETWEEN 0 AND 100000),
  error_code TEXT CHECK (
    error_code IS NULL OR (
      instr(error_code,char(0)) = 0 AND length(CAST(error_code AS BLOB)) BETWEEN 1 AND 64 AND
      substr(error_code,1,1) GLOB '[a-z]' AND error_code NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  FOREIGN KEY (connection_id) REFERENCES learning_provider_connections(id) ON DELETE RESTRICT,
  FOREIGN KEY (course_id, connection_id)
    REFERENCES learning_courses(id, connection_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'running' AND finished_at IS NULL AND error_code IS NULL) OR
    (status = 'succeeded' AND finished_at IS NOT NULL AND error_code IS NULL) OR
    (status = 'failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL) OR
    (status = 'cancelled' AND finished_at IS NOT NULL AND error_code IS NULL)
  )
);

CREATE INDEX idx_learning_sync_runs_connection_time
  ON learning_sync_runs(connection_id, started_at, id);
CREATE INDEX idx_learning_sync_runs_course_time
  ON learning_sync_runs(course_id, started_at, id)
  WHERE course_id IS NOT NULL;
CREATE INDEX idx_learning_sync_runs_status_time
  ON learning_sync_runs(status, started_at, id);
