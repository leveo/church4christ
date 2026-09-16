# Working in Church4Christ

## Start here

For installation work, read [docs/setup.md](docs/setup.md) first. It is the shared
setup contract for people and AI agents, including complete noninteractive commands,
expected output, readiness checks, and recovery steps. Use the existing installer;
do not invent a second provisioning path or replace setup with raw seed commands.

- Inspect `git status --short` and whether `church.config.json` or `.church/setup-state.json`
  already exists. An established installation follows [docs/upgrade.md](docs/upgrade.md).
- For a new local evaluation, use D1 with `website-community` and fictional demo data
  unless the user chooses otherwise. Full Church / Portal / Giving / Registration need
  Supabase-compatible PostgreSQL; ask for missing deployment inputs when needed.
- Use `node scripts/setup/index.mjs --help` to verify supported flags. For automation,
  pass complete answers with `--yes --json`; `--dry-run` returns the plan before applying it.
- Read the returned `handoff` and doctor checks. Report the actual URL, administrator,
  selected features, completed checks, and unresolved operational items.
- Local evaluation does not authorize production provisioning or deployment. Preserve
  existing configuration and data; follow the user's authorized scope for external actions.
- Keep secrets in environment variables or documented bindings, outside prompts, source,
  screenshots, and logs. `.church/`, `.dev.vars`, and `superpowers/` are local artifacts.

## Repository map

| Concern | Source |
| --- | --- |
| Setup CLI, plan, provisioning, handoff | `scripts/setup/` |
| Feature catalog and presets | `config/capabilities.json` |
| Shared readiness checks | `config/readiness.json` |
| Generated deployment config template | `config/wrangler.template.jsonc` |
| Feature behavior and visuals | `docs/features/` |
| D1 / PostgreSQL forward migrations | `migrations/` / `migrations-supabase/` |
| Bilingual UI copy | `src/i18n/en.ts` / `src/i18n/zh.ts` |
| Design tokens | `design/`; see `docs/design-system.md` |

## Validation and handoff

Use [CONTRIBUTING.md](CONTRIBUTING.md) for implementation rules. Keep UI dictionaries
in parity and use design tokens. Add meaningful tests for changed behavior. Run focused
tests for the touched paths; use `npm run check` and `npm run build` for application changes.
For feature catalog documentation, run `npm run docs:generate` and `npm run docs:check`.
Keep the LF line endings specified in `.gitattributes`; setup recognizes the checked-in
Wrangler baseline by its fingerprint. Run `npm run doctor` after installation, and report
manual checks separately from automated results. Do not describe local fixtures as proof
of live email delivery, payment processing, or provider synchronization.
