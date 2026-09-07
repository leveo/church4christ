// Real rendered-page coverage for the Sanctuary module bodies. Every GET goes
// through the built Worker, middleware, request-scoped Postgres client and Astro
// renderer. Consume the entire HTML stream: a status-only assertion can miss a
// query failure after streaming has begun. No renderer/provider mocks or POSTs.
// The existing PG harness reseeds once per file; run on an isolated test DB.
import { env } from 'cloudflare:test';
import postgres from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { t } from '../../src/lib/i18n';
import { get } from '../e2e/helpers';

const bindings = env as unknown as {
  SESSION_SECRET: string;
  HYPERDRIVE: { connectionString: string };
};
type Actor = 'admin' | 'member' | 'groupLeader';
const cookies: Record<Actor, string> = { admin: '', member: '', groupLeader: '' };
const fixture = {
  memberId: 0, memberName: '', teamId: 0, teamName: '', candidateName: '',
  ministryId: 0, ministrySlug: '', groupId: 0, groupName: '',
  planId: 0, serviceTypeId: 0, serviceName: '',
  newcomerId: '', newcomerName: '', courseId: 0, courseName: '',
  bulletinId: 0, sermonId: 0, prayerSheetId: 0,
  registrationId: 0, registrationTitle: 'Design smoke community supper',
  householdId: 0, householdName: '', kioskToken: '',
};

