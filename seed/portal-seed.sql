-- Church4Christ member-groups demo seed (Phase 2, Task 6). Postgres-only — group
-- membership and applications (group_members, group_applications) are
-- Supabase-only tables (migrations-supabase/0007_member_portal.sql has no D1
-- counterpart — see migrations/0008_member_portal.sql's header), so this file
-- NEVER loads on D1. It is applied by scripts/db/seed-supabase.mjs after
-- seed/dev-seed.sql (member_groups + people already exist) and before the
-- identity-sequence reset; test/e2e-pg/setup.ts loads it the same way for the
-- Postgres e2e suite.
--
-- David Chen (person 2) leads group 1 (Young Adults Fellowship, seeded in
-- dev-seed.sql); Amy Chen (person 7) is a plain member — giving /my/groups and
-- the leader console real membership data on a freshly seeded DB. Sarah Johnson
-- (person 3, sarah.johnson@example.com — not in group 1) has one pending
-- application to the same group, so the leader's pending-applications panel has
-- a real applicant to approve or reject.
--
-- IMPORTANT: like dev-seed.sql, this file is split on the statement terminator
-- ';' after full-line '--' comments are stripped. Do NOT use ';' anywhere except
-- to end a statement.
INSERT INTO group_members (id, group_id, person_id, is_leader) VALUES
  (1, 1, 2, 1),
  (2, 1, 7, 0);

INSERT INTO group_applications (id, group_id, person_id, note, status) VALUES
  (1, 1, 3, 'Excited to join and grow alongside other young adults.', 'P');
