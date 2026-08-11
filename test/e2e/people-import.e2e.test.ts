// People + household CSV migration against the BUILT D1 worker. These tests
// exercise the real middleware, admin grant/module gates, multipart boundary,
// parser/preflight, and atomic D1 batch. Uploaded values stay fictional and are
// never printed so a failed assertion cannot put migration data into CI logs.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PEOPLE_IMPORT_HEADERS, type PeopleImportHeader } from '../../src/lib/peopleImport';
import { PEOPLE_IMPORT_MULTIPART_MAX_BYTES } from '../../src/lib/peopleImportHttp';
import { MODULE_KEYS } from '../../src/lib/modules';
import { mintSession, SESSION_COOKIE } from '../../src/lib/session';
import { get, ORIGIN, post } from './helpers';

const SECRET = (env as unknown as { SESSION_SECRET: string }).SESSION_SECRET;
const PAGE = '/admin/people/import';
const TEMPLATE = `${PAGE}/template.csv`;
const PREVIEW = `${PAGE}/preview`;
const COMMIT = `${PAGE}/commit`;

type RecordInput = Partial<Record<PeopleImportHeader, string>>;

async function sessionCookie(id: number, email: string): Promise<string> {
  const jwt = await mintSession(SECRET, { id, email, sessionEpoch: 0 });
  return `${SESSION_COOKIE}=${jwt}`;
}

function modulesBody(disabled: string[]): string {
  const body = new URLSearchParams();
  body.append('action', 'modules');
  for (const key of MODULE_KEYS) {
    if (!disabled.includes(key)) body.append(`module.${key}`, '1');
  }
  return body.toString();
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csv(records: RecordInput[]): string {
  const rows = [
    PEOPLE_IMPORT_HEADERS.join(','),
    ...records.map((record) =>
      PEOPLE_IMPORT_HEADERS.map((header) => csvCell(record[header] ?? '')).join(',')),
  ];
  return `${rows.join('\n')}\n`;
}

function standalonePerson(email: string, displayName: string): string {
  return csv([{ record_type: 'person', display_name: displayName, email }]);
}

function familyCsv(
  prefix: string,
  householdName = 'Migration Example Family',
  dependentName = 'Casey Migration',
): string {
  return csv([
    {
      record_type: 'person',
      display_name: 'Jordan Migration',
      email: `${prefix}.primary@example.com`,
      first_name: 'Jordan',
      last_name: 'Migration',
      phone: '(555) 010-8101',
      language: 'en',
      membership_status: 'member',
      birthday: '1984-05-06',
      joined_on: '2020-01-02',
      address: '101 Example Avenue',
      active: 'true',
      household_key: `${prefix}-family`,
      household_name: householdName,
      household_address: '101 Example Avenue',
      household_phone: '(555) 010-8101',
      household_role: 'adult',
      household_primary: 'true',
    },
    {
      record_type: 'person',
      display_name: 'Riley Migration',
      email: `${prefix}.secondary@example.com`,
      first_name: 'Riley',
      last_name: 'Migration',
      language: 'zh',
      membership_status: 'visitor',
      active: 'false',
      household_key: `${prefix}-family`,
      household_role: 'child',
      household_primary: 'false',
    },
    {
      record_type: 'dependent',
      display_name: dependentName,
      household_key: `${prefix}-family`,
      household_role: 'child',
      household_primary: 'false',
    },
  ]);
}

async function upload(
  path: string,
  cookie: string,
  contents: string,
  options: { acknowledge?: boolean; origin?: string; type?: string } = {},
): Promise<Response> {
  const form = new FormData();
  form.set('csv', new File([contents], 'people.csv', { type: options.type ?? 'text/csv' }));
  if (options.acknowledge) form.set('acknowledge_warnings', 'true');
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { cookie, origin: options.origin ?? ORIGIN },
    body: form,
    redirect: 'manual',
  });
}

