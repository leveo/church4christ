// Member app (PWA): a phone-first view of the church for ordinary members, served
// by the same Worker and database as the website under /<locale>/app. It has no
// backend of its own: every tab reads the same tables, settings and session as
// the matching website page, and the route policy treats /app like any other
// public page (member-only data is filtered inside each page, exactly as on the
// website).
//
// Admins choose which tabs the app shows under Settings -> Member app. The
// choices live in the existing `settings` key/value table (no migration):
//   app.enabled       '0' turns the whole app off (its pages 404); anything else = on
//   app.tab.<tab>     '0' hides that tab; anything else = shown
// Absent rows read as ON, so a fresh or upgraded installation shows the four
// default tabs. A tab is also hidden whenever the website module it reads from is
// off (Giving is Supabase-only, so the Giving tab never shows on D1).
import type { AppDb } from './appDb';
import type { ModuleKey } from './modules';
import { getSettings } from './settings';

export const APP_TABS = ['home', 'events', 'groups', 'giving'] as const;
export type AppTab = (typeof APP_TABS)[number];

/** The website module each tab reads from; `null` = core content, always available. */
export const APP_TAB_MODULE: Record<AppTab, ModuleKey | null> = {
  home: null,
  events: 'events',
  groups: 'groups',
  giving: 'giving',
};

/** Locale-stripped path of each tab, under /<locale>. */
export const APP_TAB_PATH: Record<AppTab, string> = {
  home: '/app',
  events: '/app/events',
  groups: '/app/groups',
  giving: '/app/give',
};

export const APP_ENABLED_KEY = 'app.enabled';
export const appTabKey = (tab: AppTab): string => `app.tab.${tab}`;
export const APP_SETTING_KEYS: readonly string[] = [APP_ENABLED_KEY, ...APP_TABS.map(appTabKey)];

export interface AppSettings {
  enabled: boolean;
  tabs: Record<AppTab, boolean>;
}

/** Stored rows -> settings. Only the exact string '0' turns something off. Pure. */
export function appSettingsFromRows(rows: Record<string, string>): AppSettings {
  const tabs = Object.fromEntries(APP_TABS.map((tab) => [tab, rows[appTabKey(tab)] !== '0'])) as Record<AppTab, boolean>;
  return { enabled: rows[APP_ENABLED_KEY] !== '0', tabs };
}

export async function getAppSettings(db: AppDb): Promise<AppSettings> {
  return appSettingsFromRows(await getSettings(db, [...APP_SETTING_KEYS]));
}

/** True when the tab's website module is available (always true for Home). */
export function tabModuleAvailable(tab: AppTab, modules: ReadonlySet<string>): boolean {
  const mod = APP_TAB_MODULE[tab];
  return mod === null || modules.has(mod);
}

/**
 * The tabs the app shows, in bottom-bar order: chosen by the admin AND backed by
 * an enabled website module. When nothing is left (every chosen tab's module is
 * off), Home is shown so the app never renders empty. Pure.
 */
export function visibleAppTabs(settings: AppSettings, modules: ReadonlySet<string>): AppTab[] {
  const tabs = APP_TABS.filter((tab) => settings.tabs[tab] && tabModuleAvailable(tab, modules));
  return tabs.length > 0 ? tabs : ['home'];
}

/**
 * Gate for an app page: the visible tabs, or null when the page must 404 (the app
 * is turned off, or `tab` is not one of the visible tabs). A failed settings read
 * falls back to the defaults (everything on) rather than 500ing, like the module
 * gate in the middleware.
 */
export async function resolveAppTabs(
  db: AppDb,
  modules: ReadonlySet<string>,
  tab: AppTab | null,
): Promise<AppTab[] | null> {
  let settings: AppSettings;
  try {
    settings = await getAppSettings(db);
  } catch {
    settings = appSettingsFromRows({});
  }
  if (!settings.enabled) return null;
  const tabs = visibleAppTabs(settings, modules);
  if (tab !== null && !tabs.includes(tab)) return null;
  return tabs;
}

