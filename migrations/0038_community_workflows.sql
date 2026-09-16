-- Fellowships are optional. Campus workflows use a NULL fellowship_id.
CREATE TABLE fellowships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  meeting_details TEXT NOT NULL DEFAULT '', coordinator_id INTEGER REFERENCES people(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campus_id,slug), UNIQUE(campus_id,id)
);
CREATE UNIQUE INDEX idx_groups_campus_identity ON groups(campus_id,id);
CREATE TABLE fellowship_groups (
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  group_id INTEGER PRIMARY KEY,
  fellowship_id INTEGER NOT NULL,
  FOREIGN KEY(campus_id,group_id) REFERENCES groups(campus_id,id),
  FOREIGN KEY(campus_id,fellowship_id) REFERENCES fellowships(campus_id,id)
);
CREATE TABLE fellowship_members (
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  fellowship_id INTEGER NOT NULL, person_id INTEGER NOT NULL REFERENCES people(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','coordinator')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(fellowship_id,person_id),
  FOREIGN KEY(campus_id,fellowship_id) REFERENCES fellowships(campus_id,id)
);
CREATE TABLE workflow_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  fellowship_id INTEGER, name TEXT NOT NULL, steps_json TEXT NOT NULL,
  default_assignee_id INTEGER REFERENCES people(id),
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual','member_added')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campus_id,id),
  FOREIGN KEY(campus_id,fellowship_id) REFERENCES fellowships(campus_id,id)
);
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  template_id INTEGER NOT NULL, fellowship_id INTEGER,
  person_id INTEGER NOT NULL REFERENCES people(id),
  name TEXT NOT NULL, request_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campus_id,request_key), UNIQUE(campus_id,id),
  FOREIGN KEY(campus_id,template_id) REFERENCES workflow_templates(campus_id,id),
  FOREIGN KEY(campus_id,fellowship_id) REFERENCES fellowships(campus_id,id)
);
CREATE TABLE workflow_tasks (
  id TEXT PRIMARY KEY,
  campus_id INTEGER NOT NULL DEFAULT 1 REFERENCES campuses(id),
  run_id TEXT NOT NULL, step_index INTEGER NOT NULL,
  title TEXT NOT NULL, assignee_id INTEGER NOT NULL REFERENCES people(id),
  due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','cancelled')),
  notes TEXT NOT NULL DEFAULT '', updated_by INTEGER REFERENCES people(id), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  reminder_enabled INTEGER NOT NULL DEFAULT 1 CHECK(reminder_enabled IN (0,1)),
  next_reminder_at TEXT NOT NULL, delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','sending','sent','failed','uncertain')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT, last_sent_at TEXT,
  UNIQUE(run_id,step_index), UNIQUE(campus_id,id),
  FOREIGN KEY(campus_id,run_id) REFERENCES workflow_runs(campus_id,id)
);
CREATE INDEX idx_workflow_tasks_due ON workflow_tasks(next_reminder_at,status,delivery_state);
CREATE INDEX idx_workflow_tasks_assignee ON workflow_tasks(campus_id,assignee_id,status);
CREATE INDEX idx_workflow_runs_scope ON workflow_runs(campus_id,fellowship_id,status);

-- Keep the identity merge inventory exhaustive; mutable community references require review.
INSERT INTO person_merge_registry_keys(reference_key,policy) VALUES
  ('fellowships.coordinator_id','hard_conflict'),
  ('fellowship_members.person_id','hard_conflict'),
  ('workflow_templates.default_assignee_id','hard_conflict'),
  ('workflow_runs.person_id','hard_conflict'),
  ('workflow_tasks.assignee_id','hard_conflict'),
  ('workflow_tasks.updated_by','historical_preserve');