async function tableCounts(): Promise<{
  people: number;
  households: number;
  members: number;
  emailLog: number;
}> {
  const count = async (table: string): Promise<number> => {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return row?.n ?? -1;
  };
  return {
    people: await count('people'),
    households: await count('households'),
    members: await count('household_members'),
    emailLog: await count('email_log'),
  };
}

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
     VALUES (60, 'Lena', 'Limited', 'Lena Limited', 'lena.import-limited@example.com', 'admin', 0, 'bulletins')
     ON CONFLICT(id) DO NOTHING`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO people (id, first_name, last_name, display_name, email, role, super_admin, admin_areas)
     VALUES (61, 'Paula', 'People', 'Paula People', 'paula.import-people@example.com', 'admin', 0, 'people')
     ON CONFLICT(id) DO NOTHING`,
  ).run();
});

// Module enablement is cached outside isolated D1 storage. Re-post the all-on
// state after every case so a failed module-off assertion cannot poison later
// tests in this worker isolate.
afterEach(async () => {
  const admin = await sessionCookie(1, 'admin@example.com');
  await post('/admin/settings', modulesBody([]), { cookie: admin });
});

describe('people import access boundary', () => {
  it('redirects anonymous page requests and rejects member, editor, and ungranted admins before parsing', async () => {
    const anonymous = await get(PAGE);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe('/en/signin?next=%2Fadmin%2Fpeople%2Fimport');

    const denied = [
      await sessionCookie(3, 'sarah.johnson@example.com'),
      await sessionCookie(2, 'pastor.david@example.com'),
      await sessionCookie(60, 'lena.import-limited@example.com'),
    ];
    for (const cookie of denied) {
      expect((await get(PAGE, { cookie })).status).toBe(403);
      const api = await post(PREVIEW, 'not=multipart', { cookie });
      expect(api.status).toBe(403);
    }
  });

  it('lets both a people-granted admin and the super admin use page, template, preview, and commit', async () => {
    const actors = [
      {
        cookie: await sessionCookie(61, 'paula.import-people@example.com'),
        csv: standalonePerson('granted.import@example.com', 'Granted Import'),
      },
      {
        cookie: await sessionCookie(1, 'admin@example.com'),
        csv: standalonePerson('super.import@example.com', 'Super Import'),
      },
    ];

    for (const actor of actors) {
      const page = await get(PAGE, { cookie: actor.cookie });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(TEMPLATE);
      expect((await get(TEMPLATE, { cookie: actor.cookie })).status).toBe(200);

      const preview = await upload(PREVIEW, actor.cookie, actor.csv);
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ ok: true, summary: { people: 1 } });

      const commit = await upload(COMMIT, actor.cookie, actor.csv);
      expect(commit.status).toBe(201);
      expect(await commit.json()).toEqual({
        ok: true,
        counts: { people: 1, households: 0, dependents: 0 },
      });
    }
  });

  it('returns method contracts, canonical template headers, and blocks cross-origin writes', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    for (const path of [PREVIEW, COMMIT]) {
      const response = await get(path, { cookie: admin });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
    const templatePost = await post(TEMPLATE, '', { cookie: admin });
    expect(templatePost.status).toBe(405);
    expect(templatePost.headers.get('allow')).toBe('GET');

    const template = await get(TEMPLATE, { cookie: admin });
    expect(template.status).toBe(200);
    expect(template.headers.get('cache-control')).toContain('no-store');
    const header = (await template.text()).split('\n')[0].split(',');
    expect(header).toEqual(PEOPLE_IMPORT_HEADERS);
    expect(header).toHaveLength(18);

    const before = await tableCounts();
    for (const path of [PREVIEW, COMMIT]) {
      const response = await upload(
        path,
        admin,
        standalonePerson('cross-origin.import@example.com', 'Cross Origin'),
        { origin: 'https://cross-origin.example' },
      );
      expect(response.status).toBe(403);
    }
    expect(await tableCounts()).toEqual(before);
  });

  it('404s the whole import subtree when people is off, hides its directory link, then restores it', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    expect((await post('/admin/settings', modulesBody(['people']), { cookie: admin })).status).toBe(303);

    expect((await get(PAGE, { cookie: admin })).status).toBe(404);
    expect((await get(TEMPLATE, { cookie: admin })).status).toBe(404);
    expect((await post(PREVIEW, 'body-must-not-be-read', { cookie: admin })).status).toBe(404);
    expect((await post(COMMIT, 'body-must-not-be-read', { cookie: admin })).status).toBe(404);

    const directory = await get('/admin/people', { cookie: admin });
    expect(directory.status).toBe(200);
    expect(await directory.text()).not.toContain(PAGE);

    expect((await post('/admin/settings', modulesBody([]), { cookie: admin })).status).toBe(303);
    expect((await get(PAGE, { cookie: admin })).status).toBe(200);
    expect(await (await get('/admin/people', { cookie: admin })).text()).toContain(PAGE);
  });
});

