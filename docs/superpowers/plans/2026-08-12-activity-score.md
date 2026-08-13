# Activity Score Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable, bilingual Activity Score module that calculates explainable per-person and church-wide engagement scores from existing person-linked activity.

**Architecture:** Store one revisioned configuration and normalized dimension rows, but calculate scores live from bounded source queries. Keep pure scoring in `activityScoreModel.ts`, persistence and evidence queries in `activityScoreDb.ts`, orchestration in `activityScoreService.ts`, strict form parsing in `activityScoreForms.ts`, and server-rendered administration in one capability- and area-gated Astro page.

**Tech Stack:** Astro 7 SSR, TypeScript 6, Cloudflare Workers, AppDb over D1/PostgreSQL, Vitest, Tailwind CSS, generated capability catalog, English/Chinese dictionaries.

---

## File map

- Create `migrations/0014_activity_score.sql` and `migrations-supabase/0014_activity_score.sql`: portable configuration schema and defaults.
- Create `src/lib/activityScoreModel.ts`: strict types and pure scoring/filtering logic.
- Create `src/lib/activityScoreDb.ts`: configuration persistence, eligible People, and activity evidence queries.
- Create `src/lib/activityScoreService.ts`: windows, module availability, live report, coverage, and bounds.
- Create `src/lib/activityScoreForms.ts`: bounded POST parsing with fixed error codes.
- Create `src/pages/admin/activity-score/index.astro`: report, filters, explanations, and super-admin configuration.
- Modify `config/capabilities.json`, `src/lib/adminAreas.ts`, `src/lib/routePolicy.ts`, `src/layouts/Admin.astro`, `src/pages/admin/index.astro`: module and authorization integration.
- Modify `src/i18n/en.ts` and `src/i18n/zh.ts`: complete bilingual copy.
- Create focused unit, Workers/D1, PostgreSQL, source-boundary, and schema tests listed below.
- Modify documentation and setup/schema-parity expectations generated from the capability catalog.

### Task 1: Portable configuration schema

**Files:**
- Create: `test/activityScoreSchema.test.ts`
- Create: `migrations/0014_activity_score.sql`
- Create: `migrations-supabase/0014_activity_score.sql`
- Modify: `test/pg/schemaParity.ts`

- [ ] **Step 1: Write the failing D1 schema tests**

Assert that `activity_score_config` is a singleton with bounded window, membership flags, ordered thresholds, revision, actor, and timestamps; that `activity_score_dimensions` contains exactly the three allowlisted keys; and that database checks reject invalid windows, weights, targets, dimensions, revisions, and foreign actors.

```ts
it('seeds one bounded model and three dimensions', async () => {
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM activity_score_config').first<number>('n')).toBe(1);
  const rows = await env.DB.prepare(`
    SELECT dimension_key, enabled, weight, target_count
    FROM activity_score_dimensions ORDER BY dimension_key
  `).all();
  expect(rows.results).toEqual([
    { dimension_key: 'group_attendance', enabled: 1, weight: 50, target_count: null },
    { dimension_key: 'registration', enabled: 0, weight: 0, target_count: 2 },
    { dimension_key: 'serving', enabled: 1, weight: 50, target_count: 3 },
  ]);
});
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `npm test -- test/activityScoreSchema.test.ts`

Expected: FAIL because the two tables do not exist.

- [ ] **Step 3: Add the two portable migrations**

Use integer booleans and explicit checks. Seed config id `1`, default eligibility for regular/member, thresholds `70/40`, revision `0`, and the exact three dimension rows. Add the two new tables to the schema-parity allowlist.

- [ ] **Step 4: Verify GREEN and PostgreSQL migration parsing**

Run: `npm test -- test/activityScoreSchema.test.ts test/node/setup/schema-parity-parser.test.ts`

Expected: both files pass.

- [ ] **Step 5: Commit**

```bash
git add migrations/0014_activity_score.sql migrations-supabase/0014_activity_score.sql test/activityScoreSchema.test.ts test/pg/schemaParity.ts
git commit -m "feat: add activity score schema"
```

### Task 2: Pure scoring model

**Files:**
- Create: `test/activityScoreModel.test.ts`
- Create: `src/lib/activityScoreModel.ts`

- [ ] **Step 1: Write failing tests for the public model contract**

Cover strict configuration validation, group rates, count targets, weighted scores, unavailable-source renormalization, active/watch/limited bands, current-versus-previous trend, empty averages, coverage, stable ordering, name/status/band filtering, and rejection of duplicate or unsafe evidence.

```ts
expect(scorePerson(config, evidence, new Set(['group_attendance', 'serving']))).toMatchObject({
  score: 75,
  band: 'active',
  dimensions: {
    group_attendance: { score: 50, numerator: 1, denominator: 2 },
    serving: { score: 100, numerator: 3, denominator: 3 },
  },
});
expect(scorePerson(config, evidence, new Set(['serving']))).toMatchObject({ score: 100 });
```

- [ ] **Step 2: Run the model tests and verify RED**

Run: `npm test -- test/activityScoreModel.test.ts`

Expected: FAIL because `activityScoreModel.ts` does not exist.

- [ ] **Step 3: Implement strict types and pure functions**

Export `ACTIVITY_DIMENSIONS`, `ActivityScoreConfig`, `ActivityEvidence`, `PersonActivityScore`, `validateActivityScoreConfig`, `scorePerson`, `buildActivitySummary`, and `filterActivityScores`. Use integer arithmetic/`Math.round`, reject non-plain or unsafe inputs, and never mutate inputs.

- [ ] **Step 4: Verify GREEN and refactor names without adding behavior**

Run: `npm test -- test/activityScoreModel.test.ts`

Expected: all model tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/activityScoreModel.ts test/activityScoreModel.test.ts
git commit -m "feat: calculate explainable activity scores"
```

