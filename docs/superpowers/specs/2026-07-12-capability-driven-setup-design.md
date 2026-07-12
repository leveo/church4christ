# Capability-Driven Setup Foundation — Design

Date: 2026-07-12
Status: Ready for owner review

## Goal

Make Church4Christ straightforward to initialize without asking a church to understand
its database architecture first. A user chooses the capabilities they want, the setup
system derives a compatible D1 or Supabase backend, creates a reproducible configuration,
initializes the application, and reports whether it is ready to run.

This is the foundation required before building `church4christ-demo`. The demo directory
is explicitly out of scope for this design and must remain untouched until the foundation
is implemented and verified.

## Why this work is needed

The application already has a broad, well-tested CMS and a runtime module registry, but
setup and product claims have drifted away from the implementation:

- module selection happens only after database setup, deployment, first-admin SQL, and
  sign-in;
- the 16 runtime modules are described inconsistently as 15 in code comments and docs;
- `portal`, `giving`, and `registration` are Supabase-only, while several onboarding
  documents say only Giving and Registration require Supabase;
- no supported setup, config-generation, preflight, or first-admin command exists;
- absent module settings mean every compatible module starts enabled;
- the documented promise that a D1 installation can switch to Supabase later without
  losing data has no migration implementation.

The baseline is otherwise healthy: the review run completed 1,108 tests with 107
Postgres-dependent tests skipped when no Postgres URL was present, and `astro check`
completed with zero errors. This design changes the onboarding contract rather than
replacing the existing CMS architecture.

## Scope and project decomposition

The complete path to the requested interactive demo is split into three independently
verifiable projects:

1. **Capability-driven setup foundation (this design):** authoritative capability
   metadata, interactive/noninteractive setup, backend resolution, generated config,
   first-admin bootstrap, readiness checks, documentation parity, and clean-room tests.
2. **Financial-event reliability hardening (separate design after project 1):** durable
   Stripe webhook receipt, idempotent processing, failure visibility, and replay for
   Giving and paid Registration.
3. **Full interactive demo (separate design after projects 1 and 2):** create
   `church4christ-demo` entirely through the supported setup path and verify every
   advertised capability.

Completing project 1 does not claim the overall demo goal is complete. It only establishes
the reusable setup contract on which the later projects depend.

## Approaches considered

### A. Declarative catalog plus setup CLI — chosen

One catalog describes capabilities and infrastructure requirements. A CLI reads the
catalog, asks outcome-oriented questions, resolves the backend, writes a manifest and
generated config, initializes storage, and runs readiness checks. The same CLI supports
flags and JSON output for CI and future demo generation.

This approach works before the application can boot, keeps interactive and automated
setup on one code path, and gives runtime module gating, docs, and tests one source of
truth.

### B. First-run browser wizard — rejected for initial provisioning

A browser wizard would be approachable after the Worker and database exist, but provider
selection and bindings must be configured before the Worker can serve the wizard. It
creates a bootstrap loop and would still require a second provisioning tool. A future
in-app onboarding checklist may consume the setup manifest, but it is not the source of
truth.

### C. Documentation-only presets — rejected

Copyable D1 and Supabase examples are inexpensive, but they preserve manual JSON edits,
cannot validate incompatible feature selections, and will drift as the module registry
changes. Documentation remains important, but executable setup and verification must
back its claims.

## Core decisions

### Users choose capabilities; the resolver chooses the database

The normal questionnaire never requires a user to choose a database. Resolution is
deterministic:

1. If any selected capability requires Supabase, choose `supabase`.
2. Otherwise choose `d1`.
3. An advanced explicit Supabase override is allowed for any selection.
4. An explicit D1 override with a Supabase-only capability is rejected before files or
   infrastructure are changed. The error lists every incompatible capability and the
   reason.

At initial release, Portal, Giving, and Registration require Supabase. The requirement
comes from the catalog, never from a second hard-coded list in the setup program.

### Feature selection configures behavior, not a reduced codebase

Setup installs the complete schema available for the selected provider and writes an
explicit `module.<key>` setting for every module. Selected modules receive `1`; unselected
modules receive `0`. This removes the ambiguous “absent means everything on” behavior for
new installations while preserving that legacy fallback for existing databases.

The generated project still contains all Church4Christ code. This keeps later module
toggles cheap, avoids partial-migration combinations, and ensures a demo is 100% based on
the CMS rather than a forked or pruned application.

### Configuration is reproducible and secrets stay separate

`church.config.json` is the safe, versioned setup manifest. It contains:

- manifest schema version;
- installation mode (`local` or `deploy`);
- stable site slug and non-secret church identity values;
- selected preset, if any, and the complete resolved module list;
- resolved database backend;
- selected locales and whether fictional demo data is requested;
- non-secret Cloudflare resource names and generated resource identifiers.

