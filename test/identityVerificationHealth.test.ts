import { describe, expect, it } from 'vitest';
import { identityPinnedConfigurationMismatchResponse, identityVerificationHealthResponse } from '../src/lib/identitySecret';

describe('identity verification health response', () => {
  it('returns only an uncached status without secret diagnostics', async () => {
    const healthy = identityVerificationHealthResponse('x'.repeat(32), 'y'.repeat(32), 'v1', 'z'.repeat(32), 'v1');
    expect(healthy.status).toBe(204);
    expect(healthy.headers.get('cache-control')).toBe('no-store');
    expect(healthy.headers.get('x-frame-options')).toBe('DENY');
    expect(healthy.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(await healthy.text()).toBe('');

    const unhealthy = identityVerificationHealthResponse('short', 'y'.repeat(32), 'v1', 'z'.repeat(32), 'v1');
    expect(unhealthy.status).toBe(503);
    expect(unhealthy.headers.get('cache-control')).toBe('no-store');
    expect(unhealthy.headers.get('x-frame-options')).toBe('DENY');
    expect(unhealthy.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(await unhealthy.text()).toBe('');
    expect(identityVerificationHealthResponse('x'.repeat(32), 'short', 'v1', 'z'.repeat(32), 'v1').status).toBe(503);
    expect(identityVerificationHealthResponse('x'.repeat(32), 'y'.repeat(32), 'V 2', 'z'.repeat(32), 'v1').status).toBe(503);
    expect(identityVerificationHealthResponse('x'.repeat(32), 'y'.repeat(32), 'v1', 'short', 'v1').status).toBe(503);
    expect(identityVerificationHealthResponse('x'.repeat(32), 'y'.repeat(32), 'v1', 'z'.repeat(32), 'V 2').status).toBe(503);
  });

  it('reports a database pin mismatch as bodyless unverifiable, not an invalid OTP secret', async () => {
    const mismatch = identityPinnedConfigurationMismatchResponse();
    expect(mismatch.status).toBe(409);
    expect(mismatch.headers.get('cache-control')).toBe('no-store');
    expect(await mismatch.text()).toBe('');
  });
});
