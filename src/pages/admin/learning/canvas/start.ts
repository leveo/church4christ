import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { hasAreaAccess } from '../../../../lib/adminAreas';
import type { AppDb } from '../../../../lib/appDb';
import { hasSameOriginProvenance } from '../../../../lib/csrf';
import {
  beginCanvasOAuthState,
  type BegunCanvasOAuthState,
} from '../../../../lib/learningCanvasAuth';
import {
  importLearningCredentialKeyRing,
  type LearningCredentialKeyRing,
} from '../../../../lib/learningCredentials';
import { normalizeCanvasBaseUrl } from '../../../../lib/learningModel';
import { SESSION_COOKIE } from '../../../../lib/session';

export const prerender = false;

const SAFE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});
const MAX_FORM_BYTES = 3_072;

interface CanvasOAuthStartDeps {
  readonly appOrigin: string | undefined | (() => string | undefined);
  readonly clientId: string | undefined | (() => string | undefined);
  readonly keySecret: string | undefined | (() => string | undefined);
  readonly importKeyRing: (secret: string) => Promise<unknown>;
  readonly beginState: (db: AppDb, input: {
    readonly connectionId: number;
    readonly expectedRevision: number;
    readonly actorPersonId: number;
    readonly sessionBinding: string;
    readonly baseUrl: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly keyRing: unknown;
    readonly nowEpochMs: number;
  }) => Promise<BegunCanvasOAuthState>;
  readonly now: () => number;
}

type CanvasOAuthEnv = {
  APP_ORIGIN?: string;
  CANVAS_OAUTH_CLIENT_ID?: string;
  LEARNING_CREDENTIAL_KEYS?: string;
};

const defaultVars = env as unknown as CanvasOAuthEnv;
const defaultDeps: CanvasOAuthStartDeps = {
  appOrigin: () => defaultVars.APP_ORIGIN,
  clientId: () => defaultVars.CANVAS_OAUTH_CLIENT_ID,
  keySecret: () => defaultVars.LEARNING_CREDENTIAL_KEYS,
  importKeyRing: importLearningCredentialKeyRing,
  beginState: (db, input) => beginCanvasOAuthState(db, {
    ...input, keyRing: input.keyRing as LearningCredentialKeyRing,
  }),
  now: Date.now,
};

function value(source: string | undefined | (() => string | undefined)): string {
  const result = typeof source === 'function' ? source() : source;
  if (typeof result !== 'string' || result.length < 1) throw new Error('config');
  return result;
}

function redirectError(): Response {
  return new Response(null, {
    status: 303,
    headers: { ...SAFE_HEADERS, Location: '/admin/learning?error=canvas_authorization_failed' },
  });
}

async function readStartForm(request: Request): Promise<{
  readonly connectionId: number;
  readonly revision: number;
  readonly baseUrl: string;
}> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') throw new Error('form');
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > MAX_FORM_BYTES)) {
    throw new RangeError('form');
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
      throw new RangeError('form');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let params: URLSearchParams;
  try { params = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new Error('form');
  }
  const entries = [...params.entries()];
  if (
    entries.length !== 3 || new Set(entries.map(([key]) => key)).size !== 3
    || !entries.every(([key]) => ['connection_id', 'revision', 'base_url'].includes(key))
  ) throw new Error('form');
  const rawConnection = params.get('connection_id');
  const rawRevision = params.get('revision');
  if (
    rawConnection === null || !/^[1-9]\d{0,9}$/u.test(rawConnection)
    || rawRevision === null || !/^(?:0|[1-9]\d{0,9})$/u.test(rawRevision)
  ) throw new Error('form');
  const connectionId = Number(rawConnection);
  const revision = Number(rawRevision);
  if (
    !Number.isInteger(connectionId) || connectionId > 2_147_483_647
    || !Number.isInteger(revision) || revision > 2_147_483_647
  ) throw new Error('form');
  return { connectionId, revision, baseUrl: normalizeCanvasBaseUrl(params.get('base_url')) };
}

export function createCanvasOAuthStartHandler(
  dependencies: CanvasOAuthStartDeps = defaultDeps,
): APIRoute {
  return async ({ request, locals, cookies }) => {
    if (!locals.modules.has('learning')) return new Response(null, { status: 404, headers: SAFE_HEADERS });
    const user = locals.user;
    if (!hasAreaAccess(user, 'learning')) return new Response(null, { status: 403, headers: SAFE_HEADERS });
    if (request.method !== 'POST') return new Response(null, {
      status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
    });
    if (!hasSameOriginProvenance(request)) return new Response(null, { status: 403, headers: SAFE_HEADERS });
    let form: Awaited<ReturnType<typeof readStartForm>>;
    try { form = await readStartForm(request); } catch { return redirectError(); }
    try {
      const sessionBinding = cookies.get(SESSION_COOKIE)?.value;
      if (typeof sessionBinding !== 'string' || sessionBinding.length < 1 || sessionBinding.length > 4_096) {
        throw new Error('session');
      }
      const appOrigin = value(dependencies.appOrigin);
      if (new URL(appOrigin).origin !== appOrigin) throw new Error('origin');
      const redirectUri = `${appOrigin}/admin/learning/canvas/callback`;
      const keyRing = await dependencies.importKeyRing(value(dependencies.keySecret));
      const begun = await dependencies.beginState(locals.db, {
        connectionId: form.connectionId,
        expectedRevision: form.revision,
        actorPersonId: user!.id,
        sessionBinding,
        baseUrl: form.baseUrl,
        clientId: value(dependencies.clientId),
        redirectUri,
        keyRing,
        nowEpochMs: dependencies.now(),
      });
      const authorization = new URL(begun.authorizationUrl);
      if (
        authorization.origin !== form.baseUrl
        || authorization.pathname !== '/login/oauth2/auth'
      ) throw new Error('authorization');
      return new Response(null, {
        status: 303, headers: { ...SAFE_HEADERS, Location: authorization.toString() },
      });
    } catch { return redirectError(); }
  };
}

export const POST: APIRoute = createCanvasOAuthStartHandler();
export const ALL: APIRoute = async () => new Response(null, {
  status: 405, headers: { ...SAFE_HEADERS, Allow: 'POST' },
});
