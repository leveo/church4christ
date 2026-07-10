// Postgres-backed e2e for the member portal's groups (Member Portal Phase 2,
// Task 6): the member hub list, the group detail's roster/apply/decide/files
// flows, the auth-gated file download route, and — since /admin/fellowships is
// backend-agnostic (Astro.locals.db) and already proven reachable over Postgres
// by smoke.test.ts's /admin/ministries + /admin/giving coverage — a create →
// edit → delete round trip through the admin group editor. All driven through
// the BUILT worker (SELF.fetch) over Postgres, exercising groupDb.ts /
// groupFiles.ts / my/groups/index.astro / my/groups/[id].astro /
// my/groups/[id]/files/[fileId].ts / admin/fellowships/*.astro with real bind
// params translated by PgAdapter.
//
// Seed anchors (seed/dev-seed.sql + seed/portal-seed.sql, the latter Postgres-
// only since group_members/group_applications have no D1 counterpart — see its
// header): group 1 (id 1, 'young-adults' fellowship) has David Chen (person 2)
// as leader and Amy Chen (person 7) as a plain member; group 2 (id 2,
// 'foundations-of-faith' Sunday School) is open_signup=1 with no members yet;
// Sarah Johnson (person 3, sarah.johnson@example.com) has one seeded PENDING
// application to group 1 (id 1); Ben Wu (person 8) belongs to neither group —
// the non-member anchor throughout.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ORIGIN, get, post } from '../e2e/helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { openDb, type DbEnv } from '../../src/lib/dbProvider';
import type { AppDb } from '../../src/lib/appDb';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

/** Open a request-scoped Postgres AppDb (same factory the worker uses), run
 *  `fn`, then drain the client — mirrors portal-household.test.ts. */
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
const SARAH_ID = 3;
const BEN_ID = 8;
const BEN_EMAIL = 'ben.wu@example.com';
const ADMIN_ID = 1;
const ADMIN_EMAIL = 'admin@example.com';
const GROUP_1 = 1; // young-adults fellowship: David leads, Amy is a member
const GROUP_2 = 2; // foundations-of-faith Sunday School: open_signup, no members
const PENDING_APP_ID = 1; // Sarah's seeded pending application to group 1