beforeAll(async () => {
  const sql = postgres(bindings.HYPERDRIVE.connectionString, {
    max: 1, fetch_types: false, prepare: false, onnotice: () => {},
  });
  try {
    // Select actors by the actual dev-seed identities; do not guess numeric IDs
    // or manufacture authorization on the request. Middleware still loads each
    // person's role, grants, team memberships and epoch from this database.
    const people = await sql.unsafe<{ id: number; email: string; display_name: string; session_epoch: number }[]>(
      `SELECT id,email,display_name,session_epoch FROM people
       WHERE email IN ('admin@example.com','sarah.johnson@example.com','ben.wu@example.com')`,
    );
    const actorEmails: Record<Actor, string> = {
      admin: 'admin@example.com', member: 'sarah.johnson@example.com', groupLeader: 'ben.wu@example.com',
    };
    for (const actor of Object.keys(actorEmails) as Actor[]) {
      const person = people.find(row => row.email === actorEmails[actor]);
      if (!person) throw new Error(`design surfaces: missing seeded ${actor}`);
      cookies[actor] = `${SESSION_COOKIE}=${await mintSession(bindings.SESSION_SECRET, {
        id: person.id, email: person.email, sessionEpoch: person.session_epoch,
      })}`;
      if (actor === 'member') {
        fixture.memberId = person.id;
        fixture.memberName = person.display_name;
      }
    }

    const [team] = await sql.unsafe<{ id: number; name: string; ministry_id: number; slug: string; category: string }[]>(
      `SELECT tm.team_id AS id,ti.name,t.ministry_id,m.slug,m.category
       FROM team_members tm JOIN teams t ON t.id=tm.team_id
       JOIN team_i18n ti ON ti.team_id=t.id AND ti.locale='en'
       JOIN ministries m ON m.id=t.ministry_id
       WHERE tm.person_id=$1 AND tm.is_leader=1 ORDER BY t.id LIMIT 1`, [fixture.memberId],
    );
    if (!team) throw new Error('design surfaces: seeded member must lead a ministry team');
    Object.assign(fixture, { teamId: team.id, teamName: team.name, ministryId: team.ministry_id, ministrySlug: team.slug });
    const [candidate] = await sql.unsafe<{ display_name: string }[]>(
      `SELECT p.display_name FROM people p JOIN person_interests pi ON pi.person_id=p.id
       JOIN gift_results gr ON gr.person_id=p.id
       WHERE pi.category=$1 AND gr.recommended_json::jsonb @> jsonb_build_array($1::text)
         AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.person_id=p.id AND tm.team_id=$2)
       ORDER BY p.id LIMIT 1`, [team.category, team.id],
    );
    if (!candidate) throw new Error('design surfaces: seed must contain a non-member interest/gift candidate');
    fixture.candidateName = candidate.display_name;

    const groupLeader = people.find(row => row.email === actorEmails.groupLeader)!;
    const [group] = await sql.unsafe<{ id: number; name: string }[]>(
      `SELECT g.id,g.name FROM groups g JOIN group_members gm ON gm.group_id=g.id
       WHERE gm.person_id=$1 AND gm.is_admin=1 AND g.is_public=1 ORDER BY g.id LIMIT 1`, [groupLeader.id],
    );
    const [plan] = await sql.unsafe<{ id: number; service_type_id: number; name: string }[]>(
      `SELECT p.id,p.service_type_id,st.name FROM plans p
       JOIN service_type_i18n st ON st.service_type_id=p.service_type_id AND st.locale='en'
       JOIN plan_positions pp ON pp.plan_id=p.id JOIN positions pos ON pos.id=pp.position_id
       WHERE pos.team_id=$1 AND p.deleted_at IS NULL ORDER BY p.id LIMIT 1`, [team.id],
    );
    const [newcomer] = await sql.unsafe<{ id: string; name: string }[]>(
      "SELECT id,name FROM newcomer_submissions WHERE email='jamie.new@example.com' AND deleted_at IS NULL",
    );
    const [course] = await sql.unsafe<{ id: number; display_name: string }[]>(
      "SELECT id,display_name FROM learning_courses WHERE external_course_id='genesis-1-creation'",
    );
    const [household] = await sql.unsafe<{ id: number; name: string }[]>(
      `SELECT h.id,h.name FROM households h JOIN household_members hm ON hm.household_id=h.id
       WHERE hm.role='child' ORDER BY h.id LIMIT 1`,
    );
    const [kiosk] = await sql.unsafe<{ value: string }[]>("SELECT value FROM settings WHERE key='children.kiosk_token'");
    const [bulletin] = await sql.unsafe<{ id: number }[]>('SELECT id FROM bulletins ORDER BY id LIMIT 1');
    const [sermon] = await sql.unsafe<{ id: number }[]>('SELECT id FROM sermons ORDER BY id LIMIT 1');
    const [prayerSheet] = await sql.unsafe<{ id: number }[]>('SELECT id FROM prayer_sheets ORDER BY id LIMIT 1');
    if (!group || !plan || !newcomer || !course || !household || !kiosk || !bulletin || !sermon || !prayerSheet) {
      throw new Error('design surfaces: required dev-seed detail record is missing');
    }
    Object.assign(fixture, {
      groupId: group.id, groupName: group.name, planId: plan.id,
      serviceTypeId: plan.service_type_id, serviceName: plan.name,
      newcomerId: newcomer.id, newcomerName: newcomer.name,
      courseId: course.id, courseName: course.display_name,
      householdId: household.id, householdName: household.name, kioskToken: kiosk.value,
      bulletinId: bulletin.id, sermonId: sermon.id, prayerSheetId: prayerSheet.id,
    });

    // dev-seed intentionally has no registration events. Create a real free,
    // open event and question so public/admin detail pages exercise their query
    // paths and form rendering without Stripe or external provider traffic.
    const [event] = await sql.unsafe<{ id: number }[]>(
      `INSERT INTO reg_events (starts_at,location,capacity,price_cents,active)
       VALUES (datetime('now','+7 days'),'Fellowship Hall',30,0,1) RETURNING id`,
    );
    fixture.registrationId = event.id;
    await sql.unsafe('INSERT INTO reg_event_i18n (event_id,locale,title,description) VALUES ($1,\'en\',$2,$3)',
      [event.id, fixture.registrationTitle, 'A fictional event created only for PostgreSQL render coverage.']);
    const [question] = await sql.unsafe<{ id: number }[]>(
      "INSERT INTO reg_questions (event_id,sort,type,required) VALUES ($1,1,'text',0) RETURNING id", [event.id],
    );
    await sql.unsafe("INSERT INTO reg_question_i18n (question_id,locale,label) VALUES ($1,'en','Dietary needs')", [question.id]);
  } finally {
    await sql.end();
  }
});

