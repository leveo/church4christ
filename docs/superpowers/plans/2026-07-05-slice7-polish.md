# Slice 7 — Backup, Docs & Final Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Nightly D1→R2 backup, complete documentation set, README with screenshots,
final verification sweeps, and open-source hygiene so a stranger can clone → run → deploy.

## Global Constraints
- Backup (port `/Users/leosong/Python/dcfc-website/src/lib/backup.ts` + test): D1 REST
  export polling protocol → R2 `backups/YYYY-MM-DD.sql`; requires vars CF_ACCOUNT_ID +
  D1_DATABASE_ID + secret D1_EXPORT_TOKEN — wrangler.jsonc gains commented placeholder
  vars; cron handler logs-and-skips gracefully when unset (demo-friendly).
- Docs are user-facing product: write for a church tech volunteer, not for us. No
  references to dcfc or this build process.
- README structure: hero paragraph · screenshots grid (from docs/images) · feature list
  (grouped: Public Site / CMS / Volunteer / Platform) · architecture diagram (mermaid) ·
  quickstart (clone → npm i → cf-typegen → tokens → migrate:local → seed:local → dev,
  with magic-link-in-console explanation) · deploy guide (create D1 + R2 + Email binding,
  put ids in wrangler.jsonc, secrets, `wrangler deploy`, custom domain
  church.yunfei-song.com walkthrough, first-admin bootstrap: `wrangler d1 execute`
  INSERT person role admin) · theming guide (edit/add theme JSON, contrast gate,
  admin switcher) · i18n guide (add a locale end-to-end checklist) · roadmap (check-in,
  swap marketplace, DB-driven cron templates) · license.
- docs/: `architecture.md`, `design-system.md` (token reference tables generated from
  the JSONs by hand-writing, naming rules, enforcement), `i18n.md`, `deploy.md`
  (expanded), `features.md` (per-feature walkthrough w/ screenshots), `CONTRIBUTING.md`
  (dev setup, test philosophy, token rules, PR checklist).
- `.github/`: ISSUE_TEMPLATE (bug/feature), PULL_REQUEST_TEMPLATE.md referencing token +
  i18n-parity rules.
- Commits per task; `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Tasks
1. Backup lib + cron wiring + tests; wrangler.jsonc commented backup vars.
2. Screenshots: dev server + seed, capture per slice-4 checklist matrix + admin +
   serve pages into docs/images (use the browser tooling available; else document
   `npm run dev` capture steps and mark TODO — do NOT ship broken image links).
3. README + docs set + templates (content per constraints).
4. Final verification: fresh-clone dry run in a temp dir (git clone file://…, npm ci,
   cf-typegen, tokens, migrate, seed, test, build, smoke) — record transcript in report;
   fix anything found; `rg` sweeps: dcfc/PII zero-hit audit (excluding docs/superpowers
   which stays internal — actually MOVE build-process docs to `.superpowers/` or keep?
   DECISION: keep docs/superpowers/ in repo — it demonstrates the spec-driven build,
   but add a note in its folder README that it's the project's own design history),
   `rg -n "#[0-9a-fA-F]{3,8}" src/` clean, LICENSE year/name intact.
5. Final whole-branch review (controller dispatches per SDD skill) + fix wave.

## Self-review checklist
Fresh-clone dry run transcript green end-to-end; README renders (no broken links/images);
`npx wrangler deploy --dry-run` succeeds with placeholder ids swapped by envs? (skip if
requires auth — document); repo tree has no stray scratch files (.superpowers/ ignored).
