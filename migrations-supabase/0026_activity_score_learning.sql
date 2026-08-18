-- PostgreSQL parity for the optional Learning engagement Activity Score source.
-- The frozen 0016 configuration and existing dimension values remain unchanged.

CREATE TABLE activity_score_dimensions_learning (
  dimension_key TEXT PRIMARY KEY CHECK (dimension_key IN (
    'group_attendance', 'serving', 'registration', 'learning_engagement'
  )),
  enabled integer NOT NULL CHECK (enabled IN (0, 1)),
  weight integer NOT NULL CHECK (weight BETWEEN 0 AND 100),
  target_count integer CHECK (target_count BETWEEN 1 AND 100),
  CHECK ((enabled = 1 AND weight > 0) OR (enabled = 0 AND weight = 0)),
  CHECK (
    (dimension_key = 'group_attendance' AND target_count IS NULL)
    OR (dimension_key IN ('serving', 'registration', 'learning_engagement')
      AND target_count IS NOT NULL)
  )
);

INSERT INTO activity_score_dimensions_learning
  (dimension_key, enabled, weight, target_count)
SELECT dimension_key, enabled, weight, target_count
FROM activity_score_dimensions;

INSERT INTO activity_score_dimensions_learning
  (dimension_key, enabled, weight, target_count)
VALUES ('learning_engagement', 0, 0, 3);

DROP TABLE activity_score_dimensions;
ALTER TABLE activity_score_dimensions_learning RENAME TO activity_score_dimensions;

CREATE INDEX idx_learning_events_activity_score
  ON learning_activity_events(occurred_at, person_id, id)
  WHERE event_type='assignment_submitted' OR event_type='quiz_submitted';
