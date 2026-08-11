# Documentation and Visual Guides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the README, Member Portal, design-theme, and adjacent documentation with reproducible screenshots and four GPT Image overview diagrams, then publish and merge the reviewed pull request.

**Architecture:** Keep real UI screenshots, generated explanatory diagrams, and authoritative prose separate. Add portal rows plus content assertions to the existing Chrome DevTools screenshot harness; put task-oriented theme authoring in `design/README.md`; use the existing feature guides and README as the navigation layer. Preserve the user-owned untracked `output/` directory throughout.

**Tech Stack:** Markdown, Astro, Node.js, Vitest, Chrome DevTools Protocol, Supabase/Postgres demo seed, local R2 media, GPT Image, Git/GitHub.

---

## Authoritative inputs

- Design: `docs/superpowers/specs/2026-08-11-documentation-and-visual-guides-design.md`
- Existing screenshot harness: `scripts/screenshots.mjs`
- Portal routes: `src/pages/[locale]/my/*.astro`
- Theme sources: `design/foundation.json`, `design/themes/*.json`
- Theme runtime: `src/lib/theme.ts`, `src/layouts/{Base,Admin,Kiosk}.astro`
- Theme generation: `scripts/build-tokens.mjs`, `scripts/check-tokens.mjs`
- Supabase setup: `docs/supabase-setup.md`

## File map

- `scripts/lib/screenshot-validation.mjs` — pure page-state validation shared by the capture harness and tests.
- `test/node/screenshotValidation.test.ts` — success/failure tests for expected text, sign-in, and 404 detection.
- `vitest.config.ts` — classify the validation test as a pure Node test.
- `scripts/screenshots.mjs` — portal capture rows, correct Supabase prerequisites, and pre-write page assertions.
- `docs/images/portal/*.png` — five real seeded Member Portal screenshots.
- `design/README.md` — task-oriented theme and color-token authoring guide.
- `docs/design-system.md` — concise conceptual guide that links to the authoring guide.
- `docs/features/member-portal.md` — illustrated portal workflow and technical guide.
- `docs/features/public-site-and-themes.md` — existing public-surface screenshot gallery.
- `README.md` — Portal imagery, product overview, setup overview, and design-guide links.
- `docs/deploy.md` — D1/Supabase fork, go-live checklist, and readiness diagram.
- `docs/cloudflare-setup.md` — reuse of the setup-decision diagram and consistent installation command.
- `docs/architecture.md` — non-drifting test-coverage wording.
- `docs/images/diagrams/{product-overview,setup-paths-overview,member-portal-journey,go-live-readiness}.png` — generated explanatory diagrams.

### Task 1: Make authenticated screenshots reject the wrong page

**Files:**
- Create: `scripts/lib/screenshot-validation.mjs`
- Create: `test/node/screenshotValidation.test.ts`
- Modify: `vitest.config.ts`
- Modify: `scripts/screenshots.mjs`

- [ ] **Step 1: Write failing page-validation tests**

Create a Node-only Vitest suite with these exact cases:

```ts
import { describe, expect, test } from 'vitest';
import { assertExpectedScreenshotPage } from '../../scripts/lib/screenshot-validation.mjs';

const portalRow = { out: 'docs/images/portal/dashboard.png', expectedText: 'Chen Household' };

describe('screenshot page validation', () => {
  test('accepts the expected portal page', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      title: 'My Portal',
      headings: ['Welcome, David Chen'],
      body: 'Chen Household Owner My groups Upcoming events',
    })).not.toThrow();
  });

  test('rejects a sign-in redirect', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/signin?next=%2Fen%2Fmy',
      title: 'Sign in',
      headings: ['Sign in'],
      body: 'Email me a sign-in link',
    })).toThrow(/sign-in page/i);
  });

  test('rejects a rendered 404', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      title: 'Page not found',
      headings: ['Page not found'],
      body: 'The page you requested does not exist.',
    })).toThrow(/404/i);
  });

  test('rejects a page missing its marker', () => {
    expect(() => assertExpectedScreenshotPage(portalRow, {
      url: 'http://localhost:4321/en/my',
      title: 'My Portal',
      headings: ['Welcome'],
      body: 'No seeded household here',
    })).toThrow(/Chen Household/);
  });
});
```

