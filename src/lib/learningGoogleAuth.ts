import type { AppDb, AppDbResult } from './appDb';
import {
  decryptLearningCredential,
  encryptLearningCredential,
  type LearningCredentialEnvelope,
  type LearningCredentialKeyRing,
} from './learningCredentials';
import { LEARNING_LIMITS, learningValidation } from './learningModel';

export const GOOGLE_CLASSROOM_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.students.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  'https://www.googleapis.com/auth/classroom.push-notifications',
  'https://www.googleapis.com/auth/classroom.rosters.readonly',
] as const);

export const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_CALLBACK_PATH = '/admin/learning/google/callback';
const MAX_ACCESS_TOKEN_BYTES = 2_048;
const MAX_REFRESH_TOKEN_BYTES = 512;
const MAX_REFRESH_TOKEN_LIFETIME_SECONDS = 316_224_000;
const MAX_GOOGLE_TOKEN_RESPONSE_BYTES = 65_536;
const GOOGLE_AUTH_HTTP_TIMEOUT_MS = 10_000;
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export class LearningGoogleAuthError extends Error {
  readonly code = 'learning_google_auth_invalid' as const;
  constructor() {
    super('learning_google_auth_invalid');
    this.name = 'LearningGoogleAuthError';
  }
}

export class LearningGoogleAuthConflictError extends Error {
  readonly code = 'learning_google_auth_conflict' as const;
  constructor() {
    super('learning_google_auth_conflict');
    this.name = 'LearningGoogleAuthConflictError';
  }
}

const invalid = (): never => { throw new LearningGoogleAuthError(); };

function plainRecord(value: unknown): Record<string, unknown> {
  try { return learningValidation.dataRecord(value); } catch { return invalid(); }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try { return learningValidation.exactRecord(value, keys); } catch { return invalid(); }
}

function exactOptionalRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const row = plainRecord(value);
  const keys = Object.keys(row);
  if (
    keys.some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(row, key))
  ) invalid();
  return row;
}

function asciiToken(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumBytes
    || !/^[\x21-\x7e]+$/u.test(value)
    || learningValidation.utf8Bytes(value) > maximumBytes
  ) invalid();
  return value as string;
}

function clientId(value: unknown): string {
  const id = asciiToken(value, LEARNING_LIMITS.externalIdBytes);
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/u.test(id)) invalid();
  return id;
}

function redirectUri(value: unknown): string {
  if (typeof value !== 'string' || value.length > LEARNING_LIMITS.urlBytes) invalid();
  const candidate = value as string;
  let url: URL;
  try { url = new URL(candidate); } catch { return invalid(); }
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.pathname !== GOOGLE_CALLBACK_PATH
    || url.search !== ''
    || url.hash !== ''
    || url.hostname.endsWith('.')
    || url.href !== candidate
  ) invalid();
  return candidate;
}

function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function randomSource(value: unknown): (size: number) => Uint8Array {
  if (value === undefined) {
    return (size: number) => crypto.getRandomValues(new Uint8Array(size));
  }
  if (typeof value !== 'function') invalid();
  return value as (size: number) => Uint8Array;
}

function randomBytes(source: (size: number) => Uint8Array, size: number): Uint8Array {
  let value: unknown;
  try { value = source(size); } catch { return invalid(); }
  if (!(value instanceof Uint8Array) || value.byteLength !== size) invalid();
  return (value as Uint8Array).slice();
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.byteLength; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const owned = new Uint8Array(value.byteLength);
  owned.set(value);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', owned));
}

export interface GoogleOAuthAuthorizationRequest {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly stateHash: Uint8Array;
  readonly codeVerifier: string;
  readonly expiresAt: string;
}

export async function createGoogleOAuthAuthorizationRequest(rawInput: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly nowEpochMs: number;
  readonly randomBytes?: (size: number) => Uint8Array;
}): Promise<GoogleOAuthAuthorizationRequest> {
  const input = exactRecord(rawInput, ['clientId', 'redirectUri', 'nowEpochMs', 'randomBytes']);
  const id = clientId(input.clientId);
  const redirect = redirectUri(input.redirectUri);
  const now = epoch(input.nowEpochMs);
  const source = randomSource(input.randomBytes);
  const state = base64Url(randomBytes(source, 32));
  const codeVerifier = base64Url(randomBytes(source, 64));
  if (state.length < 43 || codeVerifier.length < 43 || codeVerifier.length > 128) invalid();
  const stateHash = await sha256(new TextEncoder().encode(state));
  const challenge = base64Url(await sha256(new TextEncoder().encode(codeVerifier)));
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('client_id', id);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('include_granted_scopes', 'false');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_CLASSROOM_SCOPES.join(' '));
  url.searchParams.set('state', state);
  return Object.freeze({
    authorizationUrl: url.toString(),
    state,
    stateHash,
    codeVerifier,
    expiresAt: new Date(now + GOOGLE_OAUTH_STATE_TTL_MS).toISOString(),
  });
}

