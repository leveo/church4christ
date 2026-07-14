import { env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import { openDb, type DbEnv } from '../../src/lib/dbProvider';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { MODULE_KEYS } from '../../src/lib/modules';
import { get, ORIGIN, post } from '../e2e/helpers';

const E2E_ENV = env as unknown as DbEnv & {
  SESSION_SECRET: string;
  STRIPE_WEBHOOK_SECRET: string;
};
const TEST_WEBHOOK_SECRET = E2E_ENV.STRIPE_WEBHOOK_SECRET;
const TEST_EVENT_ID = 'evt_test_e2e_admin_operations';
const LIVE_EVENT_ID = 'evt_live_e2e_rejected';
const PRIVATE_MARKER = 'customer-private-marker-e2e';
const CHECKOUT_EMAIL_MARKER = 'checkout-private-email@example.test';
const CHECKOUT_SECRET_MARKER = 'checkout-secret-marker-e2e';
const CHECKOUT_URL_MARKER = 'checkout-private-url-marker-e2e';
const CHECKOUT_REQUEST_ID = '00000000-0000-4000-8000-000000000777';
let recoveryEventId: number | null = null;

async function cookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(E2E_ENV.SESSION_SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

async function withDb<T>(fn: (db: AppDb) => Promise<T>): Promise<T> {
  const opened = openDb(E2E_ENV);
  try {
    return await fn(opened.db);
  } finally {
    await opened.end();
  }
}

async function signedEvent(event: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TEST_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const signature = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return SELF.fetch(`${ORIGIN}/api/stripe/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      'stripe-signature': `t=${timestamp},v1=${signature}`,
    },
    body,
    redirect: 'manual',
  });
}

async function eventRow(eventId: string): Promise<{
  status: string;
  attempt_count: number;
  last_action_by: number | null;
} | null> {
  return withDb((db) => db.prepare(`
    SELECT status,attempt_count,last_action_by
    FROM church_private.stripe_webhook_events
    WHERE event_id=?1
  `).bind(eventId).first());
}

async function waitForTerminal(eventId: string): Promise<NonNullable<Awaited<ReturnType<typeof eventRow>>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await eventRow(eventId);
    if (row && ['processed', 'ignored', 'failed'].includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('stripe_e2e_terminal_timeout');
}

async function setPaymentModules(giving: boolean, registration: boolean): Promise<void> {
  const form = new URLSearchParams({ action: 'modules' });
  for (const key of MODULE_KEYS) {
    if ((key === 'giving' && !giving) || (key === 'registration' && !registration)) continue;
    form.append(`module.${key}`, '1');
  }
  const response = await post('/admin/settings', form.toString(), {
    cookie: await cookie(1, 'admin@example.com'),
  });
  expect(response.status).toBe(303);
}

async function financeValue(personId: number): Promise<number | null> {
  return withDb(async (db) => (await db.prepare('SELECT finance FROM people WHERE id=?1')
    .bind(personId).first<{ finance: number }>())?.finance ?? null);
}

beforeAll(async () => {
  await withDb(async (db) => {
    await db.prepare('UPDATE people SET finance=1 WHERE id=4').run();
    await db.prepare("UPDATE people SET admin_areas='payment-operations' WHERE id=11").run();
    const event = await db.prepare(`
      INSERT INTO reg_events (starts_at,price_cents,currency)
      VALUES (datetime('now','+1 day'),2500,'usd') RETURNING id
    `).first<{ id: number }>();
    if (!event) throw new Error('stripe_e2e_recovery_event_missing');
    recoveryEventId = event.id;
    const registration = await db.prepare(`
      INSERT INTO registrations (event_id,name,email,status,amount_cents,currency)
      VALUES (?1,'Private Checkout Person',?2,'pending',2500,'usd') RETURNING id
    `).bind(event.id, CHECKOUT_EMAIL_MARKER).first<{ id: number }>();
    if (!registration) throw new Error('stripe_e2e_recovery_registration_missing');
    await db.prepare(`
      INSERT INTO church_private.stripe_checkout_requests
        (request_id,request_sha256,registration_id,request_json,session_url,state,reconcile_attempts,last_error)
      VALUES (?1,?2,?3,?4,?5,'creating',2,'sanitized_test_failure')
    `).bind(
      CHECKOUT_REQUEST_ID,
      '7'.repeat(64),
      registration.id,
      JSON.stringify({ customer_email: CHECKOUT_EMAIL_MARKER, private_secret: CHECKOUT_SECRET_MARKER }),
      `https://checkout.stripe.com/c/pay/${CHECKOUT_URL_MARKER}`,
    ).run();
  });
});

afterAll(async () => {
  await withDb(async (db) => {
    await db.prepare('UPDATE people SET finance=0 WHERE id=4').run();
    await db.prepare("UPDATE people SET admin_areas='groups,events' WHERE id=11").run();
    if (recoveryEventId !== null) await db.prepare('DELETE FROM reg_events WHERE id=?1').bind(recoveryEventId).run();
  });
});

