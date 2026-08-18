import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import type { AppDb } from '../../../../lib/appDb';
import { openDb } from '../../../../lib/dbProvider';
import {
  LEARNING_SYNC_RUN_LIMITS,
  reconcileLearningProviderCourse,
  type LearningSynchronizationEnv,
} from '../../../../lib/learningSyncOrchestration';
import {
  acceptCanvasLiveEvent,
  finishCanvasLiveEvent,
  verifyCanvasLiveEventJwt,
  type AcceptedCanvasLiveEvent,
  type CanvasLiveEvent,
} from '../../../../lib/learningCanvasLiveEvents';

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
  readonly openBackgroundDb: () => { readonly db: AppDb; readonly end: () => Promise<void> };
}

const defaultVars = env as unknown as Record<string, string | undefined> & LearningSynchronizationEnv;
const defaultDeps: CanvasLiveEventsRouteDeps = {
  now: Date.now,
  verifyEvent: verifyCanvasLiveEventJwt,
  acceptEvent: acceptCanvasLiveEvent,
  finishEvent: finishCanvasLiveEvent,
  openBackgroundDb: () => openDb(defaultVars),
  reconcileCourse: async (db, input) => {
    await reconcileLearningProviderCourse(defaultVars, db, {
      ...input,
      provider: 'canvas',
      maxProviderPages: LEARNING_SYNC_RUN_LIMITS.canvasMaxPagesPerAttempt,
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
      const waitUntil = locals.cfContext?.waitUntil?.bind(locals.cfContext);
      if (!waitUntil) {
        try {
          await dependencies.finishEvent(locals.db, {
            receipt: accepted, outcome: 'failed', completedAt: new Date(dependencies.now()).toISOString(),
          });
        } catch { /* stale-claim recovery remains available */ }
        return response(503);
      }
      let backgroundDb: ReturnType<CanvasLiveEventsRouteDeps['openBackgroundDb']>;
      try {
        backgroundDb = dependencies.openBackgroundDb();
      } catch {
        try {
          await dependencies.finishEvent(locals.db, {
            receipt: accepted,
            outcome: 'failed',
            completedAt: new Date(dependencies.now()).toISOString(),
          });
        } catch { /* stale-claim recovery remains available */ }
        return response(503);
      }
      let registered = false;
      let releaseRegistration!: () => void;
      const registration = new Promise<void>((resolve) => { releaseRegistration = resolve; });
      const background = registration.then(async () => {
        if (!registered) return;
        let outcome: 'failed' | 'succeeded' = 'failed';
        try {
          await dependencies.reconcileCourse(backgroundDb.db, {
            connectionId: accepted.connectionId,
            externalCourseId: accepted.externalCourseId,
            trigger: 'notification',
            signal: new AbortController().signal,
          });
          outcome = 'succeeded';
        } catch {
          console.warn(JSON.stringify({
            event: 'learning_notification_reconcile_failed', provider: 'canvas',
            trigger: 'notification', status: 'failed',
          }));
        }
        try {
          await dependencies.finishEvent(backgroundDb.db, {
            receipt: accepted, outcome, completedAt: new Date(dependencies.now()).toISOString(),
          });
        } catch { /* stale-claim recovery remains available */ }
      }).catch(() => {}).finally(async () => {
        try { await backgroundDb.end(); } catch { /* independent drainer cleanup is best effort */ }
      });
      try {
        waitUntil(background);
        registered = true;
        releaseRegistration();
      } catch {
        releaseRegistration();
        await background;
        try {
          await dependencies.finishEvent(locals.db, {
            receipt: accepted, outcome: 'failed', completedAt: new Date(dependencies.now()).toISOString(),
          });
        } catch { /* stale-claim recovery remains available */ }
        return response(503);
      }
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