/** Read the whole response and require the actual page body, not just a shell. */
async function rendered(path: string, actor?: Actor): Promise<string> {
  const response = await get(path, actor ? { cookie: cookies[actor] } : {});
  const html = await response.text();
  expect(response.status, path).toBe(200);
  expect(response.headers.get('content-type'), path).toContain('text/html');
  // Astro can append a page script after its layout's closing HTML element.
  expect(/<\/body>\s*<\/html>/i.test(html), `${path}: response stream must finish`).toBe(true);
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1].replace(/<[^>]*>/g, ' ').trim();
  expect(heading, `${path}: route must render a nonempty h1`).toBeTruthy();
  expect(heading, path).not.toMatch(/^(?:Internal Server Error|Not Found|404)$/i);
  return html;
}

describe('PostgreSQL design surfaces: administration', () => {
  it.each([
    '/admin', '/admin/settings', '/admin/navigation', '/admin/campuses',
    '/admin/onboarding', '/admin/activity-score', '/admin/reports',
    '/admin/groups', '/admin/people', '/admin/people/import',
    '/admin/people/export', '/admin/people/export-notes',
    '/admin/newcomers', '/admin/newcomers/new', '/admin/newcomers/settings',
    '/admin/registration', '/admin/giving', '/admin/giving/funds', '/admin/giving/reconcile',
    '/admin/stripe-events', '/admin/learning', '/admin/children', '/admin/attendance',
    '/admin/teams', '/admin/service-types', '/admin/testimonies', '/admin/prayer-wall',
    '/admin/bulletins', '/admin/sermons', '/admin/prayer-sheets',
    '/admin/events', '/admin/announcements', '/admin/pages',
  ])('%s renders its complete page body', async (path) => {
    await rendered(path, 'admin');
  });

  it.each(['overview', 'applications', 'ministries', 'new', 'email', 'availability'])(
    'renders the ministry %s tab with its own content', async (tab) => {
      const html = await rendered(`/admin/ministries?tab=${tab}`, 'admin');
      const content = html.match(/<div\b[^>]*class="[^\"]*\bmw-console-content\b[^\"]*"[^>]*>([\s\S]*)/)?.[1];
      expect(content, `${tab} content`).toBeDefined();
      // Require the selected body rather than accepting the navigation's label.
      const bodyMarkers: Record<string, string> = {
        overview: t('en', 'admin.console.needsAttention'),
        applications: fixture.candidateName,
        ministries: 'name="ministry_id"',
        new: 'data-wizard',
        email: 'name="template_key"',
        availability: fixture.memberName,
      };
      expect(content, tab).toContain(bodyMarkers[tab]);
    },
  );

  it.each([
    { name: 'person', path: () => `/admin/people/${fixture.memberId}`, marker: () => fixture.memberName },
    { name: 'group', path: () => `/admin/groups/${fixture.groupId}`, marker: () => fixture.groupName },
    { name: 'newcomer', path: () => `/admin/newcomers/${fixture.newcomerId}`, marker: () => fixture.newcomerName },
    { name: 'bulletin editor', path: () => `/admin/bulletins/${fixture.bulletinId}`, marker: () => '<form' },
    { name: 'sermon editor', path: () => `/admin/sermons/${fixture.sermonId}`, marker: () => '<form' },
    { name: 'prayer sheet editor', path: () => `/admin/prayer-sheets/${fixture.prayerSheetId}`, marker: () => '<form' },
    { name: 'registration', path: () => `/admin/registration/${fixture.registrationId}`, marker: () => fixture.registrationTitle },
  ])('renders the real $name detail', async ({ path, marker }) => {
    expect(await rendered(path(), 'admin')).toContain(marker());
  });

  it('renders the real registration question and the local learning connection', async () => {
    expect(await rendered(`/admin/registration/${fixture.registrationId}`, 'admin')).toContain('Dietary needs');
    expect(await rendered('/admin/learning', 'admin')).toContain('Local fictional Canvas snapshot');
    // Provider course-pickers need real OAuth credentials and network access;
    // they are deliberately outside this no-provider smoke suite.
  });
});

