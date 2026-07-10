// Per-admin area-grant matrix against the BUILT worker. A LIMITED admin (role
// 'admin', super_admin=0) sees only the always-on defaults (prayer wall, member
// directory) plus explicit grants; a super admin sees everything. On the D1 e2e
// backend the giving/registration modules are force-off (404 pre-session), so
// no-grant 403s are asserted with `groups`/content areas instead.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

// Isolated storage rolls back per FILE, not per `it` (see auth.e2e.test.ts), so
// this fixed-id insert must be idempotent across the file's tests.
beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
     VALUES (50, 'Lena', 'Limited', 'Lena Limited', 'lena.limited@example.com', 'admin', 0, 'bulletins')
     ON CONFLICT(id) DO NOTHING`,
  ).run();
  // Limited admin holding the 'people' grant — used to prove that grant lets her
  // edit identity fields but NOT role/active (those are flags-form/super-only).
  await env.DB.prepare(
    `INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
     VALUES (51, 'Paula', 'People', 'Paula People', 'paula.people@example.com', 'admin', 0, 'people')
     ON CONFLICT(id) DO NOTHING`,
  ).run();
});

describe('limited admin route matrix', () => {
  const CASES: Array<[string, number]> = [
    ['/admin', 200],               // dashboard: every admin
    ['/admin/bulletins', 200],     // granted
    ['/admin/prayer-wall', 200],   // always-on default
    ['/admin/people', 200],        // member directory: always-on default
    ['/admin/sermons', 403],       // not granted
    ['/admin/groups', 403],        // not granted
    ['/admin/teams', 403],         // serve area, not granted
    ['/admin/reports', 403],
    ['/admin/settings', 403],      // reserved for super admins
    ['/admin/navigation', 403],
    ['/admin/does-not-exist', 403],// unknown /admin path fails closed
  ];
  for (const [path, status] of CASES) {
    it(`${path} -> ${status}`, async () => {
      const cookie = await sessionCookie(50, 'lena.limited@example.com');
      expect((await get(path, { cookie })).status).toBe(status);
    });
  }
  it('seeded limited admin (lydia, groups+events) reaches groups but not sermons', async () => {
    const cookie = await sessionCookie(11, 'lydia.kwan@example.com');
    expect((await get('/admin/groups', { cookie })).status).toBe(200);
    expect((await get('/admin/events', { cookie })).status).toBe(200);
    expect((await get('/admin/sermons', { cookie })).status).toBe(403);
  });
  it('super admin (person 1) is unaffected', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    for (const path of ['/admin/sermons', '/admin/settings', '/admin/teams']) {
      expect((await get(path, { cookie })).status).toBe(200);
    }
  });
});

describe('flags form is super-admin only; grants apply instantly', () => {
  it('limited admin: flags POST -> 403; delete POST -> 403 (no people grant)', async () => {
    const cookie = await sessionCookie(50, 'lena.limited@example.com');
    const flags = await post(
      '/admin/people/3',
      new URLSearchParams({ action: 'flags', role: 'member', active: 'on' }).toString(),
      { cookie },
    );
    expect(flags.status).toBe(403);
    const del = await post('/admin/people/3', new URLSearchParams({ action: 'delete' }).toString(), { cookie });
    expect(del.status).toBe(403);
  });
  it('super admin grants sermons to lena; she gains access on her next request', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const body = new URLSearchParams();
    body.append('action', 'flags');
    body.append('role', 'admin');
    body.append('active', 'on');
    body.append('areas', 'bulletins');
    body.append('areas', 'sermons');
    const res = await post('/admin/people/50', body.toString(), { cookie: admin });
    expect(res.status).toBe(303);
    const lena = await sessionCookie(50, 'lena.limited@example.com');
    expect((await get('/admin/sermons', { cookie: lena })).status).toBe(200);
  });
  it('unchecking super on the last super admin re-renders with an error and keeps the flag', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const res = await post(
      '/admin/people/1',
      new URLSearchParams({ action: 'flags', role: 'admin', active: 'on' }).toString(),
      { cookie: admin },
    );
    expect(res.status).toBe(200); // re-render with error banner, not a redirect
    expect((await get('/admin/settings', { cookie: admin })).status).toBe(200); // still super
  });
  it('limited admin sees no flags form on a person page', async () => {
    const cookie = await sessionCookie(50, 'lena.limited@example.com');
    const html = await (await get('/admin/people/3', { cookie })).text();
    expect(html).not.toContain('name="action" value="flags"');
  });
});

describe('member profile activity respects the viewer’s grants', () => {
  it('limited admin without people grant: read-only identity, no household/notes forms, save POST -> 403', async () => {
    const cookie = await sessionCookie(50, 'lena.limited@example.com');
    const html = await (await get('/admin/people/3', { cookie })).text();
    expect(html).not.toContain('name="action" value="save"'); // no editable identity form
    expect(html).not.toContain('name="action" value="createHousehold"');
    expect(html).not.toContain('name="action" value="addNote"');
    const save = await post(
      '/admin/people/3',
      new URLSearchParams({ action: 'save', display_name: 'X', email: 's@x.com' }).toString(),
      { cookie },
    );
    expect(save.status).toBe(403);
    // /admin/people/new is member management too
    expect((await get('/admin/people/new', { cookie })).status).toBe(403);
  });

  it('groups activity panel follows the groups grant', async () => {
    const lydia = await sessionCookie(11, 'lydia.kwan@example.com'); // groups granted
    const lena = await sessionCookie(50, 'lena.limited@example.com'); // not granted
    const withGroups = await (await get('/admin/people/3', { cookie: lydia })).text();
    const withoutGroups = await (await get('/admin/people/3', { cookie: lena })).text();
    // Lydia (person 11) is seeded with lang='zh' while Lena defaults to 'en'
    // (seed/dev-seed.sql), and the admin console follows each viewer's own lang
    // (src/layouts/Admin.astro), so the two renders use different dictionary
    // values for the same key — a single marker string would pass vacuously
    // (the zh string never appears on an en page regardless of gating). Check
    // each viewer against the heading their OWN locale would render.
    expect(withGroups).toContain('小组活动'); // src/i18n/zh.ts: admin.person.groups.title
    expect(withoutGroups).not.toContain('Group activity'); // src/i18n/en.ts: admin.person.groups.title
  });

  it('people index hides the New-person button without the people grant', async () => {
    const cookie = await sessionCookie(50, 'lena.limited@example.com');
    const html = await (await get('/admin/people', { cookie })).text();
    expect(html).not.toContain('/admin/people/new');
  });
});

// Role/active are super-admin-only concerns (editable only via the flags form,
// which carries the last-super-admin guard). A limited admin who merely holds
// the 'people' grant must never be able to change them through the identity
// save form — that would otherwise let her demote/deactivate the sole super
// admin (permanent lockout) or promote a member to admin.
describe('save action cannot escalate/demote role or active (privilege-escalation guard)', () => {
  it('limited admin (people grant): save on the seeded super admin succeeds but role/active/super_admin are unchanged', async () => {
    const cookie = await sessionCookie(51, 'paula.people@example.com');
    const res = await post(
      '/admin/people/1',
      new URLSearchParams({
        action: 'save',
        role: 'member',
        active: '', // omitted checkbox = unchecked
        display_name: 'Alex Admin',
        email: 'admin@example.com',
        first_name: 'Alex',
        last_name: 'Admin',
        phone: '',
        lang: 'en',
      }).toString(),
      { cookie },
    );
    expect(res.status).toBe(303); // the save itself is not rejected...
    const row = await env.DB
      .prepare('SELECT role, active, super_admin FROM people WHERE id = 1')
      .first<{ role: string; active: number; super_admin: number }>();
    // ...but role/active/super_admin are pinned to their stored values, not the
    // crafted POST's role=member/active=(unchecked).
    expect(row).toMatchObject({ role: 'admin', active: 1, super_admin: 1 });
  });

  it('limited admin (people grant): save on a member cannot promote them to admin', async () => {
    const cookie = await sessionCookie(51, 'paula.people@example.com');
    const res = await post(
      '/admin/people/3',
      new URLSearchParams({
        action: 'save',
        role: 'admin',
        active: 'on',
        display_name: 'Sarah Johnson',
        email: 'sarah.johnson@example.com',
        first_name: 'Sarah',
        last_name: 'Johnson',
        phone: '',
        lang: 'en',
      }).toString(),
      { cookie },
    );
    expect(res.status).toBe(303);
    const row = await env.DB.prepare('SELECT role FROM people WHERE id = 3').first<{ role: string }>();
    expect(row?.role).toBe('member');
  });
});

describe('sidebar and dashboard reflect grants', () => {
  // An earlier test in this file ('super admin grants sermons to lena') grants
  // person 50 the sermons area via a real UPDATE; isolated storage rolls back
  // per FILE, not per `it` (see the file-top comment / auth.e2e.test.ts), so
  // that grant would otherwise leak into these tests. Reset it back to her
  // beforeEach-seeded baseline ('bulletins' only) before each case here.
  beforeEach(async () => {
    await env.DB.prepare(`UPDATE people SET admin_areas = 'bulletins' WHERE id = 50`).run();
  });

  it('limited admin sidebar: granted + default links only; no settings/navigation', async () => {
    const cookie = await sessionCookie(50, 'lena.limited@example.com');
    const html = await (await get('/admin', { cookie })).text();
    expect(html).toContain('href="/admin/bulletins"');
    expect(html).toContain('href="/admin/prayer-wall"');
    expect(html).toContain('href="/admin/people"');
    expect(html).not.toContain('href="/admin/sermons"');
    expect(html).not.toContain('href="/admin/groups"');
    expect(html).not.toContain('href="/admin/settings"');
    expect(html).not.toContain('href="/admin/navigation"');
  });
  it('super admin sidebar unchanged (spot check)', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    const html = await (await get('/admin', { cookie })).text();
    for (const href of ['/admin/sermons', '/admin/settings', '/admin/navigation', '/admin/groups']) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});

// Task 9 (in-page guard sweep): the rewritten in-page checks (user.isAdmin ->
// hasAreaAccess(user, area) / isSuperAdmin) are defense-in-depth on top of the
// middleware area gate for /admin paths, so these are no-regression canaries —
// an editor (no admin_areas grant at all) must still pass every content console
// via the isEditor disjunct, and a super admin must still pass isSuperAdmin-only
// pages. They pass identically before and after this task's edits.
// /admin/registration is intentionally NOT probed here: registration is
// backend-gated to Supabase (src/lib/modules.ts) and 404s pre-session on this
// D1 e2e backend for every role, so it can't serve as an in-page-guard canary
// here (see test/e2e-pg/admin-permissions.e2e.test.ts for the Postgres mirror).
describe('in-page guard sweep: no-regression canaries (Task 9)', () => {
  it('editor (person 2) still 200 on /admin/bulletins', async () => {
    const cookie = await sessionCookie(2, 'pastor.david@example.com');
    expect((await get('/admin/bulletins', { cookie })).status).toBe(200);
  });
  it('member (person 3) still 403 on /admin/bulletins', async () => {
    const cookie = await sessionCookie(3, 'sarah.johnson@example.com');
    expect((await get('/admin/bulletins', { cookie })).status).toBe(403);
  });
  it('super admin (person 1) still 200 on /admin/settings (isSuperAdmin path)', async () => {
    const cookie = await sessionCookie(1, 'admin@example.com');
    expect((await get('/admin/settings', { cookie })).status).toBe(200);
  });
});

// The recent-revisions section on /admin is gated at the SECTION level (renders
// if the admin holds ANY content area), but its rows span every content entity
// unfiltered — an admin without the sermons grant must never see a sermon row
// (each row links straight into the entity's editor, which would 403 on click).
describe('dashboard recent-revisions rows respect the viewer’s area grants', () => {
  it('admin granted only groups+events does not see a sermon revision row (dead 403 link)', async () => {
    // Isolated storage rolls back per FILE (see file-top comment), so this insert
    // is visible to every later test in this file too — harmless, since it is
    // only ever read back by entity_id 999.
    await env.DB.prepare(
      `INSERT INTO revisions (entity, entity_id, snapshot_json, edited_by) VALUES ('sermon', 999, '{}', 'e2e-finding2')`,
    ).run();

    const lydia = await sessionCookie(11, 'lydia.kwan@example.com'); // groups,events — no sermons
    const lydiaHtml = await (await get('/admin', { cookie: lydia })).text();
    expect(lydiaHtml).not.toContain('href="/admin/sermons/999"');

    const admin = await sessionCookie(1, 'admin@example.com'); // super admin: keeps all rows
    const adminHtml = await (await get('/admin', { cookie: admin })).text();
    expect(adminHtml).toContain('href="/admin/sermons/999"');
  });
});
