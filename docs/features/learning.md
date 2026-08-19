# Learning (continue beyond the classroom)

## What it does

Learning gives Sunday school, discipleship, membership classes, and similar ministries an
authenticated place to continue between in-person meetings. Learners can find prepared
privacy-enhanced YouTube videos, provider-hosted files, ordinary links, assignments, quizzes,
due dates, and their current submission state in English or Chinese.

Church4Christ is the provider-neutral learner hub and synchronization control plane; Google
Classroom or Canvas remains provider authoritative. Learners submit assignments and quizzes in
that provider's supported interface. Church4Christ then reconciles a bounded status snapshot—it
does not become a second gradebook or quiz engine.

![Bilingual workflow diagram showing Google Classroom and Church4Christ Canvas feeding Church4Christ secure synchronization, followed by connection and mapping, verification and synchronization, privacy-bounded metadata, learner videos/files/assignments/quizzes, submission in the provider, reconciled status, and optional Activity Score](../images/learning/learning-flow.png)

## Learner experience

An enrolled learner opens `/en/learn` or `/zh/learn`, chooses a course, and sees only the
normalized metadata authorized for that live Person, provider identity, and enrollment. The
course page uses a click-to-load `youtube-nocookie.com` facade with no autoplay. An unlisted
YouTube URL is convenient but is not private or access control. Provider files and ordinary
links open the exact validated HTTPS destination in a new tab; Church4Christ neither iframes
the provider nor proxies file bytes.

The following real 1280×800 local-D1 captures use the canonical fictional Genesis 1 demo.
Seeded learner **Sarah Johnson** supplies the English view, including her submitted assignment
and not-submitted quiz state. Seeded learner **Grace Lin** supplies the Chinese view, including
her returned assignment and submitted quiz state.

![English Genesis 1 learner view showing Canvas status, course activities, due dates, submission state, and provider launch actions](../images/learning/genesis-1-en.png)

![Chinese Genesis 1 learner view showing localized course activities, due dates, returned/submitted states, and provider launch actions](../images/learning/genesis-1-zh.png)

Assignments and quizzes are always completed in Google Classroom or Canvas. Church4Christ shows
due, submitted, and returned metadata only. Grades are not stored; answers are not stored;
comments, assignment bodies, uploaded files, and file bytes are not stored or rendered either.

## Administrator experience

An administrator with the dedicated Learning area grant opens `/admin/learning` to create and
authorize provider connections, map courses, inspect connection health and last-sync state, and
start a manual sync. Scheduled reconciliation scans only enabled Learning installations with
active mapped courses. Authenticated provider notifications can accelerate reconciliation, but
the official provider API remains authoritative and every pass stays bounded.

![Learning administrator overview showing the fictional Canvas connection, active status, provider controls, and the Genesis 1 manual synchronization action](../images/learning/admin-overview.png)

The screenshot intentionally uses a fictional local Canvas snapshot: **Local fictional Canvas
snapshot / 本地虚构 Canvas 快照** from demo data. Every provider launch shown by that snapshot
uses the reserved non-production host `https://canvas-learning.example.test`; the demo has no
provider credentials and assumes no provider network. Do not treat its health, OAuth, or
manual-sync buttons as a connected service. Replace it with an authorized real provider
connection before operational testing.

Transient rate limits and provider failures preserve the last complete snapshot and surface
staleness instead of partially deleting a course. Permanent authentication failures ask an
administrator to reconnect. Disconnecting a provider stops synchronization and removes the
credential envelope according to the documented cleanup path.

## Provider choices

- **Google Classroom:** Church4Christ uses the official Classroom API with administrator/teacher
  OAuth. Pub/Sub notifications, when configured, schedule authoritative reconciliation.
- **Church4Christ Learning — Canvas Edition:** an independently deployed Canvas LMS derivative
  communicates with Church4Christ through the Canvas REST API and, optionally, Live Events. It
  has its own PostgreSQL database, Redis, background-job workers, web/application services,
  object/file storage, deployment, backups, and source-publication obligations; it is not
  vendored into this Astro/Workers repository.

Provider choice is per program or course, so a church may operate Google Classroom for one
ministry and Canvas for another.

## Privacy and Activity Score

Personalized learner and administrator responses are `Cache-Control: no-store`. Provider
credentials remain encrypted server-side and never enter page HTML or browser JavaScript.
Provider URLs are normalized and allowlisted; unsafe destinations fail closed. Synchronization
logs contain bounded structural counts and error codes rather than People data, names, URLs,
tokens, raw bodies, or continuation tokens.

Learning engagement is an optional Activity Score source and is disabled with weight zero by
default. When explicitly configured, it counts only deduplicated assignment and quiz submission
events inside the selected window. Grades, lateness, course/activity titles, answers, files, and
comments never contribute. If Learning is disabled or disconnected, Activity Score renormalizes
the remaining available dimensions without deleting Learning events or changing the saved model.

## Retention, deletion, and operator verification

Version 1.1.0 intentionally has **no automatic time-based Learning retention/TTL job**. A provider
disconnect disables the connection and synchronization, but the two provider cleanup sagas retain
different minimum state. Canvas moves its encrypted credential into a cleanup task and deletes the
active credential row, Canvas OAuth state, event receipts, and webhook configuration. Google
disables its credential from active use and retains the encrypted provider credential until cleanup
finalization; it removes live registration rows locally, but Google OAuth state and notification
receipts are not removed by disconnect and remain subject to the retention policy.

