# Learning Module Design

**Date:** 2026-08-16

**Status:** Implementation baseline

**Church4Christ baseline:** `origin/main` at `1dbd80d`

## Purpose

Church4Christ will add an optional Learning module for Sunday school,
discipleship, membership classes, and similar ministries that continue between
in-person meetings. Learners need one authenticated place to find prepared
YouTube videos, course files, assignments, and quizzes. Teachers and church
administrators need provider setup and a privacy-bounded activity feed without
building a second complete LMS inside the Church4Christ Worker.

Learning is a provider-neutral control plane and learner hub. A learning program
is linked to either Google Classroom or an independently deployed
Church4Christ-maintained Canvas LMS derivative. The provider remains authoritative
for course content, files, submissions, quiz answers, feedback, and grades.
Church4Christ stores only the normalized metadata and activity needed to render a
useful course dashboard and support explicitly enabled engagement reporting.

## Product outcomes

1. An administrator can enable Learning and configure one or more Google
   Classroom or Canvas provider connections.
2. A church can use different providers for different programs instead of making
   one irreversible church-wide choice.
3. An administrator or authorized Learning manager can map an external course to
   a Church4Christ learning program and link external identities to People.
4. An enrolled learner can view courses, prepared unlisted YouTube videos, file
   links, assignments, quizzes, due dates, and current submission state from a
   bilingual Church4Christ hub.
5. Assignment and quiz submission remains in the provider's supported interface.
   Church4Christ launches the exact provider activity and reconciles the resulting
   state back into the hub.
6. Important activity can feed the existing Activity Score module as an optional,
   explainable dimension without copying answers, files, comments, or grades.
7. The Church4Christ Canvas edition visibly credits Instructure, Inc., preserves
   AGPL notices, publishes corresponding source, and remains independently
   deployable from the GPL Church4Christ application.

## Non-goals

- Reimplementing a full LMS, gradebook, quiz engine, rubric system, or document
  viewer in the Church4Christ Worker.
- Copying Google Drive or Canvas-managed files into R2 by default.
- Storing assignment bodies, uploaded homework, quiz answers, private comments,
  or grades in Church4Christ by default.
- Treating a YouTube `unlisted` URL as private or access-controlled.
- Making Activity Score visible to learners or using it for automated discipline,
  roles, messages, or pastoral decisions.
- Merging the Canvas Rails/React/PostgreSQL/Redis application into this Astro and
  Cloudflare Workers repository.
- Claiming affiliation with or endorsement by Instructure, Inc.

## Architecture

### Learning Hub

The Church4Christ application owns:

- program and provider mapping;
- People-to-provider identity mapping;
- enrolled learner authorization;
- normalized course, resource, activity, and submission snapshots;
- manual and scheduled synchronization state;
- privacy-bounded activity events;
- bilingual learner and administrator pages; and
- the optional bridge into Activity Score.

The provider owns:

- authoritative course membership;
- source content and files;
- assignment and quiz definitions;
- submissions, answers, comments, grading, and feedback;
- provider-specific permissions; and
- provider launch URLs.

No provider adapter may write directly to provider database tables. Google uses
the official Classroom API. Canvas uses its REST API and, where configured, Live
Events. Every provider read is followed by a bounded reconciliation pass so a
missed notification cannot leave Church4Christ permanently stale.

### Provider interface

`learningProvider.ts` defines a narrow interface implemented by Google Classroom
and Canvas adapters:

- `healthCheck`
- `listCourses`
- `syncCourse`
- `syncEnrollments`
- `syncActivities`
- `syncSubmissions`
- `buildLaunchUrl`
- `normalizeNotification`

Provider responses cross the boundary only as validated, provider-neutral plain
objects. Unknown enum values, oversized strings or collections, unsafe URLs,
duplicate external ids, and malformed timestamps fail closed with non-sensitive
error codes.

### Deployment boundary

The Canvas derivative lives in a separate repository/checkout and deployment. It
may share visual design and identity strategy with Church4Christ, but it is not
compiled, vendored, or linked into the Worker. The two systems communicate over
HTTPS APIs and independently maintain their own databases and operational
runbooks.

## Capability and authorization

`learning` is an optional community capability supported by D1 and PostgreSQL. It
owns `/learn`, `/admin/learning`, and Learning-specific API/webhook paths. It
depends on People and may use Groups, Portal, Activity Score, cron, and email.
It is included in Website + Community and Full Church presets, but not the
Website preset.

