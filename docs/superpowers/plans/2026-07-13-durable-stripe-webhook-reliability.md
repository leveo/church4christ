# Durable Stripe Webhook Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Supabase-only, test-mode-only Stripe event inbox and registration Checkout recovery system that never acknowledges an accepted event before durable receipt, converges safely under replay, and remains easy to configure without adding Stripe infrastructure to D1.

**Architecture:** Store signed test-mode events and outbound registration requests in the access-revoked `church_private` Postgres schema. One lease-based processor is shared by request acceleration, the Supabase five-minute cron, and finance/admin actions; all Stripe API calls enforce `STRIPE_MODE="test"`, `sk_test_` keys, strict `livemode:false` responses, stable idempotency keys, and 10-second aborts. Existing Giving/Registration writers remain the domain-effect seam, but receive module and lease checkpoints and return structured processed/ignored/deferred results.

**Tech Stack:** Astro 7, TypeScript 6, Cloudflare Workers, `@astrojs/cloudflare`, Supabase/Postgres through Hyperdrive and `postgres.js`, the D1-shaped `AppDb` adapter, Stripe REST API via `fetch`, Vitest workers/node/real-Postgres projects.

---

## Authoritative inputs and non-negotiable boundaries

- Implement every acceptance criterion in `docs/superpowers/specs/2026-07-13-durable-stripe-webhook-reliability-design.md`.
- Stripe is test-mode-only. There is no live-mode switch, live fixture success path, or live-key fallback.
- A genuinely signed `livemode:true` webhook returns `400 live_mode_disabled` before receipt, dispatch, domain mutation, logging of payload data, or `waitUntil` scheduling.
- Registration Checkout parameters omit `expires_at`; every `pending` registration holds a seat until a guarded terminal transition.
- `/Users/leosong/Python/church4christ-demo` remains empty. This plan changes only `church-cms`.
- D1 receives no private Stripe tables, Stripe recovery cron, or Stripe readiness requirement.
- Use strict red/green cycles. Do not weaken skipped-test assertions or replace real-Postgres state tests with mocks.
- Commit after each task only when its targeted tests pass.

## File map

### New production files

- `migrations-supabase/0008_stripe_webhook_events.sql` — private event inbox and outbound Checkout-request schema, constraints, indexes, FKs, and privilege revocation.
- `src/lib/stripeWebhookInbox.ts` — strict envelope parsing, digest/redaction/backoff helpers, receipt/claim/finalize/replay/dismiss/list/retention SQL.
- `src/lib/stripeWebhookProcessor.ts` — one leased processing attempt and due-event drain; owns fresh Postgres client lifetime.
- `src/lib/stripeWebhookEndpoint.ts` — request-size/signature/envelope/receipt response policy and safe background acceleration.
- `src/lib/stripeCheckoutRequests.ts` — registration request digest, atomic registration/request creation, reuse matrix, attachment, cleanup, admin list and CAS transitions.
- `src/lib/stripeCheckoutRecovery.ts` — Stripe session retrieval, exact age schedule, attached/unattached recovery matrix, manual attach/reconcile/cancel operations.
- `src/lib/stripeRecovery.ts` — bounded five-minute orchestration for inbox, Checkout recovery, and retention.
- `src/pages/admin/stripe-events.astro` — finance/admin operations UI with no raw payload or Checkout secrets.

### New test files

- `test/stripeFixtures.ts` — complete test-mode envelope, exact JSON body, and real WebCrypto signature helpers.
- `test/stripeWebhookInbox.test.ts` — pure envelope/hash/redaction/backoff/retention contracts.
- `test/stripeWebhookEndpoint.test.ts` — body/signature/mode/receipt/acknowledgement/background policy.
- `test/pg/stripeWebhookSchema.test.ts` — exact private schema and denied privileges.
- `test/pg/stripeWebhookInbox.test.ts` — real-Postgres receipt and state-machine transitions.
- `test/pg/stripeWebhookProcessor.test.ts` — real effects, retries, lease checkpoints, and client lifetime.
- `test/pg/stripeCheckoutRequests.test.ts` — atomic pair creation, digest/reuse/cleanup state matrix.
- `test/pg/stripeCheckoutRecovery.test.ts` — exact recovery ages, session decisions, ambiguity, and manual operations.
- `test/pg/stripeReliabilityConcurrency.test.ts` — deterministic expired-lease, crash, webhook/recovery, and manual/cron overlap proof.
- `test/registrationCheckout.test.ts` — registration form/request UUID and route decision contracts.
- `test/pg/adminStripeOperations.test.ts` — finance authorization, bounded projections, and guarded operator actions.
- `test/e2e-pg/stripeWebhook.test.ts` — built-worker durable webhook and finance operations smoke.

### Existing production files to modify

- `src/lib/stripe.ts` — test-key/mode guard, structured bounded errors, request options, idempotency header, abort, strict Checkout object parser/retriever.
- `src/lib/givingWebhook.ts` — enabled-module isolation, structured result, async payment events, payment-state gates, defer semantics, checkpoints.
- `src/lib/regDb.ts` — permanent pending-seat predicate and guarded registration/session transitions.
- `src/lib/givingDb.ts` — expose enough result information for internal refund-order deferral without weakening idempotency.
- `src/pages/api/stripe/webhook.ts` — thin adapter into `stripeWebhookEndpoint`.
- `src/pages/[locale]/register/[id].astro`, `src/pages/api/register/submit.ts` — rendered request UUID and recoverable paid-submit flow.
- `src/pages/[locale]/give.astro`, `src/pages/api/giving/checkout.ts` — rendered request UUID and stable Giving idempotency key.
- `src/worker.ts` — fourth static Stripe-recovery branch.
- `config/wrangler.template.jsonc`, `scripts/setup/render-wrangler.mjs`, `scripts/setup/checks/config.mjs` — provider-specific cron arrays and Supabase test-mode marker.
- `scripts/setup/secrets.mjs`, `scripts/setup/index.mjs`, `scripts/setup/checks/services.mjs` — optional test-secret import, local validation, remote-presence honesty, and redaction.
- `scripts/setup/checks/database.mjs`, `scripts/setup/verification.mjs` — qualified private-relation readiness.
- `src/lib/routePolicy.ts`, `src/layouts/Admin.astro`, `src/pages/admin/people/[id].astro` — global finance route/nav and Registration-only role assignment.
- `src/i18n/en.ts`, `src/i18n/zh.ts` — test-mode, inbox, recovery, action, warning, and result copy.
- `docs/features/giving.md`, `docs/features/registration.md`, `docs/cloudflare-setup.md`, `docs/supabase-setup.md` — test-mode-only setup and operations guidance.

### Existing test/harness files to modify

- `test/pg/helpers.ts`, `test/e2e-pg/global-setup.ts`, `test/e2e-pg/setup.ts` — reset/truncate `church_private` deterministically.
- `test/pg/stripe.test.ts`, `test/pg/givingWebhook.test.ts`, `test/pg/regWebhook.test.ts`, `test/pg/regDb.test.ts` — strict mode fixtures and new domain behavior.
- `test/pg/schema.test.ts`, `test/pg/runner.test.ts` — explicit private-schema allowlist and migration idempotency.
- `test/routePolicy.test.ts`, `test/moduleGating.test.ts`, `test/i18n.test.ts` — finance route/module/i18n coverage.
- `test/node/setup/setup-apply.test.ts`, `test/node/setup/setup-cli.test.ts`, `test/node/setup/setup-doctor.test.ts`, `test/node/setup/setup-runtime-hardening.test.ts`, `test/node/setup/setup-files.test.ts` — secret/mode/provider-schedule/readiness contracts.
- `test/setup/clean-room-d1.test.ts`, `test/setup/clean-room-pg.test.ts` — provider-specific final proof.

## Task 1: Make the Stripe HTTP seam test-mode-only and recovery-aware

**Files:**
- Modify: `src/lib/stripe.ts:11-300`
- Modify: `test/pg/stripe.test.ts:7-345`

- [ ] **Step 1: Write failing client-contract tests**

Add cases that prove the exact public seam:

```ts
const TEST_ENV: StripeEnv = {
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_secret',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  APP_ORIGIN: 'https://church.example',
};

it.each(['sk_live_secret', 'rk_test_secret', 'secret', ''])('rejects %j before fetch', async (key) => {
  const { fn, calls } = mockFetch(json({ id: 'cs_test_x', livemode: false }));
  await expect(stripeRequest({ ...TEST_ENV, STRIPE_SECRET_KEY: key }, 'checkout/sessions', {}, { fetcher: fn }))
    .rejects.toMatchObject({ code: 'stripe_test_key_required' });
  expect(calls).toHaveLength(0);
});

it('requires the explicit test-mode marker before fetch', async () => {
  const { fn, calls } = mockFetch(json({}));
  await expect(stripeRequest({ ...TEST_ENV, STRIPE_MODE: undefined }, 'checkout/sessions', {}, { fetcher: fn }))
    .rejects.toMatchObject({ code: 'stripe_test_mode_required' });
  expect(calls).toHaveLength(0);
});

it('sends a bounded idempotency key and abort signal', async () => {
  const { fn, calls } = mockFetch(json({ id: 'obj_1' }));
  const signal = AbortSignal.abort();
  await stripeRequest(TEST_ENV, 'checkout/sessions', { mode: 'payment' }, {
    fetcher: fn,
    idempotencyKey: 'church4christ:registration:00000000-0000-4000-8000-000000000001',
    signal,
  });
  expect(headersOf(calls[0])['Idempotency-Key']).toBe('church4christ:registration:00000000-0000-4000-8000-000000000001');
  expect(calls[0].init?.signal).toBe(signal);
});

it('preserves only bounded Stripe classification fields', async () => {
  const { fn } = mockFetch(new Response(JSON.stringify({
    error: { message: 'declined', type: 'card_error', code: 'card_declined' },
  }), { status: 402, headers: { 'request-id': 'req_test_123' } }));
  await expect(stripeRequest(TEST_ENV, 'checkout/sessions', {}, { fetcher: fn })).rejects.toMatchObject({
    status: 402, type: 'card_error', code: 'card_declined', requestId: 'req_test_123',
  });
});

it.each([{ livemode: true }, {}, { livemode: 'false' }])('rejects non-test Checkout object %#', async (body) => {
  const { fn } = mockFetch(json({ id: 'cs_test_x', url: 'https://checkout', ...body }));
  await expect(createOneTimeCheckout(TEST_ENV, oneTimeArgs, { fetcher: fn, requestId: UUID }))
    .rejects.toMatchObject({ code: body.livemode === true ? 'live_mode_disabled' : 'stripe_response_invalid' });
});
```

