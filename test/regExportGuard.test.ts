// The roster CSV export re-tightens the 'console' route class to editor∪admin
// (the roster is names/emails/answers — PII). This pins that the guard runs
// BEFORE any DB read: the db stub throws if touched, so a 403 proves nothing was
// queried. Pure — no worker/DB binding needed (the endpoint's only runtime import
// is regDb, which imports types only).
import { describe, expect, it } from 'vitest';
import { GET } from '../src/pages/admin/registration/[id]/export.csv';

// Any property access throws — used to prove the guard short-circuits pre-DB.
const throwingDb = new Proxy(
  {},
  {
    get() {
      throw new Error('db must not be touched before the role guard');
    },
  },
);

// Minimal APIContext for the handler (only params + locals are read).
const ctx = (user: unknown) => ({ params: { id: '5' }, locals: { user, db: throwingDb } }) as never;

describe('export.csv role guard', () => {
  it('403s an anonymous request without touching the DB', async () => {
    const res = await GET(ctx(null));
    expect(res.status).toBe(403);
  });

  it('403s a bare team leader (console class, but neither editor nor admin)', async () => {
    const leader = { isEditor: false, isAdmin: false, leaderTeamIds: [3], memberTeamIds: [], lang: 'en' };
    const res = await GET(ctx(leader));
    expect(res.status).toBe(403);
  });
});
