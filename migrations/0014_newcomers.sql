-- Newcomer intake and follow-up foundation. Fixed core fields mirror columns on
-- newcomer_submissions; only later custom fields store newcomer_answers rows.
-- Status zero-initial prevention and fixed-field management are application
-- invariants; the schema prevents invalid and multiple active open initials.

CREATE TABLE newcomer_statuses (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  category TEXT NOT NULL CHECK (category IN ('open','closed')),
  sort INTEGER NOT NULL CHECK (sort BETWEEN 0 AND 100000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_initial INTEGER NOT NULL DEFAULT 0 CHECK (is_initial IN (0,1)),
  CHECK (is_initial = 0 OR (category = 'open' AND active = 1))
) WITHOUT ROWID;

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
) WITHOUT ROWID;

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
  key TEXT NOT NULL UNIQUE
    CHECK (
      length(key) BETWEEN 1 AND 64 AND key = lower(trim(key)) AND
      substr(key, 1, 1) GLOB '[a-z]' AND key NOT GLOB '*[^a-z0-9_]*'
    ),
  type TEXT NOT NULL CHECK (type IN ('text','textarea','select','checkbox')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort INTEGER NOT NULL DEFAULT 0 CHECK (sort BETWEEN 0 AND 100000),
  fixed INTEGER NOT NULL DEFAULT 0 CHECK (fixed IN (0,1))
) WITHOUT ROWID;

CREATE INDEX idx_newcomer_fields_active_sort
  ON newcomer_fields(active, sort, id);