Update every existing Checkout mock response in this file to use one complete fixture containing `livemode: false`, valid nullable status/payment/amount/currency/metadata fields, and an HTTPS URL; update every environment to include `STRIPE_MODE: 'test'`.

- [ ] **Step 2: Run the Stripe client tests and confirm red**

Run:

```bash
npx vitest run --project pg test/pg/stripe.test.ts
```

Expected: FAIL because `StripeEnv` has no mode, `stripeRequest` has no options object/idempotency header, and Checkout responses are not mode-validated.

- [ ] **Step 3: Implement the bounded error and request option types**

Replace the current error intersection and positional fetcher with these contracts:

```ts
export type StripeEnv = {
  STRIPE_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  APP_ORIGIN?: string;
};

export class StripeError extends Error {
  status?: number;
  type?: string;
  code?: string;
  requestId?: string;
  stage: 'configuration' | 'transport' | 'response';

  constructor(message: string, fields: Partial<StripeError> & Pick<StripeError, 'stage'>) {
    super(message.slice(0, 500));
    this.name = 'StripeError';
    this.stage = fields.stage;
    if (Number.isInteger(fields.status)) this.status = fields.status;
    for (const key of ['type', 'code', 'requestId'] as const) {
      const value = fields[key];
      if (typeof value === 'string' && value.length > 0) this[key] = value.slice(0, 128);
    }
  }
}

export interface StripeRequestOptions {
  fetcher?: typeof fetch;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export const STRIPE_REQUEST_TIMEOUT_MS = 10_000;

function requireSecret(env: StripeEnv): string {
  if (env.STRIPE_MODE !== 'test') {
    throw new StripeError('Stripe test mode is required', { stage: 'configuration', code: 'stripe_test_mode_required' });
  }
  const secret = env.STRIPE_SECRET_KEY?.trim() ?? '';
  if (!secret.startsWith('sk_test_')) {
    throw new StripeError('A Stripe test secret key is required', { stage: 'configuration', code: 'stripe_test_key_required' });
  }
  return secret;
}
```

Implement `stripeRequest(env, path, params, options = {})` with `options.fetcher ?? fetch`, `options.signal ?? AbortSignal.timeout(10_000)`, and a validated `Idempotency-Key` header only when supplied. Permit 1–255 printable ASCII characters and reject CR/LF.

- [ ] **Step 4: Implement strict test Checkout parsing and retrieval**

Add and use one parser for create and retrieve paths:

```ts
export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  livemode: false;
  status: 'open' | 'complete' | 'expired' | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required' | null;
  payment_intent: string | null;
  amount_total: number | null;
  currency: string | null;
  metadata: Record<string, string>;
}

export function requireTestCheckoutSession(value: unknown): StripeCheckoutSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StripeError('Malformed Stripe Checkout response', { stage: 'response', code: 'stripe_response_invalid' });
  }
  const raw = value as Record<string, unknown>;
  if (raw.livemode === true) {
    throw new StripeError('Stripe live mode is disabled', { stage: 'response', code: 'live_mode_disabled' });
  }
  if (raw.livemode !== false || typeof raw.id !== 'string' || !raw.id.startsWith('cs_test_')) {
    throw new StripeError('Malformed Stripe Checkout response', { stage: 'response', code: 'stripe_response_invalid' });
  }
  return raw as unknown as StripeCheckoutSession;
}

export async function retrieveCheckoutSession(
  env: StripeEnv,
  id: string,
  options: StripeRequestOptions = {},
): Promise<StripeCheckoutSession> {
  if (!/^cs_test_[A-Za-z0-9_]{1,240}$/.test(id)) {
    throw new StripeError('Invalid test Checkout Session ID', { stage: 'configuration', code: 'stripe_session_id_invalid' });
  }
  const secret = requireSecret(env);
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
    signal: options.signal ?? AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
  });
  return requireTestCheckoutSession(await readResponse(response));
}
```

Before the final cast, validate every declared field without coercion: `url` is string/null; `status` and `payment_status` are members of their listed unions; `payment_intent` is string/null; `amount_total` is a non-negative integer/null; `currency` is a bounded lowercase string/null; and `metadata` is a plain object whose keys and values are bounded strings. Create builders additionally require a non-empty HTTPS Checkout URL before redirecting. Convert fetch rejection/abort into a bounded `StripeError` with `stage='transport'`, and non-2xx/malformed JSON into `stage='response'` without retaining the raw body.

Change all Checkout builders to accept `{ fetcher?, requestId?, signal? }`, derive the exact namespaced idempotency key when a request ID is supplied, remove Registration `expires_at`, add `request_id` to Registration metadata when supplied, and parse the response with `requireTestCheckoutSession` before returning it. Keep `requestId` optional only during this seam migration so existing route call sites continue to type-check; Task 9 makes it mandatory for every browser Checkout submission. Change other Stripe fetch helpers to the same options object so the test-key guard and abort deadline cover Portal and subscription retrieval too.

- [ ] **Step 5: Run focused tests and type-check**

Run:

```bash
npx vitest run --project pg test/pg/stripe.test.ts
npm run check
```

