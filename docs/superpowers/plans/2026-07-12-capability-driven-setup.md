# Capability-Driven Setup Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested, idempotent setup system that asks which Church4Christ capabilities to enable, derives D1 or Supabase automatically, generates safe configuration, initializes the selected provider, bootstraps an administrator, and proves readiness before any demo repository is created.

**Architecture:** `config/capabilities.json` is the data source of truth. A shared plain-Node validator serves both a typed runtime adapter and focused setup modules for answers, resolution, planning, rendering, apply, database operations, media, and doctor checks. The existing `MODULE_KEYS`/`MODULES` API and legacy installs remain compatible; only newly initialized installs receive explicit settings for all 16 modules.

**Tech Stack:** Node.js 22 ESM, TypeScript, Astro 7, Cloudflare Workers/Wrangler 4, D1, R2, Hyperdrive, Supabase-compatible PostgreSQL via `postgres`, Vitest node/workers/pg projects, JSON/JSONC, Markdown.

---

## Scope and execution order

This plan implements only project 1 from
`docs/superpowers/specs/2026-07-12-capability-driven-setup-design.md`. Do not create,
inspect, or modify `church4christ-demo`. Durable Stripe event replay and the full demo are
separate projects after every acceptance gate here passes.

Tasks are intentionally sequential. Tasks 1–2 establish the catalog/runtime contract;
Tasks 3–5 create mutation-free planning and file generation; Tasks 6–9 add database,
apply, media, and doctor behavior; Tasks 10–12 wire the CLI, documentation, and clean-room
CI gates.

## File map

### Canonical metadata and runtime adapter

- Create `config/capabilities.json` — all provider, service, preset, and 16 capability data.
- Create `scripts/lib/validate-capability-catalog.mjs` — the only runtime catalog validator.
- Create `src/lib/capabilityCatalog.ts` — typed adapter over the JSON + shared validator.
- Modify `src/lib/modules.ts` — derive registry data while preserving every public export.
- Modify `src/pages/admin/settings/index.astro` — derive admin module groups from catalog.
- Modify `src/lib/dbProvider.ts` — reject unknown `DB_BACKEND` values.

### Setup planning and files

- Create `scripts/setup/args.mjs` — native flag parsing and help.
- Create `scripts/setup/prompts.mjs` — injected interactive questions only.
- Create `scripts/setup/answers.mjs` — merge flags/prompts without secrets in output.
- Create `scripts/setup/resolve-provider.mjs` — hard-dependency expansion and backend choice.
- Create `scripts/setup/plan.mjs` — immutable, secret-free desired action plan.
- Create `scripts/setup/manifest.mjs` — versioned `church.config.json` validation/rendering.
- Create `scripts/setup/render-wrangler.mjs` — deterministic JSONC generation.
- Create `scripts/setup/files.mjs` — atomic write, backup, ownership/refusal rules.
- Create `scripts/setup/import-existing.mjs` — read-only proposal for legacy installations.
- Create `config/wrangler.template.jsonc` — tracked Worker configuration template.

### Database/apply/readiness

- Create `src/lib/setupDb.mjs` and `src/lib/setupDb.d.mts` — provider-neutral module/admin behavior on the structural `AppDb` seam.
- Create `scripts/setup/commands.mjs` — injected `spawn` runner with stdin and redaction.
- Create `scripts/setup/providers/d1.mjs` — D1/R2/Wrangler adapter and resource actions.
- Create `scripts/setup/providers/postgres.mjs` — PostgreSQL/Hyperdrive actions.
- Create `scripts/setup/state.mjs` — atomic gitignored apply-state record.
- Create `scripts/setup/apply.mjs` — ordered, idempotent coordinator.
- Create `scripts/setup/secrets.mjs` — local secret-file and Wrangler-stdin configuration.
- Create `scripts/setup/media.mjs` — shared media manifest/key/target logic.
- Refactor `scripts/db/seed-media-local.mjs` — compatibility wrapper over shared media path.
- Create `scripts/setup/readiness.mjs`, `scripts/setup/doctor.mjs`, and `scripts/setup/checks/*.mjs` — stable readiness model.
- Create `scripts/setup/index.mjs` — thin CLI composition root.

### Tests, docs, and CI

- Create `test/node/setup/*.test.ts` for catalog/resolver/args/plan/files/doctor/CLI purity.
- Create `test/setupDb.test.ts` and `test/pg/setupDb.test.ts` for provider parity.
- Create `test/setup/clean-room-d1.test.ts` and `test/setup/clean-room-pg.test.ts`.
- Create `scripts/docs/generate-capabilities.mjs` and `scripts/docs/check-capabilities.mjs`.
- Modify `README.md`, setup/architecture/module docs, `.dev.vars.example`, `.gitignore`, `package.json`, Vitest configs, and `.github/workflows/ci.yml`.

---

### Task 1: Canonical capability catalog and validation

**Files:**
- Create: `config/capabilities.json`
- Create: `scripts/lib/validate-capability-catalog.mjs`
- Create: `src/lib/capabilityCatalog.ts`
- Create: `test/node/setup/capability-catalog.test.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Register setup tests in the Node Vitest project**

Modify the existing `NODE_ONLY` list in `vitest.config.ts` so Node-only setup tests never
fall into workerd:

```ts
const NODE_ONLY = [
  'test/tokens.test.ts',
  'test/themeMeta.test.ts',
  'test/node/setup/**/*.test.ts',
  'test/setup/clean-room-*.test.ts',
];
```

- [ ] **Step 2: Write the failing catalog contract tests**

Create `test/node/setup/capability-catalog.test.ts` with these concrete assertions:

```ts
import { describe, expect, it } from 'vitest';
import raw from '../../../config/capabilities.json';
import { validateCapabilityCatalog } from '../../../scripts/lib/validate-capability-catalog.mjs';

const KEYS = [
  'bulletins', 'sermons', 'prayer-sheets', 'prayer-wall', 'events', 'serve',
  'gifts', 'testimonies', 'articles', 'fellowships', 'people', 'children',
  'page-builder', 'portal', 'giving', 'registration',
];

