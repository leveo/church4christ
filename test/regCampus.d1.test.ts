// Multi-campus: a registration on a second campus is only reachable on that campus. The
// middleware picks the campus from ?campus=<slug>, so the emailed manage and QR links carry
// it; without it the request resolves the default campus and gets the uniform 404.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/email', async () => (await import('./shared/regMail')).mockEmailModule());

import { scopeDatabase } from '../src/lib/campusScope';
import { createRegistration, saveEvent } from '../src/lib/regDb';
import { findRegistrationByToken } from '../src/lib/regManage';
import { performManageAction } from '../src/lib/regManageApi';
import { sendConfirmation } from '../src/lib/regNotify';
import { createManageHandler } from '../src/pages/api/register/manage';
import { GET as qr } from '../src/pages/register/qr/[eventId]/[confirmation].png';
import { mail } from './shared/regMail';

const ts = (ms: number) => new Date(Date.now() + ms).toISOString().slice(0, 19).replace('T', ' ');

describe('registration links on a second campus', () => {
  const north = () => scopeDatabase(env.DB, 2);
  const main = () => scopeDatabase(env.DB, 1);
  let eventId = 0;
  let created: Awaited<ReturnType<typeof createRegistration>>;

  beforeAll(async () => {
    await env.DB.prepare(`INSERT INTO campuses (id, slug, name, active, is_default) VALUES (2, 'north', 'North Campus', 1, 0)`).run();
    eventId = await saveEvent(north(), { title_en: 'North Picnic', starts_at: ts(10 * 86_400_000), active: 1 });
    created = await createRegistration(north(), {
      eventId, personId: null, name: 'Nora', email: 'nora@example.com', status: 'confirmed', amountCents: 0,
      currency: 'usd', answers: [], locale: 'en', submissionKey: 'campus-north-1',
    });
  });

  const manage = (db: ReturnType<typeof north>) =>
    createManageHandler(() => ({
      secret: 'campus-test-secret-0123456789abcdef', notifyEnv: {}, findByToken: findRegistrationByToken,
      perform: performManageAction, notify: vi.fn(async () => {}) as never, limit: 1000,
    }))({
      request: new Request('https://church.example/api/register/manage?campus=north', { method: 'POST', body: JSON.stringify({ token: created.manageToken, action: 'view' }) }),
      locals: { modules: new Set(['registration']), db, dbBackend: 'd1', locale: 'en' },
    } as never) as Promise<Response>;

  it('finds the registration through the campus selector and returns the uniform 404 without it', async () => {
    const found = await manage(north());
    expect(found.status).toBe(200);
    const body = await found.json() as { view: { qrUrl: string } };
    expect(body.view.qrUrl).toBe(`/register/qr/${eventId}/${created.confirmationNo}.png?campus=north`);
    const missing = await manage(main());
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('{"error":"not_found"}');
  });

  it('serves the QR image only on the registration’s campus', async () => {
    const get = (db: ReturnType<typeof north>) =>
      qr({ params: { eventId: String(eventId), confirmation: created.confirmationNo }, locals: { modules: new Set(['registration']), db } } as never) as Promise<Response>;
    const ok = await get(north());
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await get(main())).status).toBe(404);
  });

  it('puts the campus slug in the emailed manage and QR links', async () => {
    mail.sent.length = 0;
    await sendConfirmation({ APP_ORIGIN: 'https://church.example' }, env.DB, created.id, { manageToken: created.manageToken });
    const [m] = mail.sent;
    expect(m.html).toContain(`https://church.example/en/register/manage?campus=north#t=${created.manageToken}`);
    expect(m.html).toContain(`https://church.example/register/qr/${eventId}/${created.confirmationNo}.png?campus=north`);
  });
});
