import { describe, expect, it, vi } from 'vitest';
import { probeIdentityVerificationRuntime } from '../../../scripts/setup/identity-verification-probe.mjs';

describe('identity verification runtime probe', () => {
  it.each([
    [204, 'valid'],
    [503, 'invalid'],
    [404, 'unverifiable'],
    [500, 'unverifiable'],
  ] as const)('classifies HTTP %s as %s without reading a response body', async (status, expected) => {
    const fetch = vi.fn(async () => new Response(status === 204 ? null : 'ignored', { status }));
    await expect(probeIdentityVerificationRuntime({ appOrigin: 'https://church.example', fetch })).resolves.toEqual({ status: expected });
    expect(fetch).toHaveBeenCalledWith('https://church.example/api/health/identity-verification', expect.objectContaining({ method: 'HEAD', redirect: 'error' }));
  });

  it('fails closed for an unavailable fetch or malformed origin', async () => {
    await expect(probeIdentityVerificationRuntime({ appOrigin: 'https://church.example', fetch: async () => { throw new Error('offline'); } }))
      .resolves.toEqual({ status: 'unverifiable' });
    await expect(probeIdentityVerificationRuntime({ appOrigin: 'https://church.example/path', fetch: vi.fn() })).rejects.toThrow(/origin/i);
  });

  it.each([
    'http://localhost', 'http://127.0.0.1', 'http://10.1.2.3', 'http://172.16.0.1', 'http://192.168.1.1', 'http://169.254.1.1',
    'http://[::1]', 'http://[fc00::1]', 'http://[fd12::1]', 'http://[fe80::1]',
  ])('rejects a private canary origin: %s', async (appOrigin) => {
    await expect(probeIdentityVerificationRuntime({ appOrigin, fetch: vi.fn() })).rejects.toThrow(/origin/i);
  });

  it('allows public origins and wins an internal race when a fetch ignores abort', async () => {
    const publicFetch = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(probeIdentityVerificationRuntime({ appOrigin: 'https://203.0.113.10', fetch: publicFetch })).resolves.toEqual({ status: 'valid' });
    await expect(probeIdentityVerificationRuntime({ appOrigin: 'https://church.example', fetch: () => new Promise(() => {}), timeoutMs: 100 }))
      .resolves.toEqual({ status: 'unverifiable' });
  });
});