describe('capability catalog', () => {
  it('contains the 16 capabilities in stable display order', () => {
    expect(validateCapabilityCatalog(raw).order).toEqual(KEYS);
  });

  it('pins preset membership and provider boundaries', () => {
    const catalog = validateCapabilityCatalog(raw);
    expect(catalog.presets.website.modules).toEqual([
      'bulletins', 'sermons', 'prayer-sheets', 'prayer-wall', 'events',
      'articles', 'fellowships', 'page-builder',
    ]);
    expect(catalog.presets['website-community'].modules).toEqual(KEYS.slice(0, 13));
    expect(catalog.presets['full-church'].modules).toEqual(KEYS);
    expect(KEYS.filter((key) => catalog.capabilities[key].requiresBackend === 'supabase'))
      .toEqual(['portal', 'giving', 'registration']);
  });

  it('permits nested longest-prefix ownership but rejects exact duplicates', () => {
    expect(() => validateCapabilityCatalog(structuredClone(raw))).not.toThrow();
    const bad = structuredClone(raw);
    bad.capabilities.articles.publicPrefixes = ['/sermons'];
    expect(() => validateCapabilityCatalog(bad)).toThrow(/public prefix \/sermons.*sermons.*articles/i);
  });

  it('rejects missing bilingual labels, unknown refs, and hard-dependency cycles', () => {
    const missingZh = structuredClone(raw);
    missingZh.capabilities.sermons.labels.zh = '';
    expect(() => validateCapabilityCatalog(missingZh)).toThrow(/sermons.*labels\.zh/i);

    const unknown = structuredClone(raw);
    unknown.capabilities.gifts.uses = ['missing'];
    expect(() => validateCapabilityCatalog(unknown)).toThrow(/gifts.*unknown.*missing/i);

    const cycle = structuredClone(raw);
    cycle.capabilities.sermons.dependsOn = ['bulletins'];
    cycle.capabilities.bulletins.dependsOn = ['sermons'];
    expect(() => validateCapabilityCatalog(cycle)).toThrow(/dependency cycle/i);
  });
});
```

- [ ] **Step 3: Run the test and verify RED**

Run:

```bash
npx vitest run --project node test/node/setup/capability-catalog.test.ts
```

Expected: FAIL because the catalog and validator modules do not exist.

- [ ] **Step 4: Add the complete catalog data**

Create `config/capabilities.json`. Use this exact preset membership and metadata copied
from the current `MODULES` registry; do not invent partial schemas or make Portal D1-safe:

```json
{
  "schemaVersion": 1,
  "providers": {
    "d1": { "label": "Cloudflare D1", "requiredServices": ["worker", "r2"], "optionalServices": ["email", "cron"] },
    "supabase": { "label": "Supabase Postgres", "requiredServices": ["worker", "r2", "hyperdrive"], "optionalServices": ["email", "cron", "stripe"] }
  },
  "services": ["worker", "r2", "email", "cron", "hyperdrive", "stripe"],
  "groups": ["content", "community", "volunteering"],
  "presets": {
    "website": {
      "labels": { "en": "Website", "zh": "教会网站" },
      "modules": ["bulletins", "sermons", "prayer-sheets", "prayer-wall", "events", "articles", "fellowships", "page-builder"]
    },
    "website-community": {
      "labels": { "en": "Website + Community", "zh": "网站 + 社群管理" },
      "modules": ["bulletins", "sermons", "prayer-sheets", "prayer-wall", "events", "serve", "gifts", "testimonies", "articles", "fellowships", "people", "children", "page-builder"]
    },
    "full-church": {
      "labels": { "en": "Full Church", "zh": "完整教会系统" },
      "modules": ["bulletins", "sermons", "prayer-sheets", "prayer-wall", "events", "serve", "gifts", "testimonies", "articles", "fellowships", "people", "children", "page-builder", "portal", "giving", "registration"]
    }
  },
  "order": ["bulletins", "sermons", "prayer-sheets", "prayer-wall", "events", "serve", "gifts", "testimonies", "articles", "fellowships", "people", "children", "page-builder", "portal", "giving", "registration"],
  "capabilities": {
    "bulletins": { "order": 1, "labels": { "en": "Bulletins", "zh": "周报" }, "descriptions": { "en": "Build and publish weekly service bulletins.", "zh": "建立并发布每周崇拜周报。" }, "group": "content", "publicPrefixes": ["/bulletin"], "adminPrefixes": ["/admin/bulletins"], "navKeys": ["nav.bulletin"], "uses": [], "dependsOn": [], "requiredServices": [], "optionalServices": ["cron"], "seedProfiles": ["demo"], "readinessChecks": [] },
    "sermons": { "order": 2, "labels": { "en": "Sermons", "zh": "讲道" }, "descriptions": { "en": "Publish a searchable sermon archive.", "zh": "发布可搜索的讲道资料库。" }, "group": "content", "publicPrefixes": ["/sermons"], "adminPrefixes": ["/admin/sermons"], "navKeys": ["nav.sermons"], "uses": [], "dependsOn": [], "requiredServices": [], "optionalServices": [], "seedProfiles": ["demo"], "readinessChecks": [] },
    "prayer-sheets": { "order": 3, "labels": { "en": "Prayer Sheets", "zh": "祷告单" }, "descriptions": { "en": "Prepare and publish prayer sheets.", "zh": "预备并发布祷告单。" }, "group": "content", "publicPrefixes": ["/prayer"], "adminPrefixes": ["/admin/prayer-sheets"], "navKeys": ["nav.prayer"], "uses": [], "dependsOn": [], "requiredServices": [], "optionalServices": [], "seedProfiles": ["demo"], "readinessChecks": [] },
    "prayer-wall": { "order": 4, "labels": { "en": "Prayer Wall", "zh": "祷告墙" }, "descriptions": { "en": "Receive and care for prayer requests.", "zh": "接收并关怀祷告事项。" }, "group": "community", "publicPrefixes": ["/api/prayer-request"], "adminPrefixes": ["/admin/prayer-wall"], "navKeys": [], "uses": [], "dependsOn": [], "requiredServices": [], "optionalServices": ["email"], "seedProfiles": ["demo"], "readinessChecks": [] },
    "events": { "order": 5, "labels": { "en": "Events", "zh": "活动" }, "descriptions": { "en": "Publish events and announcements.", "zh": "发布活动与公告。" }, "group": "community", "publicPrefixes": ["/events"], "adminPrefixes": ["/admin/events", "/admin/announcements"], "navKeys": ["nav.events"], "uses": [], "dependsOn": [], "requiredServices": [], "optionalServices": [], "seedProfiles": ["demo"], "readinessChecks": [] },
    "serve": { "order": 6, "labels": { "en": "Volunteer Scheduling", "zh": "服事排班" }, "descriptions": { "en": "Coordinate ministries, teams, plans, and reminders.", "zh": "协调事工、团队、排班与提醒。" }, "group": "volunteering", "publicPrefixes": ["/serve", "/my", "/cal", "/ministries"], "adminPrefixes": ["/admin/ministries", "/admin/service-types", "/admin/teams", "/admin/reports"], "navKeys": ["nav.serve", "nav.ministries", "nav.opportunities"], "uses": [], "dependsOn": [], "requiredServices": [], "optionalServices": ["email", "cron"], "seedProfiles": ["demo"], "readinessChecks": [] },
    "gifts": { "order": 7, "labels": { "en": "Spiritual Gifts", "zh": "恩赐探索" }, "descriptions": { "en": "Help people discover gifts and serving matches.", "zh": "帮助会众探索恩赐与服事配搭。" }, "group": "volunteering", "publicPrefixes": ["/serve/gifts"], "adminPrefixes": [], "navKeys": [], "uses": ["serve"], "dependsOn": [], "requiredServices": [], "optionalServices": [], "seedProfiles": ["demo"], "readinessChecks": [] },
    "testimonies": { "order": 8, "labels": { "en": "Testimonies", "zh": "见证" }, "descriptions": { "en": "Collect and publish serving testimonies.", "zh": "收集并发布服事见证。" }, "group": "volunteering", "publicPrefixes": ["/serve/testimonies"], "adminPrefixes": ["/admin/testimonies"], "navKeys": [], "uses": [], "dependsOn": [], "requiredServices": [], "optionalServices": [], "seedProfiles": ["demo"], "readinessChecks": [] },
    "articles": { "order": 9, "labels": { "en": "Articles", "zh": "文章" }, "descriptions": { "en": "Publish bilingual articles.", "zh": "发布双语文章。" }, "group": "content", "publicPrefixes": ["/articles"], "adminPrefixes": [], "navKeys": ["nav.articles"], "uses": [], "dependsOn": [], "requiredServices": [], "optionalServices": [], "seedProfiles": ["demo"], "readinessChecks": [] },
    "fellowships": { "order": 10, "labels": { "en": "Fellowships", "zh": "团契" }, "descriptions": { "en": "Publish and manage fellowship groups.", "zh": "发布并管理团契小组。" }, "group": "community", "publicPrefixes": ["/fellowships"], "adminPrefixes": ["/admin/fellowships"], "navKeys": ["nav.fellowships"], "uses": [], "dependsOn": [], "requiredServices": [], "optionalServices": [], "seedProfiles": ["demo"], "readinessChecks": [] },
    "people": { "order": 11, "labels": { "en": "People & Households", "zh": "会友与家庭" }, "descriptions": { "en": "Manage people, households, and pastoral notes.", "zh": "管理会友、家庭与牧养记录。" }, "group": "community", "publicPrefixes": [], "adminPrefixes": [], "navKeys": [], "uses": ["serve"], "dependsOn": [], "requiredServices": [], "optionalServices": [], "seedProfiles": ["demo"], "readinessChecks": [] },
    "children": { "order": 12, "labels": { "en": "Children Check-in", "zh": "儿童报到" }, "descriptions": { "en": "Run secure child check-in and attendance.", "zh": "进行安全的儿童报到与出席管理。" }, "group": "community", "publicPrefixes": ["/kiosk"], "adminPrefixes": ["/admin/children"], "navKeys": [], "uses": [], "dependsOn": [], "requiredServices": [], "optionalServices": [], "seedProfiles": ["demo"], "readinessChecks": [] },
    "page-builder": { "order": 13, "labels": { "en": "Page Builder", "zh": "页面编辑器" }, "descriptions": { "en": "Build custom bilingual pages with blocks.", "zh": "使用区块建立自订双语页面。" }, "group": "content", "publicPrefixes": [], "adminPrefixes": ["/admin/pages/builder"], "navKeys": [], "uses": [], "dependsOn": [], "requiredServices": ["r2"], "optionalServices": [], "seedProfiles": ["demo"], "readinessChecks": ["media"] },
    "portal": { "order": 14, "labels": { "en": "Member Portal", "zh": "会友平台" }, "descriptions": { "en": "Give members household, group, calendar, and prayer tools.", "zh": "提供会友家庭、小组、日历与祷告工具。" }, "group": "community", "publicPrefixes": ["/my/household", "/my/groups", "/my/events", "/my/serving", "/my/prayer", "/email-change"], "adminPrefixes": [], "navKeys": [], "uses": ["serve", "fellowships"], "dependsOn": [], "requiresBackend": "supabase", "requiredServices": ["r2"], "optionalServices": ["email"], "seedProfiles": ["demo", "portal"], "readinessChecks": ["media"] },
    "giving": { "order": 15, "labels": { "en": "Giving", "zh": "奉献" }, "descriptions": { "en": "Record gifts and optionally accept Stripe payments.", "zh": "记录奉献并可选择使用 Stripe 收款。" }, "group": "community", "publicPrefixes": ["/give/checkout", "/my/giving", "/api/giving"], "adminPrefixes": ["/admin/giving"], "navKeys": [], "uses": ["people"], "dependsOn": [], "requiresBackend": "supabase", "requiredServices": [], "optionalServices": ["stripe"], "seedProfiles": ["demo", "giving"], "readinessChecks": ["stripe-optional"] },
    "registration": { "order": 16, "labels": { "en": "Registration", "zh": "活动报名" }, "descriptions": { "en": "Run free or paid event registration.", "zh": "管理免费或付费活动报名。" }, "group": "community", "publicPrefixes": ["/register", "/api/register"], "adminPrefixes": ["/admin/registration"], "navKeys": ["nav.register"], "uses": [], "dependsOn": [], "requiresBackend": "supabase", "requiredServices": [], "optionalServices": ["stripe"], "seedProfiles": ["demo", "registration"], "readinessChecks": ["stripe-optional"] }
  }
}
```

- [ ] **Step 5: Implement the one shared validator**

Create `scripts/lib/validate-capability-catalog.mjs`. Export
`validateCapabilityCatalog(input)` and aggregate all errors before throwing. The complete
validator must check object shape, schema version, order/key equality, unique numeric
orders, bilingual nonblank labels/descriptions, group/provider/service refs, preset refs,
soft/hard refs, hard-dependency cycles, slash-prefixed routes, and exact duplicate prefix
ownership. Nested prefixes remain legal.

Use this public shape:

```js
export function validateCapabilityCatalog(input) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!input || typeof input !== 'object') throw new Error('capability catalog must be an object');
  if (input.schemaVersion !== 1) fail('schemaVersion must be 1');
  const capabilities = input.capabilities ?? {};
  const keys = Object.keys(capabilities);
  const known = new Set(keys);
  const services = new Set(input.services ?? []);
  const groups = new Set(input.groups ?? []);
  const providers = new Set(Object.keys(input.providers ?? {}));
  if (new Set(input.order ?? []).size !== (input.order ?? []).length) fail('order contains duplicates');
  if ([...(input.order ?? [])].sort().join('\0') !== [...keys].sort().join('\0')) fail('order must contain every capability exactly once');

  for (const [provider, def] of Object.entries(input.providers ?? {})) {
    for (const service of [...(def.requiredServices ?? []), ...(def.optionalServices ?? [])]) {
      if (!services.has(service)) fail(`provider ${provider} has unknown service ${service}`);
    }
  }

  const exactOwners = new Map();
  for (const key of keys) {
    const def = capabilities[key];
    for (const field of ['en', 'zh']) {
      if (!def.labels?.[field]?.trim()) fail(`${key}.labels.${field} is required`);
      if (!def.descriptions?.[field]?.trim()) fail(`${key}.descriptions.${field} is required`);
    }
    if (!Number.isInteger(def.order) || def.order < 1) fail(`${key}.order must be a positive integer`);
    if (!groups.has(def.group)) fail(`${key} has unknown group ${def.group}`);
    if (def.requiresBackend && !providers.has(def.requiresBackend)) fail(`${key} has unknown provider ${def.requiresBackend}`);
    for (const ref of [...(def.uses ?? []), ...(def.dependsOn ?? [])]) if (!known.has(ref)) fail(`${key} has unknown capability ${ref}`);
    for (const service of [...(def.requiredServices ?? []), ...(def.optionalServices ?? [])]) if (!services.has(service)) fail(`${key} has unknown service ${service}`);
    for (const field of ['publicPrefixes', 'adminPrefixes']) {
      for (const prefix of def[field] ?? []) {
        if (!prefix.startsWith('/')) fail(`${key}.${field} contains invalid prefix ${prefix}`);
        const ownerKey = `${field}:${prefix}`;
        const owner = exactOwners.get(ownerKey);
        if (owner) fail(`${field === 'publicPrefixes' ? 'public' : 'admin'} prefix ${prefix} is owned by ${owner} and ${key}`);
        else exactOwners.set(ownerKey, key);
      }
    }
  }
  const numericOrders = keys.map((key) => capabilities[key].order);
  if (new Set(numericOrders).size !== numericOrders.length) fail('capability numeric order contains duplicates');
  if ((input.order ?? []).some((key, index) => capabilities[key]?.order !== index + 1)) fail('order array and capability numeric order disagree');
  for (const [preset, def] of Object.entries(input.presets ?? {})) {
    for (const field of ['en', 'zh']) if (!def.labels?.[field]?.trim()) fail(`preset ${preset}.labels.${field} is required`);
    if (new Set(def.modules ?? []).size !== (def.modules ?? []).length) fail(`preset ${preset} contains duplicate capabilities`);
    for (const key of def.modules ?? []) if (!known.has(key)) fail(`preset ${preset} has unknown capability ${key}`);
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (key, trail) => {
    if (visiting.has(key)) { fail(`hard dependency cycle: ${[...trail, key].join(' -> ')}`); return; }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const next of capabilities[key].dependsOn ?? []) visit(next, [...trail, key]);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys) visit(key, []);
  if (errors.length) throw new Error(`Invalid capability catalog:\n- ${errors.join('\n- ')}`);
  return input;
}
```

- [ ] **Step 6: Add the typed Astro adapter**

Create `src/lib/capabilityCatalog.ts`:

```ts
import raw from '../../config/capabilities.json';
import { validateCapabilityCatalog } from '../../scripts/lib/validate-capability-catalog.mjs';

export type CapabilityKey = keyof typeof raw.capabilities;
export type ProviderKey = keyof typeof raw.providers;
export type ServiceKey = (typeof raw.services)[number];
export type CapabilityGroup = (typeof raw.groups)[number];

export interface CapabilityDef {
  order: number;
  labels: { en: string; zh: string };
  descriptions: { en: string; zh: string };
  group: CapabilityGroup;
  publicPrefixes: string[];
  adminPrefixes: string[];
  navKeys: string[];
  uses: CapabilityKey[];
  dependsOn: CapabilityKey[];
  requiresBackend?: ProviderKey;
  requiredServices: ServiceKey[];
  optionalServices: ServiceKey[];
  seedProfiles: string[];
  readinessChecks: string[];
}

validateCapabilityCatalog(raw);
export const CAPABILITY_CATALOG = raw;
export const CAPABILITY_KEYS = Object.freeze([...raw.order]) as readonly CapabilityKey[];
export const CAPABILITIES = raw.capabilities as Record<CapabilityKey, CapabilityDef>;
```

Add `scripts/lib/validate-capability-catalog.d.mts` so TypeScript does not treat the shared
validator as `any`:

```ts
export function validateCapabilityCatalog<T>(input: T): T;
```

- [ ] **Step 7: Run GREEN and commit**

Run:

```bash
npx vitest run --project node test/node/setup/capability-catalog.test.ts
npm run check
```

Expected: catalog tests PASS and Astro check reports 0 errors.

Commit:

```bash
git add config/capabilities.json scripts/lib/validate-capability-catalog.mjs scripts/lib/validate-capability-catalog.d.mts src/lib/capabilityCatalog.ts test/node/setup/capability-catalog.test.ts vitest.config.ts
git commit -m "feat(setup): add canonical capability catalog"
```

---

### Task 2: Derive runtime modules and enforce database resolution

**Files:**
- Modify: `src/lib/modules.ts`
- Modify: `src/pages/admin/settings/index.astro`
- Modify: `src/lib/dbProvider.ts`
- Create: `scripts/setup/resolve-provider.mjs`
- Create: `test/node/setup/provider-resolution.test.ts`
- Modify: `test/modules.test.ts`
- Modify: `test/dbProvider.test.ts`

- [ ] **Step 1: Write failing resolver and strict-backend tests**

Create `test/node/setup/provider-resolution.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import raw from '../../../config/capabilities.json';
import { resolveProvider } from '../../../scripts/setup/resolve-provider.mjs';

describe('resolveProvider', () => {
  it('defaults compatible selections to D1 and permits a Supabase override', () => {
    expect(resolveProvider(['sermons', 'people'], undefined, raw).backend).toBe('d1');
    expect(resolveProvider(['sermons'], 'supabase', raw).backend).toBe('supabase');
  });

  it('selects Supabase when any selected capability requires it', () => {
    for (const key of ['portal', 'giving', 'registration']) {
      expect(resolveProvider([key], undefined, raw).backend).toBe('supabase');
    }
  });

  it('rejects D1 before mutation and lists every incompatible capability', () => {
    expect(() => resolveProvider(['portal', 'giving', 'registration'], 'd1', raw))
      .toThrow(/portal, giving, registration.*require Supabase/i);
  });

  it('expands visible hard dependencies but never forces soft uses', () => {
    const catalog = structuredClone(raw);
    catalog.capabilities.registration.dependsOn = ['events'];
    const result = resolveProvider(['registration'], undefined, catalog);
    expect(result.modules).toEqual(['events', 'registration']);
    expect(result.addedDependencies).toEqual([{ capability: 'registration', added: 'events' }]);
    expect(result.modules).not.toContain('people');
  });
});
```

Replace the obsolete `postgres -> d1` assertion in `test/dbProvider.test.ts` with:

```ts
it('rejects every nonempty unknown DB_BACKEND value', () => {
  for (const value of ['postgres', 'D1', ' supabase ', 'sqlite']) {
    expect(() => getBackend({ DB_BACKEND: value })).toThrow(
      new RegExp(`DB_BACKEND.*${value.trim()}.*d1.*supabase`, 'i'),
    );
  }
});
```

Change the stale test name in `test/modules.test.ts` to `has all 16 module keys in display order`.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --project node test/node/setup/provider-resolution.test.ts
npx vitest run --project workers test/dbProvider.test.ts test/modules.test.ts
```

