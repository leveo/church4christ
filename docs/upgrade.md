# Upgrading an existing installation

This runbook is for an installation that already has church data, uploaded media, and
deployment configuration. It is intentionally separate from first-time setup. Church4Christ
uses versioned releases, but interfaces and operating requirements may still change, so review
[`CHANGELOG.md`](../CHANGELOG.md) and the exact source diff before every upgrade.

An upgrade is an operator-reviewed deployment, not an unattended command. Keep a technical
owner responsible for backups, staging, schema changes, secret handling, verification, and
recovery.

## 1. Identify what will change

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
