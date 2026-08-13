-- Newcomer intake and follow-up foundation. Fixed core fields mirror columns on
-- newcomer_submissions; only later custom fields store newcomer_answers rows.
-- Preventing zero active open initials remains an application invariant; the
-- schema prevents invalid/multiple initials and protects fixed field carriers.

CREATE TABLE newcomer_statuses (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  key TEXT NOT NULL UNIQUE
    CHECK (
      instr(key,char(0)) = 0 AND length(CAST(key AS BLOB)) BETWEEN 1 AND 64 AND key = lower(trim(key)) AND
      substr(key, 1, 1) GLOB '[a-z]' AND key NOT GLOB '*[^a-z0-9_]*'
    ),
  category TEXT NOT NULL CHECK (instr(category,char(0)) = 0 AND category IN ('open','closed')),
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
  locale TEXT NOT NULL CHECK (instr(locale,char(0)) = 0 AND locale IN ('en','zh')),
  label TEXT NOT NULL CHECK (
    instr(label,char(0)) = 0 AND label = trim(label) AND length(CAST(label AS BLOB)) BETWEEN 1 AND 100
  ),
  PRIMARY KEY (status_id, locale)
) WITHOUT ROWID;

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

-- The five seeded identities are application-owned. Custom statuses use IDs
-- above the fixed range, while every status keeps its stable key and immutable
-- open/closed category after creation. Ordering, active, and initial remain
-- application-managed fields.
CREATE TRIGGER newcomer_statuses_boundary_insert
BEFORE INSERT ON newcomer_statuses
WHEN NOT (
  (NEW.id = 1 AND NEW.key = 'new') OR
  (NEW.id = 2 AND NEW.key = 'assigned') OR
  (NEW.id = 3 AND NEW.key = 'contacted') OR
  (NEW.id = 4 AND NEW.key = 'connected') OR
  (NEW.id = 5 AND NEW.key = 'closed') OR
  (NEW.id > 5 AND NEW.key NOT IN ('new','assigned','contacted','connected','closed'))
)
BEGIN
  SELECT RAISE(ABORT, 'newcomer_status_boundary');
END;

CREATE TRIGGER newcomer_statuses_boundary_update
BEFORE UPDATE ON newcomer_statuses
WHEN NOT (
  NEW.id = OLD.id AND NEW.key = OLD.key AND NEW.category = OLD.category
)
BEGIN
  SELECT RAISE(ABORT, 'newcomer_status_immutable');
END;

CREATE TRIGGER newcomer_statuses_core_delete
BEFORE DELETE ON newcomer_statuses
WHEN OLD.id <= 5
BEGIN
  SELECT RAISE(ABORT, 'newcomer_status_immutable');
END;

CREATE TABLE newcomer_fields (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647),
  key TEXT NOT NULL UNIQUE
    CHECK (
      instr(key,char(0)) = 0 AND length(CAST(key AS BLOB)) BETWEEN 1 AND 64 AND key = lower(trim(key)) AND
      substr(key, 1, 1) GLOB '[a-z]' AND key NOT GLOB '*[^a-z0-9_]*'
    ),
  type TEXT NOT NULL CHECK (instr(type,char(0)) = 0 AND type IN ('text','textarea','select','checkbox')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort INTEGER NOT NULL DEFAULT 0 CHECK (sort BETWEEN 0 AND 100000),
  fixed INTEGER NOT NULL DEFAULT 0 CHECK (fixed IN (0,1))
) WITHOUT ROWID;

CREATE INDEX idx_newcomer_fields_active_sort
  ON newcomer_fields(active, sort, id);

