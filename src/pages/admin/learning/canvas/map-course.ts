import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { hasAreaAccess } from '../../../../lib/adminAreas';
import type { AppDb } from '../../../../lib/appDb';
import { hasSameOriginProvenance } from '../../../../lib/csrf';
import {
  mapSelectedCanvasCourse,
  unmapSelectedCanvasCourse,
} from '../../../../lib/learningCanvasAdmin';
import { importLearningCredentialKeyRing } from '../../../../lib/learningCredentials';
import { LEARNING_LIMITS, learningValidation } from '../../../../lib/learningModel';
import { readCanvasAllowedOrigins } from '../../../../lib/learningCanvasOrigins';

export const prerender = false;

const MAX_FORM_BYTES = 4_096;
const SAFE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

interface CanvasCourseMappingDeps {
  readonly mapCourse: (db: AppDb, input: {
    readonly connectionId: number;
    readonly expectedRevision: number;
    readonly externalCourseId: string;
    readonly programId: number;
    readonly rootAccountId: string;
    readonly actorPersonId: number;
  }) => Promise<unknown>;
  readonly unmapCourse: (db: AppDb, input: {
    readonly connectionId: number;
    readonly expectedRevision: number;
    readonly externalCourseId: string;
    readonly actorPersonId: number;
  }) => Promise<unknown>;
}

const vars = env as unknown as {
  CANVAS_OAUTH_CLIENT_ID?: string;
  CANVAS_OAUTH_CLIENT_SECRET?: string;
  LEARNING_CREDENTIAL_KEYS?: string;
  CANVAS_ALLOWED_ORIGINS?: string;
};

async function adminEnvironment(connectionId: number) {
  if (
    typeof vars.CANVAS_OAUTH_CLIENT_ID !== 'string'
    || typeof vars.CANVAS_OAUTH_CLIENT_SECRET !== 'string'
    || typeof vars.LEARNING_CREDENTIAL_KEYS !== 'string'
  ) throw new Error('config');
  return {
    connectionId,
    allowedOrigins: readCanvasAllowedOrigins(vars.CANVAS_ALLOWED_ORIGINS),
    clientId: vars.CANVAS_OAUTH_CLIENT_ID,
    clientSecret: vars.CANVAS_OAUTH_CLIENT_SECRET,
    keyRing: await importLearningCredentialKeyRing(vars.LEARNING_CREDENTIAL_KEYS),
    fetcher: fetch,
    nowEpochMs: Date.now(),
  };
}

const defaultDeps: CanvasCourseMappingDeps = {
  mapCourse: async (db, input) => mapSelectedCanvasCourse(db, {
    ...await adminEnvironment(input.connectionId), ...input,
  }),
  unmapCourse: async (db, input) => unmapSelectedCanvasCourse(db, {
    ...await adminEnvironment(input.connectionId), ...input,
  }),
};

function redirect(connectionId: number, kind: 'saved' | 'error', code: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      ...SAFE_HEADERS,
      Location: `/admin/learning/canvas/courses?connection_id=${connectionId}&${kind}=${code}`,
    },
  });
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') throw new Error('form');
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > MAX_FORM_BYTES)) {
    throw new Error('form');
  }
  const body = request.body;
  if (body === null) throw new Error('form');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    if (!(part.value instanceof Uint8Array)) throw new Error('form');
    total += part.value.byteLength;
    if (total > MAX_FORM_BYTES) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      throw new Error('form');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let params: URLSearchParams;
  try { params = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new Error('form');
  }
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of params) {
    if (Object.hasOwn(fields, key)) throw new Error('form');
    fields[key] = value;
  }
  return fields;
}

function number(value: string | undefined, minimum: number): number {
  if (value === undefined || !/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error('form');
  return learningValidation.integer(Number(value), minimum, LEARNING_LIMITS.databaseInteger);
}

function exact(fields: Record<string, string>, keys: readonly string[]): void {
  const actual = Object.keys(fields).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error('form');
  }
}

export function createCanvasCourseMappingHandler(
  dependencies: CanvasCourseMappingDeps = defaultDeps,
): APIRoute {
  return async ({ request, locals }) => {
    if (!locals.modules.has('learning')) return new Response(null, { status: 404, headers: SAFE_HEADERS });
    const user = locals.user;
    if (!hasAreaAccess(user, 'learning')) return new Response(null, { status: 403, headers: SAFE_HEADERS });
    if (request.method !== 'POST') return new Response(null, {
      status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
    });
    if (!hasSameOriginProvenance(request)) return new Response(null, { status: 403, headers: SAFE_HEADERS });
    let fields: Record<string, string>;
    try { fields = await readForm(request); } catch { return redirect(1, 'error', 'course_mapping_failed'); }
    let connectionId = 1;
    try {
      connectionId = number(fields.connection_id, 1);
      const expectedRevision = number(fields.revision, 0);
      const externalCourseId = learningValidation.externalId(fields.external_course_id);
      if (fields.action === 'map') {
        exact(fields, ['action', 'connection_id', 'revision', 'external_course_id', 'program_id', 'root_account_id']);
        await dependencies.mapCourse(locals.db, {
          connectionId, expectedRevision, externalCourseId,
          programId: number(fields.program_id, 1),
          rootAccountId: learningValidation.externalId(fields.root_account_id),
          actorPersonId: user!.id,
        });
        return redirect(connectionId, 'saved', 'course_mapped');
      }
      if (fields.action === 'unmap') {
        exact(fields, ['action', 'connection_id', 'revision', 'external_course_id']);
        await dependencies.unmapCourse(locals.db, {
          connectionId, expectedRevision, externalCourseId, actorPersonId: user!.id,
        });
        return redirect(connectionId, 'saved', 'course_unmapped');
      }
      throw new Error('form');
    } catch { return redirect(connectionId, 'error', 'course_mapping_failed'); }
  };
}

export const POST: APIRoute = createCanvasCourseMappingHandler();
export const ALL: APIRoute = async () => new Response(null, {
  status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
});