export interface GoogleCredential {
  readonly version: 1;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string | null;
  readonly grantedScopes: typeof GOOGLE_CLASSROOM_SCOPES;
}

function normalizedScopes(value: unknown): typeof GOOGLE_CLASSROOM_SCOPES {
  if (typeof value !== 'string' || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  const scopes = (value as string).split(' ');
  if (scopes.some((scope) => scope === '') || new Set(scopes).size !== GOOGLE_CLASSROOM_SCOPES.length) invalid();
  const sorted = [...scopes].sort();
  if (
    sorted.length !== GOOGLE_CLASSROOM_SCOPES.length
    || sorted.some((scope, index) => scope !== GOOGLE_CLASSROOM_SCOPES[index])
  ) invalid();
  return GOOGLE_CLASSROOM_SCOPES;
}

function exactTokenResponse(value: unknown): Record<string, unknown> {
  return exactOptionalRecord(value, [
    'access_token', 'expires_in', 'refresh_token', 'refresh_token_expires_in', 'scope', 'token_type',
  ], ['access_token', 'expires_in', 'scope', 'token_type']);
}

export function normalizeGoogleTokenResponse(
  value: unknown,
  rawOptions: {
    readonly nowEpochMs: number;
    readonly requireRefreshToken: boolean;
    readonly retainedRefreshToken: string | null;
    readonly retainedRefreshTokenExpiresAt?: string | null;
  },
): GoogleCredential {
  const options = exactOptionalRecord(rawOptions, [
    'nowEpochMs', 'requireRefreshToken', 'retainedRefreshToken', 'retainedRefreshTokenExpiresAt',
  ], ['nowEpochMs', 'requireRefreshToken', 'retainedRefreshToken']);
  const now = epoch(options.nowEpochMs);
  if (typeof options.requireRefreshToken !== 'boolean') invalid();
  const retained = options.retainedRefreshToken === null
    ? null
    : asciiToken(options.retainedRefreshToken, MAX_REFRESH_TOKEN_BYTES);
  const row = exactTokenResponse(value);
  if (row.token_type !== 'Bearer') invalid();
  if (!Number.isInteger(row.expires_in) || (row.expires_in as number) < 1 || (row.expires_in as number) > 86_400) invalid();
  const returnedRefresh = Object.hasOwn(row, 'refresh_token')
    ? asciiToken(row.refresh_token, MAX_REFRESH_TOKEN_BYTES)
    : null;
  const refreshToken = returnedRefresh ?? retained;
  if (refreshToken === null || (options.requireRefreshToken && returnedRefresh === null)) invalid();
  const safeRefreshToken = refreshToken ?? invalid();
  let retainedRefreshTokenExpiresAt: string | null = null;
  if (options.retainedRefreshTokenExpiresAt !== undefined && options.retainedRefreshTokenExpiresAt !== null) {
    try { retainedRefreshTokenExpiresAt = learningValidation.timestamp(options.retainedRefreshTokenExpiresAt); } catch { return invalid(); }
    if (Date.parse(retainedRefreshTokenExpiresAt) <= now) invalid();
  }
  let returnedRefreshTokenExpiresAt: string | null = null;
  if (Object.hasOwn(row, 'refresh_token_expires_in')) {
    if (
      !Number.isInteger(row.refresh_token_expires_in)
      || (row.refresh_token_expires_in as number) < 1
      || (row.refresh_token_expires_in as number) > MAX_REFRESH_TOKEN_LIFETIME_SECONDS
    ) invalid();
    returnedRefreshTokenExpiresAt = new Date(
      now + (row.refresh_token_expires_in as number) * 1_000,
    ).toISOString();
  }
  return Object.freeze({
    version: 1,
    accessToken: asciiToken(row.access_token, MAX_ACCESS_TOKEN_BYTES),
    refreshToken: safeRefreshToken,
    accessTokenExpiresAt: new Date(now + (row.expires_in as number) * 1_000).toISOString(),
    refreshTokenExpiresAt: returnedRefreshTokenExpiresAt ?? retainedRefreshTokenExpiresAt,
    grantedScopes: normalizedScopes(row.scope),
  });
}

export function encodeGoogleCredential(value: GoogleCredential): Uint8Array {
  const credential = normalizeGoogleCredential(value);
  return new TextEncoder().encode(JSON.stringify(credential));
}

function normalizeGoogleCredential(value: unknown): GoogleCredential {
  const row = exactOptionalRecord(value, [
    'version', 'accessToken', 'refreshToken', 'accessTokenExpiresAt', 'refreshTokenExpiresAt', 'grantedScopes',
  ], ['version', 'accessToken', 'refreshToken', 'accessTokenExpiresAt', 'grantedScopes']);
  if (row.version !== 1 || !Array.isArray(row.grantedScopes)) invalid();
  const scopes = (row.grantedScopes as unknown[]).map((scope) => {
    if (typeof scope !== 'string') invalid();
    return scope;
  });
  normalizedScopes(scopes.join(' '));
  if (scopes.some((scope, index) => scope !== GOOGLE_CLASSROOM_SCOPES[index])) invalid();
  let accessTokenExpiresAt: string;
  try { accessTokenExpiresAt = learningValidation.timestamp(row.accessTokenExpiresAt); } catch { return invalid(); }
  let refreshTokenExpiresAt: string | null = null;
  if (row.refreshTokenExpiresAt !== undefined && row.refreshTokenExpiresAt !== null) {
    try { refreshTokenExpiresAt = learningValidation.timestamp(row.refreshTokenExpiresAt); } catch { return invalid(); }
  }
  return Object.freeze({
    version: 1,
    accessToken: asciiToken(row.accessToken, MAX_ACCESS_TOKEN_BYTES),
    refreshToken: asciiToken(row.refreshToken, MAX_REFRESH_TOKEN_BYTES),
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    grantedScopes: GOOGLE_CLASSROOM_SCOPES,
  });
}

export function decodeGoogleCredential(value: Uint8Array): GoogleCredential {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 8_192) invalid();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
    return normalizeGoogleCredential(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof LearningGoogleAuthError) throw error;
    return invalid();
  }
}

type GoogleAuthFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function authSignal(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal) || value.aborted) invalid();
  return value as AbortSignal;
}

function authFetcher(value: unknown): GoogleAuthFetcher {
  if (typeof value !== 'function') invalid();
  return value as GoogleAuthFetcher;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new LearningGoogleAuthError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = (): void => finish(() => reject(new LearningGoogleAuthError()));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new LearningGoogleAuthError())),
    );
  });
}

async function withAuthDeadline<T>(
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const parent = authSignal(parentSignal);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, GOOGLE_AUTH_HTTP_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
  }
}

function clientSecret(value: unknown): string {
  return asciiToken(value, 512);
}

async function postGoogleAuth(
  url: string,
  body: URLSearchParams,
  fetcher: GoogleAuthFetcher,
  signal: AbortSignal,
): Promise<Response> {
  if (url !== GOOGLE_TOKEN_ENDPOINT && url !== GOOGLE_REVOCATION_ENDPOINT) invalid();
  let response: Response;
  try {
    response = await abortable(Promise.resolve().then(() => fetcher(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    })), signal);
  } catch { return invalid(); }
  if (!(response instanceof Response)) invalid();
  return response;
}

async function boundedGoogleJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.body === null) invalid();
  const body = response.body ?? invalid();
  const rawLength = response.headers.get('Content-Length');
  let expectedLength: number | null = null;
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) invalid();
    expectedLength = Number(rawLength);
    if (!Number.isSafeInteger(expectedLength) || expectedLength > MAX_GOOGLE_TOKEN_RESPONSE_BYTES) {
      try { void body.cancel().catch(() => undefined); } catch { /* best effort */ }
      invalid();
    }
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    if (signal.aborted) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      invalid();
    }
    let part: ReadableStreamReadResult<Uint8Array>;
    try { part = await abortable(reader.read(), signal); } catch {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      return invalid();
    }
    if (part.done) break;
    if (!(part.value instanceof Uint8Array)) invalid();
    length += part.value.byteLength;
    if (length > MAX_GOOGLE_TOKEN_RESPONSE_BYTES) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      invalid();
    }
    chunks.push(part.value);
  }
  if (expectedLength !== null && expectedLength !== length) invalid();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch { return invalid(); }
}

async function boundedGoogleTokenJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) {
    try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
    invalid();
  }
  return boundedGoogleJson(response, signal);
}

export async function exchangeGoogleAuthorizationCode(rawInput: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly fetcher: GoogleAuthFetcher;
  readonly signal: AbortSignal;
  readonly nowEpochMs: number;
}): Promise<GoogleCredential> {
  const input = exactRecord(rawInput, [
    'clientId', 'clientSecret', 'code', 'codeVerifier', 'redirectUri', 'fetcher', 'signal', 'nowEpochMs',
  ]);
  const id = clientId(input.clientId);
  const secret = clientSecret(input.clientSecret);
  const code = asciiToken(input.code, 2_048);
  const verifier = asciiToken(input.codeVerifier, 128);
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(verifier)) invalid();
  const redirect = redirectUri(input.redirectUri);
  const fetcher = authFetcher(input.fetcher);
  const signal = authSignal(input.signal);
  const nowEpochMs = epoch(input.nowEpochMs);
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
  });
  return withAuthDeadline(signal, async (boundedSignal) => {
    const response = await postGoogleAuth(GOOGLE_TOKEN_ENDPOINT, body, fetcher, boundedSignal);
    return normalizeGoogleTokenResponse(await boundedGoogleTokenJson(response, boundedSignal), {
      nowEpochMs, requireRefreshToken: true, retainedRefreshToken: null,
      retainedRefreshTokenExpiresAt: null,
    });
  });
}

