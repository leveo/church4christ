// Member app (PWA) settings and generated files. Runs in the workers project
// against a live, migrated D1 binding for the settings round trip; the rest is
// pure: tab visibility against website modules, the admin form, the manifest and
// the service worker source.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_TABS,
  APP_TAB_PATH,
  appSettingsFromRows,
  buildManifest,
  buildServiceWorker,
  getAppSettings,
  parseAppSettingsForm,
  resolveAppTabs,
  shortAppName,
  visibleAppTabs,
} from '../src/lib/memberApp';
import { setSettings } from '../src/lib/settings';

const ALL_MODULES = new Set(['events', 'groups', 'giving', 'sermons']);

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.append(key, value);
  return fd;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'app.%'").run();
});

describe('member app settings', () => {
  it('defaults to the app on with Main, Events, Groups and Giving', async () => {
    const settings = await getAppSettings(env.DB);
    expect(settings.enabled).toBe(true);
    expect(APP_TABS).toEqual(['home', 'events', 'groups', 'giving']);
    expect(APP_TABS.every((tab) => settings.tabs[tab])).toBe(true);
  });

  it('treats only the exact string 0 as off', () => {
    const s = appSettingsFromRows({ 'app.enabled': '1', 'app.tab.events': '0', 'app.tab.groups': 'yes' });
    expect(s.enabled).toBe(true);
    expect(s.tabs).toEqual({ home: true, events: false, groups: true, giving: true });
    expect(appSettingsFromRows({ 'app.enabled': '0' }).enabled).toBe(false);
  });

  it('reads the stored rows back', async () => {
    await setSettings(env.DB, { 'app.enabled': '1', 'app.tab.giving': '0', 'app.tab.groups': '0' });
    const s = await getAppSettings(env.DB);
    expect(s.tabs).toEqual({ home: true, events: true, groups: false, giving: false });
  });
});

describe('visible tabs', () => {
  const on = appSettingsFromRows({});

  it('shows all four tabs, in order, when every website module is on', () => {
    expect(visibleAppTabs(on, ALL_MODULES)).toEqual(['home', 'events', 'groups', 'giving']);
  });

  it('hides Giving when the giving module is off (the D1 case), leaving three tabs', () => {
    expect(visibleAppTabs(on, new Set(['events', 'groups']))).toEqual(['home', 'events', 'groups']);
  });

  it('hides a tab the admin turned off even when its module is on', () => {
    const s = appSettingsFromRows({ 'app.tab.events': '0' });
    expect(visibleAppTabs(s, ALL_MODULES)).toEqual(['home', 'groups', 'giving']);
  });

  it('falls back to Main when nothing else is left', () => {
    const s = appSettingsFromRows({ 'app.tab.home': '0', 'app.tab.groups': '1', 'app.tab.events': '0', 'app.tab.giving': '0' });
    expect(visibleAppTabs(s, new Set())).toEqual(['home']);
  });

  it('gates a page: 404 (null) when the app is off or the tab is hidden', async () => {
    expect(await resolveAppTabs(env.DB, ALL_MODULES, 'giving')).toEqual(['home', 'events', 'groups', 'giving']);
    expect(await resolveAppTabs(env.DB, new Set(['events']), 'giving')).toBeNull();
    await setSettings(env.DB, { 'app.enabled': '0' });
    expect(await resolveAppTabs(env.DB, ALL_MODULES, null)).toBeNull();
  });

  it('maps every tab to a path under /app', () => {
    for (const tab of APP_TABS) expect(APP_TAB_PATH[tab].startsWith('/app')).toBe(true);
  });
});

describe('Settings -> Member app form', () => {
  it('writes every key explicitly: checked = 1, unchecked = 0', () => {
    const parsed = parseAppSettingsForm(form({ 'app.enabled': '1', 'app.tab.home': '1', 'app.tab.groups': '1' }));
    expect(parsed).toEqual({
      ok: true,
      data: { 'app.enabled': '1', 'app.tab.home': '1', 'app.tab.events': '0', 'app.tab.groups': '1', 'app.tab.giving': '0' },
    });
  });

  it('can turn the whole app off', () => {
    const parsed = parseAppSettingsForm(form({ 'app.tab.home': '1' }));
    expect(parsed.ok && parsed.data['app.enabled']).toBe('0');
  });

  it('rejects a save with no tab chosen', () => {
    expect(parseAppSettingsForm(form({ 'app.enabled': '1' }))).toEqual({ ok: false, error: 'noTabs' });
  });
});

describe('web app manifest', () => {
  it('is a standalone app scoped to the locale, with installable icons', () => {
    const m = buildManifest({
      locale: 'zh',
      lang: 'zh-Hans',
      name: '恩典教会',
      description: '欢迎',
      themeColor: '#026F6C', /* tokens-ok */
      backgroundColor: '#FFFFFF', /* tokens-ok */
    });
    expect(m).toMatchObject({ id: '/zh/app/', start_url: '/zh/app/', scope: '/zh/app/', display: 'standalone', name: '恩典教会', lang: 'zh-Hans' });
    const icons = m.icons as Array<{ sizes: string; purpose: string }>;
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('shortens long names for the home-screen label', () => {
    expect(shortAppName('Grace Community Church of Dallas')).toBe('Grace Commun');
    expect(shortAppName('  Grace  ')).toBe('Grace');
  });
});

describe('service worker', () => {
  const sw = buildServiceWorker('en', '9.9.9');

  it('versions its cache per locale and release, precaches the offline page, and stays in scope', () => {
    expect(sw).toContain('"cache":"c4c-app-en-9.9.9-');
    expect(sw).toContain('"scope":"/en/app/"');
    expect(sw).toContain('"offline":"/en/app/offline"');
    expect(sw).toContain('/app-icons/icon-192.png');
  });

  it('never stores personal (no-store) pages', () => {
    expect(sw).toMatch(/no-store/);
    expect(sw).toContain("req.method !== 'GET'");
  });
});