describe('PostgreSQL design surfaces: public and serving', () => {
  it.each([
    '/en/', '/en/visit', '/en/new-here', '/en/about', '/en/about/beliefs', '/en/about/staff',
    '/en/sermons', '/en/articles', '/en/bulletin', '/en/prayer', '/en/events',
    '/en/ministries', '/en/fellowships', '/en/groups', '/en/register',
    '/en/serve', '/en/serve/opportunities', '/en/serve/apply', '/en/serve/gifts', '/en/serve/testimonies',
  ])('%s renders its complete page body', async (path) => {
    await rendered(path);
  });

  it.each(['/en/serve/teams', '/en/serve/plans', '/en/serve/matrix', '/en/manage'])(
    '%s renders for a real team leader', async (path) => { await rendered(path, 'member'); },
  );

  it.each(['admin', 'member'] as const)('renders the real team and both recruitment sources for %s', async (actor) => {
    const html = await rendered(`/en/serve/teams/${fixture.teamId}`, actor);
    expect(html).toContain(fixture.teamName);
    const recruitment = html.match(/<section\b[^>]*id="team-recruit"[^>]*>([\s\S]*?)<\/section>/)?.[1];
    expect(recruitment).toBeDefined();
    expect(recruitment).toContain(fixture.candidateName);
    expect(recruitment).toContain(t('en', 'serve.teams.viaGift'));
    expect(recruitment).toContain(t('en', 'serve.teams.viaInterest'));
    expect(recruitment).toContain('name="_action" value="invite"');
  });

  it('renders the real plan and assignment forms for its leader', async () => {
    const html = await rendered(`/en/serve/plans/${fixture.planId}`, 'member');
    expect(html).toContain(fixture.serviceName);
    expect(html).toContain('name="position_id"');
  });

  it('renders the real service matrix for its leader', async () => {
    const html = await rendered(`/en/serve/matrix/${fixture.serviceTypeId}`, 'member');
    expect(html).toContain(fixture.serviceName);
    expect(html).toContain('<table');
  });

  it('renders the public ministry detail', async () => {
    expect(await rendered(`/en/ministries/${fixture.ministrySlug}`)).toContain(fixture.teamName);
  });

  it('renders the leader ministry editor', async () => {
    expect(await rendered(`/en/manage/ministries/${fixture.ministryId}`, 'member')).toContain('name="name_en"');
  });

  it('renders the real public group detail', async () => {
    expect(await rendered(`/en/groups/${fixture.groupId}`)).toContain(fixture.groupName);
  });

  it('renders the group workspace for its actual group administrator', async () => {
    expect(await rendered(`/en/groups/${fixture.groupId}/manage`, 'groupLeader')).toContain(fixture.groupName);
  });

  it('renders the real free registration and its dynamic question', async () => {
    const html = await rendered(`/en/register/${fixture.registrationId}`);
    expect(html).toContain(fixture.registrationTitle);
    expect(html).toContain('action="/api/register/submit"');
    expect(html).toContain('Dietary needs');
  });

  it('renders kiosk search and the seeded household child picker', async () => {
    expect(await rendered(`/kiosk/${fixture.kioskToken}`)).toContain('<form');
    expect(await rendered(`/kiosk/${fixture.kioskToken}/household/${fixture.householdId}`)).toContain(fixture.householdName);
  });
});

describe('PostgreSQL design surfaces: member portal and learning', () => {
  it.each([
    '/en/my', '/en/my/opportunities', '/en/my/household', '/en/my/events',
    '/en/my/serving', '/en/my/prayer', '/en/my/calendar', '/en/my/blockouts',
    '/en/my/giving', '/en/learn', '/en/profile',
  ])('%s renders for the seeded member', async (path) => { await rendered(path, 'member'); });

  it('renders the enrolled course player with its real lesson and submission snapshot', async () => {
    const html = await rendered(`/en/learn/${fixture.courseId}`, 'member');
    expect(html).toContain(fixture.courseName);
    expect(html).toContain('data-embed="https://www.youtube-nocookie.com/embed/DemoGen1Vid"');
    expect(html).toContain('Submitted');
    expect(html).toContain('Not submitted');
  });
});
