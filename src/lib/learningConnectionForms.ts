import {
  LEARNING_LIMITS,
  normalizeCanvasBaseUrl,
  type LearningConnectionStatus,
  type LearningProviderKind,
} from './learningModel';

export const LEARNING_CONNECTION_FORM_MAX_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const FORM_FIELD_NAMES = new Set([
  'action', 'provider', 'display_name', 'base_url',
  'connection_id', 'revision', 'status',
]);

export type LearningConnectionFormData =
  | {
      readonly action: 'create';
      readonly provider: 'canvas';
      readonly displayName: string;
      readonly baseUrl: string;
    }
  | {
      readonly action: 'create';
      readonly provider: 'google_classroom';
      readonly displayName: string;
      readonly baseUrl: null;
    }
  | {
      readonly action: 'update';
      readonly connectionId: number;
      readonly revision: number;
      readonly provider: LearningProviderKind;
      readonly displayName: string;
    }
  | {
      readonly action: 'health_check';
      readonly connectionId: number;
      readonly revision: number;
      readonly provider: LearningProviderKind;
      readonly status: LearningConnectionStatus;
    }
  | {
      readonly action: 'disconnect';
      readonly connectionId: number;
      readonly revision: number;
    };

export type LearningConnectionFormParseResult =
  | { readonly ok: true; readonly data: LearningConnectionFormData }
  | { readonly ok: false; readonly code: 'learning_connection_invalid' };

export type LearningConnectionFormReadResult =
  | { readonly ok: true; readonly fields: Record<string, string> }
  | { readonly ok: false; readonly reason: 'unsupported_media_type' | 'too_large' | 'invalid' };

const invalid = (): LearningConnectionFormParseResult => ({ ok: false, code: 'learning_connection_invalid' });

function exactKeys(fields: Readonly<Record<string, string | undefined>>, expected: readonly string[]): boolean {
  const actual = Object.keys(fields).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function integer(value: string, minimum: number): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= LEARNING_LIMITS.databaseInteger
    ? parsed : null;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function boundedExactString(value: string, maximum: number): string | null {
  if (
    value.trim() !== value
    || encoder.encode(value).byteLength < 1
    || encoder.encode(value).byteLength > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
    || !hasWellFormedUnicode(value)
  ) return null;
  return value;
}

function displayName(value: string): string | null {
  return boundedExactString(value, LEARNING_LIMITS.connectionDisplayNameBytes);
}

function provider(value: string): LearningProviderKind | null {
  return value === 'canvas' || value === 'google_classroom' ? value : null;
}

function connectionStatus(value: string): LearningConnectionStatus | null {
  return value === 'pending' || value === 'active' || value === 'error' || value === 'disabled'
    ? value : null;
}

function canvasBaseUrl(value: string): string | null {
  try { return normalizeCanvasBaseUrl(value); } catch { return null; }
}

export function parseLearningConnectionForm(
  fields: Readonly<Record<string, string | undefined>>,
): LearningConnectionFormParseResult {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return invalid();
  const proto = Object.getPrototypeOf(fields);
  if (proto !== Object.prototype && proto !== null) return invalid();
  const action = fields.action;

  if (action === 'create') {
    const kind = provider(fields.provider ?? '');
    const name = displayName(fields.display_name ?? '');
    if (!kind || !name) return invalid();
    if (kind === 'google_classroom') {
      if (!exactKeys(fields, ['action', 'provider', 'display_name'])) return invalid();
      return { ok: true, data: { action, provider: kind, displayName: name, baseUrl: null } };
    }
    if (!exactKeys(fields, ['action', 'provider', 'display_name', 'base_url'])) return invalid();
    const baseUrl = canvasBaseUrl(fields.base_url ?? '');
    return baseUrl
      ? { ok: true, data: { action, provider: kind, displayName: name, baseUrl } }
      : invalid();
  }

  if (action === 'update') {
    if (!exactKeys(fields, ['action', 'connection_id', 'revision', 'provider', 'display_name'])) return invalid();
    const connectionId = integer(fields.connection_id ?? '', 1);
    const revision = integer(fields.revision ?? '', 0);
    const kind = provider(fields.provider ?? '');
    const name = displayName(fields.display_name ?? '');
    if (connectionId === null || revision === null || !kind || !name) return invalid();
    return { ok: true, data: {
      action, connectionId, revision, provider: kind, displayName: name,
    } };
  }

  if (action === 'health_check') {
    if (!exactKeys(fields, ['action', 'connection_id', 'revision', 'provider', 'status'])) return invalid();
    const connectionId = integer(fields.connection_id ?? '', 1);
    const revision = integer(fields.revision ?? '', 0);
    const kind = provider(fields.provider ?? '');
    const status = connectionStatus(fields.status ?? '');
    return connectionId === null || revision === null || kind === null || status === null
      ? invalid()
      : { ok: true, data: { action, connectionId, revision, provider: kind, status } };
  }

  if (action === 'disconnect') {
    if (!exactKeys(fields, ['action', 'connection_id', 'revision'])) return invalid();
    const connectionId = integer(fields.connection_id ?? '', 1);
    const revision = integer(fields.revision ?? '', 0);
    return connectionId === null || revision === null
      ? invalid()
      : { ok: true, data: { action, connectionId, revision } };
  }

  return invalid();
}

function declaredTooLarge(request: Request): boolean {
  const raw = request.headers.get('content-length');
  if (raw === null) return false;
  if (!/^\d+$/.test(raw)) return true;
  const length = Number(raw);
  return !Number.isSafeInteger(length) || length > LEARNING_CONNECTION_FORM_MAX_BYTES;
}

async function boundedBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > LEARNING_CONNECTION_FORM_MAX_BYTES) {
        try { await reader.cancel(); } catch { /* cancellation is best effort */ }
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readLearningConnectionForm(request: Request): Promise<LearningConnectionFormReadResult> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8\s*)?$/i.test(contentType)) {
    return { ok: false, reason: 'unsupported_media_type' };
  }
  if (declaredTooLarge(request)) return { ok: false, reason: 'too_large' };
  let bytes: Uint8Array | null;
  try { bytes = await boundedBody(request); } catch { return { ok: false, reason: 'invalid' }; }
  if (bytes === null) return { ok: false, reason: 'too_large' };
  let encoded: string;
  try { encoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { ok: false, reason: 'invalid' }; }
  if (/%(?![0-9a-f]{2})/i.test(encoded)) return { ok: false, reason: 'invalid' };
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of new URLSearchParams(encoded)) {
    if (!FORM_FIELD_NAMES.has(name) || Object.hasOwn(fields, name)) return { ok: false, reason: 'invalid' };
    fields[name] = value;
  }
  return { ok: true, fields };
}