- [ ] **Step 2: Register and run the failing Node test**

Add `test/node/screenshotValidation.test.ts` to `NODE_ONLY` in `vitest.config.ts`.

Run:

```bash
npx vitest run --project node test/node/screenshotValidation.test.ts
```

Expected: FAIL because `scripts/lib/screenshot-validation.mjs` does not exist.

- [ ] **Step 3: Implement the pure validator**

Create `scripts/lib/screenshot-validation.mjs`:

```js
const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function assertExpectedScreenshotPage(row, snapshot) {
  const pathname = new URL(snapshot.url).pathname;
  const text = normalize([snapshot.title, ...(snapshot.headings ?? []), snapshot.body].join('\n'));
  if (/(^|\/)signin\/?$/.test(pathname)) {
    throw new Error(`${row.out}: capture landed on the sign-in page`);
  }
  if (/\bpage not found\b|\b404\b|找不到页面/i.test(text)) {
    throw new Error(`${row.out}: capture rendered a 404 page`);
  }
  if (row.expectedText && !text.includes(row.expectedText)) {
    throw new Error(`${row.out}: expected page marker ${JSON.stringify(row.expectedText)} was not found`);
  }
}
```

- [ ] **Step 4: Add portal rows and call the validator before capture**

Import `assertExpectedScreenshotPage`, correct the obsolete `WRANGLER_...` prerequisite to
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`, and add:

```js
{ path: '/en/my', out: 'docs/images/portal/dashboard.png', bypass: 'pastor.david@example.com', backend: 'supabase', expectedText: 'Chen Household' },
{ path: '/en/my/household', out: 'docs/images/portal/household.png', bypass: 'pastor.david@example.com', backend: 'supabase', expectedText: 'Chen Household' },
{ path: '/en/my/events', out: 'docs/images/portal/events.png', bypass: 'pastor.david@example.com', backend: 'supabase', expectedText: 'My registrations' },
{ path: '/en/my/prayer?tab=pending', out: 'docs/images/portal/prayer-moderation.png', bypass: 'pastor.david@example.com', backend: 'supabase', expectedText: 'Pending' },
{ path: '/en/groups/1', out: 'docs/images/portal/group-files.png', bypass: 'ben.wu@example.com', backend: 'supabase', anchor: 'Shared files', expectedText: 'Shared files' },
```

Immediately before `Page.captureScreenshot`, evaluate and validate:

```js
const { result: pageState } = await send('Runtime.evaluate', {
  expression: `({url:location.href,title:document.title,headings:[...document.querySelectorAll('h1,h2,h3')].map((e)=>e.textContent||''),body:document.body?.innerText||''})`,
  returnByValue: true,
}, sessionId);
assertExpectedScreenshotPage(row, pageState.value);
```

- [ ] **Step 5: Run focused and full Node validation**

Run:

```bash
npx vitest run --project node test/node/screenshotValidation.test.ts
npx vitest run --project node
```

Expected: both PASS.

- [ ] **Step 6: Commit the screenshot-harness slice**

```bash
git add scripts/lib/screenshot-validation.mjs test/node/screenshotValidation.test.ts vitest.config.ts scripts/screenshots.mjs
git commit -m "test: validate documentation screenshot pages"
```

### Task 2: Add the design authoring guide

**Files:**
- Create: `design/README.md`
- Modify: `docs/design-system.md`
- Modify: `README.md`

- [ ] **Step 1: Write `design/README.md` with an operational structure**

Use these headings and make every command and manual wiring requirement explicit:

```text
# Design files and themes
## Start here
## Source of truth
## Theme schema and semantic colors
## Modify an existing theme
## Create a new theme
## Add a font
## Add a semantic token
## Generate and verify
## Common problems
## Related documentation
```

The new-theme checklist must mention `src/lib/theme.ts`, both locale dictionaries,
`Base.astro`, `Admin.astro`, `Kiosk.astro`, theme/token tests, and screenshot rows. State
that JSON `fontsource` is metadata, JSON `label` is not the translated picker label, and
the saved/visitor mode can override a theme’s intrinsic `defaultMode`.

- [ ] **Step 2: Separate concept from operation in `docs/design-system.md`**

Keep the token-pipeline and enforcement explanation. Replace the detailed editing section
with a summary plus `../design/README.md`. Correct “spacing” in the foundation description
and remove “no other wiring needed.”

- [ ] **Step 3: Link the authoring guide from the README**

In “What’s under the hood,” link “design tokens” to `design/README.md` and retain the
conceptual `docs/design-system.md` link.

- [ ] **Step 4: Verify commands and links**

Run:

```bash
npm run tokens
npm run tokens:check
npx vitest run --project node test/tokens.test.ts test/themeMeta.test.ts
git diff --check -- design/README.md docs/design-system.md README.md
```

Expected: all commands PASS.

- [ ] **Step 5: Commit the design-guide slice**

```bash
git add design/README.md docs/design-system.md README.md
git commit -m "docs: add design theme authoring guide"
```

### Task 3: Capture and document the Member Portal

**Files:**
- Create: `docs/images/portal/dashboard.png`
- Create: `docs/images/portal/household.png`
- Create: `docs/images/portal/events.png`
- Create: `docs/images/portal/prayer-moderation.png`
- Create: `docs/images/portal/group-files.png`
- Modify: `docs/features/member-portal.md`
- Modify: `README.md`

- [ ] **Step 1: Confirm the Supabase screenshot environment without printing secrets**

Verify Node/Chrome, the required `.dev.vars` keys by name only, the Hyperdrive binding,
database reachability, migrations, demo seeds, and local R2 seed. If setup is missing, use
the repository’s documented local Supabase path and never print a connection string.

- [ ] **Step 2: Capture the David Chen portal pass**

Boot Astro dev with `AUTH_DEV_BYPASS_EMAIL=pastor.david@example.com` and the host-shell
Supabase connection variable, then run:

```bash
node scripts/screenshots.mjs --only portal/dashboard.png,portal/household.png,portal/events.png,portal/prayer-moderation.png
```

Expected: four `1280x800` portal PNGs, each larger than 20 KB, with content validation
passing.

- [ ] **Step 3: Capture the Ben Wu group-file pass**

Restart Astro dev with `AUTH_DEV_BYPASS_EMAIL=ben.wu@example.com`, then run:

```bash
node scripts/screenshots.mjs --only portal/group-files.png
```

Expected: one `1280x800` portal PNG showing “Shared files.”

- [ ] **Step 4: Visually inspect all five screenshots**

Check identity, expected seeded content, absence of the Astro toolbar, absence of sign-in or
404 content, crop, font rendering, and disclosure of only fictional demo data. Recapture
any failed image.

- [ ] **Step 5: Rewrite `docs/features/member-portal.md` around the real workflows**

Add the screenshots immediately after their corresponding sections. Include:

```text
- Portal dashboard and passwordless sign-in
- household owner/member responsibilities
- group membership and protected files
- registrations, serving, calendar, and Giving as related modules
- church/group/event/private prayer scopes and moderation
- Supabase, R2, and production-email prerequisites
- exact setup steps
- route/module boundary table
- developer file/test references
```

- [ ] **Step 6: Put the Portal into the README visual story**

Replace the feature-table lock icon with the dashboard thumbnail, replace one redundant
theme image in the opening gallery with the dashboard, and insert the dashboard after the
member-home introduction.

- [ ] **Step 7: Check image references and commit**

Run a local Markdown image/link resolver, `git diff --check`, and:

```bash
git add docs/images/portal docs/features/member-portal.md README.md
git commit -m "docs: illustrate the member portal"
```

### Task 4: Reuse existing screenshots and close adjacent documentation gaps

**Files:**
- Modify: `docs/features/public-site-and-themes.md`
- Modify: `docs/deploy.md`
- Modify: `docs/cloudflare-setup.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Add the existing public-surface gallery**

