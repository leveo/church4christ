import { SignJWT, jwtVerify } from 'jose';

// Session = stateless jose HS256 JWT in an HttpOnly cookie. Middleware reloads
// the person row every request, so revocation is people.active=0 / deleted_at /
// a session_epoch bump (carried as the `ep` claim). Ported from
// dcfc-serve/src/lib/session.ts (cookie name c4c_session, secret-first args).
export const SESSION_COOKIE = 'c4c_session';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Sign a 30-day session JWT with claims sub=person id, email, ep=session epoch. */
export async function mintSession(
  secret: string,
  person: { id: number; email: string; sessionEpoch: number },
): Promise<string> {
  return await new SignJWT({ email: person.email, ep: person.sessionEpoch })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(person.id))
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S)
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
): Promise<{ personId: number; email: string; epoch: number } | null> {
  try {
    const { payload } = await jwtVerify(jwt, secretKey(secret), { algorithms: ['HS256'] });
    const personId = Number(payload.sub);
    if (!Number.isInteger(personId) || personId <= 0) return null;
    if (typeof payload.email !== 'string' || payload.email === '') return null;
    return {
      personId,
      email: payload.email,
      epoch: typeof payload.ep === 'number' ? payload.ep : 0,
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
