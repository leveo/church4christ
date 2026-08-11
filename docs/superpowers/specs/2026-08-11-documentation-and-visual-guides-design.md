# Documentation and Visual Guides Design

**Status:** Approved for implementation

**Date:** 2026-08-11

## Context

Church4Christ already has broad feature documentation and a large screenshot library,
but four gaps make the project harder to evaluate and customize:

1. the README and Member Portal guide do not show the signed-in portal experience;
2. the `design/` sources have an architectural guide but no task-oriented authoring
   guide beside the files a developer edits;
3. several useful committed screenshots are not referenced, while a few onboarding and
   deployment facts are inconsistent; and
4. the documentation explains individual features without enough high-level visual maps
   for a first-time evaluator.

The documentation currently resolves all checked local image and document links. This
work therefore adds missing guidance and visual coverage without replacing the existing
feature-guide structure.

## Goals

1. Make the README show the public site, admin system, and Member Portal as one product.
2. Document the most important Member Portal workflows with reproducible real screenshots.
3. Add `design/README.md` as the operational guide for editing and creating themes and
   semantic color systems.
4. Reuse valuable existing screenshots in guides that currently describe those surfaces
   without showing them.
5. Add four GPT Image-generated overview diagrams that make product, setup, portal, and
   go-live flows understandable at a glance.
6. Improve screenshot automation enough that authenticated or backend-gated error pages
   cannot silently pass as successful documentation captures.
7. Correct a small set of adjacent documentation inconsistencies discovered by the audit.

## Non-goals

- Changing application behavior, data schemas, authorization, or module ownership.
- Creating a screenshot for every route.
- Replacing existing SVG technical diagrams.
- Documenting a not-yet-shipped People CSV import UI.
- Turning generated illustrative diagrams into authoritative configuration references.
- Changing the shipped default theme or adding a fourth theme.

## Chosen approach

Use a curated narrative rather than exhaustive page coverage. The README gives the
product-level story, feature guides show decisive workflows, `design/README.md` owns
hands-on token authoring, and generated diagrams explain relationships that are difficult
to communicate with screenshots alone.

All repository documentation and diagram labels remain in English to match the existing
documentation. Product screenshots use the seeded English demo and fictional demo people.

## Information architecture

### README

- Replace the Member Portal lock icon in the feature table with the real portal dashboard.
- Add the portal dashboard to the opening gallery by replacing one redundant theme image.
- Show the portal dashboard once in the “A home for your members” section.
- Add a product overview diagram near “What’s inside.”
- Add a setup decision diagram before the five-minute setup instructions.
- Link directly to `design/README.md` from the design-token paragraph while retaining the
  conceptual `docs/design-system.md` link.

### Member Portal guide

Expand `docs/features/member-portal.md` into the same structure as the stronger feature
guides: purpose, member workflows, screenshots, module boundaries, setup, architecture,
and developer references.

The guide will use these real screenshots:

| Screenshot | Route and identity | Purpose |
|---|---|---|
| `docs/images/portal/dashboard.png` | `/en/my`, David Chen | Portal navigation, household, groups, approvals, events, and serving summary |
| `docs/images/portal/household.png` | `/en/my/household`, David Chen | Household members, owner responsibilities, and profile editing |
| `docs/images/portal/events.png` | `/en/my/events`, David Chen | Existing registrations and open events |
| `docs/images/portal/prayer-moderation.png` | `/en/my/prayer?tab=pending`, David Chen | Scoped prayer moderation |
| `docs/images/portal/group-files.png` | `/en/groups/1`, Ben Wu | Member-only group roster and protected shared files |

Existing giving, calendar, and blockout screenshots may be linked or reused rather than
duplicated. The prose will distinguish Portal-owned routes from the independently enabled
Serve, Groups, Giving, and Registration modules.

### Design authoring guide

Create `design/README.md` beside the JSON sources. It will cover:

- source-of-truth files and generated outputs;
- the foundation and theme contracts;
- semantic foreground/background roles;
- modifying both modes of an existing theme;
- creating and wiring a new theme through runtime allowlists, translations, fonts, tests,
  and screenshots;
- adding a semantic token and its Tailwind mapping;
- generation, lint, test, type-check, and build commands; and
- troubleshooting generated files, contrast failures, mode precedence, missing mappings,
  and unsupported theme names.

`docs/design-system.md` remains the conceptual architecture guide. Its duplicated editing
instructions will become a concise summary that links to `design/README.md`, and inaccurate
statements about spacing tokens and zero-wiring theme addition will be corrected.

### Additional documentation coverage

- Add a compact gallery of the existing Events, Ministries, Staff, Articles, and Visit
  screenshots to `docs/features/public-site-and-themes.md`.
- Align deployment documentation on Node.js 22.12.0+, `npm ci`, and the early D1 versus
  Supabase path.
