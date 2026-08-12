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

type FakeContext = {
  request: Request;
  url: URL;
  locals: Record<string, unknown>;
  cookies: { get: ReturnType<typeof vi.fn> };
  redirect: (location: string, status: number) => Response;
  rewrite: ReturnType<typeof vi.fn>;
};

function middlewareContext(path: string, init: {
  method?: string;
  body?: BodyInit;
  headers?: HeadersInit;
  session?: string;
} = {}): FakeContext {
  const url = new URL(`http://localhost${path}`);
  const cookies = {
    get: vi.fn((name: string) => (
      name === SESSION_COOKIE && init.session ? { value: init.session } : undefined
    )),
  };
  return {
    request: new Request(url, {
      method: init.method ?? 'GET',
      body: init.method && init.method !== 'GET' && init.method !== 'HEAD' ? init.body : undefined,
      headers: init.headers,
    }),
    url,
    locals: {
      cfContext: { waitUntil: vi.fn((promise: Promise<unknown>) => { void promise; }) },
    },
    cookies,
    redirect: (location, status) => new Response(null, {
      status,
      headers: { location: new URL(location, url).toString() },
    }),
    rewrite: vi.fn(async () => new Response('<h1>Not found</h1>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })),
  };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'module.people'").run();
  clearModuleCache();
  clearThemeCache();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO people
      (id, display_name, email, role, active, session_epoch, super_admin, admin_areas, deleted_at)
     VALUES
      (970, 'People Admin', 'people-admin@example.com', 'admin', 1, 0, 0, 'people', NULL),
      (971, 'No Grant', 'no-grant@example.com', 'admin', 1, 0, 0, '', NULL),
      (972, 'Super Admin', 'super-export@example.com', 'admin', 1, 0, 1, '', NULL)`,
  ).run();
});

describe('People export central middleware gate', () => {
  const paths = [
    '/admin/people/export',
    '/admin/people/export.csv',
    '/admin/people/export-notes',
  ] as const;

  it('returns the central 404 before session handling for every exact path when People is disabled', async () => {
    await setSetting(env.DB, 'module.people', '0');
    clearModuleCache();
    for (const path of paths) {
      const context = middlewareContext(path);
      const next = vi.fn(async () => new Response('must not render'));
      const response = await onRequest(context as never, next);
      expect(response?.status, path).toBe(404);
      expect(context.rewrite, path).toHaveBeenCalledWith('/404');
      expect(context.cookies.get, path).not.toHaveBeenCalled();
      expect(next, path).not.toHaveBeenCalled();
    }
  });

  it('keeps enabled anonymous GETs on the admin redirect path', async () => {
    for (const path of paths) {
      clearModuleCache();
      const context = middlewareContext(path);
      const next = vi.fn(async () => new Response('must not render'));
      const response = await onRequest(context as never, next);
      expect(response?.status, path).toBe(303);
      expect(response?.headers.get('location'), path).toContain('/en/signin?next=');
      expect(context.cookies.get, path).toHaveBeenCalled();
      expect(context.rewrite, path).not.toHaveBeenCalled();
      expect(next, path).not.toHaveBeenCalled();
    }
  });

  it('applies the authenticated full-People area gate before calling a route', async () => {
    const secret = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
    const granted = await mintSession(secret, {
      id: 970,
      email: 'people-admin@example.com',
      sessionEpoch: 0,
    });
    const denied = await mintSession(secret, {
      id: 971,
      email: 'no-grant@example.com',
      sessionEpoch: 0,
    });

    for (const path of paths) {
      clearModuleCache();
      const grantedContext = middlewareContext(path, { session: granted });
      const grantedNext = vi.fn(async () => new Response('route reached'));
      const grantedResponse = await onRequest(grantedContext as never, grantedNext);
      expect(grantedResponse?.status, path).toBe(200);
      expect(grantedNext, path).toHaveBeenCalledTimes(1);

      clearModuleCache();
      const deniedContext = middlewareContext(path, { session: denied });
      const deniedNext = vi.fn(async () => new Response('must not render'));
      const deniedResponse = await onRequest(deniedContext as never, deniedNext);
      expect(deniedResponse?.status, path).toBe(403);
      expect(deniedNext, path).not.toHaveBeenCalled();
    }
  });

  it('rejects cross-origin notes POST before session lookup, route execution, or body reads', async () => {
    const secret = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
    const session = await mintSession(secret, {
      id: 972,
      email: 'super-export@example.com',
      sessionEpoch: 0,
    });
    let pulled = false;
    const context = middlewareContext('/admin/people/export-notes', {
      method: 'POST',
      session,
      headers: {
        origin: 'https://attacker.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new ReadableStream<Uint8Array>({
        pull() {
          pulled = true;
          throw new Error('body must not be read');
        },
      }, { highWaterMark: 0 }),
    });
    const next = vi.fn(async () => {
      await context.request.text();
      return new Response('must not render');
    });
    const response = await onRequest(context as never, next);
    expect(response?.status).toBe(403);
    expect(context.cookies.get).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(pulled).toBe(false);
    expect(context.request.body?.locked).toBe(false);
  });
});
