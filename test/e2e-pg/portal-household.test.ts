// Postgres-backed e2e for the member portal's household foundations (Task 7):
// owner GET, promote/demote a co-owner, non-owner gating (no edit forms for
// others, a rejected setOwner), and the email-change request → consume →
// session-revocation flow — all driven through the BUILT worker (SELF.fetch)
// over Postgres, exercising portalDb.ts / emailChange.ts / the household.astro
// route with real bind params translated by PgAdapter.
//
// D1's module gating (portal `requiresBackend: 'supabase'`, so /my/household
// 404s there regardless of settings) is unit-covered already — test/modules.
// test.ts asserts both filterByBackend('d1') drops 'portal' AND
// moduleForPath('/my/household') === 'portal' — so no e2e is needed for that
// combination; see docs/CONTRIBUTING.md's Postgres section for why this suite
// is separate from test/e2e/** (that one seeds/asserts through the D1 env.DB
// binding, which this backend never reads).
//
// Seeded Chen household (id 1, seed/dev-seed.sql): David Chen (person 2,
// household_members id 1, adult, is_owner=1 per Task 7's seed line) and Amy
// Chen (person 7, household_members id 2, adult, no owner). The raw
// email-change token never reaches this test through HTTP (it's only ever
// "emailed", and EMAIL_DEV_LOG just logs it) — mint it by calling
// requestEmailChange() directly against a Postgres AppDb, the same technique
// the smoke test uses for session cookies.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { openDb, type DbEnv } from '../../src/lib/dbProvider';
import { requestEmailChange } from '../../src/lib/emailChange';
import type { AppDb } from '../../src/lib/appDb';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string, epoch = 0): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: epoch });
  return `${SESSION_COOKIE}=${jwt}`;
}

/** Open a request-scoped Postgres AppDb (same factory the worker uses), run
 *  `fn`, then drain the client — mirrors how middleware opens/ends per request. */
async function withDb<T>(fn: (db: AppDb) => Promise<T>): Promise<T> {
  const { db, end } = openDb(env as unknown as DbEnv);
  try {
    return await fn(db);
  } finally {
    await end();
  }
}

const DAVID_ID = 2;
const DAVID_EMAIL = 'pastor.david@example.com';
const AMY_ID = 7;
const AMY_EMAIL = 'amy.chen@example.com';
const HOUSEHOLD_ID = 1;
const DAVID_MEMBER_ID = 1;
const AMY_MEMBER_ID = 2;

