import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('astro:middleware', () => ({
  defineMiddleware: <T>(handler: T): T => handler,
}));

import type { AppDb } from '../src/lib/appDb';
import { setCampusModules, upsertCampusMembership } from '../src/lib/campusDb';
import { clearModuleCache } from '../src/lib/modules';
import { mintSession, SESSION_COOKIE } from '../src/lib/session';
import { clearThemeCache } from '../src/lib/theme';
import { onRequest } from '../src/middleware';

const CAMPUS_COOKIE = 'c4c_campus';
const db = env.DB;

type FakeContext = {
  request: Request;
  url: URL;
  locals: Record<string, unknown>;
  cookies: { get: ReturnType<typeof vi.fn> };
  redirect: (location: string, status: number) => Response;
  rewrite: ReturnType<typeof vi.fn>;
};

function context(path: string, options: { session?: string; campus?: string } = {}): FakeContext {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url),
    url,
    locals: { cfContext: { waitUntil: vi.fn((promise: Promise<unknown>) => { void promise; }) } },
    cookies: {
      get: vi.fn((name: string) => {
        if (name === SESSION_COOKIE && options.session) return { value: options.session };
        if (name === CAMPUS_COOKIE && options.campus) return { value: options.campus };
        return undefined;
      }),
    },
    redirect: (location, status) => new Response(null, {
      status,
      headers: { location: new URL(location, url).toString() },
    }),
    rewrite: vi.fn(async () => new Response('<h1>Not found</h1>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })),
  };
}

async function session(id: number, email: string): Promise<string> {
  const secret = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
  return mintSession(secret, { id, email, sessionEpoch: 0 });
}

beforeEach(async () => {
  clearModuleCache();
  clearThemeCache();
  await db.prepare('DELETE FROM campus_modules WHERE campus_id >= 82000').run();
  await db.prepare('DELETE FROM campus_memberships WHERE campus_id >= 82000 OR person_id >= 82000').run();
  await db.prepare('DELETE FROM events WHERE campus_id >= 82000').run();
  await db.prepare('DELETE FROM campuses WHERE id >= 82000').run();
  await db.prepare('DELETE FROM people WHERE id >= 82000').run();
  await db.prepare(
    `INSERT INTO people (id, display_name, email, role, super_admin) VALUES
       (82001, 'Middleware Master', 'mw-master@example.test', 'admin', 1),
       (82002, 'Middleware Campus Admin', 'mw-campus-admin@example.test', 'member', 0)`,
  ).run();
  await db.prepare(
    `INSERT INTO campuses (id, slug, name) VALUES
       (82001, 'north-mw', 'North Middleware'),
       (82002, 'south-mw', 'South Middleware')`,
  ).run();
  await upsertCampusMembership(db, {
    campusId: 82001,
    personId: 82002,
    role: 'admin',
    finance: false,
    adminAreas: ['groups'],
    active: true,
  });
  await db.prepare(
    `INSERT INTO events (starts_at, campus_id) VALUES
       ('north-event', 82001),
       ('south-event', 82002)`,
  ).run();
});

describe('campus middleware boundary', () => {
  it('scopes an anonymous public request to the campus selected by URL', async () => {
    const ctx = context('/events?campus=south-mw');
    const next = vi.fn(async () => {
      const scoped = ctx.locals.db as AppDb;
      const rows = await scoped.prepare('SELECT starts_at FROM events ORDER BY starts_at').all();
      return Response.json({ rows: rows.results, campus: ctx.locals.campus });
    });

    const response = await onRequest(ctx as never, next);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      rows: [{ starts_at: 'south-event' }],
      campus: { id: 82002, slug: 'south-mw', name: 'South Middleware' },
    });
  });

  it('derives a campus admin session from the selected campus and scopes route data', async () => {
    const token = await session(82002, 'mw-campus-admin@example.test');
    const ctx = context('/admin/groups', { session: token, campus: 'north-mw' });
    const next = vi.fn(async () => {
      const scoped = ctx.locals.db as AppDb;
      const rows = await scoped.prepare('SELECT starts_at FROM events').all();
      return Response.json({ rows: rows.results, user: ctx.locals.user });
    });

    const response = await onRequest(ctx as never, next);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      rows: [{ starts_at: 'north-event' }],
      user: {
        id: 82002,
        role: 'admin',
        isAdmin: true,
        isSuperAdmin: false,
        adminAreas: ['groups'],
        campusMode: 'campus',
        campus: { id: 82001, slug: 'north-mw' },
      },
    });
  });

  it('denies a non-master user who explicitly selects an unauthorized campus', async () => {
    const token = await session(82002, 'mw-campus-admin@example.test');
    const ctx = context('/admin/groups?campus=south-mw', { session: token });
    const next = vi.fn(async () => new Response('must not render'));

    const response = await onRequest(ctx as never, next);
    expect(response?.status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets only a master admin use all-campus mode', async () => {
    const masterToken = await session(82001, 'mw-master@example.test');
    const master = context('/admin/groups?campus=all', { session: masterToken });
    const masterNext = vi.fn(async () => {
      const rows = await (master.locals.db as AppDb).prepare(
        'SELECT starts_at FROM events WHERE campus_id >= 82000 ORDER BY starts_at',
      ).all();
      return Response.json({ rows: rows.results, user: master.locals.user });
    });
    const response = await onRequest(master as never, masterNext);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      rows: [{ starts_at: 'north-event' }, { starts_at: 'south-event' }],
      user: { isSuperAdmin: true, campusMode: 'all', campus: null },
    });

    const token = await session(82002, 'mw-campus-admin@example.test');
    const ordinary = context('/admin/groups?campus=all', { session: token });
    const ordinaryNext = vi.fn(async () => new Response('must not render'));
    expect((await onRequest(ordinary as never, ordinaryNext))?.status).toBe(403);
    expect(ordinaryNext).not.toHaveBeenCalled();
  });

  it('applies a campus-specific module switch before route execution', async () => {
    await setCampusModules(db, 82002, new Set(['sermons']));
    clearModuleCache();
    const ctx = context('/groups?campus=south-mw');
    const next = vi.fn(async () => new Response('must not render'));

    const response = await onRequest(ctx as never, next);
    expect(response?.status).toBe(404);
    expect(ctx.rewrite).toHaveBeenCalledWith('/404');
    expect(next).not.toHaveBeenCalled();
  });

  it('loads the selected campus theme without sharing another campus cache entry', async () => {
    await db.prepare(
      `INSERT INTO campus_settings (campus_id, key, value) VALUES
         (82001, 'theme.name', 'harvest'),
         (82002, 'theme.name', 'midnight')
       ON CONFLICT(campus_id, key) DO UPDATE SET value = excluded.value`,
    ).run();
    const north = context('/events?campus=north-mw');
    const south = context('/events?campus=south-mw');

    const northResponse = await onRequest(north as never, async () => Response.json({ theme: north.locals.theme }));
    const southResponse = await onRequest(south as never, async () => Response.json({ theme: south.locals.theme }));

    expect(await northResponse?.json()).toEqual({ theme: 'harvest' });
    expect(await southResponse?.json()).toEqual({ theme: 'midnight' });
  });
});