Expected: both commands PASS; no fetch occurs for a live/non-test key or absent test-mode marker.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/lib/stripe.ts test/pg/stripe.test.ts
git commit -m "feat(stripe): enforce test-mode client contract"
```

## Task 2: Add the access-revoked private schema and qualified readiness

**Files:**
- Create: `migrations-supabase/0008_stripe_webhook_events.sql`
- Create: `test/pg/stripeWebhookSchema.test.ts`
- Modify: `test/pg/helpers.ts:21-24`
- Modify: `test/e2e-pg/global-setup.ts`
- Modify: `test/e2e-pg/setup.ts`
- Modify: `test/pg/schema.test.ts:9-32,97-111`
- Modify: `test/pg/runner.test.ts`
- Modify: `scripts/setup/checks/database.mjs:4-100,183-213`
- Modify: `scripts/setup/verification.mjs:16-29`
- Modify: `test/node/setup/setup-doctor.test.ts:237-289`

- [ ] **Step 1: Make test resets drop the private schema**

Change every Postgres reset before adding the migration:

```ts
export async function resetSchema(sql: ReturnType<typeof pgClient>) {
  await sql.unsafe('DROP SCHEMA IF EXISTS church_private CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
```

Apply the same `DROP SCHEMA IF EXISTS church_private CASCADE` in `test/e2e-pg/global-setup.ts`, and truncate the two qualified private tables in `test/e2e-pg/setup.ts` after migration (before public seed reset).

- [ ] **Step 2: Write the failing migration and privilege tests**

Create `test/pg/stripeWebhookSchema.test.ts` using the standard `resetSchema` + migration runner pattern. Assert:

```ts
expect(privateTables).toEqual(['stripe_checkout_requests', 'stripe_webhook_events']);
expect(await sql.unsafe(`SELECT has_schema_privilege('public', 'church_private', 'USAGE') AS ok`))
  .toEqual([expect.objectContaining({ ok: false })]);
expect(await sql.unsafe(`SELECT has_table_privilege('public', 'church_private.stripe_webhook_events', 'SELECT') AS ok`))
  .toEqual([expect.objectContaining({ ok: false })]);
```

Also query `information_schema.columns`, `pg_constraint`, and `pg_indexes` to assert the exact columns and named indexes from the design. When `anon` or `authenticated` exists, assert both lack schema usage and table select.

- [ ] **Step 3: Run the schema test and confirm red**

Run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npx vitest run --project pg test/pg/stripeWebhookSchema.test.ts
```

Expected: FAIL because migration `0008` and `church_private` do not exist.

- [ ] **Step 4: Add the exact private migration**

Create the migration with this structure and exact state constraints:

```sql
CREATE SCHEMA IF NOT EXISTS church_private;
REVOKE ALL ON SCHEMA church_private FROM PUBLIC;

CREATE TABLE church_private.stripe_webhook_events (
  event_id TEXT PRIMARY KEY CHECK (octet_length(event_id) BETWEEN 1 AND 255),
  payload_json TEXT,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  event_type TEXT NOT NULL CHECK (octet_length(event_type) BETWEEN 1 AND 255),
  api_version TEXT CHECK (api_version IS NULL OR octet_length(api_version) BETWEEN 1 AND 64),
  event_created INTEGER NOT NULL CHECK (event_created >= 0),
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','processed','ignored','failed','dismissed')),
  outcome TEXT CHECK (outcome IS NULL OR octet_length(outcome) <= 128),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_cycle_attempts INTEGER NOT NULL DEFAULT 0 CHECK (retry_cycle_attempts >= 0),
  next_attempt_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR octet_length(last_error) <= 1000),
  last_action_by INTEGER REFERENCES public.people(id) ON DELETE SET NULL,
  last_action_at TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_attempt_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((status = 'processing') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX stripe_webhook_events_due_idx
  ON church_private.stripe_webhook_events(status, next_attempt_at);
CREATE INDEX stripe_webhook_events_lease_idx
  ON church_private.stripe_webhook_events(lease_expires_at);
CREATE INDEX stripe_webhook_events_received_idx
  ON church_private.stripe_webhook_events(received_at DESC, event_id DESC);

CREATE TABLE church_private.stripe_checkout_requests (
  request_id TEXT PRIMARY KEY CHECK (octet_length(request_id) BETWEEN 1 AND 255),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  registration_id INTEGER NOT NULL UNIQUE REFERENCES public.registrations(id) ON DELETE CASCADE,
  request_json TEXT,
  session_url TEXT,
  state TEXT NOT NULL DEFAULT 'creating' CHECK (state IN ('creating','attached','manual_review','resolved')),
  reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0),
  next_reconcile_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR octet_length(last_error) <= 1000),
  last_action_by INTEGER REFERENCES public.people(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (state <> 'creating' OR request_json IS NOT NULL),
  CHECK (state NOT IN ('manual_review','resolved') OR (request_json IS NULL AND session_url IS NULL))
);

CREATE INDEX stripe_checkout_requests_due_idx
  ON church_private.stripe_checkout_requests(state, next_reconcile_at);
CREATE INDEX stripe_checkout_requests_registration_idx
  ON church_private.stripe_checkout_requests(registration_id);

REVOKE ALL ON ALL TABLES IN SCHEMA church_private FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA church_private FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA church_private FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA church_private FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA church_private FROM authenticated;
  END IF;
END $$;
```

- [ ] **Step 5: Add qualified schema allowlists and readiness probes**

Keep public tables and private relations separate:

```js
const PRIVATE_TABLES_BY_CAPABILITY = Object.freeze({
  giving: Object.freeze(['church_private.stripe_webhook_events']),
  registration: Object.freeze([
    'church_private.stripe_webhook_events',
    'church_private.stripe_checkout_requests',
  ]),
});
```

For Supabase, query `information_schema.tables` for both `public` and `church_private`, normalize to `schema.table`, and require the private relation only when Giving or Registration is enabled. Update the migration-DDL discovery test to capture optional qualified schema names rather than treating `church_private` as a table. Add the private set to `test/pg/schema.test.ts` without adding either table to the public Supabase-only set.

- [ ] **Step 6: Run migration/readiness regression tests**

Run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npx vitest run --project pg test/pg/stripeWebhookSchema.test.ts test/pg/schema.test.ts test/pg/runner.test.ts
npx vitest run --project node test/node/setup/setup-doctor.test.ts
```

Expected: PASS. The D1 created-table set contains neither private relation.

- [ ] **Step 7: Commit Task 2**

```bash
git add migrations-supabase/0008_stripe_webhook_events.sql test/pg/stripeWebhookSchema.test.ts test/pg/helpers.ts test/e2e-pg/global-setup.ts test/e2e-pg/setup.ts test/pg/schema.test.ts test/pg/runner.test.ts scripts/setup/checks/database.mjs scripts/setup/verification.mjs test/node/setup/setup-doctor.test.ts
git commit -m "feat(stripe): add private reliability schema"
```

## Task 3: Implement strict webhook envelope and retry-policy helpers

**Files:**
- Create: `src/lib/stripeWebhookInbox.ts`
- Create: `test/stripeFixtures.ts`
- Create: `test/stripeWebhookInbox.test.ts`

- [ ] **Step 1: Create complete signed Stripe fixture helpers**

Add one canonical envelope builder so integrated tests cannot accidentally omit mode/audit fields:

```ts
export function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  over: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'evt_test_000000000001',
    type,
    api_version: '2026-06-30',
    created: 1_700_000_000,
    livemode: false,
    data: { object },
    ...over,
  };
}

export async function signedStripeRequest(event: Record<string, unknown>, secret = 'whsec_test', now = 1_700_000_000) {
  const body = JSON.stringify(event);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${now}.${body}`));
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return new Request('https://church.example/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': `t=${now},v1=${hex}`, 'content-type': 'application/json' },
    body,
  });
}
```

- [ ] **Step 2: Write failing pure-policy tests**

Cover exact boundary values:

```ts
expect(parseStripeEnvelope(stripeEvent('invoice.paid', {}))).toEqual(expect.objectContaining({
  eventId: 'evt_test_000000000001', eventType: 'invoice.paid', livemode: false,
}));
expect(() => parseStripeEnvelope({ ...stripeEvent('x', {}), livemode: 0 })).toThrow('invalid_livemode');
expect(() => parseStripeEnvelope({ ...stripeEvent('x', {}), created: -1 })).toThrow('invalid_created');
expect(retryDelayMs(1)).toBe(5 * 60_000);
expect(retryDelayMs(2)).toBe(30 * 60_000);
expect(retryDelayMs(3)).toBe(2 * 60 * 60_000);
expect(retryDelayMs(4)).toBe(12 * 60 * 60_000);
expect(retryDelayMs(5)).toBe(24 * 60 * 60_000);
expect(retryDelayMs(6)).toBeNull();
expect(sanitizeStripeDiagnostic(new Error('line1\nline2 sk_test_secret'), ['sk_test_secret']))
  .toBe('line1 line2 [REDACTED]');
```

Also test UTF-8 byte limits, exact-body SHA-256, 90-day processed/ignored pruning, immediate dismissed pruning, 180-day failed pruning, and maximum 1,000-byte diagnostic output.

- [ ] **Step 3: Run the pure tests and confirm red**

Run:

```bash
npx vitest run --project workers test/stripeWebhookInbox.test.ts
```

Expected: FAIL because the inbox module does not exist.

- [ ] **Step 4: Implement the pure contracts at the top of `stripeWebhookInbox.ts`**

Export these exact types and constants:

```ts
export const STRIPE_WEBHOOK_MAX_BYTES = 1024 * 1024;
export const STRIPE_LEASE_MS = 10 * 60_000;
export const STRIPE_ATTEMPT_MS = 25_000;
export const STRIPE_MAX_CYCLE_ATTEMPTS = 6;
export const STRIPE_DRAIN_LIMIT = 10;
export type StripeWebhookStatus = 'pending' | 'processing' | 'processed' | 'ignored' | 'failed' | 'dismissed';
export type StripeDispatchResult =
  | { state: 'processed'; outcome: string }
  | { state: 'ignored'; outcome: string }
  | { state: 'deferred'; outcome: string };
export interface StripeEnvelope {
  eventId: string;
  eventType: string;
  apiVersion: string | null;
  eventCreated: number;
  livemode: boolean;
  event: Record<string, unknown>;
}
```

`parseStripeEnvelope` must accept only a plain object, strict non-empty bounded `id`/`type`, non-negative integer `created`, strict boolean `livemode`, and null/absent/bounded-string `api_version`. `sha256Utf8` must use WebCrypto over exact UTF-8 bytes. `sanitizeStripeDiagnostic` must flatten control characters, replace every supplied secret, strip URL credentials, and truncate by UTF-8 bytes rather than code units.

- [ ] **Step 5: Run the pure tests**

Run:

```bash
npx vitest run --project workers test/stripeWebhookInbox.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/lib/stripeWebhookInbox.ts test/stripeFixtures.ts test/stripeWebhookInbox.test.ts
git commit -m "feat(stripe): define durable inbox contracts"
```

## Task 4: Implement the real-Postgres inbox state machine

**Files:**
- Modify: `src/lib/stripeWebhookInbox.ts`
- Create: `test/pg/stripeWebhookInbox.test.ts`

- [ ] **Step 1: Write failing receipt tests**

Use a migrated `PgAdapter` and assert:

```ts
const input = {
  eventId: 'evt_test_receipt',
  payloadJson: body,
  payloadSha256: await sha256Utf8(body),
  eventType: 'invoice.paid',
  apiVersion: '2026-06-30',
  eventCreated: 1_700_000_000,
  livemode: false,
};
expect(await receiveStripeEvent(db, input, NOW)).toMatchObject({ kind: 'inserted', status: 'pending' });
expect(await receiveStripeEvent(db, input, NOW)).toMatchObject({ kind: 'duplicate', status: 'pending' });
await expect(receiveStripeEvent(db, { ...input, payloadSha256: 'f'.repeat(64) }, NOW))
  .resolves.toEqual({ kind: 'collision' });
expect((await sql.unsafe('SELECT payload_json FROM church_private.stripe_webhook_events WHERE event_id=$1', [input.eventId]))[0].payload_json)
  .toBe(body);
```

- [ ] **Step 2: Write failing lease/finalization tests**

Prove an active lease excludes a second claim, expiry permits a new token, the stale token cannot finalize, and counters increment only on successful claims:

```ts
const first = await claimStripeEvent(db, id, NOW, 'lease-a');
expect(first).toMatchObject({ leaseToken: 'lease-a', attemptCount: 1, retryCycleAttempts: 1 });
expect(await claimStripeEvent(db, id, addMs(NOW, STRIPE_LEASE_MS - 1), 'lease-b')).toBeNull();
const second = await claimStripeEvent(db, id, addMs(NOW, STRIPE_LEASE_MS), 'lease-b');
expect(second).toMatchObject({ attemptCount: 2, retryCycleAttempts: 2 });
expect(await finalizeStripeEvent(db, id, 'lease-a', { state: 'processed', outcome: 'late' }, NOW)).toBe(false);
expect(await finalizeStripeEvent(db, id, 'lease-b', { state: 'processed', outcome: 'gift_recorded' }, NOW)).toBe(true);
```

- [ ] **Step 3: Write failing retry/replay/dismiss/retention tests**

Drive attempts 1–5 through `recordStripeAttemptFailure` and assert exact `next_attempt_at` values; attempt 6 must become `failed`. Assert authorized replay works only for retained `failed`/`ignored`, resets only the cycle counter, and records actor/time. Assert dismissal immediately nulls payload and cannot replay. Seed exact timestamps on both sides of 90/180-day boundaries and verify only eligible payloads are pruned.

- [ ] **Step 4: Run the inbox PG suite and confirm red**

Run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npx vitest run --project pg test/pg/stripeWebhookInbox.test.ts
```

Expected: FAIL because SQL methods are not implemented.

- [ ] **Step 5: Implement immutable receipt and collision detection**

Use insert-first concurrency-safe SQL, never read-then-insert:

```ts
export async function receiveStripeEvent(db: AppDb, input: StripeReceiptInput, now: Date): Promise<StripeReceiptResult> {
  const stamp = utcText(now);
  const inserted = await db.prepare(`
    INSERT INTO church_private.stripe_webhook_events
      (event_id,payload_json,payload_sha256,event_type,api_version,event_created,livemode,status,next_attempt_at,received_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?8,?8)
    ON CONFLICT(event_id) DO NOTHING RETURNING status,outcome
  `).bind(input.eventId, input.payloadJson, input.payloadSha256, input.eventType, input.apiVersion,
    input.eventCreated, input.livemode ? 1 : 0, stamp).first<{ status: StripeWebhookStatus; outcome: string | null }>();
  if (inserted) return { kind: 'inserted', ...inserted };
  const existing = await db.prepare(`
    SELECT payload_sha256,status,outcome FROM church_private.stripe_webhook_events WHERE event_id=?1
  `).bind(input.eventId).first<{ payload_sha256: string; status: StripeWebhookStatus; outcome: string | null }>();
  if (!existing || existing.payload_sha256 !== input.payloadSha256) return { kind: 'collision' };
  return { kind: 'duplicate', status: existing.status, outcome: existing.outcome };
}
```

- [ ] **Step 6: Implement conditional claim and lease assertions**

`claimStripeEvent` must use one `UPDATE ... RETURNING` with this eligibility predicate:

```sql
WHERE event_id=?1 AND payload_json IS NOT NULL AND (
  (status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?2))
  OR (status='processing' AND lease_expires_at<=?2)
)
```

Set status/lease fields and increment both counters in that statement. `assertStripeLease` must select only `event_id`, `lease_token`, `lease_expires_at`, and status, then return true only for the active token with expiry later than `now`.

- [ ] **Step 7: Implement lease-token finalization and bounded failure scheduling**

For processed/ignored, set terminal status/outcome/completed time and clear lease/error/schedule. For deferred/thrown errors, use the claimed row's cycle count:

```ts
const exhausted = claim.retryCycleAttempts >= STRIPE_MAX_CYCLE_ATTEMPTS;
const next = exhausted ? null : utcText(new Date(now.getTime() + retryDelayMs(claim.retryCycleAttempts)!));
await db.prepare(`
  UPDATE church_private.stripe_webhook_events
  SET status=?1,outcome=?2,next_attempt_at=?3,lease_token=NULL,lease_expires_at=NULL,
      last_error=?4,completed_at=?5,updated_at=?5
  WHERE event_id=?6 AND status='processing' AND lease_token=?7
`).bind(exhausted ? 'failed' : 'pending', outcome, next, diagnostic,
  utcText(now), claim.eventId, claim.leaseToken).run();
