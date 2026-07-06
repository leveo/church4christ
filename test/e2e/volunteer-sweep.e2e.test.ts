// Slice-6 volunteer e2e sweep — the gap-fill file on top of volunteer.e2e /
// console.e2e / gifts-testimonies.e2e / auth.e2e. Covers, end-to-end against the
// BUILT worker: the cron functions invoked directly against the e2e DB, the full
// magic-link→accept→iCal journey, the open-slot claim journey (no email for a
// self-claim), member-added blockout → leader conflict → force (+request mail),
// decline → every team leader mailed, the apply/approve email touchpoints, the
// gifts→interests→potential-volunteers pipeline, and the volunteer-surface role
// matrix (/serve/plans + the adminOnly consoles).
//
// Seed anchors (seed/dev-seed.sql): person 3 sarah (leads team 1), 4 grace (NO
// team, 'U' on plan 9), 5 mark (team-1 member, 'U' on plan 1 Vocalist), 6
// faithful (leads team 3), 7 amy (team-1 member, 'D' on plan 1), 8 ben (leads
// team 2, 'C' on plan 1 Sound), 9 esther (team-3 member, pending application to
// team 1, app id 1). Plans 1/9 fall on the first upcoming Sunday = sunday(0);
// plan 2 on the next Sunday = sunday(1). The seed's dates are relative (see seed
// header), so fake cron clocks and date assertions derive from the sunday()
// helper instead of pinned calendar dates.
//
// Tests that revisit rows an earlier test may have touched reset them first (or
// assert via id-deltas / kind-scoped counts), so the file passes whether the
// pool rolls storage back per test or per file.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { cookiePair, get, icalDate, post, sunday } from './helpers';
import { createLoginToken } from '../../src/lib/auth';
import { sendReminders, sendWeeklyDigest } from '../../src/lib/digest';
import { type EmailEnv } from '../../src/lib/email';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const emailEnv = env as unknown as EmailEnv;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

function rawOf(res: { raw: string } | { rateLimited: true }): string {
  if ('rateLimited' in res) throw new Error('expected a token, got rateLimited');
  return res.raw;
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
}