A dedicated `learning` admin area controls provider setup, program mapping, sync,
and identity linking. Super administrators always pass. An administrator must
hold the Learning area grant. Learners never receive admin access merely because
they are teachers in an external provider.

Learner routes require a live authenticated Person and an active course
enrollment. Course and item lookups must scope by the current person in the SQL
query; fetching a row and checking ownership afterward is insufficient. Disabled
Learning returns 404 before session authorization. Anonymous learner requests
redirect to sign-in, and authenticated non-enrolled users receive 403 or a
non-disclosing not-found response as appropriate.

## Data model

Migration `0017_learning.sql` is added in both migration trees and uses portable
integer booleans, text timestamps, explicit checks, foreign keys, and deterministic
indexes.

### `learning_provider_connections`

One row per Google Classroom or Canvas connection. It stores provider type,
display label, normalized base URL where applicable, connection state, revision,
last successful sync metadata, bounded error code, creator/updater, and soft
deletion. OAuth or API credentials are not stored in clear text.

### `learning_provider_credentials`

One current encrypted credential envelope per connection: ciphertext, IV/nonce,
algorithm/version, optional expiry, and update timestamp. Encryption keys exist
only as Worker secrets. Logs, errors, HTML, and audit rows never contain token
material. Credential writes and connection activation are atomic.

### `learning_programs` and `learning_courses`

A program describes a church ministry learning context. A course maps one
provider course into one program, recording only a bounded display snapshot,
external id, provider launch URL, lifecycle state, and sync timestamps. External
course ids are unique within a provider connection.

### `learning_identity_links` and `learning_enrollments`

An identity link maps one Person to one opaque external user id within a provider
connection. An enrollment links the identity to a course with a normalized role
(`student`, `teacher`, or `observer`) and state. Email addresses are not used as
permanent cross-system keys. Conflicts require administrator review and never
silently merge People.

### `learning_activities` and `learning_resources`

Activities normalize provider material, assignment, and quiz records. Stored
fields are limited to bounded title, type, lifecycle state, due/publish time,
provider launch URL, and provider update time. Resources normalize YouTube,
provider file, and ordinary link attachments. YouTube stores a validated video id;
provider files store metadata and a provider-controlled launch URL, not file bytes.

### `learning_submission_snapshots`

One current normalized submission snapshot per learner/activity. It stores state,
late flag, attempt number, submitted/returned timestamps, and provider update
time. Grade, answer, comment, rubric, and uploaded-file content are absent in the
initial release.

### `learning_activity_events`

An append-only, deduplicated history of normalized person-linked events such as
`enrolled`, `resource_opened`, `assignment_submitted`, `quiz_submitted`,
`submission_returned`, and `course_completed`. Events contain stable ids, event
type, person/course/activity references where relevant, occurrence time, provider
source, and ingestion time. They do not contain provider payloads or titles.

### `learning_sync_runs`

Bounded operational records for a manual, scheduled, or notification-triggered
sync: connection/course, start/end, status, non-sensitive error code, and numeric
counts. Raw responses, tokens, names, URLs, and submission data are never logged.

## Learner experience

`/[locale]/learn` shows active enrolled courses, upcoming assignments and quizzes,
recent materials, current submission states, and a stale-data warning when the
last successful sync is outside its configured service window.

`/[locale]/learn/[courseId]` shows provider-neutral activity cards:

- YouTube resources reuse the click-to-load `youtube-nocookie.com` facade. The
  unlisted URL is available only after enrollment authorization, responses are
  `no-store`, and UI copy warns teachers that unlisted is not private.
- File resources display type, title, and a provider-controlled launch link. The
  provider remains responsible for download authorization.
- Assignments and quizzes display due date and normalized submission state, then
  launch the exact provider activity. The next sync updates the snapshot.

The initial release does not iframe whole Google Classroom or Canvas pages. This
avoids broken frame policies, hidden login prompts, confusing origin boundaries,
and accidental token exposure.

## Google Classroom integration

Google Classroom uses administrator/teacher OAuth with the minimum required
scopes. Authorization uses exact redirect URI matching, state bound to the
current admin session, PKCE, short expiry, one-time consumption, and encrypted
refresh-token storage. Domain-wide delegation is not assumed.

The adapter synchronizes mapped courses, teachers/students, coursework materials,
coursework, rubrics only when needed for display, and permitted student submission
states. Classroom `registrations` and Google Cloud Pub/Sub may accelerate updates;
registrations are renewed before expiry and every notification still triggers a
bounded API reconciliation rather than being treated as authoritative data.

## Canvas integration