describe('Postgres-backed worker: /my/household (member portal)', () => {
  it('owner GETs /en/my/household: 200, lists every household member', async () => {
    const res = await get('/en/my/household', { cookie: await sessionCookie(DAVID_ID, DAVID_EMAIL) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('My Household'); // portal.household.title
    expect(body).toContain('陈大卫 David Chen');
    expect(body).toContain('Amy Chen 陈爱美');
  });

  it('owner promotes a second adult to co-owner: both are owners after', async () => {
    const cookie = await sessionCookie(DAVID_ID, DAVID_EMAIL);
    const res = await post('/en/my/household', `_action=setOwner&member_id=${AMY_MEMBER_ID}`, { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/en/my/household?ok=owner');

    const owners = await withDb((db) =>
      db
        .prepare('SELECT COUNT(*) AS n FROM household_members WHERE household_id = ? AND is_owner = 1')
        .bind(HOUSEHOLD_ID)
        .first<{ n: number }>(),
    );
    expect(owners?.n).toBe(2);
  });

  it('owner demotes that co-owner: back down to one owner', async () => {
    const cookie = await sessionCookie(DAVID_ID, DAVID_EMAIL);
    const res = await post('/en/my/household', `_action=unsetOwner&member_id=${AMY_MEMBER_ID}`, { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/en/my/household?ok=owner');

    const owner = await withDb((db) =>
      db
        .prepare('SELECT id FROM household_members WHERE household_id = ? AND is_owner = 1')
        .bind(HOUSEHOLD_ID)
        .first<{ id: number }>(),
    );
    expect(owner?.id).toBe(DAVID_MEMBER_ID);
  });

  it('non-owner GET: only her own member card is editable, no owner controls at all', async () => {
    const res = await get('/en/my/household', { cookie: await sessionCookie(AMY_ID, AMY_EMAIL) });
    expect(res.status).toBe(200);
    const body = await res.text();
    // The household has 4 members (David, Amy, Ethan, Mia); a non-owner only
    // gets an editable "Edit profile" details block on her own row.
    expect(body.match(/name="_action" value="updateProfile"/g)?.length).toBe(1);
    // canPromote/canDemote both require viewerIsOwner — neither form renders.
    expect(body).not.toContain('value="setOwner"');
    expect(body).not.toContain('value="unsetOwner"');
  });

  it('non-owner setOwner POST is rejected (not an owner, not admin)', async () => {
    const cookie = await sessionCookie(AMY_ID, AMY_EMAIL);
    const res = await post('/en/my/household', `_action=setOwner&member_id=${AMY_MEMBER_ID}`, { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/en/my/household?err=generic');

    // Unchanged: still only David is an owner.
    const owners = await withDb((db) =>
      db
        .prepare('SELECT COUNT(*) AS n FROM household_members WHERE household_id = ? AND is_owner = 1')
        .bind(HOUSEHOLD_ID)
        .first<{ n: number }>(),
    );
    expect(owners?.n).toBe(1);
  });

  it('email-change: request stores pending_email, consume swaps it and revokes the old session', async () => {
    const oldCookie = await sessionCookie(DAVID_ID, DAVID_EMAIL);
    const newEmail = 'david.new@example.com';

    // Real route POST — proves the page wiring (requestEmailChange +
    // sendEmailChangeLink) works end to end; EMAIL_DEV_LOG=1 (test/e2e/
    // wrangler.e2e.jsonc, shared by this pg config) makes the "send" a no-op
    // console log, so a clean redirect here is the send succeeding.
    const reqRes = await post('/en/my/household', `_action=requestEmailChange&new_email=${newEmail}`, {
      cookie: oldCookie,
    });
    expect(reqRes.status).toBe(303);
    expect(reqRes.headers.get('location')).toContain('/en/my/household?ok=emailChange');

    const pending = await withDb((db) =>
      db.prepare('SELECT pending_email FROM people WHERE id = ?').bind(DAVID_ID).first<{ pending_email: string }>(),
    );
    expect(pending?.pending_email).toBe(newEmail);

    // The raw token is only ever "emailed" (logged, not returned over HTTP), so
    // mint one directly against Postgres via the lib — this supersedes the
    // token from the POST above but re-stashes the SAME pending_email.
    const minted = await withDb((db) => requestEmailChange(db, DAVID_ID, newEmail));
    if ('error' in minted) throw new Error(`unexpected requestEmailChange error: ${minted.error}`);

    // Consume (David is seeded lang='zh', so the post-consume redirect lands
    // on the Chinese sign-in).
    const consumeRes = await post(`/email-change/${minted.raw}`, '', { cookie: oldCookie });
    expect(consumeRes.status).toBe(303);
    expect(consumeRes.headers.get('location')).toBe('/zh/signin?changed=1');

    const person = await withDb((db) =>
      db
        .prepare('SELECT email, pending_email, session_epoch FROM people WHERE id = ?')
        .bind(DAVID_ID)
        .first<{ email: string; pending_email: string | null; session_epoch: number }>(),
    );
    expect(person?.email).toBe(newEmail);
    expect(person?.pending_email).toBeNull();
    expect(person?.session_epoch).toBe(1);

    // The old (epoch 0) session cookie is now stale: the middleware reloads
    // people.session_epoch every request, the mismatch drops the user back to
    // anonymous, and /my is an authed route → redirected to signin.
    const staleRes = await get('/en/my/household', { cookie: oldCookie });
    expect(staleRes.status).toBe(303);
    expect(staleRes.headers.get('location')).toContain('/signin');
  });
});
