# Onboarding, Visual Documentation, and v0.2 Release Plan

> **Required execution skills:** subagent-driven-development, test-driven-development,
> browser control for real screenshots, and verification-before-completion.

**Goal:** Share one truthful readiness catalog across CLI and admin, capture real English
and Chinese UI, update README, and publish rehearsed beta and stable releases.

**Delivery:** Four sequential PRs: onboarding, visual/docs, beta, stable.

## PR A: Shared onboarding readiness

### Fixed choices

- All authenticated real admins may read the checklist; super-admin alone may acknowledge
  manual checks.
- Restore-drill acknowledgements expire after 90 days. Other manual acknowledgements remain
  current until their catalog definition changes version.
- CLI JSON schema becomes version 2 and retains a documented legacy `code` field during
  v0.2. Each item is exactly `{checkId,status,severity,code,message,remediation}`. Stable
  statuses are `pass`, `action_required`, `manual`, `not_applicable`; severity remains
  `error|warning|info`; `code` preserves the v1 outcome code while `checkId` is the shared
  catalog identity.
- Binding/config presence proves only configuration. Delivery, route reachability, jobs,
  backups and restores remain manual/action-required until explicitly proven.
- Overall compatibility truth table: any `action_required/error` is `not-ready`; otherwise
  any `action_required/warning` or unacknowledged `manual` is
  `ready-with-limitations`; otherwise `ready`. Normal doctor exits 1 only for
  `action_required/error`; strict doctor also exits 1 for
  `action_required/warning` and unacknowledged `manual`. Pass and not-applicable never
  fail either mode. Legacy code, summary and exit behavior remain byte-compatible.
- `/admin/onboarding` belongs to a new non-grantable always-on admin area: limited admins
  may read it, members/editors are denied, and only super-admin may acknowledge.

### Files

- Create: `config/readiness.json`
- Create: `scripts/lib/validate-readiness-catalog.mjs`, `src/lib/readinessCatalog.ts`
- Create both `0015_onboarding.sql` migrations and `src/lib/onboardingDb.ts`
- Create: `src/pages/admin/onboarding/index.astro`
- Create Node, Workers, PG and built-worker D1/PG onboarding tests.
- Modify setup/doctor readiness and check adapters, admin route/nav/area, en/zh i18n,
  docs, changelog and upgrade guidance.

### Tasks

- [ ] Write RED catalog validation tests for unique stable ids, categories, severity,
  capability/service selectors, surfaces, bilingual keys, CLI remediation, admin links and
  manual version.
- [ ] Add ids for identity, locales, service times, grants, migration/no-import decision,
  newcomer owner, attendance/check-in mapping, origin/domain/email, routes/jobs, backups,
  and restore drill.
- [ ] Catalog every production legacy result code in the manifest/config/database/services
  adapters plus `manifest.exception`, `config.exception`, `database.exception`, and
  `services.exception`. Add a source exhaustiveness test that fails for an uncataloged
  literal production code; test-only synthetic codes remain fixture-local.
- [ ] Refactor setup/doctor adapters to emit catalog ids and four statuses while preserving
  redaction, strict exit behavior and the temporary legacy code.
- [ ] Lock the exact item JSON shape, overall summary and the normal/strict truth table
  before changing `formatDoctor`, `buildHandoff`, or any adapter.
- [ ] Add acknowledgement parity migrations and APIs. Accept only allowlisted manual ids;
  store actor/time/version, enforce super-admin, and calculate 90-day restore expiry.
- [ ] Implement safe Worker/admin adapters and bilingual checklist. Never render secrets,
  URLs, provider payloads, contacts or backup contents.
- [ ] Prove CLI/admin ids match, unprovable checks never pass, D1/PG parity, access matrix,
  no-store, and module-dependent not-applicable states.
- [ ] Run full verification; merge, verify exact main CI, then clean branch/worktree.

## PR B: Real screenshots and README/docs

### Files and assets

- Modify: `scripts/screenshots.mjs`, `scripts/lib/screenshot-validation.mjs`,
  `test/node/screenshotValidation.test.ts`, `seed/dev-seed.sql`.
- Commit reviewed images only under `docs/images/**`; never add `output/**`.
- Update: `README.md`, `CHANGELOG.md`, feature/admin/module/architecture/deploy/upgrade/
  release/cloudflare/supabase/stack docs affected by the shipped features.

