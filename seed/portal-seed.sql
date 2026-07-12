-- Church4Christ member portal demo seed. This file is POSTGRES-ONLY: every
-- table below is created by migrations-supabase/0009_member_portal.sql and has
-- no D1 counterpart. scripts/db/seed-supabase.mjs loads it after dev-seed.sql,
-- giving-seed.sql, and registration-seed.sql; dev-seed.sql remains portable.
--
-- IDs are fixed and all people/groups/events already exist at this point:
-- group 1 is Young Adults and person 8 (Ben) administers it, events 900/910
-- and their registrations are from registration-seed.sql. The group-file R2
-- object lives at the matching stable key in seed/portal-files/ and is uploaded
-- by npm run db:seed-media:local for a local R2 demo.
--
-- IMPORTANT: the shared seed parser strips full-line comments then splits on
-- semicolons. Do not use semicolons except as statement terminators.

INSERT INTO group_files (id, group_id, uploaded_by, file_name, r2_key, content_type, size_bytes) VALUES
  (1, 1, 8, 'young-adults-welcome.pdf', 'group-files/1/demo-young-adults-welcome.pdf', 'application/pdf', 218);

-- Event 900's host (David) and event 910's host (Amy) can moderate their own
-- event prayer queues while church-wide admins retain their normal authority.
INSERT INTO event_admins (id, reg_event_id, person_id) VALUES
  (1, 900, 2),
  (2, 910, 7);

-- One item for each portal scope provides a useful moderation demo. Approved
-- items have a named approver and timestamp; pending group/event items exercise
-- the leader and event-admin queues. The private item is intentionally approved
-- for the personal prayer list demo.
INSERT INTO prayer_items (id, author_person_id, scope, group_id, reg_event_id, body, status, approved_by, approved_at) VALUES
  (1, 3, 'church', NULL, NULL, 'Please pray that our church welcomes new neighbors with the love of Christ this month.', 'approved', 1, datetime('now','-2 days')),
  (2, 5, 'group', 1, NULL, 'Please pray for wisdom as I begin a new season at work and keep joining the Friday study faithfully.', 'pending', NULL, NULL),
  (3, 4, 'event', NULL, 900, 'Please pray for safe travel, meaningful conversations, and rest for every family at the retreat.', 'pending', NULL, NULL),
  (4, 7, 'private', NULL, NULL, 'Thank you for God''s faithfulness in our family. Please give us patience and gratitude this week.', 'approved', 7, datetime('now','-1 day'));