describe('people import request and privacy boundary', () => {
  it('returns bounded safe errors for non-multipart, malformed, oversized, and malicious uploads', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');

    const nonMultipart = await post(PREVIEW, 'csv=not-a-file', { cookie: admin });
    expect(nonMultipart.status).toBe(415);
    expect(await nonMultipart.json()).toEqual({ ok: false, code: 'multipart_required' });

    const malformed = await SELF.fetch(`${ORIGIN}${PREVIEW}`, {
      method: 'POST',
      headers: {
        cookie: admin,
        origin: ORIGIN,
        'content-type': 'multipart/form-data; boundary=broken',
      },
      body: 'not a valid multipart envelope',
      redirect: 'manual',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ ok: false, code: 'multipart_invalid' });

    const oversized = await SELF.fetch(`${ORIGIN}${PREVIEW}`, {
      method: 'POST',
      headers: {
        cookie: admin,
        origin: ORIGIN,
        'content-type': 'multipart/form-data; boundary=oversized',
      },
      body: new Uint8Array(PEOPLE_IMPORT_MULTIPART_MAX_BYTES + 1),
      redirect: 'manual',
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ ok: false, code: 'file_too_large' });

    const privateMarker = '<script>PRIVATE_IMPORT_CELL_7391</script>';
    const invalid = csv([{
      record_type: 'person',
      display_name: privateMarker.repeat(5),
      email: 'private-invalid@example.com',
    }]);
    const rejected = await upload(PREVIEW, admin, invalid);
    expect(rejected.status).toBe(200);
    const rejectionBody = await rejected.text();
    expect(rejectionBody).toContain('"code":"too_long"');
    expect(rejectionBody).not.toContain(privateMarker);

    const page = await get(PAGE, { cookie: admin });
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain(privateMarker);
  });

  it('previews a valid family without writing people, households, members, or email log rows', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const before = await tableCounts();
    const response = await upload(PREVIEW, admin, familyCsv('preview-zero'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.json()).toMatchObject({
      ok: true,
      summary: { dataRows: 3, people: 2, dependents: 1, households: 1, inactivePeople: 1 },
      issues: [],
    });
    expect(await tableCounts()).toEqual(before);
  });
});