Expected: resolver import fails; strict backend test fails because unknown values still map to D1.

- [ ] **Step 3: Implement the pure provider resolver**

Create `scripts/setup/resolve-provider.mjs`:

```js
import { validateCapabilityCatalog } from '../lib/validate-capability-catalog.mjs';

export function resolveProvider(selectedModules, override, inputCatalog) {
  const catalog = validateCapabilityCatalog(inputCatalog);
  const selected = new Set(selectedModules);
  for (const key of selected) if (!catalog.capabilities[key]) throw new Error(`Unknown capability: ${key}`);
  if (override !== undefined && override !== 'd1' && override !== 'supabase') throw new Error(`Unknown database override: ${override}`);

  const addedDependencies = [];
  const expand = (key) => {
    for (const dependency of catalog.capabilities[key].dependsOn ?? []) {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        addedDependencies.push({ capability: key, added: dependency });
        expand(dependency);
      }
    }
  };
  for (const key of [...selected]) expand(key);
  const modules = catalog.order.filter((key) => selected.has(key));
  const incompatible = modules.filter((key) => catalog.capabilities[key].requiresBackend === 'supabase');
  if (override === 'd1' && incompatible.length) {
    throw new Error(`${incompatible.join(', ')} require Supabase and cannot run on D1`);
  }
  return {
    backend: override ?? (incompatible.length ? 'supabase' : 'd1'),
    modules,
    addedDependencies,
    reasons: incompatible.map((key) => ({ capability: key, requiresBackend: 'supabase' })),
  };
}
```

- [ ] **Step 4: Derive `MODULE_KEYS` and `MODULES` without changing the public API**

In `src/lib/modules.ts`, remove only the hand-written registry data. Import
`CAPABILITY_KEYS`, `CAPABILITIES`, and `CapabilityKey`; retain `PREFIX_OWNERS`, cache,
classification, filtering, and settings logic unchanged:

```ts
import { CAPABILITIES, CAPABILITY_KEYS, type CapabilityKey } from './capabilityCatalog';

export const MODULE_KEYS = CAPABILITY_KEYS;
export type ModuleKey = CapabilityKey;

export interface ModuleDef {
  publicPrefixes: string[];
  adminPrefixes: string[];
  navKeys: string[];
  uses: ModuleKey[];
  requiresBackend?: 'supabase';
}

export const MODULES = Object.fromEntries(
  MODULE_KEYS.map((key) => {
    const def = CAPABILITIES[key];
    return [key, {
      publicPrefixes: [...def.publicPrefixes],
      adminPrefixes: [...def.adminPrefixes],
      navKeys: [...def.navKeys],
      uses: [...def.uses],
      ...(def.requiresBackend ? { requiresBackend: def.requiresBackend as 'supabase' } : {}),
    }];
  }),
) as Record<ModuleKey, ModuleDef>;
```

In `src/pages/admin/settings/index.astro`, replace the separate hard-coded group arrays:

```ts
import { CAPABILITIES } from '../../../lib/capabilityCatalog';

const moduleGroups: { titleKey: string; keys: ModuleKey[] }[] = [
  { titleKey: 'admin.settings.modulesContentGroup', keys: MODULE_KEYS.filter((key) => CAPABILITIES[key].group === 'content') },
  { titleKey: 'admin.settings.modulesCommunityGroup', keys: MODULE_KEYS.filter((key) => CAPABILITIES[key].group === 'community') },
  { titleKey: 'admin.settings.modulesVolunteeringGroup', keys: MODULE_KEYS.filter((key) => CAPABILITIES[key].group === 'volunteering') },
];
```

- [ ] **Step 5: Make runtime backend parsing strict**

Replace `getBackend` in `src/lib/dbProvider.ts`:

```ts
export function getBackend(env: DbEnv): DbBackend {
  const value = env.DB_BACKEND;
  if (value === undefined || value === '') return 'd1';
  if (value === 'd1' || value === 'supabase') return value;
  throw new Error(`Invalid DB_BACKEND=${JSON.stringify(value)}; expected "d1" or "supabase"`);
}
```

Do not trim or case-fold: configuration typos must fail visibly.

- [ ] **Step 6: Run runtime/resolver regression gates and commit**

```bash
npx vitest run --project node test/node/setup/provider-resolution.test.ts
npx vitest run --project workers test/dbProvider.test.ts test/modules.test.ts test/moduleGating.test.ts
npm run check
```

Expected: all selected tests PASS and check reports 0 errors.

Commit:

```bash
git add scripts/setup/resolve-provider.mjs src/lib/modules.ts src/lib/dbProvider.ts src/pages/admin/settings/index.astro test/node/setup/provider-resolution.test.ts test/modules.test.ts test/dbProvider.test.ts
git commit -m "feat(setup): derive modules and resolve database"
```

---

### Task 3: Parse answers and build an immutable setup plan

**Files:**
- Create: `scripts/setup/args.mjs`
- Create: `scripts/setup/answers.mjs`
- Create: `scripts/setup/plan.mjs`
- Create: `test/node/setup/setup-args.test.ts`
- Create: `test/node/setup/setup-plan.test.ts`

- [ ] **Step 1: Write failing argument and plan tests**

Create `test/node/setup/setup-args.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import raw from '../../../config/capabilities.json';
import { parseSetupArgs } from '../../../scripts/setup/args.mjs';

describe('parseSetupArgs', () => {
  it('normalizes a complete noninteractive request', () => {
    expect(parseSetupArgs([
      '--preset', 'website', '--mode', 'local', '--site-slug', 'grace-church',
      '--church-name', 'Grace Church', '--locale', 'en', '--admin-email',
      'Admin@Example.com', '--admin-name', 'Grace Admin', '--demo-data', '--yes', '--dry-run', '--json',
    ], raw)).toMatchObject({
      preset: 'website', mode: 'local', siteSlug: 'grace-church',
      churchName: 'Grace Church', locale: 'en', adminEmail: 'admin@example.com',
      adminName: 'Grace Admin',
      demoData: true, yes: true, dryRun: true, json: true,
    });
  });

  it('rejects conflicting preset/modules and unknown values', () => {
    expect(() => parseSetupArgs(['--preset', 'website', '--modules', 'sermons'], raw)).toThrow(/preset.*modules/i);
    expect(() => parseSetupArgs(['--preset', 'missing'], raw)).toThrow(/unknown preset/i);
    expect(() => parseSetupArgs(['--modules', 'sermons,missing'], raw)).toThrow(/unknown capability.*missing/i);
    expect(() => parseSetupArgs(['--locale', 'fr'], raw)).toThrow(/locale.*en.*zh/i);
  });
});
```

Create `test/node/setup/setup-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import raw from '../../../config/capabilities.json';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';

const base = { mode: 'local', siteSlug: 'grace-church', churchName: 'Grace Church', locale: 'en', adminEmail: 'admin@example.com', adminName: 'Grace Admin', demoData: true };

describe('buildSetupPlan', () => {
  it('turns Website into a D1 plan with all 16 settings explicit', () => {
    const plan = buildSetupPlan({ ...base, preset: 'website' }, raw);
    expect(plan.backend).toBe('d1');
    expect(Object.keys(plan.moduleSettings)).toHaveLength(16);
    expect(plan.moduleSettings['module.sermons']).toBe('1');
    expect(plan.moduleSettings['module.portal']).toBe('0');
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('turns Full Church into Supabase with every module enabled', () => {
    const plan = buildSetupPlan({ ...base, preset: 'full-church' }, raw);
    expect(plan.backend).toBe('supabase');
    expect(new Set(Object.values(plan.moduleSettings))).toEqual(new Set(['1']));
  });

  it('contains no secrets or connection URLs in JSON', () => {
    const plan = buildSetupPlan({ ...base, preset: 'full-church' }, raw);
    const json = JSON.stringify(plan);
    expect(json).not.toMatch(/password|secret|connectionString|databaseUrl|stripeKey/i);
  });

  it('refuses an existing D1 to Supabase switch because content migration is not implemented', () => {
    expect(() => buildSetupPlan({ ...base, modules: ['portal'] }, raw, { existingBackend: 'd1' }))
      .toThrow(/D1-to-Supabase content migration is not implemented/i);
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --project node test/node/setup/setup-args.test.ts test/node/setup/setup-plan.test.ts
```

Expected: FAIL because setup argument and plan modules do not exist.

- [ ] **Step 3: Implement argument parsing with `node:util.parseArgs`**

Create `scripts/setup/args.mjs`. Export `parseSetupArgs(argv, catalog)` and `SETUP_HELP`.
Use these exact options:

```js
import { parseArgs } from 'node:util';

export const SETUP_HELP = `Usage: npm run setup -- [options]
  --mode local|deploy
  --preset website|website-community|full-church
  --modules key,key,...
  --site-slug slug
  --church-name name
  --locale en|zh
  --admin-email email
  --admin-name name
  --app-origin https://church.example
  --email-from serve@church.example
  --backend d1|supabase
  --demo-data
  --yes --dry-run --json --force-config --promote-existing-admin
  --doctor --strict
  --help`;

const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function parseSetupArgs(argv, catalog) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, mode: { type: 'string' }, preset: { type: 'string' },
    modules: { type: 'string' }, 'site-slug': { type: 'string' }, 'church-name': { type: 'string' },
    locale: { type: 'string' }, 'admin-email': { type: 'string' }, 'admin-name': { type: 'string' },
    'app-origin': { type: 'string' }, 'email-from': { type: 'string' }, backend: { type: 'string' },
    'demo-data': { type: 'boolean' }, yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    json: { type: 'boolean' }, 'force-config': { type: 'boolean' },
    'promote-existing-admin': { type: 'boolean' },
    doctor: { type: 'boolean' }, strict: { type: 'boolean' },
  }});
  if (values.preset && values.modules) throw new Error('--preset and --modules cannot be combined');
  if (values.doctor && (values.preset || values.modules || values.mode)) throw new Error('--doctor cannot be combined with setup answers');
  if (values.strict && !values.doctor) throw new Error('--strict requires --doctor');
  if (values.preset && !catalog.presets[values.preset]) throw new Error(`Unknown preset: ${values.preset}`);
  const modules = values.modules?.split(',').map((v) => v.trim()).filter(Boolean);
  for (const key of modules ?? []) if (!catalog.capabilities[key]) throw new Error(`Unknown capability: ${key}`);
  if (values.mode && !['local', 'deploy'].includes(values.mode)) throw new Error('--mode must be local or deploy');
  if (values.locale && !['en', 'zh'].includes(values.locale)) throw new Error('--locale must be en or zh');
  if (values.backend && !['d1', 'supabase'].includes(values.backend)) throw new Error('--backend must be d1 or supabase');
  if (values['admin-email'] && !email.test(values['admin-email'])) throw new Error('--admin-email must be valid');
  if (values['email-from'] && !email.test(values['email-from'])) throw new Error('--email-from must be valid');
  if (values['app-origin']) {
    const origin = new URL(values['app-origin']);
    if (origin.protocol !== 'https:' || origin.origin !== values['app-origin'].replace(/\/$/, '')) throw new Error('--app-origin must be an HTTPS origin without a path');
  }
  if (values['site-slug'] && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values['site-slug'])) throw new Error('--site-slug must be lowercase kebab-case');
  return {
    help: values.help ?? false, mode: values.mode, preset: values.preset, modules,
    siteSlug: values['site-slug'], churchName: values['church-name'], locale: values.locale,
    adminEmail: values['admin-email']?.trim().toLowerCase(), adminName: values['admin-name']?.trim(),
    appOrigin: values['app-origin']?.replace(/\/$/, ''), emailFrom: values['email-from']?.trim().toLowerCase(),
    backendOverride: values.backend,
    demoData: values['demo-data'] ?? false, yes: values.yes ?? false,
    dryRun: values['dry-run'] ?? false, json: values.json ?? false,
    forceConfig: values['force-config'] ?? false,
    promoteExistingAdmin: values['promote-existing-admin'] ?? false,
    doctor: values.doctor ?? false, strict: values.strict ?? false,
  };
}
```

- [ ] **Step 4: Implement answer completion and immutable planning**

Create `scripts/setup/answers.mjs` with a pure `missingAnswers(answers)` returning the
ordered missing fields `mode`, `featureChoice`, `siteSlug`, `churchName`, `locale`,
`adminEmail`, and `adminName`. In deploy mode it additionally requires `appOrigin` and
`emailFrom`. Do not read environment variables or secrets here.

Create `scripts/setup/plan.mjs`:

