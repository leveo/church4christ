import { hmacIdentityValue } from './identityAuth';

export const IDENTITY_CONTINUATION_COOKIE = 'c4_identity_continuation';

type ContinuationCookie = Readonly<{
  intentId: string;
  operationId: string;
  publicId: string;
  kind: 'giving' | 'registration';
  locale: 'en' | 'zh';
  returnPath: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_PATH = /^\/[a-z]{2}\/(?:give|register\/\d+|identity\/continue)$/u;

function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decode(value: string): string | null {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(normalized);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch { return null; }
}

function same(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left); const b = new TextEncoder().encode(right);
  let different = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) different |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return different === 0;
}

export async function sealIdentityContinuationCookie(secret: string, value: ContinuationCookie): Promise<string> {
  if (!UUID.test(value.intentId) || !UUID.test(value.operationId) || !UUID.test(value.publicId)
    || (value.kind !== 'giving' && value.kind !== 'registration') || (value.locale !== 'en' && value.locale !== 'zh')
    || !SAFE_PATH.test(value.returnPath)) throw new Error('identity_continuation_cookie_invalid');
  const payload = base64url(JSON.stringify(value));
  return `${payload}.${await hmacIdentityValue(secret, 'identity-continuation-cookie', payload)}`;
}

export async function openIdentityContinuationCookie(secret: string, value: string | null | undefined): Promise<ContinuationCookie | null> {
  if (typeof value !== 'string') return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra || !/^[A-Za-z0-9_-]+$/u.test(payload)) return null;
  const expected = await hmacIdentityValue(secret, 'identity-continuation-cookie', payload);
  if (!same(signature, expected)) return null;
  const parsed = decode(payload);
  if (!parsed) return null;
  try {
    const value = JSON.parse(parsed) as ContinuationCookie;
    if (!UUID.test(value.intentId) || !UUID.test(value.operationId) || !UUID.test(value.publicId)
      || (value.kind !== 'giving' && value.kind !== 'registration') || (value.locale !== 'en' && value.locale !== 'zh')
      || !SAFE_PATH.test(value.returnPath)) return null;
    return Object.freeze(value);
  } catch { return null; }
}

export function identityContinuationCookieHeader(value: string, secure = true): string {
  return `${IDENTITY_CONTINUATION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearIdentityContinuationCookieHeader(secure = true): string {
  return `${IDENTITY_CONTINUATION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