It never contains database passwords, Stripe keys, session secrets, Cloudflare API
tokens, or other credentials. Local-only secrets live in `.dev.vars`, which remains
gitignored. Production secrets are written through Wrangler's secret mechanism and are
never echoed in summaries or JSON output.

The existing hand-edited `wrangler.jsonc` becomes generated from a tracked template. A
generated-file marker identifies ownership. Setup may replace the repository's known
placeholder config on first use. It refuses to overwrite an unrecognized or locally
modified config unless the user explicitly approves after seeing a diff; noninteractive
mode requires `--force-config` for that case.

## Authoritative capability catalog

A machine-readable catalog is the source of truth shared by runtime code, setup, docs,
and tests. Each optional capability defines:

- stable module key and display order;
- English and Chinese setup labels and concise descriptions;
- questionnaire group and preset membership;
- public/admin route prefixes and navigation keys currently held in `MODULES`;
- soft relationships (`uses`) that improve another capability without forcing it on;
- hard dependencies, if a future capability cannot operate without another;
- required database backend, if not provider-neutral;
- required services such as R2, email, Stripe, Hyperdrive, or scheduled jobs;
- seed profile participation and readiness checks.

Provider definitions live beside the capability entries and describe base requirements
that are not optional modules. Catalog loaders validate duplicate keys, unknown
dependencies, dependency cycles, duplicate route ownership, unsupported providers, and
unknown service names.

`src/lib/modules.ts` remains the public runtime API (`MODULE_KEYS`, `MODULES`,
`moduleForPath`, and enablement helpers), but it derives its keys and definitions from the
validated catalog. Existing consumers do not need a new import surface.

The catalog describes all 16 current keys:

`bulletins`, `sermons`, `prayer-sheets`, `prayer-wall`, `events`, `serve`, `gifts`,
`testimonies`, `articles`, `fellowships`, `people`, `children`, `page-builder`, `portal`,
`giving`, and `registration`.

### Component boundaries

- `config/capabilities.json` is the canonical, data-only catalog consumable by both the
  Astro build and plain Node setup commands.
- `src/lib/capabilityCatalog.ts` validates and types the catalog for application code.
- `src/lib/modules.ts` adapts the catalog to the existing runtime module API and owns only
  enablement/cache behavior.
- `scripts/setup/` contains focused Node modules for argument/prompt collection, provider
  resolution, immutable plan construction, config rendering, apply steps, and doctor
  checks. Prompting does not perform mutations, and apply code does not make product
  decisions.
- `config/wrangler.template.jsonc` is the tracked template for generated
  `wrangler.jsonc`.
- `church.config.json` is the tracked, non-secret desired-state manifest.
- `.church/setup-state.json` is a gitignored, non-secret record of completed apply steps;
  setup verifies real state instead of trusting this file blindly.

The implementation may split focused files further, but it must preserve these ownership
boundaries. In particular, provider rules must not leak into prompts, docs generators, or
runtime route code.

## Setup experience

### Supported entry points

- `npm run setup` starts the interactive setup.
- `npm run setup -- --help` documents every flag without changing state.
- `npm run setup -- --preset <name> ... --yes` runs noninteractively when all required
  values are supplied.
- `npm run setup -- --dry-run` resolves and validates the plan but writes nothing and
  executes no external commands.
- `npm run doctor` validates the current manifest, generated files, database, schema, and
  feature-specific services.
- Both setup and doctor support `--json` with a stable, versioned result shape for CI and
  the later demo scaffolder.

### Questionnaire

The interactive flow is short and asks one decision at a time:

1. Local trial or deploy to Cloudflare.
2. Church identity, primary locale, and first-admin email.
3. Choose a starting point:
   - **Website:** public content, events, and basic CMS administration.
   - **Website + Community:** Website plus people/households, fellowships, prayer, serving,
     and children's check-in.
   - **Full Church:** every capability, which resolves to Supabase.
   - **Customize:** review every capability group.
4. Confirm the resolved capabilities, database, required accounts/services, and actions.

Preset membership is catalog data. The confirmation screen names the database only after
the user's capability choice and explains any Supabase requirement in product language.
Soft relationships are recommendations, not silently forced selections. Hard dependencies
are added visibly and included in the confirmation diff.

### Planning before mutation

Setup first constructs an immutable plan containing file changes, infrastructure checks,
database actions, seed actions, and bootstrap actions. Validation completes before the
first write. Interactive mode displays the plan and asks for confirmation. Noninteractive
mode requires `--yes`. A failed validation produces no partial setup state.

### Apply sequence

After confirmation, setup performs these steps in order:

1. Write `church.config.json` atomically.
2. Generate `wrangler.jsonc` and safe local configuration atomically.
3. Verify required command-line authentication and supplied connection information.
4. Create or verify supported Cloudflare resources; where an external dashboard action
   cannot be automated safely, pause before database mutation and print the single exact
   action required.
