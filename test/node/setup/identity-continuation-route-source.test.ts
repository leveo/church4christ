import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const complete = readFileSync('src/pages/api/identity/continuation/complete.ts', 'utf8');
const business = readFileSync('src/lib/identityBusinessContinuation.ts', 'utf8');
const worker = readFileSync('src/worker.ts', 'utf8');

describe('identity continuation completion recovery route', () => {
  it('preserves the continuation credential while business work is waiting', () => {
    const waiting = complete.indexOf("result.status === 'waiting'");
    const sessionClaim = complete.indexOf('const delivery = await resolveSignupSessionDelivery');
    expect(waiting).toBeGreaterThan(-1);
    expect(waiting).toBeLessThan(sessionClaim);
    expect(complete.slice(waiting, sessionClaim)).not.toContain('clearIdentityContinuationCookieHeader');
    expect(complete.slice(waiting, sessionClaim)).toContain('/identity/continue?error=waiting');
  });

  it('does not bypass OTP-backed session delivery for a consumed Giving replay', () => {
    const sessionClaim = complete.indexOf('const delivery = await resolveSignupSessionDelivery');
    const givingRedirect = complete.indexOf("pending.kind === 'giving' && result.status === 'redirect'", sessionClaim);
    expect(sessionClaim).toBeGreaterThan(-1);
    expect(givingRedirect).toBeGreaterThan(sessionClaim);
    expect(complete).toContain("delivery.status === 'already_claimed' && result.replay === true");
    const replayBranch = complete.indexOf("delivery.status === 'already_claimed' && result.replay === true");
    const mint = complete.indexOf('const jwt = await mintSession');
    expect(replayBranch).toBeGreaterThan(sessionClaim);
    expect(replayBranch).toBeLessThan(mint);
    expect(complete.slice(replayBranch, mint)).not.toContain('sessionCookie(');
  });

  it('never treats a registration id as an event route id', () => {
    expect(complete).not.toMatch(/register\/\$\{result\.resolution\?\.registrationId/);
    expect(complete).not.toContain("pending.kind === 'registration' && result.status === 'waiting'");
  });

  it('binds AES-GCM retry material to campus, intent, and account operation', () => {
    expect(business).toContain('identity-business-delivery:v2\\0${campusId}\\0${intentId}\\0${operationId}');
    expect(business).toContain('crypto.getRandomValues(new Uint8Array(12))');
    expect(business).not.toContain('identity-business-delivery:v1\\0${campusId}\\0${intentId}`');
  });

  it('uses a server-authenticated device id for request and resend rate limits', () => {
    expect(complete.replaceAll(' ', '')).not.toContain('identityTrustedRequestContext(request.headers,null)');
    const start = readFileSync('src/pages/api/identity/continuation/start.ts', 'utf8');
    expect(start).toContain('resolveIdentityDeviceCookie');
    expect(start).toContain('IDENTITY_DEVICE_COOKIE');
    expect(start).toContain('resolvedDevice.deviceId');
    expect(start.replaceAll(' ', '')).not.toContain('identityTrustedRequestContext(request.headers,null)');
  });

  it('runs bounded abandoned-ciphertext cleanup from the hourly worker even after sibling work fails', () => {
    expect(worker).toContain("import { expireIdentityBusinessContinuations } from './lib/identityBusinessContinuation'");
    const hourly = worker.slice(worker.indexOf('case ATTENDANCE_CRON:'), worker.indexOf('case GOOGLE_CLASSROOM_REGISTRATION_CRON:'));
    expect(hourly).toContain('expireIdentityBusinessContinuations(db');
    expect(hourly).toMatch(/finally\s*\{[\s\S]*await expireIdentityBusinessContinuations/u);
  });
});
