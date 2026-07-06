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
  it('signed-out POST creates a minimal person, a pending application, and a login token', async () => {
    const email = 'applicant.e2e@example.com';
    const res = await post(
      '/en/serve/apply',
      `team_id=2&name=New+Applicant&email=${encodeURIComponent(email)}&phone=555-0000&message=hi`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('sent=1');
    expect(res.headers.get('location')).toContain('signin=1');

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
    const token = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM tokens WHERE person_id = ? AND purpose = 'login'`)
      .bind(person!.id)
      .first<{ n: number }>();
    expect(token?.n).toBe(1);

    // A second pending application for the same team → friendly dup, still one row.
    const dup = await post(
      '/en/serve/apply',
      `team_id=2&name=New+Applicant&email=${encodeURIComponent(email)}`,
    );
    expect(dup.status).toBe(303);
    expect(dup.headers.get('location')).toContain('dup=1');
    const count = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM team_applications WHERE person_id = ?`)
      .bind(person!.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('honeypot POST pretends success and writes nothing', async () => {
    const res = await post('/en/serve/apply', 'team_id=2&name=Bot&email=bot@example.com&website=spam');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('sent=1');
    const person = await env.DB
      .prepare(`SELECT id FROM people WHERE email = 'bot@example.com'`)
      .first<{ id: number }>();
    expect(person).toBeNull();
  });

  it('signed-in POST applies as the session user, ignoring posted identity fields', async () => {
    const cookie = await sessionCookie(5, 'mark.liu@example.com');
    // Team 3 (Hospitality) — mark has no application there in the seed.
    const res = await post('/en/serve/apply', 'team_id=3&name=Impostor&email=other@example.com', { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('sent=1');
    const app = await env.DB
      .prepare(`SELECT person_id, status FROM team_applications WHERE team_id = 3 AND person_id = 5`)
      .first<{ person_id: number; status: string }>();
    expect(app).toMatchObject({ person_id: 5, status: 'P' });
    // No person was created for the posted email.
    expect(await env.DB.prepare(`SELECT id FROM people WHERE email = 'other@example.com'`).first()).toBeNull();
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
});