```js
import { resolveProvider } from './resolve-provider.mjs';

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export function buildSetupPlan(answers, catalog, currentState = {}) {
  const selected = answers.modules ?? catalog.presets[answers.preset]?.modules;
  if (!selected) throw new Error('Choose a preset or custom modules');
  for (const key of ['mode', 'siteSlug', 'churchName', 'locale', 'adminEmail', 'adminName']) {
    if (!answers[key]) throw new Error(`Missing setup answer: ${key}`);
  }
  if (answers.mode === 'deploy' && (!answers.appOrigin || !answers.emailFrom)) throw new Error('Deploy setup requires appOrigin and emailFrom');
  const resolved = resolveProvider(selected, answers.backendOverride, catalog);
  if (currentState.existingBackend && currentState.existingBackend !== resolved.backend) {
    throw new Error(`Existing ${currentState.existingBackend} installation cannot change to ${resolved.backend}: D1-to-Supabase content migration is not implemented`);
  }
  const enabled = new Set(resolved.modules);
  const moduleSettings = Object.fromEntries(catalog.order.map((key) => [`module.${key}`, enabled.has(key) ? '1' : '0']));
  const services = [...new Set([
    ...catalog.providers[resolved.backend].requiredServices,
    ...resolved.modules.flatMap((key) => catalog.capabilities[key].requiredServices),
  ])].sort();
  return deepFreeze({
    planVersion: 1,
    mode: answers.mode,
    site: {
      slug: answers.siteSlug, name: answers.churchName, locale: answers.locale,
      appOrigin: answers.appOrigin ?? 'http://localhost:4321',
      emailFrom: answers.emailFrom ?? `serve@${answers.siteSlug}.invalid`,
    },
    adminEmail: answers.adminEmail,
    adminName: answers.adminName,
    preset: answers.preset ?? null,
    modules: resolved.modules,
    moduleSettings,
    backend: resolved.backend,
    providerReasons: resolved.reasons,
    addedDependencies: resolved.addedDependencies,
    services,
    demoData: Boolean(answers.demoData),
    actions: ['verify-provider', 'ensure-resources', 'write-manifest', 'write-config', 'configure-secrets', 'migrate', ...(answers.demoData ? ['seed', 'seed-media'] : []), 'initialize-modules', 'bootstrap-admin', 'doctor'],
  });
}
```

- [ ] **Step 5: Run GREEN and commit**

```bash
npx vitest run --project node test/node/setup/setup-args.test.ts test/node/setup/setup-plan.test.ts
```

Expected: all tests PASS.

Commit:

```bash
git add scripts/setup/args.mjs scripts/setup/answers.mjs scripts/setup/plan.mjs test/node/setup/setup-args.test.ts test/node/setup/setup-plan.test.ts
git commit -m "feat(setup): build deterministic setup plans"
```

---

### Task 4: Versioned manifest, Wrangler template, and safe file ownership

**Files:**
- Create: `config/wrangler.template.jsonc`
- Create: `scripts/setup/manifest.mjs`
- Create: `scripts/setup/render-wrangler.mjs`
- Create: `scripts/setup/files.mjs`
- Create: `scripts/setup/import-existing.mjs`
- Create: `test/node/setup/setup-files.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing deterministic-render and ownership tests**

Create `test/node/setup/setup-files.test.ts`. Use `mkdtemp`, never the repository root:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import raw from '../../../config/capabilities.json';
import { renderManifest, validateManifest } from '../../../scripts/setup/manifest.mjs';
import { renderWrangler } from '../../../scripts/setup/render-wrangler.mjs';
import { classifyConfig, writeAtomic } from '../../../scripts/setup/files.mjs';

const dirs: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'church-setup-')); dirs.push(dir); return dir; };
afterEach(async () => { const { rm } = await import('node:fs/promises'); await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

const plan = {
  planVersion: 1, mode: 'local', site: { slug: 'grace-church', name: 'Grace Church', locale: 'en', appOrigin: 'http://localhost:4321', emailFrom: 'serve@grace-church.invalid' },
  adminEmail: 'admin@example.com', adminName: 'Grace Admin', preset: 'website', modules: ['sermons'], backend: 'd1', demoData: true,
  resources: { d1DatabaseName: 'grace-church-db', d1DatabaseId: 'local', r2BucketName: 'grace-church-media', hyperdriveId: null },
};

describe('setup files', () => {
  it('renders a deterministic, secret-free versioned manifest', () => {
    const one = renderManifest(plan, raw);
    expect(one).toBe(renderManifest(plan, raw));
    expect(validateManifest(JSON.parse(one), raw)).toMatchObject({ schemaVersion: 1, database: 'd1' });
    expect(one).not.toMatch(/password|secret|connection/i);
  });

  it('renders provider-specific config with no template tokens remaining', async () => {
    const template = await readFile('config/wrangler.template.jsonc', 'utf8');
    const d1 = renderWrangler(template, JSON.parse(renderManifest(plan, raw)));
    expect(d1).toContain('// Generated by Church4Christ setup; edit church.config.json and rerun setup.');
    expect(d1).toContain('"binding": "DB"');
    expect(d1).not.toContain('"hyperdrive"');
    expect(d1).not.toMatch(/@@[A-Z_]+@@/);
  });

  it('classifies generated, known baseline, and unrecognized config separately', async () => {
    const baseline = await readFile('wrangler.jsonc', 'utf8');
    expect(classifyConfig(baseline, baseline)).toBe('baseline');
    expect(classifyConfig('// Generated by Church4Christ setup; edit church.config.json and rerun setup.\n{}', baseline)).toBe('generated');
    expect(classifyConfig('{ "name": "hand-edited" }', baseline)).toBe('unrecognized');
  });

  it('writes atomically and preserves an unrecognized file without force', async () => {
    const dir = await temp();
    const path = join(dir, 'wrangler.jsonc');
    await writeFile(path, 'user config');
    await expect(writeAtomic(path, 'generated', { allowReplace: false })).rejects.toThrow(/refusing to overwrite/i);
    expect(await readFile(path, 'utf8')).toBe('user config');
  });

  it('imports an existing installation as a read-only proposal', async () => {
    const { importExistingInstallation } = await import('../../../scripts/setup/import-existing.mjs');
    const proposal = await importExistingInstallation({
      catalog: raw,
      config: { backend: 'd1', siteSlug: 'existing', appOrigin: 'https://existing.example', emailFrom: 'serve@existing.example', resources: { d1DatabaseName: 'existing-db', d1DatabaseId: 'abc', r2BucketName: 'existing-media', hyperdriveId: null } },
      settings: { 'module.sermons': '0', 'site.name.en': 'Existing Church', 'locale.default': 'en' },
      admins: [{ email: 'owner@example.com', display_name: 'Owner' }],
    });
    expect(proposal.existingBackend).toBe('d1');
    expect(proposal.modules).not.toContain('sermons');
    expect(proposal.modules).toContain('bulletins');
    expect(proposal.adminEmail).toBe('owner@example.com');
    expect(proposal.mutations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --project node test/node/setup/setup-files.test.ts
```

Expected: FAIL because manifest/render/file modules and template do not exist.

- [ ] **Step 3: Add the tracked Wrangler template**

Create `config/wrangler.template.jsonc` from the stable fields in the current
`wrangler.jsonc`. Use only the following controlled tokens and conditional block tokens:
`@@WORKER_NAME@@`, `@@APP_ORIGIN@@`, `@@EMAIL_FROM@@`, `@@DB_BACKEND@@`,
`@@DATABASE_BLOCK@@`, and `@@R2_BUCKET@@`.

```jsonc
// Generated by Church4Christ setup; edit church.config.json and rerun setup.
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "@@WORKER_NAME@@",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./dist", "binding": "ASSETS" },
  "triggers": { "crons": ["0 13 * * *", "0 14 * * 4", "0 9 * * *"] },
  "send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["@@EMAIL_FROM@@"] }],
  "vars": {
    "APP_ORIGIN": "@@APP_ORIGIN@@",
    "EMAIL_FROM": "@@EMAIL_FROM@@",
    "DB_BACKEND": "@@DB_BACKEND@@"
  },
  @@DATABASE_BLOCK@@
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "@@R2_BUCKET@@" }],
  "observability": { "enabled": true }
}
```

For D1, `@@DATABASE_BLOCK@@` renders the full `d1_databases` property with binding `DB`,
name, id, and `migrations_dir`. For Supabase it renders the full `hyperdrive` property with
binding `HYPERDRIVE` and id. Each rendered block ends in a comma.

- [ ] **Step 4: Implement manifest validation and deterministic rendering**

Create `scripts/setup/manifest.mjs`:

```js
export function validateManifest(value, catalog) {
  const moduleSet = new Set(catalog.order);
  if (!value || value.schemaVersion !== 1) throw new Error('church.config.json schemaVersion must be 1');
  if (!['local', 'deploy'].includes(value.mode)) throw new Error('manifest mode must be local or deploy');
  if (!['d1', 'supabase'].includes(value.database)) throw new Error('manifest database must be d1 or supabase');
  if (!Array.isArray(value.modules) || value.modules.some((key) => !moduleSet.has(key))) throw new Error('manifest contains an unknown module');
  if (!['en', 'zh'].includes(value.site?.locale)) throw new Error('manifest site.locale must be en or zh');
  if (!/^https?:\/\//.test(value.site?.appOrigin ?? '')) throw new Error('manifest site.appOrigin is invalid');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.site?.emailFrom ?? '')) throw new Error('manifest site.emailFrom is invalid');
  return value;
}

export function manifestFromPlan(plan, catalog) {
  return validateManifest({
    schemaVersion: 1,
    mode: plan.mode,
    site: { slug: plan.site.slug, name: plan.site.name, locale: plan.site.locale, appOrigin: plan.site.appOrigin, emailFrom: plan.site.emailFrom },
    preset: plan.preset,
    modules: [...plan.modules],
    database: plan.backend,
    demoData: plan.demoData,
    resources: plan.resources ?? {
      d1DatabaseName: `${plan.site.slug}-db`, d1DatabaseId: plan.mode === 'local' ? 'local' : null,
      r2BucketName: `${plan.site.slug}-media`, hyperdriveId: null,
    },
  }, catalog);
}

export function renderManifest(plan, catalog) {
  return `${JSON.stringify(manifestFromPlan(plan, catalog), null, 2)}\n`;
}
```

- [ ] **Step 5: Implement strict Wrangler rendering**

Create `scripts/setup/render-wrangler.mjs`:

```js
const quote = (value) => JSON.stringify(String(value));
export function renderWrangler(template, manifest) {
  if (manifest.mode === 'deploy' && manifest.database === 'd1' && !manifest.resources.d1DatabaseId) throw new Error('deploy D1 config requires a database id');
  if (manifest.mode === 'deploy' && manifest.database === 'supabase' && !manifest.resources.hyperdriveId) throw new Error('deploy Supabase config requires a Hyperdrive id');
  const appOrigin = manifest.site.appOrigin;
  const emailFrom = manifest.site.emailFrom;
  const databaseBlock = manifest.database === 'd1'
    ? `"d1_databases": [{ "binding": "DB", "database_name": ${quote(manifest.resources.d1DatabaseName)}, "database_id": ${quote(manifest.resources.d1DatabaseId)}, "migrations_dir": "migrations" }],`
    : `"hyperdrive": [{ "binding": "HYPERDRIVE", "id": ${quote(manifest.resources.hyperdriveId)} }],`;
  const replacements = {
    WORKER_NAME: manifest.site.slug,
    APP_ORIGIN: appOrigin,
    EMAIL_FROM: emailFrom,
    DB_BACKEND: manifest.database,
    DATABASE_BLOCK: databaseBlock,
    R2_BUCKET: manifest.resources.r2BucketName,
  };
  let output = template;
  for (const [token, value] of Object.entries(replacements)) {
    const marker = `@@${token}@@`;
    if (output.split(marker).length !== 2) throw new Error(`template must contain ${marker} exactly once`);
    output = output.replace(marker, value);
  }
  const leftover = output.match(/@@[A-Z_]+@@/g);
  if (leftover) throw new Error(`unresolved template tokens: ${leftover.join(', ')}`);
  return output.endsWith('\n') ? output : `${output}\n`;
}
```

- [ ] **Step 6: Implement atomic writes, backups, and refusal**

Create `scripts/setup/files.mjs` using `open(..., 'wx')`, `rename`, and `copyFile`. Export:

```js
import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const GENERATED_MARKER = '// Generated by Church4Christ setup; edit church.config.json and rerun setup.';

export function classifyConfig(content, knownBaseline) {
  if (content.startsWith(GENERATED_MARKER)) return 'generated';
  if (content === knownBaseline) return 'baseline';
  return 'unrecognized';
}

export async function writeAtomic(path, content, { allowReplace, backup = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  let existing = null;
  try { existing = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing === content) return { changed: false, backupPath: null };
  if (existing !== null && !allowReplace) throw new Error(`Refusing to overwrite unrecognized file: ${path}`);
  let backupPath = null;
  if (existing !== null && backup) {
    backupPath = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await copyFile(path, backupPath);
  }
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
  try { await rename(temp, path); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  return { changed: true, backupPath };
}
```

Add `.church/` to `.gitignore`. Keep `church.config.json` tracked and `.dev.vars` ignored.
The apply file step uses `classifyConfig` exactly as follows: known repository baseline may
be replaced without a backup; recognized generated config may be replaced only after
showing its diff and always with `backup: true`; unrecognized config is refused unless
interactive confirmation or noninteractive `--force-config` is present, and a forced
replacement always uses `backup: true`. `church.config.json` follows the same generated-
ownership rule using its schema/version rather than a comment marker.

