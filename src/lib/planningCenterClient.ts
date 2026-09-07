import { sha256Utf8 } from './stripeWebhookInbox';
export { sha256Utf8 };

const OFFICIAL_HOST = 'api.planningcenteronline.com';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_ROWS = 1_000;
const MAX_INCLUDED_ROWS = 5_000;
const MAX_LINKS = 32;
const HEX = /^[0-9a-f]{64}$/u;
const APPROVED_PATHS = new Set(['/people/v2', '/people/v2/people', '/people/v2/person_mergers']);
const EXACT_PERSON_PATH = /^\/people\/v2\/people\/([0-9]{1,32})$/u;

export class PlanningCenterBadResponseError extends Error { constructor(message = 'planning_center_bad_response') { super(message); this.name = 'PlanningCenterBadResponseError'; } }
export class PlanningCenterNotFoundError extends Error { constructor() { super('planning_center_not_found'); this.name = 'PlanningCenterNotFoundError'; } }
export class PlanningCenterRateLimitError extends Error {
  readonly retryAt: number | null;
  constructor(retryAt: number | null) { super('planning_center_rate_limited'); this.name = 'PlanningCenterRateLimitError'; this.retryAt = retryAt; }
}

export type PlanningCenterPage = Readonly<{
  data: ReadonlyArray<{ type: string; id: string; attributes: Record<string, unknown>; relationships?: Record<string, unknown> }>;
  included: ReadonlyArray<{ type: string; id: string; attributes: Record<string, unknown>; relationships?: Record<string, unknown> }>;
  links: Record<string, unknown>;
  rate: { limit: number | null; count: number | null; remaining: number | null; periodSeconds: number | null; resetAt: number | null };
}>;

export type PlanningCenterWebhookEnvelope = Readonly<{ deliveryId: string; eventType: string; attempt: number; organizationId: string; providerPersonId: string | null }>;

/** Parse only the opaque EventDelivery metadata; never return or retain its payload. */
export function parsePlanningCenterWebhookEnvelope(body: string, maxBytes = 256 * 1024): PlanningCenterWebhookEnvelope {
  if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > maxBytes) throw new Error('planning_center_webhook_too_large');
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error('planning_center_webhook_json_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('planning_center_webhook_shape_invalid');
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== 'object' || Array.isArray(data[0])) throw new Error('planning_center_webhook_shape_invalid');
  const row = data[0] as { type?: unknown; id?: unknown; attributes?: unknown };
  const attributes = row.attributes;
  if (row.type !== 'EventDelivery' || typeof row.id !== 'string' || !/^[\x21-\x7e]{1,256}$/u.test(row.id)
    || !attributes || typeof attributes !== 'object' || Array.isArray(attributes)) throw new Error('planning_center_webhook_shape_invalid');
  const eventType = (attributes as { name?: unknown }).name;
  const attempt = (attributes as { attempt?: unknown }).attempt;
  const organizationId = ((row as { relationships?: unknown }).relationships as { organization?: { data?: { id?: unknown } } } | undefined)?.organization?.data?.id;
  let providerPersonId: string | null = null;
  const payload = (attributes as { payload?: unknown }).payload;
  if (typeof payload === 'string' && new TextEncoder().encode(payload).byteLength <= 128 * 1024) {
    try {
      const parsed = JSON.parse(payload) as { data?: unknown };
      const person = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data as { type?: unknown; id?: unknown } : null;
      if (person?.type === 'Person' && typeof person.id === 'string' && /^[0-9]{1,32}$/u.test(person.id)) providerPersonId = person.id;
    } catch { /* authoritative sync will handle a malformed provider payload */ }
  }
  if (typeof eventType !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(eventType)
    || !Number.isSafeInteger(attempt) || (attempt as number) < 1 || (attempt as number) > 2_147_483_647
    || typeof organizationId !== 'string' || !/^[0-9]{1,32}$/u.test(organizationId)) throw new Error('planning_center_webhook_shape_invalid');
  return Object.freeze({ deliveryId: row.id, eventType, attempt: attempt as number, organizationId, providerPersonId });
}

function validUserAgent(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256 && !/[\0-\x1f\x7f]/u.test(value)
    && /^.{2,120} (?:<(?:https?:\/\/[^ <>]{1,120}|mailto:[^ <>]{3,120})>|\((?:https?:\/\/[^ <>]{1,120}|[^ ()<>@]{1,64}@[^ ()<>]{1,120})\))$/u.test(value);
}

function approvedPath(pathname: string): boolean {
  return APPROVED_PATHS.has(pathname) || EXACT_PERSON_PATH.test(pathname);
}

