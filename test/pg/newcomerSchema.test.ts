import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const NEWCOMER_TABLES = [
  'newcomer_activity',
  'newcomer_answers',
  'newcomer_field_i18n',
  'newcomer_field_option_i18n',
  'newcomer_field_options',
  'newcomer_fields',
  'newcomer_notes',
  'newcomer_rate_limits',
  'newcomer_status_i18n',
  'newcomer_statuses',
  'newcomer_submissions',
];

const STATUS_ROWS = [
  [1, 'open', 1, 1, 1, 'New', '新朋友'],
  [2, 'open', 2, 1, 0, 'Assigned', '已分配'],
  [3, 'open', 3, 1, 0, 'Contacted', '已联系'],
  [4, 'closed', 4, 1, 0, 'Connected', '已连接'],
  [5, 'closed', 5, 1, 0, 'Closed', '已关闭'],
];

function submission(values: string): string {
  return `INSERT INTO newcomer_submissions
    (id,name,email,phone,locale,visit_date,service_type_id,contact_consent_at,source,status_id,
     assignee_person_id,linked_person_id,next_follow_up_date,version,last_mutation_id,closed_at,deleted_at,
     created_at,updated_at)
    VALUES (${values})`;
}

describe.skipIf(!hasPg)('newcomer foundation schema (real Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    await sql.unsafe(`
      INSERT INTO people (id,display_name,email) VALUES
        (9801,'Newcomer Owner','newcomer-owner@example.test'),
        (9802,'Newcomer Author','newcomer-author@example.test');
      INSERT INTO service_types (id,sort) VALUES (9801,1);
    `);
  });

  afterAll(async () => {
    await sql?.end();
  });

  async function rejects(statement: string, code?: string): Promise<void> {
    const expectation = expect(sql.unsafe(statement)).rejects;
    if (code) await expectation.toMatchObject({ code });
    else await expectation.toBeTruthy();
  }

  it('creates the same eleven shared tables with non-identity stable catalog IDs and exact bilingual status seed', async () => {
    const tables = await sql.unsafe<{ table_name: string }[]>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'newcomer_%' ORDER BY table_name
    `);
    expect(tables.map((row) => row.table_name)).toEqual(NEWCOMER_TABLES);

    const identities = await sql.unsafe<{ table_name: string; is_identity: string }[]>(`
      SELECT table_name,is_identity FROM information_schema.columns
      WHERE table_schema='public' AND column_name='id'
        AND table_name IN ('newcomer_statuses','newcomer_fields') ORDER BY table_name
    `);
    expect(identities).toEqual([
      expect.objectContaining({ table_name: 'newcomer_fields', is_identity: 'NO' }),
      expect.objectContaining({ table_name: 'newcomer_statuses', is_identity: 'NO' }),
    ]);

    const rows = await sql.unsafe<Record<string, string | number>[]>(`
      SELECT s.id,s.category,s.sort,s.active,s.is_initial,en.label AS en_label,zh.label AS zh_label
      FROM newcomer_statuses s
      JOIN newcomer_status_i18n en ON en.status_id=s.id AND en.locale='en'
      JOIN newcomer_status_i18n zh ON zh.status_id=s.id AND zh.locale='zh'
      ORDER BY s.id
    `);
    expect(rows.map((row) => [
      Number(row.id), row.category, Number(row.sort), Number(row.active), Number(row.is_initial), row.en_label, row.zh_label,
    ])).toEqual(STATUS_ROWS);
  });

  it('repeats workflow, field, option, and single-initial constraint behavior', async () => {
    for (const statement of [
      "INSERT INTO newcomer_statuses (id,category,sort,active,is_initial) VALUES (90,'closed',90,1,1)",
      "INSERT INTO newcomer_statuses (id,category,sort,active,is_initial) VALUES (91,'open',91,0,1)",
      "INSERT INTO newcomer_statuses (id,category,sort,active,is_initial) VALUES (92,'open',92,1,1)",
      "INSERT INTO newcomer_statuses (id,category,sort,active,is_initial) VALUES (93,'pending',93,1,0)",
      "INSERT INTO newcomer_statuses (id,category,sort,active,is_initial) VALUES (94,'open',-1,2,0)",
      "INSERT INTO newcomer_status_i18n (status_id,locale,label) VALUES (1,'fr','Nouveau')",
      "INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (91,'bad','radio',0,1,1,0)",
      "INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (92,'BAD KEY','text',0,1,1,0)",
      "INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (93,'bad_bool','text',2,1,1,0)",
      "INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (999,'missing',1,1)",
    ]) await rejects(statement);

    await sql.unsafe("INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (90,'custom_path','select',1,1,90,0)");
    await sql.unsafe("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (90,'first_visit',1,1)");
    await sql.unsafe("INSERT INTO newcomer_field_option_i18n (field_id,value,locale,label) VALUES (90,'first_visit','zh','首次到访')");
    await rejects("INSERT INTO newcomer_field_option_i18n (field_id,value,locale,label) VALUES (90,'missing','en','Missing')", '23503');
  });

  it('repeats normalized contact, strict date/timestamp, enum, range, UUID, and FK behavior', async () => {
    await sql.unsafe(`INSERT INTO newcomer_submissions
      (id,name,email,phone,locale,visit_date,service_type_id,contact_consent_at,source,next_follow_up_date)
      VALUES ('10000000-0000-4000-8000-000000000001','Ada Visitor','ada@example.test','+13125550100',
        'en','2028-02-29',9801,'2026-08-12 12:00:00','public','2026-08-20')`);
    const [stored] = await sql.unsafe<{ status_id: number; version: number }[]>(`
      SELECT status_id,version FROM newcomer_submissions WHERE id='10000000-0000-4000-8000-000000000001'
    `);
    expect(stored).toMatchObject({ status_id: 1, version: 0 });

    const base = (id: string, overrides: Partial<Record<string, string>> = {}) => submission([
      overrides.id ?? `'${id}'`, overrides.name ?? "'Visitor'", overrides.email ?? 'NULL', overrides.phone ?? 'NULL',
      overrides.locale ?? "'en'", overrides.visitDate ?? "'2026-08-12'", overrides.serviceType ?? 'NULL',
      overrides.consentAt ?? 'NULL', overrides.source ?? "'public'", overrides.status ?? '1',
      overrides.assignee ?? 'NULL', overrides.linked ?? 'NULL', overrides.followUp ?? 'NULL',
      overrides.version ?? '0', overrides.mutation ?? 'NULL', overrides.closedAt ?? 'NULL', overrides.deletedAt ?? 'NULL',
      overrides.createdAt ?? "'2026-08-12 12:00:00'", overrides.updatedAt ?? "'2026-08-12 12:00:00'",
    ].join(','));
    const invalid = [
      base('not-a-uuid'),
      base('10000000-0000-4000-8000-000000000002', { name: 'NULL' }),
      base('10000000-0000-4000-8000-000000000003', { email: "'Ada@Example.test'" }),
      base('10000000-0000-4000-8000-000000000004', { phone: "' +13125550100'" }),
      base('10000000-0000-4000-8000-000000000005', { locale: "'fr'" }),
      base('10000000-0000-4000-8000-000000000006', { visitDate: "'2026-02-30'" }),
      base('10000000-0000-4000-8000-000000000007', { followUp: "'abcd-01-01'" }),
      base('10000000-0000-4000-8000-000000000008', { source: "'import'" }),
      base('10000000-0000-4000-8000-000000000009', { version: '-1' }),
      base('10000000-0000-4000-8000-00000000000a', { mutation: `''` }),
      base('10000000-0000-4000-8000-00000000000b', { consentAt: "'2026-02-30 12:00:00'" }),
      base('10000000-0000-4000-8000-00000000000c', { deletedAt: "'2026-08-12 25:00:00'" }),
      base('10000000-0000-4000-8000-00000000000d', { serviceType: '999999' }),
      base('10000000-0000-4000-8000-00000000000e', { status: '999999' }),
      base('10000000-0000-4000-8000-00000000000f', { assignee: '999999' }),
      base('10000000-0000-4000-8000-000000000010', { linked: '999999' }),
    ];
    for (const statement of invalid) await rejects(statement);
  });

  it('repeats bounded answer/note and PII-safe structural activity behavior', async () => {
    await sql.unsafe(submission(`
      '20000000-0000-4000-8000-000000000001','Answer Owner',NULL,NULL,'zh','2026-08-12',NULL,NULL,
      'staff',1,9802,NULL,NULL,0,NULL,NULL,NULL,'2026-08-12 12:00:00','2026-08-12 12:00:00'
    `));
    await sql.unsafe("INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (98,'custom_question','textarea',0,1,98,0)");
    await sql.unsafe(`INSERT INTO newcomer_answers (submission_id,field_id,value)
      VALUES ('20000000-0000-4000-8000-000000000001',98,'Bounded answer')`);
    await sql.unsafe(`INSERT INTO newcomer_notes (id,submission_id,author_person_id,body,created_at)
      VALUES ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',9802,
      'Private follow-up note','2026-08-12 12:01:00')`);
    await sql.unsafe(`INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind,metadata_json,created_at)
      VALUES ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',9802,
      'person_linked','{"person_id":9802}','2026-08-12 12:02:00')`);

    for (const statement of [
      `INSERT INTO newcomer_answers (submission_id,field_id,value)
       VALUES ('20000000-0000-4000-8000-000000000001',98,'${'x'.repeat(4001)}')`,
      `INSERT INTO newcomer_notes (id,submission_id,author_person_id,body)
       VALUES ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',9802,'')`,
      `INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
       VALUES ('40000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','emailed','{}')`,
      `INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
       VALUES ('40000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','submission_created','not json')`,
      `INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
       VALUES ('40000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001','submission_created','[]')`,
      `INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
       VALUES ('40000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000001','submission_created','{"email":"private@example.test"}')`,
      `INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
       VALUES ('40000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000001','person_linked','{"person_id":"9802"}')`,
    ]) await rejects(statement);
  });

  it('repeats canonical HMAC, ten-minute window, attempt range, unique bucket, and exact 48-hour expiry behavior', async () => {
    const hash = 'a'.repeat(64);
    await sql.unsafe(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${hash}','2026-08-12 12:10:00',1,'2026-08-14 12:10:00')`);
    for (const statement of [
      `INSERT INTO newcomer_rate_limits VALUES ('${'A'.repeat(64)}','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${'b'.repeat(63)}','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${'b'.repeat(64)}','2026-08-12 12:11:00',1,'2026-08-14 12:11:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${'c'.repeat(64)}','2026-02-30 12:20:00',1,'2026-03-04 12:20:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${'d'.repeat(64)}','2026-08-12 12:20:00',0,'2026-08-14 12:20:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${'e'.repeat(64)}','2026-08-12 12:20:00',1,'2026-08-14 12:19:59')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${hash}','2026-08-12 12:10:00',2,'2026-08-14 12:10:00')`,
    ]) await rejects(statement);
  });
});
