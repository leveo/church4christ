-- PostgreSQL mirror of migrations/0014_newcomers.sql. Stable status and field
-- IDs are explicit application-owned integers, never identity columns.

CREATE OR REPLACE FUNCTION newcomer_valid_uuid(value text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

CREATE OR REPLACE FUNCTION newcomer_valid_date(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR substr(value,1,4) = '0000' THEN
    RETURN false;
  END IF;
  RETURN to_char(value::date, 'YYYY-MM-DD') = value;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION newcomer_valid_timestamp(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
     OR substr(value,1,4) = '0000' THEN
    RETURN false;
  END IF;
  RETURN to_char(value::timestamp, 'YYYY-MM-DD HH24:MI:SS') = value;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

-- Only non-PII structural keys enter activity metadata. Per-kind required-key
-- combinations remain an application validator responsibility.
CREATE OR REPLACE FUNCTION newcomer_valid_activity_metadata(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  payload jsonb;
  key_name text;
  scalar text;
BEGIN
  IF length(value) NOT BETWEEN 2 AND 512 THEN RETURN false; END IF;
  payload := value::jsonb;
  IF jsonb_typeof(payload) <> 'object' THEN RETURN false; END IF;
  FOR key_name IN SELECT jsonb_object_keys(payload) LOOP
    IF key_name NOT IN (
      'assignee_person_id','from_assignee_person_id','to_assignee_person_id',
      'status_id','from_status_id','to_status_id','person_id','note_id','follow_up_date'
    ) THEN
      RETURN false;
    END IF;
    IF key_name = 'note_id' THEN
      IF jsonb_typeof(payload->key_name) <> 'string'
         OR NOT newcomer_valid_uuid(payload->>key_name) THEN RETURN false; END IF;
    ELSIF key_name = 'follow_up_date' THEN
      IF jsonb_typeof(payload->key_name) <> 'string'
         OR NOT newcomer_valid_date(payload->>key_name) THEN RETURN false; END IF;
    ELSE
      scalar := payload->>key_name;
      IF jsonb_typeof(payload->key_name) <> 'number'
         OR scalar !~ '^[1-9][0-9]{0,9}$'
         OR scalar::bigint > 2147483647 THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE TABLE newcomer_statuses (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  category TEXT NOT NULL CHECK (category IN ('open','closed')),
  sort INTEGER NOT NULL CHECK (sort BETWEEN 0 AND 100000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_initial INTEGER NOT NULL DEFAULT 0 CHECK (is_initial IN (0,1)),
  CHECK (is_initial = 0 OR (category = 'open' AND active = 1))
);

CREATE UNIQUE INDEX idx_newcomer_statuses_one_initial
  ON newcomer_statuses(is_initial)
  WHERE active = 1 AND category = 'open' AND is_initial = 1;
CREATE INDEX idx_newcomer_statuses_active_sort
  ON newcomer_statuses(active, sort, id);

CREATE TABLE newcomer_status_i18n (
  status_id INTEGER NOT NULL REFERENCES newcomer_statuses(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  label TEXT NOT NULL CHECK (label = trim(label) AND length(label) BETWEEN 1 AND 100),
  PRIMARY KEY (status_id, locale)
);

INSERT INTO newcomer_statuses (id,category,sort,active,is_initial) VALUES
  (1,'open',1,1,1),
  (2,'open',2,1,0),
  (3,'open',3,1,0),
  (4,'closed',4,1,0),
  (5,'closed',5,1,0);
INSERT INTO newcomer_status_i18n (status_id,locale,label) VALUES
  (1,'en','New'),       (1,'zh','新朋友'),
  (2,'en','Assigned'),  (2,'zh','已分配'),
  (3,'en','Contacted'), (3,'zh','已联系'),
  (4,'en','Connected'), (4,'zh','已连接'),
  (5,'en','Closed'),    (5,'zh','已关闭');

CREATE TABLE newcomer_fields (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  key TEXT NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  type TEXT NOT NULL CHECK (type IN ('text','textarea','select','checkbox')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort INTEGER NOT NULL DEFAULT 0 CHECK (sort BETWEEN 0 AND 100000),
  fixed INTEGER NOT NULL DEFAULT 0 CHECK (fixed IN (0,1))
);
CREATE INDEX idx_newcomer_fields_active_sort
  ON newcomer_fields(active, sort, id);

CREATE TABLE newcomer_field_i18n (
  field_id INTEGER NOT NULL REFERENCES newcomer_fields(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  label TEXT NOT NULL CHECK (label = trim(label) AND length(label) BETWEEN 1 AND 100),
  help TEXT CHECK (help IS NULL OR length(help) <= 500),
  PRIMARY KEY (field_id, locale)
);

CREATE TABLE newcomer_field_options (
  field_id INTEGER NOT NULL REFERENCES newcomer_fields(id) ON DELETE CASCADE,
  value TEXT NOT NULL CHECK (value ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  sort INTEGER NOT NULL DEFAULT 0 CHECK (sort BETWEEN 0 AND 100000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (field_id, value)
);
CREATE INDEX idx_newcomer_options_field_sort
  ON newcomer_field_options(field_id, active, sort, value);

CREATE TABLE newcomer_field_option_i18n (
  field_id INTEGER NOT NULL,
  value TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  label TEXT NOT NULL CHECK (label = trim(label) AND length(label) BETWEEN 1 AND 100),
  PRIMARY KEY (field_id, value, locale),
  FOREIGN KEY (field_id, value)
    REFERENCES newcomer_field_options(field_id, value) ON DELETE CASCADE
);

INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES
  (1,'name','text',0,1,1,1),
  (2,'email','text',0,1,2,1),
  (3,'phone','text',0,1,3,1),
  (4,'preferred_language','select',0,1,4,1),
  (5,'visit_date','text',0,1,5,1),
  (6,'service_type','select',0,1,6,1),
  (7,'contact_consent','checkbox',0,1,7,1);
INSERT INTO newcomer_field_i18n (field_id,locale,label,help) VALUES
  (1,'en','Name',NULL),                 (1,'zh','姓名',NULL),
  (2,'en','Email',NULL),                (2,'zh','电子邮箱',NULL),
  (3,'en','Phone',NULL),                (3,'zh','电话',NULL),
  (4,'en','Preferred language',NULL),   (4,'zh','首选语言',NULL),
  (5,'en','Visit date',NULL),           (5,'zh','到访日期',NULL),
  (6,'en','Service type',NULL),         (6,'zh','聚会类型',NULL),
  (7,'en','Contact consent',NULL),      (7,'zh','联系同意',NULL);

CREATE TABLE newcomer_submissions (
  id TEXT PRIMARY KEY CHECK (newcomer_valid_uuid(id)),
  name TEXT CHECK (name IS NULL OR (name = trim(name) AND length(name) BETWEEN 1 AND 200)),
  email TEXT CHECK (
    email IS NULL OR (
      email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254 AND
      email LIKE '%@%' AND email NOT LIKE '% %'
    )
  ),
  phone TEXT CHECK (phone IS NULL OR phone ~ '^\+[0-9]{7,15}$'),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  visit_date TEXT NOT NULL CHECK (newcomer_valid_date(visit_date)),
  service_type_id INTEGER REFERENCES service_types(id),
  contact_consent_at TEXT CHECK (contact_consent_at IS NULL OR newcomer_valid_timestamp(contact_consent_at)),
  source TEXT NOT NULL CHECK (source IN ('public','staff')),
  status_id INTEGER NOT NULL DEFAULT 1 REFERENCES newcomer_statuses(id),
  assignee_person_id INTEGER REFERENCES people(id),
  linked_person_id INTEGER REFERENCES people(id),
  next_follow_up_date TEXT CHECK (next_follow_up_date IS NULL OR newcomer_valid_date(next_follow_up_date)),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 2147483647),
  last_mutation_id TEXT CHECK (last_mutation_id IS NULL OR length(last_mutation_id) BETWEEN 1 AND 64),
  closed_at TEXT CHECK (closed_at IS NULL OR newcomer_valid_timestamp(closed_at)),
  deleted_at TEXT CHECK (deleted_at IS NULL OR newcomer_valid_timestamp(deleted_at)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (newcomer_valid_timestamp(created_at)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (newcomer_valid_timestamp(updated_at)),
  CHECK (name IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL)
);

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

CREATE TABLE newcomer_answers (
  submission_id TEXT NOT NULL REFERENCES newcomer_submissions(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES newcomer_fields(id),
  value TEXT NOT NULL CHECK (length(value) <= 4000),
  PRIMARY KEY (submission_id, field_id)
);
CREATE INDEX idx_newcomer_answers_field
  ON newcomer_answers(field_id, submission_id);

CREATE TABLE newcomer_notes (
  id TEXT PRIMARY KEY CHECK (newcomer_valid_uuid(id)),
  submission_id TEXT NOT NULL REFERENCES newcomer_submissions(id) ON DELETE CASCADE,
  author_person_id INTEGER NOT NULL REFERENCES people(id),
  body TEXT NOT NULL CHECK (body = trim(body) AND length(body) BETWEEN 1 AND 10000),
  created_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (newcomer_valid_timestamp(created_at))
);
CREATE INDEX idx_newcomer_notes_submission_created
  ON newcomer_notes(submission_id, created_at, id);

CREATE TABLE newcomer_activity (
  id TEXT PRIMARY KEY CHECK (newcomer_valid_uuid(id)),
  submission_id TEXT NOT NULL REFERENCES newcomer_submissions(id) ON DELETE CASCADE,
  actor_person_id INTEGER REFERENCES people(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'submission_created','assigned','status_changed','follow_up_scheduled',
    'note_added','person_linked','visitor_created'
  )),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (newcomer_valid_activity_metadata(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (newcomer_valid_timestamp(created_at))
);
CREATE INDEX idx_newcomer_activity_submission_created
  ON newcomer_activity(submission_id, created_at, id);
CREATE INDEX idx_newcomer_activity_kind_created
  ON newcomer_activity(kind, created_at, id);

CREATE TABLE newcomer_rate_limits (
  bucket_hash TEXT NOT NULL CHECK (bucket_hash ~ '^[0-9a-f]{64}$'),
  window_start TEXT NOT NULL CHECK (
    newcomer_valid_timestamp(window_start) AND substr(window_start,16,1) = '0' AND substr(window_start,18,2) = '00'
  ),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 100000),
  expires_at TEXT NOT NULL CHECK (
    newcomer_valid_timestamp(expires_at) AND
    expires_at = to_char(window_start::timestamp + interval '48 hours', 'YYYY-MM-DD HH24:MI:SS')
  ),
  PRIMARY KEY (bucket_hash, window_start)
);
CREATE INDEX idx_newcomer_rate_limits_expires
  ON newcomer_rate_limits(expires_at, bucket_hash, window_start);