### Task 3: Configuration and evidence persistence

**Files:**
- Create: `test/activityScoreDb.test.ts`
- Create: `test/pg/activityScoreDb.test.ts`
- Create: `src/lib/activityScoreDb.ts`

- [ ] **Step 1: Write failing D1 database tests**

Seed people, group attendance, plans/assignments, and registrations where supported by the test profile. Assert exact config reads; atomic revisioned saves; stale conflicts; rollback on invalid dimension data; eligible-person status filtering; inclusive current/comparison bounds; explicit present/absent group counts; confirmed completed serves only; and validated deterministic rows bounded to 5,000.

```ts
const saved = await saveActivityScoreConfig(env.DB, nextConfig, 0, actorId);
expect(saved.revision).toBe(1);
await expect(saveActivityScoreConfig(env.DB, nextConfig, 0, actorId))
  .rejects.toMatchObject({ code: 'activity_score_conflict' });
```

- [ ] **Step 2: Run D1 tests and verify RED**

Run: `npm test -- test/activityScoreDb.test.ts`

Expected: FAIL because `activityScoreDb.ts` does not exist.

- [ ] **Step 3: Implement the AppDb persistence boundary**

Export typed errors, `getActivityScoreConfig`, `saveActivityScoreConfig`, `listEligibleActivityPeople`, `listGroupAttendanceEvidence`, `listServingEvidence`, and `listRegistrationEvidence`. Use `db.batch` for the compare-and-swap config update plus all dimension updates, validate every returned row, and translate only known constraint/conflict failures.

- [ ] **Step 4: Verify D1 GREEN**

Run: `npm test -- test/activityScoreDb.test.ts test/activityScoreSchema.test.ts`

Expected: both files pass.

- [ ] **Step 5: Add PostgreSQL parity tests**

Mirror the configuration conflict, rollback, and one representative evidence snapshot under `test/pg/activityScoreDb.test.ts`, self-skipping when `DATABASE_URL` is absent per repository convention.

- [ ] **Step 6: Run PostgreSQL-independent and D1 checks**

Run: `npm test -- test/activityScoreDb.test.ts test/pg/activityScoreDb.test.ts`

Expected: D1 passes; PostgreSQL passes when configured or reports the repository-standard skip.

- [ ] **Step 7: Commit**

```bash
git add src/lib/activityScoreDb.ts test/activityScoreDb.test.ts test/pg/activityScoreDb.test.ts
git commit -m "feat: query activity score evidence"
```

### Task 4: Orchestration and strict forms

**Files:**
- Create: `test/activityScoreService.test.ts`
- Create: `test/activityScoreForms.test.ts`
- Create: `src/lib/activityScoreService.ts`
- Create: `src/lib/activityScoreForms.ts`

