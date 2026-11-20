// The registration event page's server side on Postgres: the cases of test/regBackOfficeUi.d1.test.ts, plus the
// card-refund path through the dispatcher (Stripe is a fake fetch). Self-skips without DATABASE_URL.
// `cloudflare:email` cannot load in plain Node, so src/lib/email is replaced by the capturing stand-in.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('../../src/lib/email', async () => (await import('../shared/regMail')).mockEmailModule());

import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { createRegistration, saveEvent } from '../../src/lib/regDb';
import { grantEventRole } from '../../src/lib/regAccess';
import { runRegAdminAction, type RegActionContext } from '../../src/lib/regAdminPage';
import { defineRegBackOfficeUiCases } from '../shared/regBackOfficeUiCases';

describe.skipIf(!hasPg)('registration event page actions (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  defineRegBackOfficeUiCases('Postgres', () => db, 'supabase');

  it('refunds a card payment through the dispatcher: payment operations + manage, Stripe called once, the registrar without the permission refused', async () => {
    const env = { DB_BACKEND: 'supabase', STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', APP_ORIGIN: 'https://church.example' } as RegActionContext['env'];
    const eventId = await saveEvent(db, { title_en: 'Gala', title_zh: '晚宴', starts_at: '2031-01-01 10:00:00', price_cents: 5000, active: 1 });
    const created = await createRegistration(db, {
      eventId, personId: null, name: 'Pia', email: 'pia-ui@example.com', status: 'confirmed', amountCents: 0, currency: 'usd', answers: [], submissionKey: `ui-refund-${Date.now()}`,
    });
    await db.prepare(`UPDATE registrations SET amount_cents = 5000, payment_method = 'stripe', stripe_payment_intent_id = 'pi_ui_1' WHERE id = ?1`).bind(created.id).run();
    await db.prepare(`INSERT INTO people (id, display_name, email) VALUES (9100, 'Payments', 'payments9100@example.com'), (9101, 'Registrar', 'registrar9101@example.com') ON CONFLICT (id) DO NOTHING`).run();
    const payments = { id: 9100, email: 'p@example.com', displayName: 'P', role: 'admin', isAdmin: true, isEditor: false, finance: 0, memberTeamIds: [], leaderTeamIds: [], lang: null, isSuperAdmin: false, adminAreas: ['registration', 'payment-operations'] } as never;
    const registrar = { id: 9101, email: 'r@example.com', displayName: 'R', role: 'member', isAdmin: false, isEditor: false, finance: 0, memberTeamIds: [], leaderTeamIds: [], lang: null, isSuperAdmin: false, adminAreas: [] } as never;
    await grantEventRole(db, eventId, 9101, 'registrar');

    const calls: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push(`${url}?${String(init.body)}`);
      return new Response(JSON.stringify({ id: 're_ui', amount: 2000, status: 'succeeded' }), { status: 200 });
    }) as unknown as typeof fetch;
    const base: Omit<RegActionContext, 'user'> = { db, env, eventId, portal: false, defaultLocale: 'en', fetcher };
    const fd = () => { const f = new FormData(); f.set('action', 'refund'); f.set('registration_id', String(created.id)); f.set('amount', '20.00'); return f; };

    expect(await runRegAdminAction({ ...base, user: registrar }, fd())).toEqual({ kind: 'denied', status: 403 });
    expect(calls).toHaveLength(0);
    expect(await runRegAdminAction({ ...base, user: payments }, fd())).toEqual({ kind: 'ok', notice: 'refunded', reg: created.id });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('https://api.stripe.com/v1/refunds');
    expect(Number((await db.prepare(`SELECT refunded_cents FROM registrations WHERE id = ?1`).bind(created.id).first<{ refunded_cents: number }>())!.refunded_cents)).toBe(2000);
    // More than what is left is refused by the data layer, with no second Stripe call.
    const over = fd();
    over.set('amount', '40.00');
    expect(await runRegAdminAction({ ...base, user: payments }, over)).toEqual({ kind: 'failed', code: 'exceeds_paid', reg: created.id });
    expect(calls).toHaveLength(1);
  });
});