### Tasks

- [ ] Make every screenshot definition explicit: path, output, locale, backend, identity,
  1280x800 viewport, expected marker, and rejection markers.
- [ ] Add a production-built screenshot server command using the isolated E2E Wrangler
  config after D1/PG migrate+seed. Do not use `AUTH_DEV_BYPASS_EMAIL`, which is unavailable
  in production builds. Mint a JWT with the fixed test-only `SESSION_SECRET`, seeded id,
  email and `session_epoch`, then inject the `c4c_session` cookie through CDP before the
  first authenticated navigation. Public rows receive no cookie.
- [ ] Validate unique outputs, PNG dimensions, expected page marker, authenticated identity,
  and real main-document HTTP status captured from CDP `Network.responseReceived`. A
  redirect to sign-in, 401/403/404/5xx, wrong identity, or missing marker fails capture.
- [ ] Seed only fictional export/mapping, attendance/check-in, newcomer, onboarding and Group
  checklist data. Use actual built-worker pages, never mockups or generated UI.
- [ ] Capture at minimum canonical export, mapping, attendance entry/report, public New Here
  in English and Chinese, newcomer queue/detail, onboarding, and Groups member checklist.
- [ ] Visually review every PNG at full size and README display size for clipping, overflow,
  contrast, stale copy and accidental PII. Re-capture any failure.
- [ ] Update README feature matrix, final 19/16/8 preset counts, exports/mapping limits,
  aggregate adults vs derived children vs per-person Groups, Newcomers, readiness, real
  screenshots, maturity and upcoming beta. Do not name any comparison project.
- [ ] Update feature/deploy/upgrade/release docs and generated capability docs; run link,
  docs, token, screenshot, full code and E2E verification.
- [ ] Merge, verify exact main CI, then clean branch/worktree.

## PR C: `v0.2.0-beta.1`

- [ ] Add `scripts/release/rehearse-upgrade.mjs` and tests. It accepts only the fixed
  baseline `b85ad362b9f879408797270929c52dab7ad39d1d`, uses `git archive` into a temporary
  directory, provisions isolated D1 and PostgreSQL, seeds canaries at the baseline, applies
  current forward migrations, and asserts historical People/permissions/modules plus new
  schema readiness. It never edits or reapplies released migrations in place.
- [ ] In the beta PR, set Checkout `fetch-depth: 0` and add a source-contract test because
  exact-baseline rehearsal requires the old commit. The rehearsal first runs
  `git cat-file -e b85ad362b9f879408797270929c52dab7ad39d1d^{commit}` and fails closed when
  absent; it never performs a network fetch itself.
- [ ] Run PostgreSQL rehearsal only against an explicitly test-marked disposable database,
  create a random schema and `search_path`, and drop only that schema in `finally`. Refuse
  production-like or unmarked connection targets and never drop or recreate `public`.
- [ ] Run clean D1, clean PG, exact-baseline D1 upgrade, exact-baseline PG upgrade, doctor
  strict, all tests/check/build/docs/tokens, both built-worker E2E suites, and smoke.
- [ ] Finalize the beta changelog/release note; run
  `npm version 0.2.0-beta.1 --no-git-tag-version`; assert `private: true` remains.
- [ ] Merge the release PR and require the exact merge SHA's main CI green.
- [ ] Create annotated tag `v0.2.0-beta.1` on that SHA, push it, create a GitHub prerelease,
  then read back tag target, prerelease flag, notes and URL. Do not npm publish or deploy.
- [ ] Delete release branch/worktree only after tag/release verification.

## PR D: `v0.2.0`

- [ ] Resolve every beta finding with forward-only fixes and green PR/main CI; never amend
  the beta tag or any applied migration.
- [ ] Re-run the same clean-install and exact-baseline D1/PG upgrade matrix.
- [ ] Finalize stable changelog/release note; run
  `npm version 0.2.0 --no-git-tag-version`; preserve `private: true`.
- [ ] Merge and require exact main SHA CI green, tag that SHA `v0.2.0`, push, create a
  non-prerelease GitHub Release, and read it back.
- [ ] Verify package/lock/changelog/tag agree, no npm package or production deployment was
  created, and user-owned `output/` is absent from every diff.
- [ ] Only then delete the stable branch/worktree and mark the program complete.
