# Pre-1.0 release process

Church4Christ currently develops before a stable `1.0` contract. Future `0.x` releases are
maintainer-created checkpoints for operators who need a reviewed source revision and explicit
upgrade notes. They do not make the private package publishable, promise managed upgrades, or
remove the need to test custom implementations.

No release is created merely because `package.json` currently says `0.1.0`. The changelog
baseline is commit `20b67f3`; a version becomes a release only when a maintainer completes the
process below and deliberately creates an immutable tag and corresponding GitHub Release.

## What belongs in a checkpoint

A checkpoint should make the cost of maintaining a customized church-management system and
website easier to understand and control. Before selecting a version, summarize operator
impact under `Unreleased` in [`CHANGELOG.md`](../CHANGELOG.md), including:

- database migrations or data-shape changes;
- configuration, bindings, environment variables, secrets, provider plans, or schedules;
- changed module defaults, access rules, import/export behavior, or operational limits;
- deployment, backup, restore, monitoring, or manual follow-up steps;
- user-visible additions, fixes, security changes, removals, and known limitations.

Do not edit, rename, delete, or reorder a migration once it is merged into `main` or applied to
a persistent, shared, or deployed installation; waiting for a tag or GitHub Release is too
late. Before merge, a proposed migration applied only to disposable local or CI databases may
still change after those databases are reset or rebuilt. Merge to `main` establishes the
permanent boundary even when no deployed installation has applied it. Files `0001` through
`0012` in both `migrations/` and `migrations-supabase/` are the frozen current `main` baseline.
Create a new, numbered, forward migration for every correction. Never manufacture migration
history by editing D1's `d1_migrations` table or Supabase/Postgres's `_migrations` table.

## Prepare the release pull request

1. Choose the next semantic pre-1.0 version (`0.x.y`) based on compatibility and operator
   impact. A breaking change can require a new `0.x.0` checkpoint while compatible fixes can
   use `0.x.y`.
2. Move the reviewed `Unreleased` entries into a dated version section and create a new empty
   `Unreleased` section. Link the upgrade notes for any change requiring operator action.
3. Update the private package metadata without creating a tag:

   ```bash
   npm version 0.x.y --no-git-tag-version
   ```

   Review both `package.json` and `package-lock.json`. Keep `"private": true`; this repository
   does not publish an npm package.
4. Run the release-candidate checks from a clean install. The final doctor command must run
   with the candidate deployed to representative staging resources, not against production:

   ```bash
   npm ci
   npm run docs:check
   npm run tokens:check
   npm test
   npm run check
   npm run build
   npm run doctor -- --strict
   ```

   Run backend-specific integration and end-to-end suites when the checkpoint affects those
   paths. Rehearse [`upgrade.md`](./upgrade.md) against representative staging backups.
5. Open a release-preparation pull request containing only reviewed release metadata, notes,
   and any necessary fixes. Merge it only after required CI and review are green.

`npm version --no-git-tag-version` prepares metadata; it does not authorize or create a tag or
GitHub Release.

## Create the immutable checkpoint

After the release-preparation pull request is merged and the exact `main` commit has green CI,
a maintainer must explicitly:

1. verify that the commit contains the intended version and changelog section;
2. create an annotated `v0.x.y` tag on that exact commit;
3. push the tag without force;
4. create the GitHub Release from the matching changelog text and link the upgrade runbook;
5. verify the published tag and Release both resolve to the reviewed commit.

Tags and published release notes are immutable records. Never move, replace, or force-push a
release tag, and never silently rewrite released migration history or artifacts. Correct an
error with a new commit and, when needed, a new pre-1.0 checkpoint.

There is intentionally no repository automation that versions, tags, publishes, deploys, or
migrates production on merge. Those are explicit maintainer and operator decisions.
