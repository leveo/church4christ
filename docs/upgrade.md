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
     npx wrangler d1 export <database-name> --remote --output=church4christ-before-upgrade.sql
     ```

   - Supabase/Postgres: use the provider backup or `pg_dump` with a connection URL supplied
     through the environment, never committed to the repository:

     ```bash
     pg_dump --format=custom --file=church4christ-before-upgrade.dump "$SUPABASE_DB_URL"
     ```

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

Apply only the forward migrations for the selected staging backend:

```bash
# D1 staging, using its staging Wrangler environment/configuration
npm run db:migrate:remote

# Supabase/Postgres staging; keep the URL in the environment
SUPABASE_DB_URL=postgres://... npm run db:migrate:supabase
```

Do **not** run `npm run db:seed:local`, `npm run db:seed-media:local`, or
`npm run db:seed:supabase` in production. Seed data is for disposable local development and
tests; it is not an upgrade step.

Deploy the target revision to staging, exercise sign-in and the church's critical workflows,
then require the strict readiness check to pass:

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
2. apply all pending migrations for the selected backend with
   `npm run db:migrate:remote` (D1) or
   `SUPABASE_DB_URL=postgres://... npm run db:migrate:supabase` (Supabase/Postgres);
3. deploy the exact reviewed source revision with `npm run deploy`;
4. run `npm run doctor -- --strict` against production configuration;
5. smoke-test sign-in, public pages, admin access, media, email, and the workflows the church
   depends on;
6. record the deployed revision, migration result, verifier, and completion time.

Migration runners are forward-only. Never edit, delete, rename, reorder, or manually mark an
already-applied migration. In particular, do not rewrite D1's `d1_migrations` table or the
Supabase runner's `_migrations` table. Investigate a mismatch and add a new forward migration
when correction is needed.

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
