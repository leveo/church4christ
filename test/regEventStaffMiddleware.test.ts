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

function context(path: string, session?: string, method = 'GET') {
  const url = new URL(`http://localhost${path}`);
  return {
    // A same-origin POST so the mutation-provenance check passes and the role gate is what decides.
    request: new Request(url, method === 'GET' ? undefined : { method, headers: { origin: url.origin, 'sec-fetch-site': 'same-origin' } }),
    url,
    locals: { cfContext: { waitUntil: vi.fn() } } as Record<string, unknown>,
    cookies: { get: vi.fn((name: string) => (name === SESSION_COOKIE && session ? { value: session } : undefined)) },
    redirect: (location: string, status: number) => new Response(null, { status, headers: { location: new URL(location, url).toString() } }),
    rewrite: vi.fn(async () => new Response('<h1>Not found</h1>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })),
  };
}

const secret = () => (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const session = (id: number, email: string) => mintSession(secret(), { id, email, sessionEpoch: 0 });

async function newEvent(): Promise<number> {
  const row = await env.DB.prepare(`INSERT INTO reg_events (starts_at) VALUES ('2032-01-01 09:00:00') RETURNING id`).first<{ id: number }>();
  return row!.id;
}

async function status(path: string, token?: string, method = 'GET'): Promise<{ status: number | undefined; reached: boolean }> {
  clearModuleCache();
  const ctx = context(path, token, method);
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

  it('fails closed: a signed-in member with no role for the event never reaches either page (GET or POST)', async () => {
    const token = await session(980, 'door@example.com');
    const event = await newEvent();
    for (const path of [`/admin/registration/${event}`, `/admin/registration/${event}/checkin`, '/admin/registration/999999']) {
      expect(await status(path, token), path).toEqual({ status: 403, reached: false });
      expect(await status(path, token, 'POST'), `POST ${path}`).toEqual({ status: 403, reached: false });
    }
  });

  it('a desk role reaches only the desk; a viewer only the event page; nothing else under /admin', async () => {
    const token = await session(980, 'door@example.com');
    const deskEvent = await newEvent();
    const viewEvent = await newEvent();
    await grantEventRole(env.DB, deskEvent, 980, 'desk');
    await grantEventRole(env.DB, viewEvent, 980, 'viewer');
    expect(await status(`/admin/registration/${deskEvent}/checkin`, token)).toEqual({ status: 200, reached: true });
    // The same-origin POST passes provenance, so the 403s above for POST come from the role gate.
    expect(await status(`/admin/registration/${deskEvent}/checkin`, token, 'POST')).toEqual({ status: 200, reached: true });
    expect(await status(`/admin/registration/${deskEvent}`, token)).toEqual({ status: 403, reached: false });
    expect(await status(`/admin/registration/${viewEvent}`, token)).toEqual({ status: 200, reached: true });
    expect(await status(`/admin/registration/${viewEvent}/checkin`, token)).toEqual({ status: 403, reached: false });
    // A role on one event opens nothing on another.
    expect(await status(`/admin/registration/${viewEvent + 1000}`, token)).toEqual({ status: 403, reached: false });
    for (const path of ['/admin/registration', `/admin/registration/${viewEvent}/other`, '/admin', '/admin/people']) {
      expect(await status(path, token), path).toEqual({ status: 403, reached: false });
    }
  });

  it('every read-only per-event page (CSV, people CSV, badges, sign-in sheet, logistics prints) needs view: a viewer reaches them, a desk volunteer does not', async () => {
    const token = await session(980, 'door@example.com');
    const viewEvent = await newEvent();
    const deskEvent = await newEvent();
    await grantEventRole(env.DB, viewEvent, 980, 'viewer');
    await grantEventRole(env.DB, deskEvent, 980, 'desk');
    // The event-logistics prints are gated the same way here (the page itself then 404s when the module or the area is off).
    for (const tail of ['export.csv', 'export-people.csv', 'badges', 'sign-in-sheet', 'room-list', 'door-signs', 'table-list', 'table-cards', 'group-list']) {
      expect(await status(`/admin/registration/${viewEvent}/${tail}`, token), tail).toEqual({ status: 200, reached: true });
      expect(await status(`/admin/registration/${deskEvent}/${tail}`, token), `desk ${tail}`).toEqual({ status: 403, reached: false });
      // A role on one event opens nothing on another.
      expect(await status(`/admin/registration/${viewEvent + 5000}/${tail}`, token), `other ${tail}`).toEqual({ status: 403, reached: false });
    }
  });

  it('carves the per-event pages out of the limited-admin area gate only for a held role, and keeps the event list gated', async () => {
    const token = await session(981, 'limited@example.com');
    const event = await newEvent();
    expect(await status(`/admin/registration/${event}`, token)).toEqual({ status: 403, reached: false });
    await grantEventRole(env.DB, event, 981, 'registrar');
    for (const path of [`/admin/registration/${event}`, `/admin/registration/${event}/checkin`, `/admin/registration/${event}/export.csv`, `/admin/registration/${event}/badges`]) {
      expect(await status(path, token), path).toEqual({ status: 200, reached: true });
    }
    // The event list stays for registration admins only.
    expect(await status('/admin/registration', token)).toEqual({ status: 403, reached: false });
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
