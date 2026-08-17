import type { AppDb } from './appDb';
import {
  decryptLearningCredential,
  encryptLearningCredential,
  type LearningCredentialEnvelope,
  type LearningCredentialKeyRing,
} from './learningCredentials';
import { CANVAS_REQUIRED_SCOPES } from './learningCanvasProvider';
import {
  LEARNING_LIMITS,
  learningValidation,
  normalizeCanvasBaseUrl,
} from './learningModel';

export const CANVAS_OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const MAX_TOKEN_RESPONSE_BYTES = 65_536;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();

export class LearningCanvasAuthError extends Error {
  readonly code = 'learning_canvas_auth_invalid' as const;
  constructor() {
    super('learning_canvas_auth_invalid');
    this.name = 'LearningCanvasAuthError';
  }
}

export class LearningCanvasAuthConflictError extends Error {
  readonly code = 'learning_canvas_auth_conflict' as const;
  constructor() {
    super('learning_canvas_auth_conflict');
    this.name = 'LearningCanvasAuthConflictError';
  }
}

const invalid = (): never => { throw new LearningCanvasAuthError(); };

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const row = learningValidation.dataRecord(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(row, key))) invalid();
  if (Object.keys(row).some((key) => !allowed.has(key))) invalid();
  return row;
}

function dbInteger(value: unknown, minimum = 1): number {
  try { return learningValidation.integer(value, minimum, LEARNING_LIMITS.databaseInteger); }
  catch { return invalid(); }
}

function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function bounded(value: unknown, maximum: number): string {
  try { return learningValidation.boundedString(value, 1, maximum); }
  catch { return invalid(); }
}

function asciiToken(value: unknown, maximum: number): string {
  const token = bounded(value, maximum);
  if (!/^[\x21-\x7e]+$/u.test(token)) invalid();
  return token;
}

function redirectUri(value: unknown): string {
  const raw = bounded(value, LEARNING_LIMITS.urlBytes);
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(); }
  if (
    url.toString() !== raw
    || url.protocol !== 'https:'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || url.pathname !== '/admin/learning/canvas/callback'
  ) invalid();
  return raw;
}

function sessionBinding(value: unknown): string {
  const binding = bounded(value, 4_096);
  if (/\s/u.test(binding)) invalid();
  return binding;
}

function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function databaseBytes(value: unknown, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array | null = null;
  if (value instanceof Uint8Array) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (Array.isArray(value) && value.every(
    (byte) => Number.isInteger(byte) && (byte as number) >= 0 && (byte as number) <= 255,
  )) bytes = new Uint8Array(value as number[]);
  if (bytes === null || bytes.byteLength < minimum || bytes.byteLength > maximum) invalid();
  const safeBytes = bytes ?? invalid();
  return owned(safeBytes);
}

function base64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function sha256(value: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', owned(value)));
}

async function bindingHash(value: string): Promise<Uint8Array<ArrayBuffer>> {
  return owned(await sha256(encoder.encode(value)));
}

function randomBytes(source: ((size: number) => Uint8Array) | undefined, size: number): Uint8Array<ArrayBuffer> {
  let value: Uint8Array;
  try { value = source ? source(size) : crypto.getRandomValues(new Uint8Array(size)); }
  catch { return invalid(); }
  if (!(value instanceof Uint8Array) || value.byteLength !== size) invalid();
  return owned(value);
}

export interface CanvasOAuthAuthorizationRequest {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly stateHash: Uint8Array<ArrayBuffer>;
  readonly codeVerifier: string;
  readonly expiresAt: string;
}

