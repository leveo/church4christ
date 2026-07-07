// Postgres-backed smoke of the BUILT worker (SELF.fetch), run by
// vitest.e2e.pg.config.ts with DB_BACKEND=supabase + a HYPERDRIVE binding on local
// Postgres. Every request here flows middleware → route → postgres.js over
// Hyperdrive, so a green run proves the whole stack serves real seeded pages against
// Postgres — and specifically exercises the SQLite→Postgres portability fixes this
// exploration landed:
//   - the streamed-render drain (middleware pipes the body through a TransformStream
//     whose flush() ends the client) — every rendered page below loads theme/
//     settings/modules through the request-scoped client while the body streams;
//   - the admin Overview shortfall query (adminOverviewDb.getNeedsAttention /
//     getOverviewStats), which needed the 2-arg MAX/MIN compat functions, the mixed
//     numbered/anonymous placeholder fix, the HAVING-alias → subquery rewrite, the
//     explicit GROUP BY, and the TRUE/FALSE scope clause — reached via /admin/
//     ministries as both an admin and a team leader.
// This does NOT reuse test/e2e/** (those seed + verify through the D1 env.DB binding,
// which this backend never reads) — see docs/superpowers/plans/phase1-e2e-pg-findings.md.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

describe('Postgres-backed worker: public render path', () => {
  it('/healthz → 200 {"ok":true}', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('/en/ renders the seeded theme, both hreflang alternates, and the announcement', async () => {
    const body = await (await get('/en/')).text();
    expect(body).toContain('data-theme="sanctuary"'); // theme.name setting, read over Postgres
    expect(body).toContain('hreflang="en"');
    expect(body).toContain('hreflang="zh-Hans"');
    expect(body).toContain('New members class every first Sunday'); // seeded announcement
  });

  it('/zh/ declares lang="zh-Hans" and renders the Chinese announcement', async () => {
    const body = await (await get('/zh/')).text();
    expect(body).toContain('lang="zh-Hans"');
    expect(body).toContain('新朋友课程每月首个主日');
  });

  it('/en/sermons lists a published sermon', async () => {
    const body = await (await get('/en/sermons')).text();
    expect(body).toContain('The Beatitudes');
  });
});

describe('Postgres-backed worker: admin console (exercises the shortfall query)', () => {
  it('/admin/ministries: anon → 303 to signin', async () => {
    const res = await get('/admin/ministries');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/signin');
  });

  it('/admin/ministries: admin → 200 (Overview shortfall query runs over Postgres)', async () => {
    // Person 1 (admin@example.com) is the admin — Overview runs getOverviewStats +
    // getNeedsAttention (the SUM(MAX(0, needed - filled)) shortfall math) with the
    // all-scope TRUE clause.
    const res = await get('/admin/ministries', { cookie: await sessionCookie(1, 'admin@example.com') });
    expect(res.status).toBe(200);
  });

  it('/admin/ministries: team leader → 200 (leaderTeamFilter placeholder path)', async () => {
    // Person 3 (sarah) leads Worship Team — the shortfall query runs with the
    // `teams.id IN (?)` leader filter spliced into a numbered-placeholder head query
    // (the mixed ?N / ? case the translator fix handles).
    const res = await get('/admin/ministries', { cookie: await sessionCookie(3, 'sarah.johnson@example.com') });
    expect(res.status).toBe(200);
  });
});