export async function refreshGoogleAccessToken(rawInput: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt?: string | null;
  readonly fetcher: GoogleAuthFetcher;
  readonly signal: AbortSignal;
  readonly nowEpochMs: number;
}): Promise<GoogleCredential> {
  const input = exactOptionalRecord(rawInput, [
    'clientId', 'clientSecret', 'refreshToken', 'refreshTokenExpiresAt', 'fetcher', 'signal', 'nowEpochMs',
  ], ['clientId', 'clientSecret', 'refreshToken', 'fetcher', 'signal', 'nowEpochMs']);
  const id = clientId(input.clientId);
  const secret = clientSecret(input.clientSecret);
  const retainedRefreshToken = asciiToken(input.refreshToken, MAX_REFRESH_TOKEN_BYTES);
  const fetcher = authFetcher(input.fetcher);
  const signal = authSignal(input.signal);
  const nowEpochMs = epoch(input.nowEpochMs);
  return withAuthDeadline(signal, async (boundedSignal) => {
    const response = await postGoogleAuth(GOOGLE_TOKEN_ENDPOINT, new URLSearchParams({
      client_id: id,
      client_secret: secret,
      grant_type: 'refresh_token',
      refresh_token: retainedRefreshToken,
    }), fetcher, boundedSignal);
    return normalizeGoogleTokenResponse(await boundedGoogleTokenJson(response, boundedSignal), {
      nowEpochMs, requireRefreshToken: false, retainedRefreshToken,
      retainedRefreshTokenExpiresAt: input.refreshTokenExpiresAt === undefined
        ? null
        : input.refreshTokenExpiresAt as string | null,
    });
  });
}

export async function revokeGoogleRefreshToken(rawInput: {
  readonly refreshToken: string;
  readonly fetcher: GoogleAuthFetcher;
  readonly signal: AbortSignal;
}): Promise<void> {
  const input = exactRecord(rawInput, ['refreshToken', 'fetcher', 'signal']);
  const refreshToken = asciiToken(input.refreshToken, MAX_REFRESH_TOKEN_BYTES);
  const fetcher = authFetcher(input.fetcher);
  const signal = authSignal(input.signal);
  await withAuthDeadline(signal, async (boundedSignal) => {
    const response = await postGoogleAuth(
      GOOGLE_REVOCATION_ENDPOINT, new URLSearchParams({ token: refreshToken }), fetcher, boundedSignal,
    );
    if (response.ok) {
      try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
      return;
    }
    if (response.status !== 400 || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
      try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
      invalid();
    }
    const row = exactOptionalRecord(
      await boundedGoogleJson(response, boundedSignal),
      ['error', 'error_description'], ['error'],
    );
    if (row.error !== 'invalid_token') invalid();
    if (
      row.error_description !== undefined
      && (
        typeof row.error_description !== 'string'
        || row.error_description.length > 1_024
        || learningValidation.utf8Bytes(row.error_description) > 1_024
      )
    ) invalid();
  });
}

function databaseInteger(value: unknown, minimum = 1): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > LEARNING_LIMITS.databaseInteger) {
    invalid();
  }
  return value as number;
}

function sessionBinding(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 4_096
    || !/^[\x20-\x7e]+$/u.test(value)
  ) invalid();
  return value as string;
}

function uuid(): string {
  const value = crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) invalid();
  return value;
}

function resultRows(result: AppDbResult<unknown> | undefined, maximum = 1): Record<string, unknown>[] {
  if (!result || !Array.isArray(result.results) || result.results.length > maximum) invalid();
  const safeResult = result ?? invalid();
  return safeResult.results.map((value) => plainRecord(value));
}

function databaseBytes(value: unknown, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array | null = null;
  if (value instanceof Uint8Array) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    bytes = new Uint8Array(value);
  }
  else invalid();
  const safeBytes = bytes ?? invalid();
  if (safeBytes.byteLength < minimum || safeBytes.byteLength > maximum) invalid();
  const owned = new Uint8Array(safeBytes.byteLength);
  owned.set(safeBytes);
  return owned;
}

function envelopeFromRow(row: Record<string, unknown>, prefix: 'verifier_' | ''): LearningCredentialEnvelope {
  const ciphertext = databaseBytes(row[`${prefix}ciphertext`], 16, 16_384);
  const nonce = databaseBytes(row[`${prefix}nonce`], 12, 12);
  if (row.algorithm !== 'AES-256-GCM') invalid();
  const rawEnvelopeVersion = databaseInteger(row.envelope_version);
  if (rawEnvelopeVersion !== 1 && rawEnvelopeVersion !== 2) invalid();
  const envelopeVersion: 1 | 2 = rawEnvelopeVersion === 1 ? 1 : 2;
  const expiresAt = row.expires_at === null ? null : (() => {
    try { return learningValidation.timestamp(row.expires_at); } catch { return invalid(); }
  })();
  return Object.freeze({
    ciphertext,
    nonce,
    algorithm: 'AES-256-GCM',
    keyVersion: databaseInteger(row.key_version),
    envelopeVersion,
    expiresAt,
  });
}

async function bindingHash(value: string): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await sha256(new TextEncoder().encode(value));
  const owned = new Uint8Array(digest.byteLength);
  owned.set(digest);
  return owned;
}