export async function fetchPlanningCenterOrganization(input: {
  baseUrl: string; clientId: string; secret: string; userAgent: string; fetcher?: typeof fetch;
}): Promise<{ id: string }> {
  const base = validatePlanningCenterBaseUrl(input.baseUrl);
  if (typeof input.clientId !== 'string' || input.clientId.length < 1 || /[\s\0-\x1f\x7f]/u.test(input.clientId)) throw new Error('planning_center_client_id_invalid');
  if (typeof input.secret !== 'string' || input.secret.length < 8 || /[\s\0-\x1f\x7f]/u.test(input.secret)) throw new Error('planning_center_secret_invalid');
  if (!validUserAgent(input.userAgent)) throw new Error('planning_center_user_agent_invalid');
  const fetcher = input.fetcher ?? fetch;
  const auth = btoa(`${input.clientId}:${input.secret}`);
  const response = await fetcher(new URL('/people/v2', `${base}/`), { method: 'GET', headers: { accept: 'application/vnd.api+json', authorization: `Basic ${auth}`, 'user-agent': input.userAgent } });
  if (response.status === 429) throw new PlanningCenterRateLimitError(retryAfter(response.headers));
  if (response.status === 404) throw new PlanningCenterNotFoundError();
  if (!response.ok) throw new PlanningCenterBadResponseError(`planning_center_http_${response.status}`);
  let value: unknown;
  try { value = JSON.parse(await boundedText(response, DEFAULT_MAX_BYTES)); } catch { throw new PlanningCenterBadResponseError('planning_center_json_invalid'); }
  const data = value && typeof value === 'object' && !Array.isArray(value) ? (value as { data?: unknown }).data : null;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PlanningCenterBadResponseError('planning_center_organization_shape_invalid');
  const row = data as { type?: unknown; id?: unknown; attributes?: unknown };
  if (row.type !== 'Organization' || typeof row.id !== 'string' || !/^[0-9]{1,32}$/u.test(row.id) || !row.attributes || typeof row.attributes !== 'object' || Array.isArray(row.attributes)) throw new PlanningCenterBadResponseError('planning_center_organization_shape_invalid');
  return { id: row.id };
}

export function validatePlanningCenterBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('planning_center_url_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== OFFICIAL_HOST || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('planning_center_url_invalid');
  }
  return `https://${OFFICIAL_HOST}`;
}

export function nextPlanningCenterUrl(baseUrl: string, links: Record<string, unknown>): string | null {
  const next = links.next;
  if (next === null || next === undefined) return null;
  if (typeof next !== 'string') throw new Error('planning_center_next_invalid');
  const base = validatePlanningCenterBaseUrl(baseUrl);
  let parsed: URL;
  try { parsed = new URL(next, `${base}/`); } catch { throw new Error('planning_center_next_invalid'); }
  if (parsed.origin !== base || parsed.protocol !== 'https:' || parsed.hostname !== OFFICIAL_HOST || parsed.username || parsed.password || !approvedPath(parsed.pathname)) throw new Error('planning_center_next_invalid');
  return parsed.toString();
}

function retryAfter(headers: Headers, now = Date.now()): number | null {
  const retry = headers.get('retry-after');
  if (retry) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds) && seconds >= 0) return now + Math.min(seconds, 86_400) * 1000;
    const date = Date.parse(retry);
    if (Number.isFinite(date)) return Math.max(now, date);
  }
  return null;
}

function remaining(headers: Headers): number | null {
  const limit = Number(headers.get('x-pco-api-request-rate-limit'));
  const count = Number(headers.get('x-pco-api-request-rate-count'));
  return Number.isSafeInteger(limit) && limit >= 0 && Number.isSafeInteger(count) && count >= 0 && count <= limit ? limit - count : null;
}

