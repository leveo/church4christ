# Slice 7 — Backup, README Suite, Screenshots & Final Acceptance Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> v2 incorporates the owner's 2026-07-05 directives: GPL v3, English README suite for a
> non-technical audience, screenshots + SVG diagrams, AI-assisted-maintenance pitch,
> Fable-run final acceptance.

**Goal:** Nightly D1→R2 backup, the full English documentation suite (non-technical
landing README + per-feature docs with screenshots and SVG diagrams), open-source
hygiene under GPL v3, and a Fable-run final acceptance so a stranger can clone → run →
deploy — or hand the repo to Claude Code / Codex and ask for changes.

## Global Constraints
- LICENSE is **GPL-3.0-only** (already switched; package.json carries the field). All
  docs referencing licensing must say GPL v3 and explain copyleft plainly: forks and
  derivatives must stay open source; using this codebase for a closed-source commercial
  product is not permitted.
- Backup (port `/Users/leosong/Python/dcfc-website/src/lib/backup.ts` + test): D1 REST
  export polling → R2 `backups/YYYY-MM-DD.sql`; vars CF_ACCOUNT_ID + D1_DATABASE_ID +
  secret D1_EXPORT_TOKEN as commented placeholders in wrangler.jsonc; cron handler
  logs-and-skips gracefully when unset.
- README suite is user-facing product, ALL ENGLISH. Landing README.md audience =
  church staff/volunteers who are NOT developers: short sentences, no stack jargon
  above the fold (Cloudflare/Astro named once in a "what's under the hood" section).
  Must contain, in this order: hero paragraph + screenshot collage · "Why not
  WordPress/Wix/a paid service?" honest comparison ($0 hosting on Cloudflare free tier,
  fast worldwide, you own your data and code, no vendor lock-in, no plugin updates) ·
  "Build it with an AI assistant" section explicitly encouraging Claude Code or Codex,
  with 3 example prompts (e.g. "read docs/features and change the theme colors to our
  church's blue") · mission statement (simplest/fastest/cheapest church & nonprofit
  websites, easy to maintain with AI help) · feature gallery table linking every
  docs/features/*.md with a thumbnail · 5-minute local demo quickstart · deploy pointer
  to docs/deploy.md · GPL v3 paragraph · credits.
- `docs/features/*.md` (English): public-site-and-themes, cms-admin, bulletins,
  sermons, prayer-wall, volunteer-serve, i18n, email-automation. Each: what it does
  (for the church), how staff use it (walkthrough with SCREENSHOTS), one original SVG
  structure diagram (checked into docs/images/diagrams/, token-palette colors, no
  external assets), and a short "for developers" pointer into the code.
- Screenshots: captured from the seeded dev server (headless Chromium, consistent
  1280×800 viewport, sanctuary theme light unless demonstrating themes; theme-matrix
  shots for the themes doc: 3 themes × light/dark home page). Stored
  `docs/images/**` with descriptive kebab-case names. Every doc image referenced must
  exist (link-check in final acceptance).
- Technical docs: architecture.md (with mermaid or SVG), design-system.md, i18n.md,
  deploy.md (full walkthrough incl. church.yunfei-song.com custom-domain example,
  first-admin bootstrap via wrangler d1 execute), CONTRIBUTING.md (dev setup, token
  rules, i18n parity rules, PR checklist). `.github/` issue/PR templates.
- docs/superpowers/ is INTERNAL design history (owner directive): it stays in the LOCAL
  repo only and is EXCLUDED from the public GitHub repo, which is published as a fresh
  clean history (filtered export, no internal metadata). No public doc may reference
  docs/superpowers/.
- Commits per task; `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Tasks
1. **Backup + GPL sweep**: backup lib + cron wiring + tests; wrangler.jsonc commented
   backup vars; repo-wide license-reference sweep (no MIT mentions anywhere;
   CONTRIBUTING/README stubs updated); verify `npm test` + e2e still green.
2. **Screenshot harness + capture**: scripts/screenshots.mjs (playwright-core or
   puppeteer-core devDep driving headless Chromium against `npm run dev` with seed;
   page list + viewport config; writes docs/images/**). Capture: full public tour
   (home en+zh, sermons, bulletin, prayer, events, ministries, serve, gifts page if
   built, visit/about/staff), admin tour (dashboard, bulletin editor with repeat rows,
   sermons list, announcements, events w/ image, prayer wall kanban, settings incl.
   theme picker), theme matrix (3×2 home). Commit images.
3. **SVG diagrams + feature docs**: 8 docs/features/*.md per constraints + their SVG
   diagrams (original, hand-authored, theme-token colors).
4. **Landing README + technical docs + templates**: per constraints above.
5. **Final verification**: fresh-clone dry run (git clone file://, npm ci, cf-typegen,
   tokens, migrate, seed, test, test:e2e, build, smoke) recorded in report; empty-DB
   dev run renders gracefully; rg sweeps (dcfc/PII audit, hex-literal audit, MIT
   mentions); image link-check; `npx wrangler deploy --dry-run` (skip gracefully if
   auth needed).
6. **Fable final acceptance** (controller-run, not a subagent dispatch of this plan):
   whole-repo review against the spec + ledger minors triage + goal checklist; fix
   wave for anything found; final commit.
