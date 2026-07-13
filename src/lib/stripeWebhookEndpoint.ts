import type { AppDb } from './appDb';
import type { DbEnv } from './dbProvider';
import { verifyStripeWebhook, type StripeEnv } from './stripe';
import {
  STRIPE_WEBHOOK_MAX_BYTES,
  parseStripeEnvelope,
  receiveStripeEvent,
  sha256Utf8,
  type StripeEnvelope,
  type StripeReceiptInput,
  type StripeReceiptResult,
} from './stripeWebhookInbox';
import { processStripeWebhookEvent } from './stripeWebhookProcessor';

export interface StripeWebhookEndpointDeps {
  db: AppDb;
  env: StripeEnv & DbEnv;
  modules: ReadonlySet<string>;
  waitUntil?: (promise: Promise<unknown>) => void;
  nowSeconds?: number;
  receive?: typeof receiveStripeEvent;
  process?: typeof processStripeWebhookEvent;
}

function receiptInput(body: string, envelope: StripeEnvelope, payloadSha256: string): StripeReceiptInput {
  return {
    eventId: envelope.eventId,
    payloadJson: body,
    payloadSha256,
    eventType: envelope.eventType,
    apiVersion: envelope.apiVersion,
    eventCreated: envelope.eventCreated,
    livemode: envelope.livemode,
  };
}

/** Verify, validate, and durably receive one test-mode event before acknowledging it. */
export async function handleStripeWebhookRequest(
  request: Request,
  deps: StripeWebhookEndpointDeps,
): Promise<Response> {
  if (!(deps.modules.has('giving') || deps.modules.has('registration'))) {
    return new Response('Not found', { status: 404 });
  }

  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > STRIPE_WEBHOOK_MAX_BYTES) {
    return new Response('payload_too_large', { status: 413 });
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > STRIPE_WEBHOOK_MAX_BYTES) {
    return new Response('payload_too_large', { status: 413 });
  }

  const secret = deps.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response('webhook_not_configured', { status: 400 });

  const event = await verifyStripeWebhook(
    body,
    request.headers.get('stripe-signature') ?? '',
    secret,
    300,
    deps.nowSeconds,
  );
  if (!event) return new Response('invalid_signature', { status: 400 });

  let envelope: StripeEnvelope;
  try {
    envelope = parseStripeEnvelope(event);
  } catch {
    return new Response('invalid_envelope', { status: 400 });
  }
  if (envelope.livemode) return new Response('live_mode_disabled', { status: 400 });

  const input = receiptInput(body, envelope, await sha256Utf8(body));
  let receipt: StripeReceiptResult;
  try {
    receipt = await (deps.receive ?? receiveStripeEvent)(
      deps.db,
      input,
      new Date((deps.nowSeconds ?? Date.now() / 1000) * 1000),
    );
  } catch {
    return new Response('receipt_failed', { status: 500 });
  }

  if (receipt.kind === 'collision') {
    return new Response('event_id_collision', { status: 400 });
  }

  if ((receipt.kind === 'inserted' || receipt.status === 'pending') && deps.waitUntil) {
    const process = deps.process ?? processStripeWebhookEvent;
    deps.waitUntil(process(envelope.eventId, { env: deps.env }).catch(() => undefined));
  }

  return new Response(receipt.kind === 'duplicate' ? receipt.status : 'received', { status: 200 });
}
