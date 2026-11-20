// The roster CSV exports are gated by the per-event capability ('view') BEFORE any read: a person with no role on
// the event (or a desk-only volunteer) gets 403 and nothing is queried for the roster. The registration-admin and
// per-event viewer paths are covered with a real database in regBackOfficeUi.d1.test.ts.
import { describe, expect, it } from 'vitest';
import { GET } from '../src/pages/admin/registration/[id]/export.csv';
import { GET as GET_PEOPLE } from '../src/pages/admin/registration/[id]/export-people.csv';

// Any property access throws — used to prove the guard short-circuits pre-DB for an anonymous request.
const throwingDb = new Proxy({}, { get() { throw new Error('db must not be touched before the role guard'); } });
const ctx = (user: unknown, id = '5') => ({ params: { id }, locals: { user, db: throwingDb } }) as never;

describe('roster CSV role guard', () => {
  it('403s an anonymous request without touching the DB', async () => {
    expect((await GET(ctx(null))).status).toBe(403);
    expect((await GET_PEOPLE(ctx(null))).status).toBe(403);
  });

  it('404s a malformed event id for a signed-in person without touching the DB', async () => {
    const user = { isEditor: true, isAdmin: false, adminAreas: [], leaderTeamIds: [], memberTeamIds: [], lang: 'en' };
    expect((await GET(ctx(user, 'abc'))).status).toBe(404);
    expect((await GET_PEOPLE(ctx(user, '5 or 1'))).status).toBe(404);
  });
});
