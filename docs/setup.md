# Set up Church4Christ

This is the starting point for both people and AI coding agents. Use one installer to
choose features, initialize the database, configure the site, and create the first admin.
Start with a local preview; deployment uses the same installer with real infrastructure.

## Choose your path

| Goal | Mode and preset | What you need |
| --- | --- | --- |
| Explore the website and community features | Local / `website-community` | Git, Node.js 22.22.1+, npm; no hosted account |
| Start a smaller publishing site | Local / `website` | Same local tools |
| Explore all modules, including Portal, Giving, Registration | Local / `full-church` | The local tools plus a compatible PostgreSQL database |
| Put a church online | Deploy / chosen preset | Cloudflare account, church details, origin, admin email; Supabase for Full Church |
| Update an existing church installation | Upgrade | Follow [the upgrade runbook](upgrade.md), preserving data and configuration |

Use a fresh checkout for first setup. If `church.config.json`, `.church/setup-state.json`,
or an existing church database is present, inspect it before applying a new plan. Setup
is resumable, but changing the content flag is not a database reset or an upgrade plan.

On Windows, WSL2 with a Linux checkout is the recommended environment for the complete
installer. Native PowerShell supports the CLI and local application, but Node can reject
the installer's parent-directory `fsync` with `EPERM`. If that occurs, preserve the partial
installation and use the recovery guidance below; do not force a reset. The repository
keeps setup scripts and its Wrangler baseline in LF format through `.gitattributes`.

## People: run the guided installer

```sh
git clone https://github.com/leveo/church4christ.git
cd church4christ
npm ci
npm run setup
```

Choose **Local**, **Website + Community**, and **Include demo content** to explore the
application. Enter a church name, a lowercase site slug, language, and first-admin name
and email. For a new church's own installation, choose **No demo content** instead.
Both choices retain the bundled design and default decorative images.

The installer prints the selected features, readiness findings, administrator email,
site URL, and next command. For local D1, that command is:

```sh
npm run dev
```

Open the printed address and `/admin`. Local setup writes the selected administrator's
email as `AUTH_DEV_BYPASS_EMAIL` in `.dev.vars` for automatic sign-in. To test passwordless
sign-in, remove that local bypass and request a link with the same email; local email
delivery logs the link instead of sending mail. Follow the server's printed log instructions.

If dependencies were installed with `npm ci --ignore-scripts`, run `npm run tokens`
before setup or the development server.

## AI agents: use complete, machine-readable commands

Read [AGENTS.md](../AGENTS.md), inspect the checkout, and collect the inputs below.
The example values are for a disposable local evaluation, not a production church.

| Input | Example / choice |
| --- | --- |
| Mode and features | `local`, `website-community` |
| Site identity | `demo-church`, `Demo Church` |
| Default language | `en` or `zh` |
| First administrator | `First Admin`, `admin@example.com` |
| Local origin and sender | `http://localhost:4321`, `admin@example.com` |
| Initial content | Explicitly choose `--demo-data` or `--no-demo-data` |

After `npm ci`, preview the plan. This single-line command works in Bash and PowerShell:

```sh
node scripts/setup/index.mjs --mode local --preset website-community --site-slug demo-church --church-name "Demo Church" --locale en --admin-email admin@example.com --admin-name "First Admin" --app-origin http://localhost:4321 --email-from admin@example.com --demo-data --yes --dry-run --json
```

Expect a JSON object with `schemaVersion: 1`, `kind: "setup-plan"`, and `plan`.
Check its backend, modules, content choice, and proposed steps. Then apply the same inputs:

```sh
node scripts/setup/index.mjs --mode local --preset website-community --site-slug demo-church --church-name "Demo Church" --locale en --admin-email admin@example.com --admin-name "First Admin" --app-origin http://localhost:4321 --email-from admin@example.com --demo-data --yes --json
```

