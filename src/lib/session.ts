import { SignJWT, jwtVerify } from 'jose';
import type { SessionAssurance, SessionAuthMethod } from './sessionAssurance';

// Session = stateless jose HS256 JWT in an HttpOnly cookie. Middleware reloads
// the person row every request, so revocation is people.active=0 / deleted_at /
// a session_epoch bump (carried as the `ep` claim). Ported from
// the reference stack's src/lib/session.ts (cookie name c4c_session, secret-first args).
export const SESSION_COOKIE = 'c4c_session';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days
export const SESSION_SCHEMA_VERSION = 2;

export type VerifiedSession = {
  personId: number;
  epoch: number;
  assurance: SessionAssurance;
};

type MintSessionOptions = {
  authMethod?: SessionAuthMethod;
  authTime?: number;
  stepUpTime?: number;
};

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function validEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isAuthMethod(value: unknown): value is SessionAuthMethod {
  return value === 'email_otp' || value === 'magic_link' || value === 'screenshot' || value === 'legacy';
}

/** Sign a 30-day opaque session. The deprecated email input is ignored. */
export async function mintSession(
  secret: string,
  person: { id: number; email?: string; sessionEpoch: number },
  options: MintSessionOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const authMethod = options.authMethod ?? 'legacy';
  if (!isAuthMethod(authMethod)) throw new Error('Invalid session authentication method');
  const authTime = authMethod === 'legacy' ? null : (options.authTime ?? now);
  const stepUpTime = options.stepUpTime ?? null;
  if (!Number.isSafeInteger(person.id) || person.id <= 0) throw new Error('Invalid session person');
  if (!validEpoch(person.sessionEpoch)) throw new Error('Invalid session epoch');
  if (authTime !== null && !validTime(authTime)) throw new Error('Invalid authentication time');
  if (stepUpTime !== null && (!validTime(stepUpTime) || authTime === null || stepUpTime < authTime)) {
    throw new Error('Invalid step-up time');
  }
  const sessionId = crypto.randomUUID();
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('Invalid session id');

  return await new SignJWT({
    v: SESSION_SCHEMA_VERSION,
    ep: person.sessionEpoch,
    sid: sessionId,
    am: authMethod,
    at: authTime,
    su: stepUpTime,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(person.id))
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_MAX_AGE_S)
    .sign(secretKey(secret));
}

/**
 * Verify the session JWT. Returns null on ANY failure (tamper, wrong secret,
 * expiry, garbage) — never throws. The `epoch` is compared against
 * people.session_epoch by the middleware so a /signout invalidates old cookies.
 */
export async function verifySession(
  secret: string,
  jwt: string,
): Promise<VerifiedSession | null> {
  try {
    const { payload } = await jwtVerify(jwt, secretKey(secret), { algorithms: ['HS256'] });
    const personId = Number(payload.sub);
    if (!Number.isInteger(personId) || personId <= 0) return null;
    if (!validEpoch(payload.ep)) return null;
    if (payload.v === undefined) {
      // Compatibility bridge for sessions minted before opaque v2 sessions.
      // The legacy email is required only to recognize the old shape; it is
      // never returned or used to resolve the current identity.
      if (typeof payload.email !== 'string' || payload.email === '') return null;
      return {
        personId,
        epoch: payload.ep,
        assurance: {
          schemaVersion: 1,
          sessionId: null,
          authMethod: 'legacy',
          authTime: null,
          stepUpTime: null,
        },
      };
    }
    if (payload.v !== SESSION_SCHEMA_VERSION) return null;
    if ('email' in payload || 'name' in payload || 'contact' in payload || 'phone' in payload) return null;
    if (typeof payload.sid !== 'string' || !SESSION_ID_RE.test(payload.sid)) return null;
    if (!isAuthMethod(payload.am)) return null;
    const authTime = payload.at === null ? null : payload.at;
    const stepUpTime = payload.su === null ? null : payload.su;
    if (payload.am === 'legacy') {
      if (authTime !== null || stepUpTime !== null) return null;
    } else if (!validTime(authTime)) {
      return null;
    }
    if (stepUpTime !== null && (!validTime(stepUpTime) || authTime === null || stepUpTime < authTime)) return null;
    return {
      personId,
      epoch: payload.ep,
      assurance: {
        schemaVersion: 2,
        sessionId: payload.sid,
        authMethod: payload.am,
        authTime,
        stepUpTime,
      },
    };
  } catch {
    return null;
  }
}

/** Build the Set-Cookie header for a fresh session. Secure only when isProd. */
export function sessionCookie(jwt: string, isProd: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${jwt}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE_S}`,
  ];
  if (isProd) attrs.push('Secure');
  return attrs.join('; ');
}

/** Build the Set-Cookie header that immediately expires the session cookie. */
export function clearSessionCookie(isProd: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (isProd) attrs.push('Secure');
  return attrs.join('; ');
}
