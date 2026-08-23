import { describe, expect, it } from 'vitest';
import {
  clearIdentityContinuationCookieHeader,
  identityContinuationCookieHeader,
  openIdentityContinuationCookie,
  sealIdentityContinuationCookie,
} from '../../src/lib/identityContinuationCookie';

const value = {
  intentId: '11111111-1111-4111-8111-111111111111',
  operationId: '22222222-2222-4222-8222-222222222222',
  publicId: '33333333-3333-4333-8333-333333333333',
  kind: 'giving' as const,
  locale: 'en' as const,
  returnPath: '/en/give',
};

describe('identity continuation cookie', () => {
  it('round-trips only signed opaque identifiers', async () => {
    const sealed = await sealIdentityContinuationCookie('x'.repeat(32), value);
    expect(await openIdentityContinuationCookie('x'.repeat(32), sealed)).toEqual(value);
    expect(await openIdentityContinuationCookie('y'.repeat(32), sealed)).toBeNull();
    expect(identityContinuationCookieHeader(sealed)).toContain('HttpOnly');
    expect(clearIdentityContinuationCookieHeader()).toContain('Max-Age=0');
  });

  it('rejects tampered payload and open redirects', async () => {
    const sealed = await sealIdentityContinuationCookie('x'.repeat(32), value);
    const [payload, signature] = sealed.split('.');
    expect(await openIdentityContinuationCookie('x'.repeat(32), `${payload.slice(0, -1)}A.${signature}`)).toBeNull();
    await expect(sealIdentityContinuationCookie('x'.repeat(32), { ...value, returnPath: 'https://evil.invalid' })).rejects.toThrow();
  });
});