- [ ] **Step 7: Implement read-only import for existing installations**

Create `scripts/setup/import-existing.mjs`. It accepts already-read config, settings, and
active-admin rows so the pure function cannot mutate. It derives the current backend and
resource identifiers, treats an absent `module.<key>` row with the legacy enabled default,
uses an exact `'0'` as disabled, and returns normalized setup answers plus
`existingBackend`. If zero or multiple active admins exist, leave admin identity missing
so the questionnaire asks; never guess. Always return `mutations: []`.

The CLI invokes provider-specific read-only inspection only when `church.config.json` is
absent and the current Wrangler config is not the known repository placeholder. It shows
the complete proposed manifest/settings diff and requires confirmation before planning
writes. If the new feature selection resolves to a different backend, Task 3's current-
state guard stops with the explicit unsupported migration message.

- [ ] **Step 8: Run GREEN and commit**

```bash
npx vitest run --project node test/node/setup/setup-files.test.ts
git diff --check
```

Expected: PASS; no whitespace errors.

Commit:

```bash
git add config/wrangler.template.jsonc scripts/setup/manifest.mjs scripts/setup/render-wrangler.mjs scripts/setup/files.mjs scripts/setup/import-existing.mjs test/node/setup/setup-files.test.ts .gitignore
git commit -m "feat(setup): render safe installation config"
```

---

### Task 5: Provider-neutral module initialization and first-admin bootstrap

**Files:**
- Create: `src/lib/setupDb.mjs`
- Create: `src/lib/setupDb.d.mts`
- Create: `test/setupDb.test.ts`
- Create: `test/pg/setupDb.test.ts`

- [ ] **Step 1: Write D1 tests first**

Create `test/setupDb.test.ts` in the workers project:

```ts
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { MODULE_KEYS } from '../src/lib/modules';
import { bootstrapFirstAdmin, initializeModuleSettings } from '../src/lib/setupDb.mjs';

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'module.%'").run();
  await env.DB.prepare("DELETE FROM people WHERE email LIKE '%@setup.test'").run();
});

describe('setup database operations on D1', () => {
  it('writes every module setting explicitly in one statement', async () => {
    await initializeModuleSettings(env.DB, MODULE_KEYS, ['sermons', 'people']);
    const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'module.%' ORDER BY key").all<{ key: string; value: string }>();
    expect(results).toHaveLength(16);
    expect(Object.fromEntries(results.map((row) => [row.key, row.value]))).toMatchObject({ 'module.sermons': '1', 'module.people': '1', 'module.portal': '0' });
  });

  it('creates and reruns the same administrator idempotently', async () => {
    const input = { email: ' Admin@Setup.Test ', displayName: 'Setup Admin', locale: 'en' };
    expect(await bootstrapFirstAdmin(env.DB, input)).toEqual({ status: 'created', email: 'admin@setup.test' });
    expect(await bootstrapFirstAdmin(env.DB, input)).toEqual({ status: 'already-admin', email: 'admin@setup.test' });
  });

  it('requires explicit promotion and refuses inactive or deleted people', async () => {
    await env.DB.prepare("INSERT INTO people (display_name,email,role,active) VALUES ('Member','member@setup.test','member',1),('Inactive','inactive@setup.test','member',0),('Deleted','deleted@setup.test','member',1)").run();
    await env.DB.prepare("UPDATE people SET deleted_at=datetime('now') WHERE email='deleted@setup.test'").run();
    await expect(bootstrapFirstAdmin(env.DB, { email: 'member@setup.test', displayName: 'Member', locale: 'en' })).resolves.toMatchObject({ status: 'promotion-required' });
    await expect(bootstrapFirstAdmin(env.DB, { email: 'member@setup.test', displayName: 'Member', locale: 'en', promoteExisting: true })).resolves.toMatchObject({ status: 'promoted' });
    await expect(bootstrapFirstAdmin(env.DB, { email: 'inactive@setup.test', displayName: 'Inactive', locale: 'en' })).resolves.toMatchObject({ status: 'inactive' });
    await expect(bootstrapFirstAdmin(env.DB, { email: 'deleted@setup.test', displayName: 'Deleted', locale: 'en' })).resolves.toMatchObject({ status: 'reactivation-required' });
  });

  it('rejects invalid email and locale before querying', async () => {
    await expect(bootstrapFirstAdmin(env.DB, { email: 'bad', displayName: 'Admin', locale: 'en' })).rejects.toThrow(/email/i);
    await expect(bootstrapFirstAdmin(env.DB, { email: 'a@setup.test', displayName: 'Admin', locale: 'fr' })).rejects.toThrow(/locale/i);
  });
});
```

- [ ] **Step 2: Write the equivalent Postgres parity test**

Create `test/pg/setupDb.test.ts`. Follow `test/pg/parity.test.ts`: reset schema, run
`scripts/db/migrate-supabase.mjs`, construct `PgAdapter`, execute the same four behavior
cases, and close the client. Do not mock SQL or mark provider differences as acceptable.

- [ ] **Step 3: Run RED on D1**

```bash
npx vitest run --project workers test/setupDb.test.ts
```

Expected: FAIL because `src/lib/setupDb.mjs` does not exist.

- [ ] **Step 4: Implement the portable setup operations**

Create `src/lib/setupDb.mjs`. Keep it Node/Worker-compatible: no filesystem, process,
Wrangler, or postgres imports.

```js
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uniqueViolation = (error) => String(error).includes('UNIQUE constraint failed') || error?.code === '23505' || String(error).includes('duplicate key value');

export async function initializeModuleSettings(db, moduleKeys, selectedModules) {
  const enabled = new Set(selectedModules);
  const rows = moduleKeys.map((key) => [`module.${key}`, enabled.has(key) ? '1' : '0']);
  const groups = rows.map(() => '(?, ?)').join(', ');
  await db.prepare(`INSERT INTO settings (key, value) VALUES ${groups} ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(...rows.flat()).run();
}

export async function bootstrapFirstAdmin(db, input) {
  const email = String(input.email ?? '').trim().toLowerCase();
  const displayName = String(input.displayName ?? '').trim();
  if (!EMAIL.test(email)) throw new Error('first administrator email is invalid');
  if (!displayName) throw new Error('first administrator display name is required');
  if (input.locale !== 'en' && input.locale !== 'zh') throw new Error('first administrator locale must be en or zh');

  const find = () => db.prepare('SELECT id, role, active, deleted_at FROM people WHERE lower(email)=?').bind(email).first();
  const existing = await find();
  if (existing) {
    if (existing.deleted_at) return { status: 'reactivation-required', email };
    if (!existing.active) return { status: 'inactive', email };
    if (existing.role === 'admin') return { status: 'already-admin', email };
    if (!input.promoteExisting) return { status: 'promotion-required', email };
    const result = await db.prepare("UPDATE people SET role='admin', updated_at=datetime('now') WHERE id=? AND active=1 AND deleted_at IS NULL AND role<>'admin'").bind(existing.id).run();
    const current = await find();
    if (current?.role !== 'admin') throw new Error('administrator promotion lost a concurrent update');
    return { status: result.meta.changes > 0 ? 'promoted' : 'already-admin', email };
  }
  try {
    await db.prepare("INSERT INTO people (display_name,email,role,active,lang) VALUES (?,?,'admin',1,?)")
      .bind(displayName, email, input.locale).run();
    return { status: 'created', email };
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
    const raced = await find();
    if (raced?.role === 'admin' && raced.active && !raced.deleted_at) return { status: 'already-admin', email };
    return { status: raced?.deleted_at ? 'reactivation-required' : raced?.active ? 'promotion-required' : 'inactive', email };
  }
}
```

The Postgres migration defines the compatibility `datetime()` function used by existing
portable queries; keep the conditional update dialect-neutral.

Create `src/lib/setupDb.d.mts`:

```ts
import type { AppDb } from './appDb';
import type { ModuleKey } from './modules';

export function initializeModuleSettings(db: AppDb, moduleKeys: readonly ModuleKey[], selectedModules: readonly ModuleKey[]): Promise<void>;
export type BootstrapStatus = 'created' | 'already-admin' | 'promotion-required' | 'promoted' | 'inactive' | 'reactivation-required';
export function bootstrapFirstAdmin(db: AppDb, input: { email: string; displayName: string; locale: 'en' | 'zh'; promoteExisting?: boolean }): Promise<{ status: BootstrapStatus; email: string }>;
```

- [ ] **Step 5: Run D1 and Postgres GREEN**

```bash
npx vitest run --project workers test/setupDb.test.ts
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run --project pg test/pg/setupDb.test.ts
```

Expected: D1 PASS. With local Postgres available, PG PASS with zero skips; without it,
record the local skip and rely on the mandatory CI service in Task 12 before completion.

- [ ] **Step 6: Commit**

```bash
git add src/lib/setupDb.mjs src/lib/setupDb.d.mts test/setupDb.test.ts test/pg/setupDb.test.ts
git commit -m "feat(setup): initialize modules and first admin"
```

---

### Task 6: Safe command runner and provider adapters

**Files:**
- Create: `scripts/setup/commands.mjs`
- Create: `scripts/setup/sql.mjs`
- Create: `scripts/setup/providers/d1.mjs`
- Create: `scripts/setup/providers/postgres.mjs`
- Create: `test/node/setup/setup-providers.test.ts`

- [ ] **Step 1: Write failing command/redaction/D1 adapter tests**

Create `test/node/setup/setup-providers.test.ts` with an injected fake runner:

```ts
import { describe, expect, it } from 'vitest';
import { createCommandRunner } from '../../../scripts/setup/commands.mjs';
import { renderAnonymousBinds } from '../../../scripts/setup/sql.mjs';
import { D1CliDb } from '../../../scripts/setup/providers/d1.mjs';

describe('setup provider safety', () => {
  it('replaces binds only in SQL code and escapes literals', () => {
    expect(renderAnonymousBinds("SELECT '?' AS q, email FROM people WHERE email=? -- ?\n", ["o'hara@example.com"]))
      .toBe("SELECT '?' AS q, email FROM people WHERE email='o''hara@example.com' -- ?\n");
    expect(() => renderAnonymousBinds('SELECT ?', [])).toThrow(/bind count/i);
    expect(() => renderAnonymousBinds('SELECT 1', ['extra'])).toThrow(/bind count/i);
  });

  it('redacts tagged args and never invokes a shell', async () => {
    const calls: unknown[] = [];
    const runner = createCommandRunner({ exec: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    }});
    const result = await runner.run('wrangler', ['hyperdrive', 'create', 'x', '--connection-string', 'postgres://secret'], { secretArgIndexes: [4] });
    expect(result.displayCommand).toContain('[REDACTED]');
    expect(result.displayCommand).not.toContain('postgres://secret');
    expect(calls[0]).toMatchObject({ options: { shell: false } });
  });

  it('adapts Wrangler D1 JSON to the AppDb statement contract', async () => {
    const calls: string[][] = [];
    const runner = { run: async (_file, args) => {
      calls.push(args);
      return { stdout: JSON.stringify([{ results: [{ id: 7 }], success: true, meta: { changes: 1 } }]), stderr: '', exitCode: 0 };
    }};
    const db = new D1CliDb({ runner, wranglerBin: 'wrangler', configPath: 'wrangler.jsonc', mode: 'local' });
    expect(await db.prepare('SELECT id FROM people WHERE email=?').bind('a@example.com').first()).toEqual({ id: 7 });
    expect(calls[0]).toContain("SELECT id FROM people WHERE email='a@example.com'");
    expect(calls[0]).toContain('--local');
    expect(calls[0]).toContain('--json');
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --project node test/node/setup/setup-providers.test.ts
```

Expected: FAIL because command, SQL, and provider modules do not exist.

- [ ] **Step 3: Implement the shell-free command runner**

Create `scripts/setup/commands.mjs` around `node:child_process.spawn` so production secrets
can reach Wrangler over stdin without appearing in the command line:

```js
import { spawn } from 'node:child_process';

const defaultExec = (file, args, options) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { cwd: options.cwd, env: options.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  child.stdin.end(options.input ?? '');
});

const redactText = (text, secrets) => secrets.reduce((out, secret) => secret && secret.length >= 8 ? out.replaceAll(secret, '[REDACTED]') : out, text);

export function createCommandRunner({ exec = defaultExec } = {}) {
  return {
    async run(file, args, { cwd = process.cwd(), env = process.env, input, secretArgIndexes = [] } = {}) {
      const redacted = args.map((arg, index) => secretArgIndexes.includes(index) ? '[REDACTED]' : arg);
      const result = await exec(file, args, { cwd, env, input, shell: false });
      const displayCommand = [file, ...redacted].map((part) => JSON.stringify(part)).join(' ');
      const secrets = [...secretArgIndexes.map((index) => args[index]), input].filter(Boolean);
      const safe = { stdout: redactText(result.stdout, secrets), stderr: redactText(result.stderr, secrets), exitCode: result.exitCode, displayCommand };
      if (safe.exitCode !== 0) throw new Error(`${displayCommand} failed (${safe.exitCode}): ${safe.stderr}`);
      return safe;
    },
  };
}
```

Do not include `input`, environment values, or unredacted args in thrown errors or JSON
results. Add a regression test with a secret echoed on stderr and redact exact provided
secret values before constructing the error.

- [ ] **Step 4: Implement a tested anonymous-placeholder scanner**

Create `scripts/setup/sql.mjs`. Track `code`, single quote, double quote, line comment, and
block comment states exactly as `src/lib/pgAdapter.ts` does. Export:

```js
export function sqlLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('non-finite SQL number'); return String(value); }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value !== 'string') throw new Error(`unsupported SQL bind type: ${typeof value}`);
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderAnonymousBinds(sql, params, replacement = sqlLiteral) {
  let out = '', index = 0, mode = 'code';
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i], next = sql[i + 1];
    if (mode === 'code') {
      if (char === "'") mode = 'single';
      else if (char === '"') mode = 'double';
      else if (char === '-' && next === '-') { mode = 'line'; out += char + next; i += 1; continue; }
      else if (char === '/' && next === '*') { mode = 'block'; out += char + next; i += 1; continue; }
      else if (char === '?') {
        if (index >= params.length) throw new Error('SQL bind count is smaller than placeholder count');
        out += replacement(params[index], index + 1); index += 1; continue;
      }
    } else if (mode === 'single' && char === "'") {
      if (next === "'") { out += char + next; i += 1; continue; }
      mode = 'code';
    } else if (mode === 'double' && char === '"') mode = 'code';
    else if (mode === 'line' && char === '\n') mode = 'code';
    else if (mode === 'block' && char === '*' && next === '/') { out += char + next; i += 1; mode = 'code'; continue; }
    out += char;
  }
  if (index !== params.length) throw new Error('SQL bind count is larger than placeholder count');
  return out;
}
```

- [ ] **Step 5: Implement `D1CliDb`**

Create `scripts/setup/providers/d1.mjs`. Its statement object stores SQL/params immutably;
`first`, `all`, and `run` call Wrangler with argument arrays:

```js
import { renderAnonymousBinds } from '../sql.mjs';