- Add a concise go-live verification checklist covering health, first-admin sign-in,
  production email, enabled routes, scheduled jobs, backups, and a restore drill.
- Replace the hard-coded test count in `docs/architecture.md` with non-drifting language.

## Generated overview diagrams

GPT Image will produce four English-language editorial diagrams with a shared visual
language: warm off-white background, restrained indigo/gold/green accents, rounded panels,
clear arrows, large legible labels, no logos from third parties, and no UI screenshot
simulation. They are explanatory companions; the surrounding prose remains authoritative.

| File | Subject | Primary placement |
|---|---|---|
| `docs/images/diagrams/product-overview.png` | Public site, staff admin, Member Portal, and shared platform services | README, before the feature table |
| `docs/images/diagrams/setup-paths-overview.png` | Local/Deploy, feature preset, D1/Supabase, and service prerequisites | README before “Try it in 5 minutes”; cross-link from Cloudflare setup |
| `docs/images/diagrams/member-portal-journey.png` | Sign in, household, groups, events, serving, giving, calendar, and scoped prayer | Member Portal guide |
| `docs/images/diagrams/go-live-readiness.png` | Setup, doctor, deploy, domain, email test, admin verification, backup/restore, and monitoring | Deployment guide |

Each image will be visually inspected for spelling, hierarchy, cropping, and legibility at
README display width. Images with malformed text or misleading flow will be regenerated.

## Screenshot automation

Extend `scripts/screenshots.mjs` with the five portal rows and correct the obsolete local
Hyperdrive environment-variable name in its instructions. Captures will remain explicit
identity-specific passes because the development auth bypass is fixed when the server
starts.

Each new authenticated row will declare an expected page marker. Before writing the PNG,
the harness will verify that the final page contains that marker and does not render the
site’s 404 or sign-in heading. The existing fixed viewport and minimum-byte checks remain.
The `backend: 'supabase'` metadata will continue to document batching; the capture command
and guide will make the required backend pass explicit rather than pretending a D1 default
run can capture these routes.

## Data and dependency flow

The real screenshots depend on seeded Supabase/Postgres data, local R2 media, and one auth
identity per development-server pass:

```text
Supabase migrations + demo seeds + local media
                    │
                    ▼
Astro dev with Supabase connection + member auth bypass
                    │
                    ▼
scripts/screenshots.mjs --only <identity-specific files>
                    │
                    ▼
validated 1280×800 PNGs under docs/images/portal/
                    │
                    ▼
README and Member Portal guide references
```

The GPT Image diagrams are independent static assets. Their captions and surrounding
Markdown explain the same concepts in text so the documentation remains accessible and
searchable.

## Error handling and safety

- Preserve the existing untracked `output/` directory; it is user-owned and outside the
  planned commit.
- Use only fictional seeded people and data in screenshots.
- Never expose connection strings, auth bypass values beyond documented demo emails,
  Stripe secrets, or local absolute paths in committed content.
- Fail screenshot capture on missing expected content, wrong dimensions, undersized PNGs,
  or navigation to sign-in/404 content.
- Do not claim an image-generation diagram is a complete operational procedure; link to
  the exact textual guide next to it.
- If a local Supabase service is unavailable, set it up through the documented local path
  rather than fabricating portal screenshots.

## Verification

1. Run the targeted screenshot passes and visually inspect all five portal images.
2. Visually inspect all four generated diagrams at full size and README display size.
3. Verify every local Markdown link and image reference resolves.
4. Run `npm run docs:check`.
5. Verify screenshot content validation with one successful portal capture and one
   intentional wrong-marker run that must fail before writing a PNG.
6. Run `npm run tokens`, `npm run tokens:check`, and the theme/token tests after editing
   design documentation examples.
7. Run `npm run check`, `npm test`, and `npm run build` before claiming completion.
8. Run `git diff --check` and confirm the commit excludes `output/` and local environment
   files.

## Acceptance criteria

1. The README contains a real Member Portal image instead of the lock placeholder and
   includes product and setup overview diagrams.
2. The Member Portal guide contains at least four decisive real screenshots and accurately
   describes route/module boundaries.
3. `design/README.md` lets a developer modify an existing theme or add a new one without
   relying on undocumented wiring.
4. `docs/design-system.md` and `design/README.md` cross-link without contradictory steps.
5. Existing public-site screenshots are reused where they add meaningful coverage.
6. Four GPT Image diagrams are committed, legible, and placed beside authoritative prose.
7. Portal screenshot rows are reproducible and reject sign-in/404 captures.
8. Adjacent deployment and architecture inconsistencies identified in this design are
   corrected.
9. Documentation link checks, repository checks, tests, and build pass.
10. A pull request is reviewed and merged into `main` without including the existing
    untracked `output/` directory.
