import { applySecurityHeaders } from './securityHeaders';
import { hasValidIdentityRecoveryKeyConfiguration } from './identityRecoveryKey';

/** Shared validator for the Worker binding used to sign identity challenges. */
export function hasValidIdentityVerificationSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 32 && value.length <= 1024 && !/[\s\0-\x1f\x7f]/u.test(value);
}

export function hasValidIdentitySourceKeyConfiguration(secret: unknown, keyId: unknown): boolean {
  return typeof secret === 'string' && secret.length >= 32 && secret.length <= 1024 && !/[\s\0-\x1f\x7f]/u.test(secret)
    && typeof keyId === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(keyId);
}

/** Deliberately bodyless: the canary reports only binding health, never a reason. */
export function identityVerificationHealthResponse(secret: unknown, sourceKeySecret?: unknown, sourceKeyId?: unknown,
  recoveryKeySecret?: unknown, recoveryKeyId?: unknown): Response {
  const headers = new Headers({ 'cache-control': 'no-store' });
  applySecurityHeaders(headers);
  return new Response(null, {
    status: hasValidIdentityVerificationSecret(secret)
      && hasValidIdentitySourceKeyConfiguration(sourceKeySecret, sourceKeyId)
      && hasValidIdentityRecoveryKeyConfiguration(recoveryKeySecret, recoveryKeyId) ? 204 : 503,
    headers,
  });
}

/** A syntactically valid runtime whose stable source/recovery key no longer
 * matches its database pin is unhealthy but does not prove the OTP key bad. */
export function identityPinnedConfigurationMismatchResponse(): Response {
  const headers = new Headers({ 'cache-control': 'no-store' });
  applySecurityHeaders(headers);
  return new Response(null, { status: 409, headers });
}
