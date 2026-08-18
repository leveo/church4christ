// Canvas Live Events boundary against the BUILT worker with the PostgreSQL
// backend selected. Reaching the route proves middleware/module policy loaded
// through Hyperdrive before the compact JWT is rejected without a DB write.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'https://church.example';
const PATH = '/api/learning/canvas/live-events';

async function consume(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

describe('Canvas Live Events PostgreSQL built-worker boundary', () => {
  it('reaches only the exact server-authenticated route without browser provenance', async () => {
    const exact = await SELF.fetch(`${ORIGIN}${PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/jwt' }, body: 'not-a-compact-jwt',
    });
    expect(await consume(exact)).toEqual({ status: 401, body: '' });

    const near = await SELF.fetch(`${ORIGIN}${PATH}-near`, {
      method: 'POST', headers: { 'content-type': 'application/jwt' }, body: 'not-a-compact-jwt',
    });
    expect(await consume(near)).toEqual({ status: 403, body: 'Forbidden' });
  });

  it('keeps method and body limits on the PostgreSQL build', async () => {
    const get = await SELF.fetch(`${ORIGIN}${PATH}`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    await get.arrayBuffer();

    const oversized = await SELF.fetch(`${ORIGIN}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/jwt' },
      body: 'x'.repeat(65_537),
    });
    expect(await consume(oversized)).toEqual({ status: 413, body: '' });
  });
});
