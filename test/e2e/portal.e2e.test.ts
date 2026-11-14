// Member Portal basics on the default D1 backend, against the BUILT worker. The
// portal module is on by default; Registration (Supabase-only) is off on D1, so
// the portal pages must render without touching reg_* / event_admins tables.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  return `${SESSION_COOKIE}=${await mintSession(SECRET, { id, email, sessionEpoch: 0 })}`;
}

describe('member portal on D1', () => {
  it.each(['/en/my/household', '/en/my/prayer', '/en/my/serving', '/en/my/events', '/en/my/groups'])(
    'serves %s to a signed-in member',
    async (path) => {
      const member = await sessionCookie(3, 'sarah.johnson@example.com');
      const res = await get(path, { cookie: member });
      expect(res.status).toBe(200);
    },
  );

  it('shows an informational state on /my/events instead of reading registrations', async () => {
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    const html = await (await get('/en/my/events', { cookie: member })).text();
    expect(html).toContain('Event registration is not enabled');
    expect(html).not.toContain('Open for registration');
  });

  it('hides the event scope on the prayer page and rejects a forged event post', async () => {
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    const html = await (await get('/en/my/prayer', { cookie: member })).text();
    expect(html).not.toContain('name="reg_event_id"');
    expect(html).not.toContain('value="event"');
    expect(html).not.toContain('tab=events');

    const forged = await post('/en/my/prayer', 'tab=church&_action=post&scope=event&reg_event_id=1&body=hello', { cookie: member });
    expect(forged.status).toBe(303);
    expect(forged.headers.get('location')).toContain('err=generic');
  });

  it('posts a church prayer, lets the super admin approve it, and shows it on the church tab', async () => {
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    const admin = await sessionCookie(1, 'admin@example.com');
    const body = 'Pray for the new school year e2e';

    const posted = await post('/en/my/prayer', `_action=post&scope=church&tab=church&body=${encodeURIComponent(body)}`, { cookie: member });
    expect(posted.headers.get('location')).toBe('/en/my/prayer?tab=church&ok=posted');

    const row = await env.DB.prepare('SELECT id, status FROM prayer_items WHERE body = ?').bind(body).first<{ id: number; status: string }>();
    expect(row?.status).toBe('pending');

    const pendingPage = await (await get('/en/my/prayer?tab=pending', { cookie: admin })).text();
    expect(pendingPage).toContain(body);

    const approved = await post('/en/my/prayer', `_action=approve&item_id=${row!.id}&tab=pending`, { cookie: admin });
    expect(approved.headers.get('location')).toBe('/en/my/prayer?tab=pending&ok=approved');
    expect(await (await get('/en/my/prayer?tab=church', { cookie: member })).text()).toContain(body);
  });

  it('renders the dashboard portal card row without Registration tables', async () => {
    const member = await sessionCookie(3, 'sarah.johnson@example.com');
    expect((await get('/en/my', { cookie: member })).status).toBe(200);
  });
});