const maxEmailLogId = async (): Promise<number> =>
  (await env.DB.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM email_log`).first<{ m: number }>())!.m;

// ── Checklist 9: cron functions invoked DIRECTLY against the e2e DB ──
describe('cron functions against the e2e DB (rule-gated)', () => {
  // The Sunday before the first upcoming Sunday; +7d = sunday(0), the seeded plan
  // date with two still-'U' assignments (mark on plan 1, grace on plan 9). Noon
  // UTC so the America/Chicago wall date the reminder pass reads equals sunday(-1).
  const remindersNow = new Date(`${sunday(-1)}T12:00:00Z`);

  it('sendReminders: disabled rule → 0; enabled remind7 re-nudges every still-U 7 days out', async () => {
    await env.DB.prepare(`UPDATE email_rules SET enabled = 0 WHERE rule_key = 'remind7'`).run();
    const before = await maxEmailLogId();
    expect(await sendReminders(emailEnv, env.DB, remindersNow)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM email_log WHERE id > ?`, before)).toBe(0);

    await env.DB.prepare(`UPDATE email_rules SET enabled = 1 WHERE rule_key = 'remind7'`).run();
    expect(await sendReminders(emailEnv, env.DB, remindersNow)).toBe(2);
    for (const email of ['mark.liu@example.com', 'grace.lin@example.com']) {
      expect(
        await count(
          `SELECT COUNT(*) AS n FROM email_log WHERE id > ? AND kind = 'request' AND status = 'devlog' AND to_email = ?`,
          before,
          email,
        ),
      ).toBe(1);
    }
    // The re-nudge stamps notified_at on both unconfirmed assignments.
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM roster_assignments
         WHERE status = 'U' AND deleted_at IS NULL AND notified_at IS NOT NULL
           AND plan_id IN (1, 9)`,
      ),
    ).toBe(2);
  });

  it('sendWeeklyDigest: gated by digestAM; one devlog row per person with next-7d assignments', async () => {
    // Window [today, today+7): anchor on sunday(0) so plans 1/9 fall inside while
    // plan 2/10 (sunday(1)) stays out. Noon UTC → the wall date reads sunday(0).
    const digestNow = new Date(`${sunday(0)}T12:00:00Z`);

    await env.DB.prepare(`UPDATE email_rules SET enabled = 0 WHERE rule_key = 'digestAM'`).run();
    expect(await sendWeeklyDigest(emailEnv, env.DB, digestNow)).toEqual([]);

    await env.DB.prepare(`UPDATE email_rules SET enabled = 1 WHERE rule_key = 'digestAM'`).run();
    const before = await maxEmailLogId();
    const sent = await sendWeeklyDigest(emailEnv, env.DB, digestNow);
    // Non-declined sunday(0) assignees: sarah C, mark U, ben C, pastor david C,
    // grace U. Amy's 'D' must NOT get a digest. Exactly one mail per person.
    const expected = [
      'sarah.johnson@example.com',
      'mark.liu@example.com',
      'ben.wu@example.com',
      'pastor.david@example.com',
      'grace.lin@example.com',
    ];
    expect(new Set(sent).size).toBe(sent.length);
    for (const email of expected) expect(sent).toContain(email);
    expect(sent).not.toContain('amy.chen@example.com');
    expect(
      await count(`SELECT COUNT(*) AS n FROM email_log WHERE id > ? AND kind = 'digest' AND status = 'devlog'`, before),
    ).toBe(sent.length);
  });
});

// ── Checklist 1: full member journey, magic link → /my → accept → iCal ──
describe('full volunteer journey (magic link → pending → accept → iCal)', () => {
  it('signs in via magic link, sees the pending request, accepts, and the event lands in the token feed', async () => {
    // Reset mark's seeded request in case an earlier test in this file consumed it.
    await env.DB
      .prepare(
        `UPDATE roster_assignments SET status = 'U', responded_at = NULL, decline_reason = NULL
         WHERE plan_id = 1 AND position_id = 2 AND person_id = 5`,
      )
      .run();

    // Magic-link sign-in as mark (member, lang zh → lands on /zh/my).
    const raw = rawOf(await createLoginToken(env.DB, 5));
    const consumed = await post(`/auth/${raw}`, '');
    expect(consumed.status).toBe(303);
    expect(consumed.headers.get('location')).toBe('/zh/my');
    const cookie = cookiePair(consumed.headers.get('set-cookie'));
    expect(cookie).toContain(`${SESSION_COOKIE}=`);

    // /my shows the pending Vocalist request.
    const page = await get('/en/my', { cookie });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('Vocalist');
    expect(body).toContain('Awaiting your response');

    // Accept → C.
    const pending = await env.DB
      .prepare(`SELECT id FROM roster_assignments WHERE plan_id = 1 AND position_id = 2 AND person_id = 5`)
      .first<{ id: number }>();
    const accept = await post('/en/my', `_action=accept&assignment_id=${pending!.id}`, { cookie });
    expect(accept.status).toBe(303);
    const after = await env.DB
      .prepare(`SELECT status FROM roster_assignments WHERE id = ?`)
      .bind(pending!.id)
      .first<{ status: string }>();
    expect(after?.status).toBe('C');

    // The confirmed assignment appears in mark's calendar token feed, without
    // the unconfirmed '(?)' marker.
    const TOKEN = '00e2e000000000000000000000000f01';
    await env.DB.prepare(`UPDATE people SET calendar_token = ? WHERE id = 5`).bind(TOKEN).run();
    const ics = await (await get(`/cal/${TOKEN}.ics`)).text();
    expect(ics).toContain('SUMMARY:Vocalist — Sunday Worship (English)');
    expect(ics).not.toContain('Vocalist — Sunday Worship (English) (?)');
    expect(ics).toContain(`DTSTART:${icalDate(0)}T093000`);
  });
});

// ── Checklist 2: open-slot claim journey (self-claim sends NO email) ──
describe('open-slot claim journey', () => {
  it("a team member claims a seeded open slot → 'C' is_signup, shows under /my upcoming, and no email is written", async () => {
    // Esther (9) is a Hospitality member; plan 1 Greeter (position 8) is open
    // (needed 2, no assignees).
    const cookie = await sessionCookie(9, 'esther.lin@example.com');
    const before = await maxEmailLogId();

    const res = await post('/en/my', '_action=claim&plan_id=1&position_id=8', { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/my?claimed=1');

    const row = await env.DB
      .prepare(`SELECT status, is_signup FROM roster_assignments WHERE plan_id = 1 AND position_id = 8 AND person_id = 9`)
      .first<{ status: string; is_signup: number }>();
    expect(row).toMatchObject({ status: 'C', is_signup: 1 });

    const body = await (await get('/en/my?claimed=1', { cookie })).text();
    expect(body).toContain('You are signed up. Thank you for serving!');
    expect(body).toContain('Greeter'); // now in the upcoming list

    // A self-claim needs no scheduling-request round-trip: no email_log row of
    // ANY kind may have been written by the claim.
    expect(await count(`SELECT COUNT(*) AS n FROM email_log WHERE id > ?`, before)).toBe(0);
  });
});

// ── Checklists 3 + 10: member blockout → leader assign conflict → force ──
describe('blockout → conflict → force flow (leader session)', () => {
  it('member-added blockout blocks the assign with a rendered warning; force creates U + request devlog', async () => {
    // Mark blocks out plan 2's date (the second upcoming Sunday) through his own page.
    const markCookie = await sessionCookie(5, 'mark.liu@example.com');
    const add = await post('/en/my/blockouts', `_action=add&start_date=${sunday(1)}&reason=Camping`, {
      cookie: markCookie,
    });
    expect(add.status).toBe(303);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM blockout_dates WHERE person_id = 5 AND start_date = ? AND end_date = ?`,
        sunday(1),
        sunday(1),
      ),
    ).toBe(1);

    // Sarah (leader of Worship Team) assigns mark to plan 2's Worship Leader →
    // the page re-renders (200) with the conflict panel instead of writing.
    const sarahCookie = await sessionCookie(3, 'sarah.johnson@example.com');
    const conflicted = await post('/en/serve/plans/2', '_action=assign&position_id=1&person_id=5', {
      cookie: sarahCookie,
    });
    expect(conflicted.status).toBe(200);
    const html = await conflicted.text();
    expect(html).toContain('Blocked-out date');
    expect(html).toContain('Camping');
    expect(html).toContain('Assign anyway');
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM roster_assignments WHERE plan_id = 2 AND position_id = 1 AND person_id = 5 AND deleted_at IS NULL`,
      ),
    ).toBe(0);

    // Force → 303, assignment exists as 'U', and the scheduling request went out.
    const before = await maxEmailLogId();
    const forced = await post('/en/serve/plans/2', '_action=assign&position_id=1&person_id=5&force=1', {
      cookie: sarahCookie,
    });
    expect(forced.status).toBe(303);
    expect(forced.headers.get('location')).toBe('/en/serve/plans/2');
    const row = await env.DB
      .prepare(
        `SELECT status, is_signup FROM roster_assignments WHERE plan_id = 2 AND position_id = 1 AND person_id = 5 AND deleted_at IS NULL`,
      )
      .first<{ status: string; is_signup: number }>();
    expect(row).toMatchObject({ status: 'U', is_signup: 0 });
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM email_log
         WHERE id > ? AND kind = 'request' AND status = 'devlog'
           AND to_email = 'mark.liu@example.com' AND detail LIKE ?`,
        before,
        `${sunday(1)}%`,
      ),
    ).toBe(1);
  });
});