```

Thrown errors and `deferred` both follow this schedule; only their sanitized outcome/diagnostic differs.
For a non-exhausted attempt set `completed_at=NULL`; set it to the current timestamp only when the row becomes terminal `failed`.

- [ ] **Step 8: Implement replay, dismissal, listing, and retention**

All actions must be single conditional updates. Admin list projections must omit `payload_json` and `request_json`. Retention must execute three explicit updates: processed/ignored at 90 days, failed at 180 days with `outcome='payload_expired'`, and no-op for already-null payloads. Dismissal sets status/outcome/action fields and payload null in the same statement.

- [ ] **Step 9: Run the state-machine and migration tests**

Run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npx vitest run --project pg test/pg/stripeWebhookInbox.test.ts test/pg/stripeWebhookSchema.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 4**

```bash
git add src/lib/stripeWebhookInbox.ts test/pg/stripeWebhookInbox.test.ts
git commit -m "feat(stripe): persist and lease webhook receipts"
```

## Task 5: Make domain dispatch module-aware, payment-safe, and defer-capable

**Files:**
- Modify: `src/lib/givingWebhook.ts:20-343`
- Modify: `src/lib/regDb.ts:50-58,331-381`
- Modify: `src/lib/givingDb.ts:370-381`
- Modify: `test/pg/givingWebhook.test.ts`
- Modify: `test/pg/regWebhook.test.ts`
- Modify: `test/pg/regDb.test.ts`

- [ ] **Step 1: Convert existing dispatcher fixtures and assertions to structured results**

Update envelope helpers to use `stripeEvent`, add `modules: new Set(['giving','registration'])`, and replace string expectations:

```ts
expect(await handleStripeEvent({ db, env: ENV, modules: new Set(['giving', 'registration']) }, event))
  .toEqual({ state: 'processed', outcome: 'registration_confirmed' });
```

Do this mechanically before adding behavior so failures isolate the type migration.

- [ ] **Step 2: Add failing module-isolation and payment-state tests**

Add both directions:

```ts
expect(await handleStripeEvent({ db, env: ENV, modules: new Set(['registration']) }, giftPaid))
  .toEqual({ state: 'ignored', outcome: 'module_disabled' });
expect(await handleStripeEvent({ db, env: ENV, modules: new Set(['giving']) }, registrationPaid))
  .toEqual({ state: 'ignored', outcome: 'module_disabled' });
```

Assert `checkout.session.completed` with Registration metadata and `payment_status:'unpaid'` does not confirm and returns `awaiting_async_payment`. Assert `checkout.session.async_payment_succeeded` confirms/records money and `async_payment_failed` cancels only a pending registration.

- [ ] **Step 3: Add failing self-heal and out-of-order tests**

Cover:

- an unattached pending registration with matching `registration_id`, `request_id`, amount, and currency attaches and confirms;
- mismatched request ID, registration ID, amount, or currency is ignored independently;
- a known request whose registration is not yet visible returns deferred;
- a full `charge.refunded` with `metadata.kind='gift'` and no local gift returns deferred;
- a foreign or partial refund remains ignored;
- an attached legacy registration without a private request row can still converge by exact session ID.

- [ ] **Step 4: Add failing seat-hold and guarded-transition tests**

In `test/pg/regDb.test.ts`, backdate a pending row by more than one hour and assert it still counts toward `taken_count`. Add tests for a guarded transition that accepts null-or-same session ID only, requires pending status and matching amount/currency, and cannot cancel a confirmed registration.

- [ ] **Step 5: Run the domain tests and confirm red**

Run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npx vitest run --project pg test/pg/givingWebhook.test.ts test/pg/regWebhook.test.ts test/pg/regDb.test.ts
```

Expected: FAIL on flat results, missing module deps, unpaid Registration confirmation, async events, and the one-hour seat heuristic.

- [ ] **Step 6: Replace the seat predicate and add guarded registration resolution**

Use the permanent predicate:

```ts
const HOLDS_SEAT = `r.status IN ('pending','confirmed')`;
```

Add:

```ts
export type RegistrationCheckoutAction = 'confirm' | 'cancel' | 'attach_waiting' | 'attach_open';
export type RegistrationCheckoutTransition = 'applied' | 'converged' | 'deferred' | 'mismatch';

export async function applyRegistrationCheckoutSession(
  db: AppDb,
  input: {
    registrationId: number;
    requestId: string | null;
    sessionId: string;
    paymentIntentId: string | null;
    amountCents: number;
    currency: string;
    action: RegistrationCheckoutAction;
  },
): Promise<RegistrationCheckoutTransition>;
```

The `UPDATE` must require pending status, exact amount/currency, null-or-same session, plus either exact existing session or an `EXISTS` match in `church_private.stripe_checkout_requests` for self-attachment. Follow a zero-row update with one bounded read to distinguish missing/deferred, terminal convergence, and mismatch. For applied/terminal results, idempotently resolve/clear the private request in a `db.batch` so cleanup converges after a prior partial commit.

- [ ] **Step 7: Add module/checkpoint dependencies and structured results**

Use:

```ts
export interface WebhookDeps {
  db: AppDb;
  env: StripeEnv;
  modules: ReadonlySet<ModuleKey>;
  fetcher?: typeof fetch;
  checkpoint?: () => Promise<void>;
}
const checked = async (deps: WebhookDeps) => deps.checkpoint?.();
```

Call `checked` immediately before every Stripe fetch and each domain write. Return `StripeDispatchResult` everywhere. Gate by `metadata.kind` and current modules before any table mutation.

