# README screenshot inventory

Sanctuary renewal capture contract, audited 2026-09-06. README currently references 33 distinct image files: 29 interface captures and 4 diagrams. All 29 interface images were recaptured from the integrated application and visually reviewed. The four architecture/workflow diagrams were reviewed and retained because their underlying relationships remain accurate.

## Capture command

Run against a fully enabled, migrated and seeded local Supabase development server, with the complete demo, Giving, Registration, Portal, and fictional Learning fixtures plus their local R2 media. Keep `AUTH_DEV_BYPASS_EMAIL` unset. Use the same ephemeral `SCREENSHOT_SESSION_SECRET` in the server and capture process environments only; do not print it, write it to a file, or reuse `SESSION_SECRET`.

```sh
node scripts/screenshots.mjs --base http://127.0.0.1:4321 --only readme
```

Replace the loopback port with the actual development server port. The `readme` preset selects exactly the 29 interface rows below; it does not include other feature-documentation images or generate diagrams. To retry selected outputs, use `--only admin/page-builder.png,identity/merge-review-queue.jpg` with exact output-path tokens.

Every shot has its own incognito browser context. Authenticated rows receive a freshly minted five-minute session for the exact seeded person ID and epoch 0; public rows receive no cookie. Keep the seed identities and their verified ownership fixture intact. All rows use 1280×800, Sanctuary light, except the explicitly marked Midnight dark variant. Output extensions select real PNG or JPEG encoding; dimensions and a 20 KB minimum are checked before writing.

Page status, exact pathname and requested query values, page markers and applicable identity markers are checked before capture. Required anchors and menu disclosures fail if absent; the page-builder shot waits for its React editor. Local images in the capture region must decode before capture, including lazy media in an anchored panel. This preset uses GET navigation and a local menu disclosure only; it does not submit forms, create identity cases, send email, synchronize providers, or create payments.

## Pages by actor

### Anonymous public visitor (5)

| Page | Output under docs/images/ | Backend | Required page marker / framing |
| --- | --- | --- | --- |
| `/en/` | `public/home-en.png` | D1 or Supabase | Life together. Faith that grows. |
| `/zh/` | `public/home-zh.png` | D1 or Supabase | 在这里， 一起成长。 |
| `/en/` | `public/grouped-navigation.png` | D1 or Supabase | Life together. Faith that grows.; open: Connect |
| `/en/` | `themes/home-midnight-dark.png` | D1 or Supabase | Life together. Faith that grows.; Midnight dark |
| `/en/sermons` | `public/sermons.png` | D1 or Supabase | Sermons |

### admin@example.com — person 1, epoch 0 (18)

| Page | Output under docs/images/ | Backend | Required page marker / framing |
| --- | --- | --- | --- |
| `/admin` | `admin/dashboard.png` | D1 or Supabase | Dashboard |
| `/admin/prayer-wall` | `admin/prayer-wall.png` | D1 or Supabase | Prayer Wall |
| `/admin/people/11` | `admin/person-permissions.png` | D1 or Supabase | Lydia Kwan; full record with Access & status present |
| `/admin/campuses` | `admin/campuses-overview.png` | D1 or Supabase | Campus management |
| `/admin/bulletins/1` | `admin/bulletin-editor.png` | D1 or Supabase | Edit bulletin |
| `/admin/people/export` | `admin/people-export.png` | D1 or Supabase | Export people and households |
| `/admin/people/identity/merge` | `identity/merge-review-queue.jpg` | D1 or Supabase | Merge review queue |
| `/en/groups/1/manage` | `groups/member-checklist.png` | D1 or Supabase | Manage Young Adults; anchor: Members |
| `/admin/children?tab=dashboard` | `admin/children-dashboard.png` | D1 or Supabase | Children check-in |
| `/admin/attendance` | `admin/attendance-report.png` | D1 or Supabase | Attendance report; anchor: Attendance report |
| `/admin/newcomers` | `admin/newcomers-queue.png` | D1 or Supabase | Newcomer follow-up |
| `/admin/onboarding` | `admin/onboarding.png` | D1 or Supabase | Launch checklist |
| `/admin/pages/builder/seedbuilderwelcome0000000000pb01` | `admin/page-builder.png` | D1 or Supabase | Design your page; wait: .builder-topbar |
| `/admin/giving` | `admin/giving.png` | Supabase | Giving |
| `/admin/registration` | `admin/registration.png` | Supabase | Registration |
| `/admin/ministries?tab=email` | `admin/email-tab.png` | D1 or Supabase | Automation rules; anchor: Automation rules |
| `/admin/settings` | `admin/settings-modules.png` | D1 or Supabase | Site Settings; anchor: Modules |
| `/admin/learning` | `learning/admin-overview.png` | D1 or Supabase | Learning provider connections; anchor: Learning provider connections |

