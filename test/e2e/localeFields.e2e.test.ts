// The per-locale tabbed field group renders one tab per enabled locale, keeps the
// legacy `<field>_en` / `<field>_zh` names (so handlers are unchanged), preserves
// the text of a disabled locale in a hidden input, and the same forms still save.
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { get, ORIGIN } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function adminCookie(): Promise<string> {
  return `${SESSION_COOKIE}=${await mintSession(SECRET, { id: 1, email: 'admin@example.com', sessionEpoch: 0 })}`;
}
/** Save language settings through the real Settings form: the built worker keeps its
 *  own 60-second memo, which only a save inside that isolate clears. */
async function saveLanguages(enabled: string[], defaultLocale: string): Promise<void> {
  const form = new FormData();
  form.set('locale.enabled_form', '1');
  for (const code of enabled) form.append('locale.enabled', code);
  form.set('locale.default', defaultLocale);
  const res = await SELF.fetch(`${ORIGIN}/admin/settings`, { method: 'POST', headers: { origin: ORIGIN, cookie: await adminCookie() }, body: form, redirect: 'manual' });
  expect(res.status).toBe(303);
}
async function editorCookie(): Promise<string> {
  return `${SESSION_COOKIE}=${await mintSession(SECRET, { id: 2, email: 'pastor.david@example.com', sessionEpoch: 0 })}`;
}

afterEach(async () => {
  await saveLanguages(['en', 'zh'], 'en');
});

describe('LocaleFields in admin editors', () => {
  it('shows English and Chinese tabs with the legacy field names when both are enabled', async () => {
    const html = await (await get('/admin/events', { cookie: await editorCookie() })).text();
    expect(html).toContain('data-locale-fields="title"');
    expect(html).toMatch(/class="lf-tab"[^>]*>\s*English/);
    expect(html).toMatch(/class="lf-tab"[^>]*>\s*中文/);
    expect(html).toContain('name="title_en"');
    expect(html).toContain('name="title_zh"');
    expect(html).toContain('name="blurb_en"');
  });

  it('hides a disabled locale tab but keeps its field as a hidden input', async () => {
    await saveLanguages(['en'], 'en');
    const html = await (await get('/admin/events', { cookie: await editorCookie() })).text();
    expect(html).not.toMatch(/class="lf-tab"[^>]*>\s*中文/);
    expect(html).toMatch(/<input type="hidden" name="title_zh"/);
  });

  it('still saves both languages through the unchanged form fields', async () => {
    const form = new FormData();
    form.set('action', 'save');
    form.set('title_en', 'Tabbed Event');
    form.set('title_zh', '分页活动');
    form.set('sort', '0');
    form.set('active', 'on');
    form.set('image_key', '');
    const res = await SELF.fetch(`${ORIGIN}/admin/events`, {
      method: 'POST', headers: { origin: ORIGIN, cookie: await editorCookie() }, body: form, redirect: 'manual',
    });
    expect(res.status).toBe(303);
    const rows = await env.DB.prepare("SELECT locale, title FROM event_i18n WHERE title IN ('Tabbed Event', '分页活动') ORDER BY locale").all<{ locale: string; title: string }>();
    expect(rows.results).toEqual([{ locale: 'en', title: 'Tabbed Event' }, { locale: 'zh', title: '分页活动' }]);
  });
});

describe('language routing on the built worker', () => {
  it('negotiates the bare root with Vary, and the switcher cookie wins over Accept-Language', async () => {
    const zh = await get('/', { 'accept-language': 'zh-CN,zh;q=0.9' });
    expect(zh.status).toBe(302);
    expect(new URL(zh.headers.get('location')!, ORIGIN).pathname).toBe('/zh/');
    expect(zh.headers.get('vary')).toBe('Accept-Language, Cookie');
    const cookie = await get('/', { 'accept-language': 'zh-CN', cookie: 'c4c_locale=en' });
    expect(new URL(cookie.headers.get('location')!, ORIGIN).pathname).toBe('/en/');
  });

  it('turns ?setlang into a cookie and redirects disabled locales to the default', async () => {
    const set = await get('/en/about?setlang=zh');
    expect(set.status).toBe(302);
    expect(set.headers.get('set-cookie')).toContain('c4c_locale=zh');
    expect(new URL(set.headers.get('location')!, ORIGIN).pathname).toBe('/en/about');
    await saveLanguages(['en'], 'en');
    const disabled = await get('/zh/about');
    expect(disabled.status).toBe(302);
    expect(new URL(disabled.headers.get('location')!, ORIGIN).pathname).toBe('/en/about');
    const page = await (await get('/en/about')).text();
    expect(page).not.toContain('hreflang="zh-Hans"');
    expect(page).toContain('hreflang="x-default"');
  });
});