describe('Postgres-backed worker: /my/groups (member portal groups)', () => {
  it('leader GETs /en/my/groups: 200, lists group 1 (leader badge) and group 2 under open sign-up', async () => {
    const res = await get('/en/my/groups', { cookie: await sessionCookie(DAVID_ID, DAVID_EMAIL) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Young Adults Fellowship');
    expect(body).toContain('Leader'); // portal.groups.leader badge on group 1
    expect(body).toContain('Foundations of Faith'); // listed under "Open for sign-up"
  });

  it('member GETs /en/my/groups/1: 200, roster lists both David (leader) and Amy', async () => {
    const res = await get(`/en/my/groups/${GROUP_1}`, { cookie: await sessionCookie(AMY_ID, AMY_EMAIL) });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('陈大卫 David Chen');
    expect(body).toContain('Amy Chen 陈爱美');
  });

  it('non-member GET /en/my/groups/1: 404 (Ben belongs to neither seeded group)', async () => {
    const res = await get(`/en/my/groups/${GROUP_1}`, { cookie: await sessionCookie(BEN_ID, BEN_EMAIL) });
    expect(res.status).toBe(404);
  });

  it('non-member applies to open group 2: group_applications row lands with status P', async () => {
    const cookie = await sessionCookie(BEN_ID, BEN_EMAIL);
    const res = await post('/en/my/groups', `_action=apply&group_id=${GROUP_2}&note=Looking%20forward%20to%20it`, { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/en/my/groups?ok=applied');

    const row = await withDb((db) =>
      db
        .prepare('SELECT status FROM group_applications WHERE group_id = ? AND person_id = ?')
        .bind(GROUP_2, BEN_ID)
        .first<{ status: string }>(),
    );
    expect(row?.status).toBe('P');
  });

  it("leader approves Sarah's seeded pending application to group 1: she becomes a group_members row", async () => {
    const cookie = await sessionCookie(DAVID_ID, DAVID_EMAIL);
    const res = await post(
      `/en/my/groups/${GROUP_1}`,
      `_action=decideApp&application_id=${PENDING_APP_ID}&decision=approve`,
      { cookie },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain(`/en/my/groups/${GROUP_1}?ok=appApproved`);

    const app = await withDb((db) =>
      db.prepare('SELECT status FROM group_applications WHERE id = ?').bind(PENDING_APP_ID).first<{ status: string }>(),
    );
    expect(app?.status).toBe('A');

    const member = await withDb((db) =>
      db
        .prepare('SELECT is_leader FROM group_members WHERE group_id = ? AND person_id = ?')
        .bind(GROUP_1, SARAH_ID)
        .first<{ is_leader: number }>(),
    );
    expect(member?.is_leader).toBe(0);
  });

  describe('group files (auth-gated R2 download route)', () => {
    const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%E2%E3%CF%D3\nfake pdf bytes for the e2e round trip\n');
    let fileId: number;

    it('leader uploads a PDF via multipart POST: 303, a group_files row lands', async () => {
      const form = new FormData();
      form.set('_action', 'uploadFile');
      form.set('file', new File([PDF_BYTES], 'agenda.pdf', { type: 'application/pdf' }));

      const res = await SELF.fetch(`${ORIGIN}/en/my/groups/${GROUP_1}`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: await sessionCookie(DAVID_ID, DAVID_EMAIL) },
        body: form,
        redirect: 'manual',
      });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toContain(`/en/my/groups/${GROUP_1}?ok=uploaded`);

      const row = await withDb((db) =>
        db
          .prepare('SELECT id, file_name, size_bytes FROM group_files WHERE group_id = ? AND deleted_at IS NULL')
          .bind(GROUP_1)
          .first<{ id: number; file_name: string; size_bytes: number }>(),
      );
      expect(row?.file_name).toBe('agenda.pdf');
      expect(row?.size_bytes).toBe(PDF_BYTES.byteLength);
      fileId = row!.id;
    });

    it('member downloads the file: 200, attachment disposition, exact bytes round-trip', async () => {
      const res = await get(`/en/my/groups/${GROUP_1}/files/${fileId}`, { cookie: await sessionCookie(AMY_ID, AMY_EMAIL) });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      const disposition = res.headers.get('content-disposition') ?? '';
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('agenda.pdf');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes).toEqual(PDF_BYTES);
    });

    it('non-member download: 404 (Ben is not in group 1)', async () => {
      const res = await get(`/en/my/groups/${GROUP_1}/files/${fileId}`, { cookie: await sessionCookie(BEN_ID, BEN_EMAIL) });
      expect(res.status).toBe(404);
    });

    it('non-leader (Amy) upload POST: 403', async () => {
      const form = new FormData();
      form.set('_action', 'uploadFile');
      form.set('file', new File([PDF_BYTES], 'not-allowed.pdf', { type: 'application/pdf' }));

      const res = await SELF.fetch(`${ORIGIN}/en/my/groups/${GROUP_1}`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: await sessionCookie(AMY_ID, AMY_EMAIL) },
        body: form,
        redirect: 'manual',
      });
      expect(res.status).toBe(403);
    });

    it('leader deletes the file: 303, row soft-deleted', async () => {
      const cookie = await sessionCookie(DAVID_ID, DAVID_EMAIL);
      const res = await post(`/en/my/groups/${GROUP_1}`, `_action=deleteFile&file_id=${fileId}`, { cookie });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toContain(`/en/my/groups/${GROUP_1}?ok=fileDeleted`);

      const row = await withDb((db) =>
        db.prepare('SELECT deleted_at FROM group_files WHERE id = ?').bind(fileId).first<{ deleted_at: string | null }>(),
      );
      expect(row?.deleted_at).not.toBeNull();
    });
  });
});

describe('Postgres-backed worker: /admin/fellowships (group definition CRUD round trip)', () => {
  it('admin creates, edits, then deletes a group', async () => {
    const cookie = await sessionCookie(ADMIN_ID, ADMIN_EMAIL);

    const created = await post(
      '/admin/fellowships',
      '_action=create&slug=e2e-admin-group&kind=fellowship&name_en=E2E%20Admin%20Group',
      { cookie },
    );
    expect(created.status).toBe(303);
    const createdLocation = created.headers.get('location') ?? '';
    const match = createdLocation.match(/\/admin\/fellowships\/(\d+)\?saved=1/);
    expect(match).not.toBeNull();
    const id = Number(match![1]);

    const editPage = await get(`/admin/fellowships/${id}`, { cookie });
    expect(editPage.status).toBe(200);
    expect(await editPage.text()).toContain('E2E Admin Group');

    const saved = await post(
      `/admin/fellowships/${id}`,
      '_action=save&slug=e2e-admin-group&kind=fellowship&name_en=E2E%20Admin%20Group%20Updated&sort=0',
      { cookie },
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(`/admin/fellowships/${id}?saved=1`);

    const nameAfterSave = await withDb((db) =>
      db
        .prepare(`SELECT name FROM member_group_i18n WHERE group_id = ? AND locale = 'en'`)
        .bind(id)
        .first<{ name: string }>(),
    );
    expect(nameAfterSave?.name).toBe('E2E Admin Group Updated');

    const deleted = await post(`/admin/fellowships/${id}`, '_action=delete', { cookie });
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get('location')).toBe('/admin/fellowships?deleted=1');

    const afterDelete = await withDb((db) =>
      db.prepare('SELECT deleted_at FROM member_groups WHERE id = ?').bind(id).first<{ deleted_at: string | null }>(),
    );
    expect(afterDelete?.deleted_at).not.toBeNull();
  });
});