describe('Postgres-backed built worker: Stripe test-mode operations', () => {
  it('renders and enforces all four Giving/Registration module combinations', async () => {
    const admin = await cookie(1, 'admin@example.com');
    const flagsForm = new URLSearchParams({ action: 'flags', role: 'member', active: 'on', finance: 'on' });

    await setPaymentModules(false, false);
    await withDb((db) => db.prepare('UPDATE people SET finance=0 WHERE id=4').run().then(() => undefined));
    expect((await get('/admin/stripe-events', { cookie: admin })).status).toBe(404);
    const neitherPeople = await get('/admin/people/4', { cookie: admin });
    expect(neitherPeople.status).toBe(200);
    const neitherPeopleBody = await neitherPeople.text();
    expect(neitherPeopleBody.includes('Payment operations')).toBe(false);
    expect(neitherPeopleBody.includes('href="/admin/stripe-events"')).toBe(false);
    expect((await post('/admin/people/4', flagsForm.toString(), { cookie: admin })).status).toBe(303);
    expect(await financeValue(4)).toBe(0);

    for (const [giving, registration] of [[true, false], [false, true], [true, true]] as const) {
      await setPaymentModules(giving, registration);
      const page = await get('/admin/stripe-events', { cookie: admin });
      expect(page.status).toBe(200);
      await page.text();
      const people = await get('/admin/people/4', { cookie: admin });
      expect(people.status).toBe(200);
      const peopleBody = await people.text();
      expect(peopleBody.includes('Payment operations (Giving and paid Registration)')).toBe(true);
      expect(peopleBody.includes('href="/admin/stripe-events"')).toBe(true);
      await withDb((db) => db.prepare('UPDATE people SET finance=0 WHERE id=4').run().then(() => undefined));
      expect((await post('/admin/people/4', flagsForm.toString(), { cookie: admin })).status).toBe(303);
      expect(await financeValue(4)).toBe(1);
    }
  });

  it('accepts a genuinely signed test event and durably processes it', async () => {
    const response = await signedEvent({
      id: TEST_EVENT_ID,
      type: 'customer.created',
      api_version: '2026-06-30',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object: { id: 'cus_test_e2e', description: PRIVATE_MARKER } },
    });
    expect(response.status).toBe(200);
    expect(['received', 'pending', 'ignored']).toContain(await response.text());
    const row = await waitForTerminal(TEST_EVENT_ID);
    expect(row.status).toBe('ignored');
    expect(row.attempt_count).toBe(1);
  });

  it('rejects a separately signed live event with the exact response and no receipt', async () => {
    const response = await signedEvent({
      id: LIVE_EVENT_ID,
      type: 'customer.created',
      api_version: '2026-06-30',
      created: Math.floor(Date.now() / 1000),
      livemode: true,
      data: { object: { id: 'cus_live_e2e' } },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('live_mode_disabled');
    expect(await eventRow(LIVE_EVENT_ID)).toBeNull();
  });

  it('gates reads to admin or finance and never renders private event or Checkout data', async () => {
    const anon = await get('/admin/stripe-events');
    expect(anon.status).toBe(303);
    const member = await get('/admin/stripe-events', {
      cookie: await cookie(3, 'sarah.johnson@example.com'),
    });
    expect(member.status).toBe(403);
    const editor = await get('/admin/stripe-events', {
      cookie: await cookie(2, 'pastor.david@example.com'),
    });
    expect(editor.status).toBe(403);

    const finance = await get('/admin/stripe-events', {
      cookie: await cookie(4, 'grace.lin@example.com'),
    });
    expect(finance.status).toBe(200);
    const financeBody = await finance.text();
    expect(financeBody.includes('Stripe 测试模式')).toBe(true);
    expect(financeBody.includes(TEST_EVENT_ID)).toBe(true);
    for (const marker of [PRIVATE_MARKER, CHECKOUT_EMAIL_MARKER, CHECKOUT_SECRET_MARKER, CHECKOUT_URL_MARKER]) {
      expect(financeBody.includes(marker)).toBe(false);
    }

    const admin = await get('/admin/stripe-events', {
      cookie: await cookie(1, 'admin@example.com'),
    });
    expect(admin.status).toBe(200);
    const adminBody = await admin.text();
    expect(adminBody.includes('Stripe test mode')).toBe(true);
    for (const marker of [PRIVATE_MARKER, CHECKOUT_EMAIL_MARKER, CHECKOUT_SECRET_MARKER, CHECKOUT_URL_MARKER]) {
      expect(adminBody.includes(marker)).toBe(false);
    }

    const limitedPaymentAdmin = await get('/admin/stripe-events', {
      cookie: await cookie(11, 'lydia.kwan@example.com'),
    });
    expect(limitedPaymentAdmin.status).toBe(200);
    expect((await limitedPaymentAdmin.text()).includes('href="/admin/stripe-events"')).toBe(true);
  });

  it('rejects unauthorized and cross-origin mutations before an audited same-origin replay', async () => {
    const memberResponse = await post(
      '/admin/stripe-events',
      new URLSearchParams({ action: 'replay', eventId: TEST_EVENT_ID }).toString(),
      { cookie: await cookie(3, 'sarah.johnson@example.com') },
    );
    expect(memberResponse.status).toBe(403);

    const crossOrigin = await SELF.fetch(`${ORIGIN}/admin/stripe-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: await cookie(1, 'admin@example.com'),
        origin: 'https://attacker.invalid',
      },
      body: new URLSearchParams({ action: 'replay', eventId: TEST_EVENT_ID }).toString(),
      redirect: 'manual',
    });
    expect(crossOrigin.status).toBe(403);
    expect(await eventRow(TEST_EVENT_ID)).toMatchObject({ attempt_count: 1, last_action_by: null });

    const replay = await post(
      '/admin/stripe-events',
      new URLSearchParams({ action: 'replay', eventId: TEST_EVENT_ID }).toString(),
      { cookie: await cookie(1, 'admin@example.com') },
    );
    expect(replay.status).toBe(303);
    expect(await eventRow(TEST_EVENT_ID)).toMatchObject({
      status: 'ignored',
      attempt_count: 2,
      last_action_by: 1,
    });
  });
});