5. Apply the complete migration set for the resolved provider.
6. Load fictional demo data only when selected.
7. Upload/associate demo media through a provider-neutral media seed path when demo data
   is selected.
8. Write all module settings explicitly.
9. Create the first administrator idempotently.
10. Run the same doctor engine exposed by `npm run doctor`.
11. Print the start/deploy command, application URL, sign-in identity, enabled capability
    summary, and any optional follow-up integrations.

Each completed step is recorded in an atomic local setup-state file containing no
credentials. Rerunning setup reloads the manifest and state, recomputes the desired plan,
verifies actual external state, and performs only missing or changed actions.

## Local and deployed modes

### Local D1

The D1 path uses Wrangler's local D1 and R2 emulation. It requires no cloud account.
Setup generates safe localhost values, migrates and seeds the local database, seeds local
media, creates a fictional or user-supplied first admin, and finishes with `npm run dev`.

### Local Supabase-compatible Postgres

Full capability development needs Postgres. Setup accepts a local Postgres connection URL
or a Supabase development connection URL and configures the existing Hyperdrive-local
connection mechanism. It does not silently install Docker or create a database server.
If no connection is reachable, it stops before migration with concise instructions for
the supported local Postgres route and the option to rerun.

### Cloudflare D1 deployment

Setup checks Wrangler authentication, creates or reuses named D1 and R2 resources, writes
their identifiers into generated config, applies remote migrations, configures secrets,
and bootstraps the admin. Reuse requires matching resource names or explicit identifiers;
setup never guesses between multiple resources.

### Supabase deployment

The user supplies a Supabase Postgres connection URL through a secret prompt or supported
environment variable. Setup validates connectivity before migration, creates or verifies
the Cloudflare Hyperdrive binding, applies Supabase migrations, and configures the Worker.
Stripe is required only when Giving or paid Registration is intended to process payments;
the selected modules may initialize without Stripe, but doctor reports them as “configured
without payments” rather than fully ready. The final readiness summary distinguishes
working free-registration/offline-giving behavior from payment readiness.

## First administrator bootstrap

Bootstrap normalizes and validates the email, then behaves idempotently on both providers:

- if no person has the email, create an active admin;
- if an active admin already has the email, report success without changing it;
- if a non-admin person has the email, stop and require an explicit
  `--promote-existing-admin` confirmation;
- if an inactive person has the email, stop with a reactivation instruction rather than
  silently changing membership state.

Raw SQL is no longer part of the normal first-admin path. The operation is covered by the
same database seam and provider tests as application data access.

## Doctor and readiness model

Doctor runs checks in four layers:

1. **Manifest:** schema version, valid catalog keys, provider compatibility, dependency
   resolution, and safe identity values.
2. **Generated configuration:** no placeholder identifiers; correct D1/Hyperdrive, R2,
   email, origin, cron, and asset bindings; no deprecated local Hyperdrive variable.
3. **Database:** connectivity, expected provider, migration/schema version, explicit
   module rows, and first-admin presence.
4. **Capability services:** media bucket access, email configuration, Stripe key/webhook
   configuration when applicable, and scheduled-job requirements.

Every check returns a stable code, severity (`error`, `warning`, or `info`), human message,
and remediation. Errors produce a nonzero exit status. Warnings keep exit status zero
unless `--strict` is passed. Secret values are redacted at their source rather than after
formatting.

The readiness summary has three states:

- **ready:** all requirements for enabled behavior pass;
- **ready-with-limitations:** the site can run, but an explicitly described optional path
  such as Stripe payments or production email is unavailable;
- **not-ready:** startup, data integrity, authentication, or an enabled capability would
  fail.

## Error handling and recovery

- File writes use temporary files plus atomic rename. Setup retains a timestamped backup
  before replacing a recognized generated config with user-visible differences.
- External commands are invoked without a shell, use argument arrays, and redact secret
  input and output.
- Every failure identifies the failed step, unchanged/completed steps, and the exact rerun
  command. Reruns are the recovery mechanism; no destructive automatic rollback is
  attempted after external infrastructure creation.
- Migration failures stop before seed, module-setting, or admin actions. Existing migration
  transaction behavior remains authoritative for each provider.
- Unknown `DB_BACKEND` values become configuration errors. They no longer silently select
  D1.
- Setup never deletes databases, buckets, media, people, or content. Resource cleanup is a
  separate, explicit operation and is not part of this project.

## Existing installations and backend changes

Existing installations without `church.config.json` continue to boot with the current
runtime defaults. Running setup in an existing installation begins with an import step
that reads non-secret values, inspects module rows, and produces a proposed manifest. It
does not rewrite configuration or settings until confirmed.

