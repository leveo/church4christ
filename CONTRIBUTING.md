# Contributing to Church4Christ

Thanks for helping — bug reports, translations, docs, and features are all welcome. This
project aims to be the simplest, cheapest way for a church or nonprofit to run a real
website, and it stays that way by keeping a few rules tight. This guide gets you set up and
explains those rules.

## Getting set up

You need [Node.js](https://nodejs.org/) 22+. Then:

```bash
git clone https://github.com/leveo/church4christ.git
cd church4christ
npm install
cp .dev.vars.example .dev.vars      # safe local demo values
npm run cf-typegen
npm run tokens
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Open the printed address (usually `http://localhost:4321`). To reach the admin area, sign
in as `admin@example.com` — the magic link prints to your terminal (local email is logged,
not sent), and `.dev.vars` also enables an auto-sign-in bypass for convenience. Full context
is in the [README quickstart](README.md#try-it-in-5-minutes-on-your-own-computer).

## The four project rules

These are enforced automatically — CI will reject a PR that breaks one — so it is best to
know them up front.

### 1. Styling comes only from design tokens

No hardcoded colors or fonts in `src/`. Use the semantic utilities (`bg-primary`,
`text-ink-muted`, `font-display`) that resolve to design tokens. `npm run tokens:check`
scans for stray hex, `rgb()`/`hsl()`, and literal `font-family` values and **fails** on any.
If you truly need a literal, append `/* tokens-ok */` on that line. To change a color, edit
`design/themes/*.json` — see [`docs/design-system.md`](docs/design-system.md).

### 2. Both language dictionaries stay in parity

Every UI string exists in both `src/i18n/en.ts` and `src/i18n/zh.ts`, with the same keys and
the same `{placeholders}`. `test/i18n.test.ts` **fails** if they diverge. Add an English
label, add its Chinese counterpart in the same PR. See [`docs/i18n.md`](docs/i18n.md).

### 3. Every feature needs tests

New behavior comes with tests that cover it. Pure logic gets unit tests; anything touching a
request/response or the database gets an integration or end-to-end test. The bar is simple:
a reviewer should be able to see the feature's important cases exercised.

### 4. Conventional commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, optionally scoped
(`feat(serve): …`). This keeps history readable and releasable.

## Running the checks

Run these before opening a PR — they are the same steps CI runs:

| Command | What it checks |
|---|---|
| `npm run tokens:check` | No hardcoded colors/fonts (rule 1) |
| `npm test` | Unit + integration tests (Workers test pool), incl. dictionary parity |
| `npm run check` | TypeScript / Astro type checking |
| `npm run build` | Production build (also rebuilds tokens) |
| `bash scripts/smoke.sh` | Boots the built worker; checks routing, i18n, health, security headers |
| `npm run test:e2e` | End-to-end tests against the actual built worker |
| `npm run screenshots` | (Optional) regenerates the docs screenshots from the seeded dev server |

## Pull request checklist

Before you open a PR, confirm:

- [ ] `npm test`, `npm run check`, and `npm run tokens:check` all pass.
- [ ] Styling uses design tokens only (no new hardcoded colors/fonts).
- [ ] Any new or changed UI string is present in **both** `en.ts` and `zh.ts`.
- [ ] New behavior is covered by tests.
- [ ] Commits follow Conventional Commits.
- [ ] No secrets, `.dev.vars`, or real member data are committed (see [`SECURITY.md`](SECURITY.md)).
- [ ] Docs updated if behavior changed.

## Code of conduct

Be kind, be respectful, assume good faith. Harassment or discrimination of any kind is not
tolerated. We are building tools to serve churches and nonprofits; treat contributors the
way you would treat a fellow volunteer.

## Licensing of contributions

Church4Christ is licensed under the **[GNU GPL v3](LICENSE)**. Contributions are **inbound =
outbound**: by submitting a pull request, you agree that your contribution is licensed under
the same GPL v3 as the project. You retain copyright to your work; you are simply licensing
it to the project (and everyone who receives it) under GPL v3.