Normalized courses, activities, identity links, enrollments, submission status snapshots, bounded
sync facts, and append-only activity events may remain as explicitly retained history.
Activity events retain stable source/event identifiers, provider and event type, Person, identity,
enrollment, course, and activity references, activity kind, and occurrence and ingestion timestamps.
Those references and timestamps are sensitive congregation engagement facts even though the rows
contain no grades, answers, comments, assignment bodies, uploaded file bytes, or raw provider
payloads. All retained Learning rows therefore need an operator-approved retention period.

Document the church's purpose, retention duration, deletion approver, backup impact, and legal or
pastoral hold process before production. Person deletion cascades the Person-scoped Learning graph;
provider/course history can be purged only through a reviewed lifecycle after its connection is
disabled/deleted or course is soft-deleted. Do not bypass the active-parent and append-only database
guards with ad-hoc migration-history edits. A restore can reintroduce deleted rows, so include
Learning in backup-retention and restore-erasure procedures. Disabling the module alone is not a
deletion request and does not alter saved provider or Activity Score configuration.

`npm run doctor -- --strict` verifies the selected module catalog and required tables/schedules it
can inspect. It cannot prove OAuth consent, provider scopes, Pub/Sub/Live Events delivery, manual or
scheduled sync, credential revocation, retention execution, or a restore. Before go-live, capture
separate evidence for a real authorized connection, mapping, manual sync, `:15` maintenance, `:45`
reconciliation, authenticated notification (if configured), disconnect cleanup, and matched restore.

## Canvas provenance and credit

Church4Christ Learning — Canvas Edition is based on the official
[Canvas LMS repository](https://github.com/instructure/canvas-lms), developed and maintained by
**Instructure, Inc.** The derivative baseline is upstream commit
`1c9f0bb8013ed69c4f2efe11fd483025469b7e6c` and remains licensed under **GNU AGPL v3** with the
upstream `LICENSE` and `COPYRIGHT` notices preserved. Church4Christ Learning — Canvas Edition is
not affiliated with, sponsored by, or endorsed by Instructure, Inc.

The derivative lives in a separate repository/checkout and deployment. Its
[`CHURCH4CHRIST_NOTICE.md`](https://github.com/leveo/canvas-lms/blob/57c5ad2505cf69c95faead538995fc59c6c38fe8/CHURCH4CHRIST_NOTICE.md)
records the pinned upstream, modification history, no-endorsement notice, and the obligation for
deployed modified versions to prominently offer corresponding source to remote users. This 1.1.0
documentation was audited against published derivative revision
[`57c5ad2505cf69c95faead538995fc59c6c38fe8`](https://github.com/leveo/canvas-lms/tree/57c5ad2505cf69c95faead538995fc59c6c38fe8)
in the [Church4Christ Canvas derivative source repository](https://github.com/leveo/canvas-lms).
A deployment must link to the exact corresponding source for its own build, not merely to an
unrelated or moving branch. That legal/source boundary is separate from Church4Christ's GPLv3
application license.

Operate Canvas as a separate service boundary. Back up and restore-test its PostgreSQL database,
Redis/job state as appropriate, uploaded/object files, configuration/secrets, and deployed source
together; the Church4Christ D1/Postgres and R2 backup does not cover Canvas. For an upstream update,
fetch the official `instructure/canvas-lms` remote, review release/security notes and the full
pinned-commit diff, merge or rebase in an isolated branch, preserve `LICENSE`/`COPYRIGHT` and
`CHURCH4CHRIST_NOTICE.md`, rerun Canvas's own tests and restore rehearsal, update the pinned commit
and modification log, publish exact corresponding source, then update the deployment. Never treat
this Astro/Worker release as an automatic Canvas upgrade.

## Demo capture and implementation notes

Setup applies the Genesis fixture only when explicitly passed `--demo-data`.
The screenshot runbook deliberately applies `seed/dev-seed.sql` directly through
`npm run db:seed:local`. Choose one strong, ephemeral `SCREENSHOT_SESSION_SECRET` of at least 32
non-whitespace characters and put the same value in the environment of both local processes. It
is distinct from `SESSION_SECRET` and does not need to match it. Do not add it to `.dev.vars`, a
shell command, or any file; enter or paste it without echo through your shell or password
manager, and unset it after capture.

```bash
npm run db:migrate:local
npm run db:seed:local

# Dev-server shell: set SCREENSHOT_SESSION_SECRET in this process, then start Astro.
npm run dev

# Capture shell: set the same SCREENSHOT_SESSION_SECRET in this process, then capture.
npm run screenshots -- --only learning/genesis-1-en.png,learning/genesis-1-zh.png,learning/admin-overview.png
```

The harness refuses an unfiltered capture, mints a five-minute session for each exact seeded
identity, accepts only an exact `localhost`, `127.0.0.1`, or `[::1]` HTTP(S) origin, validates
positive and rejection markers before writing, and requires every PNG to be
exactly 1280×800 and larger than 20 KB. The secret and session token are never printed or written
by the harness.

Core implementation lives in `src/lib/learningModel.ts`, the Google and Canvas adapters,
`src/lib/learningDb.ts`, `src/lib/learningSync.ts`, `src/lib/learningLearnerDb.ts`, the learner
pages under `src/pages/[locale]/learn/`, and the admin pages under
`src/pages/admin/learning/`. Portable migrations are `0017` through `0025`; the optional Activity
Score bridge is forward migration `0026_activity_score_learning.sql`.
