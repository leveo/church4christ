// Module registry + enablement cache (spec addendum §A). Every non-core
// capability is a MODULE a church can switch off to simplify onboarding; all
// default ON. This file is the pure, tested source of truth: `MODULES` maps each
// key to the locale-stripped route prefixes it owns, plus its nav dictionary keys
// and soft `uses` (degrade-only, no hard deps). `moduleForPath` is the middleware
// choke point's classifier; `getEnabledModules` reads the `module.<key>` settings
// with the same per-isolate 60s cache the theme uses.
import { getSettings } from './settings';

// The 11 module keys, in display order (drives the admin Modules panel + nav).
export const MODULE_KEYS = [
  'bulletins',
  'sermons',
  'prayer-sheets',
  'prayer-wall',
  'events',
  'serve',
  'gifts',
  'testimonies',
  'articles',
  'fellowships',
  'people',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface ModuleDef {
  /** Locale-stripped public route prefixes this module owns. */
  publicPrefixes: string[];
  /** Admin (`/admin/...`) route prefixes this module owns. */
  adminPrefixes: string[];
  /** Public nav dictionary keys hidden when the module is off (consumed in T2). */
  navKeys: string[];
  /** Soft dependencies — degrade-only cross-links, never hard gates. */
  uses: ModuleKey[];
}

// Per-module route ownership. Notes: `/profile` stays CORE (auth surface), so it
// is absent here; `gifts` owns `/serve/gifts` and `testimonies` owns
// `/serve/testimonies`, which win over `serve`'s `/serve` by longest-prefix match;
// `events` also owns `/admin/announcements` (the homepage ticker admin);
// `people` deliberately owns NO route prefixes: its surfaces live inside
// pre-existing CORE routes (`/profile`, `/admin/people`) and its opportunity
// board is under `/serve` (the `serve` module). The People module therefore
// gates only its added panels/sections via `locals.modules.has('people')` in
// those pages (slice 9), never whole routes.
export const MODULES: Record<ModuleKey, ModuleDef> = {
  bulletins: {
    publicPrefixes: ['/bulletin'],
    adminPrefixes: ['/admin/bulletins'],
    navKeys: ['nav.bulletin'],
    uses: [],
  },
  sermons: {
    publicPrefixes: ['/sermons'],
    adminPrefixes: ['/admin/sermons'],
    navKeys: ['nav.sermons'],
    uses: [],
  },
  'prayer-sheets': {
    publicPrefixes: ['/prayer'],
    adminPrefixes: ['/admin/prayer-sheets'],
    navKeys: ['nav.prayer'],
    uses: [],
  },
  'prayer-wall': {
    publicPrefixes: ['/api/prayer-request'],
    adminPrefixes: ['/admin/prayer-wall'],
    navKeys: [],
    uses: [],
  },
  events: {
    publicPrefixes: ['/events'],
    adminPrefixes: ['/admin/events', '/admin/announcements'],
    navKeys: ['nav.events'],
    uses: [],
  },
  serve: {
    publicPrefixes: ['/serve', '/my', '/cal', '/ministries'],
    adminPrefixes: ['/admin/ministries', '/admin/service-types', '/admin/teams', '/admin/reports'],
    navKeys: ['nav.serve', 'nav.ministries', 'nav.opportunities'],
    uses: [],
  },
  gifts: {
    publicPrefixes: ['/serve/gifts'],
    adminPrefixes: [],
    navKeys: [],
    uses: ['serve'],
  },
  testimonies: {
    publicPrefixes: ['/serve/testimonies'],
    adminPrefixes: ['/admin/testimonies'],
    navKeys: [],
    uses: [],
  },
  articles: {
    publicPrefixes: ['/articles'],
    adminPrefixes: [],
    navKeys: ['nav.articles'],
    uses: [],
  },
  fellowships: {
    publicPrefixes: ['/fellowships'],
    adminPrefixes: [],
    navKeys: ['nav.fellowships'],
    uses: [],
  },
  people: {
    publicPrefixes: [],
    adminPrefixes: [],
    navKeys: [],
    uses: ['serve'],
  },
};

// Flattened [prefix, key] pairs, built once. Every prefix a module owns (public
// or admin) points back to its module; `moduleForPath` picks the longest match.
const PREFIX_OWNERS: readonly [string, ModuleKey][] = MODULE_KEYS.flatMap((key) =>
  [...MODULES[key].publicPrefixes, ...MODULES[key].adminPrefixes].map(
    (prefix) => [prefix, key] as [string, ModuleKey],
  ),
);

/** True when `path` equals `prefix` or is a sub-path (`prefix/...`) — segment-aware,
 *  so `/serveware` does NOT match `/serve` and a trailing slash still matches. */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

/**
 * The module that owns a locale-stripped path, or null when the path is core
 * (always-on) or unmatched. Longest matching prefix wins, so `/serve/gifts`
 * resolves to `gifts` even though `/serve` (the `serve` module) also matches.
 * Pure — the middleware feeds it the same `rest` the route policy classifies.
 */
export function moduleForPath(path: string): ModuleKey | null {
  let best: ModuleKey | null = null;
  let bestLen = -1;
  for (const [prefix, key] of PREFIX_OWNERS) {
    if (under(path, prefix) && prefix.length > bestLen) {
      best = key;
      bestLen = prefix.length;
    }
  }
  return best;
}

// Per-isolate cache: reading the module settings on every request would hammer
// D1, and the enabled set changes at most a few times a church's lifetime. The
// admin save clears this (task 2 calls clearModuleCache) so a toggle takes effect
// on the next request in the writing isolate; others catch up within the TTL.
const CACHE_TTL_MS = 60_000;
let cache: { value: Set<ModuleKey>; expiresAt: number } | null = null;

/** Drop the cached enabled set (tests + admin save after a module toggle). */
export function clearModuleCache(): void {
  cache = null;
}

/**
 * The set of enabled modules from the `module.<key>` settings, cached per-isolate
 * for {@link CACHE_TTL_MS}. Absent rows read as enabled (default ON), and any
 * value other than the exact string '0' also counts as enabled — '0' is the only
 * disable. May throw if the DB is unavailable; the middleware guards that to
 * all-enabled so a fresh install never 500s.
 */
export async function getEnabledModules(db: D1Database): Promise<Set<ModuleKey>> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const rows = await getSettings(
    db,
    MODULE_KEYS.map((key) => `module.${key}`),
  );
  const enabled = new Set<ModuleKey>();
  for (const key of MODULE_KEYS) {
    if (rows[`module.${key}`] !== '0') enabled.add(key);
  }
  cache = { value: enabled, expiresAt: now + CACHE_TTL_MS };
  return enabled;
}
