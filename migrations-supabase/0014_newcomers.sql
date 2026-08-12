-- PostgreSQL mirror of migrations/0014_newcomers.sql. Stable status and field
-- IDs are explicit application-owned integers, never identity columns.

CREATE OR REPLACE FUNCTION newcomer_valid_uuid(value text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT octet_length(value) = 36 AND value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

CREATE OR REPLACE FUNCTION newcomer_valid_date(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF octet_length(value) <> 10 OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR substr(value,1,4) = '0000' THEN
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
  IF octet_length(value) <> 19 OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
     OR substr(value,1,4) = '0000' THEN
    RETURN false;
  END IF;
  RETURN to_char(value::timestamp, 'YYYY-MM-DD HH24:MI:SS') = value;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

-- Deliberately modest normalized-email shape validation, not RFC completeness.
CREATE OR REPLACE FUNCTION newcomer_valid_email(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  at_position integer;
  ascii_code integer;
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF value <> lower(trim(value)) OR octet_length(value) NOT BETWEEN 3 AND 254 THEN RETURN false; END IF;
  at_position := position('@' IN value);
  IF at_position < 2 OR at_position >= length(value)
     OR position('@' IN substring(value FROM at_position + 1)) <> 0 THEN
    RETURN false;
  END IF;
  FOR ascii_code IN 1..32 LOOP
    IF position(chr(ascii_code) IN value) <> 0 THEN RETURN false; END IF;
  END LOOP;
  RETURN position(chr(127) IN value) = 0;
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
  canonical text := '{';
  separator text := '';
BEGIN
  IF octet_length(value) NOT BETWEEN 2 AND 512 THEN RETURN false; END IF;
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
  FOREACH key_name IN ARRAY ARRAY[
    'assignee_person_id','from_assignee_person_id','to_assignee_person_id',
    'status_id','from_status_id','to_status_id','person_id','note_id','follow_up_date'
  ] LOOP
    IF payload ? key_name THEN
      canonical := canonical || separator || to_json(key_name)::text || ':' || (payload->key_name)::text;
      separator := ',';
    END IF;
  END LOOP;
  canonical := canonical || '}';
  RETURN value = canonical;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE TABLE newcomer_statuses (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  key TEXT NOT NULL UNIQUE CHECK (octet_length(key) BETWEEN 1 AND 64 AND key ~ '^[a-z][a-z0-9_]{0,63}$'),
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
  label TEXT NOT NULL CHECK (label = trim(label) AND octet_length(label) BETWEEN 1 AND 100),
  PRIMARY KEY (status_id, locale)
);

INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES
  (1,'new','open',1,1,1),
  (2,'assigned','open',2,1,0),
  (3,'contacted','open',3,1,0),
  (4,'connected','closed',4,1,0),
  (5,'closed','closed',5,1,0);
INSERT INTO newcomer_status_i18n (status_id,locale,label) VALUES
  (1,'en','New'),       (1,'zh','新朋友'),
  (2,'en','Assigned'),  (2,'zh','已分配'),
  (3,'en','Contacted'), (3,'zh','已联系'),
  (4,'en','Connected'), (4,'zh','已连接'),
  (5,'en','Closed'),    (5,'zh','已关闭');

CREATE OR REPLACE FUNCTION newcomer_statuses_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    (NEW.id = 1 AND NEW.key = 'new') OR
    (NEW.id = 2 AND NEW.key = 'assigned') OR
    (NEW.id = 3 AND NEW.key = 'contacted') OR
    (NEW.id = 4 AND NEW.key = 'connected') OR
    (NEW.id = 5 AND NEW.key = 'closed') OR
    (NEW.id > 5 AND NEW.key NOT IN ('new','assigned','contacted','connected','closed'))
  ) THEN
    RAISE EXCEPTION 'newcomer_status_boundary';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION newcomer_statuses_update_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    NEW.id = OLD.id AND NEW.key = OLD.key AND NEW.category = OLD.category
  ) THEN
    RAISE EXCEPTION 'newcomer_status_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION newcomer_statuses_core_delete_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id <= 5 THEN
    RAISE EXCEPTION 'newcomer_status_immutable';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER newcomer_statuses_boundary_insert
BEFORE INSERT ON newcomer_statuses FOR EACH ROW
EXECUTE FUNCTION newcomer_statuses_insert_guard();
CREATE TRIGGER newcomer_statuses_boundary_update
BEFORE UPDATE ON newcomer_statuses FOR EACH ROW
EXECUTE FUNCTION newcomer_statuses_update_guard();
CREATE TRIGGER newcomer_statuses_core_delete
BEFORE DELETE ON newcomer_statuses FOR EACH ROW
EXECUTE FUNCTION newcomer_statuses_core_delete_guard();

CREATE TABLE newcomer_fields (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  key TEXT NOT NULL UNIQUE CHECK (octet_length(key) BETWEEN 1 AND 64 AND key ~ '^[a-z][a-z0-9_]{0,63}$'),
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
  label TEXT NOT NULL CHECK (label = trim(label) AND octet_length(label) BETWEEN 1 AND 100),
  help TEXT CHECK (help IS NULL OR octet_length(help) <= 500),
  PRIMARY KEY (field_id, locale)
);

CREATE TABLE newcomer_field_options (
  field_id INTEGER NOT NULL REFERENCES newcomer_fields(id) ON DELETE CASCADE,
  value TEXT NOT NULL CHECK (octet_length(value) BETWEEN 1 AND 80 AND value ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  sort INTEGER NOT NULL DEFAULT 0 CHECK (sort BETWEEN 0 AND 100000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (field_id, value)
);
CREATE INDEX idx_newcomer_options_field_sort
  ON newcomer_field_options(field_id, active, sort, value);

CREATE TABLE newcomer_field_option_i18n (
  field_id INTEGER NOT NULL,
  value TEXT NOT NULL CHECK (octet_length(value) BETWEEN 1 AND 80),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  label TEXT NOT NULL CHECK (label = trim(label) AND octet_length(label) BETWEEN 1 AND 100),
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

CREATE OR REPLACE FUNCTION newcomer_fields_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    NEW.id > 7 AND
    NEW.key NOT IN ('name','email','phone','preferred_language','visit_date','service_type','contact_consent') AND
    NEW.fixed = 0
  ) THEN
    RAISE EXCEPTION 'newcomer_field_boundary';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION newcomer_fields_update_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    (NEW.id = 1 AND NEW.key = 'name' AND NEW.type = 'text' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
    (NEW.id = 2 AND NEW.key = 'email' AND NEW.type = 'text' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
    (NEW.id = 3 AND NEW.key = 'phone' AND NEW.type = 'text' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
    (NEW.id = 4 AND NEW.key = 'preferred_language' AND NEW.type = 'select' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
    (NEW.id = 5 AND NEW.key = 'visit_date' AND NEW.type = 'text' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
    (NEW.id = 6 AND NEW.key = 'service_type' AND NEW.type = 'select' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
    (NEW.id = 7 AND NEW.key = 'contact_consent' AND NEW.type = 'checkbox' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
    (NEW.id > 7 AND NEW.key NOT IN ('name','email','phone','preferred_language','visit_date','service_type','contact_consent') AND NEW.fixed = 0)
  ) THEN
    RAISE EXCEPTION 'newcomer_field_boundary';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER newcomer_fields_boundary_insert
BEFORE INSERT ON newcomer_fields FOR EACH ROW
EXECUTE FUNCTION newcomer_fields_insert_guard();
CREATE TRIGGER newcomer_fields_boundary_update
BEFORE UPDATE ON newcomer_fields FOR EACH ROW
EXECUTE FUNCTION newcomer_fields_update_guard();

CREATE OR REPLACE FUNCTION newcomer_fields_core_delete_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.fixed = 1 THEN
    RAISE EXCEPTION 'newcomer_field_immutable';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER newcomer_fields_core_delete
BEFORE DELETE ON newcomer_fields FOR EACH ROW
EXECUTE FUNCTION newcomer_fields_core_delete_guard();

CREATE OR REPLACE FUNCTION newcomer_field_options_custom_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 1) THEN
    RAISE EXCEPTION 'newcomer_field_options_custom_only';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER newcomer_field_options_custom_insert
BEFORE INSERT ON newcomer_field_options FOR EACH ROW
EXECUTE FUNCTION newcomer_field_options_custom_guard();
CREATE TRIGGER newcomer_field_options_custom_update
BEFORE UPDATE ON newcomer_field_options FOR EACH ROW
EXECUTE FUNCTION newcomer_field_options_custom_guard();

CREATE TABLE newcomer_submissions (
  id TEXT PRIMARY KEY CHECK (newcomer_valid_uuid(id)),
  name TEXT CHECK (name IS NULL OR (name = trim(name) AND octet_length(name) BETWEEN 1 AND 200)),
  email TEXT CHECK (newcomer_valid_email(email)),
  phone TEXT CHECK (phone IS NULL OR (octet_length(phone) BETWEEN 8 AND 16 AND phone ~ '^\+[0-9]{7,15}$')),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  visit_date TEXT NOT NULL CHECK (newcomer_valid_date(visit_date)),
  service_type_id INTEGER REFERENCES service_types(id) ON DELETE SET NULL,
  contact_consent_at TEXT CHECK (contact_consent_at IS NULL OR newcomer_valid_timestamp(contact_consent_at)),
  source TEXT NOT NULL CHECK (source IN ('public','staff')),
  status_id INTEGER NOT NULL DEFAULT 1 REFERENCES newcomer_statuses(id) ON DELETE RESTRICT,
  assignee_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  linked_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  next_follow_up_date TEXT CHECK (next_follow_up_date IS NULL OR newcomer_valid_date(next_follow_up_date)),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 2147483647),
  last_mutation_id TEXT CHECK (last_mutation_id IS NULL OR octet_length(last_mutation_id) BETWEEN 1 AND 64),
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
  submission_id TEXT NOT NULL CHECK (octet_length(submission_id) = 36)
    REFERENCES newcomer_submissions(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES newcomer_fields(id) ON DELETE RESTRICT,
  value TEXT NOT NULL CHECK (octet_length(value) <= 4000),
  PRIMARY KEY (submission_id, field_id)
);
CREATE INDEX idx_newcomer_answers_field
  ON newcomer_answers(field_id, submission_id);

CREATE OR REPLACE FUNCTION newcomer_answers_custom_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 1) THEN
    RAISE EXCEPTION 'newcomer_answers_custom_only';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER newcomer_answers_custom_insert
BEFORE INSERT ON newcomer_answers FOR EACH ROW
EXECUTE FUNCTION newcomer_answers_custom_guard();
CREATE TRIGGER newcomer_answers_custom_update
BEFORE UPDATE ON newcomer_answers FOR EACH ROW
EXECUTE FUNCTION newcomer_answers_custom_guard();

CREATE TABLE newcomer_notes (
  id TEXT PRIMARY KEY CHECK (newcomer_valid_uuid(id)),
  submission_id TEXT NOT NULL CHECK (octet_length(submission_id) = 36)
    REFERENCES newcomer_submissions(id) ON DELETE CASCADE,
  author_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (body = trim(body) AND octet_length(body) BETWEEN 1 AND 10000),
  created_at TEXT NOT NULL DEFAULT (datetime('now')) CHECK (newcomer_valid_timestamp(created_at))
);
CREATE INDEX idx_newcomer_notes_submission_created
  ON newcomer_notes(submission_id, created_at, id);

CREATE TABLE newcomer_activity (
  id TEXT PRIMARY KEY CHECK (newcomer_valid_uuid(id)),
  submission_id TEXT NOT NULL CHECK (octet_length(submission_id) = 36)
    REFERENCES newcomer_submissions(id) ON DELETE CASCADE,
  actor_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
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
  bucket_hash TEXT NOT NULL CHECK (octet_length(bucket_hash) = 64 AND bucket_hash ~ '^[0-9a-f]{64}$'),
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

-- Browser-facing Supabase roles receive no direct newcomer-table access.
-- Server PostgreSQL/Hyperdrive connects as the table owner and is unaffected.
ALTER TABLE newcomer_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE newcomer_status_i18n ENABLE ROW LEVEL SECURITY;
ALTER TABLE newcomer_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE newcomer_field_i18n ENABLE ROW LEVEL SECURITY;
ALTER TABLE newcomer_field_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE newcomer_field_option_i18n ENABLE ROW LEVEL SECURITY;
ALTER TABLE newcomer_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE newcomer_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE newcomer_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE newcomer_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE newcomer_rate_limits ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE
          newcomer_statuses,
          newcomer_status_i18n,
          newcomer_fields,
          newcomer_field_i18n,
          newcomer_field_options,
          newcomer_field_option_i18n,
          newcomer_submissions,
          newcomer_answers,
          newcomer_notes,
          newcomer_activity,
          newcomer_rate_limits
        FROM %I',
        client_role
      );
    END IF;
  END LOOP;
END
$$;