CREATE TABLE newcomer_field_i18n (
  field_id INTEGER NOT NULL REFERENCES newcomer_fields(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  label TEXT NOT NULL CHECK (label = trim(label) AND length(label) BETWEEN 1 AND 100),
  help TEXT CHECK (help IS NULL OR length(help) <= 500),
  PRIMARY KEY (field_id, locale)
) WITHOUT ROWID;

CREATE TABLE newcomer_field_options (
  field_id INTEGER NOT NULL REFERENCES newcomer_fields(id) ON DELETE CASCADE,
  value TEXT NOT NULL
    CHECK (
      length(value) BETWEEN 1 AND 80 AND value = lower(trim(value)) AND
      substr(value, 1, 1) GLOB '[a-z0-9]' AND value NOT GLOB '*[^a-z0-9_-]*'
    ),
  sort INTEGER NOT NULL DEFAULT 0 CHECK (sort BETWEEN 0 AND 100000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (field_id, value)
) WITHOUT ROWID;

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
) WITHOUT ROWID;

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
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 36 AND id = lower(id) AND
      substr(id,9,1) = '-' AND substr(id,14,1) = '-' AND
      substr(id,19,1) = '-' AND substr(id,24,1) = '-' AND
      length(replace(id,'-','')) = 32 AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  name TEXT CHECK (name IS NULL OR (name = trim(name) AND length(name) BETWEEN 1 AND 200)),
  email TEXT CHECK (
    email IS NULL OR (
      email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254 AND
      email LIKE '%@%' AND email NOT LIKE '% %'
    )
  ),
  phone TEXT CHECK (
    phone IS NULL OR (
      length(phone) BETWEEN 8 AND 16 AND substr(phone,1,1) = '+' AND
      substr(phone,2) <> '' AND substr(phone,2) NOT GLOB '*[^0-9]*'
    )
  ),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  visit_date TEXT NOT NULL
    CHECK (
      length(visit_date) = 10 AND substr(visit_date,5,1) = '-' AND substr(visit_date,8,1) = '-' AND
      substr(visit_date,1,4) BETWEEN '0001' AND '9999' AND
      substr(visit_date,6,2) BETWEEN '01' AND '12' AND substr(visit_date,9,2) BETWEEN '01' AND '31' AND
      (substr(visit_date,6,2) NOT IN ('04','06','09','11') OR substr(visit_date,9,2) <= '30') AND
      (substr(visit_date,6,2) <> '02' OR substr(visit_date,9,2) <= '29') AND
      (date(visit_date,'+0 days') = visit_date) IS TRUE
    ),
  service_type_id INTEGER REFERENCES service_types(id),
  contact_consent_at TEXT
    CHECK (contact_consent_at IS NULL OR (
      length(contact_consent_at) = 19 AND substr(contact_consent_at,5,1) = '-' AND
      substr(contact_consent_at,8,1) = '-' AND substr(contact_consent_at,11,1) = ' ' AND
      substr(contact_consent_at,14,1) = ':' AND substr(contact_consent_at,17,1) = ':' AND
      substr(contact_consent_at,1,4) BETWEEN '0001' AND '9999' AND
      substr(contact_consent_at,12,2) BETWEEN '00' AND '23' AND
      substr(contact_consent_at,15,2) BETWEEN '00' AND '59' AND
      substr(contact_consent_at,18,2) BETWEEN '00' AND '59' AND
      date(substr(contact_consent_at,1,10),'+0 days') = substr(contact_consent_at,1,10) AND
      datetime(contact_consent_at,'+0 seconds') = contact_consent_at
    )),
  source TEXT NOT NULL CHECK (source IN ('public','staff')),
  status_id INTEGER NOT NULL DEFAULT 1 REFERENCES newcomer_statuses(id),
  assignee_person_id INTEGER REFERENCES people(id),
  linked_person_id INTEGER REFERENCES people(id),
  next_follow_up_date TEXT
    CHECK (next_follow_up_date IS NULL OR (
      length(next_follow_up_date) = 10 AND substr(next_follow_up_date,5,1) = '-' AND substr(next_follow_up_date,8,1) = '-' AND
      substr(next_follow_up_date,1,4) BETWEEN '0001' AND '9999' AND
      substr(next_follow_up_date,6,2) BETWEEN '01' AND '12' AND substr(next_follow_up_date,9,2) BETWEEN '01' AND '31' AND
      (substr(next_follow_up_date,6,2) NOT IN ('04','06','09','11') OR substr(next_follow_up_date,9,2) <= '30') AND
      (substr(next_follow_up_date,6,2) <> '02' OR substr(next_follow_up_date,9,2) <= '29') AND
      (date(next_follow_up_date,'+0 days') = next_follow_up_date) IS TRUE
    )),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 2147483647),
  last_mutation_id TEXT CHECK (last_mutation_id IS NULL OR length(last_mutation_id) BETWEEN 1 AND 64),
  closed_at TEXT
    CHECK (closed_at IS NULL OR (
      length(closed_at) = 19 AND substr(closed_at,5,1) = '-' AND substr(closed_at,8,1) = '-' AND
      substr(closed_at,11,1) = ' ' AND substr(closed_at,14,1) = ':' AND substr(closed_at,17,1) = ':' AND
      substr(closed_at,1,4) BETWEEN '0001' AND '9999' AND substr(closed_at,12,2) BETWEEN '00' AND '23' AND
      substr(closed_at,15,2) BETWEEN '00' AND '59' AND substr(closed_at,18,2) BETWEEN '00' AND '59' AND
      date(substr(closed_at,1,10),'+0 days') = substr(closed_at,1,10) AND datetime(closed_at,'+0 seconds') = closed_at
    )),
  deleted_at TEXT
    CHECK (deleted_at IS NULL OR (
      length(deleted_at) = 19 AND substr(deleted_at,5,1) = '-' AND substr(deleted_at,8,1) = '-' AND
      substr(deleted_at,11,1) = ' ' AND substr(deleted_at,14,1) = ':' AND substr(deleted_at,17,1) = ':' AND
      substr(deleted_at,1,4) BETWEEN '0001' AND '9999' AND substr(deleted_at,12,2) BETWEEN '00' AND '23' AND
      substr(deleted_at,15,2) BETWEEN '00' AND '59' AND substr(deleted_at,18,2) BETWEEN '00' AND '59' AND
      date(substr(deleted_at,1,10),'+0 days') = substr(deleted_at,1,10) AND datetime(deleted_at,'+0 seconds') = deleted_at
    )),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (
      length(created_at) = 19 AND substr(created_at,5,1) = '-' AND substr(created_at,8,1) = '-' AND
      substr(created_at,11,1) = ' ' AND substr(created_at,14,1) = ':' AND substr(created_at,17,1) = ':' AND
      substr(created_at,1,4) BETWEEN '0001' AND '9999' AND substr(created_at,12,2) BETWEEN '00' AND '23' AND
      substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND
      date(substr(created_at,1,10),'+0 days') = substr(created_at,1,10) AND datetime(created_at,'+0 seconds') = created_at
    ),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (
      length(updated_at) = 19 AND substr(updated_at,5,1) = '-' AND substr(updated_at,8,1) = '-' AND
      substr(updated_at,11,1) = ' ' AND substr(updated_at,14,1) = ':' AND substr(updated_at,17,1) = ':' AND
      substr(updated_at,1,4) BETWEEN '0001' AND '9999' AND substr(updated_at,12,2) BETWEEN '00' AND '23' AND
      substr(updated_at,15,2) BETWEEN '00' AND '59' AND substr(updated_at,18,2) BETWEEN '00' AND '59' AND
      date(substr(updated_at,1,10),'+0 days') = substr(updated_at,1,10) AND datetime(updated_at,'+0 seconds') = updated_at
    ),
  CHECK (name IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL)
) WITHOUT ROWID;

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
) WITHOUT ROWID;
CREATE INDEX idx_newcomer_answers_field
  ON newcomer_answers(field_id, submission_id);