const normalize = (stdout) => {
  const parsed = JSON.parse(stdout);
  const result = Array.isArray(parsed) ? parsed.at(-1) : parsed;
  if (!result?.success) throw new Error('Wrangler D1 returned an unsuccessful result');
  return { results: result.results ?? [], meta: result.meta ?? { changes: 0 }, success: true };
};

class D1Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...values) { return new D1Statement(this.db, this.sql, values); }
  async all() { return this.db.execute(renderAnonymousBinds(this.sql, this.params)); }
  async first(column) { const row = (await this.all()).results[0] ?? null; return row && column ? row[column] ?? null : row; }
  async run() { return this.all(); }
}

export class D1CliDb {
  constructor({ runner, wranglerBin, configPath, mode, persistTo }) { Object.assign(this, { runner, wranglerBin, configPath, mode, persistTo }); }
  prepare(sql) { return new D1Statement(this, sql); }
  async batch(statements) { const out = []; for (const statement of statements) out.push(await statement.run()); return out; }
  async execute(sql) {
    const scope = this.mode === 'deploy' ? '--remote' : '--local';
    const args = ['d1', 'execute', 'DB', scope, '--command', sql, '--json', '--yes', '--config', this.configPath];
    if (this.persistTo && this.mode === 'local') args.push('--persist-to', this.persistTo);
    return normalize((await this.runner.run(this.wranglerBin, args)).stdout);
  }
}
```

Add focused helpers in the same file for `wrangler d1 list --json`, `d1 create`,
`r2 bucket list --json`, and `r2 bucket create`. Always list before create and list again
after create; select an exact resource name and never parse a resource id from human prose.

- [ ] **Step 6: Implement the Postgres AppDb adapter and provider resource helpers**

Create `scripts/setup/providers/postgres.mjs`. Use `postgres` with `max: 1`,
`prepare: false`, and the same int8 number mapping as `src/lib/dbProvider.ts`. Translate
anonymous placeholders through `renderAnonymousBinds(sql, params, (_, n) => '$' + n)` and
call `sql.unsafe(translated, params)`. Export `openPostgresSetupDb(url)` returning
`{ db, close }`.

Also export Hyperdrive helpers that list exact names before create. A connection URL passed
to `wrangler hyperdrive create ... --connection-string <url>` must mark its argument index
secret so logs and JSON are redacted. Never store the URL in the plan, manifest, state, or
generated config.

- [ ] **Step 7: Run GREEN and commit**

```bash
npx vitest run --project node test/node/setup/setup-providers.test.ts
npm run check
```

Expected: PASS and 0 type errors.

Commit:

```bash
git add scripts/setup/commands.mjs scripts/setup/sql.mjs scripts/setup/providers/d1.mjs scripts/setup/providers/postgres.mjs test/node/setup/setup-providers.test.ts
git commit -m "feat(setup): add safe database provider adapters"
```

---

### Task 7: Provider-neutral media seeding and idempotent apply coordinator

**Files:**
- Create: `scripts/setup/media.mjs`
- Create: `scripts/setup/state.mjs`
- Create: `scripts/setup/apply.mjs`
- Create: `scripts/setup/secrets.mjs`
- Modify: `scripts/db/seed-media-local.mjs`
- Create: `test/node/setup/setup-apply.test.ts`
- Create: `test/node/setup/setup-media.test.ts`

- [ ] **Step 1: Write failing media and apply-order tests**

In `test/node/setup/setup-media.test.ts`, assert that every file in
`seed/media/manifest.json` recomputes its declared content-addressed key, and that D1 and
Postgres fake AppDb instances receive identical parameterized media/target writes.

In `test/node/setup/setup-apply.test.ts`, use injected step functions and a temporary state
path:

```ts
import { describe, expect, it } from 'vitest';
import { applySetup } from '../../../scripts/setup/apply.mjs';

it('applies steps in contract order and reruns completed steps as verified no-ops', async () => {
  const calls: string[] = [];
  const steps = Object.fromEntries([
    'verify-provider', 'ensure-resources', 'write-manifest', 'write-config', 'configure-secrets', 'migrate', 'seed', 'seed-media',
    'initialize-modules', 'bootstrap-admin', 'doctor',
  ].map((name) => [name, { apply: async () => { calls.push(name); return { changed: true }; }, verify: async () => true }]));
  const stateStore = { completed: new Set<string>(), async has(name) { return this.completed.has(name); }, async mark(name) { this.completed.add(name); } };
  await applySetup({ actions: Object.keys(steps) }, { steps, stateStore, dryRun: false });
  expect(calls).toEqual(Object.keys(steps));
  calls.length = 0;
  await applySetup({ actions: Object.keys(steps) }, { steps, stateStore, dryRun: false });
  expect(calls).toEqual([]);
});