export async function createCanvasOAuthAuthorizationRequest(rawInput: {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly nowEpochMs: number;
  readonly randomBytes?: (size: number) => Uint8Array;
}): Promise<CanvasOAuthAuthorizationRequest> {
  try {
    const baseUrl = normalizeCanvasBaseUrl(rawInput.baseUrl);
    const clientId = asciiToken(rawInput.clientId, 512);
    const redirect = redirectUri(rawInput.redirectUri);
    const now = epoch(rawInput.nowEpochMs);
    const state = base64Url(randomBytes(rawInput.randomBytes, 32));
    const codeVerifier = base64Url(randomBytes(rawInput.randomBytes, 64));
    if (!/^[A-Za-z0-9_-]{43}$/u.test(state) || !/^[A-Za-z0-9_-]{86}$/u.test(codeVerifier)) invalid();
    const challenge = base64Url(await sha256(encoder.encode(codeVerifier)));
    const url = new URL('/login/oauth2/auth', baseUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', CANVAS_REQUIRED_SCOPES.join(' '));
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return Object.freeze({
      authorizationUrl: url.toString(),
      state,
      stateHash: owned(await sha256(encoder.encode(state))),
      codeVerifier,
      expiresAt: new Date(now + CANVAS_OAUTH_STATE_TTL_MS).toISOString(),
    });
  } catch (error) {
    if (error instanceof LearningCanvasAuthError) throw error;
    return invalid();
  }
}

export interface CanvasCredential {
  readonly version: 1;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string;
  readonly grantedScopes: typeof CANVAS_REQUIRED_SCOPES;
}

function canonicalScopes(value: unknown): typeof CANVAS_REQUIRED_SCOPES {
  const raw = bounded(value, 8_192);
  const scopes = raw.split(' ');
  if (scopes.some((scope) => scope.length === 0) || new Set(scopes).size !== scopes.length) invalid();
  const actual = [...scopes].sort();
  const expected = [...CANVAS_REQUIRED_SCOPES].sort();
  if (actual.length !== expected.length || actual.some((scope, index) => scope !== expected[index])) invalid();
  return CANVAS_REQUIRED_SCOPES;
}

function normalizeCredential(value: unknown): CanvasCredential {
  const row = exact(value, [
    'version', 'accessToken', 'refreshToken', 'accessTokenExpiresAt', 'grantedScopes',
  ]);
  if (row.version !== 1) invalid();
  const scopes = learningValidation.dataArray(row.grantedScopes, CANVAS_REQUIRED_SCOPES.length);
  if (
    scopes.length !== CANVAS_REQUIRED_SCOPES.length
    || scopes.some((scope, index) => scope !== CANVAS_REQUIRED_SCOPES[index])
  ) invalid();
  return Object.freeze({
    version: 1,
    accessToken: asciiToken(row.accessToken, 8_192),
    refreshToken: asciiToken(row.refreshToken, 8_192),
    accessTokenExpiresAt: learningValidation.timestamp(row.accessTokenExpiresAt),
    grantedScopes: CANVAS_REQUIRED_SCOPES,
  });
}

export function normalizeCanvasTokenResponse(
  value: unknown,
  rawOptions: {
    readonly nowEpochMs: number;
    readonly requireRefreshToken: boolean;
    readonly retainedRefreshToken: string | null;
  },
): CanvasCredential {
  try {
    const row = exact(value, ['access_token', 'expires_in', 'token_type'], [
      'refresh_token', 'scope', 'canvas_region', 'user',
    ]);
    const options = exact(rawOptions, ['nowEpochMs', 'requireRefreshToken', 'retainedRefreshToken']);
    const now = epoch(options.nowEpochMs);
    if (options.requireRefreshToken !== true && options.requireRefreshToken !== false) invalid();
    const expiresIn = learningValidation.integer(row.expires_in, 1, 31_622_400);
    if (row.token_type !== 'Bearer' && row.token_type !== 'bearer') invalid();
    if (row.canvas_region !== undefined) bounded(row.canvas_region, 64);
    if (row.user !== undefined) learningValidation.dataRecord(row.user);
    if (row.scope !== undefined) canonicalScopes(row.scope);
    const returnedRefresh = row.refresh_token === undefined ? null : asciiToken(row.refresh_token, 8_192);
    const retained = options.retainedRefreshToken === null
      ? null : asciiToken(options.retainedRefreshToken, 8_192);
    const refreshToken = returnedRefresh ?? retained;
    if (refreshToken === null || (options.requireRefreshToken === true && returnedRefresh === null)) invalid();
    const safeRefreshToken = refreshToken ?? invalid();
    return Object.freeze({
      version: 1,
      accessToken: asciiToken(row.access_token, 8_192),
      refreshToken: safeRefreshToken,
      accessTokenExpiresAt: new Date(now + expiresIn * 1_000).toISOString(),
      grantedScopes: CANVAS_REQUIRED_SCOPES,
    });
  } catch (error) {
    if (error instanceof LearningCanvasAuthError) throw error;
    return invalid();
  }
}

export function encodeCanvasCredential(value: CanvasCredential): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(normalizeCredential(value)));
}

