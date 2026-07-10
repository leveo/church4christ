-- Church4Christ registration demo seed (Phase 3, Task 5). Postgres-only — the
-- registration module is Supabase-backed, so this file NEVER loads on D1. It is
-- applied by scripts/db/seed-supabase.mjs after seed/dev-seed.sql and
-- seed/giving-seed.sql (people already exist) and before the identity-sequence
-- reset, so the reg_events/reg_questions/registrations sequences are bumped past
-- these explicit ids too.
--
-- RELATIVE DATES — like dev-seed.sql, every timestamp floats from seed time so a
-- freshly cloned demo always has two open, upcoming events. Event times use
-- datetime('now','+N days','start of day','+H hours') to land on a clean hour, and
-- each registration's created_at sits a few days in the past. CRITICAL: never a
-- bare single-argument date() on the literal now — Postgres parses that as a cast
-- and a tripwire test (test/pg/compatFunctions.test.ts) bans it. Every timestamp
-- here is datetime('now', ...) with modifiers, which always resolves via the
-- SQLite-compat function. reg_events/registrations store timestamps as UTC
-- 'YYYY-MM-DD HH:MM:SS' text, matching the rest of the app.
--
-- ALL content is FICTIONAL. Every registrant email is @example.com and must never
-- be emailed. Every Stripe id is an obvious fake (cs_test_reg…, pi_test_reg…) so
-- nothing here can ever collide with a real Stripe object. Money is integer cents
-- (2500 = $25.00). Demo ids start at 900 to stay clear of dev-seed's id ranges,
-- and the reg_answers rows reference these exact event/question/registration ids.
--
-- IMPORTANT: this file is split on the statement terminator ';' after full-line
-- '--' comments are stripped (the exact seed-supabase.mjs pattern). Do NOT use ';'
-- anywhere except to end a statement — Chinese text uses ，。 and English is
-- phrased to avoid it. Every id and row count is fixed — only the dates float.

-- Two upcoming, currently-open events. Event 900 is FREE (price_cents NULL,
-- unlimited capacity) — a two-day retreat. Event 910 is PAID ($25 = 2500 cents,
-- capacity 20) — an evening dinner. opens_at NULL = open immediately, closes_at a
-- couple of days before the start so both stay inside their sign-up window.
INSERT INTO reg_events (id, starts_at, ends_at, location, capacity, price_cents, currency, opens_at, closes_at, active) VALUES
  (900, datetime('now','+30 days','start of day','+9 hours'), datetime('now','+31 days','start of day','+16 hours'),
   'Pine Valley Camp 松谷营地', NULL, NULL, 'usd', NULL, datetime('now','+28 days','start of day','+23 hours'), 1),
  (910, datetime('now','+20 days','start of day','+18 hours'), datetime('now','+20 days','start of day','+21 hours'),
   'Fellowship Hall 团契厅', 20, 2500, 'usd', NULL, datetime('now','+18 days','start of day','+23 hours'), 1);

INSERT INTO reg_event_i18n (event_id, locale, title, description) VALUES
  (900, 'en', 'Fall Family Retreat',
   'A restful weekend away for the whole church family — worship, teaching, and time in nature. Registration is free, and all meals are provided.'),
  (900, 'zh', '秋季家庭退修会',
   '为全教会家庭预备的安息周末，有敬拜、教导与亲近大自然的时光。报名免费，并提供三餐。'),
  (910, 'en', 'Marriage Enrichment Dinner',
   'An evening for couples: a catered dinner, an encouraging talk, and time to reconnect. Seats are limited, so please register early.'),
  (910, 'zh', '婚姻加添晚宴',
   '为夫妻预备的美好夜晚，有精致晚宴、勉励的信息，以及重新联结的时光。名额有限，请尽早报名。');

-- Free event 900 has three questions: a required T-shirt-size SELECT, an optional
-- dietary TEXTAREA, and an optional first-time YES/NO. Paid event 910 has a
-- required meal-choice SELECT and an optional dietary-restrictions TEXT. Options
-- are a JSON array of strings (select only). sort orders the form top to bottom.
INSERT INTO reg_questions (id, event_id, sort, type, required, options) VALUES
  (901, 900, 1, 'select', 1, '["S","M","L","XL"]'),
  (902, 900, 2, 'textarea', 0, NULL),
  (903, 900, 3, 'yesno', 0, NULL),
  (911, 910, 1, 'select', 1, '["Chicken","Fish","Vegetarian"]'),
  (912, 910, 2, 'text', 0, NULL);

