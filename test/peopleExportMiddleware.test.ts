import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('astro:middleware', () => ({
  defineMiddleware: <T>(handler: T): T => handler,
}));

import { clearModuleCache } from '../src/lib/modules';
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

function middlewareContext(path: string): FakeContext {
  const url = new URL(`http://localhost${path}`);
  const cookies = { get: vi.fn(() => undefined) };
  return {
    request: new Request(url),
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
});
