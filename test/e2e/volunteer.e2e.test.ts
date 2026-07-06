// Volunteer-facing e2e against the BUILT worker (SELF.fetch): /my access +
// accept flow, the public token iCal feed, the public apply flow (signed-out
// person upsert + magic-link token + pending-unique + honeypot), and the
// profile self-update privilege strip. Session cookies are minted with the pure
// session lib for seeded people (session_epoch 0) — no mail round-trip.
//
// Seed anchors (seed/dev-seed.sql): person 5 (mark.liu, Worship Team member)
// holds the only pending 'U' assignment (plan 1, Vocalist, 2026-07-12);
// person 3 (sarah) has a confirmed assignment on the same plan.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, post } from './helpers';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

describe('/en/my (authed)', () => {
  it('anonymous GET → 303 to signin', async () => {
    const res = await get('/en/my');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/signin');
  });

  it('a member sees their pending request and accepting flips it to C', async () => {
    const cookie = await sessionCookie(5, 'mark.liu@example.com');
    const page = await get('/en/my', { cookie });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('Vocalist'); // the pending panel row
    expect(body).toContain('Awaiting your response');

    const pending = await env.DB
      .prepare(`SELECT id FROM roster_assignments WHERE person_id = 5 AND status = 'U' AND deleted_at IS NULL`)
      .first<{ id: number }>();
    expect(pending).not.toBeNull();

    const res = await post('/en/my', `_action=accept&assignment_id=${pending!.id}`, { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/my');

    const after = await env.DB
      .prepare(`SELECT status FROM roster_assignments WHERE id = ?`)
      .bind(pending!.id)
      .first<{ status: string }>();
    expect(after?.status).toBe('C');
  });

  it("cannot respond to someone else's assignment (no-op)", async () => {
    const cookie = await sessionCookie(5, 'mark.liu@example.com');
    // Assignment 1 belongs to person 3 (sarah), status C in the seed.
    const res = await post('/en/my', `_action=decline&assignment_id=1&reason=nope`, { cookie });
    expect(res.status).toBe(303);
    const row = await env.DB
      .prepare(`SELECT status, person_id FROM roster_assignments WHERE id = 1`)
      .first<{ status: string; person_id: number }>();
    expect(row).toMatchObject({ status: 'C', person_id: 3 });
  });
});

describe('/cal/[token].ics (public token feed)', () => {
  const TOKEN = '00e2e000000000000000000000000e2e';

  it('serves text/calendar with the person’s VEVENTs for a valid token', async () => {
    await env.DB.prepare(`UPDATE people SET calendar_token = ? WHERE id = 3`).bind(TOKEN).run();
    const res = await get(`/cal/${TOKEN}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    const ics = await res.text();
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    // UID host derives from APP_ORIGIN (https://church.example in e2e vars).
    expect(ics).toMatch(/UID:c4c-assignment-\d+@church\.example/);
    // Sarah's seeded assignment: Worship Leader on the English service (timed).
    expect(ics).toContain('SUMMARY:Worship Leader — Sunday Worship (English)');
    expect(ics).toContain('DTSTART:20260712T093000');
    expect(ics).toContain('\r\n');
  });

  it('404s an unknown token and an inactive person', async () => {
    expect((await get('/cal/ffffffffffffffffffffffffffffffff.ics')).status).toBe(404);

    await env.DB.prepare(`UPDATE people SET calendar_token = ?, active = 0 WHERE id = 3`).bind(TOKEN).run();
    expect((await get(`/cal/${TOKEN}.ics`)).status).toBe(404);
  });
});

describe('/en/serve/apply (public)', () => {
  it('signed-out POST creates a minimal person, a pending application, and a login token; a duplicate is indistinguishable', async () => {
    const email = 'applicant.e2e@example.com';
    const res = await post(
      '/en/serve/apply',
      `team_id=2&name=New+Applicant&email=${encodeURIComponent(email)}&phone=555-0000&message=hi`,
    );
    expect(res.status).toBe(303);
    const freshLocation = res.headers.get('location')!;
    expect(freshLocation).toBe('/en/serve/apply?sent=1&signin=1');

    const person = await env.DB
      .prepare(`SELECT id, display_name, role, active FROM people WHERE email = ?`)
      .bind(email)
      .first<{ id: number; display_name: string; role: string; active: number }>();
    expect(person).toMatchObject({ display_name: 'New Applicant', role: 'member', active: 1 });

    const app = await env.DB
      .prepare(`SELECT status, team_id FROM team_applications WHERE person_id = ?`)
      .bind(person!.id)
      .first<{ status: string; team_id: number }>();
    expect(app).toMatchObject({ status: 'P', team_id: 2 });

    // Magic link issued (EMAIL_DEV_LOG=1: mail devlogged, token row persisted).
    const tokensOf = async () =>
      (await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM tokens WHERE person_id = ? AND purpose = 'login'`)
        .bind(person!.id)
        .first<{ n: number }>())!.n;
    expect(await tokensOf()).toBe(1);
    const freshBody = await (await get(freshLocation)).text();

    // ANTI-ENUMERATION: a second signed-out application for the same team must
    // be byte-identical to a fresh success — same redirect (no dup flag), same
    // rendered body — while writing no duplicate row and still sending the
    // magic link so the person can sign in and see their pending application.
    const dup = await post(
      '/en/serve/apply',
      `team_id=2&name=New+Applicant&email=${encodeURIComponent(email)}`,
    );
    expect(dup.status).toBe(303);
    const dupLocation = dup.headers.get('location')!;
    expect(dupLocation).toBe(freshLocation);
    expect(dupLocation).not.toContain('dup');
    const dupBody = await (await get(dupLocation)).text();
    expect(dupBody).toBe(freshBody);

    const count = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM team_applications WHERE person_id = ?`)
      .bind(person!.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1); // no duplicate application
    expect(await tokensOf()).toBe(2); // magic link sent again
  });

  it('honeypot POST lands on the exact same success state and writes nothing', async () => {
    const res = await post('/en/serve/apply', 'team_id=2&name=Bot&email=bot@example.com&website=spam');
    expect(res.status).toBe(303);
    // Same redirect target as a genuine signed-out submission — no tell.
    expect(res.headers.get('location')).toBe('/en/serve/apply?sent=1&signin=1');
    const person = await env.DB
      .prepare(`SELECT id FROM people WHERE email = 'bot@example.com'`)
      .first<{ id: number }>();
    expect(person).toBeNull();
  });

  it('signed-in POST applies as the session user; a signed-in duplicate shows the friendly note', async () => {
    const cookie = await sessionCookie(5, 'mark.liu@example.com');
    // Team 3 (Hospitality) — mark has no application there in the seed.
    const res = await post('/en/serve/apply', 'team_id=3&name=Impostor&email=other@example.com', { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/serve/apply?sent=1');
    const app = await env.DB
      .prepare(`SELECT person_id, status FROM team_applications WHERE team_id = 3 AND person_id = 5`)
      .first<{ person_id: number; status: string }>();
    expect(app).toMatchObject({ person_id: 5, status: 'P' });
    // No person was created for the posted email.
    expect(await env.DB.prepare(`SELECT id FROM people WHERE email = 'other@example.com'`).first()).toBeNull();

    // Signed-in duplicate → the dup flag and the "already applied" note (the
    // user owns the account, nothing leaks).
    const dup = await post('/en/serve/apply', 'team_id=3', { cookie });
    expect(dup.status).toBe(303);
    expect(dup.headers.get('location')).toBe('/en/serve/apply?sent=1&dup=1');
    const dupBody = await (await get(dup.headers.get('location')!, { cookie })).text();
    expect(dupBody).toContain('You already have an application with this team');

    // The dup flag is session-gated: hand-typing it anonymously renders the
    // neutral success, not the note.
    const anonBody = await (await get('/en/serve/apply?sent=1&dup=1')).text();
    expect(anonBody).not.toContain('You already have an application with this team');
  });
});

describe('/en/profile self-update privilege strip', () => {
  it('saves the personal fields but keeps email/role/active unchanged', async () => {
    const cookie = await sessionCookie(5, 'mark.liu@example.com');
    const res = await post(
      '/en/profile',
      'display_name=Mark+Updated&first_name=Mark&last_name=Liu&phone=555-9999&lang=en' +
        '&role=admin&email=stolen@example.com', // privileged fields — must be stripped
      { cookie },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/profile?saved=1');

    const row = await env.DB
      .prepare(`SELECT display_name, phone, lang, role, active, email FROM people WHERE id = 5`)
      .first<{ display_name: string; phone: string; lang: string; role: string; active: number; email: string }>();
    expect(row).toMatchObject({
      display_name: 'Mark Updated',
      phone: '555-9999',
      lang: 'en',
      role: 'member', // NOT admin
      active: 1, // 'active' checkbox absent from the POST yet still active
      email: 'mark.liu@example.com',
    });
  });

  it('replaces interests from the checklist form', async () => {
    const cookie = await sessionCookie(5, 'mark.liu@example.com');
    const res = await post('/en/profile', '_action=saveInterests&interest=worship&interest=care&interest=bogus', {
      cookie,
    });
    expect(res.status).toBe(303);
    const { results } = await env.DB
      .prepare(`SELECT category FROM person_interests WHERE person_id = 5 ORDER BY category`)
      .all<{ category: string }>();
    expect(results.map((r) => r.category)).toEqual(['care', 'worship']); // 'bogus' filtered

    await post('/en/profile', '_action=saveInterests&interest=youth', { cookie });
    const after = await env.DB
      .prepare(`SELECT category FROM person_interests WHERE person_id = 5 ORDER BY category`)
      .all<{ category: string }>();
    expect(after.results.map((r) => r.category)).toEqual(['youth']);
  });

  it('persists self-service birthday/address but never membership_status/joined_on', async () => {
    const cookie = await sessionCookie(5, 'mark.liu@example.com');
    // The POST smuggles admin-only membership fields alongside the legit ones.
    const res = await post(
      '/en/profile',
      'display_name=Mark+Liu&first_name=Mark&last_name=Liu&phone=555-0000&lang=en' +
        '&birthday=1990-05-15&address=42+Grace+St' +
        '&membership_status=member&joined_on=2020-01-01',
      { cookie },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/profile?saved=1');

    const row = await env.DB
      .prepare(`SELECT birthday, address, membership_status, joined_on FROM people WHERE id = 5`)
      .first<{ birthday: string; address: string; membership_status: string; joined_on: string | null }>();
    expect(row).toMatchObject({
      birthday: '1990-05-15', // self-service field DID persist
      address: '42 Grace St',
      membership_status: 'visitor', // admin-only — the smuggled 'member' was ignored
      joined_on: null, // admin-only — never set here
    });
  });
});

describe('/en/profile household card (self-service)', () => {
  it('round-trips create → add dependent → edit → leave for the signed-in member', async () => {
    const cookie = await sessionCookie(6, 'faithful.wang@example.com'); // no household in the seed

    // Create — the creator becomes the adult + primary member.
    const created = await post(
      '/en/profile',
      '_action=createHousehold&name=Wang+Family&address=1+Hope+Ln&phone=555-7000',
      { cookie },
    );
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toBe('/en/profile?household=1');
    const hh = await env.DB
      .prepare(`SELECT id, name FROM households WHERE deleted_at IS NULL AND name = 'Wang Family'`)
      .first<{ id: number; name: string }>();
    expect(hh).not.toBeNull();
    const primary = await env.DB
      .prepare(`SELECT person_id, role, is_primary FROM household_members WHERE household_id = ? AND person_id = 6`)
      .bind(hh!.id)
      .first<{ person_id: number; role: string; is_primary: number }>();
    expect(primary).toMatchObject({ person_id: 6, role: 'adult', is_primary: 1 });

    // Add a name-only child dependent.
    const added = await post('/en/profile', '_action=addDependent&display_name=Baby+Wang&role=child', { cookie });
    expect(added.status).toBe(303);
    const dep = await env.DB
      .prepare(`SELECT display_name, role, person_id FROM household_members WHERE household_id = ? AND person_id IS NULL`)
      .bind(hh!.id)
      .first<{ display_name: string; role: string; person_id: number | null }>();
    expect(dep).toMatchObject({ display_name: 'Baby Wang', role: 'child', person_id: null });

    // Edit the household name.
    const edited = await post('/en/profile', '_action=updateHousehold&name=Wang+Household&address=&phone=', { cookie });
    expect(edited.status).toBe(303);
    const renamed = await env.DB.prepare(`SELECT name FROM households WHERE id = ?`).bind(hh!.id).first<{ name: string }>();
    expect(renamed?.name).toBe('Wang Household');

    // Leave — last real member, so the household soft-deletes and its dependent
    // is hard-deleted (a dependent cannot outlive its household).
    const left = await post('/en/profile', '_action=leaveHousehold', { cookie });
    expect(left.status).toBe(303);
    const gone = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM household_members WHERE household_id = ?`)
      .bind(hh!.id)
      .first<{ n: number }>();
    expect(gone?.n).toBe(0);
    const soft = await env.DB
      .prepare(`SELECT deleted_at FROM households WHERE id = ?`)
      .bind(hh!.id)
      .first<{ deleted_at: string | null }>();
    expect(soft?.deleted_at).not.toBeNull();
  });

  it('rejects a second household for someone already in one', async () => {
    const cookie = await sessionCookie(7, 'amy.chen@example.com');
    expect((await post('/en/profile', '_action=createHousehold&name=First+Home', { cookie })).status).toBe(303);
    // A second create surfaces the localized "already in a household" error (no redirect).
    const dupe = await post('/en/profile', '_action=createHousehold&name=Second+Home', { cookie });
    expect(dupe.status).toBe(200);
    expect(await dupe.text()).toContain('You already belong to a household.');
    const count = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM households h
         JOIN household_members hm ON hm.household_id = h.id AND hm.person_id = 7
         WHERE h.deleted_at IS NULL`,
      )
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe('/en/serve/opportunities (public board)', () => {
  it('renders seeded teams + open slots and links to the apply flow with the team preselected', async () => {
    const page = await get('/en/serve/opportunities');
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('Worship Team'); // teams-accepting-applications section
    expect(body).toContain('Vocalist'); // an open self-signup slot (plan 1, position 2)
    expect(body).toContain('/en/serve/apply?team=1'); // Apply CTA carries the team

    // Following the CTA lands on the apply form with team 1 preselected.
    const apply = await get('/en/serve/apply?team=1');
    expect(apply.status).toBe(200);
    expect(await apply.text()).toContain('name="team_id" value="1"');
  });
});