- [ ] **Step 8: Implement payment and ordering branches**

Route `checkout.session.async_payment_succeeded` through the paid fulfillment handler. Route `async_payment_failed` through Registration guarded cancellation and terminal ignored/no-op for Giving. Registration completion must require `payment_status==='paid'`. Change `markGiftRefunded` to return whether a row moved; an internal full refund that moved no row becomes deferred, while foreign/partial remains ignored.

- [ ] **Step 9: Run all domain tests**

Run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npx vitest run --project pg test/pg/givingWebhook.test.ts test/pg/regWebhook.test.ts test/pg/regDb.test.ts
```

Expected: PASS, including existing invoice/subscription/refund/redelivery cases.

- [ ] **Step 10: Commit Task 5**

```bash
git add src/lib/givingWebhook.ts src/lib/regDb.ts src/lib/givingDb.ts test/pg/givingWebhook.test.ts test/pg/regWebhook.test.ts test/pg/regDb.test.ts
git commit -m "fix(stripe): make replayed domain effects converge"
```

## Task 6: Add the lease-based processor and bounded recovery drain

**Files:**
- Create: `src/lib/stripeWebhookProcessor.ts`
- Create: `src/lib/stripeRecovery.ts`
- Create: `test/pg/stripeWebhookProcessor.test.ts`

- [ ] **Step 1: Write failing processor lifetime and outcome tests**

Inject `openDb`, clock, token, and dispatcher seams. Assert:

```ts
const result = await processStripeWebhookEvent('evt_test_1', {
  env,
  openDb: () => ({ db, backend: 'supabase', end }),
  now: () => NOW,
  newLeaseToken: () => 'lease-test',
  dispatch: vi.fn(async () => ({ state: 'processed', outcome: 'gift_recorded' })),
});
expect(result).toEqual({ state: 'processed', outcome: 'gift_recorded' });
expect(end).toHaveBeenCalledOnce();
```

Repeat for no claim, ignored, deferred, thrown error, parse failure, finalization failure, module-load failure, and `openDb` failure. `end` must run exactly once whenever open succeeds.

- [ ] **Step 2: Write failing lease/deadline tests**

Use an injected advancing clock and checkpoint spy to prove:

- active lease prevents dispatch;
- checkpoint rejects at 25 seconds;
- checkpoint rejects a changed/expired lease before a later fetch/write;
- stale token cannot finalize;
- a failed finalization leaves processing state recoverable after 10 minutes;
- six claims exhaust the cycle and become failed.

- [ ] **Step 3: Write failing bounded drain tests**

Seed 11 due events and assert `drainStripeWebhookInbox` attempts only 10 sequentially, stops starting work when its 25-second pass deadline is reached, and does not overlap calls. Add an empty-inbox no-op. Add a retention spy to the initial `runStripeRecovery` and assert each phase is bounded and top-level errors are sanitized. Task 10 extends this orchestrator with Checkout recovery after that service exists.

- [ ] **Step 4: Run the processor tests and confirm red**

Run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npx vitest run --project pg test/pg/stripeWebhookProcessor.test.ts
```

Expected: FAIL because processor/recovery files do not exist.

- [ ] **Step 5: Implement one processing attempt with owned DB lifetime**

Use this dependency shape:

```ts
export interface StripeWebhookProcessorDeps {
  env: StripeEnv & DbEnv;
  openDb?: typeof openDb;
  fetcher?: typeof fetch;
  now?: () => Date;
  newLeaseToken?: () => string;
  dispatch?: typeof handleStripeEvent;
}

export async function processStripeWebhookEvent(
  eventId: string,
  deps: StripeWebhookProcessorDeps,
): Promise<ProcessAttemptResult> {
  const opened = (deps.openDb ?? openDb)(deps.env);
  let claim: StripeWebhookClaim | null = null;
  try {
    if (opened.backend !== 'supabase') return { state: 'not_claimed' };
    const now = deps.now ?? (() => new Date());
    claim = await claimStripeEvent(opened.db, eventId, now(), (deps.newLeaseToken ?? crypto.randomUUID)());
    if (!claim) return { state: 'not_claimed' };
    const deadline = now().getTime() + STRIPE_ATTEMPT_MS;
    const checkpoint = async () => {
      if (now().getTime() >= deadline || !(await assertStripeLease(opened.db, eventId, claim.leaseToken, now()))) {
        throw Object.assign(new Error('stripe_attempt_lease_lost'), { code: 'stripe_attempt_lease_lost' });
      }
    };
    await checkpoint();
    const modules = await getEnabledModules(opened.db, 'supabase');
    const event = JSON.parse(claim.payloadJson) as Record<string, unknown>;
    const result = await (deps.dispatch ?? handleStripeEvent)({
      db: opened.db, env: deps.env, modules, fetcher: deps.fetcher, checkpoint,
    }, event);
    await checkpoint();
    await finishStripeDispatch(opened.db, claim, result, now());
    return result;
  } catch (error) {
    if (claim) await recordClaimErrorWhenOwned(opened.db, claim, error, (deps.now ?? (() => new Date()))());
    return { state: 'failed' };
  } finally {
    await opened.end();
  }
}
```

`recordClaimErrorWhenOwned` must update only the still-owned lease token; if the database is unavailable or ownership is lost, allow lease expiry to recover it.

- [ ] **Step 6: Implement due-event and top-level recovery orchestration**

`drainStripeWebhookInbox` opens one short-lived client only to list at most 10 due IDs, closes it, then calls `processStripeWebhookEvent` sequentially so every attempt owns its own client. The initial `runStripeRecovery` runs inbox drain and retention in that order, with no raw errors/payloads logged.

- [ ] **Step 7: Run processor and inbox suites**

Run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npx vitest run --project pg test/pg/stripeWebhookProcessor.test.ts test/pg/stripeWebhookInbox.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/lib/stripeWebhookProcessor.ts src/lib/stripeRecovery.ts test/pg/stripeWebhookProcessor.test.ts
git commit -m "feat(stripe): process durable receipts with leases"
```

## Task 7: Replace the synchronous webhook route with durable-before-ack receipt

**Files:**
- Create: `src/lib/stripeWebhookEndpoint.ts`
- Create: `test/stripeWebhookEndpoint.test.ts`
- Modify: `src/pages/api/stripe/webhook.ts:1-54`

- [ ] **Step 1: Write failing endpoint-policy tests**

Drive a pure `handleStripeWebhookRequest` with injected receipt and background functions. Cover:

- both modules disabled returns 404 before `request.text`, signature verification, receipt, or waitUntil;
- declared or measured body above 1 MiB returns 413;
- absent secret/bad signature returns 400;
- malformed signed envelope returns 400 and no receipt;
- separately signed otherwise-valid `livemode:true` returns exact body/status `live_mode_disabled`/400 and performs no receipt, dispatch, domain call, or waitUntil;
- receipt insert failure returns 500;
- insert/duplicate returns 200 only after the receipt promise resolves;
- collision returns 400;
- only inserted or pending duplicate schedules acceleration;
- terminal duplicate returns its status without reactivation;
- background callback opens/closes its own DB through the processor and never captures request `db`.

- [ ] **Step 2: Run endpoint tests and confirm red**

Run:

```bash
npx vitest run --project workers test/stripeWebhookEndpoint.test.ts
```

Expected: FAIL because the endpoint service does not exist.

- [ ] **Step 3: Implement exact body and acknowledgement flow**

Use:

```ts
export interface StripeWebhookEndpointDeps {
  db: AppDb;
  env: StripeEnv & DbEnv;
  modules: ReadonlySet<string>;
  waitUntil?: (promise: Promise<unknown>) => void;
  nowSeconds?: number;
  receive?: typeof receiveStripeEvent;
  process?: typeof processStripeWebhookEvent;
}

export async function handleStripeWebhookRequest(request: Request, deps: StripeWebhookEndpointDeps): Promise<Response> {
  if (!(deps.modules.has('giving') || deps.modules.has('registration'))) return new Response('Not found', { status: 404 });
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > STRIPE_WEBHOOK_MAX_BYTES) return new Response('payload_too_large', { status: 413 });
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > STRIPE_WEBHOOK_MAX_BYTES) return new Response('payload_too_large', { status: 413 });
  if (!deps.env.STRIPE_WEBHOOK_SECRET) return new Response('webhook_not_configured', { status: 400 });
  const event = await verifyStripeWebhook(body, request.headers.get('stripe-signature') ?? '', deps.env.STRIPE_WEBHOOK_SECRET, 300, deps.nowSeconds);
  if (!event) return new Response('invalid_signature', { status: 400 });
  let envelope: StripeEnvelope;
  try { envelope = parseStripeEnvelope(event); } catch { return new Response('invalid_envelope', { status: 400 }); }
  if (envelope.livemode) return new Response('live_mode_disabled', { status: 400 });
  const input = await receiptInput(body, envelope);
  let receipt: StripeReceiptResult;
  try {
    receipt = await (deps.receive ?? receiveStripeEvent)(deps.db, input, new Date((deps.nowSeconds ?? Date.now() / 1000) * 1000));
  } catch {
    return new Response('receipt_failed', { status: 500 });
  }
  if (receipt.kind === 'collision') return new Response('event_id_collision', { status: 400 });
  if ((receipt.kind === 'inserted' || receipt.status === 'pending') && deps.waitUntil) {
    deps.waitUntil((deps.process ?? processStripeWebhookEvent)(envelope.eventId, { env: deps.env }).catch(() => undefined));
  }
  return new Response(receipt.kind === 'duplicate' ? receipt.status : 'received', { status: 200 });
}
```

Catch only receipt-storage errors at this service boundary and return `500 receipt_failed`; do not log payload/error objects.

- [ ] **Step 4: Make the Astro route a thin adapter**

Replace its current retry classifier/drop policy with:

```ts
export const POST: APIRoute = ({ request, locals }) => handleStripeWebhookRequest(request, {
  db: locals.db,
  env: env as unknown as StripeEnv & DbEnv,
  modules: locals.modules,
  waitUntil: locals.cfContext?.waitUntil?.bind(locals.cfContext),
});
```

Delete route-level `error_logged`, transient classification, and raw error logging.

- [ ] **Step 5: Run endpoint, signature, and route-policy tests**

Run:

```bash
npx vitest run --project workers test/stripeWebhookEndpoint.test.ts
npx vitest run --project pg test/pg/stripe.test.ts
npx vitest run --project workers test/routePolicy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