CREATE TABLE newcomer_field_i18n (
  field_id INTEGER NOT NULL REFERENCES newcomer_fields(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (instr(locale,char(0)) = 0 AND locale IN ('en','zh')),
  label TEXT NOT NULL CHECK (
    instr(label,char(0)) = 0 AND label = trim(label) AND length(CAST(label AS BLOB)) BETWEEN 1 AND 100
  ),
  help TEXT CHECK (help IS NULL OR (instr(help,char(0)) = 0 AND length(CAST(help AS BLOB)) <= 500)),
  PRIMARY KEY (field_id, locale)
) WITHOUT ROWID;

CREATE TABLE newcomer_field_options (
  field_id INTEGER NOT NULL REFERENCES newcomer_fields(id) ON DELETE CASCADE,
  value TEXT NOT NULL
    CHECK (
      instr(value,char(0)) = 0 AND length(CAST(value AS BLOB)) BETWEEN 1 AND 80 AND value = lower(trim(value)) AND
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
  value TEXT NOT NULL CHECK (instr(value,char(0)) = 0 AND length(CAST(value AS BLOB)) BETWEEN 1 AND 80),
  locale TEXT NOT NULL CHECK (instr(locale,char(0)) = 0 AND locale IN ('en','zh')),
  label TEXT NOT NULL CHECK (
    instr(label,char(0)) = 0 AND label = trim(label) AND length(CAST(label AS BLOB)) BETWEEN 1 AND 100
  ),
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

-- The seven core carriers mirror newcomer_submissions columns. Their labels
-- and ordering remain editable, but their schema identity cannot be changed.
CREATE TRIGGER newcomer_fields_boundary_insert
BEFORE INSERT ON newcomer_fields
WHEN NOT (
  NEW.id > 7 AND
  NEW.key NOT IN ('name','email','phone','preferred_language','visit_date','service_type','contact_consent') AND
  NEW.fixed = 0
)
BEGIN
  SELECT RAISE(ABORT, 'newcomer_field_boundary');
END;

CREATE TRIGGER newcomer_fields_boundary_update
BEFORE UPDATE ON newcomer_fields
WHEN NOT (
  (NEW.id = 1 AND NEW.key = 'name' AND NEW.type = 'text' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
  (NEW.id = 2 AND NEW.key = 'email' AND NEW.type = 'text' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
  (NEW.id = 3 AND NEW.key = 'phone' AND NEW.type = 'text' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
  (NEW.id = 4 AND NEW.key = 'preferred_language' AND NEW.type = 'select' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
  (NEW.id = 5 AND NEW.key = 'visit_date' AND NEW.type = 'text' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
  (NEW.id = 6 AND NEW.key = 'service_type' AND NEW.type = 'select' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
  (NEW.id = 7 AND NEW.key = 'contact_consent' AND NEW.type = 'checkbox' AND NEW.required = 0 AND NEW.active = 1 AND NEW.fixed = 1) OR
  (NEW.id > 7 AND NEW.key NOT IN ('name','email','phone','preferred_language','visit_date','service_type','contact_consent') AND NEW.fixed = 0)
)
BEGIN
  SELECT RAISE(ABORT, 'newcomer_field_boundary');
END;

CREATE TRIGGER newcomer_fields_core_delete
BEFORE DELETE ON newcomer_fields
WHEN OLD.fixed = 1
BEGIN
  SELECT RAISE(ABORT, 'newcomer_field_immutable');
END;

CREATE TRIGGER newcomer_field_options_custom_insert
BEFORE INSERT ON newcomer_field_options
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 1
  ) THEN RAISE(ABORT, 'newcomer_field_options_custom_only') END;
END;

CREATE TRIGGER newcomer_field_options_custom_update
BEFORE UPDATE ON newcomer_field_options
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 1
  ) THEN RAISE(ABORT, 'newcomer_field_options_custom_only') END;
END;

CREATE TABLE newcomer_submissions (
  id TEXT PRIMARY KEY
    CHECK (
      instr(id,char(0)) = 0 AND length(CAST(id AS BLOB)) = 36 AND id = lower(id) AND
      substr(id,9,1) = '-' AND substr(id,14,1) = '-' AND
      substr(id,19,1) = '-' AND substr(id,24,1) = '-' AND
      length(replace(id,'-','')) = 32 AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  name TEXT CHECK (name IS NULL OR (
    instr(name,char(0)) = 0 AND name = trim(name) AND length(CAST(name AS BLOB)) BETWEEN 1 AND 200
  )),
  email TEXT CHECK (
    email IS NULL OR (
      email = lower(trim(email)) AND length(CAST(email AS BLOB)) BETWEEN 3 AND 254 AND
      instr(email,'@') BETWEEN 2 AND length(email) - 1 AND
      instr(substr(email,instr(email,'@') + 1),'@') = 0 AND
      substr(email,1,instr(email,'@') - 1) NOT GLOB '*[^a-z0-9.!#$%&''*+/=?^_`{|}~-]*' AND
      substr(email,1,instr(email,'@') - 1) NOT GLOB '.*' AND
      substr(email,1,instr(email,'@') - 1) NOT GLOB '*.' AND
      substr(email,1,instr(email,'@') - 1) NOT GLOB '*..*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*[^a-z0-9.-]*' AND
      substr(email,instr(email,'@') + 1) GLOB '*.*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '.*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*.' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '-*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*-' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*..*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*.-*' AND
      substr(email,instr(email,'@') + 1) NOT GLOB '*-.*'
    )
  ),
  phone TEXT CHECK (
    phone IS NULL OR (
      instr(phone,char(0)) = 0 AND length(CAST(phone AS BLOB)) BETWEEN 8 AND 16 AND substr(phone,1,1) = '+' AND
      substr(phone,2,1) GLOB '[1-9]' AND substr(phone,2) NOT GLOB '*[^0-9]*'
    )
  ),
  locale TEXT NOT NULL CHECK (instr(locale,char(0)) = 0 AND locale IN ('en','zh')),
  visit_date TEXT NOT NULL
    CHECK (
      instr(visit_date,char(0)) = 0 AND length(CAST(visit_date AS BLOB)) = 10 AND
      substr(visit_date,5,1) = '-' AND substr(visit_date,8,1) = '-' AND
      substr(visit_date,1,4) BETWEEN '0001' AND '9999' AND
      substr(visit_date,6,2) BETWEEN '01' AND '12' AND substr(visit_date,9,2) BETWEEN '01' AND '31' AND
      (substr(visit_date,6,2) NOT IN ('04','06','09','11') OR substr(visit_date,9,2) <= '30') AND
      (substr(visit_date,6,2) <> '02' OR substr(visit_date,9,2) <= '29') AND
      (date(visit_date,'+0 days') = visit_date) IS TRUE
    ),
  service_type_id INTEGER REFERENCES service_types(id) ON DELETE SET NULL,
  contact_consent_at TEXT
    CHECK (contact_consent_at IS NULL OR (
      instr(contact_consent_at,char(0)) = 0 AND length(CAST(contact_consent_at AS BLOB)) = 19 AND
      substr(contact_consent_at,5,1) = '-' AND
      substr(contact_consent_at,8,1) = '-' AND substr(contact_consent_at,11,1) = ' ' AND
      substr(contact_consent_at,14,1) = ':' AND substr(contact_consent_at,17,1) = ':' AND
      substr(contact_consent_at,1,4) BETWEEN '0001' AND '9999' AND
      substr(contact_consent_at,12,2) BETWEEN '00' AND '23' AND
      substr(contact_consent_at,15,2) BETWEEN '00' AND '59' AND
      substr(contact_consent_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(contact_consent_at,1,10),'+0 days') = substr(contact_consent_at,1,10)) IS TRUE AND
      (datetime(contact_consent_at,'+0 seconds') = contact_consent_at) IS TRUE
    )),
  source TEXT NOT NULL CHECK (instr(source,char(0)) = 0 AND source IN ('public','staff')),
  status_id INTEGER NOT NULL DEFAULT 1 REFERENCES newcomer_statuses(id) ON DELETE RESTRICT,
  assignee_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  linked_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  next_follow_up_date TEXT
    CHECK (next_follow_up_date IS NULL OR (
      instr(next_follow_up_date,char(0)) = 0 AND length(CAST(next_follow_up_date AS BLOB)) = 10 AND
      substr(next_follow_up_date,5,1) = '-' AND substr(next_follow_up_date,8,1) = '-' AND
      substr(next_follow_up_date,1,4) BETWEEN '0001' AND '9999' AND
      substr(next_follow_up_date,6,2) BETWEEN '01' AND '12' AND substr(next_follow_up_date,9,2) BETWEEN '01' AND '31' AND
      (substr(next_follow_up_date,6,2) NOT IN ('04','06','09','11') OR substr(next_follow_up_date,9,2) <= '30') AND
      (substr(next_follow_up_date,6,2) <> '02' OR substr(next_follow_up_date,9,2) <= '29') AND
      (date(next_follow_up_date,'+0 days') = next_follow_up_date) IS TRUE
    )),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 2147483647),
  last_mutation_id TEXT CHECK (last_mutation_id IS NULL OR (
    instr(last_mutation_id,char(0)) = 0 AND length(CAST(last_mutation_id AS BLOB)) BETWEEN 1 AND 64
  )),
  closed_at TEXT
    CHECK (closed_at IS NULL OR (
      instr(closed_at,char(0)) = 0 AND length(CAST(closed_at AS BLOB)) = 19 AND
      substr(closed_at,5,1) = '-' AND substr(closed_at,8,1) = '-' AND
      substr(closed_at,11,1) = ' ' AND substr(closed_at,14,1) = ':' AND substr(closed_at,17,1) = ':' AND
      substr(closed_at,1,4) BETWEEN '0001' AND '9999' AND substr(closed_at,12,2) BETWEEN '00' AND '23' AND
      substr(closed_at,15,2) BETWEEN '00' AND '59' AND substr(closed_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(closed_at,1,10),'+0 days') = substr(closed_at,1,10)) IS TRUE AND
      (datetime(closed_at,'+0 seconds') = closed_at) IS TRUE
    )),
  deleted_at TEXT
    CHECK (deleted_at IS NULL OR (
      instr(deleted_at,char(0)) = 0 AND length(CAST(deleted_at AS BLOB)) = 19 AND
      substr(deleted_at,5,1) = '-' AND substr(deleted_at,8,1) = '-' AND
      substr(deleted_at,11,1) = ' ' AND substr(deleted_at,14,1) = ':' AND substr(deleted_at,17,1) = ':' AND
      substr(deleted_at,1,4) BETWEEN '0001' AND '9999' AND substr(deleted_at,12,2) BETWEEN '00' AND '23' AND
      substr(deleted_at,15,2) BETWEEN '00' AND '59' AND substr(deleted_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(deleted_at,1,10),'+0 days') = substr(deleted_at,1,10)) IS TRUE AND
      (datetime(deleted_at,'+0 seconds') = deleted_at) IS TRUE
    )),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (
      instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) = 19 AND
      substr(created_at,5,1) = '-' AND substr(created_at,8,1) = '-' AND
      substr(created_at,11,1) = ' ' AND substr(created_at,14,1) = ':' AND substr(created_at,17,1) = ':' AND
      substr(created_at,1,4) BETWEEN '0001' AND '9999' AND substr(created_at,12,2) BETWEEN '00' AND '23' AND
      substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(created_at,1,10),'+0 days') = substr(created_at,1,10)) IS TRUE AND
      (datetime(created_at,'+0 seconds') = created_at) IS TRUE
    ),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (
      instr(updated_at,char(0)) = 0 AND length(CAST(updated_at AS BLOB)) = 19 AND
      substr(updated_at,5,1) = '-' AND substr(updated_at,8,1) = '-' AND
      substr(updated_at,11,1) = ' ' AND substr(updated_at,14,1) = ':' AND substr(updated_at,17,1) = ':' AND
      substr(updated_at,1,4) BETWEEN '0001' AND '9999' AND substr(updated_at,12,2) BETWEEN '00' AND '23' AND
      substr(updated_at,15,2) BETWEEN '00' AND '59' AND substr(updated_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(updated_at,1,10),'+0 days') = substr(updated_at,1,10)) IS TRUE AND
      (datetime(updated_at,'+0 seconds') = updated_at) IS TRUE
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
  submission_id TEXT NOT NULL CHECK (
    instr(submission_id,char(0)) = 0 AND length(CAST(submission_id AS BLOB)) = 36
  ) REFERENCES newcomer_submissions(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES newcomer_fields(id) ON DELETE RESTRICT,
  value TEXT NOT NULL CHECK (instr(value,char(0)) = 0 AND length(CAST(value AS BLOB)) <= 4000),
  PRIMARY KEY (submission_id, field_id)
) WITHOUT ROWID;
CREATE INDEX idx_newcomer_answers_field
  ON newcomer_answers(field_id, submission_id);

CREATE TRIGGER newcomer_answers_custom_insert
BEFORE INSERT ON newcomer_answers
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 1
  ) THEN RAISE(ABORT, 'newcomer_answers_custom_only') END;
END;

CREATE TRIGGER newcomer_answers_custom_update
BEFORE UPDATE ON newcomer_answers
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM newcomer_fields WHERE id = NEW.field_id AND fixed = 1
  ) THEN RAISE(ABORT, 'newcomer_answers_custom_only') END;