it('dry-run calls no step and writes no state', async () => {
  let called = false;
  await applySetup({ actions: ['migrate'] }, { steps: { migrate: { apply: async () => { called = true; }, verify: async () => true } }, stateStore: { async has() { return false; }, async mark() { throw new Error('mutation'); } }, dryRun: true });
  expect(called).toBe(false);
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --project node test/node/setup/setup-media.test.ts test/node/setup/setup-apply.test.ts
```

Expected: FAIL because shared media/apply/state modules do not exist.

- [ ] **Step 3: Extract media logic without changing the compatibility command**

Move `sanitizeFilename`, `uploadKey`, manifest validation, and target mapping from
`scripts/db/seed-media-local.mjs` into `scripts/setup/media.mjs`. Export:

```js
export function loadMediaPlan({ root, manifestPath = 'seed/media/manifest.json' })
export async function applyMediaPlan({ mediaPlan, db, uploadObject })
```

`applyMediaPlan` must use bound statements for `media`, settings, event, ministry, and
person updates. `uploadObject` receives `{ key, filePath, contentType }`; the D1 and
Supabase paths both upload to the configured R2 bucket, while their supplied AppDb writes
metadata to the selected database.

Rewrite `scripts/db/seed-media-local.mjs` as a thin wrapper that opens `D1CliDb`, supplies
the current local R2 `wrangler r2 object put` uploader, and calls the shared functions.
Preserve its existing `--dry-run`, `MEDIA_BUCKET`, `WRANGLER_BIN`, and
`WRANGLER_PERSIST_TO` contracts.

- [ ] **Step 4: Implement atomic state and the apply coordinator**

Create `scripts/setup/state.mjs` with a schema-versioned JSON file:

```js
export function createStateStore(path, { readJson, writeJsonAtomic }) {
  let state = { schemaVersion: 1, planFingerprint: null, completed: {} };
  return {
    async load(fingerprint) {
      state = await readJson(path).catch((error) => error.code === 'ENOENT' ? state : Promise.reject(error));
      if (state.planFingerprint && state.planFingerprint !== fingerprint) state.completed = {};
      state.planFingerprint = fingerprint;
    },
    async has(name) { return Boolean(state.completed[name]); },
    async mark(name, evidence) { state.completed[name] = { at: new Date().toISOString(), evidence }; await writeJsonAtomic(path, state); },
  };
}
```

Create `scripts/setup/apply.mjs`:

```js
const ORDER = ['verify-provider', 'ensure-resources', 'write-manifest', 'write-config', 'configure-secrets', 'migrate', 'seed', 'seed-media', 'initialize-modules', 'bootstrap-admin', 'doctor'];
export async function applySetup(plan, { steps, stateStore, dryRun }) {
  const actions = ORDER.filter((name) => plan.actions.includes(name));
  if (dryRun) return { status: 'dry-run', actions, results: [] };
  const results = [];
  for (const name of actions) {
    if (await stateStore.has(name) && await steps[name].verify()) {
      results.push({ step: name, status: 'already-complete' });
      continue;
    }
    const result = await steps[name].apply();
    const verified = await steps[name].verify();
    if (!verified) throw new Error(`Setup step ${name} did not verify after apply`);
    await stateStore.mark(name, result.evidence ?? null);
    results.push({ step: name, status: result.changed ? 'changed' : 'verified' });
  }
  return { status: 'applied', actions, results };
}
```

Adjust the test fixture to provide `{ apply, verify }` per step; a state record is never
trusted without verification of actual file/resource/database state.

For deploy mode, identifiers do not exist until resource creation. The plan/confirmation
describes all desired file bytes before mutation, but apply must verify authentication,
create or reuse exact named resources, put their identifiers into the manifest, and only
then render the final placeholder-free config. Local `ensure-resources` verifies Wrangler
emulation and performs no cloud operation. The immutable plan is never mutated: the
resource step returns a `resolvedResources` value, and the manifest/config steps render
from `{ ...plan, resources: resolvedResources }`. Non-secret resource IDs may be recorded
as state evidence.

- [ ] **Step 5: Configure secrets without persisting them in setup state**

Create `scripts/setup/secrets.mjs`. Generate `SESSION_SECRET` with
`randomBytes(32).toString('base64url')` only when absent. Local mode atomically writes the
gitignored `.dev.vars` with file mode `0600`, preserving recognized existing keys:

```text
SESSION_SECRET=<generated value>
EMAIL_DEV_LOG=1
AUTH_DEV_BYPASS_EMAIL=<normalized first-admin email>
```

Deploy mode first checks `wrangler secret list --json`, then writes a missing session
secret over stdin so it never appears in process arguments:

```js
await runner.run(wranglerBin, ['secret', 'put', 'SESSION_SECRET', '--config', configPath], { input: `${sessionSecret}\n` });
```

Stripe secrets remain optional user-provided integrations and are never synthesized.
Secret values must not enter `.church/setup-state.json`, `church.config.json`, plan/result
JSON, state evidence, or command errors.

- [ ] **Step 6: Wire concrete provider actions**

The D1 step factory must invoke, with argument arrays:

```text
wrangler d1 migrations apply DB --local|--remote --config wrangler.jsonc
wrangler d1 execute DB --local|--remote --file seed/dev-seed.sql --config wrangler.jsonc --yes
```

The Supabase step factory invokes existing Node migration/seed scripts with
`SUPABASE_DB_URL` in the child environment, never the plan. Both factories then call
`initializeModuleSettings` and `bootstrapFirstAdmin` through their AppDb adapters.

Local Hyperdrive uses the host-process environment variable
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`; do not write it to
`.dev.vars`, because Wrangler reads it before Worker startup.

- [ ] **Step 7: Run GREEN and compatibility tests, then commit**

```bash
npx vitest run --project node test/node/setup/setup-media.test.ts test/node/setup/setup-apply.test.ts
node scripts/db/seed-media-local.mjs --dry-run
```

Expected: tests PASS; dry-run prints R2/D1 actions without changing local state.

Commit:

```bash
git add scripts/setup/media.mjs scripts/setup/state.mjs scripts/setup/apply.mjs scripts/setup/secrets.mjs scripts/db/seed-media-local.mjs test/node/setup/setup-media.test.ts test/node/setup/setup-apply.test.ts
git commit -m "feat(setup): apply provider setup idempotently"
```

---

### Task 8: Doctor checks and stable readiness output

**Files:**
- Create: `scripts/setup/readiness.mjs`
- Create: `scripts/setup/doctor.mjs`
- Create: `scripts/setup/checks/manifest.mjs`
- Create: `scripts/setup/checks/config.mjs`
- Create: `scripts/setup/checks/database.mjs`
- Create: `scripts/setup/checks/services.mjs`
- Create: `scripts/setup/redact.mjs`
- Create: `test/node/setup/setup-doctor.test.ts`

- [ ] **Step 1: Write failing readiness aggregation tests**

Create `test/node/setup/setup-doctor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { summarizeReadiness, doctorExitCode } from '../../../scripts/setup/readiness.mjs';
import { redact } from '../../../scripts/setup/redact.mjs';

const check = (code: string, severity: string) => ({ code, severity, message: code, remediation: `fix ${code}` });
describe('doctor readiness', () => {
  it('derives all three readiness states and strict exit codes', () => {
    expect(summarizeReadiness([check('ok', 'info')]).status).toBe('ready');
    expect(summarizeReadiness([check('stripe', 'warning')]).status).toBe('ready-with-limitations');
    expect(summarizeReadiness([check('db', 'error')]).status).toBe('not-ready');
    expect(doctorExitCode([check('stripe', 'warning')], false)).toBe(0);
    expect(doctorExitCode([check('stripe', 'warning')], true)).toBe(1);
    expect(doctorExitCode([check('db', 'error')], false)).toBe(1);
  });

  it('removes registered secret values recursively', () => {
    expect(JSON.stringify(redact({ message: 'postgres://secret', nested: ['sk_test_secret'] }, ['postgres://secret', 'sk_test_secret'])))
      .toBe('{"message":"[REDACTED]","nested":["[REDACTED]"]}');
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --project node test/node/setup/setup-doctor.test.ts
```

Expected: FAIL because readiness/redaction modules do not exist.

- [ ] **Step 3: Implement stable check/result types and aggregation**

Create `scripts/setup/readiness.mjs`:

```js
export function summarizeReadiness(checks) {
  const status = checks.some((check) => check.severity === 'error')
    ? 'not-ready'
    : checks.some((check) => check.severity === 'warning') ? 'ready-with-limitations' : 'ready';
  return { schemaVersion: 1, status, checks };
}
export function doctorExitCode(checks, strict) {
  return checks.some((check) => check.severity === 'error' || (strict && check.severity === 'warning')) ? 1 : 0;
}
export function result(code, severity, message, remediation) {
  if (!['error', 'warning', 'info'].includes(severity)) throw new Error(`invalid severity: ${severity}`);
  return { code, severity, message, remediation };
}
```

Create recursive exact-value replacement in `scripts/setup/redact.mjs`. Filter blank and
shorter-than-eight-character secrets to avoid redacting ordinary words.

- [ ] **Step 4: Implement four focused check layers**

Each check module exports one async function returning check results; it never calls
`process.exit` or formats output.

`checks/manifest.mjs`:

- validate schema, module keys, locale, mode, backend compatibility, dependency expansion,
  and safe resource names;
- report `manifest.missing`, `manifest.invalid`, or `manifest.ok`.

`checks/config.mjs`:

- require the generated marker and compare config against freshly rendered desired bytes;
- reject `YOUR_*`, `@@TOKEN@@`, missing backend bindings, and unknown `DB_BACKEND`;
- report deprecated `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` if found in
  files or host environment;
- check cron strings exactly match the three `src/worker.ts` scheduled branches.

`checks/database.mjs`:

- execute `SELECT 1`, confirm all 16 explicit module rows, confirm at least one active
  nondeleted admin, and probe provider-specific required tables;
- on Postgres compare `_migrations` to sorted `migrations-supabase/*.sql`;
- on D1 do not assume `_migrations`; probe the final shared schema (`member_groups`,
  `checkins`, `custom_pages`, `page_blocks`) and use `wrangler d1 migrations list` when
  available.

`checks/services.mjs`:

- R2 access is an error when required and missing;
- local `EMAIL_DEV_LOG=1` is info, missing production email is warning;
- missing Stripe keys for Giving/Registration is warning with free-registration/offline-
  giving wording; one of two Stripe keys present is error because configuration is partial;
- missing optional backup configuration is info, never an error.

- [ ] **Step 5: Compose the doctor without process-global coupling**

Create `scripts/setup/doctor.mjs`:

```js
import { summarizeReadiness, doctorExitCode } from './readiness.mjs';
export async function runDoctor(context, { strict = false } = {}) {
  const groups = await Promise.all([
    context.checkManifest(), context.checkConfig(), context.checkDatabase(), context.checkServices(),
  ]);
  const checks = groups.flat();
  return { ...summarizeReadiness(checks), exitCode: doctorExitCode(checks, strict) };
}
```

Formatting belongs in the CLI. JSON output is exactly the versioned object after redaction;
text output lists status then each severity/code/message/remediation.

- [ ] **Step 6: Run GREEN and commit**

```bash
npx vitest run --project node test/node/setup/setup-doctor.test.ts
```

Expected: PASS.

Commit:

```bash
git add scripts/setup/readiness.mjs scripts/setup/doctor.mjs scripts/setup/checks scripts/setup/redact.mjs test/node/setup/setup-doctor.test.ts
git commit -m "feat(setup): add installation readiness doctor"
```

---

### Task 9: Interactive/noninteractive CLI composition

**Files:**
- Create: `scripts/setup/prompts.mjs`
- Create: `scripts/setup/index.mjs`
- Create: `test/node/setup/setup-cli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI purity/equivalence tests**

Create `test/node/setup/setup-cli.test.ts` by importing the entrypoint's exported
`runSetup(argv, deps)`. Inject prompt, filesystem, runner, apply, and output spies.

Required cases:

```ts
it('--help exits zero without prompting, files, commands, or apply');
it('interactive answers and equivalent flags build deeply equal plans');
it('--dry-run --json emits one versioned plan and performs zero mutations');
it('noninteractive missing answers fail with all missing flags listed');
it('D1 override plus portal/giving/registration lists all offenders before mutation');
it('confirmation rejection leaves files, commands, state, and database untouched');
```

For the equivalence test, use Website + Community and assert D1 with exactly 13 enabled
modules. For Full Church, assert automatic Supabase and all 16.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --project node test/node/setup/setup-cli.test.ts
```

Expected: FAIL because prompts and entrypoint do not exist.

- [ ] **Step 3: Implement one-question-at-a-time prompts**

Create `scripts/setup/prompts.mjs` with an injected `ask(question)` dependency. Export
`collectInteractiveAnswers(partial, catalog, ask)` and ask in this exact order:

1. mode: Local trial / Deploy to Cloudflare;
2. feature choice: Website / Website + Community / Full Church / Customize;
3. if Customize, one yes/no question per catalog group with a final exact module review;
4. site slug;
5. church name;
6. locale: English / Chinese;
7. first-admin display name;
8. first-admin email;
9. in deploy mode, the public HTTPS origin and verified sender email;
10. fictional demo data yes/no;
11. resolved plan confirmation.

The prompt module returns normalized answers only. It does not import provider adapters,
filesystem functions, commands, apply, or doctor.

- [ ] **Step 4: Implement the thin composition root**

Create `scripts/setup/index.mjs`. Guard direct invocation with the same
`pathToFileURL(process.argv[1]).href === import.meta.url` pattern as
`scripts/build-tokens.mjs`. Export:

```js
export async function runSetup(argv, deps) {
  const parsed = parseSetupArgs(argv, deps.catalog);
  if (parsed.help) { deps.output(SETUP_HELP); return 0; }
  if (parsed.doctor) {
    const doctor = await deps.doctor({ strict: parsed.strict });
    deps.output(parsed.json ? JSON.stringify(doctor) : deps.formatDoctor(doctor));
    return doctor.exitCode;
  }
  const answers = deps.interactive
    ? await collectInteractiveAnswers(parsed, deps.catalog, deps.ask)
    : parsed;
  const currentState = await deps.inspectExisting({ dryRun: parsed.dryRun });
  const plan = buildSetupPlan(answers, deps.catalog, currentState);
  if (parsed.dryRun) {
    deps.output(parsed.json ? JSON.stringify({ schemaVersion: 1, kind: 'setup-plan', plan }) : deps.formatPlan(plan));
    return 0;
  }
  if (!parsed.yes && !await deps.confirm(plan)) return 0;
  const secretContext = plan.backend === 'supabase' ? await deps.collectSupabaseSecret() : {};
  const result = await deps.apply(plan, { secretContext, forceConfig: parsed.forceConfig, promoteExistingAdmin: parsed.promoteExistingAdmin });
  deps.output(parsed.json ? JSON.stringify({ schemaVersion: 1, kind: 'setup-result', ...result }) : deps.formatResult(result));
  return result.doctor.exitCode;
}
```

`collectSupabaseSecret()` reads `SUPABASE_DB_URL` first. In an interactive TTY it may use
an injected masked-input reader; it must not use ordinary echoing `readline.question` for a
password-bearing URL. Noninteractive mode without the environment variable exits before
mutation and names `SUPABASE_DB_URL`. The URL exists only in the in-memory
`secretContext`; dry-run never requests it because no provider connection is made.

The actual composition creates `readline/promises` only for interactive TTY runs. If
stdin/stdout is not a TTY and required answers are missing, print the exact missing flags
and exit nonzero; never hang.

- [ ] **Step 5: Add package entrypoints**

Modify `package.json`:

```json
"setup": "node scripts/setup/index.mjs",
"doctor": "node scripts/setup/index.mjs --doctor"
```

The entrypoint must recognize `--doctor` as a mutually exclusive mode in `args.mjs` and
call the same doctor engine used after apply. Add `--strict` to doctor options only.

- [ ] **Step 6: Run CLI GREEN and manual contract checks, then commit**

```bash
npx vitest run --project node test/node/setup/setup-cli.test.ts
npm run setup -- --help
npm run setup -- --preset website --mode local --site-slug plan-probe --church-name "Plan Probe" --locale en --admin-name "Plan Admin" --admin-email admin@example.test --demo-data --yes --dry-run --json
git status --short
```

Expected: tests PASS; help exit 0; dry-run emits D1 JSON; no new manifest/config/state files
appear. Only pre-existing user files such as `output/` remain untracked.

Commit:

```bash
git add scripts/setup/prompts.mjs scripts/setup/index.mjs scripts/setup/args.mjs test/node/setup/setup-cli.test.ts package.json
git commit -m "feat(setup): add guided setup and doctor CLI"
```

---

### Task 10: Generate catalog-owned documentation and repair setup claims

**Files:**
- Create: `scripts/docs/generate-capabilities.mjs`
- Create: `scripts/docs/check-capabilities.mjs`
- Create: `test/node/setup/docs-capabilities.test.ts`
- Modify: `README.md`
- Modify: `docs/features/modules.md`
- Modify: `docs/architecture.md`
- Modify: `docs/deploy.md`
- Modify: `docs/cloudflare-setup.md`
- Modify: `docs/supabase-setup.md`
- Modify: `docs/why-this-stack.md`
- Modify: `CONTRIBUTING.md`
- Modify: `.dev.vars.example`
- Modify: `package.json`

- [ ] **Step 1: Write failing documentation drift tests**

Create `test/node/setup/docs-capabilities.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import raw from '../../../config/capabilities.json';
import { renderCapabilityTable, replaceGeneratedSection } from '../../../scripts/docs/generate-capabilities.mjs';

const docs = ['README.md', 'docs/features/modules.md', 'docs/architecture.md', 'docs/deploy.md', 'docs/cloudflare-setup.md', 'docs/supabase-setup.md', 'docs/why-this-stack.md', 'CONTRIBUTING.md'];
describe('catalog-owned docs', () => {
  it('renders all 16 modules and exactly three Supabase requirements', () => {
    const table = renderCapabilityTable(raw);
    expect(raw.order.every((key) => table.includes(key))).toBe(true);
    expect((table.match(/Supabase/g) ?? [])).toHaveLength(3);
  });

  it('has current generated markers and no unsupported migration promise', () => {
    for (const path of docs) {
      const text = readFileSync(path, 'utf8');
      expect(text).not.toMatch(/15 modules|two modules need|everything except (online )?giving and registration/i);
      expect(text).not.toMatch(/switch later[^.\n]*(nothing is lost|without losing)/i);
    }
    const moduleDoc = readFileSync('docs/features/modules.md', 'utf8');
    expect(moduleDoc).toContain('<!-- capabilities:start -->');
    expect(moduleDoc).toContain('<!-- capabilities:end -->');
    expect(moduleDoc).toContain('Member Portal');
    expect(moduleDoc).toMatch(/Registration[^\n]*Registration/);
  });

  it('replacing a generated section preserves surrounding prose', () => {
    expect(replaceGeneratedSection('before\n<!-- capabilities:start -->\nold\n<!-- capabilities:end -->\nafter\n', 'new'))
      .toBe('before\n<!-- capabilities:start -->\nnew\n<!-- capabilities:end -->\nafter\n');
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run --project node test/node/setup/docs-capabilities.test.ts
```

Expected: FAIL because generators/markers do not exist and stale claims remain.

- [ ] **Step 3: Implement marker-scoped generation and checking**

Create `scripts/docs/generate-capabilities.mjs` with pure exports plus a guarded CLI:

```js
export const START = '<!-- capabilities:start -->';
export const END = '<!-- capabilities:end -->';
export function replaceGeneratedSection(document, generated) {
  const start = document.indexOf(START), end = document.indexOf(END);
  if (start < 0 || end < start || document.indexOf(START, start + 1) >= 0 || document.indexOf(END, end + 1) >= 0) throw new Error('expected exactly one ordered capabilities marker pair');
  return `${document.slice(0, start + START.length)}\n${generated.trim()}\n${document.slice(end)}`;
}
export function renderCapabilityTable(catalog) {
  const rows = catalog.order.map((key) => {
    const def = catalog.capabilities[key];
    return `| \`${key}\` | ${def.labels.en} | ${def.labels.zh} | ${def.requiresBackend === 'supabase' ? 'Supabase' : 'D1 or Supabase'} |`;
  });
  return ['| Key | English | 中文 | Database |', '|---|---|---|---|', ...rows].join('\n');
}
```

The CLI updates only marked sections in `README.md`, `docs/features/modules.md`, and
`docs/architecture.md`. `scripts/docs/check-capabilities.mjs` computes desired bytes in
memory and exits 1 with the changed paths; it never writes.

- [ ] **Step 4: Repair prose and setup command hierarchy**

Make `npm run setup` the first path in README, Cloudflare setup, deploy, and Supabase setup.
Retain manual commands under a clearly labeled reference/troubleshooting heading.

Apply these exact truth changes:

- 16 modules, not 15;
- Portal, Giving, and Registration require Supabase;
- Registration's table label is Registration;
- new installations use explicit selected settings; legacy missing rows still default on;
- remove every lossless D1-to-Supabase switch claim and state that no automated content
  migration exists yet;
- replace raw first-admin SQL with `npm run setup`/bootstrap instructions;
- describe Website, Website + Community (13 D1-compatible modules), and Full Church;
- update `.dev.vars.example` to
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` and explain that it is a host
  environment variable, not a Worker binding loaded from `.dev.vars`;