function encodeVerifier(codeVerifier: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({ version: 1, codeVerifier }));
}

function decodeVerifier(value: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
    const row = exactRecord(JSON.parse(text) as unknown, ['version', 'codeVerifier']);
    if (row.version !== 1) invalid();
    const verifier = asciiToken(row.codeVerifier, 128);
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(verifier)) invalid();
    return verifier;
  } catch (error) {
    if (error instanceof LearningGoogleAuthError) throw error;
    return invalid();
  }
}

export interface BegunGoogleOAuthState {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly connectionRevision: number;
}

export async function beginGoogleOAuthState(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly expectedRevision: number;
    readonly actorPersonId: number;
    readonly sessionBinding: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly nowEpochMs: number;
    readonly randomBytes?: (size: number) => Uint8Array;
  },
): Promise<BegunGoogleOAuthState> {
  const connectionId = databaseInteger(rawInput.connectionId);
  const expectedRevision = databaseInteger(rawInput.expectedRevision, 0);
  if (expectedRevision >= LEARNING_LIMITS.databaseInteger) invalid();
  const actorPersonId = databaseInteger(rawInput.actorPersonId);
  const binding = sessionBinding(rawInput.sessionBinding);
  const now = epoch(rawInput.nowEpochMs);
  const challenge = await createGoogleOAuthAuthorizationRequest({
    clientId: rawInput.clientId,
    redirectUri: rawInput.redirectUri,
    nowEpochMs: now,
    randomBytes: rawInput.randomBytes,
  });
  const sessionHash = await bindingHash(binding);
  const verifierEnvelope = await encryptLearningCredential(rawInput.keyRing, {
    provider: 'google_classroom',
    connectionId,
    plaintext: encodeVerifier(challenge.codeVerifier),
    expiresAt: challenge.expiresAt,
  });
  const marker = uuid();
  const nextRevision = expectedRevision + 1;
  try {
    const results = await db.batch([
      db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=?1,operation_expires_at=?2,revision=revision+1,updated_at=datetime('now')
        WHERE id=?3 AND provider='google_classroom' AND revision=?4
          AND deleted_at IS NULL AND operation_marker IS NULL`)
        .bind(marker, challenge.expiresAt, connectionId, expectedRevision),
      db.prepare(`INSERT INTO learning_google_oauth_states
        (connection_id,state_hash,session_hash,actor_person_id,connection_revision,redirect_uri,
         verifier_ciphertext,verifier_nonce,algorithm,key_version,envelope_version,expires_at,claim_marker,created_at)
        SELECT id,?1,?2,?3,revision,?4,?5,?6,?7,?8,?9,?10,NULL,datetime('now')
        FROM learning_provider_connections
        WHERE id=?11 AND provider='google_classroom' AND revision=?12 AND operation_marker=?13
        ON CONFLICT(connection_id) DO UPDATE SET
          state_hash=excluded.state_hash,session_hash=excluded.session_hash,
          actor_person_id=excluded.actor_person_id,connection_revision=excluded.connection_revision,
          redirect_uri=excluded.redirect_uri,verifier_ciphertext=excluded.verifier_ciphertext,
          verifier_nonce=excluded.verifier_nonce,algorithm=excluded.algorithm,
          key_version=excluded.key_version,envelope_version=excluded.envelope_version,
          expires_at=excluded.expires_at,claim_marker=NULL,created_at=datetime('now')`)
        .bind(
          challenge.stateHash, sessionHash, actorPersonId, rawInput.redirectUri,
          verifierEnvelope.ciphertext, verifierEnvelope.nonce, verifierEnvelope.algorithm,
          verifierEnvelope.keyVersion, verifierEnvelope.envelopeVersion, verifierEnvelope.expiresAt,
          connectionId, nextRevision, marker,
        ),
      db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=NULL,operation_expires_at=NULL,updated_at=datetime('now')
        WHERE id=?1 AND provider='google_classroom' AND revision=?2 AND operation_marker=?3
        RETURNING id AS connection_id,revision`)
        .bind(connectionId, nextRevision, marker),
    ]);
    if (!Array.isArray(results) || results.length !== 3) invalid();
    const rows = resultRows(results[2]);
    if (rows.length !== 1) throw new LearningGoogleAuthConflictError();
    return Object.freeze({
      authorizationUrl: challenge.authorizationUrl,
      state: challenge.state,
      connectionRevision: databaseInteger(rows[0].revision),
    });
  } catch (error) {
    if (error instanceof LearningGoogleAuthConflictError || error instanceof LearningGoogleAuthError) throw error;
    throw new LearningGoogleAuthConflictError();
  }
}

export interface ClaimedGoogleOAuthState {
  readonly connectionId: number;
  readonly connectionRevision: number;
  readonly actorPersonId: number;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly claimMarker: string;
}

