import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { hasAreaAccess } from '../../../../lib/adminAreas';
import type { AppDb } from '../../../../lib/appDb';
import {
  claimCanvasOAuthCallbackState,
  completeCanvasOAuthState,
  exchangeCanvasAuthorizationCode,
  type CanvasCredential,
  type ClaimedCanvasOAuthState,
} from '../../../../lib/learningCanvasAuth';
import {
  importLearningCredentialKeyRing,
  type LearningCredentialKeyRing,
} from '../../../../lib/learningCredentials';
import { SESSION_COOKIE } from '../../../../lib/session';
import {
  readCanvasAllowedOrigins,
  requireAllowedCanvasOrigin,
  type CanvasAllowedOriginsSource,
} from '../../../../lib/learningCanvasOrigins';

export const prerender = false;

const SAFE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

interface CanvasOAuthCallbackDeps {
  readonly appOrigin: string | undefined | (() => string | undefined);
  readonly canvasAllowedOrigins: CanvasAllowedOriginsSource;
  readonly clientId: string | undefined | (() => string | undefined);
  readonly clientSecret: string | undefined | (() => string | undefined);
  readonly keySecret: string | undefined | (() => string | undefined);
  readonly importKeyRing: (secret: string) => Promise<unknown>;
  readonly claimState: (db: AppDb, input: {
    readonly state: string;
    readonly sessionBinding: string;
    readonly actorPersonId: number;
    readonly redirectUri: string;
    readonly keyRing: unknown;
    readonly nowEpochMs: number;
  }) => Promise<ClaimedCanvasOAuthState>;
  readonly exchangeCode: (input: {
    readonly baseUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly fetcher: typeof fetch;
    readonly signal: AbortSignal;
    readonly nowEpochMs: number;
  }) => Promise<CanvasCredential>;
  readonly completeState: (db: AppDb, input: {
    readonly claim: ClaimedCanvasOAuthState;
    readonly credential: CanvasCredential;
    readonly keyRing: unknown;
    readonly nowEpochMs: number;
  }) => Promise<unknown>;
  readonly now: () => number;
}

type CanvasOAuthEnv = {
  APP_ORIGIN?: string;
  CANVAS_OAUTH_CLIENT_ID?: string;
  CANVAS_OAUTH_CLIENT_SECRET?: string;
  LEARNING_CREDENTIAL_KEYS?: string;
};

const defaultVars = env as unknown as CanvasOAuthEnv;
const defaultDeps: CanvasOAuthCallbackDeps = {
  appOrigin: () => defaultVars.APP_ORIGIN,
  canvasAllowedOrigins: () => (defaultVars as CanvasOAuthEnv & { CANVAS_ALLOWED_ORIGINS?: string }).CANVAS_ALLOWED_ORIGINS,
  clientId: () => defaultVars.CANVAS_OAUTH_CLIENT_ID,
  clientSecret: () => defaultVars.CANVAS_OAUTH_CLIENT_SECRET,
  keySecret: () => defaultVars.LEARNING_CREDENTIAL_KEYS,
  importKeyRing: importLearningCredentialKeyRing,
  claimState: (db, input) => claimCanvasOAuthCallbackState(db, {
    ...input, keyRing: input.keyRing as LearningCredentialKeyRing,
  }),
  exchangeCode: exchangeCanvasAuthorizationCode,
  completeState: (db, input) => completeCanvasOAuthState(db, {
    ...input, keyRing: input.keyRing as LearningCredentialKeyRing,
  }),
  now: Date.now,
};

function value(source: string | undefined | (() => string | undefined)): string {
  const result = typeof source === 'function' ? source() : source;
  if (typeof result !== 'string' || result.length < 1) throw new Error('config');
  return result;
}

function redirect(kind: 'saved' | 'error', code: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...SAFE_HEADERS, Location: `/admin/learning?${kind}=${code}` },
  });
}

function callbackQuery(url: URL): { readonly code: string; readonly state: string } {
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 2 || entries[0]?.[0] === entries[1]?.[0]
    || !entries.every(([key]) => key === 'code' || key === 'state')
  ) throw new Error('query');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (
    code === null || code.length < 1 || code.length > 4_096 || !/^[\x21-\x7e]+$/u.test(code)
    || state === null || !/^[A-Za-z0-9_-]{43,128}$/u.test(state)
  ) throw new Error('query');
  return { code, state };
}

export function createCanvasOAuthCallbackHandler(
  dependencies: CanvasOAuthCallbackDeps = defaultDeps,
): APIRoute {
  return async ({ request, locals, cookies }) => {
    if (!locals.modules.has('learning')) return new Response(null, { status: 404, headers: SAFE_HEADERS });
    const user = locals.user;
    if (!hasAreaAccess(user, 'learning')) return new Response(null, { status: 403, headers: SAFE_HEADERS });
    if (request.method !== 'GET') return new Response(null, {
      status: 405, headers: { ...SAFE_HEADERS, Allow: 'GET' },
    });
    let query: ReturnType<typeof callbackQuery>;
    try { query = callbackQuery(new URL(request.url)); } catch {
      return redirect('error', 'canvas_authorization_failed');
    }
    try {
      readCanvasAllowedOrigins(dependencies.canvasAllowedOrigins);
      const sessionBinding = cookies.get(SESSION_COOKIE)?.value;
      if (typeof sessionBinding !== 'string' || sessionBinding.length < 1 || sessionBinding.length > 4_096) {
        throw new Error('session');
      }
      const appOrigin = value(dependencies.appOrigin);
      if (new URL(appOrigin).origin !== appOrigin) throw new Error('origin');
      const redirectUri = `${appOrigin}/admin/learning/canvas/callback`;
      const keyRing = await dependencies.importKeyRing(value(dependencies.keySecret));
      const nowEpochMs = dependencies.now();
      const claim = await dependencies.claimState(locals.db, {
        state: query.state,
        sessionBinding,
        actorPersonId: user!.id,
        redirectUri,
        keyRing,
        nowEpochMs,
      });
      requireAllowedCanvasOrigin(claim.baseUrl, readCanvasAllowedOrigins(dependencies.canvasAllowedOrigins));
      const credential = await dependencies.exchangeCode({
        baseUrl: claim.baseUrl,
        clientId: value(dependencies.clientId),
        clientSecret: value(dependencies.clientSecret),
        code: query.code,
        codeVerifier: claim.codeVerifier,
        redirectUri,
        fetcher: fetch,
        signal: request.signal,
        nowEpochMs,
      });
      await dependencies.completeState(locals.db, {
        claim, credential, keyRing, nowEpochMs: dependencies.now(),
      });
      return redirect('saved', 'canvas_connected');
    } catch { return redirect('error', 'canvas_authorization_failed'); }
  };
}

export const GET: APIRoute = createCanvasOAuthCallbackHandler();
export const ALL: APIRoute = async () => new Response(null, {
  status: 405, headers: { ...SAFE_HEADERS, Allow: 'GET' },
});
