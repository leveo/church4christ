// Canvas Live Events boundary against the BUILT worker (SELF.fetch): these
// assertions cover the real middleware/CSRF policy and compiled Astro route.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ORIGIN } from './helpers';

const PATH = '/api/learning/canvas/live-events';

async function consume(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

describe('Canvas Live Events built-worker boundary', () => {
  it('lets only the exact signature-authenticated route bypass browser CSRF', async () => {
    const exact = await SELF.fetch(`${ORIGIN}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/jwt' },
      body: 'not-a-compact-jwt',
    });
    expect(await consume(exact)).toEqual({ status: 401, body: '' });

    for (const path of [`${PATH}/`, `${PATH}-near`, '/api/learning/canvas/Live-Events']) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/jwt' },
        body: 'not-a-compact-jwt',
      });
      expect(await consume(response), path).toEqual({ status: 403, body: 'Forbidden' });
    }
  });

  it('enforces method, media type, and body bounds in the compiled route', async () => {
    const get = await SELF.fetch(`${ORIGIN}${PATH}`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    await get.arrayBuffer();

    const media = await SELF.fetch(`${ORIGIN}${PATH}`, {
      method: 'POST', headers: { 'content-type': 'text/plain', origin: ORIGIN }, body: 'not-a-jwt',
    });
    expect(await consume(media)).toEqual({ status: 415, body: '' });

    const oversized = await SELF.fetch(`${ORIGIN}${PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/jwt' }, body: 'x'.repeat(65_537),
    });
    expect(await consume(oversized)).toEqual({ status: 413, body: '' });
  });
});
