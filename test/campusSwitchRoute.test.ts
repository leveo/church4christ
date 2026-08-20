import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../src/lib/types';
import { upsertCampusMembership } from '../src/lib/campusDb';
import { POST } from '../src/pages/campus/switch';

const db = env.DB;

const user = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 83001,
  email: 'switcher@example.test',
  displayName: 'Switcher',
  role: 'member',
  isAdmin: false,
  isEditor: false,
  isSuperAdmin: false,
  adminAreas: [],
  finance: 0,
  memberTeamIds: [],
  leaderTeamIds: [],
  lang: 'en',
  ...over,
});

function request(slug: string, next = '/admin'): Request {
  const body = new URLSearchParams({ campus: slug, next });
  return new Request('http://localhost/campus/switch', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

function ctx(slug: string, actor: SessionUser | null, next?: string) {
  const set = vi.fn();
  return {
    context: {
      request: request(slug, next),
      locals: { rawDb: db, user: actor },
      cookies: { set },
      redirect: (location: string, status: number) => new Response(null, {
        status,
        headers: { location: new URL(location, 'http://localhost').toString() },
      }),
    },
    set,
  };
}

beforeEach(async () => {
  await db.prepare('DELETE FROM campus_memberships WHERE campus_id >= 83000 OR person_id >= 83000').run();
  await db.prepare('DELETE FROM campuses WHERE id >= 83000').run();
  await db.prepare('DELETE FROM people WHERE id >= 83000').run();
  await db.prepare(
    `INSERT INTO people (id, display_name, email, role, super_admin) VALUES
       (83001, 'Switcher', 'switcher@example.test', 'member', 0),
       (83002, 'Switch Master', 'switch-master@example.test', 'admin', 1)`,
  ).run();
  await db.prepare(
    `INSERT INTO campuses (id, slug, name, active) VALUES
       (83001, 'switch-north', 'Switch North', 1),
       (83002, 'switch-south', 'Switch South', 1),
       (83003, 'switch-closed', 'Switch Closed', 0)`,
  ).run();
  await upsertCampusMembership(db, {
    campusId: 83001,
    personId: 83001,
    role: 'admin',
    finance: false,
    adminAreas: ['groups'],
    active: true,
  });
});

describe('POST /campus/switch', () => {
  it('sets an HttpOnly campus cookie for an authorized membership', async () => {
    const { context, set } = ctx('switch-north', user());
    const response = await POST(context as never);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost/admin');
    expect(set).toHaveBeenCalledWith('c4c_campus', 'switch-north', expect.objectContaining({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    }));
  });

  it('denies a signed-in non-master selecting a campus without membership', async () => {
    const { context, set } = ctx('switch-south', user());
    const response = await POST(context as never);
    expect(response.status).toBe(403);
    expect(set).not.toHaveBeenCalled();
  });

  it('lets a master select aggregate all-campus mode', async () => {
    const master = user({
      id: 83002,
      email: 'switch-master@example.test',
      role: 'admin',
      isAdmin: true,
      isSuperAdmin: true,
    });
    const { context, set } = ctx('all', master, '/admin/campuses');
    const response = await POST(context as never);
    expect(response.status).toBe(303);
    expect(set).toHaveBeenCalledWith('c4c_campus', 'all', expect.any(Object));
  });

  it('allows anonymous visitors to choose an active public campus but not an inactive one', async () => {
    const allowed = ctx('switch-south', null, '/en/events');
    expect((await POST(allowed.context as never)).status).toBe(303);
    expect(allowed.set).toHaveBeenCalledWith('c4c_campus', 'switch-south', expect.any(Object));

    const denied = ctx('switch-closed', null, '/en/events');
    expect((await POST(denied.context as never)).status).toBe(404);
    expect(denied.set).not.toHaveBeenCalled();
  });

  it('falls back to root instead of honoring an external or protocol-relative redirect', async () => {
    for (const next of ['https://attacker.example', '//attacker.example', 'admin']) {
      const { context } = ctx('switch-north', user(), next);
      const response = await POST(context as never);
      expect(response.headers.get('location'), next).toBe('http://localhost/');
    }
  });
});