export async function claimGoogleOAuthState(
  db: AppDb,
  rawInput: {
    readonly state: string;
    readonly sessionBinding: string;
    readonly actorPersonId: number;
    readonly redirectUri: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly nowEpochMs: number;
  },
): Promise<ClaimedGoogleOAuthState> {
  const state = asciiToken(rawInput.state, 128);
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(state)) invalid();
  const binding = sessionBinding(rawInput.sessionBinding);
  const actorPersonId = databaseInteger(rawInput.actorPersonId);
  const redirect = redirectUri(rawInput.redirectUri);
  const nowIso = new Date(epoch(rawInput.nowEpochMs)).toISOString();
  const stateHash = await bindingHash(state);
  const sessionHash = await bindingHash(binding);
  const marker = uuid();
  let row: Record<string, unknown> | null = null;
  try {
    const result = await db.prepare(`UPDATE learning_google_oauth_states SET claim_marker=?1
      WHERE state_hash=?2 AND session_hash=?3 AND actor_person_id=?4 AND redirect_uri=?5
        AND expires_at>?6 AND claim_marker IS NULL
        AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=learning_google_oauth_states.connection_id
            AND c.provider='google_classroom'
            AND c.revision=learning_google_oauth_states.connection_revision
            AND c.operation_marker IS NULL)
      RETURNING connection_id,connection_revision,actor_person_id,redirect_uri,
        verifier_ciphertext,verifier_nonce,algorithm,key_version,envelope_version,expires_at,claim_marker`)
      .bind(marker, stateHash, sessionHash, actorPersonId, redirect, nowIso).run();
    const rows = resultRows(result);
    row = rows.length === 1 ? rows[0] : null;
  } catch (error) {
    if (error instanceof LearningGoogleAuthError) throw error;
    return invalid();
  }
  if (row === null) invalid();
  const claimedRow = row ?? invalid();
  try {
    const connectionId = databaseInteger(claimedRow.connection_id);
    const plaintext = await decryptLearningCredential(rawInput.keyRing, {
      provider: 'google_classroom',
      connectionId,
      envelope: envelopeFromRow(claimedRow, 'verifier_'),
    });
    return Object.freeze({
      connectionId,
      connectionRevision: databaseInteger(claimedRow.connection_revision),
      actorPersonId: databaseInteger(claimedRow.actor_person_id),
      redirectUri: redirectUri(claimedRow.redirect_uri),
      codeVerifier: decodeVerifier(plaintext),
      claimMarker: asciiToken(claimedRow.claim_marker, 36),
    });
  } catch {
    return invalid();
  }
}