/**
 * The Settings -> Member app form: a checked box posts '1', an unchecked one is
 * absent and written as '0', so every row is written explicitly. At least one tab
 * must stay chosen. Pure.
 */
export function parseAppSettingsForm(
  fd: FormData,
): { ok: true; data: Record<string, string> } | { ok: false; error: 'noTabs' } {
  const data: Record<string, string> = { [APP_ENABLED_KEY]: fd.get(APP_ENABLED_KEY) === '1' ? '1' : '0' };
  for (const tab of APP_TABS) data[appTabKey(tab)] = fd.get(appTabKey(tab)) === '1' ? '1' : '0';
  if (APP_TABS.every((tab) => data[appTabKey(tab)] === '0')) return { ok: false, error: 'noTabs' };
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Web app manifest + service worker. Both are per locale: the app's scope is
// /<locale>/app/, so a member who installs the Chinese app gets a Chinese name,
// start page and offline page.

export const APP_ICONS = [
  { src: '/app-icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/app-icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/app-icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
] as const;

export const APPLE_TOUCH_ICON = '/app-icons/apple-touch-icon.png';

export const appScope = (locale: string): string => `/${locale}/app/`;
export const appOfflinePath = (locale: string): string => `/${locale}/app/offline`;

export interface ManifestInput {
  locale: string;
  /** BCP 47 tag of the locale (manifest `lang`). */
  lang: string;
  name: string;
  description: string;
  themeColor: string;
  backgroundColor: string;
}

/** Shorten a church name for the home-screen label (browsers truncate around 12 chars). */
export function shortAppName(name: string): string {
  const trimmed = name.trim();
  return [...trimmed].length <= 12 ? trimmed : [...trimmed].slice(0, 12).join('').trimEnd();
}

export function buildManifest(input: ManifestInput): Record<string, unknown> {
  const scope = appScope(input.locale);
  return {
    id: scope,
    name: input.name,
    short_name: shortAppName(input.name),
    description: input.description,
    lang: input.lang,
    dir: 'ltr',
    start_url: scope,
    scope,
    display: 'standalone',
    orientation: 'portrait',
    theme_color: input.themeColor,
    background_color: input.backgroundColor,
    icons: APP_ICONS.map((icon) => ({ ...icon })),
  };
}

/** Bump to force every installed app to drop its caches (besides app releases). */
export const SW_REVISION = '1';

/**
 * The service worker source for one locale. Strategy:
 *  - Install: precache the offline page and the icons.
 *  - App pages (navigations inside the scope): network first. A successful
 *    response is cached for offline use unless it is marked `no-store` (the
 *    middleware marks every page rendered for a signed-in person that way), so
 *    personal pages are never written to the device cache. Offline, the last
 *    cached copy is shown, else the offline page.
 *  - Hashed build assets (/_astro/) and the app icons: cache first.
 *  - Everything else (API calls, media, other site pages): straight to network.
 */
export function buildServiceWorker(locale: string, version: string): string {
  const cache = `c4c-app-${locale}-${version}-${SW_REVISION}`;
  const config = JSON.stringify({
    cache,
    prefix: `c4c-app-${locale}-`,
    scope: appScope(locale),
    offline: appOfflinePath(locale),
    precache: [appOfflinePath(locale), ...APP_ICONS.map((i) => i.src), APPLE_TOUCH_ICON],
  });
  return `// Church4Christ member app service worker (generated by src/lib/memberApp.ts).
const C = ${config};
const STATIC = ['/_astro/', '/app-icons/'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(C.cache).then((c) => c.addAll(C.precache)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(C.prefix) && k !== C.cache).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const storable = (res) => res && res.ok && res.type === 'basic' && !/no-store/i.test(res.headers.get('cache-control') || '');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate' && url.pathname.startsWith(C.scope)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (storable(res)) {
            const copy = res.clone();
            caches.open(C.cache).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match(C.offline))),
    );
    return;
  }

  if (STATIC.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(C.cache).then((c) => c.put(req, copy));
        }
        return res;
      })),
    );
  }
});
`;
}
