# Newcomer Intake and Follow-up Implementation Plan

> **Required execution skills:** subagent-driven-development, test-driven-development,
> workers-best-practices, and verification-before-completion.

**Goal:** Add public and staff newcomer intake plus a permission-scoped bilingual
follow-up queue without implicit People creation or broad People access.

**Delivery:** Two sequential PRs. Foundation owns migration `0014_newcomers.sql`; the
experience PR registers and exposes the capability only after the foundation is merged.

## Resolved product and security choices

- Default status categories: New, Assigned, Contacted are open; Connected and Closed are
  closed. Exactly one active open status is initial. DB constraints prevent multiple or
  invalid initial flags; transactional application validation prevents zero.
- Select fields have separate option and option-i18n tables. Fixed core contact/consent
  fields cannot be removed; custom fields may be required.
- Queue/settings permissions differ: a scoped Newcomers staff grant can use queue/actions
  without becoming an admin or receiving `people-basic`; status/field settings are
  super-admin only.
- A newcomer worker may link only a server-returned exact live Person match. Creating a
  visitor requires both Newcomers and full People access (or super-admin). Phone-only
  submissions cannot create a Person until an email is collected because People email is
  required; they remain fully usable in the newcomer queue.
- Public rate limits use a database-backed 10-minute window: at most 5 attempts per
  HMAC-normalized contact and 20 per trusted client IP. Only keyed hashes and counters are
  stored; the secret binding is `NEWCOMER_RATE_LIMIT_SECRET`; rows expire after 48 hours.
  A missing secret fails the public endpoint closed with a generic 503 and creates no
  submission; it never falls back to unhashed identifiers.
- Only the Cloudflare runtime's trusted `CF-Connecting-IP` value supplies the IP bucket;
  `X-Forwarded-For` is ignored. When the trusted value is absent, all such requests share
  an `unknown` keyed bucket with a stricter 5-attempt/10-minute ceiling.
- Public success is generic for accepted, honeypot, and duplicate-like cases. The form
  requires contact consent; staff entry explicitly records whether consent exists.
- No automated marketing, magic link, household, merge, revival, or Person is created by
  intake. Newcomer notes/answers never copy to pastoral notes.

## PR A: Foundation, schema, and scoped permission carrier

### Files

- Create both `0014_newcomers.sql` migrations.
- Create `src/lib/newcomerValidation.ts`, `src/lib/newcomerDb.ts`.
- Create Workers/PG validation, schema, transaction, race and permission tests.
- Modify `src/lib/adminAreas.ts`, `currentUser.ts`, `routePolicy.ts`, `types.ts`,
  `adminDb.ts`, super-admin grant UI, middleware tests, and schema parity.
- Do not register the capability or create Astro routes in this PR. The foundation adds
  only the authorization classifier/types and unit tests; route-to-capability integration
  and every reachable URL arrive together in PR B.

### Task 1: Schema and defaults

- [ ] Add RED schema tests, then parity migrations for statuses/i18n, fields/i18n,
  field options/i18n, submissions, answers, notes, activity, and rate-limit counters.
- [ ] Use text UUIDs for submissions/notes/activity and add `version` plus
  `last_mutation_id` for CAS across D1 batch and PG transactions.
- [ ] Seed the five stable statuses in migration data and test category, order, active,
  and the single initial New status.

### Task 2: Scoped Newcomers staff authorization

- [ ] Characterize that non-admin grants are currently inert, then add a narrowly typed
  scoped-staff grant that only activates `newcomers`.
- [ ] Keep all legacy admin areas inert for members. Ensure Newcomers staff cannot access
  `/admin/people`, households, pastoral notes, roles, or security settings.
- [ ] Add longest-prefix Newcomers route class before broad `/admin`; module and inline
  gates must still precede business reads/body parsing.

### Task 3: Validation and read models

- [ ] Implement normalized email/phone, shared public/staff intake validation, bounded
  questions/options/answers, queue filters, locale fallback, duplicate hints, and PII-free
  stable errors through RED/GREEN tests.
- [ ] Add status/field management with super-admin authorization and transactional
  single-initial enforcement.

### Task 4: CAS mutation layer

