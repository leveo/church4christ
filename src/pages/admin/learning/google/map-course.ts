import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { hasAreaAccess } from '../../../../lib/adminAreas';
import type { AppDb } from '../../../../lib/appDb';
import { hasSameOriginProvenance } from '../../../../lib/csrf';
import {
  mapSelectedGoogleClassroomCourse,
  unmapSelectedGoogleClassroomCourse,
} from '../../../../lib/learningGoogleAdmin';
import { importLearningCredentialKeyRing } from '../../../../lib/learningCredentials';
import { googleClassroomPushReadiness } from '../../../../lib/learningGoogleRegistrationLifecycle';

export const prerender = false;

const SAFE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});
const MAX_FORM_BYTES = 2_048;

interface GoogleCourseMappingDeps {
  readonly mapSelectedCourse: (db: AppDb, input: {
    readonly connectionId: number;
    readonly externalCourseId: string;
    readonly programId: number;
    readonly actorPersonId: number;
    readonly expectedRevision: number;
  }) => Promise<unknown>;
  readonly unmapSelectedCourse: (db: AppDb, input: {
    readonly connectionId: number;
    readonly externalCourseId: string;
    readonly actorPersonId: number;
    readonly expectedRevision: number;
  }) => Promise<unknown>;
}

type GoogleMappingEnv = {
  GOOGLE_CLASSROOM_CLIENT_ID?: string;
  GOOGLE_CLASSROOM_CLIENT_SECRET?: string;
  GOOGLE_CLASSROOM_PUBSUB_TOPIC?: string;
  GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_PUBSUB_SUBSCRIPTION_NAME?: string;
  LEARNING_CREDENTIAL_KEYS?: string;
};

const vars = env as unknown as GoogleMappingEnv;
const defaultDeps: GoogleCourseMappingDeps = {
  mapSelectedCourse: async (db, input) => {
    if (
      typeof vars.GOOGLE_CLASSROOM_CLIENT_ID !== 'string'
      || typeof vars.GOOGLE_CLASSROOM_CLIENT_SECRET !== 'string'
      || typeof vars.LEARNING_CREDENTIAL_KEYS !== 'string'
    ) throw new Error('config');
    const readiness = googleClassroomPushReadiness({
      topicName: vars.GOOGLE_CLASSROOM_PUBSUB_TOPIC,
      subscriptionName: vars.GOOGLE_PUBSUB_SUBSCRIPTION_NAME,
      serviceAccountEmail: vars.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL,
    });
    if (readiness.mode === 'misconfigured') throw new Error('config');
    const keyRing = await importLearningCredentialKeyRing(vars.LEARNING_CREDENTIAL_KEYS);
    return mapSelectedGoogleClassroomCourse(db, {
      ...input,
      clientId: vars.GOOGLE_CLASSROOM_CLIENT_ID,
      clientSecret: vars.GOOGLE_CLASSROOM_CLIENT_SECRET,
      keyRing,
      fetcher: fetch,
      nowEpochMs: Date.now(),
      pushTopicName: readiness.topicName,
    });
  },
  unmapSelectedCourse: async (db, input) => {
    if (
      typeof vars.GOOGLE_CLASSROOM_CLIENT_ID !== 'string'
      || typeof vars.GOOGLE_CLASSROOM_CLIENT_SECRET !== 'string'
      || typeof vars.LEARNING_CREDENTIAL_KEYS !== 'string'
    ) throw new Error('config');
    const keyRing = await importLearningCredentialKeyRing(vars.LEARNING_CREDENTIAL_KEYS);
    return unmapSelectedGoogleClassroomCourse(db, {
      ...input,
      clientId: vars.GOOGLE_CLASSROOM_CLIENT_ID,
      clientSecret: vars.GOOGLE_CLASSROOM_CLIENT_SECRET,
      keyRing,
      fetcher: fetch,
      nowEpochMs: Date.now(),
    });
  },
};

function redirect(connectionId: number, kind: 'saved' | 'error', code: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      ...SAFE_HEADERS,
      Location: `/admin/learning/google/courses?connection_id=${connectionId}&${kind}=${code}`,
    },
  });
}

async function readBody(request: Request): Promise<Uint8Array> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') throw new Error('form');
  const rawLength = request.headers.get('Content-Length');
  if (rawLength !== null && (!/^(?:0|[1-9]\d*)$/u.test(rawLength) || Number(rawLength) > MAX_FORM_BYTES)) {
    throw new Error('form');
  }
  const body = request.body;
  if (body === null) throw new Error('form');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    if (!(part.value instanceof Uint8Array)) throw new Error('form');
    length += part.value.byteLength;
    if (length > MAX_FORM_BYTES) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      throw new Error('form');
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

function positiveInteger(value: string | null): number | null {
  if (value === null || !/^[1-9]\d{0,9}$/u.test(value)) return null;
  const number = Number(value);
  return Number.isInteger(number) && number <= 2_147_483_647 ? number : null;
}

export function createGoogleCourseMappingHandler(
  dependencies: GoogleCourseMappingDeps = defaultDeps,
): APIRoute {
  return async ({ request, locals }) => {
    if (!locals.modules.has('learning')) return new Response(null, { status: 404, headers: SAFE_HEADERS });
    const user = locals.user;
    if (!hasAreaAccess(user, 'learning')) return new Response(null, { status: 403, headers: SAFE_HEADERS });
    if (request.method !== 'POST') return new Response(null, {
      status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
    });
    if (!hasSameOriginProvenance(request)) return new Response(null, { status: 403, headers: SAFE_HEADERS });
    let params: URLSearchParams;
    try {
      const bytes = await readBody(request);
      params = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return redirect(1, 'error', 'course_mapping_failed');
    }
    const connectionId = positiveInteger(params.get('connection_id')) ?? 1;
    const entries = [...params.entries()];
    const action = params.get('action');
    const expectedRevision = positiveInteger(params.get('revision'));
    const mapKeys = ['action', 'connection_id', 'revision', 'external_course_id', 'program_id'];
    const unmapKeys = ['action', 'connection_id', 'revision', 'external_course_id'];
    const expectedKeys = action === 'map' ? mapKeys : action === 'unmap' ? unmapKeys : [];
    const strict = entries.length === expectedKeys.length
      && new Set(entries.map(([key]) => key)).size === expectedKeys.length
      && entries.every(([key]) => expectedKeys.includes(key));
    const programId = positiveInteger(params.get('program_id'));
    const externalCourseId = params.get('external_course_id');
    if (
      !strict || expectedRevision === null || externalCourseId === null
      || externalCourseId.length < 1 || externalCourseId.length > 255
      || externalCourseId.trim() !== externalCourseId || /[\u0000-\u001f\u007f]/u.test(externalCourseId)
    ) return redirect(connectionId, 'error', 'course_mapping_failed');
    try {
      if (action === 'unmap') {
        await dependencies.unmapSelectedCourse(locals.db, {
          connectionId, expectedRevision, externalCourseId, actorPersonId: user!.id,
        });
        return redirect(connectionId, 'saved', 'course_unmapped');
      }
      if (action !== 'map' || programId === null) throw new Error('form');
      await dependencies.mapSelectedCourse(locals.db, {
        connectionId, expectedRevision, externalCourseId, programId, actorPersonId: user!.id,
      });
      return redirect(connectionId, 'saved', 'course_mapped');
    } catch {
      return redirect(connectionId, 'error', 'course_mapping_failed');
    }
  };
}

export const POST: APIRoute = createGoogleCourseMappingHandler();
export const ALL: APIRoute = async () => new Response(null, {
  status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
});