Use the direct Node entry point for JSON stdout; npm's equivalent is
`npm run --silent setup -- ... --yes --json`. Inspect stderr on a nonzero exit. Setup can
finish provisioning and return a `setup-result` with a nonzero doctor exit code; inspect
that result before deciding to rerun provisioning. Read `doctor` and `handoff`, including `startCommand`,
`url`, `adminEmail`, `capabilities`, and `limitations`. Start the server with that handoff.
Do not infer that provisioning success means all operational checks passed.

For local Supabase, set `SUPABASE_DB_URL` in the process environment before setup. The
server additionally requires `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`
in its host environment, outside `.dev.vars`. See [Supabase setup](supabase-setup.md).
Do not paste database credentials into an agent prompt or command argument.

## Check that setup worked

```sh
npm run doctor
node scripts/setup/index.mjs --doctor --json
```

1. The returned backend and enabled modules match your chosen plan.
2. The printed site URL loads, and `/en/` and `/zh/` show the expected initial content.
3. `/admin` opens for the first administrator; navigation matches enabled modules.
4. `/admin/onboarding` lists current readiness findings and the remaining manual checks.
5. For demo content, the sample records and media render; for no demo content, business
   lists start empty while the design and administrator tools remain available.

Doctor's normal mode fails on error-level required actions. Strict mode also fails on
warning-level required actions and manual checks:

```sh
node scripts/setup/index.mjs --doctor --strict --json
```

Manual checks are expected in a local evaluation. Production requires actual email,
route, scheduled-job, backup, and restore verification. Use the
[launch readiness workflow and screenshot](features/onboarding-readiness.md).

## Know what the installer writes

| Artifact | Purpose |
| --- | --- |
| `church.config.json` | Non-secret installation manifest and chosen resources |
| `wrangler.jsonc` | Generated Worker and resource bindings |
| `.church/setup-state.json` | Local resumable setup progress |
| `.dev.vars` | Local secrets and development settings; ignored by Git |
| Local D1/R2 state or selected PostgreSQL database | Schema, selected modules, initial content, and administrator |

`WRANGLER_PERSIST_TO` can isolate local D1/R2 state in a directory within the workspace;
use the same value for setup, doctor, and the dev server. The default is `.wrangler/state`.
Do not rerun raw seed SQL over an initialized database. The installer handles initial
content, module settings, and the administrator's audited identity together.

## Resolve a blocked setup

| Symptom | Next action |
| --- | --- |
| Missing answers in noninteractive mode | Supply the complete flags above; confirm supported flags with `node scripts/setup/index.mjs --help` |
| Unrecognized or modified Wrangler config | Inspect the proposed diff and existing installation; use `--force-config` only for an intentional replacement |
| Unresolved placeholders on a fresh Windows checkout | Ensure `wrangler.jsonc` has the LF line endings specified in `.gitattributes`; do not substitute fake resource IDs |
| `EPERM` while syncing a parent directory on native Windows | Preserve generated files and state, inspect what completed, and continue in a supported Linux/WSL filesystem environment; do not delete the database |
| Interrupted setup | Keep `.church/setup-state.json` and rerun the same plan; inspect any error before changing inputs |
| Existing people block demo seeding | Use a fresh workspace/database for demo evaluation; preserve existing people |
| Administrator identity conflict | Follow [identity review and recovery](features/member-identity.md); rerunning setup does not restore revoked access |
| Supabase database connection fails | Check the environment binding and database reachability using [Supabase setup](supabase-setup.md) |
| Doctor reports manual items | Verify the named behavior and record evidence; an acknowledgement is a record of review |

## Move from preview to deployment

Read [the deployment runbook](deploy.md) before choosing **Deploy**. Establish the target
Cloudflare account, origin, sender, feature preset, and first administrator. The deploy
installer can create remote resources and apply migrations; `npm run deploy` publishes
the application. Follow the user's deployment scope and the installer's concrete plan.
Keep demo evaluation separate from a production church's records.

For an agent handoff, report: **mode/backend, enabled features, content choice, actual URL,
administrator email, automated checks passed, manual checks remaining, and next command**.
This gives the next person or agent enough context to continue without reconstructing setup.
