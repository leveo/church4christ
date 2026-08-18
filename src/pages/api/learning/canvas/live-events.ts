import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import type { AppDb } from '../../../../lib/appDb';
import { reconcileCanvasCourse } from '../../../../lib/learningCanvasReconcile';
import { importLearningCredentialKeyRing } from '../../../../lib/learningCredentials';
import {
  acceptCanvasLiveEvent,
  finishCanvasLiveEvent,
  verifyCanvasLiveEventJwt,
  type AcceptedCanvasLiveEvent,
  type CanvasLiveEvent,
} from '../../../../lib/learningCanvasLiveEvents';
import { readCanvasAllowedOrigins } from '../../../../lib/learningCanvasOrigins';

export const prerender = false;

const MAX_BODY_BYTES = 65_536;
const BODY_READ_TIMEOUT_MS = 10_000;
const SAFE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

interface CanvasLiveEventsRouteDeps {
  readonly now: () => number;
  readonly verifyEvent: (input: {
    readonly compactJwt: string;
    readonly receivedAt: string;
  }) => Promise<CanvasLiveEvent>;
  readonly acceptEvent: (
    db: AppDb,
    event: CanvasLiveEvent,
  ) => Promise<AcceptedCanvasLiveEvent>;
  readonly reconcileCourse: (
    db: AppDb,
    input: {
      readonly connectionId: number;
      readonly externalCourseId: string;
      readonly trigger: 'notification';
      readonly signal: AbortSignal;
    },
  ) => Promise<unknown>;
  readonly finishEvent: (
    db: AppDb,
    input: {
      readonly receipt: AcceptedCanvasLiveEvent;
      readonly outcome: 'failed' | 'succeeded';
      readonly completedAt: string;
    },
  ) => Promise<void>;
}

const defaultVars = env as unknown as Record<string, string | undefined>;
const defaultDeps: CanvasLiveEventsRouteDeps = {
  now: Date.now,
  verifyEvent: verifyCanvasLiveEventJwt,
  acceptEvent: acceptCanvasLiveEvent,
  finishEvent: finishCanvasLiveEvent,
  reconcileCourse: async (db, input) => {
    const clientId = defaultVars.CANVAS_OAUTH_CLIENT_ID;
    const clientSecret = defaultVars.CANVAS_OAUTH_CLIENT_SECRET;
    const keySecret = defaultVars.LEARNING_CREDENTIAL_KEYS;
    if (
      typeof clientId !== 'string' || clientId.length < 1
      || typeof clientSecret !== 'string' || clientSecret.length < 1
      || typeof keySecret !== 'string' || keySecret.length < 1
    ) throw new Error('learning_canvas_config_unavailable');
    const keyRing = await importLearningCredentialKeyRing(keySecret);
    await reconcileCanvasCourse(db, {
      ...input,
      allowedOrigins: readCanvasAllowedOrigins(defaultVars.CANVAS_ALLOWED_ORIGINS),
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

class CanvasLiveEventsBodyTimeoutError extends Error {
  constructor() { super('body_timeout'); this.name = 'CanvasLiveEventsBodyTimeoutError'; }
}

function cancelBodyReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
}

function guardedBodyRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  abortError: () => Error,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      run();
    };
    const abort = (): void => finish(() => reject(abortError()));
    signal.addEventListener('abort', abort, { once: true });
    let pending: Promise<ReadableStreamReadResult<Uint8Array>>;
    try { pending = reader.read(); }
    catch { finish(() => reject(new Error('invalid_body'))); return; }
    pending.then(
      (part) => finish(() => resolve(part)),
      () => finish(() => reject(new Error('invalid_body'))),
    );
  });
}

async function readBoundedJwt(request: Request): Promise<string> {
  const body = request.body;
  if (body === null) throw new Error('invalid_body');
  const reader = body.getReader();
  const controller = new AbortController();
  let abortKind: 'invalid' | 'parent' | 'timeout' = 'invalid';
  let cancelled = false;
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    cancelBodyReader(reader);
  };
  const abort = (kind: typeof abortKind): void => {
    abortKind = kind;
    if (!controller.signal.aborted) controller.abort();
    cancel();
  };
  const parentAbort = (): void => abort('parent');
  request.signal.addEventListener('abort', parentAbort, { once: true });
  const deadlineAt = Date.now() + BODY_READ_TIMEOUT_MS;
  const timer = setTimeout(() => abort('timeout'), Math.max(0, deadlineAt - Date.now()));
  if (request.signal.aborted) abort('parent');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await guardedBodyRead(reader, controller.signal, () => (
        abortKind === 'timeout' ? new CanvasLiveEventsBodyTimeoutError() : new Error('invalid_body')
      ));
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        abort('invalid');
        throw new Error('invalid_body');
      }
      length += part.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        abort('invalid');
        throw new RangeError('body_too_large');
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (!controller.signal.aborted) abort('invalid');
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', parentAbort);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    abort('invalid');
    throw new Error('invalid_body');
  }
}

export function createCanvasLiveEventsHandler(
  dependencies: CanvasLiveEventsRouteDeps = defaultDeps,
): APIRoute {
  return async ({ request, locals }) => {
    if (!locals.modules.has('learning')) return response(404);
    if (request.method !== 'POST') return new Response(null, {
      status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
    });
    const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/jwt') return response(415);
    const rawLength = request.headers.get('Content-Length');
    if (rawLength !== null) {
      if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) return response(400);
      const length = Number(rawLength);
      if (!Number.isSafeInteger(length)) return response(400);
      if (length > MAX_BODY_BYTES) return response(413);
    }
    let compactJwt: string;
    try { compactJwt = await readBoundedJwt(request); } catch (error) {
      return response(error instanceof RangeError
        ? 413 : error instanceof CanvasLiveEventsBodyTimeoutError ? 408 : 400);
    }
    const receivedAt = new Date(dependencies.now()).toISOString();
    let event: CanvasLiveEvent;
    try { event = await dependencies.verifyEvent({ compactJwt, receivedAt }); } catch {
      return response(401);
    }
    try {
      const accepted = await dependencies.acceptEvent(locals.db, event);
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
          await dependencies.finishEvent(locals.db, {
            receipt: accepted,
            outcome: 'failed',
            completedAt: new Date(dependencies.now()).toISOString(),
          });
        } catch { /* 503 preserves Canvas redelivery and stale-claim recovery */ }
        return response(503);
      }
      await dependencies.finishEvent(locals.db, {
        receipt: accepted,
        outcome: 'succeeded',
        completedAt: new Date(dependencies.now()).toISOString(),
      });
      return response(204);
    } catch {
      return response(503);
    }
  };
}

export const POST: APIRoute = createCanvasLiveEventsHandler();
export const ALL: APIRoute = async () => new Response(null, {
  status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
});