This project does not implement D1-to-Supabase content migration. Documentation must stop
claiming that switching later preserves data automatically. If a user enables a
Supabase-only capability on an existing D1 installation, setup explains that a new
Supabase database or the future migration tool is required and makes no changes.

## Documentation contract

The README, deployment guides, architecture guide, and module guide must agree with the
catalog. Catalog-owned module counts, names, backend requirements, and preset tables are
generated into clearly marked documentation sections or checked structurally in tests.

The setup documentation leads with `npm run setup`; manual provider instructions remain
as troubleshooting/reference material. The following current inconsistencies are fixed as
part of this project:

- 15 versus 16 modules;
- two versus three Supabase-only modules;
- the Registration row mislabeled as Giving;
- omission of Portal from the module inventory;
- “everything starts on” versus explicit initial selection;
- the deprecated local Hyperdrive environment-variable name;
- the unsupported lossless backend-switch promise.

## Testing and verification

Implementation follows red-green-refactor. The required test layers are:

### Pure catalog and resolver tests

- all 16 expected keys load exactly once;
- routes and navigation metadata match runtime behavior;
- unknown dependencies, cycles, services, providers, and duplicate ownership fail;
- D1-compatible selections resolve to D1;
- Portal, Giving, or Registration resolve to Supabase;
- explicit Supabase override succeeds;
- incompatible explicit D1 override fails and lists every offender;
- presets resolve to stable, snapshot-free explicit module sets.

### Setup plan and file tests

- interactive answers and equivalent flags produce the same plan;
- dry-run performs zero filesystem or external-command mutations;
- generated manifest/config is deterministic and contains no secrets;
- unrecognized config changes are preserved and cause a safe refusal;
- rerunning an applied plan is a no-op;
- changing selected modules writes a complete explicit settings set;
- failures before confirmation leave the workspace unchanged.

### Provider integration tests

- a clean temporary checkout completes local D1 setup, migration, seed, media seed,
  bootstrap, and doctor;
- a clean temporary checkout completes Supabase/Postgres setup against CI Postgres;
- both providers bootstrap and rerun the same admin idempotently;
- incompatible and unreachable provider configurations fail before migration;
- Postgres parity checks cover tables, columns, types, defaults, constraints, indexes, and
  foreign keys for shared schema rather than tables/columns alone.

### Documentation and CI gates

- generated catalog sections are current and `git diff --exit-code` clean;
- README/setup commands run in clean workspaces;
- CI removes `--passWithNoTests` or separately asserts that expected projects and a
  nonzero minimum test count ran;
- unexpected unhandled errors fail E2E; any narrowly ignored known runtime signature is
  documented and tested;
- existing unit, D1 E2E, Postgres, type-check, build, token, and smoke gates remain green.

## Acceptance criteria

This foundation is complete only when all of the following are demonstrated from clean
workspaces:

1. A user can select a D1-compatible preset interactively and reach a running seeded local
   site without editing config or SQL.
2. A user can select Full Church and receive a Supabase plan automatically, complete setup
   against Postgres/Supabase, and reach a running site with all 16 module settings enabled.
3. Custom selection deterministically chooses the correct provider and rejects an
   incompatible D1 override before mutation.
4. Setup is rerunnable, dry-run is mutation-free, generated files are deterministic, and
   secrets never enter tracked files or logs.
5. Doctor accurately distinguishes ready, ready-with-limitations, and not-ready for both
   providers.
6. First-admin bootstrap works without raw SQL and is idempotent on both providers.
7. Module/runtime/docs/provider claims are derived from or verified against one catalog.
8. Existing installations remain boot-compatible and are never silently rewritten.
9. All existing and new quality gates pass with no unexpected ignored errors.
10. `church4christ-demo` has not been created or modified by this project.

## Explicitly out of scope

- creating or editing `church4christ-demo`;
- D1-to-Supabase data migration;
- deleting or pruning disabled module code or schema;
- automatically installing Docker, creating a Supabase account, or purchasing/configuring
  a domain;
- a browser-based first-run wizard;
- durable Stripe event storage/replay, which is the next hardening project;
- changing existing CMS feature behavior unrelated to setup correctness.

## Delivery sequence

1. Introduce and validate the capability catalog without changing runtime behavior.
2. Derive the runtime module registry and repair catalog-owned documentation.
3. Add provider resolution, manifests, plans, and deterministic config generation.
4. Add interactive and noninteractive setup flows with dry-run.
5. Add provider-neutral module initialization and admin bootstrap.
6. Add doctor/readiness checks and idempotent apply/recovery.
7. Add clean-room D1 and Postgres setup gates and strengthen parity/error gates.
8. Verify all acceptance criteria, then begin the separate financial-event reliability
   design. The demo project remains untouched.