END;

CREATE TABLE newcomer_notes (
  id TEXT PRIMARY KEY
    CHECK (
      instr(id,char(0)) = 0 AND length(CAST(id AS BLOB)) = 36 AND id = lower(id) AND
      substr(id,9,1) = '-' AND substr(id,14,1) = '-' AND substr(id,19,1) = '-' AND substr(id,24,1) = '-' AND
      length(replace(id,'-','')) = 32 AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  submission_id TEXT NOT NULL CHECK (
    instr(submission_id,char(0)) = 0 AND length(CAST(submission_id AS BLOB)) = 36
  ) REFERENCES newcomer_submissions(id) ON DELETE CASCADE,
  author_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (
    instr(body,char(0)) = 0 AND body = trim(body) AND length(CAST(body AS BLOB)) BETWEEN 1 AND 10000
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (
      instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) = 19 AND
      substr(created_at,5,1) = '-' AND substr(created_at,8,1) = '-' AND
      substr(created_at,11,1) = ' ' AND substr(created_at,14,1) = ':' AND substr(created_at,17,1) = ':' AND
      substr(created_at,1,4) BETWEEN '0001' AND '9999' AND substr(created_at,12,2) BETWEEN '00' AND '23' AND
      substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(created_at,1,10),'+0 days') = substr(created_at,1,10)) IS TRUE AND
      (datetime(created_at,'+0 seconds') = created_at) IS TRUE
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
      instr(id,char(0)) = 0 AND length(CAST(id AS BLOB)) = 36 AND id = lower(id) AND
      substr(id,9,1) = '-' AND substr(id,14,1) = '-' AND substr(id,19,1) = '-' AND substr(id,24,1) = '-' AND
      length(replace(id,'-','')) = 32 AND id NOT GLOB '*[^0-9a-f-]*'
    ),
  submission_id TEXT NOT NULL CHECK (
    instr(submission_id,char(0)) = 0 AND length(CAST(submission_id AS BLOB)) = 36
  ) REFERENCES newcomer_submissions(id) ON DELETE CASCADE,
  actor_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (instr(kind,char(0)) = 0 AND kind IN (
    'submission_created','assigned','status_changed','follow_up_scheduled',
    'note_added','person_linked','visitor_created'
  )),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      instr(metadata_json,char(0)) = 0 AND length(CAST(metadata_json AS BLOB)) BETWEEN 2 AND 512 AND
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
          (date(json_extract(metadata_json,'$.follow_up_date'),'+0 days') =
            json_extract(metadata_json,'$.follow_up_date')) IS TRUE
        )) AND
        metadata_json = json_patch(
          json_patch(
            json_patch(
              json_patch(
                json_patch(
                  json_patch(
                    json_patch(
                      json_patch(
                        json_patch(
                          '{}',
                          CASE WHEN json_type(metadata_json,'$.assignee_person_id') IS NULL THEN '{}'
                            ELSE json_object('assignee_person_id',json_extract(metadata_json,'$.assignee_person_id')) END
                        ),
                        CASE WHEN json_type(metadata_json,'$.from_assignee_person_id') IS NULL THEN '{}'
                          ELSE json_object('from_assignee_person_id',json_extract(metadata_json,'$.from_assignee_person_id')) END
                      ),
                      CASE WHEN json_type(metadata_json,'$.to_assignee_person_id') IS NULL THEN '{}'
                        ELSE json_object('to_assignee_person_id',json_extract(metadata_json,'$.to_assignee_person_id')) END
                    ),
                    CASE WHEN json_type(metadata_json,'$.status_id') IS NULL THEN '{}'
                      ELSE json_object('status_id',json_extract(metadata_json,'$.status_id')) END
                  ),
                  CASE WHEN json_type(metadata_json,'$.from_status_id') IS NULL THEN '{}'
                    ELSE json_object('from_status_id',json_extract(metadata_json,'$.from_status_id')) END
                ),
                CASE WHEN json_type(metadata_json,'$.to_status_id') IS NULL THEN '{}'
                  ELSE json_object('to_status_id',json_extract(metadata_json,'$.to_status_id')) END
              ),
              CASE WHEN json_type(metadata_json,'$.person_id') IS NULL THEN '{}'
                ELSE json_object('person_id',json_extract(metadata_json,'$.person_id')) END
            ),
            CASE WHEN json_type(metadata_json,'$.note_id') IS NULL THEN '{}'
              ELSE json_object('note_id',json_extract(metadata_json,'$.note_id')) END
          ),
          CASE WHEN json_type(metadata_json,'$.follow_up_date') IS NULL THEN '{}'
            ELSE json_object('follow_up_date',json_extract(metadata_json,'$.follow_up_date')) END
        )
      ELSE 0 END
    ),
  operation_id TEXT UNIQUE CHECK (
    operation_id IS NULL OR (
      instr(operation_id,char(0)) = 0 AND length(CAST(operation_id AS BLOB)) = 36 AND
      operation_id = lower(operation_id) AND
      substr(operation_id,9,1) = '-' AND substr(operation_id,14,1) = '-' AND
      substr(operation_id,19,1) = '-' AND substr(operation_id,24,1) = '-' AND
      substr(operation_id,15,1) = '4' AND substr(operation_id,20,1) IN ('8','9','a','b') AND
      length(replace(operation_id,'-','')) = 32 AND operation_id NOT GLOB '*[^0-9a-f-]*'
    )
  ),
  result_version INTEGER CHECK (result_version IS NULL OR result_version BETWEEN 0 AND 2147483647),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (
      instr(created_at,char(0)) = 0 AND length(CAST(created_at AS BLOB)) = 19 AND
      substr(created_at,5,1) = '-' AND substr(created_at,8,1) = '-' AND
      substr(created_at,11,1) = ' ' AND substr(created_at,14,1) = ':' AND substr(created_at,17,1) = ':' AND
      substr(created_at,1,4) BETWEEN '0001' AND '9999' AND substr(created_at,12,2) BETWEEN '00' AND '23' AND
      substr(created_at,15,2) BETWEEN '00' AND '59' AND substr(created_at,18,2) BETWEEN '00' AND '59' AND
      (date(substr(created_at,1,10),'+0 days') = substr(created_at,1,10)) IS TRUE AND
      (datetime(created_at,'+0 seconds') = created_at) IS TRUE
    ),
  CHECK ((operation_id IS NULL) = (result_version IS NULL))
) WITHOUT ROWID;
CREATE INDEX idx_newcomer_activity_submission_created
  ON newcomer_activity(submission_id, created_at, id);
