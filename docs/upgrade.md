# Upgrading an existing installation

This runbook is for an installation that already has church data, uploaded media, and
deployment configuration. It is intentionally separate from first-time setup. Church4Christ
uses versioned releases, but interfaces and operating requirements may still change, so review
[`CHANGELOG.md`](../CHANGELOG.md) and the exact source diff before every upgrade.

An upgrade is an operator-reviewed deployment, not an unattended command. Keep a technical
owner responsible for backups, staging, schema changes, secret handling, verification, and
recovery.

## 1. Identify what will change

The current dependency refresh requires `npm ci` and a fresh `npm run build` before
deployment. It adds no database migration, reseeding, bindings, secrets, or deployment
procedure changes. The minimum Node.js runtime remains 22.22.1.

The test integration now uses `@cloudflare/vitest-plugin` 1.1.13, the official replacement
for `@cloudflare/vitest-pool-workers`. Its configuration and test API are unchanged; custom
test configurations must update package imports and type references as described in the
[Cloudflare migration guide](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/).
Keep Vitest on 4.1.11 because the
[plugin's published peer dependencies](https://registry.npmjs.org/@cloudflare/vitest-plugin/1.1.13)
require `^4.1.0`. Keep TypeScript on 6.0.3 because
[`@astrojs/check` 0.9.10](https://registry.npmjs.org/@astrojs/check/0.9.10)
supports TypeScript `^5.0.0 || ^6.0.0`. Revisit these compatibility limits before moving to
Vitest 5 or TypeScript 7; installing either with forced peer resolution is not a supported
upgrade path.

The checker also pins its `@astrojs/language-server` dependency to `2.16.16`.
Version `2.17.0` introduces a parser regression for valid TypeScript non-null assertions
inside template strings in Astro frontmatter, causing false errors on the registration
page. Remove the override only after a newer checker parser passes `npm run check`;
the application continues to use Astro 7.3.3.

For npm 12, `package.json` records exact native install-script approvals; review and update
those approvals when changing esbuild, workerd, or sharp versions.

Record all of the following in the change ticket or maintenance notes:

- the currently deployed commit or immutable tag and the proposed target commit or tag;
- whether the installation uses D1 or Supabase/Postgres;
- enabled modules and any source-level customizations;
- changes listed under `Unreleased` or the target checkpoint in the changelog;
- new migrations, bindings, environment variables, secrets, scheduled jobs, or provider
  requirements in the source diff.

Do not assume `npm run setup` is a safe one-command upgrade. Setup can inspect or provision
provider resources, render configuration, apply migrations, initialize modules, and
bootstrap an administrator. Use it for a reviewed setup or recovery plan, not as a substitute
for reading the upgrade diff and this runbook.

## 2. Back up before staging and production

Take a fresh, restorable backup immediately before changing each environment. Store it
outside the deployment being upgraded, restrict access because it contains member data, and
record the backup timestamp and the source revision.

Back up:

1. **Database**
   - D1: export the remote database to a protected local path, using the configured database
     name in place of `<database-name>`:

     ```bash
     npx wrangler d1 export <database-name> --remote \
       --output=/secure/backups/church4christ-before-upgrade.sql
     ```

   - Supabase/Postgres: prefer the provider's managed backup or snapshot and verify its restore
     instructions. When a CLI export is required, keep connection metadata and the password in
     separate libpq files outside the repository. The service file must not contain a password;
     both files must be owned by the operator and restricted to mode `0600`:

     ```bash
     PGSERVICE=church4christ-backup \
     PGSERVICEFILE=/secure/credentials/pg_service.conf \
     PGPASSFILE=/secure/credentials/pgpass \
       pg_dump --format=custom \
       --file=/secure/backups/church4christ-before-upgrade.dump
     ```

     Do not pass a credential-bearing connection URL or password as a `pg_dump` argument;
     command arguments can be exposed through process listings, logs, or shell history. Do not
     commit either libpq file.

2. **R2 media** — copy every object and its key to independent storage through the R2
   S3-compatible API or another verified export process. A database export does not contain
   uploaded files.
3. **Configuration** — preserve the deployed commit, `church.config.json`,
   `.church/setup-state.json`, `wrangler.jsonc`, custom source and design files,
   domain/routes, bindings, schedules, and provider resource identifiers.
   If browser onboarding was used, also preserve `.church/preferences.json`, its uploaded
   logo, and `.church/branding.json`. These files are Git-ignored; the brand file is needed
   when generating tokens or building the same brand on another machine. Reopening the
   form only saves preferences and is not an upgrade or a way to reapply initial branding.
4. **Secrets inventory** — record which secret names and provider-side values must exist, but
   do not put secret values in Git, a ticket, a changelog, `wrangler.jsonc`, or the backup
   manifest. Store values only in the approved secret manager.

Verify that the database backup can be read by its restore tool and that the R2 copy contains
expected recent uploads. A backup that has never been restored in a test environment is not
a recovery plan.

## 3. Rehearse the target revision in staging

Restore a recent production backup into an isolated staging database and R2 bucket. Keep
staging email and payment paths non-production, and point all bindings at staging resources.
Never run automated tests or seed commands against production data.

On the target source revision, run the same install and static checks used by CI:

```bash
npm ci
npm run docs:check
npm run tokens:check
npm test
npm run check
npm run build
npm run release:rehearse
```

Apply only the forward migrations for the selected staging backend. For D1, first compare the
staging binding with `npx wrangler d1 list --json` and confirm its exact database name and ID.
A bare `npm run db:migrate:remote` uses the default Wrangler configuration and must not be used
for a staging rehearsal. Choose one explicit staging target:

```bash
# Choose one; do not run both. Named environment in the reviewed Wrangler configuration:
npm run db:migrate:remote -- --env staging

# Or a separate reviewed staging configuration outside the production checkout
npx wrangler d1 migrations apply DB --remote \
  --config /secure/path/wrangler.staging.jsonc
```

For Supabase/Postgres staging, first compare the expected staging project reference and host
through the provider dashboard or approved connection profile. Record only those non-secret
target identifiers; do not print or log a connection URL or credential. After verifying the
target, inject `SUPABASE_DB_URL` through the approved secret channel without printing it or
placing it in the command text, then run:

```bash
npm run db:migrate:supabase
```

Do **not** run `npm run db:seed:local`, `npm run db:seed-media:local`, or
`npm run db:seed:supabase` in production. Seed data is for disposable local development and
tests; it is not an upgrade step.

Deploy the target revision through the same explicit staging Wrangler environment or
configuration. This target rule also applies to a Supabase-backed Worker. Then exercise
sign-in and the church's critical workflows:

```bash
# Use the matching choice; do not run both
npm run deploy -- --env staging
npm run deploy -- --config /secure/path/wrangler.staging.jsonc
```

The doctor accepts `--strict` and `--json`, but it does not accept Wrangler `--env` or
`--config` flags. Run it from an isolated staging checkout whose `church.config.json` and
default `wrangler.jsonc` both point to the staging resources. If migration/deploy used a
separate staging configuration, first render or place those reviewed settings as that
checkout's default `wrangler.jsonc`. Never perform a staging rehearsal or run its doctor from
a checkout whose manifest or default Wrangler configuration contains production bindings.
Then require the strict readiness check to pass:

```bash
npm run doctor -- --strict
```

For Supabase, provide the staging database connection in the environment when the doctor
needs it. Resolve every error and warning before scheduling production. Also test a restore
from the pre-upgrade backup with the code revision that would be used for recovery.

The repository rehearsal uses only baseline `b85ad362b9f879408797270929c52dab7ad39d1d`,
a `git archive` temporary checkout, and disposable targets. It fails closed when full Git
history is absent. PostgreSQL rehearsal requires a local test-marked URL carrying
`c4c_rehearsal=1`; it uses a random schema and drops only that schema in `finally`.

## 4. Apply the reviewed production upgrade

Choose a maintenance window appropriate to the migration and expected traffic. Pause writes
when the reviewed migration or release note requires it. Confirm the fresh database, R2,
configuration, and secrets backups from step 2 before the first production mutation.

Use the ordering documented for the target checkpoint. Unless its notes require a different
compatibility sequence, the normal forward path is:

1. take and verify the final backups;
2. confirm the production target immediately before migration: for D1, compare the default
   production binding's exact database name and ID with `npx wrangler d1 list --json`; for
   Supabase/Postgres, compare the expected project reference and host through the provider
   dashboard or approved connection profile. Record the non-secret target identifiers, but
   never print or log a connection URL or credential;
3. apply all pending migrations for the selected backend with
   `npm run db:migrate:remote` (D1) or, after secure `SUPABASE_DB_URL` injection,
   `npm run db:migrate:supabase` (Supabase/Postgres);
4. deploy the exact reviewed source revision with `npm run deploy`;
5. run `npm run doctor -- --strict` against production configuration;
6. smoke-test sign-in, public pages, admin access, media, email, and the workflows the church
   depends on;
7. record the deployed revision, migration result, verifier, and completion time.

Migration runners are forward-only. Never edit, delete, rename, reorder, or manually mark a
migration after it is merged into `main` or applied to a persistent, shared, or deployed
installation. Before merge, applying a proposed migration only to disposable local or CI
databases does not create a permanent freeze boundary: reset or rebuild those databases while
the migration remains under review. Merge to `main` freezes the file even if no production
deployment has used it. Files `0001` through `0016` in `migrations/` and
`migrations-supabase/` are the frozen current `main` baseline. In particular, do not rewrite
D1's `d1_migrations` table or the Supabase runner's `_migrations` table. Investigate a mismatch
and add a new numbered forward migration when correction is needed.

### Church4Christ 1.0.0 → 1.1.0 Learning sequence

The 1.1.0 Worker expects the complete Learning schema. From a 1.0.0 installation, rehearse the
exact production topology in staging first: restore a fresh database and R2 backup, copy only the
required secret *names/inventory* through the approved secret manager, apply the ten migrations
below, deploy the candidate, run `npm run doctor -- --strict`, and exercise Learning-off plus each
provider path the church plans to enable. Perform a separate restore drill with the pre-upgrade
backup and 1.0.0 code before accepting the production window. Do not seed Genesis or use real
production provider credentials in an automated rehearsal.

Apply these forward files in numeric order on exactly one backend; D1 uses `migrations/` and
Supabase/PostgreSQL uses the identically named files in `migrations-supabase/`:

1. `0017_learning.sql` creates the provider-neutral control-plane graph and privacy-bounded
   metadata/events.
2. `0018_learning_sync_leases.sql` adds bounded crash-recovery/finalization leases.
3. `0019_learning_sync_policy_fingerprint.sql` binds a run to its canonical URL policy.
4. `0020_learning_google.sql` adds Google OAuth state, registrations, and Pub/Sub receipts.
5. `0021_learning_google_receipt_lifecycle.sql` adds reclaimable receipt claims.
6. `0022_learning_google_cleanup_saga.sql` adds durable registration/disconnect cleanup.
7. `0023_learning_canvas.sql` adds Canvas OAuth, signed-event binding, and receipt lifecycle.
8. `0024_learning_canvas_cleanup_saga.sql` adds durable encrypted Canvas revocation cleanup.
9. `0025_learning_sync_schedule.sql` adds the fair scheduled-attempt cursor/index.
10. `0026_activity_score_learning.sql` adds default-disabled Learning engagement without
    rewriting frozen `0016_activity_score.sql`.

Back up immediately before the production migration, verify the exact target identifiers, apply
all ten files, deploy 1.1.0, run strict doctor, then verify module-off 404 behavior, authorized
admin/learner pages, a manual sync, the `:15` maintenance branch, the `:45` scheduled branch, and
authenticated notification delivery when configured. Keep Google/Canvas provider changes in the
same approved change record; Canvas remains a separate deployment with separate service/source and
backup/restore work.

There is no down migration. Migrations `0017`–`0025` add durable state and `0026` changes the
Activity Score dimension allowlist. **Do not roll back code alone.** If the prior Worker is not
forward-compatible, stop writes and recover the matched 1.0.0 application, database backup, R2
objects, configuration, schedules, and secrets. Restoring only the database does not undo provider
OAuth grants, Pub/Sub resources, registrations, Canvas Live Events, or external token revocation;
reconcile those explicitly before reopening traffic.

Migration `0011_people_exports.sql` creates `audit_events` for sensitive pastoral-notes
export auditing on both D1 and Supabase/PostgreSQL. Apply it before deploying code that
exposes `/admin/people/export-notes`; the standard People/Household export is read-only,
but a successful notes download must be able to append its audit row or it fails closed.

Migration `0012_people_import_mappings.sql` creates the immutable saved-profile table for
create-only source-column mappings on both providers. Apply it before deploying
`/admin/people/import/map`. It stores expected headers and mapping configuration; it does not
store uploaded CSV bytes, source rows, or sample values. Code rollback does not remove
profiles, and operators must not rewrite `0012` after this frozen boundary.

Migration `0013_service_attendance.sql` creates the aggregate Service Attendance tables on
both providers. Apply it before deploying `/admin/attendance` or enabling the `attendance`
module. The migration adds adult aggregates plus append/close Children-event links; it does
not create an adult roster. A code rollback does not remove those rows. Back up and verify
the schema on staging, and do not rewrite `0013` after this frozen boundary.

Migration `0016_activity_score.sql` creates the Activity Score model tables on both
providers. Apply it before deploying `/admin/activity-score` or enabling the
`activity-score` module. The migration stores configuration only; member and church-wide
scores are calculated live. A code rollback does not remove the model, and operators must
not rewrite `0016` after this frozen boundary.

Migration `0026_activity_score_learning.sql` adds the optional Learning engagement dimension
on both providers without rewriting frozen `0016`. Apply it only after the Learning schema
migrations. It preserves the existing model and all three earlier dimension rows, adds Learning
disabled with weight zero and target three, and creates the bounded submission-event index.
A pre-Task-11 Worker revision is schema-incompatible because it rejects this fourth
configuration row. Do not roll back code alone after applying `0026`: recover a matched database backup
from before the migration, or deploy a specifically forward-compatible Worker revision.
Do not delete historical Learning events merely because the module or provider connection is
unavailable.

## 5. Recovery boundaries

Code rollback and data recovery are different operations:

- **Code rollback:** redeploy the previously recorded immutable revision only when it remains
  compatible with the schema after the forward migrations. Reverting Worker code does not
  undo database or R2 changes.
- **Database restore:** restore the verified pre-upgrade D1 export, D1 point-in-time state, or
  Postgres backup when the old code requires the old schema or when data was corrupted. This
  discards database writes made after the backup/restore point; account for that data loss and
  communicate it before restoring.
- **R2 restore:** recover media independently when objects were changed or deleted. Restoring
  the database alone cannot recover an R2 object.
- **Configuration and secrets:** restore bindings, routes, schedules, configuration, and
  provider-side secrets to the versions expected by the recovered code. Never recover secret
  values from Git because they must not be stored there.

If compatibility is uncertain, stop writes and restore the matched set: application revision,
database, R2 objects, configuration, and secrets. Validate that set in isolation before
redirecting production traffic.

## Upgrading 1.1.0 to 1.2.0

Back up the matched database, R2 media, Worker revision, and configuration. Apply every
outstanding migration from `0027_multi_campus.sql` through `0038_community_workflows.sql`
in numeric order for the selected backend before deploying 1.2.0. Keep the original files
and migration ledger intact. Follow-up tables are additive; existing groups remain campus
groups. Do not seed production or create example fellowships during upgrade.

Verify `/admin/community`, `/admin/workflows`, and `/en/my/workflows` with the correct
campus and permissions. Keep reminders off until the sending domain and `EMAIL_FROM`
are verified; then explicitly set `WORKFLOW_EMAIL_ENABLED=1`. See
[community workflows](features/community-workflows.md) for retry, pause, and recovery behavior.

## Upgrading 1.2.0 to 1.3.0

Version 1.3.0 adds no database migration, binding, secret, cron trigger, or reseeding step.
Back up as usual, run `npm ci` so the refreshed dependencies are installed, rebuild, and
deploy with your normal process. Node.js 22.22.1 remains the minimum runtime.

Before deploying, confirm `vars.APP_ORIGIN` is the domain visitors use. Canonical links,
`/robots.txt`, and `/sitemap.xml` are now generated from it; the old static
`public/robots.txt` is removed. See [Search engines](deploy.md#search-engines) for the
optional verification variables and sitemap submission.

`npm run onboard` only saves local preferences under the Git-ignored `.church/` directory.
It does not change an existing installation's brand, features, or data. Preserve
`.church/preferences.json`, any uploaded logo, and `.church/branding.json` when moving a
build to another machine.

## Upgrading 1.3.0 to 1.4.0

Version 1.4.0 adds no database migration, binding, secret, cron trigger, or reseeding step.
Back up as usual, run `npm ci`, rebuild, and deploy with your normal process.

The new `checkin`, `volunteer-scheduling`, and `small-groups` presets only affect new
installations. An existing installation keeps its recorded preset and module settings; turn
modules on or off in **Settings → Modules** as before.

## Upgrading 1.4.0 to 1.5.0

Version 1.5.0 adds forward migrations `0039` and `0040` on both backends. Apply them in order
before deploying: on D1, `0039_member_portal_d1.sql` and `0040_service_planning.sql`; on
Supabase, `0039_giving_production.sql` and `0040_service_planning.sql`. Run `npm ci` so the new
`qrcode-generator` dependency is installed. Member Portal and Service Planning stay off on an
existing installation until an administrator turns them on, and Stripe stays in test mode until
you opt into live mode. The sections below give the details.

### Member Portal on D1

The Member Portal now runs on the default Cloudflare D1 database. This adds one forward D1
migration, `migrations/0039_member_portal_d1.sql`, which creates the `group_files` and
`prayer_items` tables (each with `campus_id`). On an existing installation it also records
`module.portal = 0` when no portal choice is saved yet, so upgrading does not turn the portal
on by itself. It changes no other table or row.
Supabase installations are unaffected: there is no PostgreSQL migration and their
behavior does not change.

For a D1 installation, back up as usual and apply the new migration with your normal D1
migration step (`npm run db:migrate:remote`) **before** deploying the new build. Previously
the portal was force-disabled on D1. After upgrading it stays off until an administrator
turns on Member Portal in **Settings → Modules**. On D1 the
event-scope prayers, event administrators, and My registrations stay unavailable because
they depend on Registration, which remains Supabase-only.

### Production Giving

This adds one forward PostgreSQL migration, `migrations-supabase/0039_giving_production.sql`,
for installations with Giving. D1 has no Giving tables and no new D1 migration is needed for it.

1. Back up the Supabase database as usual (see section 2).
2. Apply the migration with your normal Supabase migration step **before** deploying the new
   build. It adds gift columns, widens the gift method/status and recurring interval checks, and
   creates `stripe_customers`, `giving_statement_outbox`, and `giving_audit_events`. It marks
   existing manual (check/cash) gifts as live, leaves existing Stripe gifts as test, and
   backfills each Stripe gift's `paid_at` from its creation time.
3. Deploy. The installation stays in **test mode**; nothing changes for donors until you opt
   into live mode. `STRIPE_MODE` accepts `test` or `live`; live also requires
   `STRIPE_LIVE_CONFIRMED=1`, a live key, and a live webhook secret.
4. Update the Stripe webhook endpoint's events to the twelve listed in
   [`supabase-setup.md`](supabase-setup.md#7c-the-webhook-endpoint), at API version
   `2025-03-31.basil`. Run `npm run doctor`; it warns when stored events came from another API
   version.
5. Before going live, follow the go-live checklist in `supabase-setup.md` (it includes draining
   Registration checkout requests that are still in `creating`).
6. Re-running setup on a live installation preserves the live opt-in in `wrangler.jsonc`.

There is no new cron trigger: annual statements are delivered by the existing five-minute job.
To roll back the application, redeploy the previous build; the new columns and tables are
additive and the previous build ignores them (it only reads the widened constraints' old values).
### Service Planning

Service Planning adds one forward migration on each backend, `migrations/0040_service_planning.sql`
(D1) and `migrations-supabase/0040_service_planning.sql` (Supabase). It creates
`planning_events`, `planning_event_coordinators`, `planning_items`, `planning_sessions`,
`planning_session_people`, `availability_windows`, and `planning_notification_rules`, seeds the
four default notification rules for the main campus, and adds five identity-merge reference keys.
On an existing installation it also records `module.planning = 0` when module choices or people
already exist, so upgrading does not switch the module on. It changes no other table or row.

1. Back up as usual (see section 2).
2. Apply the migration with your normal step, **before** deploying the new build:
   `npm run db:migrate:remote` (D1) or `npm run db:migrate:supabase` (Supabase). On Supabase, `0039` is
   Production Giving above; apply the files in order and do not renumber either.
3. Deploy. The module is off until an administrator turns on **Service Planning** in
   **Settings → Modules**. Grant the **Service planning** area on a person's page to let a limited
   admin manage events; event coordinators need no admin access.
4. Optional: open **Admin → Service planning** and review the notification rules. Reminders are sent
   by the existing daily reminder job; no cron trigger, binding, or secret is added.

No preset changes, so an installation's recorded module list stays valid.

## Upgrading 1.5.0 to 1.6.0

Version 1.6.0 adds twelve interface languages. Apply the new forward migrations before
deploying: on D1, `0041` through `0049`; on Supabase, `0041_supported_locales.sql`. There is no
new binding, secret, cron trigger, or dependency. Upgraded installations keep exactly English and
Chinese, with English as the default, until an administrator turns on more languages in
**Settings → Languages**. The sections below give the details.

### Language settings

- **No migration for the settings themselves.** Choosing languages stores two settings rows; the
  database change that lets more languages be stored is described in
  [Language lookup migrations](#language-lookup-migrations).
- **Upgraded installations keep English and Chinese, with English as the default,** until an
  administrator saves **Settings → Languages**. Nothing new appears and no behavior changes
  before then.
- **A legacy `locale.default` row is ignored until then.** It was never read at runtime; only an
  installation that has saved the new settings (the `locale.enabled` row exists) uses
  `locale.default`.
- **New setup flags:** `--locales en,zh` and `--default-locale en`. `--locale x` alone keeps its
  earlier meaning (English and Chinese enabled, `x` the default); `--locales` narrows or widens
  the set and wins when both are given. Setup manifests and onboarding preferences move to
  `schemaVersion: 2`; version 1 files are still read.
- **Disabling a language never deletes content.** It only hides the language; translations stay
  stored and reappear when it is enabled again.

### Language lookup migrations

Every locale column used a hard-coded `CHECK (locale IN ('en','zh'))`. A new `supported_locales`
table now holds the allowed language codes (seeded with `en`, `zh`, `es`, `pt`, `fr`, `de`, `ja`,
`ko`, `ms`, `id`, `vi`, `hi`) and the locale columns reference it, so adding a language later is
an `INSERT`, not a schema change. An upgraded installation still offers only English and Chinese
until an administrator enables more languages (see [docs/i18n.md](i18n.md)). **No data changes, no new
binding or secret, and no behavior changes** for existing content.

- **D1: nine forward migrations, `0041` to `0049`.** `0041_supported_locales.sql` creates and
  seeds the table. `0042` replaces the `people.lang` constraint in place; `0043` to `0049` rebuild
  the `*_i18n`, `testimonies`, `prayer_sheets`, `email_templates`, newcomer, recovery notification,
  and giving/registration continuation tables (SQLite cannot alter a `CHECK`), recreating every
  index and trigger unchanged. Each file is one transaction, so a failure leaves the database as
  it was and the migration can simply be re-run. **Back up first** (section 2 above) and apply
  with the normal migration step before deploying the new code:

  ```sh
  npx wrangler d1 migrations apply DB --remote --config <staging-or-production-config>
  ```

  Rebuilds copy every row once, so the time grows with table size. For a typical church the
  largest rebuilt table (`newcomer_submissions`) holds a few thousand rows and each file is
  expected to finish quickly; time it on a staging copy first. `people` is not rebuilt (its column is replaced in place), and rows in
  tables that reference the rebuilt ones are untouched.
- **Supabase/PostgreSQL: one migration, `0041_supported_locales.sql`.** It creates and seeds the
  table, then drops each unnamed locale `CHECK` and adds a named foreign key
  `<table>_<column>_locale_fk`. No table is rewritten; PostgreSQL validates the existing rows,
  which are all `en` or `zh`. Apply it with `npm run db:migrate:supabase`.
- **Order.** Apply the migrations before enabling any additional language. Code that still
  writes only `en`/`zh` works against either schema.
- **Recovery.** There is no down migration. Restore the pre-upgrade backup as in section 5 if you
  must go back.

## Upgrading 1.6.0 to 1.7.0

Version 1.7.0 is about event registration. Free events now run on Cloudflare D1, people can
register as a household or group, staff get an event builder and a back office with a phone
check-in desk, and an optional Event Logistics module handles rooms, tables and small groups.
Apply the new forward migrations in order before deploying: on D1, `0050` through `0054`; on
Supabase, `0042` through `0046`. Back up first (section 2 above). There is no new secret, binding
or cron trigger; the only new dependency is `jsqr` for the check-in desk scanner. Event Logistics
stays off after the upgrade until an administrator turns it on. The sections below give the
details.

### Registration on D1

- **Apply `migrations/0050_registration_d1.sql`** with your normal D1 step
  (`npm run db:migrate:remote`, or the `wrangler d1 migrations apply` command above) before
  deploying the new build. It creates the Registration tables, plus `group_reg_events` and
  `event_admins`, which the Member Portal's event prayers and the event-admins panel use.
- **Registration stays off after the upgrade.** On a database that already has data, the
  migration records `module.registration = 0`. An administrator turns it on in
  **Settings → Modules** when ready. A fresh install follows the module choice made in setup.
  An explicit saved choice is never changed.
- **Free events only on D1.** The price field is disabled and a priced event is refused. Paid
  events still need Supabase and Stripe.
- **Setup doctor** now expects the registration tables, `group_reg_events`, and
  `event_admins` on D1. Run the migration before running doctor.
- **Identity merge:** on D1, a person who is an event admin cannot be merged away. The merge
  shows a conflict, as it already did on Supabase.

### Registration on Supabase (PostgreSQL)

- **Apply `migrations-supabase/0042_registration_v2.sql`** with `npm run db:migrate:supabase`.
  It adds the new columns and fills them in for registrations you already have: a legacy
  idempotency key, one attendee row each, and a confirmation number per event such as
  `R26-0001`, counted in registration id order. Each event's next number is set after the
  last one. Existing registrations keep their status and answers. Back up first: the
  migration updates every registration row.
- **CSV export columns changed.** The roster CSV is now: Confirmation, Name, Email, Status,
  Party size, Amount, Registered, then one column per question. If a script or spreadsheet
  reads the old export by column position, update it.
- There is no down migration. Restore the pre-upgrade backup as in section 5 if you must go back.

### Registration party flow and emails

This part adds groups, a review step, emails, a private manage page, and automatic waitlist
promotion. It adds one more migration on each database and no new binding or cron trigger.

- **Apply the migrations** before deploying: D1 `migrations/0051_registration_party.sql`
  (`npm run db:migrate:remote`) and Postgres `migrations-supabase/0043_registration_party.sql`
  (`npm run db:migrate:supabase`). They add columns only, with no backfill. Existing events
  stay at 1 person per registration with self-service on. Existing registrations have no
  private link.
- **Secrets.** The private page's API needs `NEWCOMER_RATE_LIMIT_SECRET`. Setup generates it. If
  it is missing, the page says "can't load right now". Signed-in member sign-ups need the
  `IDENTITY_SOURCE_KEY_*` secrets, which setup manages. Re-run setup if unsure.
- **Time zone.** Registration pages and the admin events list now show church time. They showed
  UTC before.
- **Daily cron.** The `0 13 * * *` job also retries confirmation emails that did not send. The
  first run after the upgrade does not email people who registered before it.
- **Email.** Sending needs the Cloudflare email binding, as for other emails. Links in emails
  end in `?campus=<slug>`. A newer email's link replaces the link from an older one.
- **QR images.** `/register/qr/...` is public and cacheable. It encodes only the confirmation
  number.
- **CSV.** **People** and **Phone** are added as the last columns. Earlier columns keep their
  order.
- **Paid cancellations** do not refund automatically. Refund in Stripe.
- No down migration. Restore the pre-upgrade backup as in section 5 if you must go back.

### Registration form builder, ticket types and templates

This part adds the form builder, ticket types, per-person questions, templates, and the
page-builder Registration block. It adds one more migration on each database. There is no new
secret, binding, or cron trigger.

- **Apply the migrations** before deploying: D1 `migrations/0052_registration_builder.sql`
  (`npm run db:migrate:remote`) and Postgres `migrations-supabase/0044_registration_builder.sql`
  (`npm run db:migrate:supabase`). Back up first. Existing option text for dropdown and
  checkbox questions becomes option keys, with the old text copied as the labels. Stored
  answers are not rewritten, and existing events behave as before.
- **CSV.** **Ticket types** (only for events that have them) and one column per per-person
  question are added at the end. Earlier columns keep their order.
- **Admin editor.** The question editor is now a React island. It loads on admin pages only.
  Public pages are unchanged.
- **Paid tickets** need Postgres (Supabase) and Stripe. On D1 ticket prices must be free.
- No down migration. Restore the pre-upgrade backup as in section 5 if you must go back.

### Registration back office

This part adds the event page for staff (overview, roster, detail panel, approval, adding
registrations by hand, duplicates, reminder and bulk emails), the check-in desk, badges and a
sign-in sheet, refunds on Postgres, and access to one event. It adds one more migration on each
database. There is no new secret, binding, or cron trigger.

- **Apply the migrations** before deploying: D1 `migrations/0053_registration_back_office.sql`
  (`npm run db:migrate:remote`) and Postgres
  `migrations-supabase/0045_registration_back_office.sql` (`npm run db:migrate:supabase`). Back
  up first. They add columns with defaults and four new tables (`reg_checkins`, `reg_activity`,
  `reg_event_access`, `reg_outbox`). The one backfill sets `payment_method = 'stripe'` on every
  registration that has a Stripe Checkout session. Existing events do not require approval and
  send no reminders until you turn those on.
- **Setup doctor** now also expects `reg_checkins`, `reg_activity`, `reg_event_access`, and
  `reg_outbox`. Run the migration before running doctor.
- **Existing cron jobs carry the new email.** The daily `0 13 * * *` job also sends event
  reminders, up to 40 per run. The hourly `0 * * * *` job also sends queued bulk email, up to
  60 per run. The rest wait for the next run.
- **New dependency.** `jsqr` reads QR codes on the check-in desk when the browser has no
  built-in reader. It loads only on the desk page. Run `npm ci` before building.
- **Access to one event.** People given a role on one event can open
  `/admin/registration/<id>` (with its CSV exports, badges, and sign-in sheet) or
  `/admin/registration/<id>/checkin`, and nothing else in the admin area. The site checks the
  role before the page runs. Per-event viewers and registrars can download their event's CSV.
- **Identity merge.** A person who holds a role on one event is a hard conflict in the merge
  tool, the same as an event admin. Remove the role first.
- **CSV.** Both roster exports now start with a UTF-8 byte-order mark so Excel shows accents and
  Chinese correctly. The columns of the existing export are unchanged. A script that reads the
  first column header may need to strip the mark. A new **Export people (CSV)** gives
  one row per person.
- **Refunds.** On Postgres with Stripe, staff with payment operations can refund from the
  registration's detail panel. Refunds made in the Stripe dashboard are recorded through the
  `charge.refunded` event you already send. Nothing to configure.
- No down migration. Restore the pre-upgrade backup as in section 5 if you must go back.

### Registration event logistics

This part adds the optional **Event Logistics** module: rooms, tables with Auto-seat, small
groups, tags, and their prints on a registration event's page. See
[Event logistics](features/event-logistics.md). It adds one more migration on each database.
There is no new secret, binding, cron trigger, or dependency.

- **Apply the migrations** before deploying: D1 `migrations/0054_registration_logistics.sql`
  (`npm run db:migrate:remote`) and Postgres
  `migrations-supabase/0046_registration_logistics.sql` (`npm run db:migrate:supabase`). Back up
  first. They add defaulted columns to `reg_events` (every switch starts off) and ten new tables
  (`reg_tags`, `reg_attendee_tags`, `reg_venues`, `reg_room_types`, `reg_rooms`,
  `reg_room_assignments`, `reg_tables`, `reg_table_seats`, `reg_groups`, `reg_group_members`).
  There is no backfill. Existing events and registrations behave as before.
- **The module stays off after the upgrade.** On a database that already has data, the
  migration records `module.event-logistics = 0`. An explicit saved choice is never changed. A
  fresh install follows the module choice made in setup, and no preset includes it.
- **To turn it on:** a super admin ticks **Event Logistics** in **Settings → Modules** (Registration
  must be on too). Then edit each event that needs it and, in its **Rooms, tables and groups**
  section, turn on **Housing (rooms)**, **Tables (seating)**, **Small groups**, and, if wanted,
  **Show registrants their room, table and group**.
- **Setup doctor** now also expects the ten new tables. Run the migration before running doctor.
- **Access to one event.** Per-event viewers and registrars can also open the event's room list,
  door signs, table list, table cards, and group list (names only). Viewers see the Housing,
  Tables, and Groups tabs without changing anything. Check-in desk volunteers see each person's
  room and table on the desk.
- **Identity merge.** Who placed a person in a room, at a table, or in a group is kept as history
  (`historical_preserve`). There is no new merge conflict.
- No down migration. Restore the pre-upgrade backup as in section 5 if you must go back.
