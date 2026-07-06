<!--
Thanks for contributing! Please read CONTRIBUTING.md if you haven't.
Keep the description focused on what changed and why.
-->

## What this does

A short summary of the change and the reason for it. Link any related issue (e.g. `Closes #12`).

## Checklist

Please confirm before requesting review (these mirror the four project rules):

- [ ] **Tokens only** — no hardcoded colors or fonts; `npm run tokens:check` passes.
- [ ] **i18n parity** — any new/changed UI string is in **both** `src/i18n/en.ts` and
      `src/i18n/zh.ts`, with matching keys and placeholders.
- [ ] **Tests** — new behavior is covered; `npm test` and `npm run test:e2e` pass.
- [ ] **Type check & build** — `npm run check` and `npm run build` pass.
- [ ] **Conventional commit** messages (`feat:`, `fix:`, `docs:`, …).
- [ ] **No secrets or real member data** committed (see `SECURITY.md`).
- [ ] Docs updated if behavior changed.

## Notes for the reviewer

Anything worth calling out — trade-offs, follow-ups, screenshots for UI changes.