Use a compact Markdown table for `events.png`, `ministries.png`, `staff.png`,
`articles.png`, and `visit.png`. Do not imply each has a separate guide; describe them as
the public surface covered by the combined guide.

- [ ] **Step 2: Align installation and deployment choices**

Use Node.js 22.12.0+ and `npm ci`. Near the start of `docs/deploy.md`, add an explicit fork:
D1 Website/Community installations continue in the deployment guide; Full Church or any
Portal/Giving/Registration installation follows `docs/supabase-setup.md` for its database
path before returning to deployment.

- [ ] **Step 3: Add a concise go-live checklist**

Cover `/healthz`, first-admin magic-link sign-in, production email delivery, enabled public
and admin routes, scheduled jobs, a recent backup artifact, a restore drill, and monitoring.
Do not promise that `npm run doctor` proves external delivery or recovery.

- [ ] **Step 4: Remove the drifting test count**

Replace “over 900 automated tests” in `docs/architecture.md` with “extensive automated
coverage across unit, Worker/D1, Postgres, and end-to-end workflows.”

- [ ] **Step 5: Verify and commit**

```bash
npm run docs:check
git diff --check -- docs/features/public-site-and-themes.md docs/deploy.md docs/cloudflare-setup.md docs/architecture.md
git add docs/features/public-site-and-themes.md docs/deploy.md docs/cloudflare-setup.md docs/architecture.md
git commit -m "docs: improve evaluation and go-live guidance"
```