// ── Checklist 4: decline → EVERY team leader notified ──
describe('decline → leaders notified', () => {
  it('a /my decline with a reason writes a decline devlog row to each leader of the team', async () => {
    // Give Worship Team a second leader so "each leader" is a real plural.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE roster_assignments SET status = 'U', responded_at = NULL, decline_reason = NULL
         WHERE plan_id = 1 AND position_id = 2 AND person_id = 5`,
      ),
      env.DB.prepare(`UPDATE team_members SET is_leader = 1 WHERE team_id = 1 AND person_id = 7`),
    ]);
    const pending = await env.DB
      .prepare(`SELECT id FROM roster_assignments WHERE plan_id = 1 AND position_id = 2 AND person_id = 5`)
      .first<{ id: number }>();

    const before = await maxEmailLogId();
    const cookie = await sessionCookie(5, 'mark.liu@example.com');
    const res = await post(
      '/en/my',
      `_action=decline&assignment_id=${pending!.id}&reason=${encodeURIComponent('Traveling that week')}`,
      { cookie },
    );
    expect(res.status).toBe(303);

    const row = await env.DB
      .prepare(`SELECT status, decline_reason FROM roster_assignments WHERE id = ?`)
      .bind(pending!.id)
      .first<{ status: string; decline_reason: string | null }>();
    expect(row).toMatchObject({ status: 'D', decline_reason: 'Traveling that week' });

    for (const leader of ['sarah.johnson@example.com', 'amy.chen@example.com']) {
      expect(
        await count(
          `SELECT COUNT(*) AS n FROM email_log WHERE id > ? AND kind = 'decline' AND status = 'devlog' AND to_email = ?`,
          before,
          leader,
        ),
      ).toBe(1);
    }
  });
});

// ── Checklist 5: signed-out apply → leader notification + magic link ──
describe('apply → leader notification email', () => {
  it('a signed-out application writes the appReceived devlog row to the team leader (plus P row + login token)', async () => {
    const before = await maxEmailLogId();
    const email = 'sweep.applicant@example.com';
    const res = await post(
      '/en/serve/apply',
      `team_id=2&name=Sweep+Applicant&email=${encodeURIComponent(email)}`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/serve/apply?sent=1&signin=1');

    const person = await env.DB
      .prepare(`SELECT id FROM people WHERE email = ?`)
      .bind(email)
      .first<{ id: number }>();
    expect(person).not.toBeNull();
    expect(
      await count(`SELECT COUNT(*) AS n FROM team_applications WHERE person_id = ? AND team_id = 2 AND status = 'P'`, person!.id),
    ).toBe(1);
    expect(
      await count(`SELECT COUNT(*) AS n FROM tokens WHERE person_id = ? AND purpose = 'login'`, person!.id),
    ).toBe(1);
    // Ben leads the AV Team → the received notice lands in his devlog.
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM email_log WHERE id > ? AND kind = 'appReceived' AND status = 'devlog' AND to_email = 'ben.wu@example.com'`,
        before,
      ),
    ).toBe(1);
  });
});

