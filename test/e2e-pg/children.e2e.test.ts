import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { get } from '../e2e/helpers';

describe('Postgres-backed children dashboard', () => {
  it('renders seeded weekly dates and event totals through the built Worker', async () => {
    const secret = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
    const jwt = await mintSession(secret, { id: 1, email: 'admin@example.com', sessionEpoch: 0 });
    const response = await get('/admin/children', { cookie: `${SESSION_COOKIE}=${jwt}` });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Weekly check-ins');
    expect(html).toContain('Sunday Kids');
  });
});
