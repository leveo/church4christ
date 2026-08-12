export const SERVICE_ATTENDANCE_FORM_MAX_BYTES = 16 * 1024;

export type ServiceAttendanceFormReadResult =
  | { ok: true; form: FormData }
  | {
    ok: false;
    reason: 'unsupported_media_type' | 'too_large' | 'invalid';
  };

function contentLengthTooLarge(request: Request): boolean {
  const raw = request.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) return false;
  const size = Number(raw);
  return !Number.isSafeInteger(size) || size > SERVICE_ATTENDANCE_FORM_MAX_BYTES;
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > SERVICE_ATTENDANCE_FORM_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The body is already classified as oversized; cancellation is best-effort.
        }
        return null;
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readServiceAttendanceForm(
  request: Request,
): Promise<ServiceAttendanceFormReadResult> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, reason: 'unsupported_media_type' };
  }
  if (contentLengthTooLarge(request)) return { ok: false, reason: 'too_large' };

  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedBody(request);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (bytes === null) return { ok: false, reason: 'too_large' };

  let encoded: string;
  try {
    encoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const form = new FormData();
  for (const [name, value] of new URLSearchParams(encoded)) form.append(name, value);
  return { ok: true, form };
}