export function decodeCanvasCredential(value: Uint8Array): CanvasCredential {
  try {
    if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 16_368) invalid();
    return normalizeCredential(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as unknown);
  } catch (error) {
    if (error instanceof LearningCanvasAuthError) throw error;
    return invalid();
  }
}

type CanvasAuthFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function boundedFetch(
  url: URL,
  init: RequestInit,
  fetcher: CanvasAuthFetcher,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) invalid();
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.abort();
      reject(new LearningCanvasAuthError());
    };
    const abort = (): void => fail();
    const timer = setTimeout(fail, TOKEN_REQUEST_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    let pending: Promise<Response>;
    try { pending = Promise.resolve(fetcher(url, { ...init, redirect: 'manual', signal: controller.signal })); }
    catch { fail(); return; }
    pending.then((response) => {
      if (settled) {
        if (response instanceof Response && response.body !== null) {
          try { void response.body.cancel().catch(() => undefined); } catch { /* best effort */ }
        }
        return;
      }
      settled = true;
      cleanup();
      if (!(response instanceof Response) || response.status < 200 || response.status >= 300) {
        if (response instanceof Response && response.body !== null) {
          try { void response.body.cancel().catch(() => undefined); } catch { /* best effort */ }
        }
        reject(new LearningCanvasAuthError());
        return;
      }
      resolve(response);
    }, fail);
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const body = response.body ?? invalid();
  const rawLength = response.headers.get('Content-Length');
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) invalid();
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length > MAX_TOKEN_RESPONSE_BYTES) invalid();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) invalid();
      total += part.value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) invalid();
      chunks.push(part.value);
    }
  } catch {
    try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
    return invalid();
  }
  if (rawLength !== null && Number(rawLength) !== total) invalid();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return invalid(); }
}

async function tokenRequest(input: {
  readonly baseUrl: string;
  readonly fields: URLSearchParams;
  readonly fetcher: CanvasAuthFetcher;
  readonly signal: AbortSignal;
}): Promise<unknown> {
  const baseUrl = normalizeCanvasBaseUrl(input.baseUrl);
  const response = await boundedFetch(new URL('/login/oauth2/token', baseUrl), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: input.fields,
  }, input.fetcher, input.signal);
  return readBoundedJson(response);
}

export async function exchangeCanvasAuthorizationCode(rawInput: {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly fetcher: CanvasAuthFetcher;
  readonly signal: AbortSignal;
  readonly nowEpochMs: number;
}): Promise<CanvasCredential> {
  const fields = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: asciiToken(rawInput.clientId, 512),
    client_secret: asciiToken(rawInput.clientSecret, 8_192),
    redirect_uri: redirectUri(rawInput.redirectUri),
    code: asciiToken(rawInput.code, 4_096),
    code_verifier: asciiToken(rawInput.codeVerifier, 128),
  });
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(fields.get('code_verifier') ?? '')) invalid();
  return normalizeCanvasTokenResponse(await tokenRequest({
    baseUrl: rawInput.baseUrl, fields, fetcher: rawInput.fetcher, signal: rawInput.signal,
  }), { nowEpochMs: rawInput.nowEpochMs, requireRefreshToken: true, retainedRefreshToken: null });
}

export async function refreshCanvasAccessToken(rawInput: {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly fetcher: CanvasAuthFetcher;
  readonly signal: AbortSignal;
  readonly nowEpochMs: number;
}): Promise<CanvasCredential> {
  const refreshToken = asciiToken(rawInput.refreshToken, 8_192);
  const fields = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: asciiToken(rawInput.clientId, 512),
    client_secret: asciiToken(rawInput.clientSecret, 8_192),
    refresh_token: refreshToken,
  });
  return normalizeCanvasTokenResponse(await tokenRequest({
    baseUrl: rawInput.baseUrl, fields, fetcher: rawInput.fetcher, signal: rawInput.signal,
  }), { nowEpochMs: rawInput.nowEpochMs, requireRefreshToken: false, retainedRefreshToken: refreshToken });
}

