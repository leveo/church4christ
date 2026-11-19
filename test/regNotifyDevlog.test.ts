// The REAL sendEmail path for registration mail (dev-log mode, as in the workers pool):
// a mail carrying a manage link must keep the link out of the console log and email_log.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRegistration, saveEvent } from '../src/lib/regDb';
import { sendConfirmation, sendPromoted } from '../src/lib/regNotify';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM email_log').run();
});

describe('registration mail through the real sendEmail', () => {
  it('logs no manage token to the console or to email_log', async () => {
    const eventId = await saveEvent(env.DB, { title_en: 'Devlog event', starts_at: '2036-03-01 10:00:00', active: 1, capacity: 1 });
    const first = await createRegistration(env.DB, {
      eventId, personId: null, name: 'A', email: 'a@example.com', status: 'confirmed', amountCents: 0, currency: 'usd', answers: [], locale: 'en',
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sendConfirmation(env, env.DB, first.id, { manageToken: first.manageToken })).toBe(true);
    expect(await sendConfirmation(env, env.DB, first.id)).toBe(true); // rotates
    expect(await sendPromoted(env, env.DB, first.id)).toBe(true); // rotates
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n') + errors.mock.calls.map((c) => c.join(' ')).join('\n');
    spy.mockRestore();
    errors.mockRestore();

    expect(logged).toContain('[sensitive email body omitted]');
    expect(logged).not.toMatch(/#t=|[A-Za-z0-9_-]{43}/);
    expect(logged).not.toContain(first.manageToken!);
    const { results } = await env.DB.prepare('SELECT detail, kind, status FROM email_log').all<{ detail: string; kind: string; status: string }>();
    expect(results.map((r) => r.kind)).toEqual(['regConfirm', 'regConfirm', 'regPromoted']);
    expect(results.every((r) => r.status === 'devlog')).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});
