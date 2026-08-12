# Portable People Data Implementation Plan

> **Required execution skills:** subagent-driven-development, test-driven-development,
> workers-best-practices, and verification-before-completion.

**Goal:** Deliver a safe canonical People/Household export, a separately audited
pastoral-notes export, and saved create-only source-column mappings.

**Delivery:** Two sequential PRs. Export owns migration `0011`; mapping owns `0012`.

## Resolved boundaries

- Canonical exports are partitioned into deterministic numbered CSV parts when one
  importer-safe file would exceed 200 data rows, 100 households, or 256 KiB. A household
  is never split. The UI discloses the part count and downloads one exact 18-column CSV
  per part. A single household that exceeds a limit fails closed with a structural error.
- Export validates portability before emitting bytes. A live household with dependents
  but no live adult primary is not silently repaired or partially omitted; the admin
  receives a bounded repair-required count.
- Standard export excludes soft-deleted People, households, dependents, and notes. It
  includes active and inactive live People. Formula-prefixed cells use the existing
  `csvCell` neutralization and documentation explains the leading apostrophe.
- Sensitive notes export includes live, non-deleted notes for live People. It assigns a
  deterministic file-local `person-N` reference from the same normalized People ordering
  as the canonical export and includes the current subject email as portable matching
  data. Columns are `person_ref,person_email,author_attribution,body,created_at`.
  `author_attribution` is the historical `person_notes.author_email` text; it is not
  represented as a resolvable Person foreign key and may refer to a renamed or removed
  account. Tests lock that distinction and document that email changes require operator
  matching during a future notes restore; v0.2 does not import notes.
- Mapping profiles are immutable v1 records. Headers are stored because exact drift
  detection requires them; the UI warns operators not to use member data as column
  labels. No sample values or source rows are stored.
- One source column may feed more than one canonical field only when explicitly mapped.
  Header order is part of the profile contract. Unknown translated enum values are
  blocking row errors.
- Source inspection has its own `PEOPLE_MAPPING_SOURCE_LIMITS`: 256 KiB, 200 data
  records, 128 source columns, and 5,000 Unicode code points per cell. It does not reuse
  the canonical parser's 18-column limit. The transformed output must then contain exactly
  the 18 canonical fields and is validated by the extracted canonical validator.

## PR A: Canonical and sensitive exports

### Files

- Create: `migrations/0011_people_exports.sql`
- Create: `migrations-supabase/0011_people_exports.sql`
- Create: `src/lib/auditDb.ts`
- Create: `src/lib/peopleExport.ts`
- Create: `src/lib/peopleExportDb.ts`
- Create: `src/lib/peopleExportHttp.ts`
- Create: `src/pages/admin/people/export.csv.ts`
- Create: `src/pages/admin/people/export-notes.astro`
- Create: `test/fixtures/peopleExport.ts`
- Create: `test/peopleExport.test.ts`
- Create: `test/peopleExportDb.test.ts`
- Create: `test/peopleExportHttp.test.ts`
- Create: `test/pg/peopleExportDb.test.ts`
- Create: `test/e2e/people-export.e2e.test.ts`
- Create: `test/e2e-pg/people-export.e2e.test.ts`
- Modify: `config/capabilities.json`, `src/lib/adminAreas.ts`
- Modify: `src/pages/admin/people/index.astro`, `src/i18n/en.ts`, `src/i18n/zh.ts`
- Modify: `scripts/setup/checks/database.mjs`
- Modify: related schema, route, module, i18n, setup-doctor, docs, upgrade, and release tests.

### Task 1: Pure canonical serializer and partitioner

- [ ] Write RED tests proving `PEOPLE_IMPORT_HEADERS` is the byte-for-byte header,
  CRLF/UTF-8 quoting is stable, privileged fields are absent, and formulas are neutralized.
- [ ] Define and implement:

  ```ts
  export interface CanonicalExportPart {
    number: number;
    rowCount: number;
    householdCount: number;
    csv: string;
  }

  export function buildCanonicalExportParts(
    source: CanonicalPeopleExportSource,
  ): CanonicalExportResult;
  ```

- [ ] Sort in JavaScript using `trim().normalize('NFC').toLowerCase()`: household name,
  primary email, member email, then dependent display name/role; assign file-local
  `household-N` keys after sorting.
- [ ] Add RED/GREEN cases at 200/201 rows, 100/101 households, the byte boundary, and an
  oversized single household. Never silently truncate or split a household.
- [ ] Prove every emitted part parses with `parsePeopleImport` and the union of parts
  contains every eligible row exactly once.

### Task 2: Cross-backend snapshots and portability failures

- [ ] Implement `loadCanonicalPeopleExport(db)` using one `AppDb.batch` snapshot.
- [ ] Test live/inactive People, live dependents, soft deletes, two equal names, Unicode,
  and stable D1 ordering.
- [ ] Add orphan/no-live-primary fixtures and require a bounded `repair_required` result
  with no CSV bytes.
- [ ] Run the same fixture through real PostgreSQL and require byte-identical parts.

### Task 3: Standard export HTTP contract

- [ ] Add the exact `/admin/people/export.csv` capability and full-People admin-area
  prefixes before implementing the endpoint.
