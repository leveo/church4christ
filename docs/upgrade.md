# Upgrading an existing installation

This runbook is for an installation that already has church data, uploaded media, and
deployment configuration. It is intentionally separate from first-time setup. Church4Christ
is pre-1.0: interfaces and operating requirements can change between `0.x` checkpoints, so
review [`CHANGELOG.md`](../CHANGELOG.md) and the exact source diff before every upgrade.

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
deployment has used it. Files `0001` through `0010` in `migrations/` and
`migrations-supabase/` are the frozen current `main` baseline. In particular, do not rewrite
D1's `d1_migrations` table or the Supabase runner's `_migrations` table. Investigate a mismatch
and add a new numbered forward migration when correction is needed.

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
