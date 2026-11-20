// The central gates for a person who only holds a per-event registration role: they reach one event's page and
// its check-in desk (the page derives the role itself) and nothing else; module off still 404s everything
// before any session work; a limited admin without the registration area is carved out for those two pages only.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('astro:middleware', () => ({
  defineMiddleware: <T>(handler: T): T => handler,
}));

import { clearModuleCache } from '../src/lib/modules';
import { mintSession, SESSION_COOKIE } from '../src/lib/session';
import { clearThemeCache } from '../src/lib/theme';
import { setSetting } from '../src/lib/settings';
import { onRequest } from '../src/middleware';
import { loadSessionUser } from '../src/lib/currentUser';
import { grantEventRole, hasRegistrationArea, regEventRole } from '../src/lib/regAccess';

function context(path: string, session?: string) {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url),
    url,
    locals: { cfContext: { waitUntil: vi.fn() } } as Record<string, unknown>,
    cookies: { get: vi.fn((name: string) => (name === SESSION_COOKIE && session ? { value: session } : undefined)) },
    redirect: (location: string, status: number) => new Response(null, { status, headers: { location: new URL(location, url).toString() } }),
    rewrite: vi.fn(async () => new Response('<h1>Not found</h1>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })),
  };
}

const secret = () => (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const session = (id: number, email: string) => mintSession(secret(), { id, email, sessionEpoch: 0 });

async function status(path: string, token?: string): Promise<{ status: number | undefined; reached: boolean }> {
  clearModuleCache();
  const ctx = context(path, token);
  const next = vi.fn(async () => new Response('route reached'));
  const response = await onRequest(ctx as never, next);
  return { status: response?.status, reached: next.mock.calls.length > 0 };
}

beforeEach(async () => {
  clearModuleCache();
  clearThemeCache();
  await setSetting(env.DB, 'module.registration', '1');
  await env.DB.prepare(
    `INSERT OR REPLACE INTO people (id, display_name, email, role, active, session_epoch, super_admin, admin_areas, deleted_at)
     VALUES (980, 'Door Volunteer', 'door@example.com', 'member', 1, 0, 0, '', NULL),
            (981, 'Limited Admin', 'limited@example.com', 'admin', 1, 0, 0, 'people', NULL)`,
  ).run();
});

describe('per-event registration roles at the middleware', () => {
  it('404s the event page and desk before any session work when Registration is off', async () => {
    await setSetting(env.DB, 'module.registration', '0');
    for (const path of ['/admin/registration/5', '/admin/registration/5/checkin']) {
      clearModuleCache();
      const ctx = context(path);
      const next = vi.fn(async () => new Response('must not render'));
      const response = await onRequest(ctx as never, next);
      expect(response?.status, path).toBe(404);
      expect(ctx.cookies.get, path).not.toHaveBeenCalled();
      expect(next, path).not.toHaveBeenCalled();
    }
  });

  it('sends anonymous visitors to sign in', async () => {
    const anon = await status('/admin/registration/5/checkin');
    expect(anon).toEqual({ status: 303, reached: false });
  });

  it('lets a plain member reach one event page and its desk, and nothing else under /admin', async () => {
    const token = await session(980, 'door@example.com');
    for (const path of ['/admin/registration/5', '/admin/registration/5/checkin']) {
      expect(await status(path, token), path).toEqual({ status: 200, reached: true });
    }
    for (const path of ['/admin/registration', '/admin/registration/5/export.csv', '/admin/registration/5/other', '/admin', '/admin/people']) {
      expect(await status(path, token), path).toEqual({ status: 403, reached: false });
    }
  });

  it('carves the two pages out of the limited-admin area gate and keeps every other registration page gated', async () => {
    const token = await session(981, 'limited@example.com');
    for (const path of ['/admin/registration/5', '/admin/registration/5/checkin']) {
      expect(await status(path, token), path).toEqual({ status: 200, reached: true });
    }
    for (const path of ['/admin/registration', '/admin/registration/5/export.csv']) {
      expect(await status(path, token), path).toEqual({ status: 403, reached: false });
    }
  });

  it('through the real session loader a limited admin is not a registration admin; only an explicit role makes them staff', async () => {
    const limited = await loadSessionUser(env.DB, 981, 0);
    expect(limited).toMatchObject({ isAdmin: true, isEditor: false, adminAreas: ['people'] });
    expect(hasRegistrationArea(limited)).toBe(false);
    const event = await env.DB.prepare(`INSERT INTO reg_events (starts_at) VALUES ('2032-01-01 09:00:00') RETURNING id`).first<{ id: number }>();
    expect(await regEventRole(env.DB, limited, event!.id)).toBeNull();
    await grantEventRole(env.DB, event!.id, 981, 'viewer');
    expect(await regEventRole(env.DB, limited, event!.id)).toBe('viewer');
    const volunteer = await loadSessionUser(env.DB, 980, 0);
    expect(volunteer).toMatchObject({ isAdmin: false, isEditor: false });
    expect(await regEventRole(env.DB, volunteer, event!.id)).toBeNull();
  });
});
