# Durable Stripe Webhook Reliability Design

**Status:** Approved design, ready for implementation planning

**Date:** 2026-07-13

**Scope:** `church-cms` only; `church4christ-demo` remains untouched

## Context

Giving and paid Registration share `POST /api/stripe/webhook`. The endpoint verifies
Stripe's signature and the domain writers are mostly idempotent, but the verified event
is not stored before dispatch. A processing error classified as permanent is logged and
acknowledged with `200 error_logged`, which permanently drops the event. There is no
event-level receipt, processing history, retry lease, dead-letter state, or replay action.

The audit also found correctness gaps that durable replay alone would preserve rather than
repair:

- the shared dispatcher does not receive the enabled-module set, so a Giving event can
  mutate data while only Registration is enabled, and vice versa;
- paid registrations are confirmed on `checkout.session.completed` without requiring
  `payment_status = 'paid'`;
- async Checkout success/failure events are not handled;
- known out-of-order events can become terminal `ignored` outcomes;
- a lost registration session-attachment write leaves Stripe and the local registration
  split; and
- Checkout creation has no stable Stripe idempotency key, so retrying an ambiguous request
  can create another session.

Stripe does not guarantee event delivery order and recommends event-ID deduplication,
quick acknowledgement, asynchronous processing, and payment-state verification before
fulfillment. This design makes those properties explicit without introducing another
managed service.

## Goals

1. While either Stripe-consuming module is enabled, durably store every well-formed,
   signature-verified Stripe event before acknowledging it.
2. Process events at least once, prevent overlapping claims during the normal execution
   budget, and make lease-expiry overlap safe through idempotent domain effects.
3. Make every processing failure visible and recoverable through bounded automatic retry
   and controlled operator replay while its payload remains inside the defined 180-day
   replay window; retain non-sensitive audit metadata after that window.
4. Preserve the existing domain writers and their idempotent convergence behavior.
5. Repair module isolation, payment-state, event-ordering, and Checkout-idempotency gaps in
   the same reliability boundary.
6. Keep setup easy: use Supabase/Postgres and the existing Worker scheduled handler, with
   no Queue, Workflow, Durable Object, or additional binding.
7. Keep webhook payloads and outbound Checkout recovery data private, bounded in retention,
   and absent from logs and admin HTML.
8. Keep D1 installations free of unused Stripe schema and retry triggers.

## Non-goals

- Adding Giving or Registration support to D1.
- Providing exactly-once business effects. The database seam cannot wrap the existing
  dynamic domain handler and inbox finalization in one portable transaction; the contract
  is at-least-once processing with idempotent effects.
- Replacing Stripe Checkout, Customer Portal, or the optional Stripe FDW reconciliation.
- Adding partial-refund accounting.
- Displaying or editing raw Stripe JSON in the browser.
- Adding Cloudflare Queues, Workflows, or another paid/managed resource.
- Creating or modifying `church4christ-demo`.

## Chosen architecture

Use a **Supabase transactional inbox with lease-based processing, five-minute scheduled
recovery, and manual admin replay**.

The alternatives were:

1. **Manual-only database inbox.** Lowest runtime activity, but a payment remains broken
   until a person notices it.
2. **Database audit plus Cloudflare Queue or Workflow.** Strong delivery primitives, but
   another resource must be provisioned, bound, diagnosed, and represented in setup; a
   durable database audit record is still required.
3. **Database inbox plus Worker cron and admin replay.** Uses existing infrastructure,
   keeps setup deterministic, and provides both unattended recovery and an operator escape
   hatch. This is the selected approach.

The inbox is Supabase-only because the two Stripe-consuming modules already require
Supabase. A D1 installation neither migrates the inbox nor schedules Stripe recovery.

## Components

### `stripeWebhookInbox`

A focused data-access module owns receipt, digest comparison, claim, finalization, retry,
manual replay, dismissal, listing, and retention SQL. It accepts `AppDb`; production use is
Supabase. Deterministic helpers use seam-level unit tests, while every SQL state transition
is also proven against real Postgres.

