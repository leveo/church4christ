-- Church4Christ giving demo seed (Phase 2, Task 9). Postgres-only — the giving
-- module is Supabase-backed, so this file NEVER loads on D1. It is applied by
-- scripts/db/seed-supabase.mjs immediately after seed/dev-seed.sql (people +
-- households already exist) and before the identity-sequence reset.
--
-- RELATIVE DATES — like dev-seed.sql, every date floats from seed time so a
-- freshly cloned demo always looks alive. Manual check/cash gifts anchor on
-- received_on via date('now','start of day','-N days'); card gifts carry no
-- received_on, so their created_at (set via datetime('now','-N days')) is the
-- effective ledger date (see EFFECTIVE_DATE in src/lib/givingDb.ts). CRITICAL:
-- never a bare single-argument date() on the literal now — Postgres parses that
-- as a cast and a tripwire test (test/pg/compatFunctions.test.ts) bans it. Always
-- pass a modifier (start of day, -N days) so the SQLite-compat function is reached.
--
-- ALL content is FICTIONAL. Every Stripe id is an obvious fake (cs_test_demo…,
-- pi_test_demo…, in_test_demo…, sub_test_demo…) so nothing here can ever collide
-- with a real Stripe object. Every donor email is @example.com and must never be
-- emailed. Money is integer cents throughout (5000 = $50.00).
--
-- IMPORTANT: this file is split on the statement terminator ';' after full-line
-- '--' comments are stripped (the exact seed-supabase.mjs pattern). Do NOT use
-- ';' anywhere except to end a statement — Chinese text uses ，。 and English is
-- phrased to avoid it. Every id and row count is fixed — only the dates float.

-- Three funds an admin would configure: General (100), Missions (200), Building
-- (300), each with an English and a Simplified-Chinese name via fund_i18n.
INSERT INTO funds (id, fund_number, active, sort) VALUES
  (1, '100', 1, 1),
  (2, '200', 1, 2),
  (3, '300', 1, 3);

INSERT INTO fund_i18n (fund_id, locale, name) VALUES
  (1, 'en', 'General'),
  (1, 'zh', '常费'),
  (2, 'en', 'Missions'),
  (2, 'zh', '宣教'),
  (3, 'en', 'Building'),
  (3, 'zh', '建堂');

-- Seven online card gifts (method 'card', already succeeded). Members are linked
-- by person_id and carry no received_on, so created_at is the effective date.
-- Gifts 1/2/8 (David) and 2/9 (Amy) populate the Chen household self-service view
-- at /my/giving. Gift 6 is an anonymous guest one-time gift (person_id NULL,
-- donor_name + donor_email captured from Checkout). Gift 7 is one month of David's
-- recurring subscription, materialized the way invoice.paid records it — carrying
-- the invoice + subscription ids, no checkout session — paired with the
-- recurring_gifts row below.
INSERT INTO gifts (id, person_id, donor_name, donor_email, fund_id, amount_cents, currency, method, status,
    stripe_checkout_session_id, stripe_payment_intent_id, stripe_invoice_id, stripe_subscription_id, created_at) VALUES
  (1, 2, NULL, NULL, 1, 20000, 'usd', 'card', 'succeeded', 'cs_test_demo001', 'pi_test_demo001', NULL, NULL, datetime('now','-21 days')),
  (2, 7, NULL, NULL, 1, 8000, 'usd', 'card', 'succeeded', 'cs_test_demo002', 'pi_test_demo002', NULL, NULL, datetime('now','-14 days')),
  (3, 9, NULL, NULL, 2, 6000, 'usd', 'card', 'succeeded', 'cs_test_demo003', 'pi_test_demo003', NULL, NULL, datetime('now','-47 days')),
  (4, 3, NULL, NULL, 1, 10000, 'usd', 'card', 'succeeded', 'cs_test_demo004', 'pi_test_demo004', NULL, NULL, datetime('now','-9 days')),
  (5, 10, NULL, NULL, 2, 4500, 'usd', 'card', 'succeeded', 'cs_test_demo005', 'pi_test_demo005', NULL, NULL, datetime('now','-75 days')),
  (6, NULL, 'Hannah Guest 来宾', 'guest.hannah@example.com', 1, 5000, 'usd', 'card', 'succeeded', 'cs_test_demo006', 'pi_test_demo006', NULL, NULL, datetime('now','-5 days')),
  (7, 2, NULL, NULL, 1, 5000, 'usd', 'card', 'succeeded', NULL, 'pi_test_demo007', 'in_test_demo001', 'sub_test_demo001', datetime('now','-30 days'));

-- Five manually recorded gifts (checks and cash), each entered by the admin
-- (recorded_by 1) with a received_on date. Checks carry a check_number. These are
-- the offline half of the ledger the finance team keys in by hand.
INSERT INTO gifts (id, person_id, fund_id, amount_cents, currency, method, status, check_number, received_on, recorded_by, note) VALUES
  (8, 2, 3, 15000, 'usd', 'check', 'succeeded', '1042', date('now','start of day','-60 days'), 1, 'Building pledge'),
  (9, 7, 2, 4000, 'usd', 'cash', 'succeeded', NULL, date('now','start of day','-35 days'), 1, NULL),
  (10, 4, 1, 12000, 'usd', 'check', 'succeeded', '2087', date('now','start of day','-90 days'), 1, 'Sunday tithe'),
  (11, 5, 3, 2500, 'usd', 'cash', 'succeeded', NULL, date('now','start of day','-120 days'), 1, NULL),
  (12, 8, 1, 25000, 'usd', 'check', 'succeeded', '3310', date('now','start of day','-200 days'), 1, 'Year-end gift');

-- One active recurring subscription: David gives $50/month to the General fund.
-- Its stripe_subscription_id matches gift 7 above (one materialized invoice), so
-- the /my/giving "Manage giving" section shows the live subscription and the
-- ledger shows a real monthly gift from it.
INSERT INTO recurring_gifts (id, person_id, fund_id, amount_cents, currency, "interval", stripe_subscription_id, status, created_at) VALUES
  (1, 2, 1, 5000, 'usd', 'month', 'sub_test_demo001', 'active', datetime('now','-30 days'));