export async function revokeCanvasAccessToken(rawInput: {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly fetcher: CanvasAuthFetcher;
  readonly signal: AbortSignal;
}): Promise<void> {
  const baseUrl = normalizeCanvasBaseUrl(rawInput.baseUrl);
  const response = await boundedFetch(new URL('/login/oauth2/token', baseUrl), {
    method: 'DELETE',
    headers: { Accept: 'application/json', Authorization: `Bearer ${asciiToken(rawInput.accessToken, 8_192)}` },
  }, rawInput.fetcher, rawInput.signal);
  if (response.body !== null) {
    try { void response.body.cancel().catch(() => undefined); } catch { /* best effort */ }
  }
}

function envelopeFromRow(row: Record<string, unknown>, prefix: string): LearningCredentialEnvelope {
  const ciphertext = databaseBytes(row[`${prefix}ciphertext`], 16, 16_384);
  const nonce = databaseBytes(row[`${prefix}nonce`], 12, 12);
  return Object.freeze({
    ciphertext,
    nonce,
    algorithm: row.algorithm === 'AES-256-GCM' ? 'AES-256-GCM' : invalid(),
    keyVersion: dbInteger(row.key_version),
    envelopeVersion: row.envelope_version === 1 || row.envelope_version === 2
      ? row.envelope_version : invalid(),
    expiresAt: row.expires_at === null ? null : learningValidation.timestamp(row.expires_at),
  });
}

function resultRows(result: unknown): Record<string, unknown>[] {
  if (result === null || typeof result !== 'object' || !Array.isArray((result as { results?: unknown }).results)) invalid();
  return (result as { results: unknown[] }).results.map((row) => learningValidation.dataRecord(row));
}

function uuid(): string {
  const value = crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) invalid();
  return value;
}

function encodeVerifier(codeVerifier: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify({ version: 1, codeVerifier }));
}

function decodeVerifier(value: Uint8Array): string {
  try {
    const row = learningValidation.exactRecord(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as unknown,
      ['version', 'codeVerifier'],
    );
    if (row.version !== 1) invalid();
    const verifier = asciiToken(row.codeVerifier, 128);
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(verifier)) invalid();
    return verifier;
  } catch (error) {
    if (error instanceof LearningCanvasAuthError) throw error;
    return invalid();
  }
}

export interface BegunCanvasOAuthState {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly connectionRevision: number;
}

