// Stripe reconciliation (src/lib/givingReconcile.ts) against real Postgres.
// Migrates a fresh giving schema the runner way, then stands up a PLAIN `stripe`
// schema with stub tables shaped exactly like the Supabase Stripe FDW foreign
// tables (only the columns the queries touch, incl. the `attrs` jsonb that holds
// most Stripe fields). Plants one row per report bucket plus clean rows that must
// NOT match, and asserts each bucket catches exactly its case. Also exercises the
// feature-detection: stripeFdwAvailable true with the schema present, false after
// it is dropped. Self-skips without DATABASE_URL, like every test/pg suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { saveFund } from '../../src/lib/fundDb';
import { reconcile, stripeFdwAvailable, type ReconcileReport } from '../../src/lib/givingReconcile';

describe.skipIf(!hasPg)('reconcile (Postgres, stub stripe schema)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;
  let fund: number;
  let report: ReconcileReport;
  let mismatchGiftId: number;
  let driftGiftId: number;

  const migrate = () =>
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    migrate();
    db = new PgAdapter(sql);
    fund = await saveFund(db, { fund_number: 'R100', name_en: 'General', name_zh: '总奉献', active: 1, sort: 1 });

    // Local gifts. Session-linked gifts drive missingLocally/amountMismatch;
    // PI-linked gifts drive refundDrift.
    // cs_match: amount matches its session → clean. cs_mismatch: local 4000 vs
    // stripe 5000 → amountMismatch.
    await sql.unsafe(
      `INSERT INTO gifts (fund_id, amount_cents, method, status, stripe_checkout_session_id) VALUES
         ($1, 5000, 'card', 'succeeded', 'cs_match'),
         ($1, 4000, 'card', 'succeeded', 'cs_mismatch')`,
      [fund],
    );
    // pi_drift: charge refunded, gift still succeeded → refundDrift. pi_ok:
    // already refunded → clean. pi_live: charge not refunded → clean. pi_old:
    // charge refunded but out of window → clean.
    await sql.unsafe(
      `INSERT INTO gifts (fund_id, amount_cents, method, status, stripe_payment_intent_id) VALUES
         ($1, 3000, 'card', 'succeeded', 'pi_drift'),
         ($1, 3000, 'card', 'refunded',  'pi_ok'),
         ($1, 3000, 'card', 'succeeded', 'pi_live'),
         ($1, 3000, 'card', 'succeeded', 'pi_old')`,
      [fund],
    );
    mismatchGiftId = Number(
      (await sql.unsafe(`SELECT id FROM gifts WHERE stripe_checkout_session_id = 'cs_mismatch'`))[0].id,
    );
    driftGiftId = Number((await sql.unsafe(`SELECT id FROM gifts WHERE stripe_payment_intent_id = 'pi_drift'`))[0].id);

    // Plain stub tables shaped like the FDW foreign tables (subset of columns).
    await sql.unsafe(`CREATE SCHEMA stripe`);
    await sql.unsafe(
      `CREATE TABLE stripe.checkout_sessions (
         id text, customer text, payment_intent text, subscription text, attrs jsonb)`,
    );
    await sql.unsafe(
      `CREATE TABLE stripe.charges (
         id text, amount bigint, currency text, customer text, description text,
         invoice text, payment_intent text, status text, created timestamp, attrs jsonb)`,
    );

    // Checkout sessions. `created` is a unix epoch inside attrs (2 days ago =
    // in-window for a 30-day report; 100 days ago = out of window). cs_recurring
    // is the recurring-signup shape createRecurringCheckout produces
    // (mode='subscription', paid, gift-kind) — it legitimately has NO
    // session-keyed local gift (the webhook records recurring_gifts; money rows
    // arrive via invoice.paid with a null session id) and must never count as
    // missing.
    const epoch = (days: number) => `(extract(epoch from now())::bigint - ${days} * 86400)`;
    await sql.unsafe(
      `INSERT INTO stripe.checkout_sessions (id, attrs) VALUES
         ('cs_missing',   jsonb_build_object('payment_status','paid','mode','payment','amount_total',7000,'created',${epoch(2)},'customer_email','giver@example.com','metadata',jsonb_build_object('kind','gift'))),
         ('cs_match',     jsonb_build_object('payment_status','paid','mode','payment','amount_total',5000,'created',${epoch(2)},'metadata',jsonb_build_object('kind','gift'))),
         ('cs_mismatch',  jsonb_build_object('payment_status','paid','mode','payment','amount_total',5000,'created',${epoch(2)},'metadata',jsonb_build_object('kind','gift'))),
         ('cs_old',       jsonb_build_object('payment_status','paid','mode','payment','amount_total',9000,'created',${epoch(100)},'metadata',jsonb_build_object('kind','gift'))),
         ('cs_notgift',   jsonb_build_object('payment_status','paid','mode','payment','amount_total',9000,'created',${epoch(2)},'metadata',jsonb_build_object('kind','other'))),
         ('cs_unpaid',    jsonb_build_object('payment_status','unpaid','mode','payment','amount_total',9000,'created',${epoch(2)},'metadata',jsonb_build_object('kind','gift'))),
         ('cs_recurring', jsonb_build_object('payment_status','paid','mode','subscription','amount_total',2000,'created',${epoch(2)},'metadata',jsonb_build_object('kind','gift')))`,
    );

    // Charges. `created` is a mapped timestamp column (UTC wall clock).
    await sql.unsafe(
      `INSERT INTO stripe.charges (id, payment_intent, created, attrs) VALUES
         ('ch_drift', 'pi_drift', now() at time zone 'utc' - interval '2 days',   jsonb_build_object('refunded', true)),
         ('ch_ok',    'pi_ok',    now() at time zone 'utc' - interval '2 days',   jsonb_build_object('refunded', true)),
         ('ch_live',  'pi_live',  now() at time zone 'utc' - interval '2 days',   jsonb_build_object('refunded', false)),
         ('ch_old',   'pi_old',   now() at time zone 'utc' - interval '100 days', jsonb_build_object('refunded', true))`,
    );

    report = await reconcile(db, { sinceDays: 30 });
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('stripeFdwAvailable is true when the stripe schema exists', async () => {
    expect(await stripeFdwAvailable(db)).toBe(true);
  });

  it('missingLocally catches exactly the paid one-time gift session with no local gift', () => {
    expect(report.missingLocally).toHaveLength(1);
    expect(report.missingLocally[0]).toMatchObject({
      session_id: 'cs_missing',
      amount: 7000,
      email: 'giver@example.com',
    });
    expect(typeof report.missingLocally[0].created).toBe('string');
    // Excludes: matched (cs_match), out-of-window (cs_old), non-gift (cs_notgift),
    // unpaid (cs_unpaid), and — regression — a recurring signup (cs_recurring,
    // mode='subscription', paid gift-kind, no session-keyed local gift by design).
    const ids = report.missingLocally.map((r) => r.session_id);
    expect(ids).not.toContain('cs_match');
    expect(ids).not.toContain('cs_old');
    expect(ids).not.toContain('cs_notgift');
    expect(ids).not.toContain('cs_unpaid');
    expect(ids).not.toContain('cs_recurring');
  });

  it('amountMismatch catches exactly the local gift whose amount differs from Stripe', () => {
    expect(report.amountMismatch).toHaveLength(1);
    expect(report.amountMismatch[0]).toEqual({
      gift_id: mismatchGiftId,
      session_id: 'cs_mismatch',
      local_cents: 4000,
      stripe_cents: 5000,
    });
  });

  it('refundDrift catches exactly the refunded charge whose local gift is still succeeded', () => {
    expect(report.refundDrift).toHaveLength(1);
    expect(report.refundDrift[0]).toEqual({ gift_id: driftGiftId, payment_intent_id: 'pi_drift' });
  });

  it('stripeFdwAvailable is false after the stripe schema is dropped', async () => {
    await sql.unsafe(`DROP SCHEMA stripe CASCADE`);
    expect(await stripeFdwAvailable(db)).toBe(false);
  });
});
