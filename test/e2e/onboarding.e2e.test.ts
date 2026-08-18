import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  return `${SESSION_COOKIE}=${await mintSession(SECRET, { id, email, sessionEpoch: 0 })}`;
}

describe('built onboarding checklist', () => {
  it('is always readable by real admins, denied to members/editors, and no-store', async () => {
    expect((await get('/admin/onboarding')).status).toBe(303);
    expect((await get('/admin/onboarding', { cookie: await sessionCookie(3, 'sarah.johnson@example.com') })).status).toBe(403);
    expect((await get('/admin/onboarding', { cookie: await sessionCookie(2, 'pastor.david@example.com') })).status).toBe(403);
    const limited = await sessionCookie(11, 'lydia.kwan@example.com');
    const response = await get('/admin/onboarding', { cookie: limited });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('data-screenshot-marker="admin-onboarding"');
    expect(html).toContain('data-check-id="learning-provider-operations"');
    expect(html).toContain('学习平台供应商运维');
  });

  it('allows only the super admin to acknowledge an allowlisted manual check', async () => {
    const limited = await sessionCookie(11, 'lydia.kwan@example.com');
    expect((await post('/admin/onboarding', 'check_id=restore-drill', { cookie: limited })).status).toBe(403);
    const admin = await sessionCookie(1, 'admin@example.com');
    const english = await get('/admin/onboarding', { cookie: admin });
    expect(english.status).toBe(200);
    expect(await english.text()).toContain('Learning provider operations');
    expect((await post('/admin/onboarding', 'check_id=database-schema', { cookie: admin })).status).toBe(400);
    expect((await post('/admin/onboarding', 'check_id=restore-drill&extra=1', { cookie: admin })).status).toBe(400);
    expect((await post('/admin/onboarding', 'check_id=restore-drill', { cookie: admin })).status).toBe(303);
    expect(await env.DB.prepare("SELECT actor_person_id,definition_version FROM onboarding_acknowledgements WHERE check_id='restore-drill'").first())
      .toEqual({ actor_person_id: 1, definition_version: 1 });
  });
});