### Task 5: Generate four overview diagrams with GPT Image

**Files:**
- Create: `docs/images/diagrams/product-overview.png`
- Create: `docs/images/diagrams/setup-paths-overview.png`
- Create: `docs/images/diagrams/member-portal-journey.png`
- Create: `docs/images/diagrams/go-live-readiness.png`

- [ ] **Step 1: Generate the product overview**

Create a landscape editorial infographic with four clearly separated labeled regions:
“Public website,” “Staff admin,” “Member Portal,” and “Shared platform.” Use only these
small labels inside the regions: Public website — Bilingual pages, Sermons & events,
Prayer request; Staff admin — Content, People & households, Scheduling; Member Portal —
Family, Groups & files, Events & serving, Giving & prayer; Shared platform — Astro Worker,
D1 or Supabase, R2 media, Email. Show the three user-facing regions connected to the shared
platform.

- [ ] **Step 2: Generate the setup path overview**

Create a left-to-right decision map: “Start” → “Local evaluation” or “Deploy”; then choose
“Website,” “Website + Community,” or “Full Church”; Website/Community lead to “D1,” Full
Church leads to “Supabase”; show Cloudflare account only on deployed paths, production
email as an optional paid-capable service, and Stripe as “Preview / test mode only.”

- [ ] **Step 3: Generate the member journey**

Create a friendly journey map: “Passwordless sign-in” → central “My Portal,” branching to
Household, Groups & files, Events, Serving, Calendar, Giving, and Prayer. Add a small prayer
scope row: Church / Group / Event / Private. Keep labels short and do not depict private
data values.

- [ ] **Step 4: Generate the go-live readiness flow**

Create a numbered lifecycle: 1 Setup, 2 Doctor, 3 Deploy, 4 Domain & HTTPS, 5 Email test,
6 First-admin sign-in, 7 Backup & restore drill, 8 Monitoring. Add a small footer: “Verify
each step; deployment is operator-managed.”

- [ ] **Step 5: Visually QA and normalize assets**

Inspect every image at original size. Regenerate any image with misspelled labels,
misleading arrows, unreadable text, or cropped content. Copy final assets into the exact
paths above and confirm each is a valid PNG with no embedded secret or third-party logo.

- [ ] **Step 6: Commit the diagram assets**

```bash
git add docs/images/diagrams/product-overview.png docs/images/diagrams/setup-paths-overview.png docs/images/diagrams/member-portal-journey.png docs/images/diagrams/go-live-readiness.png
git commit -m "docs: add visual workflow guides"
```

