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

  it('promotes and demotes a household owner from the admin console', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    // Household 1 (Chen Family) / member 1 is David Chen (person 2, adult, linked, has email).
    const promote = await post('/admin/people/2', 'action=setOwner&member_id=1&household_id=1', { cookie: admin });
    expect(promote.status).toBe(303);

    const afterPromote = await env.DB
      .prepare('SELECT is_owner FROM household_members WHERE id = 1')
      .first<{ is_owner: number }>();
    expect(afterPromote?.is_owner).toBe(1);

    const pageAfterPromote = await (await get('/admin/people/2', { cookie: admin })).text();
    expect(pageAfterPromote).toContain('value="unsetOwner"');

    const demote = await post('/admin/people/2', 'action=unsetOwner&member_id=1&household_id=1', { cookie: admin });
    expect(demote.status).toBe(303);

    const afterDemote = await env.DB
      .prepare('SELECT is_owner FROM household_members WHERE id = 1')
      .first<{ is_owner: number }>();
    expect(afterDemote?.is_owner).toBe(0);
  });

  it('surfaces owner_limit as a page notice instead of a crash', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    // Fill household 1 (Chen Family) to the 2-owner cap with its two seeded
    // adults (members 1 and 2), then add a third eligible adult (person 5,
    // Mark — has email, not seeded into any household) directly and try to
    // promote them past the cap.
    await post('/admin/people/2', 'action=setOwner&member_id=1&household_id=1', { cookie: admin });
    await post('/admin/people/2', 'action=setOwner&member_id=2&household_id=1', { cookie: admin });

    const third = await env.DB
      .prepare(
        `INSERT INTO household_members (household_id, person_id, display_name, role, is_primary)
         VALUES (1, 5, 'Mark Liu', 'adult', 0) RETURNING id`,
      )
      .first<{ id: number }>();

    const res = await post('/admin/people/2', `action=setOwner&member_id=${third!.id}&household_id=1`, { cookie: admin });
    expect(res.status).toBe(200); // falls through to re-render with a notice, no redirect
    expect(await res.text()).toContain('maximum of 2 owners');

    const owners = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM household_members WHERE household_id = 1 AND is_owner = 1')
      .first<{ n: number }>();
    expect(owners?.n).toBe(2);

    // Clean up so later tests in this file see the seeded state unchanged.
    await env.DB.prepare('DELETE FROM household_members WHERE id = ?').bind(third!.id).run();
    await env.DB.prepare('UPDATE household_members SET is_owner = 0 WHERE household_id = 1').run();
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

  it('withholds a seeded household, address, dependent, birthday, and note from a leader profile view (spec §B)', async () => {
    const leader = await sessionCookie(3, 'sarah.johnson@example.com');
    // Person 2 (David Chen) carries the seeded Chen Family household (with an
    // address and a name-only child dependent Ethan Chen), a birthday, and an
    // admin pastoral note — none of which may render on a leader's /profile/[id].
    const leaderView = await get('/en/profile/2', { cookie: leader });
    expect(leaderView.status).toBe(200);
    const body = await leaderView.text();

    // Positive control: his own display name IS shown to the leader.
    expect(body).toContain('陈大卫 David Chen');

    // Private membership data is all withheld (REAL seeded strings).
    expect(body).not.toContain('Chen Family'); // household name
    expect(body).not.toContain('88 Cornerstone Way'); // household + personal address
    expect(body).not.toContain('Ethan Chen'); // dependent child
    expect(body).not.toContain('1978-04-12'); // birthday
    expect(body).not.toContain('Met with David to plan the fall newcomers class'); // pastoral note
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

  it('reports an unsendable invite honestly (?invited=0 + failure notice, no fake success)', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    // Person 9 (Esther) deactivated → sendServeInvite returns false.
    await env.DB.prepare('UPDATE people SET active = 0 WHERE id = 9').run();

    const res = await post('/admin/people/9', 'action=invite&team_id=1', { cookie: admin });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/people/9?invited=0');

    const body = await (await get('/admin/people/9?invited=0', { cookie: admin })).text();
    expect(body).toContain('Could not send the invitation');
    expect(body).not.toContain('Invitation sent.');

    const row = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM email_log WHERE to_email = 'esther.lin@example.com' AND kind = 'outreach'`)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
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