INSERT INTO reg_question_i18n (question_id, locale, label) VALUES
  (901, 'en', 'T-shirt size'),
  (901, 'zh', 'T恤尺码'),
  (902, 'en', 'Dietary needs or allergies'),
  (902, 'zh', '饮食需要或过敏'),
  (903, 'en', 'Is this your first retreat with us?'),
  (903, 'zh', '这是你第一次参加我们的退修会吗'),
  (911, 'en', 'Meal choice'),
  (911, 'zh', '餐点选择'),
  (912, 'en', 'Dietary restrictions'),
  (912, 'zh', '饮食禁忌');

-- Seven registrations. Free event 900: three CONFIRMED sign-ups (free events
-- confirm immediately, amount 0, no Stripe ids) — two members and one guest
-- (person_id NULL, name + email captured on the public form). Paid event 910: two
-- CONFIRMED paid registrations (David + Amy Chen, a married couple, each carrying a
-- fake succeeded Checkout session + payment intent, amount 2500) and two PENDING
-- ones (a Checkout session attached but not yet paid — payment_intent NULL — the
-- state that holds a seat until Stripe confirms or the session expires).
INSERT INTO registrations (id, event_id, person_id, name, email, status, amount_cents, currency, stripe_checkout_session_id, stripe_payment_intent_id, created_at) VALUES
  (900, 900, 3, 'Sarah Johnson 莎拉', 'sarah.johnson@example.com', 'confirmed', 0, 'usd', NULL, NULL, datetime('now','-8 days')),
  (901, 900, 5, 'Mark Liu 刘马可', 'mark.liu@example.com', 'confirmed', 0, 'usd', NULL, NULL, datetime('now','-6 days')),
  (902, 900, NULL, 'Rebecca Adams', 'rebecca.adams@example.com', 'confirmed', 0, 'usd', NULL, NULL, datetime('now','-5 days')),
  (910, 910, 7, 'Amy Chen 陈爱美', 'amy.chen@example.com', 'confirmed', 2500, 'usd', 'cs_test_reg001', 'pi_test_reg001', datetime('now','-7 days')),
  (911, 910, 2, '陈大卫 David Chen', 'pastor.david@example.com', 'confirmed', 2500, 'usd', 'cs_test_reg002', 'pi_test_reg002', datetime('now','-7 days')),
  (912, 910, 4, 'Grace Lin 林恩慈', 'grace.lin@example.com', 'pending', 2500, 'usd', 'cs_test_reg003', NULL, datetime('now','-2 days')),
  (913, 910, 8, 'Ben Wu 吴恩本', 'ben.wu@example.com', 'pending', 2500, 'usd', 'cs_test_reg004', NULL, datetime('now','-1 days'));

-- Answers, keyed to the exact registration + question ids above. Select values are
-- among each question's options, yes/no is normalized 'yes'/'no', and optional
-- questions are simply absent for the registrations that skipped them.
-- Link the paid dinner (event 910) to the seeded public group "Young Adults"
-- (groups.id = 1 from dev-seed.sql) via the Supabase-only group_reg_events table,
-- so groupRegDb reads and the pg parity suite always have a linked special event
-- with a real confirmed count. Explicit id 920 stays clear of other id ranges.
INSERT INTO group_reg_events (id, group_id, reg_event_id) VALUES
  (920, 1, 910);

INSERT INTO reg_answers (registration_id, question_id, value) VALUES
  (900, 901, 'M'),
  (900, 902, 'Vegetarian meals please, no peanuts'),
  (900, 903, 'no'),
  (901, 901, 'L'),
  (901, 903, 'yes'),
  (902, 901, 'S'),
  (902, 902, 'Gluten-free'),
  (902, 903, 'yes'),
  (910, 911, 'Chicken'),
  (911, 911, 'Fish'),
  (911, 912, 'No shellfish'),
  (912, 911, 'Vegetarian'),
  (913, 911, 'Chicken'),
  (913, 912, 'Peanut allergy');