```bash
git add src/lib/stripeWebhookEndpoint.ts src/pages/api/stripe/webhook.ts test/stripeWebhookEndpoint.test.ts
git commit -m "feat(stripe): acknowledge only durable test events"
```

## Task 8: Persist an Atomic Registration Checkout Request Pair

**Files:**
- Create: `src/lib/stripeCheckoutRequests.ts`
- Create: `test/pg/stripeCheckoutRequests.test.ts`
- Modify: `src/lib/regDb.ts`
- Modify: `test/pg/regDb.test.ts`

- [ ] **Step 1: Write failing request-state and transaction tests**

Cover, with a real Postgres database:

- strict UUID parsing;
- a stable SHA-256 digest of normalized event ID, registration identity, amount, currency, and sorted answers;
- the same UUID plus a different digest returns `conflict` without changing either table;
- registration, answers, and private request insert together or all roll back;
- capacity is checked inside that transaction;
- a uniqueness race reloads the winning request and applies the same digest/state rules;
- terminal registration cleanup clears `request_json` and `checkout_url`;
- every `pending` registration holds a seat regardless of age.

Run:

```bash
npx vitest run --project pg test/pg/stripeCheckoutRequests.test.ts test/pg/regDb.test.ts
```

Expected: FAIL because the request DAL and durable seat rule do not exist.

- [ ] **Step 2: Define the request state API**

Use explicit result unions rather than nullable tuples:

```ts
export type CheckoutRequestResolution =
  | { kind: 'create'; registrationId: number; requestId: string; requestJson: StripeCheckoutParams }
  | { kind: 'redirect'; registrationId: number; checkoutUrl: string }
  | { kind: 'waiting'; registrationId: number }
  | { kind: 'review'; registrationId: number; reason: string }
  | { kind: 'done'; registrationId: number }
  | { kind: 'expired' }
  | { kind: 'conflict' };
```

Persist only normalized JSON needed to reproduce the exact Stripe call. Do not store card, secret, signature, or request-header data.

- [ ] **Step 3: Reserve the registration ID and create the pair atomically**

Reserve an ID first so it can be embedded in the exact Stripe metadata:

```sql
SELECT nextval(pg_get_serial_sequence('public.registrations', 'id')) AS id
```

Sequence gaps are acceptable. Build the canonical Checkout JSON in application code, then execute one `db.batch` containing:

1. the explicit-ID `registrations` insert;
2. answer inserts;
3. the `church_private.stripe_checkout_requests` insert;
4. the capacity recount/guard.

Any failure rolls back all four. Store idempotency key `church4christ:registration:<request UUID>` and require the row's `registration_id` to match the JSON metadata.

- [ ] **Step 4: Implement the reuse matrix**

Resolve rows exactly as follows:

| Registration | Request | Result | Stripe call |
|---|---|---|---|
| `confirmed` | any | clear sensitive fields, `done` | none |
| `cancelled` | any | clear sensitive fields, `expired` | none; browser must use a new UUID |
| `pending` | `creating`, no session | `create` with stored JSON | same-key create |
| `pending` | `attached`, URL present | `redirect` | none |
| `pending` | `attached`, URL absent and complete/processing | `waiting` | none |
| `pending` | `manual_review` | `review` | none |
| any | digest mismatch | `conflict` | none |

Remove the one-hour pending exclusion from `HOLDS_SEAT`. A pending row releases capacity only through a guarded terminal or explicit manual transition.

- [ ] **Step 5: Run the focused tests**

```bash
npx vitest run --project pg test/pg/stripeCheckoutRequests.test.ts test/pg/regDb.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add src/lib/stripeCheckoutRequests.ts src/lib/regDb.ts test/pg/stripeCheckoutRequests.test.ts test/pg/regDb.test.ts
git commit -m "feat(registration): persist checkout intent atomically"
```

## Task 9: Use Stable Browser Request IDs for Registration and Giving

**Files:**
- Modify: `src/pages/[locale]/register/[id].astro`
- Modify: `src/pages/api/register/submit.ts`
- Modify: `src/pages/[locale]/give.astro`
- Modify: `src/pages/api/giving/checkout.ts`
- Modify: `src/lib/stripe.ts`
- Modify: `test/pg/stripe.test.ts`
- Create: `test/registrationCheckout.test.ts`
- Modify: `test/givingCheckout.test.ts`
- Modify: `test/pg/stripeCheckoutRequests.test.ts`

- [ ] **Step 1: Write failing route and Stripe-call tests**

Assert that:

- each rendered form contains a server-generated UUID in a hidden `checkoutRequestId` field;
- paid registration rejects a missing or malformed UUID before creating a registration;
- free registration retains its current non-Stripe flow;
- registration retries reuse `church4christ:registration:<uuid>` and the byte-equivalent canonical JSON;
- giving uses `church4christ:giving:<uuid>` for the browser submission retry;
- the registration Checkout request has no absolute `expires_at`;
- no route logs a Stripe body, secret, request JSON, or Checkout URL on failure.

Run:

```bash
npx vitest run --project workers test/registrationCheckout.test.ts test/givingCheckout.test.ts
npx vitest run --project pg test/pg/stripe.test.ts
```

Expected: FAIL on the missing UUID and idempotency behavior.

- [ ] **Step 2: Render and validate stable UUIDs**

Generate `crypto.randomUUID()` on the GET render and place it in the hidden field. Parse with one shared strict UUID function. Never generate a replacement UUID inside a POST retry.
At this task's green step, make the Checkout builders' `requestId` option required so TypeScript prevents any future browser Checkout call without a stable identity.

- [ ] **Step 3: Route paid registration through the request pair**

Normalize inputs before hashing. Resolve/create the atomic pair from Task 8, then:

1. return the saved redirect/wait/review/done result without a Stripe create call;
2. for `create`, send the saved JSON using the saved key;
3. require a test-mode Checkout response;
4. attach session ID, Stripe state, and URL with one guarded batch;
5. clear `request_json` immediately after a verified attachment;
6. redirect only after the guarded attachment succeeds.

Use this failure table:

| Failure | Registration/request action |
|---|---|
| local configuration/preflight before fetch | cancel pending; clear request data |
| Stripe 4xx except 408/409/424/429 | cancel pending; clear request data |
| transport, timeout, 408/409/424/429, or 5xx | leave pending/creating for recovery |
| malformed or live-mode response after Stripe | leave pending/creating for recovery |
| database failure after Stripe response | leave pending/creating for recovery |

Return a non-sensitive retry/wait response for ambiguous failures. Do not auto-cancel them.

- [ ] **Step 4: Add stable giving idempotency**

Validate the hidden UUID and pass `church4christ:giving:<uuid>` as the idempotency key. Giving has no local pre-Checkout record in this scope; the key prevents duplicate sessions for a retried submission, while its existing webhook durability is handled by the inbox.

- [ ] **Step 5: Remove stale absolute Checkout expiry**

Delete registration's fixed `expires_at`. Stripe's server-side idempotency window must not be invalidated by replaying a now-expired absolute parameter.

- [ ] **Step 6: Run focused tests**