No caller writes inbox state directly. Every finalization includes both `event_id` and the
current `lease_token`, so an expired worker cannot overwrite a newer attempt. A claim uses
a 10-minute lease, while one processor attempt has a 25-second application deadline and
every Stripe request has a 10-second abort deadline. The processor revalidates its lease
before dispatch, before every external fetch/domain-write phase, and before finalization.
The 25-second budget fits Cloudflare's documented
[30-second post-response `waitUntil` window](https://developers.cloudflare.com/workers/platform/limits/).
This prevents overlap in ordinary operation; after an
arbitrary platform pause, an expired attempt can still overlap a successor's business
writes, so domain writers must remain concurrency-idempotent. The design does not claim
exactly-once or absolute single-executor effects.

### `stripeWebhookProcessor`

A service owns one processing attempt:

1. claim an eligible receipt;
2. parse the already-verified stored JSON;
3. load the currently enabled modules;
4. invoke the domain dispatcher;
5. finalize as processed or ignored, defer it, or record a failed attempt; and
6. always release its independently opened Postgres client.

The request endpoint, scheduled handler, and admin replay action all call this service.
They do not duplicate state-transition logic.

### Domain dispatcher

`givingWebhook` remains the domain dispatcher, but its dependency object gains the current
enabled-module set and its result becomes structured:

```ts
type StripeDispatchResult =
  | { state: 'processed'; outcome: string }
  | { state: 'ignored'; outcome: string }
  | { state: 'deferred'; outcome: string };
```

Thrown errors represent failed attempts. `deferred` represents a known internal ordering
dependency that can converge when the immutable payload is replayed later. `ignored` is
terminal for foreign, unsupported, disabled-module, or superseded events.

### Admin operations page

`/admin/stripe-events` is a global Stripe operations page, not nested under Giving, so it
also works for Registration-only installations. Route policy explicitly classifies the
path as `finance`; the page repeats the authorization check. The admin navigation exposes
it to site administrators and finance users only when Giving or Registration is enabled.
The People editor exposes the finance/payment-operations flag when either module is
enabled, so a Registration-only installation can assign that role.

It displays event ID, type, livemode, status, outcome, attempt count, timestamps, and the
sanitized last error. It never renders `payload_json`. POST actions can replay an eligible
failed/ignored event or dismiss a failed event. Dismissed events are a distinct,
non-replayable terminal state. Replay and dismissal record the actor.

## Database design

Add `migrations-supabase/0008_stripe_webhook_events.sql`. The migration creates a
`church_private` schema, revokes all schema access from `PUBLIC`, and creates the inbox and
outbound recovery tables as `church_private.stripe_webhook_events` and
`church_private.stripe_checkout_requests`. Every application query uses a qualified name.
The migration owner used by Hyperdrive retains access; Supabase Data API roles do not gain
access through public-schema defaults. Tests prove `PUBLIC` has no schema/table privilege
and, when `anon`/`authenticated` roles exist, prove those roles cannot select the table.

### `church_private.stripe_webhook_events`

| Column | Contract |
| --- | --- |
| `event_id TEXT PRIMARY KEY` | Immutable Stripe event ID; non-empty and at most 255 UTF-8 bytes |
| `payload_json TEXT` | Exact verified request body; nullable only after retention pruning |
| `payload_sha256 TEXT NOT NULL` | Lowercase digest retained permanently for collision detection |
| `event_type TEXT NOT NULL` | Event type copied from the verified envelope, at most 255 UTF-8 bytes |
| `api_version TEXT` | Event API version when present, at most 64 UTF-8 bytes |
| `event_created INTEGER NOT NULL` | Non-negative Stripe event creation Unix timestamp |
| `livemode INTEGER NOT NULL` | `0` or `1` |
| `status TEXT NOT NULL` | `pending`, `processing`, `processed`, `ignored`, `failed`, or `dismissed` |
| `outcome TEXT` | Machine-readable dispatcher/admin outcome, at most 128 UTF-8 bytes |
| `attempt_count INTEGER NOT NULL DEFAULT 0` | Lifetime claims, incremented only by a successful claim and never reset |
| `retry_cycle_attempts INTEGER NOT NULL DEFAULT 0` | Claims in the current automatic/manual cycle; reset only by authorized replay |
| `next_attempt_at TEXT` | UTC retry eligibility time for `pending` rows |
| `lease_token TEXT` | Random token present only while processing |
| `lease_expires_at TEXT` | UTC lease deadline |
| `last_error TEXT` | Sanitized single-line diagnostic, at most 1,000 UTF-8 bytes |
| `last_action_by INTEGER` | Nullable FK to `people(id)`, `ON DELETE SET NULL`, for replay/dismiss actions |
| `last_action_at TEXT` | UTC timestamp of the most recent replay/dismiss action |
| `received_at TEXT NOT NULL` | First durable receipt time |
| `last_attempt_at TEXT` | Most recent claim time |
| `completed_at TEXT` | Most recent terminal transition time |
| `updated_at TEXT NOT NULL` | Last state change |

Constraints enforce the status set, non-negative event/attempt counters, boolean livemode,
and coherent lease fields. Indexes cover `(status, next_attempt_at)`,
`lease_expires_at`, and newest-first admin listing. The private qualified table is added to
the explicit Supabase-only schema allowlist and every setup/database readiness map that
enumerates required Supabase relations.

### `church_private.stripe_checkout_requests`

The same migration adds a private outbound-recovery table with this contract:

| Column | Contract |
| --- | --- |
| `request_id TEXT PRIMARY KEY` | Server-generated Checkout UUID |
| `request_sha256 TEXT NOT NULL` | Digest of normalized registration input |
| `registration_id INTEGER NOT NULL UNIQUE` | FK to `public.registrations(id)` with cascade delete |
| `request_json TEXT` | Exact canonical Stripe create parameter map; nullable after recovery/retention pruning |
| `session_url TEXT` | Checkout URL retained only while the registration is pending |
| `state TEXT NOT NULL` | `creating`, `attached`, `manual_review`, or `resolved` |
| `reconcile_attempts INTEGER NOT NULL DEFAULT 0` | Lifetime scheduled reconciliation attempts |
| `next_reconcile_at TEXT` | Next eligible scheduled check |
| `last_error TEXT` | Bounded sanitized recovery diagnostic |
| `last_action_by INTEGER` | Nullable FK to `people(id)`, for manual reconcile/cancel decisions |
| `created_at TEXT NOT NULL` | Request creation time |
| `updated_at TEXT NOT NULL` | Last state change |

The existing `registrations.stripe_checkout_session_id` remains the durable Stripe object
link. No request JSON, customer email snapshot, or Checkout URL is added to the public
table. Private-schema revokes and privilege tests cover both private tables.

Constraints enforce the four request states, non-negative attempts, required canonical
JSON while `creating`, and null sensitive fields after `resolved`/`manual_review`. Indexes
cover `(state, next_reconcile_at)` and `registration_id`. The private request primary key,
unique registration FK, and existing unique registration-session index prevent two request
records from owning one registration or one Checkout Session.

`request_json` is the exact canonical, non-secret-but-PII-containing Stripe Checkout
parameter map used for both the initial call and scheduled reconciliation; it prevents a
renamed event or changed site configuration from changing an idempotent retry's parameters.

Paid registration forms receive a server-generated UUID. The application hashes the
normalized event, identity, amount, currency, and answers. Reuse of the same UUID with the
same digest resolves by both registration status and private request/session state:

| Registration status | Private/session state | Reuse result |
| --- | --- | --- |
| `confirmed` | any private state | Idempotently finish private cleanup, redirect to the completed-registration page, and make no Stripe call |
| `cancelled` | any private state | Idempotently finish private cleanup, return the expired-attempt result, require a newly rendered UUID, and never reactivate or call Stripe |
| `pending` | `creating`, no session, request JSON retained | Repeat the exact same-key create, attach ID/URL, then redirect |
| `pending` | `attached`, open-session URL retained | Redirect to the stored URL; no create call |
| `pending` | `attached`, URL cleared because payment is complete/processing | Return waiting-for-payment result; no create call |
| `pending` | `manual_review` | Return actionable payment-review result; no create call |

The same UUID with a different digest is always rejected without changing the original
registration or private request row.

This prevents browser retry or double submission from reserving another seat and makes
capacity behavior explicit for every existing status. Registration creation and its
private request row commit atomically in one database batch; a uniqueness race resolves by
loading the winning request/registration pair and applying the same digest/status rules.

Giving forms also receive a server-generated Checkout request UUID. They have no local row
before Checkout, so the UUID is not stored locally; repeating the same rendered form still
reuses the same Stripe idempotency key and Checkout response.

## Inbox state machine

| State | Eligible transition |
| --- | --- |
| `pending` | Claim when `next_attempt_at` is null or due |
| `processing` | Finalize with the matching lease; reclaim only after lease expiry |
| `processed` | Terminal; duplicates return the stored outcome |
| `ignored` | Terminal; an operator may replay while the retained payload exists |
| `failed` | Terminal after retry exhaustion; replayable while payload is retained, always dismissible |
| `dismissed` | Terminal operator decision; never replayable and payload is immediately pruned |

Claiming is one conditional `UPDATE ... RETURNING` that assigns a random token, sets a
bounded lease, changes status to `processing`, increments `attempt_count`, and records
`last_attempt_at`. The same claim also increments `retry_cycle_attempts`. Cron, request
acceleration, and manual replay all compete through this same claim.

Finalization is compare-and-set on the lease token. If finalization fails after domain
effects occurred, the lease expires and a later attempt converges through existing domain
idempotency. An arbitrary platform pause can let the expired worker resume after a
successor claims the event; the 25-second execution budget and 10-minute lease make that
abnormal, and concurrency tests must still prove the overlapping effects converge safely.
This is deliberate at-least-once behavior.

## Receipt and acknowledgement flow

1. Reject a declared or measured body larger than 1 MiB with `413`, then read the exact
   raw request body. The measured UTF-8 byte length is authoritative when the header is
   absent or inaccurate.
2. Verify the Stripe signature and timestamp against `STRIPE_WEBHOOK_SECRET`.
3. Require a JSON object with a non-empty bounded string `id` and `type`, a non-negative
   integer `created`, a strict boolean `livemode`, and `api_version` that is null/absent or
   a bounded string. A malformed verified envelope receives `400` and is not acknowledged;
   no coercion is performed.
4. Compute SHA-256 from the exact body and insert it as `pending`.
5. When `event_id` already exists:

   - the same digest is a safe duplicate and never replaces stored data; a pending duplicate
     schedules background acceleration when `waitUntil` exists, while processing/terminal
     duplicates only return the current receipt status/outcome;
   - a different digest is an integrity collision, is logged without payloads, and receives
     `400`; and
   - no terminal row is silently reactivated; only the authorized replay transition can
     move retained `failed`/`ignored` rows back to `pending`.
6. A receipt write failure returns `500`, allowing Stripe delivery retry.
7. After durable receipt, return `200 received` promptly. Use the request execution
   context's `waitUntil` only to accelerate processing.

When both Giving and Registration are disabled, the endpoint returns `404` before reading
or verifying the body and stores nothing. This is an intentionally disabled integration,
not an audited module-disabled event. When either module is enabled, the shared endpoint
receives events; the dispatcher can then audit an event for the other disabled module as
`ignored/module_disabled`. Receipts already pending when both modules are later disabled
are still drained by cron and become terminal ignored outcomes without domain mutation.

The background callback never reuses `locals.db`: middleware drains that request-scoped
Postgres client after the response. It opens its own database handle through `openDb`, runs
the shared processor, catches its top-level promise so `waitUntil` never rejects
unobserved, and closes the client in `finally`. If background acceleration does not start,
cannot open the database, or is interrupted before claim, the receipt remains `pending`
for cron. Logs contain only the event ID and a bounded error classification, never payload
or secret values.

## Retry policy

The initial background attempt is attempt 1. Subsequent failed or deferred attempts use
these delays:

1. 5 minutes
2. 30 minutes
3. 2 hours
4. 12 hours
5. 24 hours

Six claims per retry cycle are allowed. After cycle attempt 6 fails or defers, the row becomes `failed`
with a sanitized diagnostic and supports operator replay during the 180-day payload window
or dismissal at any time. Manual replay
resets `retry_cycle_attempts` and scheduling eligibility but never resets the lifetime
`attempt_count`, last action, or audit timestamps.

All thrown handler errors are durable and bounded-retryable. The current distinction that
swallows a presumed permanent logic error is removed from endpoint response policy.
Foreign or unsupported traffic remains a successful terminal `ignored` result rather than
an exception.

The scheduled pass claims at most 10 due rows and processes them sequentially to bound
execution time and Stripe/Postgres pressure. Every attempt stops scheduling new work at its
25-second deadline, every Stripe fetch aborts after 10 seconds, and a successor cannot
claim until the 10-minute lease expires. Lease-token finalization plus idempotent domain
writers make abnormal expired-worker overlap convergent; lease expiry alone is not treated
as a fence around business writes.

## Domain correctness rules

### Module isolation

- `kind = 'gift'` effects require the Giving module at processing time.
- `kind = 'registration'` effects require the Registration module at processing time.
- A disabled module produces terminal `ignored` outcome `module_disabled`; it never
  mutates that module's tables.
- Unknown kinds and unknown event types remain terminal audited `ignored` events.

### Checkout payment states

Both Giving and Registration handle:

- `checkout.session.completed` only when `payment_status = 'paid'` for money/seat effects;
- `checkout.session.async_payment_succeeded` through the same paid fulfillment path; and
- `checkout.session.async_payment_failed` as no gift effect and, for Registration, a
  cancellation of a still-pending seat.

An unpaid completion is terminal `ignored` with outcome `awaiting_async_payment`; replaying
that immutable event cannot make it paid. Stripe's later async-success event is a distinct
event and performs fulfillment.

### Out-of-order registration events

For signed Registration Checkout events, `metadata.registration_id` is a recovery key.
When the stored session ID is absent because attachment failed, the processor attaches and
transitions the pending registration in one guarded write only when all of these match:

- metadata kind and registration ID;
- local pending registration;
- existing session ID is null or equals the incoming session ID;
- amount and currency equal the local registration; and
- the event has the required payment state for confirmation.

A known Registration event whose pending row is not yet visible returns `deferred` rather
than `ignored`. Expiration and async failure use the same guarded session-ID/registration-ID
resolution to free the seat.

### Out-of-order refunds

Checkout already places `kind = 'gift'` metadata on the PaymentIntent. Stripe copies that
metadata to the resulting Charge. A full `charge.refunded` event with `kind = 'gift'` but
no matching local gift is therefore an internal ordering gap and returns `deferred`.
A foreign refund remains `ignored`. Partial-refund accounting remains out of scope.

### Existing event-order handling

The existing invoice-before-checkout recovery, subscription upsert, gift unique indexes,
registration conditional updates, refund conditional update, and customer/subscription
idempotency remain. Tests must prove that replay after a partial multi-write attempt
converges without duplicating money or seats.

## Checkout request idempotency and registration recovery

`stripeRequest` gains an optional idempotency-key input for POST calls and sends the
`Idempotency-Key` header. `StripeError` also preserves bounded `status`, Stripe error
`type`/`code`, and request ID fields so recovery decisions do not depend on parsing a
human message. Keys are deterministic namespaced values derived from the server-generated
Checkout request UUID:

- `church4christ:registration:<uuid>`
- `church4christ:giving:<uuid>`

The paid registration route first atomically creates or resolves the idempotent local
registration/private request pair, calls Stripe with the stable key, then atomically writes
the returned session ID to `registrations` and URL/state to the private request row. The
session metadata continues to contain the registration ID and also carries the request
UUID. The route never returns the URL until that attachment commits.

The route cancels the local pending row only when no Checkout session could have been
created: local preflight/configuration failure or a Stripe HTTP `4xx` response other than
`408`, `409`, `424`, or `429`. Transport errors, `408`, `409`, `424`, `429`, Stripe `5xx`,
and any post-Stripe database failure are ambiguous and do not cancel a possibly valid
session. The eventual signed webhook can self-attach and confirm/cancel the row.

The five-minute Supabase Stripe recovery pass also owns outbound registration
reconciliation. It examines every paid registration still pending 45 minutes after the
Checkout request, whether its session is attached or unattached:

- an attached row retrieves the current Checkout Session by its stored session ID;
- an unattached row resends the exact private create parameters with the same idempotency
  key and, when an ID is returned, retrieves that current Checkout Session; and
- an unattached ambiguous response leaves the row pending and schedules another attempt.

A definitively retrieved session drives these transitions:

- `payment_status = 'paid'` attaches and confirms it through the same guarded transition;
- `status = 'complete'` with unpaid/processing payment attaches it and waits for the async
  success/failure event;
- `status = 'expired'` attaches and cancels it; and
- `status = 'open'` remains attached and pending while its URL can still be used; once
  Stripe reports it expired, the next pass cancels it.

Stripe API v1 [retains idempotent results for at least 24 hours](https://docs.stripe.com/api/idempotent_requests?lang=curl).
If an unattached request still cannot obtain a session ID, it remains pending and visible.
The final automatic same-key create attempt runs before 23 hours 45 minutes. A definitive
response can still resolve it, but an ambiguous result moves the private request to
`manual_review`; it never auto-cancels the registration. Automatic create retries stop
before Stripe's 24-hour idempotency window can expire and turn the same key into a new
operation.

Automatic outbound checks occur at request ages 45 minutes, 90 minutes, 3 hours, 8 hours,
16 hours, and 23 hours 45 minutes. After the last age, unattached ambiguity becomes
`manual_review`; an attached session can still be retrieved safely by ID and is checked
once per 24 hours until terminal or operator resolution.

`manual_review` preserves the local registration as pending so a delayed signed paid event
can still self-heal it. Before that state, the operations page exposes `Reconcile now`.
For `manual_review`, it exposes `Attach verified session` and `Cancel after Stripe
verification`. The attach action accepts a bounded Checkout Session ID found by the
operator in Stripe, retrieves it server-side, and proceeds only when metadata request ID,
registration ID, amount, and currency all match; the browser never supplies payment state.
After validation it uses the same retrieved-session matrix: paid confirms, complete/unpaid
attaches and waits, expired attaches and cancels, and open attaches/remains pending with its
URL. An unpaid retrieved session can never confirm the registration.
Only the explicit cancel action releases the seat without a definitive expired session.
Attached sessions continue scheduled retrieval by ID beyond 24 hours until Stripe reports
paid/expired, a webhook resolves them, or an operator acts. There is no age-only automatic
cancellation.

Whenever registration status becomes confirmed or cancelled, webhook/recovery processing
moves the private request to `resolved` and clears request JSON/session URL. If that second
write fails after the registration transition, the next scheduled pass observes the
terminal registration and performs the idempotent cleanup.

Tests use a fake clock at the 45-minute and 23-hour-45-minute boundaries, cover ambiguous
final calls without cancellation, cover attached paid/expired sessions whose webhook never
arrived, and cover a delayed paid webhook healing a `manual_review` request. Giving has no
pre-Checkout seat or local row, so it uses the stable key for browser/network convergence
but needs no outbound recovery record.

## Provider-specific scheduled configuration

The Worker supports four static scheduled branches:

- daily reminder;
- weekly digest;
- daily D1 backup; and
- five-minute Stripe inbox recovery.

Generated configuration contains exactly three based on the selected provider:

- **D1:** reminder, digest, backup;
- **Supabase:** reminder, digest, Stripe recovery.

The Wrangler template gains a provider-derived cron token. Doctor derives the expected
configured schedules from `manifest.database` and verifies that `worker.ts` contains the
complete supported branch set. This replaces the current assumption that configured and
source cron arrays are always identical. The checked-in D1 configuration keeps its current
three schedules; existing generated Supabase configurations move through the setup
preflight/diff/replacement path rather than being silently edited.

Stripe remains optional for Supabase features. With no stored events, the recovery pass is
a bounded no-op; doctor continues to report absent Stripe secrets as a limitation for
optional online payments and an error for partial configuration.

## Security, privacy, and retention

- Signature verification always precedes storage and parsing for processing.
- Secrets, signatures, payloads, donor details, and stack traces never enter logs,
  readiness output, manifests, or admin HTML.
- `last_error` is converted to a bounded, single-line, redacted diagnostic. Known secret
  values are never interpolated.
- Replay and dismissal are POST-only, same-origin/CSRF protected by existing middleware,
  authorization checked again in the route, and actor-audited.
- Raw event JSON lives only in the access-revoked `church_private` schema. Migration and
  clean-room tests prove it is not selectable through `PUBLIC`, `anon`, or `authenticated`
  database privileges; application HTML/log tests are an additional boundary, not the
  primary database authorization control.
- Processed and ignored payloads are set to null 90 days after terminal processing.
- Failed payloads remain replayable for at most 180 days after their latest failed terminal
  transition. The admin page warns during the final 30 days. At expiry the payload is set
  to null, outcome becomes `payload_expired`, and replay is disabled while the failed audit
  row remains.
- Dismissal moves a failed row to distinct status `dismissed`, records the actor/outcome,
  immediately sets the payload to null, and can never be replayed.
- A Checkout request's canonical JSON is cleared immediately after successful session
  attachment, explicit definitive failure, or transition to `manual_review`, and therefore
  never remains longer than 24 hours. Its session URL is retained only while the retrieved
  session is open and the registration remains pending; it is cleared on complete,
  expired, confirmed, cancelled, resolved, or manual-review transition. Request ID, digest,
  registration ID, state, attempts, and timestamps remain for idempotency/audit.
- Event ID, digest, type, status, outcome, attempts, and timestamps remain after payload
  pruning so late duplicate delivery cannot reapply effects.

## User experience

The Stripe operations page provides:

- filters for failed, pending/processing, processed, ignored, and dismissed events;
- a separate registration Checkout-recovery panel for `creating`, `attached`, and
  `manual_review` private request states;
- newest-first bounded pagination;
- clear event age, type, mode, attempts, outcome, and sanitized failure;
- `Replay` for retained failed/ignored events only;
- `Dismiss` for failed events with a confirmation step;
- `Reconcile now`, guarded `Attach verified session`, and explicit `Cancel after Stripe
  verification` actions for the applicable Checkout-recovery states;
- a payload-expiry warning/disabled replay state for old failed events; and
- localized English and Chinese labels, empty states, success notices, and errors.

The page explains that replay is idempotent but may repeat a partially completed handler,
and that raw customer/payment payloads are intentionally hidden. It links to the existing
Giving reconciliation page when Giving is enabled; reconciliation remains a complementary
ledger audit rather than a replay mechanism.

## Testing strategy

Implementation follows strict test-first red/green cycles.

### Schema and data layer

- Migration creates the exact two Supabase-only private tables, constraints, indexes, and
  foreign keys without D1 drift.
- The private schema/table grants deny `PUBLIC` and, when present, Supabase `anon` and
  `authenticated` roles for both tables while the migration/Hyperdrive owner can read and
  write.
- Same-ID/same-digest receipt deduplicates; same-ID/different-digest rejects without
  replacement.
- Conditional claims exclude an active lease and reclaim an expired lease.
- A stale lease token cannot finalize another worker's claim.
- Retry delays and six-attempt terminal failure are exact.
- Manual replay/dismissal records the actor and preserves audit history.
- Retention enforces exact 90-day processed/ignored, immediate dismissed, and 180-day
  failed-payload boundaries while preserving dedup metadata.
- Deterministic hashing, redaction, backoff, and state-decision helpers use seam-level unit
  tests; every receipt, claim, finalization, replay, dismissal, and retention SQL transition
  also runs against real Postgres.

### Endpoint and processor

- Oversized body, bad signature, absent secret, malformed envelope, missing ID/type,
  non-boolean livemode, invalid created timestamp, and overlong audit fields never create
  a receipt.
- Receipt failure returns non-2xx; durable receipt returns `200` before domain completion.
- Active leases prevent ordinary duplicate dispatch; a deliberately paused attempt that
  resumes after lease expiry overlaps a successor without duplicating domain effects.
- The 10-second Stripe abort, 25-second attempt deadline, 10-minute lease, and stale-token
  finalization rules are exact under a fake clock.
- Background acceleration opens and closes its own database client.
- A crash/error after one business write is replayed and converges without duplication.
- Failed finalization is recovered after lease expiry.

### Domain behavior

- Giving cannot mutate while Giving is disabled and Registration remains enabled; the
  inverse is also covered.
- Registration never confirms an unpaid Checkout.
- Async success fulfills both Giving and Registration; async failure frees a registration
  seat without creating a gift.
- Missing registration attachment self-heals from guarded metadata.
- Early known gift refund and registration completion defer and later converge.
- Foreign and malformed Stripe traffic remains terminal ignored without mutation.
- With both modules disabled the endpoint returns 404 and stores nothing; disabling both
  after receipt drains existing pending rows to ignored without mutation.
- Existing invoice/subscription/refund/redelivery tests stay green.

### Checkout routes

- Repeated giving and registration submissions reuse the same Stripe idempotency key.
- Same registration request UUID plus changed normalized input is rejected.
- Confirmed, pending-attached, pending-unattached, and cancelled registration request reuse
  follows the exact redirect/retry/reject contract.
- Transport, `408`, `409`, `424`, `429`, Stripe `5xx`, and post-Stripe DB ambiguity preserves
  the pending registration; definitive preflight/other `4xx` failure cancels it.
- The webhook self-heals a lost session attachment.
- At 45 minutes both attached and unattached rows reconcile against retrieved Stripe
  session state; open/expired/processing/paid cases are covered.
- An ambiguous final 23-hour-45-minute attempt enters `manual_review` without cancellation;
  delayed paid webhook, verified-session attach, and authorized manual cancel paths are
  covered.
- Manual verified-session attach rejects each request-ID, registration-ID, amount, and
  currency mismatch independently, and proves unpaid/processing sessions never confirm.
- Private request JSON/URL pruning and permanent request digest metadata obey the exact
  attachment, terminal, manual-review, and 24-hour boundaries.

### Admin, setup, and integration

- Anonymous, ordinary member, and editor access is denied; admin and finance access is
  allowed under the defined module gate.
- Route policy, navigation, and People role management allow assigning payment-operations
  access in a Registration-only installation.
- Raw payload and sensitive fields never appear in rendered HTML or logs.
- Replay/dismiss actions enforce POST, authorization, claim ownership, and audit fields.
- D1 rendering/doctor expects reminder, digest, backup; Supabase expects reminder, digest,
  Stripe recovery; source extraction verifies all four Worker branches.
- D1 clean-room setup remains unchanged and receives no Stripe table/trigger.
- Supabase clean-room setup applies the new migration and passes doctor.
- Full unit, Worker/D1, real-Postgres, E2E, Astro check, build, token, docs, and schema-parity
  gates pass with no unexpected skip or ignored-error weakening.

## Acceptance criteria

1. While either Stripe-consuming module is enabled, a valid Stripe event is never
   acknowledged before its immutable receipt is durable; with both disabled, the endpoint
   is an explicit no-storage 404.
2. A receipt can always be classified as pending, processing, processed, ignored, failed,
   or dismissed, with a visible lifetime attempt count, current-cycle count, latest
   diagnostic, and no silent drop path.
3. Request acceleration, cron, and manual replay share one conditional lease claim. Active
   leases exclude duplicates; an expired-worker overlap cannot duplicate domain effects or
   overwrite its successor's finalization.
4. Every thrown processing error is retained and bounded-retried; exhaustion is visible
   and manually replayable during the 180-day payload window, after which permanent audit
   metadata and dismissal remain but payload replay does not.
5. Replaying after partial effects never duplicates a gift, subscription, refund, or
   registration transition.
6. Disabled modules cannot be mutated through the shared Stripe endpoint.
7. Paid registrations confirm only from paid/successful events, including asynchronous
   success. Stripe-confirmed failed/expired sessions and authorized manual cancellation
   release seats; ambiguous recovery keeps the seat and remains visibly actionable rather
   than risking cancellation of a paid registration.
8. Known event-order gaps defer and converge instead of disappearing as ignored.
9. Checkout browser/network retries converge through local request identity and Stripe
   idempotency keys.
10. Admin/finance users can inspect sanitized status and replay/dismiss eligible events;
    no raw payload or sensitive Checkout recovery value is exposed through HTML, logs,
    `PUBLIC`, `anon`, or `authenticated` database privileges.
11. Setup and doctor generate/verify provider-appropriate schedules without adding Stripe
    infrastructure to D1.
12. Existing installations upgrade additively through normal migrations and explicit
    generated-config replacement safeguards.
13. Processed/ignored, dismissed, and failed raw event payloads plus private Checkout
    request JSON/URLs obey their exact bounded retention rules while permanent digest/audit
    metadata still blocks duplicate effects.
14. All quality gates pass, and `church4christ-demo` remains empty throughout this project.

## Primary references

- [Stripe webhook delivery, duplication, ordering, and asynchronous-processing guidance](https://docs.stripe.com/webhooks?lang=node)
- [Stripe Checkout Session payment-state contract](https://docs.stripe.com/api/checkout/sessions/object?lang=curl)
- [Stripe PaymentIntent-to-Charge metadata propagation](https://docs.stripe.com/payments/payment-intents)
- [Stripe API v1 idempotent request contract](https://docs.stripe.com/api/idempotent_requests?lang=curl)
- [Cloudflare Worker HTTP, `waitUntil`, and Cron duration limits](https://developers.cloudflare.com/workers/platform/limits/)

## Delivery boundary

This project ends when the acceptance criteria and full verification matrix pass and an
independent review finds no unresolved critical or important issues. Only then may the
broader goal proceed to feature selection for `church4christ-demo`; this design does not
authorize creating the demo.