CREATE TABLE newcomer_notes (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 36 AND id = lower(id) AND
      substr(id,9,1) = '-' AND substr(id,14,1) = '-' AND substr(id,19,1) = '-' AND substr(id,24,1) = '-' AND
      length(replace(id,'-','')) = 32 AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  submission_id TEXT NOT NULL REFERENCES newcomer_submissions(id) ON DELETE CASCADE,
  author_person_id INTEGER NOT NULL REFERENCES people(id),
  body TEXT NOT NULL CHECK (body = trim(body) AND length(body) BETWEEN 1 AND 10000),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (
      length(created_at) = 19 AND substr(created_at,5,1) = '-' AND substr(created_at,8,1) = '-' AND
      substr(created_at,11,1) = ' ' AND substr(created_at,14,1) = ':' AND substr(created_at,17,1) = ':' AND
      substr(created_at,1,4) BETWEEN '0001' AND '9999' AND substr(created_at,12,2) BETWEEN '00' AND '23' AND
      substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND
      date(substr(created_at,1,10),'+0 days') = substr(created_at,1,10) AND datetime(created_at,'+0 seconds') = created_at
    )
) WITHOUT ROWID;
CREATE INDEX idx_newcomer_notes_submission_created
  ON newcomer_notes(submission_id, created_at, id);

