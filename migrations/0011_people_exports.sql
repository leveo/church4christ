-- Sensitive People exports are auditable without copying exported PII into the
-- audit trail. The application owns the exact numeric JSON shape; the schema
-- keeps the stored representation small and the event kind closed.
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  actor_person_id INTEGER NOT NULL REFERENCES people(id),
  action_kind TEXT NOT NULL
    CHECK (action_kind IN ('people_notes_export_generated')),
  structural_counts_json TEXT NOT NULL
    CHECK (length(structural_counts_json) BETWEEN 2 AND 256),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_events_actor_created
  ON audit_events(actor_person_id, created_at);
