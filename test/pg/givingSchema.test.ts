// Giving module schema (Supabase-only) — funds, fund_i18n, gifts, recurring_gifts
// plus the two people giving columns. Applied via the real migration runner
// against a freshly reset schema (the way an operator ships it), so this suite
// exercises migrations-supabase/0002_giving.sql end to end. Self-skips without
// DATABASE_URL, like every test/pg suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';

describe.skipIf(!hasPg)('Postgres giving schema', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const migrate = () =>
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    migrate();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('round-trips a fund + i18n + gift with the documented defaults', async () => {
    const [fund] = await sql.unsafe("INSERT INTO funds (fund_number) VALUES ('100') RETURNING id");
    const fundId = Number(fund.id);
    await sql.unsafe(
      "INSERT INTO fund_i18n (fund_id, locale, name) VALUES ($1, 'en', 'General Fund'), ($1, 'zh', '总奉献')",
      [fundId],
    );
    const [gift] = await sql.unsafe(
      "INSERT INTO gifts (fund_id, amount_cents, method, donor_email) " +
        "VALUES ($1, 5000, 'card', 'giver@example.com') RETURNING id, currency, status, created_at",
      [fundId],
    );
    expect(Number(gift.id)).toBeGreaterThan(0);
    expect(gift.currency).toBe('usd');
    expect(gift.status).toBe('pending');
    expect(gift.created_at).toBeTruthy();

    const names = await sql.unsafe('SELECT locale, name FROM fund_i18n WHERE fund_id = $1 ORDER BY locale', [fundId]);
    expect(names.map((r) => r.locale)).toEqual(['en', 'zh']);
    expect(names.map((r) => r.name)).toEqual(['General Fund', '总奉献']);
  });

  it('rejects a duplicate stripe_payment_intent_id with unique_violation (23505)', async () => {
    const [fund] = await sql.unsafe("INSERT INTO funds (fund_number) VALUES ('200') RETURNING id");
    const fundId = Number(fund.id);
    await sql.unsafe(
      "INSERT INTO gifts (fund_id, amount_cents, method, stripe_payment_intent_id) VALUES ($1, 1000, 'card', 'pi_dup')",
      [fundId],
    );
    await expect(
      sql.unsafe(
        "INSERT INTO gifts (fund_id, amount_cents, method, stripe_payment_intent_id) VALUES ($1, 2000, 'card', 'pi_dup')",
        [fundId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('adds the giving columns to people (finance, stripe_customer_id)', async () => {
    const rows = await sql.unsafe(
      "SELECT column_name FROM information_schema.columns " +
        "WHERE table_schema = 'public' AND table_name = 'people' " +
        "AND column_name IN ('finance', 'stripe_customer_id')",
    );
    expect(new Set(rows.map((r) => r.column_name))).toEqual(new Set(['finance', 'stripe_customer_id']));
  });
});