CREATE INDEX idx_newcomer_activity_kind_created
  ON newcomer_activity(kind, created_at, id);

CREATE TABLE newcomer_rate_limits (
  bucket_hash TEXT NOT NULL
    CHECK (
      instr(bucket_hash,char(0)) = 0 AND length(CAST(bucket_hash AS BLOB)) = 64 AND
      bucket_hash = lower(bucket_hash) AND bucket_hash NOT GLOB '*[^0-9a-f]*'
    ),
  window_start TEXT NOT NULL
    CHECK (
      instr(window_start,char(0)) = 0 AND length(CAST(window_start AS BLOB)) = 19 AND
      substr(window_start,5,1) = '-' AND substr(window_start,8,1) = '-' AND
      substr(window_start,11,1) = ' ' AND substr(window_start,14,1) = ':' AND substr(window_start,17,1) = ':' AND
      substr(window_start,1,4) BETWEEN '0001' AND '9999' AND substr(window_start,12,2) BETWEEN '00' AND '23' AND
      substr(window_start,15,2) BETWEEN '00' AND '59' AND substr(window_start,16,1) = '0' AND
      substr(window_start,18,2) = '00' AND
      (date(substr(window_start,1,10),'+0 days') = substr(window_start,1,10)) IS TRUE AND
      (datetime(window_start,'+0 seconds') = window_start) IS TRUE
    ),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 100000),
  expires_at TEXT NOT NULL
    CHECK (
      instr(expires_at,char(0)) = 0 AND length(CAST(expires_at AS BLOB)) = 19 AND
      (date(substr(expires_at,1,10),'+0 days') = substr(expires_at,1,10)) IS TRUE AND
      (datetime(expires_at,'+0 seconds') = expires_at) IS TRUE AND
      (expires_at = datetime(window_start,'+48 hours')) IS TRUE
    ),
  PRIMARY KEY (bucket_hash, window_start)
) WITHOUT ROWID;
CREATE INDEX idx_newcomer_rate_limits_expires
  ON newcomer_rate_limits(expires_at, bucket_hash, window_start);