export async function beginCanvasOAuthState(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly expectedRevision: number;
    readonly actorPersonId: number;
    readonly sessionBinding: string;
    readonly baseUrl: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly nowEpochMs: number;
    readonly randomBytes?: (size: number) => Uint8Array;
  },
): Promise<BegunCanvasOAuthState> {
  const connectionId = dbInteger(rawInput.connectionId);
  const expectedRevision = dbInteger(rawInput.expectedRevision, 0);
  if (expectedRevision >= LEARNING_LIMITS.databaseInteger) invalid();
  const actorPersonId = dbInteger(rawInput.actorPersonId);
  const baseUrl = normalizeCanvasBaseUrl(rawInput.baseUrl);
  const challenge = await createCanvasOAuthAuthorizationRequest({
    baseUrl, clientId: rawInput.clientId, redirectUri: rawInput.redirectUri,
    nowEpochMs: rawInput.nowEpochMs, randomBytes: rawInput.randomBytes,
  });
  const sessionHash = await bindingHash(sessionBinding(rawInput.sessionBinding));
  const verifier = await encryptLearningCredential(rawInput.keyRing, {
    provider: 'canvas', connectionId, plaintext: encodeVerifier(challenge.codeVerifier),
    expiresAt: challenge.expiresAt,
  });
  const marker = uuid();
  const nextRevision = expectedRevision + 1;
  try {
    const results = await db.batch([
      db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=?1,operation_expires_at=?2,revision=revision+1,updated_at=datetime('now')
        WHERE id=?3 AND provider='canvas' AND base_url=?4 AND revision=?5
          AND deleted_at IS NULL AND operation_marker IS NULL`)
        .bind(marker, challenge.expiresAt, connectionId, baseUrl, expectedRevision),
      db.prepare(`INSERT INTO learning_canvas_oauth_states
        (connection_id,state_hash,session_hash,actor_person_id,connection_revision,base_url,redirect_uri,
         verifier_ciphertext,verifier_nonce,algorithm,key_version,envelope_version,expires_at,claim_marker,created_at)
        SELECT id,?1,?2,?3,revision,?4,?5,?6,?7,?8,?9,?10,?11,NULL,datetime('now')
        FROM learning_provider_connections
        WHERE id=?12 AND provider='canvas' AND base_url=?4 AND revision=?13 AND operation_marker=?14
        ON CONFLICT(connection_id) DO UPDATE SET
          state_hash=excluded.state_hash,session_hash=excluded.session_hash,
          actor_person_id=excluded.actor_person_id,connection_revision=excluded.connection_revision,
          base_url=excluded.base_url,redirect_uri=excluded.redirect_uri,
          verifier_ciphertext=excluded.verifier_ciphertext,verifier_nonce=excluded.verifier_nonce,
          algorithm=excluded.algorithm,key_version=excluded.key_version,
          envelope_version=excluded.envelope_version,expires_at=excluded.expires_at,
          claim_marker=NULL,created_at=datetime('now')`)
        .bind(
          challenge.stateHash, sessionHash, actorPersonId, baseUrl, rawInput.redirectUri,
          verifier.ciphertext, verifier.nonce, verifier.algorithm, verifier.keyVersion,
          verifier.envelopeVersion, verifier.expiresAt, connectionId, nextRevision, marker,
        ),
      db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=NULL,operation_expires_at=NULL,updated_at=datetime('now')
        WHERE id=?1 AND provider='canvas' AND base_url=?2 AND revision=?3 AND operation_marker=?4
        RETURNING id AS connection_id,revision`)
        .bind(connectionId, baseUrl, nextRevision, marker),
    ]);
    const rows = resultRows(results[2]);
    if (rows.length !== 1) throw new LearningCanvasAuthConflictError();
    return Object.freeze({
      authorizationUrl: challenge.authorizationUrl,
      state: challenge.state,
      connectionRevision: dbInteger(rows[0].revision),
    });
  } catch (error) {
    if (error instanceof LearningCanvasAuthError || error instanceof LearningCanvasAuthConflictError) throw error;
    throw new LearningCanvasAuthConflictError();
  }
}

export interface ClaimedCanvasOAuthState {
  readonly connectionId: number;
  readonly connectionRevision: number;
  readonly actorPersonId: number;
  readonly baseUrl: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly claimMarker: string;
}

export async function claimCanvasOAuthState(
  db: AppDb,
  rawInput: {
    readonly state: string;
    readonly sessionBinding: string;
    readonly actorPersonId: number;
    readonly baseUrl: string;
    readonly redirectUri: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly nowEpochMs: number;
  },
): Promise<ClaimedCanvasOAuthState> {
  const state = asciiToken(rawInput.state, 128);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(state)) invalid();
  const actorPersonId = dbInteger(rawInput.actorPersonId);
  const baseUrl = normalizeCanvasBaseUrl(rawInput.baseUrl);
  const redirect = redirectUri(rawInput.redirectUri);
  const marker = uuid();
  const result = await db.prepare(`UPDATE learning_canvas_oauth_states SET claim_marker=?1
    WHERE state_hash=?2 AND session_hash=?3 AND actor_person_id=?4 AND base_url=?5 AND redirect_uri=?6
      AND expires_at>?7 AND claim_marker IS NULL
      AND EXISTS (SELECT 1 FROM learning_provider_connections c
        WHERE c.id=learning_canvas_oauth_states.connection_id AND c.provider='canvas'
          AND c.base_url=?5 AND c.revision=learning_canvas_oauth_states.connection_revision
          AND c.operation_marker IS NULL)
    RETURNING connection_id,connection_revision,actor_person_id,base_url,redirect_uri,
      verifier_ciphertext,verifier_nonce,algorithm,key_version,envelope_version,expires_at,claim_marker`)
    .bind(
      marker, await bindingHash(state), await bindingHash(sessionBinding(rawInput.sessionBinding)),
      actorPersonId, baseUrl, redirect, new Date(epoch(rawInput.nowEpochMs)).toISOString(),
    ).run();
  const rows = resultRows(result);
  if (rows.length !== 1) invalid();
  const row = rows[0];
  const connectionId = dbInteger(row.connection_id);
  const plaintext = await decryptLearningCredential(rawInput.keyRing, {
    provider: 'canvas', connectionId, envelope: envelopeFromRow(row, 'verifier_'),
  });
  return Object.freeze({
    connectionId,
    connectionRevision: dbInteger(row.connection_revision),
    actorPersonId: dbInteger(row.actor_person_id),
    baseUrl: normalizeCanvasBaseUrl(row.base_url),
    redirectUri: redirectUri(row.redirect_uri),
    codeVerifier: decodeVerifier(plaintext),
    claimMarker: asciiToken(row.claim_marker, 36),
  });
}

