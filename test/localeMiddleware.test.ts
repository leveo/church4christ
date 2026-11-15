import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('astro:middleware', () => ({
  defineMiddleware: <T>(handler: T): T => handler,
}));

import { clearLocaleSettingsCache, saveLocaleSettings } from '../src/lib/localeSettings';
import { setRuntimeDefaultLocale } from '../src/lib/locales';
import { clearModuleCache } from '../src/lib/modules';
import { clearThemeCache } from '../src/lib/theme';
import { onRequest } from '../src/middleware';
import { sameOriginTarget } from '../src/lib/safeRedirect';

const db = env.DB;

function context(path: string, options: { cookie?: string; acceptLanguage?: string; method?: string } = {}) {
  const url = new URL(`http://localhost${path}`);
  const headers = new Headers();
  if (options.acceptLanguage) headers.set('accept-language', options.acceptLanguage);
  const locals: Record<string, unknown> = { cfContext: { waitUntil: vi.fn() } };
  return {
    request: new Request(url, { method: options.method ?? 'GET', headers }),
    url,
    locals,
    cookies: { get: vi.fn((name: string) => (name === 'c4c_locale' && options.cookie ? { value: options.cookie } : undefined)) },
    redirect: (location: string, status: number) => new Response(null, { status, headers: { location: new URL(location, url).toString() } }),
    rewrite: vi.fn(async () => new Response('nf', { status: 404 })),
  };
}

async function run(path: string, options: Parameters<typeof context>[1] = {}) {
  const ctx = context(path, options);
  const next = vi.fn(async () => new Response('ok'));
  const res = (await onRequest(ctx as never, next)) as Response;
  return { ctx, res, next };
}

const loc = (res: Response) => (res.headers.get('location') ? new URL(res.headers.get('location')!).pathname + new URL(res.headers.get('location')!).search : null);

beforeEach(async () => {
  await db.prepare("DELETE FROM settings WHERE key LIKE 'locale.%'").run();
  clearLocaleSettingsCache();
  clearModuleCache();
  clearThemeCache();
  setRuntimeDefaultLocale('en');
});

describe('language routing middleware', () => {
  it('serves both locales and exposes the legacy settings on an untouched install', async () => {
    const { ctx, res, next } = await run('/zh/about');
    expect(res.status).toBe(200);
    expect(next).toHaveBeenCalled();
    expect(ctx.locals.locale).toBe('zh');
    expect(ctx.locals.locales).toEqual({ enabled: ['en', 'zh'], default: 'en' });
  });

  it('negotiates the bare root from Accept-Language and sets Vary', async () => {
    const { res } = await run('/', { acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8' });
    expect(res.status).toBe(302);
    expect(loc(res)).toBe('/zh/');
    expect(res.headers.get('vary')).toBe('Accept-Language, Cookie');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('prefers the switcher cookie over Accept-Language', async () => {
    const { res } = await run('/', { cookie: 'en', acceptLanguage: 'zh-CN' });
    expect(loc(res)).toBe('/en/');
  });

  it('falls back to the default when nothing matches', async () => {
    const { res } = await run('/', { acceptLanguage: 'sw-KE' });
    expect(loc(res)).toBe('/en/');
  });

  it('redirects a disabled locale to the same path in the default locale (GET only)', async () => {
    await saveLocaleSettings(db, ['en'], 'en');
    const get = await run('/zh/sermons/2026?x=1');
    expect(get.res.status).toBe(302);
    expect(loc(get.res)).toBe('/en/sermons/2026?x=1');
    expect(get.next).not.toHaveBeenCalled();
    const home = await run('/zh');
    expect(loc(home.res)).toBe('/en/');
    const post = await run('/zh/signin', { method: 'POST' });
    expect(post.res.status).not.toBe(302);
  });

  it('negotiates only over the enabled set', async () => {
    await saveLocaleSettings(db, ['en'], 'en');
    const { res } = await run('/', { acceptLanguage: 'zh-CN', cookie: 'zh' });
    expect(loc(res)).toBe('/en/');
  });

  it('honors a non-en default for the root and for non-locale 404 paths', async () => {
    await saveLocaleSettings(db, ['en', 'zh'], 'zh');
    expect(loc((await run('/', {})).res)).toBe('/zh/');
    const { ctx } = await run('/no-such-page');
    expect(ctx.locals.locale).toBe('zh');
  });

  it('keeps unknown locale codes as ordinary 404-able paths and Learning strict', async () => {
    const unknown = await run('/xx/about');
    expect(unknown.res.status).toBe(200); // not a locale segment: the router (not this redirect) 404s it
    expect(unknown.ctx.locals.locale).toBe('en');
    const learn = await run('/ZH/learn');
    expect(learn.res.status).toBe(404);
    expect(learn.next).not.toHaveBeenCalled();
  });

  it('turns ?setlang into the c4c_locale cookie and a clean redirect, only for enabled codes', async () => {
    const ok = await run('/en/about?setlang=zh&a=1');
    expect(ok.res.status).toBe(302);
    expect(loc(ok.res)).toBe('/en/about?a=1');
    expect(ok.res.headers.get('set-cookie')).toMatch(/^c4c_locale=zh; Path=\/; Max-Age=31536000; SameSite=Lax/);
    await saveLocaleSettings(db, ['en'], 'en');
    const disabled = await run('/en/about?setlang=zh');
    expect(loc(disabled.res)).toBe('/en/about');
    expect(disabled.res.headers.get('set-cookie')).toBeNull();
  });

  it('never sets the cookie on ordinary requests', async () => {
    const { res } = await run('/zh/about', { acceptLanguage: 'zh' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    '//evil.example/x?setlang=zh',
    '/\\evil.example/x?setlang=zh',
    '/%2F%2Fevil.example?setlang=zh',
    '/%5Cevil.example?setlang=zh',
    '///evil.example?setlang=zh',
  ])('keeps the setlang redirect on the same origin for %s', async (path) => {
    const { res } = await run(path);
    const location = res.headers.get('location');
    if (res.status === 400) return;
    expect(res.status).toBe(302);
    expect(new URL(location!).origin).toBe('http://localhost');
  });

  it.each(['//evil.example/about', '/\\evil.example/about'])('keeps the disabled-locale redirect same-origin for %s', async (path) => {
    await saveLocaleSettings(db, ['en'], 'en');
    const { res } = await run(`/zh${path}`);
    expect(new URL(res.headers.get('location')!).origin).toBe('http://localhost');
  });

  it('sameOriginTarget collapses protocol-relative prefixes', () => {
    expect(sameOriginTarget('http://localhost', '//evil.example/x?a=1')).toBe('/evil.example/x?a=1');
    expect(sameOriginTarget('http://localhost', '/\\evil.example')).toBe('/evil.example');
    expect(sameOriginTarget('http://localhost', '/%2F%2Fevil.example')).toBe('/%2F%2Fevil.example');
    expect(sameOriginTarget('http://localhost', '/en/about?x=1')).toBe('/en/about?x=1');
  });
});