- update CONTRIBUTING so Postgres coverage includes Portal as well as Giving/Registration.

- [ ] **Step 5: Add scripts, generate, check, and commit**

Add to `package.json`:

```json
"docs:generate": "node scripts/docs/generate-capabilities.mjs",
"docs:check": "node scripts/docs/check-capabilities.mjs"
```

Run:

```bash
npm run docs:generate
npm run docs:check
npx vitest run --project node test/node/setup/docs-capabilities.test.ts
git diff --check
```

Expected: generator/check PASS; tests PASS; no whitespace errors.

Commit:

```bash
git add scripts/docs test/node/setup/docs-capabilities.test.ts README.md docs/features/modules.md docs/architecture.md docs/deploy.md docs/cloudflare-setup.md docs/supabase-setup.md docs/why-this-stack.md CONTRIBUTING.md .dev.vars.example package.json
git commit -m "docs: derive setup guidance from capabilities"
```

---

### Task 11: Clean-room D1 and Postgres setup tests

**Files:**
- Create: `test/setup/fixtures.ts`
- Create: `test/setup/clean-room-d1.test.ts`
- Create: `test/setup/clean-room-pg.test.ts`
- Create: `test/setup/dry-run.test.ts`
- Modify: `scripts/setup/index.mjs`
- Modify: `scripts/setup/apply.mjs`

- [ ] **Step 1: Build a disposable workspace fixture**

Create `test/setup/fixtures.ts` using `mkdtemp`, `cp`, and `symlink`. Copy the repository
while excluding `.git`, `node_modules`, `.wrangler`, `.astro`, `dist`, `.dev.vars`,
`.church`, `output`, and `church.config.json`; symlink the real `node_modules` into the
temporary root. Export `createCleanWorkspace()` and an `execNode(args, env)` helper that
uses `execFile` with `cwd` set to the temporary root and the copied
`scripts/setup/index.mjs` as entrypoint.

The fixture registers cleanup in `afterEach`; it never removes or modifies the source
workspace.

- [ ] **Step 2: Write the failing dry-run mutation proof**

Create `test/setup/dry-run.test.ts`:

1. create the clean workspace;
2. hash every file path/content before;
3. run the real CLI with Website, all required flags, `--yes --dry-run --json`;
4. hash again;
5. assert hashes equal, no `.church`, `church.config.json`, `.dev.vars`, or changed
   `wrangler.jsonc`, and JSON selects D1.

Run:

```bash
npx vitest run --project node test/setup/dry-run.test.ts
```

Expected initially: FAIL where the CLI still constructs mutation dependencies during dry-run.

- [ ] **Step 3: Write the D1 clean-room acceptance test**

Create `test/setup/clean-room-d1.test.ts`. Use a unique
`WRANGLER_PERSIST_TO=<temp>/.wrangler-state`, then run the actual CLI noninteractively for
the Website preset with demo data. Assert:

```ts
expect(result.backend).toBe('d1');
expect(result.doctor.status).toBe('ready');
expect(result.enabledModules).toHaveLength(8);
expect(result.moduleRows).toBe(16);
expect(result.admin.status).toMatch(/created|already-admin/);
```

Query the actual local D1 through `wrangler d1 execute DB --local --json` to assert exactly
16 module rows and the normalized active admin. Run setup a second time and assert every
apply result is `already-complete` or `verified`, with the same manifest/config bytes.
Then run `npm run build`, spawn `npm run dev -- --host 127.0.0.1` with the same persistence
environment, poll `/healthz` until it returns 200, and assert `/en/` returns 200 with the
configured church name. The fixture must terminate the child in `finally` and surface its
captured output on failure.

- [ ] **Step 4: Write the Postgres clean-room acceptance test**

Create `test/setup/clean-room-pg.test.ts` with `describe.skipIf(!DATABASE_URL)` locally.
Reset the CI Postgres schema, run Full Church with `SUPABASE_DB_URL` supplied only in the
child environment, and assert:

- automatic `supabase` selection;
- all migrations recorded in `_migrations`;
- all 16 module rows equal `1`;
- the admin is active and idempotent;
- demo media metadata and targets exist in Postgres;
- doctor is `ready-with-limitations` when Stripe is absent and the only limitations have
  Stripe codes;
- rerun is idempotent and generated JSON contains neither connection URL nor credentials.

Build and launch the generated Supabase configuration with
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=$DATABASE_URL`; assert
`/healthz`, `/en/`, and a Supabase-only route through the existing authenticated test
helper return their expected success statuses. Terminate the server in `finally`.

- [ ] **Step 5: Fix orchestration until all three clean-room tests pass**

Use only production setup paths; do not add test-only branches to setup. Ensure local D1
resource checks do not require Cloudflare login, and Supabase clean-room does not touch D1.

Run:

```bash
npx vitest run --project node test/setup/dry-run.test.ts test/setup/clean-room-d1.test.ts
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run --project node test/setup/clean-room-pg.test.ts
```

Expected: D1/dry-run PASS; PG PASS with zero skips when Postgres is available.

- [ ] **Step 6: Commit**

```bash
git add test/setup scripts/setup/index.mjs scripts/setup/apply.mjs
git commit -m "test(setup): prove clean D1 and Supabase installs"
```

---

### Task 12: CI hardening, schema parity, and complete verification

**Files:**
- Modify: `package.json`
- Modify: `vitest.e2e.config.ts`
- Modify: `vitest.e2e.pg.config.ts`
- Create: `test/e2e/knownUnhandled.ts`
- Modify: `test/pg/schema.test.ts`
- Create: `scripts/ci/assert-vitest-json.mjs`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Remove test-suite masking**

Change:

```json
"test": "vitest run"
```

Remove `dangerouslyIgnoreUnhandledErrors: true` from both E2E configs. Add
`test/e2e/knownUnhandled.ts` as the first setup file in both configs. It may suppress only
the exact benign es-module-lexer rejection:

```ts
const KNOWN = /WebAssembly\.compile.*(?:disallowed|not allowed|Wasm code generation)/i;
globalThis.addEventListener?.('unhandledrejection', (event: PromiseRejectionEvent) => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  if (KNOWN.test(message) && message.includes('WebAssembly')) event.preventDefault();
});
```

Add a focused test that dispatches a matching event and an unrelated rejection event;
only the matching event may be prevented. If the current dependency no longer emits the
known error, delete this filter instead of keeping dead suppression.

- [ ] **Step 2: Strengthen shared-schema parity**

Extend `test/pg/schema.test.ts` beyond tables/columns. Parse each final D1 table definition
and `ALTER TABLE ADD COLUMN` into normalized expectations, then query Postgres catalogs:

```sql
SELECT table_name,column_name,data_type,is_nullable,column_default
FROM information_schema.columns WHERE table_schema='public';

SELECT tc.table_name,tc.constraint_type,kcu.column_name,ccu.table_name AS foreign_table,ccu.column_name AS foreign_column
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.key_column_usage kcu USING (constraint_name,table_schema)
LEFT JOIN information_schema.constraint_column_usage ccu USING (constraint_name,table_schema)
WHERE tc.table_schema='public';

SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public';
```

Normalize SQLite `INTEGER PRIMARY KEY` to Postgres identity integer, SQLite integer booleans
to Postgres compatibility integer columns, equivalent UTC timestamp defaults, unique
constraints, foreign-key targets, and application-significant indexes. Assert both
`missing` and `unexpected shared drift` arrays are empty. Keep Supabase-only tables in an
explicit allowlist: `funds`, `fund_i18n`, `gifts`, `recurring_gifts`, registration tables,
and Portal-only membership/application/file/prayer/event-admin tables.

- [ ] **Step 3: Make Postgres non-skipping provable in CI**

Create `scripts/ci/assert-vitest-json.mjs`:

```js
import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if ((report.numFailedTests ?? 0) > 0) throw new Error('Vitest report contains failed tests');
if ((report.numPassedTests ?? 0) < Number(process.argv[3] ?? 1)) throw new Error('Vitest report did not execute the required tests');
if ((report.numPendingTests ?? 0) !== 0) throw new Error(`Vitest report contains ${report.numPendingTests} skipped tests`);
console.log(`verified ${report.numPassedTests} passing tests and zero skips`);
```

In CI, run the pg project with JSON reporter and assert at least one passing test and zero
pending. Do the same for the clean-room PG test.

- [ ] **Step 4: Add documentation/setup gates to CI**

Modify `.github/workflows/ci.yml` after install/type generation:

```yaml
- name: Check generated capability documentation
  run: npm run docs:check

- name: Prove setup dry-run and clean D1 install
  run: npx vitest run --project node test/setup/dry-run.test.ts test/setup/clean-room-d1.test.ts

- name: Prove clean Supabase setup
  run: npx vitest run --project node test/setup/clean-room-pg.test.ts --reporter=json --outputFile=.tmp/setup-pg.json
  env:
    DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres

- name: Assert Supabase setup test did not skip
  run: node scripts/ci/assert-vitest-json.mjs .tmp/setup-pg.json 1
```

Update the existing pg project step similarly. Ensure `.tmp` exists before reporter output
or have the script create it in a preceding non-shell Node command.

- [ ] **Step 5: Run targeted hardening gates**

```bash
npm run docs:check
npx vitest run --project pg test/pg/schema.test.ts
npm run test:e2e
```

With Postgres:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run --project pg test/pg/schema.test.ts
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:e2e:pg
```

Expected: all pass; no unexpected unhandled errors; PG schema test has zero skips with URL.

- [ ] **Step 6: Run the complete fresh verification matrix**

Run each command after all changes, not from cached prior output:

```bash
npm run docs:check
npm run tokens:check
npm test
npm run check
npm run build
npm run db:migrate:local
npm run db:seed:local
npm run db:seed-media:local
bash scripts/smoke.sh
npm run test:e2e
```

Then, against a clean local Postgres database:

```bash
SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/postgres npm run db:migrate:supabase
SUPABASE_DB_URL=postgres://postgres:postgres@localhost:5432/postgres npm run db:seed:supabase
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run --project pg
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:e2e:pg
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run --project node test/setup/clean-room-pg.test.ts
```

Expected: every command exits 0; no skipped Postgres tests in the commands with a URL;
doctor/readiness assertions match the design.

- [ ] **Step 7: Audit the written acceptance criteria explicitly**

Create a checklist in the final implementation handoff mapping all ten acceptance criteria
from the design spec to fresh command output or file evidence. Include:

```text
1 D1 interactive/clean install -> clean-room-d1 + CLI equivalence tests
2 Full Church Supabase -> clean-room-pg, 16 settings
3 deterministic provider/rejection -> resolver + dry-run tests
4 rerun/dry-run/secrets -> apply/files/clean-room tests
5 doctor states -> doctor + both clean-room tests
6 admin bootstrap parity -> D1 + pg setupDb tests
7 one catalog/docs/runtime -> catalog/modules/docs checks
8 existing install compatibility -> moduleGating + config refusal tests
9 all quality gates -> full matrix outputs
10 demo untouched -> git status/path inspection
```

Do not call the foundation complete if any evidence is skipped, indirect, or stale.

- [ ] **Step 8: Commit the hardening and CI changes**

```bash
git add package.json vitest.e2e.config.ts vitest.e2e.pg.config.ts test/e2e/knownUnhandled.ts test/pg/schema.test.ts scripts/ci/assert-vitest-json.mjs .github/workflows/ci.yml
git commit -m "ci: verify capability-driven setup end to end"
```

---

## Execution handoff constraints

- Preserve the user's unrelated untracked `output/` directory.
- Do not create or modify `church4christ-demo` during this plan.
- Use a feature branch/worktree at execution time if the current working tree has user
  changes that could overlap.
- Every production behavior begins with a failing test and an observed expected failure.
- After each agent/task, inspect the diff and rerun its focused test; never rely only on an
  agent report.
- Do not weaken existing authentication, module gating, Stripe, or deployment behavior to
  make setup tests pass.
- Do not claim the overall demo goal is complete when this foundation plan finishes. The
  next project is durable Stripe event receipt/replay, followed by the demo itself.