export async function completeGoogleOAuthState(
  db: AppDb,
  rawInput: {
    readonly claim: ClaimedGoogleOAuthState;
    readonly credential: GoogleCredential;
    readonly keyRing: LearningCredentialKeyRing;
    readonly nowEpochMs: number;
  },
): Promise<{ readonly connectionId: number; readonly revision: number; readonly status: 'active' }> {
  epoch(rawInput.nowEpochMs);
  const claim = rawInput.claim;
  const connectionId = databaseInteger(claim.connectionId);
  const revision = databaseInteger(claim.connectionRevision);
  if (revision >= LEARNING_LIMITS.databaseInteger) invalid();
  const actorPersonId = databaseInteger(claim.actorPersonId);
  const marker = asciiToken(claim.claimMarker, 36);
  redirectUri(claim.redirectUri);
  const credential = normalizeGoogleCredential(rawInput.credential);
  const envelope = await encryptLearningCredential(rawInput.keyRing, {
    provider: 'google_classroom', connectionId,
    plaintext: encodeGoogleCredential(credential), expiresAt: credential.refreshTokenExpiresAt,
  });
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO learning_provider_credentials
        (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at,updated_at)
        SELECT s.connection_id,?1,?2,?3,?4,?5,?11,datetime('now')
        FROM learning_google_oauth_states s JOIN learning_provider_connections c ON c.id=s.connection_id
        WHERE s.connection_id=?6 AND s.connection_revision=?7 AND s.actor_person_id=?8
          AND s.redirect_uri=?9 AND s.claim_marker=?10
          AND c.provider='google_classroom' AND c.revision=s.connection_revision
          AND c.operation_marker IS NULL
        ON CONFLICT(connection_id) DO UPDATE SET
          ciphertext=excluded.ciphertext,nonce=excluded.nonce,algorithm=excluded.algorithm,
          key_version=excluded.key_version,envelope_version=excluded.envelope_version,
          expires_at=excluded.expires_at,updated_at=datetime('now')`)
        .bind(
          envelope.ciphertext, envelope.nonce, envelope.algorithm, envelope.keyVersion,
          envelope.envelopeVersion, connectionId, revision, actorPersonId, claim.redirectUri, marker,
          envelope.expiresAt,
        ),
      db.prepare(`UPDATE learning_provider_connections SET
        status='active',last_error_code=NULL,deleted_at=NULL,revision=revision+1,
        updated_by_person_id=?1,updated_at=datetime('now')
        WHERE id=?2 AND provider='google_classroom' AND revision=?3 AND operation_marker IS NULL
          AND EXISTS (SELECT 1 FROM learning_google_oauth_states s
            WHERE s.connection_id=?2 AND s.connection_revision=?3 AND s.actor_person_id=?1
              AND s.redirect_uri=?4 AND s.claim_marker=?5)
        RETURNING id AS connection_id,revision,status`)
        .bind(actorPersonId, connectionId, revision, claim.redirectUri, marker),
      db.prepare(`DELETE FROM learning_google_oauth_states
        WHERE connection_id=?1 AND connection_revision=?2 AND actor_person_id=?3
          AND redirect_uri=?4 AND claim_marker=?5
          AND EXISTS (SELECT 1 FROM learning_provider_connections c
            WHERE c.id=?1 AND c.provider='google_classroom' AND c.revision=?6 AND c.status='active')`)
        .bind(connectionId, revision, actorPersonId, claim.redirectUri, marker, revision + 1),
    ]);
    if (!Array.isArray(results) || results.length !== 3) invalid();
    const rows = resultRows(results[1]);
    if (rows.length !== 1) throw new LearningGoogleAuthConflictError();
    return Object.freeze({
      connectionId: databaseInteger(rows[0].connection_id),
      revision: databaseInteger(rows[0].revision),
      status: rows[0].status === 'active' ? 'active' : invalid(),
    });
  } catch (error) {
    if (error instanceof LearningGoogleAuthConflictError || error instanceof LearningGoogleAuthError) throw error;
    throw new LearningGoogleAuthConflictError();
  }
}

export async function loadGoogleCredential(
  db: AppDb,
  rawInput: { readonly connectionId: number; readonly keyRing: LearningCredentialKeyRing },
): Promise<{ readonly connectionId: number; readonly revision: number; readonly credential: GoogleCredential }> {
  const connectionId = databaseInteger(rawInput.connectionId);
  try {
    const value = await db.prepare(`SELECT c.id AS connection_id,c.revision,
      p.ciphertext,p.nonce,p.algorithm,p.key_version,p.envelope_version,p.expires_at
      FROM learning_provider_connections c JOIN learning_provider_credentials p ON p.connection_id=c.id
      WHERE c.id=?1 AND c.provider='google_classroom' AND c.status='active'
        AND c.deleted_at IS NULL AND c.operation_marker IS NULL`).bind(connectionId).first();
    if (value === null) invalid();
    const row = plainRecord(value);
    const plaintext = await decryptLearningCredential(rawInput.keyRing, {
      provider: 'google_classroom', connectionId, envelope: envelopeFromRow(row, ''),
    });
    const credential = decodeGoogleCredential(plaintext);
    const envelope = envelopeFromRow(row, '');
    if (credential.refreshTokenExpiresAt !== envelope.expiresAt) invalid();
    return Object.freeze({
      connectionId,
      revision: databaseInteger(row.revision),
      credential,
    });
  } catch (error) {
    if (error instanceof LearningGoogleAuthError) throw error;
    return invalid();
  }
}

export async function loadGoogleCredentialForAdmin(
  db: AppDb,
  rawInput: { readonly connectionId: number; readonly keyRing: LearningCredentialKeyRing },
): Promise<{
  readonly connectionId: number;
  readonly revision: number;
  readonly status: 'active' | 'error';
  readonly credential: GoogleCredential;
}> {
  const connectionId = databaseInteger(rawInput.connectionId);
  try {
    const value = await db.prepare(`SELECT c.id AS connection_id,c.revision,c.status,
      p.ciphertext,p.nonce,p.algorithm,p.key_version,p.envelope_version,p.expires_at
      FROM learning_provider_connections c JOIN learning_provider_credentials p ON p.connection_id=c.id
      WHERE c.id=?1 AND c.provider='google_classroom' AND c.status IN ('active','error')
        AND c.deleted_at IS NULL AND c.operation_marker IS NULL`).bind(connectionId).first();
    if (value === null) invalid();
    const row = plainRecord(value);
    const plaintext = await decryptLearningCredential(rawInput.keyRing, {
      provider: 'google_classroom', connectionId, envelope: envelopeFromRow(row, ''),
    });
    const credential = decodeGoogleCredential(plaintext);
    const envelope = envelopeFromRow(row, '');
    if (credential.refreshTokenExpiresAt !== envelope.expiresAt) invalid();
    const status = learningValidation.oneOf(row.status, ['active', 'error'] as const);
    return Object.freeze({
      connectionId,
      revision: databaseInteger(row.revision),
      status,
      credential,
    });
  } catch (error) {
    if (error instanceof LearningGoogleAuthError) throw error;
    return invalid();
  }
}

export async function loadGoogleCredentialForCleanup(
  db: AppDb,
  rawInput: { readonly connectionId: number; readonly keyRing: LearningCredentialKeyRing },
): Promise<{
  readonly connectionId: number;
  readonly revision: number;
  readonly status: 'active' | 'error' | 'disabled';
  readonly credential: GoogleCredential;
}> {
  const connectionId = databaseInteger(rawInput.connectionId);
  try {
    const value = await db.prepare(`SELECT c.id AS connection_id,c.revision,c.status,
      p.ciphertext,p.nonce,p.algorithm,p.key_version,p.envelope_version,p.expires_at
      FROM learning_provider_connections c JOIN learning_provider_credentials p ON p.connection_id=c.id
      WHERE c.id=?1 AND c.provider='google_classroom' AND c.status IN ('active','error','disabled')
        AND c.operation_marker IS NULL`).bind(connectionId).first();
    if (value === null) invalid();
    const row = plainRecord(value);
    const plaintext = await decryptLearningCredential(rawInput.keyRing, {
      provider: 'google_classroom', connectionId, envelope: envelopeFromRow(row, ''),
    });
    const credential = decodeGoogleCredential(plaintext);
    const envelope = envelopeFromRow(row, '');
    if (credential.refreshTokenExpiresAt !== envelope.expiresAt) invalid();
    const status = learningValidation.oneOf(row.status, ['active', 'error', 'disabled'] as const);
    return Object.freeze({ connectionId, revision: databaseInteger(row.revision), status, credential });
  } catch (error) {
    if (error instanceof LearningGoogleAuthError) throw error;
    return invalid();
  }
}

interface GoogleCredentialRotationInput {
  readonly connectionId: number;
  readonly expectedRevision: number;
  readonly credential: GoogleCredential;
  readonly keyRing: LearningCredentialKeyRing;
  readonly nowEpochMs: number;
}

async function rotateGoogleCredentialForStatuses(
  db: AppDb,
  rawInput: GoogleCredentialRotationInput,
  includeError: boolean,
): Promise<{ readonly connectionId: number; readonly revision: number }> {
  const connectionId = databaseInteger(rawInput.connectionId);
  const expectedRevision = databaseInteger(rawInput.expectedRevision);
  if (expectedRevision >= LEARNING_LIMITS.databaseInteger) invalid();
  epoch(rawInput.nowEpochMs);
  const credential = normalizeGoogleCredential(rawInput.credential);
  const envelope = await encryptLearningCredential(rawInput.keyRing, {
    provider: 'google_classroom', connectionId,
    plaintext: encodeGoogleCredential(credential), expiresAt: credential.refreshTokenExpiresAt,
  });
  const marker = uuid();
  const nextRevision = expectedRevision + 1;
  try {
    const claim = includeError
      ? db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=?1,operation_expires_at=?2,revision=revision+1,updated_at=datetime('now')
        WHERE id=?3 AND provider='google_classroom' AND status IN ('active','error')
          AND deleted_at IS NULL AND revision=?4 AND operation_marker IS NULL`)
      : db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=?1,operation_expires_at=?2,revision=revision+1,updated_at=datetime('now')
        WHERE id=?3 AND provider='google_classroom' AND status='active'
          AND deleted_at IS NULL AND revision=?4 AND operation_marker IS NULL`);
    const results = await db.batch([
      claim.bind(
        marker, new Date(rawInput.nowEpochMs + GOOGLE_OAUTH_STATE_TTL_MS).toISOString(),
        connectionId, expectedRevision,
      ),
      db.prepare(`UPDATE learning_provider_credentials SET
        ciphertext=?1,nonce=?2,algorithm=?3,key_version=?4,envelope_version=?5,
        expires_at=?9,updated_at=datetime('now')
        WHERE connection_id=?6 AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?6 AND c.provider='google_classroom' AND c.revision=?7 AND c.operation_marker=?8)`)
        .bind(
          envelope.ciphertext, envelope.nonce, envelope.algorithm, envelope.keyVersion,
          envelope.envelopeVersion, connectionId, nextRevision, marker, envelope.expiresAt,
        ),
      db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=NULL,operation_expires_at=NULL,updated_at=datetime('now')
        WHERE id=?1 AND provider='google_classroom' AND revision=?2 AND operation_marker=?3
        RETURNING id AS connection_id,revision`)
        .bind(connectionId, nextRevision, marker),
    ]);
    if (!Array.isArray(results) || results.length !== 3) invalid();
    const rows = resultRows(results[2]);
    if (rows.length !== 1) throw new LearningGoogleAuthConflictError();
    return Object.freeze({
      connectionId: databaseInteger(rows[0].connection_id),
      revision: databaseInteger(rows[0].revision),
    });
  } catch (error) {
    if (error instanceof LearningGoogleAuthConflictError || error instanceof LearningGoogleAuthError) throw error;
    throw new LearningGoogleAuthConflictError();
  }
}

export async function rotateGoogleCredential(
  db: AppDb,
  rawInput: GoogleCredentialRotationInput,
): Promise<{ readonly connectionId: number; readonly revision: number }> {
  return rotateGoogleCredentialForStatuses(db, rawInput, false);
}

export async function rotateGoogleCredentialForActiveOrError(
  db: AppDb,
  rawInput: GoogleCredentialRotationInput,
): Promise<{ readonly connectionId: number; readonly revision: number }> {
  return rotateGoogleCredentialForStatuses(db, rawInput, true);
}
