---
name: verify
description: Build, launch, and drive church4christ locally to verify changes at the running app — dev server setup, admin auth bypass, browser automation gotchas, and the docs screenshot harness.
---

# Verifying church4christ changes at the running app

## Launch (cold start → running admin session)

```bash
npm install                      # fresh clone/worktree only
npm run tokens                   # generated CSS/TS are gitignored; dev does NOT auto-run this
npm run db:migrate:local && npm run db:seed:local
cp /path/to/.dev.vars .dev.vars  # or write one: SESSION_SECRET=<random>, EMAIL_DEV_LOG=1,
                                 # AUTH_DEV_BYPASS_EMAIL=admin@example.com
npm run dev                      # astro dev DAEMONIZES (astro dev stop / status / logs)
```

- The auth bypass is read from the **Workers runtime env (`.dev.vars`)**, NOT the shell
  environment — exporting `AUTH_DEV_BYPASS_EMAIL` on the command line does nothing.
- Seeded identities: person 1 `admin@example.com` (admin, en), person 2
  `pastor.david@example.com` (editor, **lang=zh** — admin UI renders Chinese for him).
- Server binds localhost only; for a Docker/remote browser run `npx astro dev stop`
  then `npx astro dev --host` (LAN IP and host.docker.internal both work then).

## Driving the app in a browser

- **beforeunload guard**: any page with unsaved builder changes blocks navigation with
  a browser dialog. Playwright then times out on EVERY call (even about:blank) until the
  dialog is handled — if all browser calls suddenly hang, close the page and look for
  `Modal state: beforeunload` in the result.
- **@dnd-kit drags** (page builder): Playwright's `dragTo` does NOT work (PointerSensor
  needs a ≥4px activation move plus settle time). Dispatch synthetic PointerEvents:
  pointerdown on the source, ~5 small pointermoves (40ms apart) to activate, THEN
  measure the (now-expanded) drop-gap rect, ~10 moves onto it, wait ~150ms, pointerup.
  Valid hovered gaps get `bg-primary h-6` classes — assert that mid-drag to confirm
  the drop will land. Drop-gap misses fall into the enclosing section gap (still legal).
- Non-secure origins (LAN IP over http) lack `crypto.randomUUID`; the builder falls back
  (src/components/builder/uid.ts) — ids become 32-hex instead of UUID. Expected.

## Screenshots for docs/README

Use the committed harness, never ad-hoc captures:
```bash
node scripts/screenshots.mjs --only <substring>   # needs the seeded dev server running
```
Rows live in the PAGES table in `scripts/screenshots.mjs` (`admin: true` rows need the
admin bypass). Output is asserted 1280x800, >20KB, under `docs/images/**`. The seeded
builder page for page-builder shots has fixed id `seedbuilderwelcome0000000000pb01`
(slug `welcome`, from dev-seed.sql).

## Worthwhile flows to drive

- Page builder: `/admin/pages/builder/new` — palette click-to-add + drag, properties
  panel, EN/中文 locale toggle (canvas falls back per-field; properties edit the exact
  locale string), undo/redo, Save & publish (URL updates to the page id), then
  `/en/p/<slug>` and `/zh/p/<slug>` — assert `document.querySelectorAll('astro-island').length === 0`
  on public pages (zero-JS promise).
- Module toggles: Settings → Modules panel; builder route 404s when page-builder is off
  while `/en/p/<slug>` keeps serving 200.