### pastor.david@example.com — person 2, epoch 0 (1)

| Page | Output under docs/images/ | Backend | Required page marker / framing |
| --- | --- | --- | --- |
| `/en/my` | `portal/dashboard.png` | Supabase | Welcome, David Chen |

### sarah.johnson@example.com — person 3, epoch 0 (4)

| Page | Output under docs/images/ | Backend | Required page marker / framing |
| --- | --- | --- | --- |
| `/en/my/opportunities` | `portal/member-opportunities.png` | Supabase | Find Your Place |
| `/en/manage` | `portal/leader-panel.png` | D1 or Supabase | Leader Panel |
| `/en/serve/matrix/1` | `serve/matrix.png` | D1 or Supabase | Scheduling Matrix |
| `/en/learn/21000` | `learning/genesis-1-en.png` | D1 or Supabase | Genesis 1: Creation; anchor: Course activities |

### grace.lin@example.com — person 4, epoch 0 (1)

| Page | Output under docs/images/ | Backend | Required page marker / framing |
| --- | --- | --- | --- |
| `/zh/learn/21000` | `learning/genesis-1-zh.png` | D1 or Supabase | Genesis 1: Creation; anchor: 课程活动 |

The full README preset uses Supabase so the four Supabase-only rows render together with all other rows. Alex is the seeded super administrator; the permissions screenshot views Lydia’s record while remaining signed in as Alex. Screenshot sessions do not satisfy recent-verification gates, so sensitive access controls remain read-only. David’s portal screenshot requires Chen Family. Sarah’s member and leader views preserve her actual Worship leadership; Grace’s Chinese learner view requires the returned assignment state. The merge queue is a GET-only view: an empty seeded review queue is valid, and this harness does not fabricate a pending operation.

## Separately maintained diagrams

- `docs/images/diagrams/product-overview.png`
- `docs/images/learning/learning-flow.png`
- `docs/images/diagrams/member-opportunity-workflow.png`
- `docs/images/diagrams/setup-paths-overview.png`

These four workflow/architecture illustrations require a separate content review and regeneration workflow. They are deliberately excluded from the browser preset. The identity operation-detail JPEG is referenced in feature documentation but is not a README image and is outside this inventory.

## Recorded verification

- Focused Node tests compare the manifest directly with current README image references, prevent duplicates/missing rows, require seeded sessions for authenticated rows, reject login-page redirects, verify image encodings/dimensions, and verify per-shot browser-context isolation.
- All 29 captures passed the status, route, identity, dimensions, and file-size assertions against a dedicated local PostgreSQL fixture with local R2 media. The final outputs were visually reviewed for layout, crop, media, language, and identity.
- The sermon image was recaptured after fixing its initial loading state: the packaged cover is visible while an external video thumbnail is pending, and the play control remains above both images.
- The matrix contains real seeded assignments and the Worship team; module settings display all catalog labels instead of raw translation keys. The English registration list no longer appends the Chinese secondary title.
- Screenshot/session validation and the final module/navigation regressions passed together: 76 tests in 4 suites. This count overlaps broader test runs; it is not an additional release test total.
