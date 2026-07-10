// nav.ts: the settings-driven top navigation. Pure parse/serialize cases run
// without a DB; resolveNav cases exercise the real D1 binding (workers pool) —
// migrations/0005 (custom_pages) auto-applies via test/setup.ts.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_NAV,
  DEFAULT_NAV,
  NAV_SETTING_KEY,
  parseNavItems,
  resolveNav,
  serializeNavItems,
  type NavItem,
} from '../src/lib/nav';
import { setSetting } from '../src/lib/settings';
import { saveCustomPage } from '../src/lib/pagesDb';
import { MODULE_KEYS } from '../src/lib/modules';
import { t } from '../src/lib/i18n';
import { localePath } from '../src/lib/locales';

beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM revisions WHERE entity = 'custom_page'",
      'DELETE FROM custom_page_i18n',
      'DELETE FROM custom_pages',
      'DELETE FROM settings',
    ].map((s) => env.DB.prepare(s)),
  );
});

const ALL_MODULES = new Set<string>(MODULE_KEYS);

describe('parseNavItems', () => {
  it("empty string falls back to DEFAULT_NAV", () => {
    expect(parseNavItems('')).toEqual(DEFAULT_NAV);
  });

  it('bad JSON falls back to DEFAULT_NAV', () => {
    expect(parseNavItems('not json')).toEqual(DEFAULT_NAV);
  });

  it('a non-array JSON value falls back to DEFAULT_NAV', () => {
    expect(parseNavItems('{"type":"builtin","key":"nav.visit"}')).toEqual(DEFAULT_NAV);
  });

  it('an entry with an unknown type is dropped, valid siblings survive', () => {
    const raw = JSON.stringify([{ type: 'bogus' }, { type: 'builtin', key: 'nav.visit' }]);
    expect(parseNavItems(raw)).toEqual([{ type: 'builtin', key: 'nav.visit' }]);
  });

  it('a builtin entry with an unknown key is dropped', () => {
    const raw = JSON.stringify([{ type: 'builtin', key: 'nav.doesnotexist' }]);
    expect(parseNavItems(raw)).toEqual([]);
  });

  it('a link entry with a javascript: url is dropped', () => {
    const raw = JSON.stringify([
      { type: 'link', url: 'javascript:alert(1)', label: { en: 'Evil', zh: '' } },
    ]);
    expect(parseNavItems(raw)).toEqual([]);
  });

  it('a link entry with neither en nor zh label is dropped', () => {
    const raw = JSON.stringify([
      { type: 'link', url: 'https://example.com', label: { en: '', zh: '' } },
    ]);
    expect(parseNavItems(raw)).toEqual([]);
  });

  it('accepts a well-formed link (http url, only one label set) and a page entry', () => {
    const raw = JSON.stringify([
      { type: 'link', url: 'https://example.com', label: { en: 'External', zh: '' } },
      { type: 'page', slug: 'about-us' },
    ]);
    expect(parseNavItems(raw)).toEqual([
      { type: 'link', url: 'https://example.com', label: { en: 'External', zh: '' } },
      { type: 'page', slug: 'about-us' },
    ]);
  });

  it('round-trips through serializeNavItems', () => {
    const items: NavItem[] = [
      { type: 'builtin', key: 'nav.visit' },
      { type: 'page', slug: 'about' },
      { type: 'link', url: 'https://example.com', label: { en: 'External', zh: '外部' } },
    ];
    expect(parseNavItems(serializeNavItems(items))).toEqual(items);
  });
});

describe('resolveNav', () => {
  it('with no setting, resolves DEFAULT_NAV to the module-gated builtins with i18n labels', async () => {
    const links = await resolveNav(env.DB, 'en', ALL_MODULES);
    expect(links).toEqual(
      BUILTIN_NAV.map((b) => ({ label: t('en', b.key), href: localePath('en', b.path) })),
    );
  });

  it('a setting with a published page slug resolves to the page title and /{locale}/p/{slug}', async () => {
    await saveCustomPage(env.DB, {
      id: null,
      slug: 'about-us',
      published: true,
      title_en: 'About Us',
      title_zh: '关于我们',
      body_en: 'body',
      body_zh: '内容',
      updatedBy: 'admin@example.com',
    });
    await setSetting(
      env.DB,
      NAV_SETTING_KEY,
      serializeNavItems([{ type: 'page', slug: 'about-us' }]),
    );
    const linksEn = await resolveNav(env.DB, 'en', ALL_MODULES);
    expect(linksEn).toEqual([{ label: 'About Us', href: '/en/p/about-us' }]);
    const linksZh = await resolveNav(env.DB, 'zh', ALL_MODULES);
    expect(linksZh).toEqual([{ label: '关于我们', href: '/zh/p/about-us' }]);
  });

  it('an unpublished page entry is dropped', async () => {
    await saveCustomPage(env.DB, {
      id: null,
      slug: 'draft-page',
      published: false,
      title_en: 'Draft',
      title_zh: '草稿',
      body_en: 'body',
      body_zh: '内容',
      updatedBy: 'admin@example.com',
    });
    await setSetting(
      env.DB,
      NAV_SETTING_KEY,
      serializeNavItems([{ type: 'page', slug: 'draft-page' }]),
    );
    expect(await resolveNav(env.DB, 'en', ALL_MODULES)).toEqual([]);
  });

  it('a builtin whose owning module is off is dropped', async () => {
    await setSetting(
      env.DB,
      NAV_SETTING_KEY,
      serializeNavItems([
        { type: 'builtin', key: 'nav.visit' },
        { type: 'builtin', key: 'nav.sermons' },
      ]),
    );
    const modulesWithoutSermons = new Set(MODULE_KEYS.filter((k) => k !== 'sermons'));
    const links = await resolveNav(env.DB, 'en', modulesWithoutSermons);
    expect(links).toEqual([{ label: t('en', 'nav.visit'), href: localePath('en', '/visit') }]);
  });

  it('zh locale prefers the zh label for a link item, falling back to en when zh is blank', async () => {
    await setSetting(
      env.DB,
      NAV_SETTING_KEY,
      serializeNavItems([
        { type: 'link', url: 'https://example.com/both', label: { en: 'Both', zh: '两者' } },
        { type: 'link', url: 'https://example.com/en-only', label: { en: 'English Only', zh: '' } },
      ]),
    );
    const links = await resolveNav(env.DB, 'zh', ALL_MODULES);
    expect(links).toEqual([
      { label: '两者', href: 'https://example.com/both' },
      { label: 'English Only', href: 'https://example.com/en-only' },
    ]);
  });
});
