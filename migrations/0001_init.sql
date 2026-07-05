-- people: unified identities (members, volunteers, editors, admins)
CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,            -- stored lowercase
  phone TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','editor','admin')),
  active INTEGER NOT NULL DEFAULT 1,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  calendar_token TEXT UNIQUE,
  lang TEXT CHECK (lang IN ('en','zh')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE ministries (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  cover_key TEXT,
  leader_person_id INTEGER REFERENCES people(id),
  meeting_time TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE TABLE ministry_i18n (
  ministry_id INTEGER NOT NULL REFERENCES ministries(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  name TEXT NOT NULL,
  intro TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (ministry_id, locale)
);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  ministry_id INTEGER REFERENCES ministries(id),
  sort INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE TABLE team_i18n (
  team_id INTEGER NOT NULL REFERENCES teams(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  name TEXT NOT NULL,
  PRIMARY KEY (team_id, locale)
);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  sort INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE TABLE position_i18n (
  position_id INTEGER NOT NULL REFERENCES positions(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  name TEXT NOT NULL,
  PRIMARY KEY (position_id, locale)
);

CREATE TABLE team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  is_leader INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (team_id, person_id)
);

CREATE TABLE service_types (
  id INTEGER PRIMARY KEY,
  start_time TEXT,                        -- HH:MM 24h, optional
  end_time TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE TABLE service_type_i18n (
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  name TEXT NOT NULL,
  PRIMARY KEY (service_type_id, locale)
);

CREATE TABLE plans (
  id INTEGER PRIMARY KEY,
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  plan_date TEXT NOT NULL,
  title TEXT,
  series TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (service_type_id, plan_date)
);

CREATE TABLE plan_positions (
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  position_id INTEGER NOT NULL REFERENCES positions(id),
  needed INTEGER NOT NULL DEFAULT 1,
  open_signup INTEGER NOT NULL DEFAULT 0,
  UNIQUE (plan_id, position_id)
);

CREATE TABLE roster_assignments (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  position_id INTEGER NOT NULL REFERENCES positions(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  status TEXT NOT NULL DEFAULT 'U' CHECK (status IN ('U','C','D')),
  decline_reason TEXT,
  is_signup INTEGER NOT NULL DEFAULT 0,
  assigned_by TEXT,
  notified_at TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (plan_id, position_id, person_id)
);

CREATE TABLE blockout_dates (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  reason TEXT,
  recurrence_group TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE team_applications (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  position_id INTEGER REFERENCES positions(id),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'P' CHECK (status IN ('P','A','R')),
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_app_pending_unique
  ON team_applications (person_id, team_id) WHERE status = 'P';

CREATE TABLE person_interests (
  person_id INTEGER NOT NULL REFERENCES people(id),
  category TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (person_id, category)
);

CREATE TABLE gift_results (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  top_gifts_json TEXT NOT NULL,
  recommended_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE testimonies (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id),
  author_name TEXT NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'P' CHECK (status IN ('P','A','R')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  person_id INTEGER NOT NULL REFERENCES people(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('login','respond')),
  assignment_id INTEGER REFERENCES roster_assignments(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Content
CREATE TABLE bulletins (
  id INTEGER PRIMARY KEY,
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  bulletin_date TEXT NOT NULL,
  service_time_label TEXT,
  program_json TEXT,                       -- [{item,content,person}]
  offering_json TEXT,                      -- [{label,amount}]
  attendance_json TEXT,                    -- [{label,count}]
  memory_verse TEXT,
  flowers TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  publish_at TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (service_type_id, bulletin_date)
);

CREATE TABLE bulletin_announcements (
  id INTEGER PRIMARY KEY,
  bulletin_id INTEGER NOT NULL REFERENCES bulletins(id),
  seq INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  link_url TEXT,
  link_label TEXT
);

CREATE TABLE sermons (
  id INTEGER PRIMARY KEY,
  service_type_id INTEGER NOT NULL REFERENCES service_types(id),
  sermon_date TEXT NOT NULL,
  title TEXT NOT NULL,
  speaker TEXT NOT NULL DEFAULT '',
  scripture TEXT,
  youtube_id TEXT,
  series TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  UNIQUE (service_type_id, sermon_date)
);

CREATE TABLE prayer_sheets (
  id INTEGER PRIMARY KEY,
  sheet_date TEXT NOT NULL UNIQUE,
  locale TEXT CHECK (locale IN ('en','zh')),
  sections_json TEXT,                      -- [{heading,items[]}]
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  publish_at TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE announcements (
  id INTEGER PRIMARY KEY,
  url TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE announcement_i18n (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  title TEXT NOT NULL,
  PRIMARY KEY (announcement_id, locale)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  image_key TEXT,
  url TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE event_i18n (
  event_id INTEGER NOT NULL REFERENCES events(id),
  locale TEXT NOT NULL CHECK (locale IN ('en','zh')),
  title TEXT NOT NULL,
  blurb TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (event_id, locale)
);

CREATE TABLE prayer_requests (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','praying','long_term','waiting','answered','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE prayer_activity (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES prayer_requests(id),
  author TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('prayed','comment','moved')),
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE revisions (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL CHECK (entity IN
    ('bulletin','sermon','prayer_sheet','announcement','event')),
  entity_id INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  edited_by TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE media (
  id INTEGER PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE external_ids (
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  system TEXT NOT NULL,
  external_id TEXT NOT NULL,
  UNIQUE (entity, entity_id, system)
);

CREATE INDEX idx_people_email ON people(email);
CREATE INDEX idx_teams_ministry ON teams(ministry_id);
CREATE INDEX idx_positions_team ON positions(team_id);
CREATE INDEX idx_team_members_person ON team_members(person_id);
CREATE INDEX idx_plans_date ON plans(plan_date);
CREATE INDEX idx_plan_positions_plan ON plan_positions(plan_id);
CREATE INDEX idx_roster_plan ON roster_assignments(plan_id);
CREATE INDEX idx_roster_person ON roster_assignments(person_id);
CREATE INDEX idx_blockouts_person ON blockout_dates(person_id);
CREATE INDEX idx_applications_team ON team_applications(team_id, status);
CREATE INDEX idx_gift_results_person ON gift_results(person_id, created_at);
CREATE INDEX idx_testimonies_status ON testimonies(status, locale);
CREATE INDEX idx_tokens_person ON tokens(person_id, purpose);
CREATE INDEX idx_bulletins_date ON bulletins(bulletin_date);
CREATE INDEX idx_bulletin_ann_bulletin ON bulletin_announcements(bulletin_id, seq);
CREATE INDEX idx_sermons_date ON sermons(sermon_date);
CREATE INDEX idx_prayer_requests_status ON prayer_requests(status, created_at);
CREATE INDEX idx_prayer_activity_request ON prayer_activity(request_id, created_at);
CREATE INDEX idx_revisions_entity ON revisions(entity, entity_id, edited_at);
