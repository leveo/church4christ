import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import type { AppDb } from '../../../../lib/appDb';
import { importLearningCredentialKeyRing } from '../../../../lib/learningCredentials';
import { reconcileGoogleClassroomCourse } from '../../../../lib/learningGoogleReconcile';
import {
  acceptGooglePubSubDelivery,
  finishGooglePubSubDelivery,
  parseGooglePubSubPushBody,
  verifyGooglePubSubAuthorization,
  type AcceptedGooglePubSubDelivery,
  type GooglePubSubDelivery,
  type GooglePubSubIdentity,
} from '../../../../lib/learningGooglePubSub';

export const prerender = false;

const MAX_BODY_BYTES = 65_536;
const SAFE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

interface GooglePubSubRouteDeps {
  readonly audience: string | undefined;
  readonly serviceAccountEmail: string | undefined;
  readonly subscriptionName: string | undefined;
  readonly now: () => number;
  readonly verifyAuthorization: (input: {
    readonly authorizationHeader: string | null;
    readonly expectedAudience: string;
    readonly expectedServiceAccountEmail: string;
    readonly nowEpochMs: number;
  }) => Promise<GooglePubSubIdentity>;
  readonly acceptDelivery: (db: AppDb, delivery: GooglePubSubDelivery) => Promise<AcceptedGooglePubSubDelivery>;
  readonly finishDelivery: (db: AppDb, input: {
    readonly receipt: AcceptedGooglePubSubDelivery;
    readonly outcome: 'failed' | 'succeeded';
    readonly completedAt: string;
  }) => Promise<void>;
  readonly reconcileCourse: (db: AppDb, input: {
    readonly connectionId: number;
    readonly externalCourseId: string;
    readonly trigger: 'notification';
    readonly signal: AbortSignal;
  }) => Promise<void>;
}

type GooglePushEnv = {
  APP_ORIGIN?: string;
  GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PUBSUB_SUBSCRIPTION_NAME?: string;
  GOOGLE_CLASSROOM_CLIENT_ID?: string;
  GOOGLE_CLASSROOM_CLIENT_SECRET?: string;
  LEARNING_CREDENTIAL_KEYS?: string;
};

const defaultVars = env as unknown as GooglePushEnv;
const defaultDeps: GooglePubSubRouteDeps = {
  audience: typeof defaultVars.APP_ORIGIN === 'string'
    ? `${defaultVars.APP_ORIGIN}/api/learning/google/pubsub`
    : undefined,
  serviceAccountEmail: defaultVars.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL,
  subscriptionName: defaultVars.GOOGLE_PUBSUB_SUBSCRIPTION_NAME,
  now: Date.now,
  verifyAuthorization: verifyGooglePubSubAuthorization,
  acceptDelivery: acceptGooglePubSubDelivery,
  finishDelivery: finishGooglePubSubDelivery,
  reconcileCourse: async (db, input) => {
    const clientId = defaultVars.GOOGLE_CLASSROOM_CLIENT_ID;
    const clientSecret = defaultVars.GOOGLE_CLASSROOM_CLIENT_SECRET;
    const keySecret = defaultVars.LEARNING_CREDENTIAL_KEYS;
    if (
      typeof clientId !== 'string' || clientId.length < 1
      || typeof clientSecret !== 'string' || clientSecret.length < 1
      || typeof keySecret !== 'string' || keySecret.length < 1
    ) throw new Error('learning_google_config_unavailable');
    const keyRing = await importLearningCredentialKeyRing(keySecret);
    await reconcileGoogleClassroomCourse(db, {
      ...input,
      clientId,
      clientSecret,
      keyRing,
      fetcher: fetch,
      now: Date.now,
    });
  },
};

function response(status: number): Response {
  return new Response(null, { status, headers: SAFE_HEADERS });
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const body = request.body;
  if (body === null) throw new Error('invalid_body');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    let part: ReadableStreamReadResult<Uint8Array>;
    try { part = await reader.read(); } catch { throw new Error('invalid_body'); }
    if (part.done) break;
    if (!(part.value instanceof Uint8Array)) throw new Error('invalid_body');
    length += part.value.byteLength;
    if (length > MAX_BODY_BYTES) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      throw new RangeError('body_too_large');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createGooglePubSubPushHandler(
  dependencies: GooglePubSubRouteDeps = defaultDeps,
): APIRoute {
  return async ({ request, locals }) => {
    if (!locals.modules.has('learning')) return response(404);
    if (request.method !== 'POST') return new Response(null, {
      status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
    });
    const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') return response(415);
    const rawLength = request.headers.get('Content-Length');
    if (rawLength !== null) {
      if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) return response(400);
      const length = Number(rawLength);
      if (!Number.isSafeInteger(length)) return response(400);
      if (length > MAX_BODY_BYTES) return response(413);
    }
    const { audience, serviceAccountEmail, subscriptionName } = dependencies;
    if (
      typeof audience !== 'string'
      || typeof serviceAccountEmail !== 'string'
      || typeof subscriptionName !== 'string'
    ) return response(503);
    const now = dependencies.now();
    try {
      await dependencies.verifyAuthorization({
        authorizationHeader: request.headers.get('Authorization'),
        expectedAudience: audience,
        expectedServiceAccountEmail: serviceAccountEmail,
        nowEpochMs: now,
      });
    } catch {
      return response(401);
    }
    let rawBody: Uint8Array;
    try { rawBody = await readBoundedBody(request); } catch (error) {
      return response(error instanceof RangeError ? 413 : 400);
    }
    let delivery: GooglePubSubDelivery;
    try {
      delivery = parseGooglePubSubPushBody({
        rawBody,
        expectedSubscriptionName: subscriptionName,
        receivedAt: new Date(now).toISOString(),
      });
    } catch {
      return response(400);
    }
    try {
      const accepted = await dependencies.acceptDelivery(locals.db, delivery);
      if (accepted.disposition === 'succeeded') return response(204);
      if (accepted.disposition === 'in_progress') return response(503);
      try {
        await dependencies.reconcileCourse(locals.db, {
          connectionId: accepted.connectionId,
          externalCourseId: accepted.externalCourseId,
          trigger: 'notification',
          signal: request.signal,
        });
      } catch {
        try {
          await dependencies.finishDelivery(locals.db, {
            receipt: accepted, outcome: 'failed', completedAt: new Date(dependencies.now()).toISOString(),
          });
        } catch { /* the 503 preserves Pub/Sub redelivery and stale-claim recovery */ }
        return response(503);
      }
      await dependencies.finishDelivery(locals.db, {
        receipt: accepted, outcome: 'succeeded', completedAt: new Date(dependencies.now()).toISOString(),
      });
      return response(204);
    } catch {
      return response(503);
    }
  };
}

export const POST: APIRoute = createGooglePubSubPushHandler();
export const ALL: APIRoute = async () => new Response(null, {
  status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
});
