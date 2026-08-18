import { SignJWT } from 'jose';

const SCREENSHOT_SESSION_SECONDS = 5 * 60;

function screenshotSecret(env) {
  const secret = env?.SCREENSHOT_SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < 32 || /\s/u.test(secret)) {
    throw new Error('Screenshot session unavailable');
  }
  return secret;
}

function screenshotIdentity(identity) {
  if (
    !identity
    || !Number.isSafeInteger(identity.personId)
    || identity.personId <= 0
    || typeof identity.email !== 'string'
    || identity.email.length > 320
    || identity.email !== identity.email.trim().toLowerCase()
    || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(identity.email)
    || !Number.isSafeInteger(identity.sessionEpoch)
    || identity.sessionEpoch < 0
  ) {
    throw new Error('Screenshot identity unavailable');
  }
  return identity;
}

export function requireScreenshotSessionEnvironment(env) {
  screenshotSecret(env);
}

/**
 * Mint a five-minute session for one explicitly selected screenshot row.
 * The signing secret comes only from the caller's environment. The token is
 * returned directly to the ephemeral browser target and is never logged or
 * written to disk by this module.
 */
export async function mintScreenshotSession(env, rawIdentity, nowEpochSeconds = Math.floor(Date.now() / 1000)) {
  const secret = screenshotSecret(env);
  const identity = screenshotIdentity(rawIdentity);
  if (!Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds <= 0) {
    throw new Error('Screenshot session unavailable');
  }
  return await new SignJWT({ email: identity.email, ep: identity.sessionEpoch })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(identity.personId))
    .setIssuedAt(nowEpochSeconds)
    .setExpirationTime(nowEpochSeconds + SCREENSHOT_SESSION_SECONDS)
    .sign(new TextEncoder().encode(secret));
}