- [ ] Test module-off 404, anonymous redirect, member/editor/limited-admin 403, full
  People/super-admin 200, `no-store`, UTF-8 CSV, dated filenames, part selection, and 405.
- [ ] Add the People-page export summary and part-download UI with bilingual copy.

### Task 4: Audited sensitive notes export

- [ ] Add parity migrations for `audit_events` with actor FK, allowlisted action kind,
  bounded numeric structural JSON, and actor/time index.
- [ ] Implement a narrow API:

  ```ts
  appendAuditEvent(db, {
    kind: 'people_notes_export_generated',
    actorPersonId,
    counts: { people, notes },
  })
  ```

- [ ] Write RED/GREEN tests for GET confirmation and POST-only generation, literal
  `EXPORT PASTORAL NOTES` acknowledgement, CSRF, super-admin-only access, no-store, no
  deleted records, and audit fail-closed behavior.
- [ ] Prove audit rows contain only actor, kind, timestamp, and numeric counts; no contact,
  note body, filename, or CSV content.
- [ ] Test deterministic `person_ref`, current subject-email matching, changed/deleted
  author attribution, and the absence of any claim that author attribution is a Person FK.

### Task 5: Integrate and verify PR A

- [ ] Update People capability table ownership, setup doctor, schema parity, i18n parity,
  docs, changelog, upgrade and frozen-migration references.
- [ ] Run focused Workers, real PG, built-worker D1/PG E2E, then the complete repository
  verification commands.
- [ ] Merge after green PR CI, verify exact main SHA CI, then delete branch/worktree.

## PR B: Create-only source-column mapping

### Files

- Create: `migrations/0012_people_import_mappings.sql`
- Create: `migrations-supabase/0012_people_import_mappings.sql`
- Create: `src/lib/peopleImportMapping.ts`, `peopleImportMappingDb.ts`
- Create: `src/lib/peopleImportMappingContract.ts`, `peopleImportMappingHttp.ts`
- Create: `src/lib/peopleImportMappingUi.ts`
- Create: `src/pages/admin/people/import/map/{index.astro,inspect.ts,profiles.ts,preview.ts,commit.ts}`
- Create: Workers, PG, UI, HTTP, and built-worker D1/PG tests for those modules.
- Modify: `src/lib/peopleImport.ts`, `src/lib/peopleImportHttp.ts`
- Modify: import navigation, setup table ownership, en/zh i18n, docs and tests.

### Task 1: Extract the canonical row validator

- [ ] Add characterization tests for all existing canonical parser cases.
- [ ] Extract without behavior change:

  ```ts
  export function validatePeopleImportRows(
    parsed: { rows: string[][]; rowNumbers: number[] },
    options: { today: string },
  ): PeopleImportValidationResult;
  ```

- [ ] Keep `parsePeopleImport(bytes)` as bounded RFC4180 parsing followed by the new
  validator; run all existing importer suites GREEN.

### Task 2: Pure source inspection and transformation

- [ ] RED/GREEN header trim+NFC+lower normalization, empty/duplicate headers, exact order
  drift, physical multiline row numbers, column reuse, allowed constants, enum mappings,
  and unknown-enum errors.
- [ ] Use `parseUtf8CsvWithRowNumbers` with `PEOPLE_MAPPING_SOURCE_LIMITS`; test 18/19/128
  source columns, reject 129, enforce the byte/row/cell boundaries during parsing, and
  preserve physical row coordinates after dropping unmapped columns.
- [ ] Define a JSON-safe, exhaustive `PeopleImportMappingConfig` with canonical field
  mappings plus only allowlisted constants and enum translations.
- [ ] Pass transformed rows and original physical row numbers directly to the canonical
  validator; never rebuild and reparse CSV.

### Task 3: Immutable profile persistence

- [ ] Add D1/PG parity migrations for profile name, expected headers JSON, mappings JSON,
  constants JSON, enum translations JSON, creator and timestamp.
- [ ] Enforce bounded profile/header/translation/JSON sizes before writes.
- [ ] Implement create/list/get only. Test that no upload bytes, row values, sample values,
  or inferred matches appear in persistence, logs, or errors.

### Task 4: Authoritative HTTP and UI flow

- [ ] Refactor the existing bounded multipart reader into a reusable primitive without
  weakening its 320 KiB envelope, 256 KiB file, MIME, duplicate-part, or safe-error rules.
- [ ] Implement inspect, profile-create, preview, and commit endpoints under the existing
  import capability and People-area gates.
- [ ] Preview/commit accept only current bytes plus profile id. Commit reloads the profile,
  retransforms on the server, runs fresh preflight, and passes the complete parsed result
  to `commitPeopleImport`; ignore client model, role, config, and operation fields.
- [ ] Add bilingual state-machine UI for mapping, translations, preview, warning ack,
  stale file/profile results, conflicts, and uncertain commit responses.

### Task 5: Parity, round-trip, and delivery

- [ ] Identity-map every canonical export part from PR A and prove clean create-only import.
- [ ] Test D1/PG collisions, rollback, tampering, mapping drift, module/area authorization,
  and no PII persistence through real built workers.
- [ ] Update docs/deploy/upgrade/changelog and run full verification.
- [ ] Merge after green PR CI, verify exact main SHA CI, then delete branch/worktree.
