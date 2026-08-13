import type { AppDb } from './appDb';
import type { DbBackend } from './dbProvider';
import { normalizeNewcomerEmail, normalizeNewcomerPhone } from './newcomerValidation';

export const NEWCOMER_FORM_MAX_BYTES = 48 * 1024;

export type NewcomerFormReadResult =
  | { ok: true; fields: Record<string, string> }
  | { ok: false; reason: 'unsupported_media_type' | 'too_large' | 'invalid' };

function declaredTooLarge(request: Request): boolean {
  const raw = request.headers.get('content-length');
  if (raw === null) return false;
  if (!/^\d+$/.test(raw)) return true;
  const length = Number(raw);
  return !Number.isSafeInteger(length) || length > NEWCOMER_FORM_MAX_BYTES;
}

async function boundedBytes(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > NEWCOMER_FORM_MAX_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readNewcomerUrlencodedForm(
  request: Request,
  allowedKeys: readonly string[],
): Promise<NewcomerFormReadResult> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8\s*)?$/i.test(contentType)) {
    return { ok: false, reason: 'unsupported_media_type' };
  }
  if (declaredTooLarge(request)) return { ok: false, reason: 'too_large' };
  let bytes: Uint8Array | null;
  try { bytes = await boundedBytes(request); } catch { return { ok: false, reason: 'invalid' }; }
  if (bytes === null) return { ok: false, reason: 'too_large' };
  let encoded: string;
  try { encoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { ok: false, reason: 'invalid' }; }
  if (/%(?![0-9a-f]{2})/i.test(encoded)) return { ok: false, reason: 'invalid' };
  const allowed = new Set(allowedKeys);
  if (allowed.size !== allowedKeys.length) return { ok: false, reason: 'invalid' };
  const fields: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(encoded)) {
    if (!allowed.has(name) || Object.hasOwn(fields, name)) return { ok: false, reason: 'invalid' };
    fields[name] = value;
  }
  return { ok: true, fields };
}

export interface NewcomerRateLimitInput {
  backend: DbBackend;
  secret: string | undefined;
  email: string | null;
  phone: string | null;
  cfConnectingIp: string | null;
  now?: string;
}

export type NewcomerRateLimitResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'limited' };

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function keyedHash(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function clockParts(value: string | undefined): { window: string; expires: string; now: string } | null {
  const date = value === undefined ? new Date() : new Date(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(date.getTime())) return null;
  const now = date.toISOString().slice(0, 19).replace('T', ' ');
  if (value !== undefined && now !== value) return null;
  date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 10) * 10, 0, 0);
  const window = date.toISOString().slice(0, 19).replace('T', ' ');
  date.setUTCHours(date.getUTCHours() + 48);
  return { window, expires: date.toISOString().slice(0, 19).replace('T', ' '), now };
}

function ipBucket(value: string | null): { value: string; maximum: number } {
  if (value === null) return { value: 'unknown', maximum: 5 };
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 64 || /[^0-9a-f:.]/.test(normalized)) {
    return { value: 'unknown', maximum: 5 };
  }
  return { value: normalized, maximum: 20 };
}

function rateStatement(db: AppDb) {
  return db.prepare(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
    VALUES (?1,?2,1,?3)
    ON CONFLICT(bucket_hash,window_start) DO UPDATE SET attempts=newcomer_rate_limits.attempts+1
    RETURNING attempts`);
}

function returnedAttempts(result: unknown): number | null {
  try {
    if (!result || typeof result !== 'object') return null;
    const rows = (result as { results?: unknown }).results;
    if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') return null;
    const value = (rows[0] as { attempts?: unknown }).attempts;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

export async function consumeNewcomerPublicRateLimit(
  db: AppDb,
  input: NewcomerRateLimitInput,
): Promise<NewcomerRateLimitResult> {
  if ((input.backend !== 'd1' && input.backend !== 'supabase')
    || typeof input.secret !== 'string' || input.secret.length < 16 || input.secret.length > 1024) {
    return { ok: false, reason: 'unavailable' };
  }
  const clock = clockParts(input.now);
  if (!clock) return { ok: false, reason: 'unavailable' };
  const email = input.email === null ? null : normalizeNewcomerEmail(input.email);
  const phone = input.phone === null ? null : normalizeNewcomerPhone(input.phone);
  if ((email && !email.ok) || (phone && !phone.ok) || (!email && !phone)) {
    return { ok: false, reason: 'limited' };
  }
  const contact = email?.ok ? `email:${email.value}` : `phone:${phone!.value}`;
  const ip = ipBucket(input.cfConnectingIp);
  try {
    const [contactHash, ipHash] = await Promise.all([
      keyedHash(input.secret, `contact\0${contact}`),
      keyedHash(input.secret, `ip\0${ip.value}`),
    ]);
    const results = await db.batch([
      db.prepare('DELETE FROM newcomer_rate_limits WHERE expires_at<=?').bind(clock.now),
      rateStatement(db).bind(contactHash, clock.window, clock.expires),
      rateStatement(db).bind(ipHash, clock.window, clock.expires),
    ]);
    if (!Array.isArray(results) || results.length !== 3) return { ok: false, reason: 'unavailable' };
    const contactAttempts = returnedAttempts(results[1]);
    const ipAttempts = returnedAttempts(results[2]);
    if (contactAttempts === null || ipAttempts === null) return { ok: false, reason: 'unavailable' };
    return contactAttempts <= 5 && ipAttempts <= ip.maximum
      ? { ok: true }
      : { ok: false, reason: 'limited' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