- [ ] **Step 1: Write failing service tests**

Inject the database readers so tests prove 30/60/90/180-day current and previous windows, source-module availability, warning order, no-query behavior for unavailable dimensions, all-source-unavailable behavior, full-population summary before UI filtering, and row-limit failure.

- [ ] **Step 2: Write failing form tests**

Use real `FormData` to prove exact acceptance and rejection for action, revision, window, membership flags, dimension enablement, weights, targets, and thresholds. Errors use fixed non-echoing codes and reject duplicate scalar keys.

```ts
expect(parseActivityScoreConfigForm(validForm)).toEqual({
  ok: true,
  data: expect.objectContaining({ expectedRevision: 2 }),
});
expect(parseActivityScoreConfigForm(duplicateRevisionForm)).toEqual({
  ok: false,
  errors: { revision: 'activityScoreRevisionInvalid' },
});
```

- [ ] **Step 3: Run both files and verify RED**

Run: `npm test -- test/activityScoreService.test.ts test/activityScoreForms.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement orchestration and parsing**

Export `buildActivityScoreReport` with injected/default readers and `parseActivityScoreConfigForm`. Use `addDays` with explicit inclusive date strings, a 5,000-person limit, stable safe warnings, and no raw form values in errors.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- test/activityScoreService.test.ts test/activityScoreForms.test.ts test/activityScoreModel.test.ts`

Expected: all three files pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/activityScoreService.ts src/lib/activityScoreForms.ts test/activityScoreService.test.ts test/activityScoreForms.test.ts
git commit -m "feat: orchestrate activity score reports"
```

### Task 5: Capability and authorization integration

**Files:**
- Modify: `config/capabilities.json`
- Modify: `src/lib/adminAreas.ts`
- Modify: `src/lib/routePolicy.ts`
- Modify: `test/modules.test.ts`
- Modify: `test/moduleGating.test.ts`
- Modify: `test/adminAreas.test.ts`
- Modify: `test/routePolicy.test.ts`
- Modify: `test/node/setup/capability-catalog.test.ts`
- Modify: `test/node/setup/docs-capabilities.test.ts`
- Modify: `test/node/setup/setup-cli.test.ts`
- Modify: `test/node/setup/service-attendance-docs.test.ts`
- Modify: `README.md`
- Modify: `docs/deploy.md`
- Modify: `docs/features/modules.md`
- Modify: `docs/supabase-setup.md`

- [ ] **Step 1: Add failing catalog, module, area, and route expectations**

Expect `activity-score` after Attendance in the community group, in community/full presets, dependent on People, softly using Groups/Serve/Registration, owning `/admin/activity-score`, mapping to a new grantable activity-score area, and requiring the admin route class.

- [ ] **Step 2: Run focused integration tests and verify RED**

Run: `npm test -- test/modules.test.ts test/moduleGating.test.ts test/adminAreas.test.ts test/routePolicy.test.ts test/node/setup/capability-catalog.test.ts`

Expected: failures identify the absent capability and mappings.

- [ ] **Step 3: Update catalog and authorization maps, then regenerate capability docs**

Run: `npm run docs:generate`

The generated docs include `activity-score`; all hand-maintained preset/module counts are updated to the generated total.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- test/modules.test.ts test/moduleGating.test.ts test/adminAreas.test.ts test/routePolicy.test.ts test/node/setup/capability-catalog.test.ts test/node/setup/docs-capabilities.test.ts`

Expected: all focused files pass.

- [ ] **Step 5: Commit**

```bash
git add config/capabilities.json src/lib/adminAreas.ts src/lib/routePolicy.ts test docs README.md scripts
git commit -m "feat: register activity score capability"
```

### Task 6: Bilingual admin page

**Files:**
- Create: `test/node/activityScorePageSource.test.ts`
- Create: `src/pages/admin/activity-score/index.astro`
- Modify: `src/layouts/Admin.astro`
- Modify: `src/pages/admin/index.astro`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `test/i18n.test.ts`

- [ ] **Step 1: Write failing page-source and dictionary tests**

Assert module, area, and method guards precede reads; only super admins reach save logic and configuration controls; POST uses the strict parser and PRG redirect; GET filters are bounded; the page renders summaries, warnings, band distribution, per-dimension columns, and `<details>` explanations; prohibited sensitive source words/fields are absent; and every new English key has a Chinese peer.