-- Metadata remains structural: the DB admits only these non-PII top-level keys
-- and scalar types. The application must additionally validate the exact key
-- combination required by each activity kind.
CREATE TABLE newcomer_activity (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 36 AND id = lower(id) AND
      substr(id,9,1) = '-' AND substr(id,14,1) = '-' AND substr(id,19,1) = '-' AND substr(id,24,1) = '-' AND
      length(replace(id,'-','')) = 32 AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  submission_id TEXT NOT NULL REFERENCES newcomer_submissions(id) ON DELETE CASCADE,
  actor_person_id INTEGER REFERENCES people(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'submission_created','assigned','status_changed','follow_up_scheduled',
    'note_added','person_linked','visitor_created'
  )),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      length(metadata_json) BETWEEN 2 AND 512 AND
      CASE WHEN json_valid(metadata_json) THEN
        json_type(metadata_json) = 'object' AND
        json_remove(
          metadata_json,
          '$.assignee_person_id','$.from_assignee_person_id','$.to_assignee_person_id',
          '$.status_id','$.from_status_id','$.to_status_id','$.person_id','$.note_id','$.follow_up_date'
        ) = '{}' AND
        (json_type(metadata_json,'$.assignee_person_id') IS NULL OR
          (json_type(metadata_json,'$.assignee_person_id') = 'integer' AND json_extract(metadata_json,'$.assignee_person_id') BETWEEN 1 AND 2147483647)) AND
        (json_type(metadata_json,'$.from_assignee_person_id') IS NULL OR
          (json_type(metadata_json,'$.from_assignee_person_id') = 'integer' AND json_extract(metadata_json,'$.from_assignee_person_id') BETWEEN 1 AND 2147483647)) AND
        (json_type(metadata_json,'$.to_assignee_person_id') IS NULL OR
          (json_type(metadata_json,'$.to_assignee_person_id') = 'integer' AND json_extract(metadata_json,'$.to_assignee_person_id') BETWEEN 1 AND 2147483647)) AND
        (json_type(metadata_json,'$.status_id') IS NULL OR
          (json_type(metadata_json,'$.status_id') = 'integer' AND json_extract(metadata_json,'$.status_id') BETWEEN 1 AND 2147483647)) AND
        (json_type(metadata_json,'$.from_status_id') IS NULL OR
          (json_type(metadata_json,'$.from_status_id') = 'integer' AND json_extract(metadata_json,'$.from_status_id') BETWEEN 1 AND 2147483647)) AND
        (json_type(metadata_json,'$.to_status_id') IS NULL OR
          (json_type(metadata_json,'$.to_status_id') = 'integer' AND json_extract(metadata_json,'$.to_status_id') BETWEEN 1 AND 2147483647)) AND
        (json_type(metadata_json,'$.person_id') IS NULL OR
          (json_type(metadata_json,'$.person_id') = 'integer' AND json_extract(metadata_json,'$.person_id') BETWEEN 1 AND 2147483647)) AND
        (json_type(metadata_json,'$.note_id') IS NULL OR (
          json_type(metadata_json,'$.note_id') = 'text' AND length(json_extract(metadata_json,'$.note_id')) = 36 AND
          json_extract(metadata_json,'$.note_id') = lower(json_extract(metadata_json,'$.note_id')) AND
          substr(json_extract(metadata_json,'$.note_id'),9,1) = '-' AND substr(json_extract(metadata_json,'$.note_id'),14,1) = '-' AND
          substr(json_extract(metadata_json,'$.note_id'),19,1) = '-' AND substr(json_extract(metadata_json,'$.note_id'),24,1) = '-' AND
          length(replace(json_extract(metadata_json,'$.note_id'),'-','')) = 32 AND
          json_extract(metadata_json,'$.note_id') NOT GLOB '*[^0-9a-f-]*'
        )) AND
        (json_type(metadata_json,'$.follow_up_date') IS NULL OR (
          json_type(metadata_json,'$.follow_up_date') = 'text' AND
          length(json_extract(metadata_json,'$.follow_up_date')) = 10 AND
          substr(json_extract(metadata_json,'$.follow_up_date'),1,4) BETWEEN '0001' AND '9999' AND
          date(json_extract(metadata_json,'$.follow_up_date'),'+0 days') = json_extract(metadata_json,'$.follow_up_date')
        ))
      ELSE 0 END
    ),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (
      length(created_at) = 19 AND substr(created_at,5,1) = '-' AND substr(created_at,8,1) = '-' AND
      substr(created_at,11,1) = ' ' AND substr(created_at,14,1) = ':' AND substr(created_at,17,1) = ':' AND
      substr(created_at,1,4) BETWEEN '0001' AND '9999' AND substr(created_at,12,2) BETWEEN '00' AND '23' AND
      substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND
      date(substr(created_at,1,10),'+0 days') = substr(created_at,1,10) AND datetime(created_at,'+0 seconds') = created_at
    )
) WITHOUT ROWID;
CREATE INDEX idx_newcomer_activity_submission_created
  ON newcomer_activity(submission_id, created_at, id);
CREATE INDEX idx_newcomer_activity_kind_created
  ON newcomer_activity(kind, created_at, id);

CREATE TABLE newcomer_rate_limits (
  bucket_hash TEXT NOT NULL
    CHECK (length(bucket_hash) = 64 AND bucket_hash = lower(bucket_hash) AND bucket_hash NOT GLOB '*[^0-9a-f]*'),
  window_start TEXT NOT NULL
    CHECK (
      length(window_start) = 19 AND substr(window_start,5,1) = '-' AND substr(window_start,8,1) = '-' AND
      substr(window_start,11,1) = ' ' AND substr(window_start,14,1) = ':' AND substr(window_start,17,1) = ':' AND
      substr(window_start,1,4) BETWEEN '0001' AND '9999' AND substr(window_start,12,2) BETWEEN '00' AND '23' AND
      substr(window_start,15,2) BETWEEN '00' AND '59' AND substr(window_start,16,1) = '0' AND
      substr(window_start,18,2) = '00' AND date(substr(window_start,1,10),'+0 days') = substr(window_start,1,10) AND
      datetime(window_start,'+0 seconds') = window_start
    ),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 100000),
  expires_at TEXT NOT NULL
    CHECK (
      length(expires_at) = 19 AND date(substr(expires_at,1,10),'+0 days') = substr(expires_at,1,10) AND
      datetime(expires_at,'+0 seconds') = expires_at AND expires_at = datetime(window_start,'+48 hours')
    ),
  PRIMARY KEY (bucket_hash, window_start)
) WITHOUT ROWID;
CREATE INDEX idx_newcomer_rate_limits_expires
  ON newcomer_rate_limits(expires_at, bucket_hash, window_start);
