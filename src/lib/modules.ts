// Stable runtime module adapter + enablement cache (spec addendum §A). The
// capability catalog is canonical; this module preserves the existing runtime
// API over its metadata. Every non-core
// capability is a MODULE a church can switch off to simplify onboarding; all
// default ON. `MODULES` maps each
// key to the locale-stripped route prefixes it owns, plus its nav dictionary keys
// and soft `uses` (degrade-only, no hard deps). `moduleForPath` is the middleware
// choke point's classifier; `getEnabledModules` reads the `module.<key>` settings
// with the same per-isolate 60s cache the theme uses.
import type { AppDb } from './appDb';
import {
  CAPABILITIES,
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
  type CapabilityKey,
} from './capabilityCatalog';
import type { DbBackend } from './dbProvider';
import { getSettings } from './settings';

export const MODULE_KEYS = CAPABILITY_KEYS;
export type ModuleKey = CapabilityKey;

const BACKEND_REQUIREMENT_KEYS = {
  d1: 'admin.modules.requiresD1',
  supabase: 'admin.modules.requiresSupabase',
} as const satisfies Record<DbBackend, string>;

export function moduleBackendRequirementKey(backend: DbBackend): string {
  return BACKEND_REQUIREMENT_KEYS[backend];
}

export interface ModuleDef {
  /** Locale-stripped public route prefixes this module owns. */
  publicPrefixes: string[];
  /** Admin (`/admin/...`) route prefixes this module owns. */
  adminPrefixes: string[];
  /** Public nav dictionary keys hidden when the module is off (consumed in T2). */
  navKeys: string[];
  /** Soft dependencies — degrade-only cross-links, never hard gates. */
  uses: ModuleKey[];
  /** Backend requirement: when set, the module is force-disabled on any other
   *  backend (the filter in getEnabledModules wins over its settings row). */
  requiresBackend?: DbBackend;
}

function dbBackend(value: string | undefined): DbBackend | undefined {
  if (value === undefined || value === 'd1' || value === 'supabase') return value;
  throw new Error(`Unsupported database provider in capability catalog: ${value}`);
}

export const MODULES = Object.fromEntries(
  MODULE_KEYS.map((key) => {
    const def = CAPABILITIES[key];
    const requiresBackend = dbBackend(def.requiresBackend);
    return [
      key,
      {
        publicPrefixes: [...def.publicPrefixes],
        adminPrefixes: [...def.adminPrefixes],
        navKeys: [...def.navKeys],
        uses: [...def.uses],
        ...(requiresBackend ? { requiresBackend } : {}),
      },
    ];
  }),
) as Record<ModuleKey, ModuleDef>;

const MODULE_GROUP_CONFIG = [
  { group: 'content', titleKey: 'admin.settings.modulesContentGroup' },
  { group: 'community', titleKey: 'admin.settings.modulesCommunityGroup' },
  { group: 'volunteering', titleKey: 'admin.settings.modulesVolunteeringGroup' },
] as const;

type SupportedModuleGroup = (typeof MODULE_GROUP_CONFIG)[number]['group'];

export interface ModuleGroup {
  group: SupportedModuleGroup;
  titleKey: string;
  keys: ModuleKey[];
}

export function buildModuleGroups(
  keys: readonly ModuleKey[],
  definitions: Record<ModuleKey, { group: string }>,
  declaredGroups: readonly string[],
): ModuleGroup[] {
  const supported = new Set<string>(MODULE_GROUP_CONFIG.map(({ group }) => group));
  const unsupportedDeclared = declaredGroups.filter((group) => !supported.has(group));
  if (unsupportedDeclared.length) {
    throw new Error(`Unsupported capability group(s): ${unsupportedDeclared.join(', ')}`);
  }

  const seen = new Set<ModuleKey>();
  for (const key of keys) {
    if (seen.has(key)) throw new Error(`Duplicate module key in grouping: ${key}`);
    seen.add(key);
    if (!Object.hasOwn(definitions, key)) {
      throw new Error(`Missing capability definition for module grouping: ${key}`);
    }
    if (!supported.has(definitions[key].group)) {
      throw new Error(`Unsupported capability group for ${key}: ${definitions[key].group}`);
    }
  }

  return MODULE_GROUP_CONFIG.map(({ group, titleKey }) => ({
    group,
    titleKey,
    keys: keys.filter((key) => definitions[key].group === group),
  }));
}

export const MODULE_GROUPS = buildModuleGroups(
  MODULE_KEYS,
  CAPABILITIES,
  CAPABILITY_CATALOG.groups,
);

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

/** Shared gate for the global finance operations surface and role assignment. */
export function paymentOperationsEnabled(modules: ReadonlySet<string>): boolean {
  return modules.has('giving') || modules.has('registration');
}

// Per-isolate cache: reading the module settings on every request would hammer
// D1, and the enabled set changes at most a few times a church's lifetime. The
// admin save clears this (task 2 calls clearModuleCache) so a toggle takes effect
// on the next request in the writing isolate; others catch up within the TTL.
const CACHE_TTL_MS = 60_000;
let cache: { value: Set<ModuleKey>; backend: DbBackend; expiresAt: number } | null = null;

/** Drop the cached enabled set (tests + admin save after a module toggle). */
export function clearModuleCache(): void {
  cache = null;
}

/**
 * Drop modules whose `requiresBackend` doesn't match `backend` — the backend gate
 * wins over any settings row, so e.g. `giving`/`registration` (supabase-only) stay
 * off on D1. Pure; shared by {@link getEnabledModules} and the middleware's
 * fail-safe so the two can't drift (a fail-safe that skipped this filter would
 * enable a supabase-only module on D1, and its core routes would hit a
 * nonexistent table).
 */
export function filterByBackend(keys: Iterable<ModuleKey>, backend: DbBackend): Set<ModuleKey> {
  const out = new Set<ModuleKey>();
  for (const key of keys) {
    const req = MODULES[key].requiresBackend;
    if (req && req !== backend) continue;
    out.add(key);
  }
  return out;
}

/**
 * The set of enabled modules from the `module.<key>` settings, cached per-isolate
 * for {@link CACHE_TTL_MS}. Absent rows read as enabled (default ON), and any
 * value other than the exact string '0' also counts as enabled — '0' is the only
 * disable. The backend filter ({@link filterByBackend}) then force-drops any
 * module whose `requiresBackend` doesn't match, so e.g. `giving` stays off on D1
 * even if `module.giving='1'`. The cache key includes `backend`, so a read for a
 * different backend misses rather than serving the wrong set. May throw if the DB
 * is unavailable; the middleware guards that to a backend-filtered all-enabled set
 * so a fresh install never 500s.
 */
export async function getEnabledModules(db: AppDb, backend: DbBackend): Promise<Set<ModuleKey>> {
  const now = Date.now();
  if (cache && cache.backend === backend && cache.expiresAt > now) return cache.value;
  const rows = await getSettings(
    db,
    MODULE_KEYS.map((key) => `module.${key}`),
  );
  const settingsEnabled = MODULE_KEYS.filter((key) => rows[`module.${key}`] !== '0');
  const enabled = filterByBackend(settingsEnabled, backend);
  cache = { value: enabled, backend, expiresAt: now + CACHE_TTL_MS };
  return enabled;
}