// ── Checklist 6: application approve → membership + applicant result email ──
describe('application approve → membership + result email', () => {
  it('a leader approving the seeded application creates the team_members row and emails the applicant', async () => {
    const before = await maxEmailLogId();
    // Seeded pending application id 1: esther (9) → Worship Team (1).
    const cookie = await sessionCookie(3, 'sarah.johnson@example.com');
    const res = await post('/en/serve/teams/1', '_action=decideApp&application_id=1&decision=approve', { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/serve/teams/1');

    const app = await env.DB
      .prepare(`SELECT status, decided_by FROM team_applications WHERE id = 1`)
      .first<{ status: string; decided_by: string | null }>();
    expect(app).toMatchObject({ status: 'A', decided_by: 'sarah.johnson@example.com' });
    expect(await count(`SELECT COUNT(*) AS n FROM team_members WHERE team_id = 1 AND person_id = 9`)).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM email_log WHERE id > ? AND kind = 'appResult' AND status = 'devlog' AND to_email = 'esther.lin@example.com'`,
        before,
      ),
    ).toBe(1);
  });
});

// ── Checklist 7: gifts → interests → potential-volunteers pipeline ──
describe('gifts → interests → potential volunteers', () => {
  it("mark's hospitality-heavy quiz + add-interests surfaces him on the Hospitality team page with both badges", async () => {
    // Hospitality-tagged statements (q6/15/24/32/40) at 'Always', rest 'Never'.
    const hospitality = new Set([6, 15, 24, 32, 40]);
    const answers = Array.from({ length: 40 }, (_, i) => `q${i + 1}=${hospitality.has(i + 1) ? 3 : 0}`).join('&');

    const markCookie = await sessionCookie(5, 'mark.liu@example.com');
    const quiz = await post('/en/serve/gifts', answers, { cookie: markCookie });
    expect(quiz.status).toBe(200);
    expect(await quiz.text()).toContain('Hospitality'); // top gift card

    const saved = await env.DB
      .prepare(`SELECT recommended_json FROM gift_results WHERE person_id = 5 ORDER BY id DESC LIMIT 1`)
      .first<{ recommended_json: string }>();
    expect(JSON.parse(saved!.recommended_json)).toContain('hospitality');

    // Second POST: add the recommended categories to his interests.
    const added = await post('/en/serve/gifts', '_action=addInterests&top=hospitality&rec=hospitality&rec=family', {
      cookie: markCookie,
    });
    expect(added.status).toBe(200);
    expect(await added.text()).toContain('Added to your ministry interests');
    expect(
      await count(`SELECT COUNT(*) AS n FROM person_interests WHERE person_id = 5 AND category = 'hospitality'`),
    ).toBe(1);

    // Faithful (leader of the Hospitality team, category 'hospitality') now sees
    // mark in the potential-volunteers panel, badged by BOTH sources. The seed
    // has no other hospitality interest/recommendation, so the panel is new.
    const leaderCookie = await sessionCookie(6, 'faithful.wang@example.com');
    const page = await get('/en/serve/teams/3', { cookie: leaderCookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Potential volunteers');
    expect(html).toContain('Mark Liu 刘马可');
    expect(html).toContain('Gifts quiz'); // via_gift badge
    expect(html).toContain('Interested'); // via_interest badge
  });
});

// ── Checklist 8: role matrix on the volunteer surfaces ──
describe('volunteer-surface role matrix', () => {
  it('/serve/plans: anon→303 signin, no-team person→403, team member→200', async () => {
    const anon = await get('/en/serve/plans');
    expect(anon.status).toBe(303);
    expect(anon.headers.get('location')).toContain('/signin');

    // Grace (4) is an active member of NO team → the team class 403s her.
    expect((await get('/en/serve/plans', { cookie: await sessionCookie(4, 'grace.lin@example.com') })).status).toBe(403);
    // Mark (5) is a Worship Team member.
    expect((await get('/en/serve/plans', { cookie: await sessionCookie(5, 'mark.liu@example.com') })).status).toBe(200);
  });

  it('/admin/reports and /admin/service-types stay adminOnly (leader 403, admin 200)', async () => {
    const leaderCookie = await sessionCookie(3, 'sarah.johnson@example.com');
    const adminCookie = await sessionCookie(1, 'admin@example.com');
    expect((await get('/admin/reports', { cookie: leaderCookie })).status).toBe(403);
    expect((await get('/admin/reports', { cookie: adminCookie })).status).toBe(200);
    expect((await get('/admin/service-types', { cookie: leaderCookie })).status).toBe(403);
    expect((await get('/admin/service-types', { cookie: adminCookie })).status).toBe(200);
  });
});