- [ ] Implement create submission, assignment, status, due date, note, link and safe
  visitor-create APIs. Every mutation accepts expected version and server actor.
- [ ] Put the CAS claim first; condition all following statements on the same mutation id;
  map stale/unique/FK failures to safe typed conflicts with complete rollback.
- [ ] Create visitors with role=member, membership=visitor, active=1 and no privileges;
  never call `savePerson`, which can revive a soft-deleted email.
- [ ] Prove D1/PG parity, concurrent stale updates, no orphan activity/notes/person, and no
  contact/note leakage in errors.

### Task 5: Deliver foundation

- [ ] Run full Workers/PG verification and security review.
- [ ] Merge after green PR CI, verify exact main SHA CI, then delete branch/worktree.

## PR B: Public/staff intake and follow-up experiences

### Files

- Create `src/lib/newcomerHttp.ts`.
- Create `src/pages/[locale]/new-here.astro`.
- Create `src/pages/admin/newcomers/{index.astro,new.astro,[id].astro,settings.astro}`.
- Create D1/PG built-worker tests and `docs/features/newcomers.md`.
- Modify capability catalog, navigation, setup doctor, seed, en/zh i18n, generated docs,
  admin permissions, architecture, changelog and module count tests.
- Modify `scripts/setup/secrets.mjs`, setup apply/doctor/plan tests, generated Wrangler
  config/types, local and E2E Wrangler bindings, `.dev.vars.example`, `docs/deploy.md`, and
  Cloudflare/Supabase setup guides for `NEWCOMER_RATE_LIMIT_SECRET`.

### Task 1: Register the complete capability

- [ ] Add `newcomers` for both databases, public `/new-here`, admin
  `/admin/newcomers`, People dependency, optional email, and Community/Full presets.
- [ ] Final catalog counts become 19 total, Website 8, Community 16, Full 19.
- [ ] Test module-off 404 before session/body reads, hidden navigation, scoped-staff access,
  no unrelated People access, and super-admin behavior.

### Task 2: Bounded public and staff intake

- [ ] Implement a streaming-bounded form reader before `formData()`, with total/body/cell
  caps, strict duplicate-part handling, safe errors, honeypot, generic success, no-store,
  consent, and database-backed keyed-hash rate limits.
- [ ] Public POST redirects to generic success and creates only a submission/activity row.
- [ ] Staff form reuses validation, records consent truthfully, and does not trigger contact.
- [ ] Test enumeration resistance, concurrent rate windows, expiry cleanup, module/CSRF,
  no raw logging, and zero People/household/session/email writes.
- [ ] Add the new secret to the managed-secret allowlist and setup prompts without ever
  printing its value. Prove missing-secret 503/no-write, present-secret hashing, no plaintext
  contact/IP in rate rows, doctor redaction, and D1/PG E2E binding parity.
- [ ] Prove spoofed `X-Forwarded-For` never changes a bucket and missing trusted IP uses
  the stricter unknown bucket.

### Task 3: Queue, detail, assignment, status and notes

- [ ] Implement bilingual queue filters for status, assignee, due/overdue, visit date and
  service; implement detail answers/activity plus CAS assignment/status/due/note actions.
- [ ] Render all user input as text; never expose private notes/answers to public, People,
  group leader, logs, or error responses.

### Task 4: Duplicate review, link, and visitor creation

- [ ] Show server-derived hints for normalized contact against live/soft-deleted People
  and open submissions without auto-linking.
- [ ] Link only a selected server-returned live result; force a fresh read on conflicts.
- [ ] Require People+Newcomers authority and a current email for safe visitor creation;
  phone-only records show a collect-email handoff state.
- [ ] Prove no merge/revive/privilege and that notes/answers remain in Newcomers.

### Task 5: Configuration, seed, docs, and delivery

- [ ] Build super-admin bilingual status/field/option settings with last-initial protection.
- [ ] Seed fictional public/staff submissions, answers, assignments and activity.
- [ ] Update docs/capability generation/setup doctor/i18n exhaustive result-code tests.
- [ ] Run complete Workers, real PG, D1/PG built-worker and security verification.
- [ ] Merge after green PR CI, verify exact main SHA CI, then delete branch/worktree.