```bash
npx vitest run --project workers test/registrationCheckout.test.ts test/givingCheckout.test.ts
npx vitest run --project pg test/pg/stripe.test.ts
npx vitest run --project pg test/pg/stripeCheckoutRequests.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 9**

```bash
git add 'src/pages/[locale]/register/[id].astro' src/pages/api/register/submit.ts 'src/pages/[locale]/give.astro' src/pages/api/giving/checkout.ts src/lib/stripe.ts test/pg/stripe.test.ts test/registrationCheckout.test.ts test/givingCheckout.test.ts test/pg/stripeCheckoutRequests.test.ts
git commit -m "feat(stripe): make checkout submissions idempotent"
```

## Task 10: Recover Ambiguous Registration Checkout Creation

**Files:**
- Create: `src/lib/stripeCheckoutRecovery.ts`
- Modify: `src/lib/stripeRecovery.ts`
- Create: `test/pg/stripeCheckoutRecovery.test.ts`
- Modify: `src/lib/stripe.ts`
- Modify: `src/lib/stripeCheckoutRequests.ts`
- Modify: `src/lib/regDb.ts`
- Modify: `test/pg/stripe.test.ts`

- [ ] **Step 1: Write the failing recovery matrix tests**

Use a fake Stripe transport plus real Postgres. Cover exact retry ages `45m`, `90m`, `3h`, `8h`, `16h`, and `23h45m`; no attempt before its checkpoint; and these outcomes:

| Session result | Guarded local transition |
|---|---|
| paid/settled | confirm registration, clear private request data |
| complete but unpaid/processing | attach, clear URL, keep pending |
| expired | cancel, clear private request data |
| open | attach and retain test Checkout URL |
| still ambiguous at `23h45m` | `manual_review`, clear JSON and URL |

Also cover:

- unattached rows replay the saved exact create call with the same key, then retrieve;
- attached rows retrieve by `cs_test_...` and never create;
- no create call at or beyond 24 hours;
- attached unresolved sessions continue on a once-daily cadence;
- cron/manual overlap has one compare-and-set claim-version winner;
- a late valid webhook heals a `manual_review` row;
- recovery rejects live sessions without mutating domain state.

Run:

```bash
npx vitest run --project pg test/pg/stripeCheckoutRecovery.test.ts
```

Expected: FAIL because recovery does not exist.

- [ ] **Step 2: Add strict Checkout retrieval**

Add `retrieveCheckoutSession(sessionId, env, options)` and run every create/retrieve response through `requireTestCheckoutSession`. Require `livemode === false`, a `cs_test_` ID, matching registration ID/request UUID metadata, amount, and currency before allowing a transition.

- [ ] **Step 3: Implement compare-and-set recovery claims**

The atomic pair starts with `next_reconcile_at = created_at + 45 minutes`. Select due request IDs and claim a row with one conditional update that increments `reconcile_attempts`, moves `next_reconcile_at` to a 10-minute claim-expiry time, and returns the new `updated_at` claim version; process claimed IDs sequentially with a fresh database handle. Compute every later checkpoint from immutable `created_at` (`90m`, `3h`, `8h`, `16h`, `23h45m`) rather than accumulating delay from the previous attempt. Before every Stripe call and domain write, require the same state and `updated_at` claim version. Final outcome/schedule updates compare-and-set that version, so an expired stale worker cannot overwrite its successor. Record bounded error metadata and the next exact checkpoint.

The final ambiguous create attempt at `23h45m` changes to `manual_review`; it never guesses that no Stripe session exists. Clear recoverable request JSON no later than 24 hours. Keep attached session identifiers and bounded audit metadata for later reconciliation.

- [ ] **Step 4: Expose manual recovery primitives**

Implement service functions used later by the admin page:

```ts
reconcileCheckoutRequestNow(requestId, actorId)
attachVerifiedCheckoutSession(requestId, sessionId, actorId)
cancelPendingCheckoutRequest(requestId, actorId, confirmation)
```

`reconcile...` does not first force `manual_review`. `attach...` retrieves the `cs_test_` session and validates all identity/payment fields before applying the same outcome matrix. `cancel...` requires an explicit confirmation value, a still-pending registration, compare-and-set guards, and an audit record. None of these actions prevents a later valid webhook from confirming a genuinely paid registration.

- [ ] **Step 5: Create the combined recovery entry point**

`runStripeRecovery(env, options)` first drains due webhook IDs and then due Checkout request IDs, with independent limits and bounded errors. It must be safe when Giving, Registration, or both are enabled.

- [ ] **Step 6: Run focused recovery tests**

```bash
npx vitest run --project pg test/pg/stripe.test.ts
npx vitest run --project pg test/pg/stripeCheckoutRecovery.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 10**

```bash
git add src/lib/stripeCheckoutRecovery.ts src/lib/stripeRecovery.ts src/lib/stripe.ts src/lib/stripeCheckoutRequests.ts src/lib/regDb.ts test/pg/stripe.test.ts test/pg/stripeCheckoutRecovery.test.ts
git commit -m "feat(stripe): recover ambiguous checkout creation"
```

## Task 11: Configure a Supabase-Only Stripe Recovery Schedule and Test Secrets

**Files:**
- Modify: `src/worker.ts`
- Modify: `config/wrangler.template.jsonc`
- Modify: `scripts/setup/render-wrangler.mjs`
- Modify: `scripts/setup/checks/config.mjs`
- Modify: `scripts/setup/secrets.mjs`
- Modify: `scripts/setup/checks/services.mjs`
- Modify: `scripts/setup/index.mjs`
- Modify: `test/node/setup/setup-files.test.ts`
- Modify: `test/node/setup/setup-doctor.test.ts`
- Modify: `test/node/setup/setup-apply.test.ts`
- Modify: `test/node/setup/setup-cli.test.ts`
- Modify: `test/node/setup/setup-plan.test.ts`
- Modify: `test/node/setup/setup-runtime-hardening.test.ts`
- Modify: `test/setup/dry-run.test.ts`
- Modify: `test/setup/clean-room-d1.test.ts`
- Modify: `test/setup/clean-room-pg.test.ts`

- [ ] **Step 1: Write failing provider/schedule/secret tests**

Assert the generated contract exactly:

- D1 keeps reminder, digest, and backup cron entries and has no Stripe recovery cron or `STRIPE_MODE`;
- Supabase keeps reminder and digest and adds `*/5 * * * *`, while backup remains D1-only;
- worker source recognizes all four schedules;
- every Supabase render emits `STRIPE_MODE = "test"`, with no live-value branch;
- an existing generated Supabase config without the recovery cron is surfaced through the normal preflight/diff/confirmed-replacement flow and is never silently edited;
- setup accepts only an `sk_test_` key plus `whsec_` webhook secret as a complete pair;
- partial, live, or unclassified Stripe credentials fail before any file or remote write;
- secret values never enter plan JSON, manifest JSON, generated config, logs, or snapshots;
- ambient runtime `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` values are scrubbed rather than treated as setup input;
- local `.dev.vars` remains mode `0600` and preserves unrelated entries;
- D1 clean-room setup never asks for or writes Stripe values.

Run:

```bash
npx vitest run --project node test/node/setup/setup-files.test.ts test/node/setup/setup-doctor.test.ts test/node/setup/setup-apply.test.ts test/node/setup/setup-cli.test.ts test/node/setup/setup-plan.test.ts test/node/setup/setup-runtime-hardening.test.ts test/setup/dry-run.test.ts test/setup/clean-room-d1.test.ts test/setup/clean-room-pg.test.ts
```

Expected: FAIL on the new provider contract.

- [ ] **Step 2: Add named schedule constants and recovery dispatch**

Use named constants in `src/worker.ts`. On `*/5 * * * *`, return immediately only when the database provider is not Supabase; otherwise call `runStripeRecovery`. The inbox phase must still drain already-received events to `ignored/module_disabled` after both payment modules are disabled. Checkout recovery internally skips new Stripe work unless Registration is enabled and a complete test credential pair is present. Keep reminder, digest, and D1 backup branches unchanged.

- [ ] **Step 3: Render and validate provider-specific schedules**

Represent the Stripe cron as a provider-filtered template token rather than a global static entry. Make the validator compare the rendered schedule list against the selected provider. Validate source support separately so the worker may contain all four handlers while each deployment exposes only its applicable schedules. Preserve the existing generated-config fingerprint/preflight/diff/confirmation boundary for upgraded Supabase installations.

- [ ] **Step 4: Collect and write test credentials without serialization**

Add a `collectStripeTestSecrets` boundary whose result is held only in the in-memory secret context:

```ts
type StripeTestSecrets = { secretKey: string; webhookSecret: string } | null;
```

Read only the dedicated one-shot `CHURCH_SETUP_STRIPE_SECRET_KEY` and `CHURCH_SETUP_STRIPE_WEBHOOK_SECRET` environment variables; do not add secret-valued CLI flags, consume ambient runtime `STRIPE_*` variables, or serialize values into the plan. Register both setup-input values with the existing redaction context before any command or diagnostic can run. Return `null` when both are absent. Reject a partial pair, any key not beginning `sk_test_`, and any webhook secret not beginning `whsec_` before local or deploy mutation. Local configure writes them under the runtime names `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `.dev.vars` with existing atomic/mode-preserving helpers. Deploy sends missing values to Wrangler over stdin and does not claim to inspect an already-stored remote value.

- [ ] **Step 5: Make doctor output honest and mode-visible**

Local doctor reads only a non-secret classification (`test`, `live`, `unknown`, `missing`) and fails live/unknown. Deploy doctor can verify secret-name presence plus the generated `STRIPE_MODE=test` marker, but reports remote value classification as unverifiable. Runtime validation remains authoritative before every Stripe network call.

- [ ] **Step 6: Run setup and clean-room tests**

```bash
npx vitest run --project node test/node/setup/setup-files.test.ts test/node/setup/setup-doctor.test.ts test/node/setup/setup-apply.test.ts test/node/setup/setup-cli.test.ts test/node/setup/setup-plan.test.ts test/node/setup/setup-runtime-hardening.test.ts test/setup/dry-run.test.ts test/setup/clean-room-d1.test.ts test/setup/clean-room-pg.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 11**

```bash
git add src/worker.ts config/wrangler.template.jsonc scripts/setup/render-wrangler.mjs scripts/setup/checks/config.mjs scripts/setup/secrets.mjs scripts/setup/checks/services.mjs scripts/setup/index.mjs test/node/setup/setup-files.test.ts test/node/setup/setup-doctor.test.ts test/node/setup/setup-apply.test.ts test/node/setup/setup-cli.test.ts test/node/setup/setup-plan.test.ts test/node/setup/setup-runtime-hardening.test.ts test/setup/dry-run.test.ts test/setup/clean-room-d1.test.ts test/setup/clean-room-pg.test.ts
git commit -m "feat(setup): configure test-mode Stripe recovery"
```

