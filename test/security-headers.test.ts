// Runs in the workers project (workerd via the pool). The header assertions
// lock the baseline security-header names/values that the middleware sends on
// every response; smoke.sh proves they actually reach the wire over HTTP. The
// D1 test below confirms the pool's DB binding is live and queryable (setup.ts
// ran against it — a no-op while migrations/ is empty).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS, applySecurityHeaders } from '../src/lib/securityHeaders';

describe('workers pool D1 binding', () => {
  it('env.DB is defined and answers a query', async () => {
    expect(env.DB).toBeDefined();
    const row = await env.DB.prepare('SELECT 1 AS one').first<{ one: number }>();
    expect(row?.one).toBe(1);
  });
});

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