function rateValue(headers: Headers, name: string): number | null {
  const value = Number(headers.get(name));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function ratePeriodSeconds(headers: Headers): number | null {
  const raw = headers.get('x-pco-api-request-rate-period')?.trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (/^\d+$/u.test(raw) && Number.isSafeInteger(numeric) && numeric >= 0) return numeric;
  const match = /^(\d+)\s+(second|seconds|minute|minutes|hour|hours)$/iu.exec(raw);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = /^hour/i.test(match[2]) ? 3600 : /^minute/i.test(match[2]) ? 60 : 1;
  const seconds = amount * multiplier;
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new PlanningCenterBadResponseError('planning_center_response_too_large');
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new PlanningCenterBadResponseError('planning_center_response_too_large');
    return text;
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new PlanningCenterBadResponseError('planning_center_response_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function parsePage(value: unknown, headers: Headers, expectedSingletonId: string | null): PlanningCenterPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlanningCenterBadResponseError();
  const data = (value as { data?: unknown }).data; const links = (value as { links?: unknown }).links ?? {};
  const included = (value as { included?: unknown }).included ?? [];
  const rows = expectedSingletonId === null
    ? (Array.isArray(data) ? data : null)
    : (!Array.isArray(data) && data && typeof data === 'object' ? [data] : null);
  if (!rows || rows.length > MAX_PAGE_ROWS || !Array.isArray(included) || included.length > MAX_INCLUDED_ROWS
    || !links || typeof links !== 'object' || Array.isArray(links)) throw new PlanningCenterBadResponseError();
  const linkEntries = Object.entries(links as Record<string, unknown>);
  if (linkEntries.length > MAX_LINKS || linkEntries.some(([key, item]) => !/^[A-Za-z0-9_.:-]{1,64}$/u.test(key)
    || (item !== null && (typeof item !== 'string' || new TextEncoder().encode(item).byteLength > 2_048)))) throw new PlanningCenterBadResponseError();
  const normalizeRow = (item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new PlanningCenterBadResponseError();
    const row = item as { type?: unknown; id?: unknown; attributes?: unknown; relationships?: unknown };
    if (typeof row.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(row.type)
      || typeof row.id !== 'string' || !/^[\x21-\x7e]{1,256}$/u.test(row.id)
      || !row.attributes || typeof row.attributes !== 'object' || Array.isArray(row.attributes)
      || (row.relationships !== undefined && (!row.relationships || typeof row.relationships !== 'object' || Array.isArray(row.relationships)))) throw new PlanningCenterBadResponseError();
    return { type: row.type, id: row.id, attributes: row.attributes as Record<string, unknown>, relationships: row.relationships as Record<string, unknown> | undefined };
  };
  const normalized = rows.map(normalizeRow);
  if (expectedSingletonId !== null && (normalized.length !== 1 || normalized[0].type !== 'Person' || normalized[0].id !== expectedSingletonId)) {
    throw new PlanningCenterBadResponseError();
  }
  const normalizedIncluded = included.map(normalizeRow);
  const limit = rateValue(headers, 'x-pco-api-request-rate-limit');
  const count = rateValue(headers, 'x-pco-api-request-rate-count');
  const periodSeconds = ratePeriodSeconds(headers);
  return { data: normalized, included: normalizedIncluded, links: Object.fromEntries(linkEntries), rate: { limit, count, remaining: remaining(headers), periodSeconds, resetAt: retryAfter(headers) } };
}

export async function fetchPlanningCenterPage(input: {
  baseUrl: string; path: string; clientId: string; secret: string; userAgent: string; apiVersion?: string; fetcher?: typeof fetch; maxBytes?: number;
}): Promise<PlanningCenterPage> {
  const base = validatePlanningCenterBaseUrl(input.baseUrl);
  if (typeof input.clientId !== 'string' || input.clientId.length < 1 || input.clientId.length > 512 || /[\s\0-\x1f\x7f]/u.test(input.clientId)) throw new Error('planning_center_client_id_invalid');
  if (typeof input.secret !== 'string' || input.secret.length < 8 || input.secret.length > 4096 || /[\s\0-\x1f\x7f]/u.test(input.secret)) throw new Error('planning_center_secret_invalid');
  if (!validUserAgent(input.userAgent)) throw new Error('planning_center_user_agent_invalid');
  if (input.apiVersion !== undefined && (typeof input.apiVersion !== 'string' || !/^(?:LATEST|\d{4}-\d{2}-\d{2})$/u.test(input.apiVersion))) throw new Error('planning_center_api_version_invalid');
  let url: URL;
  try { url = new URL(input.path, `${base}/`); } catch { throw new Error('planning_center_path_invalid'); }
  if (url.origin !== base || url.protocol !== 'https:' || url.hostname !== OFFICIAL_HOST || url.username || url.password || !approvedPath(url.pathname)) throw new Error('planning_center_path_invalid');
  const fetcher = input.fetcher ?? fetch;
  const auth = btoa(`${input.clientId}:${input.secret}`);
  const headers: Record<string, string> = { accept: 'application/vnd.api+json', authorization: `Basic ${auth}`, 'user-agent': input.userAgent };
  if (input.apiVersion) headers['x-pco-api-version'] = input.apiVersion;
  const response = await fetcher(url, { method: 'GET', headers });
  if (response.status === 429) throw new PlanningCenterRateLimitError(retryAfter(response.headers));
  if (response.status === 404) throw new PlanningCenterNotFoundError();
  if (!response.ok) throw new PlanningCenterBadResponseError(`planning_center_http_${response.status}`);
  const body = await boundedText(response, input.maxBytes ?? DEFAULT_MAX_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new PlanningCenterBadResponseError('planning_center_json_invalid'); }
  return parsePage(parsed, response.headers, EXACT_PERSON_PATH.exec(url.pathname)?.[1] ?? null);
}

function same(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right); let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function verifyPlanningCenterWebhook(signatureHeader: string, body: string, secret: string): Promise<{ ok: boolean; eventDigest: string | null }> {
  // Planning Center signs the raw body in X-PCO-Webhooks-Authenticity; it does
  // not send a timestamp signature header. Replay protection is enforced by
  // the delivery id/attempt receipt and local received_at policy.
  const match = /^([0-9a-f]{64})$/u.exec(signatureHeader.trim());
  if (!match || typeof secret !== 'string' || secret.length < 16) return { ok: false, eventDigest: null };
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!same(match[1], expected)) return { ok: false, eventDigest: null };
  return { ok: true, eventDigest: await sha256Utf8(body) };
}