- [ ] **Step 2: Run focused UI tests and verify RED**

Run: `npm test -- test/node/activityScorePageSource.test.ts test/i18n.test.ts`

Expected: FAIL because the page and keys are absent.

- [ ] **Step 3: Implement the server-rendered page and navigation**

Follow existing Admin UI classes. Return 404 for module-off, 403 for missing area, 405 for unsupported methods, and 303 after successful config save. Render no partial person rows after a report error. Put the nav and dashboard cards behind both module and area gates.

- [ ] **Step 4: Verify GREEN and type safety**

Run: `npm test -- test/node/activityScorePageSource.test.ts test/i18n.test.ts test/adminAreas.test.ts test/modules.test.ts`

Run: `npm run check`

Expected: focused tests pass and Astro reports zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/admin/activity-score/index.astro src/layouts/Admin.astro src/pages/admin/index.astro src/i18n/en.ts src/i18n/zh.ts test/node/activityScorePageSource.test.ts test/i18n.test.ts
git commit -m "feat: add activity score admin dashboard"
```

### Task 7: Documentation and built-worker coverage

**Files:**
- Create: `docs/features/activity-score.md`
- Create: `test/node/setup/activity-score-docs.test.ts`
- Create: `test/e2e/activityScore.e2e.test.ts`
- Create: `test/e2e-pg/activityScore.e2e.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/architecture.md`
- Modify: `docs/features/admin-permissions.md`
- Modify: `docs/features/modules.md`
- Modify: `docs/upgrade.md`
- Modify: `scripts/setup/checks/database.mjs`

- [ ] **Step 1: Write failing documentation and built-worker tests**

The docs test requires an explanation of dimensions, formulas, privacy exclusions, permissions, configuration conflicts, module/backend behavior, migration 0014, and no automated action. E2E covers module-off 404, unauthorized 403, authorized GET, super-admin save/redirect/readback, visible score explanation, and D1/PostgreSQL parity.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- test/node/setup/activity-score-docs.test.ts`

Expected: FAIL because the feature guide is absent.

- [ ] **Step 3: Write user and operator documentation**

Document the exact model without promising verified event attendance, member-facing scores, scheduled snapshots, or automated follow-up. Update migration inventories and capability counts.

- [ ] **Step 4: Verify documentation and D1 built-worker path**

Run: `npm run docs:check`

Run: `npm test -- test/node/setup/activity-score-docs.test.ts`

Run: `npm run test:e2e -- test/e2e/activityScore.e2e.test.ts`

Expected: documentation checks and the D1 built-worker activity-score path pass.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md docs scripts/setup/checks/database.mjs test/node/setup/activity-score-docs.test.ts test/e2e/activityScore.e2e.test.ts test/e2e-pg/activityScore.e2e.test.ts
git commit -m "docs: explain activity score monitoring"
```

### Task 8: Completion verification and publication

**Files:**
- Modify only files required by failures that directly contradict this specification.

- [ ] **Step 1: Verify formatting and generated artifacts**

Run: `git diff --check`

Run: `npm run tokens:check`

Run: `npm run docs:check`

Expected: all commands exit zero.

- [ ] **Step 2: Run the complete unit and type suites**

Run: `npm test`

Run: `npm run check`

Expected: zero failures and zero Astro errors.

- [ ] **Step 3: Run the production build and D1 end-to-end suite**

Run: `npm run build`

Run: `npm run test:e2e`

Expected: both commands exit zero.

- [ ] **Step 4: Run PostgreSQL verification when configured**

Run: `npm run test:e2e:pg`

Expected: passes when `DATABASE_URL` is available; otherwise record that the environment lacks the required external test database without claiming PostgreSQL runtime verification.

- [ ] **Step 5: Audit requirements and commit any verification-only fixes**

Re-read `docs/superpowers/specs/2026-08-12-activity-score-design.md`, map every acceptance criterion to code and fresh evidence, inspect `git diff main...HEAD`, and commit only necessary fixes.

- [ ] **Step 6: Push, create the PR, wait for CI, merge, and verify main**

Push `codex/activity-score`, open a ready pull request containing summary and test evidence, wait for required checks, merge using the repository-supported method, update local `main`, and rerun the required post-merge verification or confirm the required GitHub checks on the merge commit.
