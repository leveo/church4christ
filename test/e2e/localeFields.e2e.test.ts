// The per-locale tabbed field group renders one tab per enabled locale, keeps the
// legacy `<field>_en` / `<field>_zh` names (so handlers are unchanged), preserves
// the text of a disabled locale in a hidden input, and the same forms still save.
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { get, ORIGIN } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { clearLocaleSettingsCache } from '../../src/lib/localeSettings';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function editorCookie(): Promise<string> {
  return `${SESSION_COOKIE}=${await mintSession(SECRET, { id: 2, email: 'pastor.david@example.com', sessionEpoch: 0 })}`;
}

afterEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'locale.%'").run();
  clearLocaleSettingsCache();
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
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('locale.enabled', '[\"en\"]') ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('locale.default', 'en') ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    ]);
    clearLocaleSettingsCache();
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
    const row = await env.DB.prepare("SELECT title_en, title_zh FROM events WHERE title_en = 'Tabbed Event'").first<{ title_en: string; title_zh: string }>();
    expect(row).toEqual({ title_en: 'Tabbed Event', title_zh: '分页活动' });
  });
});
