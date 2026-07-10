// Admin-customizable top navigation. The menu is an ordered JSON array in
// settings key `nav.items`; when unset or unparsable the hardcoded default
// (the pre-customization menu) is used, so a bad save can never blank the nav.
import type { AppDb } from './appDb';
import type { Locale } from './locales';
import { localePath } from './locales';
import { t } from './i18n';
import { MODULE_KEYS, MODULES } from './modules';
import { getSetting } from './settings';
import { listPublishedPageTitles } from './pagesDb';

export const NAV_SETTING_KEY = 'nav.items';

export const BUILTIN_NAV: { key: string; path: string }[] = [
  { key: 'nav.visit', path: '/visit' },
  { key: 'nav.about', path: '/about' },
  { key: 'nav.sermons', path: '/sermons' },
  { key: 'nav.bulletin', path: '/bulletin' },
  { key: 'nav.events', path: '/events' },
  { key: 'nav.register', path: '/register' },
  { key: 'nav.ministries', path: '/ministries' },
  { key: 'nav.serve', path: '/serve' },
  { key: 'nav.opportunities', path: '/serve/opportunities' },
  { key: 'nav.fellowships', path: '/fellowships' },
  { key: 'nav.articles', path: '/articles' },
];

export type NavItem =
  | { type: 'builtin'; key: string }
  | { type: 'page'; slug: string }
  | { type: 'link'; url: string; label: { en: string; zh: string } };

export const DEFAULT_NAV: NavItem[] = BUILTIN_NAV.map((b) => ({ type: 'builtin' as const, key: b.key }));

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_URL = /^(https?:\/\/|\/)/i;

export function parseNavItems(raw: string): NavItem[] {
  if (!raw) return DEFAULT_NAV;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_NAV;
  }
  if (!Array.isArray(parsed)) return DEFAULT_NAV;
  const items: NavItem[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    if (o.type === 'builtin' && typeof o.key === 'string' && BUILTIN_NAV.some((b) => b.key === o.key)) {
      items.push({ type: 'builtin', key: o.key });
    } else if (o.type === 'page' && typeof o.slug === 'string' && SLUG_RE.test(o.slug)) {
      items.push({ type: 'page', slug: o.slug });
    } else if (o.type === 'link' && typeof o.url === 'string' && SAFE_URL.test(o.url) && o.label && typeof o.label === 'object') {
      const l = o.label as Record<string, unknown>;
      const en = typeof l.en === 'string' ? l.en.trim() : '';
      const zh = typeof l.zh === 'string' ? l.zh.trim() : '';
      if (en || zh) items.push({ type: 'link', url: o.url, label: { en, zh } });
    }
  }
  return items;
}

export function serializeNavItems(items: NavItem[]): string {
  return JSON.stringify(items);
}

export interface ResolvedNavLink {
  label: string;
  href: string;
}

// navKey → owning module, e.g. 'nav.sermons' → 'sermons'. Built fresh per call
// (cheap: MODULE_KEYS.length iterations over short arrays) rather than cached
// module-level state, keeping this file free of the isolate-lifetime caches
// modules.ts/theme.ts use for actual DB reads.
function buildNavKeyModuleMap(): Map<string, string> {
  const navKeyModule = new Map<string, string>();
  for (const key of MODULE_KEYS) for (const nk of MODULES[key].navKeys) navKeyModule.set(nk, key);
  return navKeyModule;
}

/** A single BUILTIN_NAV entry resolved to a label/href, or null when its
 *  owning module is disabled. Shared by resolveDefaultNav and resolveNav's
 *  builtin branch so the two can never drift on the gating rule. */
function resolveBuiltinLink(
  b: { key: string; path: string },
  locale: Locale,
  modules: Set<string>,
  navKeyModule: Map<string, string>,
): ResolvedNavLink | null {
  const owner = navKeyModule.get(b.key);
  if (owner && !modules.has(owner)) return null;
  return { label: t(locale, b.key), href: localePath(locale, b.path) };
}

/** The module-gated BUILTIN_NAV resolved to labels/hrefs, computable with no
 *  DB access. Header's fallback when the settings-driven resolveNav call is
 *  unavailable — a DB hiccup renders exactly the pre-customization nav. */
export function resolveDefaultNav(locale: Locale, modules: Set<string>): ResolvedNavLink[] {
  const navKeyModule = buildNavKeyModuleMap();
  const out: ResolvedNavLink[] = [];
  for (const b of BUILTIN_NAV) {
    const link = resolveBuiltinLink(b, locale, modules, navKeyModule);
    if (link) out.push(link);
  }
  return out;
}

/** The links Header actually renders: setting parsed, builtins module-gated,
 *  page items resolved to published titles (drafts drop out), link items as-is. */
export async function resolveNav(db: AppDb, locale: Locale, modules: Set<string>): Promise<ResolvedNavLink[]> {
  const items = parseNavItems(await getSetting(db, NAV_SETTING_KEY, ''));
  const navKeyModule = buildNavKeyModuleMap();
  const slugs = items.flatMap((x) => (x.type === 'page' ? [x.slug] : []));
  const titles = slugs.length ? await listPublishedPageTitles(db, slugs, locale) : new Map<string, string>();
  const out: ResolvedNavLink[] = [];
  for (const item of items) {
    if (item.type === 'builtin') {
      const b = BUILTIN_NAV.find((x) => x.key === item.key)!;
      const link = resolveBuiltinLink(b, locale, modules, navKeyModule);
      if (link) out.push(link);
    } else if (item.type === 'page') {
      const title = titles.get(item.slug);
      if (!title) continue;
      out.push({ label: title, href: localePath(locale, `/p/${item.slug}`) });
    } else {
      const label = (locale === 'zh' ? item.label.zh : item.label.en) || item.label.en || item.label.zh;
      out.push({ label, href: item.url });
    }
  }
  return out;
}