### Task 6: Place the diagrams and complete cross-linking

**Files:**
- Modify: `README.md`
- Modify: `docs/features/member-portal.md`
- Modify: `docs/deploy.md`
- Modify: `docs/cloudflare-setup.md`

- [ ] **Step 1: Place each image next to authoritative prose**

- `product-overview.png`: README immediately before the feature table.
- `setup-paths-overview.png`: README before setup commands; reuse in Cloudflare setup near
  the database/preset decision.
- `member-portal-journey.png`: Member Portal guide after the initial dashboard explanation.
- `go-live-readiness.png`: deployment guide immediately before the go-live checklist.

Every image needs descriptive alt text that conveys the flow rather than saying “diagram.”

- [ ] **Step 2: Remove accidental duplication**

Read each changed guide top to bottom. Keep detailed operational truth in prose; shorten
captions or repeated lists that merely restate every diagram label.

- [ ] **Step 3: Validate generated documentation and commit placement**

Run `npm run docs:check` and `git diff --check`, then:

```bash
git add README.md docs/features/member-portal.md docs/deploy.md docs/cloudflare-setup.md
git commit -m "docs: connect visual guides to workflows"
```

### Task 7: Full verification and publication

**Files:**
- Verify: all changed files

- [ ] **Step 1: Run repository verification**

```bash
npm run docs:check
npm run tokens
npm run tokens:check
npm run check
npm test
npm run build
git diff --check main...HEAD
```

Expected: every command exits 0.

- [ ] **Step 2: Verify asset and link integrity**

Resolve every local Markdown link/image under `README.md`, `design/`, and `docs/`, and
validate PNG signatures and dimensions:

```bash
node --input-type=module -e 'import{existsSync,readFileSync,readdirSync,statSync}from"node:fs";import{dirname,extname,resolve}from"node:path";const walk=d=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(resolve(d,e.name)):[resolve(d,e.name)]);const root=process.cwd();const files=[resolve(root,"README.md"),...walk(resolve(root,"design")),...walk(resolve(root,"docs"))].filter(f=>extname(f)===".md"&&!f.includes("/docs/superpowers/"));const bad=[];for(const file of files){const text=readFileSync(file,"utf8");for(const m of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)){const raw=m[1].trim().replace(/^<|>$/g,"").split("#")[0];if(!raw||/^(https?:|mailto:|#)/.test(raw))continue;const target=resolve(dirname(file),decodeURIComponent(raw));if(!existsSync(target))bad.push(`${file.slice(root.length+1)} -> ${raw}`);}}for(const file of walk(resolve(root,"docs/images")).filter(f=>extname(f)===".png")){const b=readFileSync(file);if(b.length<24||b.toString("ascii",12,16)!=="IHDR"||b.readUInt32BE(16)<1||b.readUInt32BE(20)<1)bad.push(`${file.slice(root.length+1)} -> invalid PNG`);}if(bad.length){console.error(bad.join("\n"));process.exit(1)}console.log(`validated ${files.length} Markdown files and documentation PNGs`);'
```

Expected: exits 0 and prints the number of validated Markdown files.

Confirm changed documentation contains no local artifact paths or secrets:

```bash
git diff --unified=0 main...HEAD -- README.md design docs scripts test vitest.config.ts | grep -nE '^\+.*(output/|\.dev\.vars|postgres(ql)?://|/Users/)' || true
```

Expected: no matches.

- [ ] **Step 3: Review the final diff and working tree**

Confirm the diff implements every acceptance criterion, contains only documentation,
screenshot tooling/tests, and approved assets, and leaves the pre-existing `output/`
directory untracked.

- [ ] **Step 4: Run independent spec and quality reviews**

Use fresh reviewers for design-spec compliance and documentation/code quality. Fix every
valid finding and rerun the affected checks before publication.

- [ ] **Step 5: Publish, inspect, and merge**

Push `codex/docs-visual-guides`, create a ready pull request, wait for required GitHub
checks, address failures or feedback, merge the PR to `main`, and verify the remote default
branch contains the merge.
