-- Multi-campus foundation. Existing single-campus installs are upgraded into
-- campus 1, so old rows and old INSERT statements keep their current behavior.
-- Request-time campus scoping is applied by src/lib/campusScope.ts.

CREATE TABLE campuses (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_campuses_one_default
  ON campuses (is_default) WHERE is_default = 1;

INSERT INTO campuses (id, slug, name, active, is_default)
VALUES (1, 'main', 'Main Campus', 1, 1);

-- New shared identities remember the campus that first created them. Existing
-- installs and unscoped setup flows continue to land in the default campus.
ALTER TABLE people ADD COLUMN home_campus_id INTEGER NOT NULL DEFAULT 1;

-- A person is a shared sign-in identity. Their authority is campus-local;
-- super_admin on people remains the master-admin flag and is never granted here.
CREATE TABLE campus_memberships (
  campus_id INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'editor', 'admin')),
  finance INTEGER NOT NULL DEFAULT 0 CHECK (finance IN (0, 1)),
  admin_areas TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (campus_id, person_id)
);

CREATE INDEX idx_campus_memberships_person
  ON campus_memberships (person_id, active, campus_id);

-- Preserve the existing installation's roles and grants in the default campus.
INSERT INTO campus_memberships (campus_id, person_id, role, finance, admin_areas, active)
SELECT 1, id, role, finance, admin_areas, active
FROM people
WHERE deleted_at IS NULL;

CREATE TRIGGER campus_membership_after_person_insert
AFTER INSERT ON people
BEGIN
  INSERT OR IGNORE INTO campus_memberships
    (campus_id, person_id, role, finance, admin_areas, active)
  SELECT id, NEW.id, NEW.role, NEW.finance, NEW.admin_areas, NEW.active
  FROM campuses
  WHERE id = NEW.home_campus_id;
END;

CREATE TABLE campus_modules (
  campus_id INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (campus_id, module_key)
);

CREATE TABLE campus_settings (
  campus_id INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (campus_id, key)
);

INSERT INTO campus_settings (campus_id, key, value)
SELECT 1, key, value FROM settings;

-- Each feature family carries a direct partition key. The constant default is
-- intentional for backwards compatibility; scoped runtime writes always supply
-- the selected campus explicitly.
ALTER TABLE ministries ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE teams ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE households ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bulletins ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sermons ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE prayer_requests ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE media ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE groups ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE group_events ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE checkins ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE service_attendance ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE newcomer_submissions ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activity_score_config ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_provider_connections ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_programs ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;

ALTER TABLE activity_score_dimensions ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE announcement_i18n ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE announcements ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE audit_events ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE blockout_dates ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bulletin_announcements ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE checkin_events ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE custom_page_i18n ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE custom_pages ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE email_log ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE email_rules ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE email_templates ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE event_i18n ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE external_ids ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE gift_results ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE group_attendance ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE group_attendance_tokens ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE group_event_occurrences ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE group_join_requests ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE group_members ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE household_members ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_activities ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_activity_events ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_canvas_cleanup_tasks ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_canvas_event_receipts ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_canvas_oauth_states ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_canvas_webhook_configs ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_courses ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_enrollments ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_google_cleanup_tasks ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_google_notification_receipts ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_google_oauth_states ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_google_registrations ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_identity_links ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_provider_credentials ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_resources ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_submission_snapshots ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_sync_runs ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ministry_i18n ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE newcomer_activity ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE newcomer_answers ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE newcomer_field_i18n ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE newcomer_field_option_i18n ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE newcomer_field_options ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE newcomer_fields ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE newcomer_notes ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE newcomer_rate_limits ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE newcomer_status_i18n ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE newcomer_statuses ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE onboarding_acknowledgements ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE people_import_mappings ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE person_interests ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE person_notes ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plan_positions ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plans ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE position_i18n ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE positions ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE prayer_activity ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE prayer_sheets ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE revisions ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE roster_assignments ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE service_checkin_link_state ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE service_type_checkin_events ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE service_type_i18n ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE service_types ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE team_applications ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE team_i18n ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE team_members ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE testimonies ADD COLUMN campus_id INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_ministries_campus ON ministries (campus_id);
CREATE INDEX idx_teams_campus ON teams (campus_id);
CREATE INDEX idx_households_campus ON households (campus_id);
CREATE INDEX idx_bulletins_campus ON bulletins (campus_id);
CREATE INDEX idx_sermons_campus ON sermons (campus_id);
CREATE INDEX idx_events_campus ON events (campus_id);
CREATE INDEX idx_prayer_requests_campus ON prayer_requests (campus_id);
CREATE INDEX idx_media_campus ON media (campus_id);
CREATE INDEX idx_groups_campus ON groups (campus_id);
CREATE INDEX idx_group_events_campus ON group_events (campus_id);
CREATE INDEX idx_checkins_campus ON checkins (campus_id);
CREATE INDEX idx_service_attendance_campus ON service_attendance (campus_id);
CREATE INDEX idx_newcomer_submissions_campus ON newcomer_submissions (campus_id);
CREATE INDEX idx_learning_connections_campus ON learning_provider_connections (campus_id);
CREATE INDEX idx_learning_programs_campus ON learning_programs (campus_id);
