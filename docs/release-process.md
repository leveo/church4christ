# v1.1.0 source release process

Church4Christ `v1.1.0` is a maintainer-created source checkpoint for operators who need a
reviewed revision and explicit Learning upgrade notes. Version `v1.0.0` remains the historical
initial open-source checkpoint. Neither version makes the private package publishable, promises
managed upgrades, or removes the need to test custom implementations.

No release is created merely because `package.json` currently says `1.1.0`. The immutable
upgrade-rehearsal baseline for 1.0.0 is commit
`b85ad362b9f879408797270929c52dab7ad39d1d`; a version becomes a release only when a maintainer
completes the process below and deliberately creates an immutable tag and corresponding GitHub
Release. The older changelog preparation baseline `20b67f3` is historical context, not the
rehearsal source.

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
permanent boundary even when no deployed installation has applied it.
The 1.0.0 boundary froze files `0001` through `0016` in both migration directories. Version 1.1.0
adds forward files `0017` through `0026`; review both backends for exact name/order parity, and treat
those files as
frozen once merged or applied. Create a new, numbered, forward migration for every correction.
Never manufacture migration history by editing D1's `d1_migrations` table or
Supabase/Postgres's `_migrations` table.

## Prepare the release pull request

1. Confirm that the release target is exactly `v1.1.0` and that the 1.0.0 → 1.1.0 rehearsal
   covers `0017_learning.sql` through `0026_activity_score_learning.sql` on both backends.
2. Move the reviewed `Unreleased` entries into a dated version section and create a new empty
   `Unreleased` section. Link the upgrade notes for any change requiring operator action.
3. Update the private package metadata without creating a tag:

   ```bash
   npm version 1.1.0 --no-git-tag-version
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
   npm run release:rehearse
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
2. create an annotated `v1.1.0` tag on that exact commit;
3. push the tag without force;
4. create the GitHub Release from the matching changelog text and link the upgrade runbook;
5. verify the published tag and Release both resolve to the reviewed commit.

Tags and published release notes are immutable records. Never move, replace, or force-push a
release tag, and never silently rewrite released migration history or artifacts. Correct an
error with a new commit and, when needed, a new versioned release.

There is intentionally no repository automation that versions, tags, publishes, deploys, or
migrates production on merge. Those are explicit maintainer and operator decisions.
