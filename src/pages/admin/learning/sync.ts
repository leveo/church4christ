import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { hasAreaAccess } from '../../../lib/adminAreas';
import { hasSameOriginProvenance } from '../../../lib/csrf';
import { openDb } from '../../../lib/dbProvider';
import {
  LEARNING_SYNC_RUN_LIMITS,
  listLearningSyncTargets,
  reconcileLearningSyncTarget,
  type LearningSynchronizationEnv,
} from '../../../lib/learningSyncOrchestration';
import { LEARNING_LIMITS } from '../../../lib/learningModel';

export const prerender = false;

const MAX_BODY_BYTES = 16 * 1_024;
const SAFE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

interface ManualSyncDeps {
  readonly startBackgroundSync: (input: {
    readonly courseId: number;
    readonly trigger: 'manual';
  }) => Promise<void>;
}

const runtimeEnv = env as unknown as LearningSynchronizationEnv;
const DEFAULT_DEPS: ManualSyncDeps = Object.freeze({
  startBackgroundSync: async ({ courseId, trigger }: { readonly courseId: number; readonly trigger: 'manual' }) => {
    const { db, end } = openDb(runtimeEnv);
    try {
      const targets = await listLearningSyncTargets(db, { courseId, limit: 1 });
      const target = targets[0];
      if (!target) return;
      await reconcileLearningSyncTarget(runtimeEnv, db, {
        ...target,
        trigger,
        maxProviderPages: target.provider === 'google_classroom'
          ? LEARNING_SYNC_RUN_LIMITS.googleMaxPagesPerAttempt
          : LEARNING_SYNC_RUN_LIMITS.canvasMaxPagesPerAttempt,
      });
    } finally {
      await end();
    }
  },
});

function redirect(kind: 'saved' | 'error', code: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...SAFE_HEADERS, Location: `/admin/learning?${kind}=${encodeURIComponent(code)}` },
  });
}

async function readCourseId(request: Request): Promise<number | 'too_large' | null> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8\s*)?$/iu.test(contentType)) return null;
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/u.test(declared)) return null;
    const length = Number(declared);
    if (!Number.isSafeInteger(length)) return null;
    if (length > MAX_BODY_BYTES) return 'too_large';
  }
  const body = request.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        return 'too_large';
      }
      chunks.push(part.value);
    }
  } catch { return null; }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let encoded: string;
  try { encoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  if (/%(?![0-9a-f]{2})/iu.test(encoded)) return null;
  const entries = [...new URLSearchParams(encoded)];
  if (entries.length !== 1 || entries[0]?.[0] !== 'course_id') return null;
  const value = entries[0][1];
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const courseId = Number(value);
  return Number.isInteger(courseId) && courseId <= LEARNING_LIMITS.databaseInteger ? courseId : null;
}

export function createLearningManualSyncHandler(
  dependencies: ManualSyncDeps = DEFAULT_DEPS,
): APIRoute {
  return async ({ request, locals }) => {
    if (!locals.modules.has('learning')) return new Response(null, { status: 404, headers: SAFE_HEADERS });
    if (!hasAreaAccess(locals.user, 'learning')) return new Response(null, { status: 403, headers: SAFE_HEADERS });
    if (request.method !== 'POST') return new Response(null, {
      status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
    });
    if (!hasSameOriginProvenance(request)) return new Response(null, { status: 403, headers: SAFE_HEADERS });
    const courseId = await readCourseId(request);
    if (courseId === 'too_large') return new Response(null, { status: 413, headers: SAFE_HEADERS });
    if (courseId === null) return redirect('error', 'sync_invalid');
    const waitUntil = locals.cfContext?.waitUntil?.bind(locals.cfContext);
    if (!waitUntil) return redirect('error', 'sync_unavailable');
    const background = dependencies.startBackgroundSync({ courseId, trigger: 'manual' }).catch(() => {
      console.warn(JSON.stringify({ event: 'learning_sync_background_failed', trigger: 'manual' }));
    });
    try { waitUntil(background); } catch {
      void background;
      return redirect('error', 'sync_unavailable');
    }
    return redirect('saved', 'sync_started');
  };
}

export const POST: APIRoute = createLearningManualSyncHandler();
export const ALL: APIRoute = async () => new Response(null, {
  status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
});
