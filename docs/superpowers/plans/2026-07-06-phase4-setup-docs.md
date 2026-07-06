# Phase 4: Setup Docs & Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A church can choose D1 or Supabase at setup time by following docs alone; everything new is documented in the project's non-technical style.

**Architecture:** Pure docs + small config polish; no runtime code except what review flags.

**Spec:** `docs/superpowers/specs/2026-07-06-supabase-giving-registration-design.md`
**Depends on:** Phases 1–3 merged.

## Global Constraints

- Docs follow the existing voice: plain language for non-technical church admins (read `docs/cloudflare-setup.md` and `docs/deploy.md` first; mirror their structure, including the "AI assistant vs manual" dual path where it exists).
- Every command in the docs must be copy-pasteable and correct — actually run each one you can run locally.
- `npm test` + `npm run check` + `npm run build` green; commit per task.

---

### Task 1: `docs/supabase-setup.md`

**Files:** Create `docs/supabase-setup.md`; modify `docs/deploy.md`, `docs/cloudflare-setup.md`, `README.md` (database-choice fork + links).

Content outline (write fully, not as an outline):
1. **Which database should I pick?** — D1: zero extra accounts, simplest; Supabase: enables Giving + Registration (Stripe), standard Postgres. Feature table.
2. **Create the Supabase project** — dashboard steps, find the connection string (Session pooler URI for Hyperdrive origin), keep the database password.
3. **Connect Cloudflare to Supabase** — `wrangler hyperdrive create church4christ-db --connection-string="postgres://..."`, paste the id into the `hyperdrive` block in `wrangler.jsonc`, set `"DB_BACKEND": "supabase"`.
4. **Create the tables** — `SUPABASE_DB_URL=postgres://... npm run db:migrate:supabase` (+ optional `npm run db:seed:supabase` for the demo data).
5. **Secrets** — `wrangler secret put SESSION_SECRET` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`.
6. **First admin** — SQL editor INSERT (mirror the D1 version in `docs/deploy.md`).
7. **Stripe setup (for Giving/Registration)** — restricted API key, webhook endpoint `https://<your-site>/api/stripe/webhook` with the exact event list (`checkout.session.completed`, `checkout.session.expired`, `invoice.paid`, `charge.refunded`, `customer.subscription.updated`, `customer.subscription.deleted`), Customer Portal activation, test mode vs live mode.
8. **Optional: reconciliation (Stripe FDW)** — paste `migrations-supabase/9000_stripe_fdw.sql.example` into the SQL editor with the Vault-stored key, per the [Supabase Stripe wrapper docs](https://supabase.com/docs/guides/database/extensions/wrappers/stripe).
9. **Local development** — docker Postgres line, `.dev.vars` (`DB_BACKEND=supabase`), `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`.
10. **What stays on Cloudflare** — R2 media, email, crons; note the D1 nightly backup is replaced by Supabase's own backups.

- [ ] Write it; verify each runnable command locally; commit: `docs: supabase setup guide + database choice fork`

---

### Task 2: Architecture & feature docs refresh

**Files:** Modify `docs/architecture.md` (AppDb adapter diagram/paragraph, backend selection, module `requiresBackend`), `docs/why-this-stack.md` (a short "why two databases" note), `docs/i18n.md` if the new i18n table pattern needs a mention; verify `docs/features/giving.md` + `docs/features/registration.md` (from Phases 2–3) link from README and the docs index (`grep -rn "features/people" docs README.md` to find the pattern).

- [ ] Update; commit: `docs: architecture notes for the dual-database backend`

---

### Task 3: Final consistency pass

**Files:** as found.

- [ ] `CONTRIBUTING.md`: how to run the pg test project (docker one-liner + `DATABASE_URL`), and that giving/registration development requires it.
- [ ] `.dev.vars.example`: `DB_BACKEND`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` all present with comments.
- [ ] `wrangler.jsonc` comments point at `docs/supabase-setup.md`.
- [ ] Screenshots from Phases 2–3 exist in `docs/images/` and are referenced by the feature guides; capture any missing ones.
- [ ] zh status audit: run the i18n parity test; skim every new zh string for tone consistency with existing translations.
- [ ] Full gate: `npm test`, `DATABASE_URL=... npx vitest run --project pg`, `npm run test:e2e`, (`npm run test:e2e:pg` if landed), `npm run check`, `npm run build`.
- [ ] Commit: `docs: contributor + config polish for the supabase backend`
