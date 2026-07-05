// Runs in the workers project (workerd via the pool), which also exercises the
// D1-migration wiring in test/setup.ts. The assertions themselves lock the
// baseline security-header names/values that the middleware sends on every
// response; smoke.sh proves they actually reach the wire over HTTP.
import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS, applySecurityHeaders } from '../src/lib/securityHeaders';

describe('security headers', () => {
  it('defines exactly the three baseline headers with their spec values', () => {
    expect(SECURITY_HEADERS).toEqual({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
  });

  it('applySecurityHeaders sets every pair on a Headers instance', () => {
    const headers = new Headers();
    applySecurityHeaders(headers);
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('applySecurityHeaders overwrites any pre-existing value', () => {
    const headers = new Headers({ 'x-frame-options': 'SAMEORIGIN' });
    applySecurityHeaders(headers);
    expect(headers.get('x-frame-options')).toBe('DENY');
  });
});
