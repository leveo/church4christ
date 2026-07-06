// People admin + outreach e2e against the BUILT worker (SELF.fetch): the admin
// person editor persists membership status/birthday, manages households and
// pastoral notes; notes are admin-only and never leak onto a leader's
// /profile/[id]; leaders can invite for their own team (email_log 'outreach'
// row) but not a foreign team (403); and turning the people module off keeps the
// admin page's core fields while hiding every added panel. Session cookies are
// minted with the pure session lib for seeded people (session_epoch 0).
//
// Seed anchors: person 1 (admin), person 3 (Sarah, leads Worship = team 1),
// person 5 (Mark, member with email), person 6 (Faithful, no household).
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { MODULE_KEYS } from '../../src/lib/modules';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

function modulesBody(disabled: string[]): string {
  const body = new URLSearchParams();
  body.append('action', 'modules');
  for (const key of MODULE_KEYS) if (!disabled.includes(key)) body.append(`module.${key}`, '1');
  return body.toString();
}

describe('admin person editor (people module on)', () => {
  it('persists membership status + birthday from the save form', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const body =
      'action=save&display_name=Mark+Liu&first_name=Mark&last_name=Liu' +
      '&email=mark.liu@example.com&phone=&lang=zh&role=member&active=1' +
      '&birthday=1988-03-03&address=&membership_status=member&joined_on=';
    const res = await post('/admin/people/5', body, { cookie: admin });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/people/?saved=1');

    const row = await env.DB
      .prepare('SELECT membership_status, birthday, email FROM people WHERE id = 5')
      .first<{ membership_status: string; birthday: string; email: string }>();
    expect(row).toMatchObject({ membership_status: 'member', birthday: '1988-03-03', email: 'mark.liu@example.com' });
  });

  it('creates and links a household with the person as primary adult', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const res = await post('/admin/people/6', 'action=createHousehold&name=Wang+Home', { cookie: admin });
    expect(res.status).toBe(303);

    const hm = await env.DB
      .prepare(
        `SELECT h.name AS name, hm.role AS role, hm.is_primary AS is_primary
         FROM household_members hm JOIN households h ON h.id = hm.household_id
         WHERE hm.person_id = 6 AND h.deleted_at IS NULL`,
      )
      .first<{ name: string; role: string; is_primary: number }>();
    expect(hm).toMatchObject({ name: 'Wang Home', role: 'adult', is_primary: 1 });
  });

  it('shows a pastoral note to the admin but never on a leader profile view (privacy)', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const leader = await sessionCookie(3, 'sarah.johnson@example.com');
    const secret = 'PRIVATE_PASTORAL_NOTE_ZZZ';

    const add = await post('/admin/people/5', `action=addNote&body=${encodeURIComponent(secret)}`, { cookie: admin });
    expect(add.status).toBe(303);

    const adminView = await get('/admin/people/5', { cookie: admin });
    expect(await adminView.text()).toContain(secret);

    const leaderView = await get('/en/profile/5', { cookie: leader });
    expect(leaderView.status).toBe(200);
    const leaderBody = await leaderView.text();
    expect(leaderBody).not.toContain(secret);
    expect(leaderBody).not.toContain('Pastoral notes');
  });
});

describe('leader outreach invites', () => {
  it('lets a leader invite a person to their own team (outreach email logged)', async () => {
    const leader = await sessionCookie(3, 'sarah.johnson@example.com');
    const res = await post('/en/profile/5', '_action=invite&team_id=1', { cookie: leader });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/profile/5?invited=1');

    const row = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM email_log
         WHERE to_email = 'mark.liu@example.com' AND kind = 'outreach' AND status = 'devlog'`,
      )
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('blocks a leader inviting for a team they do not lead (403, nothing sent)', async () => {
    const leader = await sessionCookie(3, 'sarah.johnson@example.com');
    const outreachCount = async () =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_log WHERE kind = 'outreach'`).first<{ n: number }>())!.n;
    const before = await outreachCount();
    const res = await post('/en/profile/5', '_action=invite&team_id=3', { cookie: leader });
    expect(res.status).toBe(403);
    expect(await outreachCount()).toBe(before); // the guard runs before any send
  });
});

describe('people module off', () => {
  // Restore every module ON (and bust the per-isolate cache) after each test.
  afterEach(async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    await post('/admin/settings', modulesBody([]), { cookie: admin });
  });

  it('keeps the admin person page core fields but hides every added panel', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const off = await post('/admin/settings', modulesBody(['people']), { cookie: admin });
    expect(off.status).toBe(303);

    const page = await get('/admin/people/5', { cookie: admin });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('name="display_name"'); // core identity field stays
    expect(body).not.toContain('name="birthday"'); // membership depth gone
    expect(body).not.toContain('value="createHousehold"'); // household panel gone
    expect(body).not.toContain('value="addNote"'); // notes panel gone
    expect(body).not.toContain('value="invite"'); // invite panel gone

    // Directory core still serves; the membership-status filter is gone.
    const dir = await get('/admin/people', { cookie: admin });
    expect(dir.status).toBe(200);
    expect(await dir.text()).not.toContain('name="status"');
  });
});