describe('people import commit semantics', () => {
  it('requires acknowledgement for an existing household name and then creates a separate household', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const contents = familyCsv('warning-copy', 'Chen Family 陈家');
    const before = await tableCounts();

    const preview = await upload(PREVIEW, admin, contents);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      ok: true,
      issues: [{ severity: 'warning', code: 'household_name_exists', row: 2, field: 'household_name' }],
    });

    const blocked = await upload(COMMIT, admin, contents);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ ok: false, code: 'warnings_not_acknowledged' });
    expect(await tableCounts()).toEqual(before);

    const committed = await upload(COMMIT, admin, contents, { acknowledge: true });
    expect(committed.status).toBe(201);
    expect(await committed.json()).toEqual({
      ok: true,
      counts: { people: 2, households: 1, dependents: 1 },
    });

    const imported = await env.DB.prepare(
      `SELECT h.id AS household_id, h.name AS household_name
       FROM people p
       JOIN household_members hm ON hm.person_id = p.id
       JOIN households h ON h.id = hm.household_id
       WHERE p.email = 'warning-copy.primary@example.com'`,
    ).first<{ household_id: number; household_name: string }>();
    expect(imported).toMatchObject({ household_name: 'Chen Family 陈家' });
    expect(imported?.household_id).not.toBe(1);
    const sameName = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM households WHERE name = 'Chen Family 陈家' AND deleted_at IS NULL`,
    ).first<{ n: number }>();
    expect(sameName?.n).toBe(2);
  });

  it('rolls back every row when a late dependent membership insert fails', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const dependentMarker = 'Private Rollback Dependent 9843';
    const databaseMarker = 'PRIVATE_DB_TRIGGER_9843';
    const before = await tableCounts();

    await env.DB.prepare(
      `CREATE TRIGGER e2e_people_import_late_abort
       BEFORE INSERT ON household_members
       WHEN NEW.person_id IS NULL AND NEW.display_name = 'Private Rollback Dependent 9843'
       BEGIN
         SELECT RAISE(ABORT, 'PRIVATE_DB_TRIGGER_9843');
       END`,
    ).run();
    try {
      const response = await upload(
        COMMIT,
        admin,
        familyCsv('late-rollback', 'Rollback Example Family', dependentMarker),
      );
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ ok: false, code: 'import_failed' });
      expect(body).not.toContain(dependentMarker);
      expect(body).not.toContain(databaseMarker);
      expect(await tableCounts()).toEqual(before);
    } finally {
      await env.DB.prepare('DROP TRIGGER IF EXISTS e2e_people_import_late_abort').run();
    }
  });

  it('atomically imports family relationships with safe defaults and rejects a duplicate submit without side effects', async () => {
    const admin = await sessionCookie(1, 'admin@example.com');
    const contents = familyCsv('atomic-family');
    const before = await tableCounts();

    const first = await upload(COMMIT, admin, contents);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      ok: true,
      counts: { people: 2, households: 1, dependents: 1 },
    });

    const people = await env.DB.prepare(
      `SELECT email, role, active, super_admin, admin_areas, session_epoch, deleted_at
       FROM people WHERE email IN ('atomic-family.primary@example.com', 'atomic-family.secondary@example.com')
       ORDER BY email`,
    ).all<{
      email: string;
      role: string;
      active: number;
      super_admin: number;
      admin_areas: string;
      session_epoch: number;
      deleted_at: string | null;
    }>();
    expect(people.results).toEqual([
      {
        email: 'atomic-family.primary@example.com',
        role: 'member',
        active: 1,
        super_admin: 0,
        admin_areas: '',
        session_epoch: 0,
        deleted_at: null,
      },
      {
        email: 'atomic-family.secondary@example.com',
        role: 'member',
        active: 0,
        super_admin: 0,
        admin_areas: '',
        session_epoch: 0,
        deleted_at: null,
      },
    ]);

    const members = await env.DB.prepare(
      `SELECT hm.display_name, p.email, hm.role, hm.is_primary, hm.person_id IS NULL AS dependent
       FROM household_members hm
       JOIN households h ON h.id = hm.household_id
       LEFT JOIN people p ON p.id = hm.person_id
       WHERE h.name = 'Migration Example Family'
       ORDER BY hm.id`,
    ).all<{
      display_name: string;
      email: string | null;
      role: string;
      is_primary: number;
      dependent: number;
    }>();
    expect(members.results).toEqual([
      {
        display_name: 'Jordan Migration',
        email: 'atomic-family.primary@example.com',
        role: 'adult',
        is_primary: 1,
        dependent: 0,
      },
      {
        display_name: 'Riley Migration',
        email: 'atomic-family.secondary@example.com',
        role: 'child',
        is_primary: 0,
        dependent: 0,
      },
      {
        display_name: 'Casey Migration',
        email: null,
        role: 'child',
        is_primary: 0,
        dependent: 1,
      },
    ]);

    const afterFirst = await tableCounts();
    expect(afterFirst).toEqual({
      people: before.people + 2,
      households: before.households + 1,
      members: before.members + 3,
      emailLog: before.emailLog,
    });

    const duplicate = await upload(COMMIT, admin, contents, { acknowledge: true });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ ok: false, code: 'import_conflict' });
    expect(await tableCounts()).toEqual(afterFirst);
  });
});
