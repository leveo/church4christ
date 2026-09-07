import { hmacIdentityValue, type IdentityAuthEnv } from './identityAuth';
import { hasValidIdentityVerificationSecret } from './identitySecret';

export const IDENTITY_DEVICE_COOKIE = 'c4c_identity_device';

export type IdentityDeviceCookie = Readonly<{
  deviceId: string;
  cookieValue: string;
  replaced: boolean;
}>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SIGNATURE = /^[0-9a-f]{64}$/u;

function sameSignature(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  let different = 0;
  for (let index = 0; index < 64; index++) {
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return different === 0;
}

async function signedValue(secret: string, deviceId: string): Promise<string> {
  const signature = await hmacIdentityValue(secret, 'device-cookie', `v1\0${deviceId}`);
  return `v1.${deviceId}.${signature}`;
}

/**
 * Returns only a server-authenticated UUID for identity rate limiting. Any
 * client-selected, malformed, forged, or stale-version value is rotated.
 */
export async function resolveIdentityDeviceCookie(
  env: IdentityAuthEnv,
  rawCookie: string | null | undefined,
): Promise<IdentityDeviceCookie> {
  const secret = env.IDENTITY_VERIFICATION_SECRET;
  if (!hasValidIdentityVerificationSecret(secret)) throw new Error('identity_verification_unavailable');

  if (typeof rawCookie === 'string' && rawCookie.length <= 256) {
    const parts = rawCookie.split('.');
    if (parts.length === 3 && parts[0] === 'v1' && UUID_V4.test(parts[1]) && SIGNATURE.test(parts[2])) {
      const expected = await signedValue(secret, parts[1]);
      const expectedSignature = expected.slice(expected.lastIndexOf('.') + 1);
      if (sameSignature(parts[2], expectedSignature)) {
        return Object.freeze({ deviceId: parts[1], cookieValue: rawCookie, replaced: false });
      }
    }
  }

  const deviceId = crypto.randomUUID();
  return Object.freeze({
    deviceId,
    cookieValue: await signedValue(secret, deviceId),
    replaced: true,
  });
}

export function identityDeviceCookieHeader(value: string, secure = true): string {
  return `${IDENTITY_DEVICE_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