## Task 12: Add Test-Mode Stripe Operations to the Admin UI

**Files:**
- Create: `src/pages/admin/stripe-events.astro`
- Create: `test/pg/adminStripeOperations.test.ts`
- Create: `test/e2e-pg/stripeWebhook.test.ts`
- Modify: `src/layouts/Admin.astro`
- Modify: `src/lib/routePolicy.ts`
- Modify: `src/pages/admin/people/[id].astro`
- Modify: `src/i18n/en.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `docs/features/giving.md`
- Modify: `docs/features/registration.md`
- Modify: `docs/cloudflare-setup.md`
- Modify: `docs/supabase-setup.md`
- Modify: `README.md`
- Modify: `test/routePolicy.test.ts`
- Modify: `test/moduleGating.test.ts`
- Modify: `test/i18n.test.ts`

- [ ] **Step 1: Write failing authorization and operations tests**

Cover:

- `/admin/stripe-events` is a finance route and unavailable without finance authorization;
- finance authorization is offered when either Giving or Registration is enabled;
- the navigation item appears under the same condition;
- list queries paginate and filter bounded columns but never select/render raw webhook payloads, request JSON, secrets, or Checkout URLs;
- retained failed events warn during their final 30 replayable days, and expired payloads disable Replay while preserving Dismiss;
- anonymous, ordinary member, and editor access is denied, while admin and finance access follows the module gate;
- replay, dismiss, reconcile-now, verified-session attach, and explicit cancel require POST, same-origin/CSRF validation, and a finance-authorized user;
- dismiss cannot alter domain data;
- replay uses a fresh lease and checkpoints;
- attach accepts only a retrieved and fully matched `cs_test_` session;
- every screen and action displays `Stripe test mode`; no live-mode switch exists.

Run:

```bash
npx vitest run --project workers test/routePolicy.test.ts
npx vitest run --project pg test/pg/adminStripeOperations.test.ts
```

Expected: FAIL because the page and policy do not exist.

- [ ] **Step 2: Add the finance route and module-aware navigation**

Classify `/admin/stripe-events` explicitly as finance. Change People finance-role availability and Admin navigation from Giving-only to `Giving || Registration` without broadening any unrelated route.

- [ ] **Step 3: Implement the bounded operations page**

Show two paginated sections: webhook receipts and registration Checkout requests. Columns may include identifiers, type, bounded status/error code, attempt count, timestamps, and registration ID. Show the 150-day warning threshold and 180-day replay cutoff from the same retention constants used by the DAL. Implement actions through the processor/recovery service layer; do not duplicate transition SQL in the page.

All mutations use the existing same-origin/CSRF middleware and repeat finance authorization in the page. Explicit cancel must require a submitted confirmation phrase tied to the registration ID and write the actor/time/action audit fields.

- [ ] **Step 4: Add bilingual copy and test-only setup guidance**

Add complete English and Chinese keys for statuses, filters, actions, confirmation, and test-mode warning. Update setup docs to show the one-shot `CHURCH_SETUP_STRIPE_*` import variables, request Stripe test credentials only, explain that live keys and live webhook events are rejected, describe the five-minute Supabase recovery schedule, and state that D1 does not support Stripe modules.

Add a built-worker Postgres E2E test that submits a genuinely signed test event, observes durable receipt/processing through the admin surface, proves unauthorized access is denied, and proves a separately signed live event receives `400 live_mode_disabled` without storage. It must use only test fixtures and must not expose payload data in failure output.

- [ ] **Step 5: Run focused UI/auth/docs tests**

```bash
npx vitest run --project workers test/routePolicy.test.ts
npx vitest run --project workers test/moduleGating.test.ts test/i18n.test.ts
npx vitest run --project pg test/pg/adminStripeOperations.test.ts
npm run docs:check
```

Expected: PASS.

- [ ] **Step 6: Commit Task 12**

```bash
git add src/pages/admin/stripe-events.astro src/layouts/Admin.astro src/lib/routePolicy.ts 'src/pages/admin/people/[id].astro' src/i18n/en.ts src/i18n/zh.ts docs/features/giving.md docs/features/registration.md docs/cloudflare-setup.md docs/supabase-setup.md README.md test/routePolicy.test.ts test/moduleGating.test.ts test/i18n.test.ts test/pg/adminStripeOperations.test.ts test/e2e-pg/stripeWebhook.test.ts
git commit -m "feat(admin): add test-mode Stripe recovery operations"
```

## Task 13: Prove Crash and Concurrency Safety

**Files:**
- Create: `test/pg/stripeReliabilityConcurrency.test.ts`
- Modify: `test/pg/stripeWebhookProcessor.test.ts`
- Modify: `test/pg/stripeCheckoutRecovery.test.ts`
- Modify: `test/stripeWebhookEndpoint.test.ts`

- [ ] **Step 1: Add deterministic two-client concurrency tests**

Use two Postgres clients and promise barriers, not timing-only sleeps. Prove:

- an expired worker overlaps its successor without duplicate gift, seat, or registration transition;
- a worker that loses its lease cannot overwrite the successor's final state;
- a crash after one business write but before final inbox update resumes from checkpoints and finishes once;
- cron and manual Checkout reconciliation overlap with one compare-and-set winner;
- a webhook arriving during outbound recovery can heal the request without a stale overwrite;
- duplicate delivery while the first worker is processing returns a durable 200 and does not launch an unsafe second mutation;
- signed `livemode:true` returns exact `400 live_mode_disabled` with zero receipt rows, dispatch calls, domain mutations, and `waitUntil` calls;
- captured logs and rendered admin HTML contain no raw payload, request JSON, secret, or Checkout URL.

- [ ] **Step 2: Run the concurrency suite repeatedly**

```bash
for run in 1 2 3; do npx vitest run --project pg test/pg/stripeReliabilityConcurrency.test.ts test/pg/stripeWebhookProcessor.test.ts test/pg/stripeCheckoutRecovery.test.ts || exit 1; done
npx vitest run --project workers test/stripeWebhookEndpoint.test.ts
```

Expected: PASS on all three database runs.

- [ ] **Step 3: Commit Task 13**

```bash
git add test/pg/stripeReliabilityConcurrency.test.ts test/pg/stripeWebhookProcessor.test.ts test/pg/stripeCheckoutRecovery.test.ts test/stripeWebhookEndpoint.test.ts
git commit -m "test(stripe): prove recovery concurrency safety"
```

## Task 14: Run Full Verification and Independent Review

**Files:**
- Modify only files required by verification or review findings

- [ ] **Step 1: Run documentation, setup, and static checks**

```bash
npm run docs:check
npx vitest run --project node test/setup/dry-run.test.ts test/setup/clean-room-d1.test.ts
npm run tokens
npm run tokens:check
npm test
npm run check
npm run build
```

Expected: every command exits 0 with no skipped required suite.

- [ ] **Step 2: Run D1 clean-room integration**

```bash
npm run db:migrate:local
npm run db:seed:local
npm run db:seed-media:local
bash scripts/smoke.sh
npm run test:e2e
```

Expected: migration, seed, smoke, and E2E commands exit 0. This confirms that the Supabase-only private schema and Stripe recovery schedule did not change the D1 baseline.

- [ ] **Step 3: Run Supabase clean-room integration with skip detection**

Start from the repository's documented disposable Postgres test database, then run:

```bash
npm run db:migrate:supabase
npm run db:seed:supabase
npx vitest run --project pg --reporter=json --outputFile=/tmp/church-cms-pg-results.json
node -e "const r=require('/tmp/church-cms-pg-results.json'); if ((r.numPendingTests ?? 0) > 0) process.exit(1)"
npm run test:e2e:pg
```

Expected: migrations, seed, all PG tests, skip assertion, and PG E2E exit 0.

- [ ] **Step 4: Verify repository boundaries and secret hygiene**

```bash
find /Users/leosong/Python/church4christ-demo -mindepth 1 -print
rg -n "sk_live_|rk_live_|STRIPE_SECRET_KEY=.*|whsec_[A-Za-z0-9]" . --glob '!node_modules/**' --glob '!.git/**'
git diff --check
git status --short
```

Expected: the demo command prints nothing; secret scan shows only intentional placeholder/prefix-validation fixtures; diff check is clean; status contains only intentional changes.

- [ ] **Step 5: Request independent implementation review**

Give the reviewer the approved design, this plan, commit range, and verification output. Require findings to cite file/line evidence and explicitly check:

- durable-before-ack behavior;
- lease fencing/checkpoints and payment-safe ordering;
- registration seat and idempotency invariants;
- exact test-mode enforcement at setup, runtime, webhook, retrieval, and admin boundaries;
- provider-specific D1/Supabase behavior;
- privacy, retention, authorization, and manual action safeguards.

Fix every confirmed finding, add a regression test first, and rerun the smallest affected suite plus the full verification command group it belongs to.

- [ ] **Step 6: Commit review fixes, if any**

```bash
git diff --cached --check
git commit -m "fix(stripe): address reliability review findings"
```

Before the two commands above, stage only the explicit paths changed for confirmed review findings; do not use a broad `git add`.

Skip this commit only when review produces no code or documentation change.

## Completion Gate

Implementation is complete only when all Task 14 commands pass, the independent reviewer has no unresolved confirmed finding, Stripe is visibly and technically test-only, D1 behavior remains intact, and `/Users/leosong/Python/church4christ-demo` is still empty. Demo creation is a separate, later phase that begins by asking the user which initial capabilities to enable and then selecting D1 or Supabase from those capabilities.