The Canvas adapter accepts an explicitly allowlisted HTTPS base URL and uses
Canvas OAuth/API credentials scoped to the minimum required account/course access.
It synchronizes courses, enrollments, modules/pages/files where mapped,
assignments/quizzes, and submissions. Live Events may trigger reconciliation, but
the regular Canvas API remains authoritative.

The Church4Christ Canvas edition is based on the official repository at
`https://github.com/instructure/canvas-lms`. Its `LICENSE` and `COPYRIGHT` remain
unchanged. A prominent derivative notice identifies Instructure, Inc., the pinned
upstream commit, AGPL v3, lack of endorsement, and the corresponding source URL.
Every deployment exposes an accessible source link and appropriate legal notices.

## Synchronization and failure behavior

- Manual sync is always available to an authorized Learning administrator.
- Scheduled reconciliation runs only for enabled Learning and active connections.
- Work is bounded by connection, mapped course, item count, page count, response
  byte size, and wall-clock deadline.
- Provider `429` and transient `5xx` results use bounded retry/backoff. Permanent
  auth errors disable background retries and ask an administrator to reconnect.
- A failed sync preserves the last complete snapshot and displays staleness; it
  never partially deletes a course.
- Notifications are authenticated, deduplicated, acknowledged quickly, and
  schedule reconciliation through `waitUntil` or a future Queue. Long multi-course
  imports do not run on the request critical path.
- Disconnect revokes credentials when supported, deletes the local encrypted
  envelope, stops sync, and retains only explicitly documented history until its
  retention window expires.

## Security and privacy

- All provider URLs are parsed with `URL`, require HTTPS outside local development,
  and reject credentials, fragments, unexpected ports, and non-allowlisted hosts.
- Tokens use Web Crypto encryption with a versioned envelope and a secret supplied
  through Wrangler secrets, never `vars` or source.
- OAuth/webhook secrets are compared and verified with current platform crypto
  APIs; no security token uses `Math.random()`.
- Response bodies are size-bounded before buffering. Large files are never
  proxied through Worker memory in the initial release.
- Every provider request is awaited; post-response work uses `ctx.waitUntil()`.
- No request-scoped state or credential cache is stored in module-level mutable
  variables.
- Learner and admin responses set `Cache-Control: no-store`; sensitive errors and
  logs contain only bounded codes and structural counts.
- Identity, enrollment, submission, and activity retention is documented and
  removable on disconnect or Person deletion according to operator policy.

## Activity Score integration

Learning adds an optional `learning_engagement` source only after the provider
feed and learner authorization are complete. It is default disabled with weight
zero. The initial evidence is a bounded count of assignment and quiz submissions
within the configured window, with a configurable target. Grades, lateness,
course names, activity titles, files, answers, and comments never contribute.

The existing Activity Score page continues to explain numerator, target, weight,
coverage, and unavailable-source renormalization. Turning Learning off makes the
source unavailable without deleting events or silently changing configuration.

## Verification

- D1 and real PostgreSQL schema/constraint parity for all Learning tables.
- Pure provider-model validation, URL policy, normalization, deduplication, limits,
  and unknown enum rejection.
- Credential envelope round trips, wrong-key/version failures, and no plaintext in
  persistence/logging/error fixtures.
- Capability, module-off, route, admin-area, enrollment, and per-person query
  authorization matrices.
- Google and Canvas adapter contract tests with bounded recorded fixtures plus
  explicit pagination, rate-limit, malformed-data, and auth failure cases.
- Manual/scheduled/notification reconciliation, idempotency, stale snapshot, and
  partial failure behavior.
- Learner video/file/assignment/quiz rendering and provider launch behavior in
  English and Chinese.
- Activity Score privacy and calculation regressions.
- Canvas derivative notice/source visibility and preserved upstream notices.
- Full tests, tokens check, Astro check, production build, smoke, built-worker D1,
  and real PostgreSQL paths before integration.

## Acceptance criteria

Learning is complete when an authorized administrator can connect and health-check
Google Classroom or the Church4Christ Canvas edition, map a provider course and
People, synchronize it manually and on schedule, and diagnose failures without
seeing secrets or raw student work; an enrolled learner can securely view prepared
videos and file links, launch and complete provider assignments/quizzes, and see
the reconciled state; optional activity evidence can feed Activity Score without
grades or content; both database backends, both languages, authorization, privacy,
operations, and provider failure behavior are verified; and the separately
deployed Canvas derivative visibly credits Instructure, preserves AGPL v3 notices,
and exposes corresponding source.