export async function completeCanvasOAuthState(
  db: AppDb,
  rawInput: {
    readonly claim: ClaimedCanvasOAuthState;
    readonly credential: CanvasCredential;
    readonly keyRing: LearningCredentialKeyRing;
    readonly nowEpochMs: number;
  },
): Promise<{ readonly connectionId: number; readonly revision: number; readonly status: 'active' }> {
  epoch(rawInput.nowEpochMs);
  const claim = rawInput.claim;
  const connectionId = dbInteger(claim.connectionId);
  const revision = dbInteger(claim.connectionRevision);
  if (revision >= LEARNING_LIMITS.databaseInteger) invalid();
  const actorPersonId = dbInteger(claim.actorPersonId);
  const baseUrl = normalizeCanvasBaseUrl(claim.baseUrl);
  const redirect = redirectUri(claim.redirectUri);
  const marker = asciiToken(claim.claimMarker, 36);
  const credential = normalizeCredential(rawInput.credential);
  const envelope = await encryptLearningCredential(rawInput.keyRing, {
    provider: 'canvas', connectionId, plaintext: encodeCanvasCredential(credential), expiresAt: null,
  });
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO learning_provider_credentials
        (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at,updated_at)
        SELECT s.connection_id,?1,?2,?3,?4,?5,NULL,datetime('now')
        FROM learning_canvas_oauth_states s JOIN learning_provider_connections c ON c.id=s.connection_id
        WHERE s.connection_id=?6 AND s.connection_revision=?7 AND s.actor_person_id=?8
          AND s.base_url=?9 AND s.redirect_uri=?10 AND s.claim_marker=?11
          AND c.provider='canvas' AND c.base_url=?9 AND c.revision=s.connection_revision
          AND c.operation_marker IS NULL
        ON CONFLICT(connection_id) DO UPDATE SET
          ciphertext=excluded.ciphertext,nonce=excluded.nonce,algorithm=excluded.algorithm,
          key_version=excluded.key_version,envelope_version=excluded.envelope_version,
          expires_at=NULL,updated_at=datetime('now')`)
        .bind(
          envelope.ciphertext, envelope.nonce, envelope.algorithm, envelope.keyVersion,
          envelope.envelopeVersion, connectionId, revision, actorPersonId, baseUrl, redirect, marker,
        ),
      db.prepare(`UPDATE learning_provider_connections SET
        status='active',last_error_code=NULL,deleted_at=NULL,revision=revision+1,
        updated_by_person_id=?1,updated_at=datetime('now')
        WHERE id=?2 AND provider='canvas' AND base_url=?3 AND revision=?4 AND operation_marker IS NULL
          AND EXISTS (SELECT 1 FROM learning_canvas_oauth_states s
            WHERE s.connection_id=?2 AND s.connection_revision=?4 AND s.actor_person_id=?1
              AND s.base_url=?3 AND s.redirect_uri=?5 AND s.claim_marker=?6)
        RETURNING id AS connection_id,revision,status`)
        .bind(actorPersonId, connectionId, baseUrl, revision, redirect, marker),
      db.prepare(`DELETE FROM learning_canvas_oauth_states
        WHERE connection_id=?1 AND connection_revision=?2 AND actor_person_id=?3
          AND base_url=?4 AND redirect_uri=?5 AND claim_marker=?6
          AND EXISTS (SELECT 1 FROM learning_provider_connections c
            WHERE c.id=?1 AND c.provider='canvas' AND c.base_url=?4
              AND c.revision=?7 AND c.status='active')`)
        .bind(connectionId, revision, actorPersonId, baseUrl, redirect, marker, revision + 1),
    ]);
    const rows = resultRows(results[1]);
    if (rows.length !== 1) throw new LearningCanvasAuthConflictError();
    return Object.freeze({
      connectionId: dbInteger(rows[0].connection_id),
      revision: dbInteger(rows[0].revision),
      status: rows[0].status === 'active' ? 'active' : invalid(),
    });
  } catch (error) {
    if (error instanceof LearningCanvasAuthError || error instanceof LearningCanvasAuthConflictError) throw error;
    throw new LearningCanvasAuthConflictError();
  }
}

export async function loadCanvasCredential(
  db: AppDb,
  rawInput: { readonly connectionId: number; readonly keyRing: LearningCredentialKeyRing },
): Promise<{
  readonly connectionId: number;
  readonly revision: number;
  readonly baseUrl: string;
  readonly credential: CanvasCredential;
}> {
  const connectionId = dbInteger(rawInput.connectionId);
  const value = await db.prepare(`SELECT c.id AS connection_id,c.revision,c.base_url,
    p.ciphertext,p.nonce,p.algorithm,p.key_version,p.envelope_version,p.expires_at
    FROM learning_provider_connections c JOIN learning_provider_credentials p ON p.connection_id=c.id
    WHERE c.id=?1 AND c.provider='canvas' AND c.status='active'
      AND c.deleted_at IS NULL AND c.operation_marker IS NULL`).bind(connectionId).first();
  if (value === null) invalid();
  const row = learningValidation.dataRecord(value);
  const envelope = envelopeFromRow(row, '');
  if (envelope.expiresAt !== null) invalid();
  const credential = decodeCanvasCredential(await decryptLearningCredential(rawInput.keyRing, {
    provider: 'canvas', connectionId, envelope,
  }));
  return Object.freeze({
    connectionId,
    revision: dbInteger(row.revision),
    baseUrl: normalizeCanvasBaseUrl(row.base_url),
    credential,
  });
}

export async function rotateCanvasCredential(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly expectedRevision: number;
    readonly credential: CanvasCredential;
    readonly keyRing: LearningCredentialKeyRing;
    readonly nowEpochMs: number;
  },
): Promise<{ readonly connectionId: number; readonly revision: number }> {
  const connectionId = dbInteger(rawInput.connectionId);
  const expectedRevision = dbInteger(rawInput.expectedRevision);
  if (expectedRevision >= LEARNING_LIMITS.databaseInteger) invalid();
  const credential = normalizeCredential(rawInput.credential);
  const envelope = await encryptLearningCredential(rawInput.keyRing, {
    provider: 'canvas', connectionId, plaintext: encodeCanvasCredential(credential), expiresAt: null,
  });
  const marker = uuid();
  const nextRevision = expectedRevision + 1;
  try {
    const results = await db.batch([
      db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=?1,operation_expires_at=?2,revision=revision+1,updated_at=datetime('now')
        WHERE id=?3 AND provider='canvas' AND status='active' AND deleted_at IS NULL
          AND revision=?4 AND operation_marker IS NULL`)
        .bind(marker, new Date(epoch(rawInput.nowEpochMs) + CANVAS_OAUTH_STATE_TTL_MS).toISOString(),
          connectionId, expectedRevision),
      db.prepare(`UPDATE learning_provider_credentials SET
        ciphertext=?1,nonce=?2,algorithm=?3,key_version=?4,envelope_version=?5,
        expires_at=NULL,updated_at=datetime('now')
        WHERE connection_id=?6 AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?6 AND c.provider='canvas' AND c.revision=?7 AND c.operation_marker=?8)`)
        .bind(
          envelope.ciphertext, envelope.nonce, envelope.algorithm, envelope.keyVersion,
          envelope.envelopeVersion, connectionId, nextRevision, marker,
        ),
      db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=NULL,operation_expires_at=NULL,updated_at=datetime('now')
        WHERE id=?1 AND provider='canvas' AND revision=?2 AND operation_marker=?3
        RETURNING id AS connection_id,revision`)
        .bind(connectionId, nextRevision, marker),
    ]);
    const rows = resultRows(results[2]);
    if (rows.length !== 1) throw new LearningCanvasAuthConflictError();
    return Object.freeze({ connectionId: dbInteger(rows[0].connection_id), revision: dbInteger(rows[0].revision) });
  } catch (error) {
    if (error instanceof LearningCanvasAuthError || error instanceof LearningCanvasAuthConflictError) throw error;
    throw new LearningCanvasAuthConflictError();
  }
}
