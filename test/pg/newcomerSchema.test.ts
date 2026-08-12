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
  [1, 'new', 'open', 1, 1, 1, 'New', '新朋友'],
  [2, 'assigned', 'open', 2, 1, 0, 'Assigned', '已分配'],
  [3, 'contacted', 'open', 3, 1, 0, 'Contacted', '已联系'],
  [4, 'connected', 'closed', 4, 1, 0, 'Connected', '已连接'],
  [5, 'closed', 'closed', 5, 1, 0, 'Closed', '已关闭'],
];

const FIELD_ROWS = [
  [1, 'name', 'text', 0, 1, 1, 1, 'Name', '姓名'],
  [2, 'email', 'text', 0, 1, 2, 1, 'Email', '电子邮箱'],
  [3, 'phone', 'text', 0, 1, 3, 1, 'Phone', '电话'],
  [4, 'preferred_language', 'select', 0, 1, 4, 1, 'Preferred language', '首选语言'],
  [5, 'visit_date', 'text', 0, 1, 5, 1, 'Visit date', '到访日期'],
  [6, 'service_type', 'select', 0, 1, 6, 1, 'Service type', '聚会类型'],
  [7, 'contact_consent', 'checkbox', 0, 1, 7, 1, 'Contact consent', '联系同意'],
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
  const createdClientRoles: string[] = [];

  beforeAll(async () => {
    const existingRoles = await sql.unsafe<{ rolname: string }[]>(`
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')
    `);
    for (const role of ['anon', 'authenticated']) {
      if (!existingRoles.some((row) => row.rolname === role)) {
        await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`);
        createdClientRoles.push(role);
      }
    }
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
    for (const role of createdClientRoles.reverse()) {
      await sql?.unsafe(`DROP ROLE ${role}`);
    }
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
      SELECT s.id,s.key,s.category,s.sort,s.active,s.is_initial,en.label AS en_label,zh.label AS zh_label
      FROM newcomer_statuses s
      JOIN newcomer_status_i18n en ON en.status_id=s.id AND en.locale='en'
      JOIN newcomer_status_i18n zh ON zh.status_id=s.id AND zh.locale='zh'
      ORDER BY s.id
    `);
    expect(rows.map((row) => [
      Number(row.id), row.key, row.category, Number(row.sort), Number(row.active), Number(row.is_initial), row.en_label, row.zh_label,
    ])).toEqual(STATUS_ROWS);

    const fields = await sql.unsafe<Record<string, string | number>[]>(`
      SELECT f.id,f.key,f.type,f.required,f.active,f.sort,f.fixed,en.label AS en_label,zh.label AS zh_label
      FROM newcomer_fields f
      JOIN newcomer_field_i18n en ON en.field_id=f.id AND en.locale='en'
      JOIN newcomer_field_i18n zh ON zh.field_id=f.id AND zh.locale='zh'
      ORDER BY f.id
    `);
    expect(fields.map((row) => [
      Number(row.id), row.key, row.type, Number(row.required), Number(row.active), Number(row.sort), Number(row.fixed),
      row.en_label, row.zh_label,
    ])).toEqual(FIELD_ROWS);
    const [fixedOptionCount] = await sql.unsafe<{ count: string }[]>(`
      SELECT COUNT(*) AS count FROM newcomer_field_options WHERE field_id BETWEEN 1 AND 7
    `);
    expect(Number(fixedOptionCount?.count)).toBe(0);
  });

  it('enables RLS without client grants while preserving owner CRUD', async () => {
    const security = await sql.unsafe<{ relname: string; relrowsecurity: boolean }[]>(`
      SELECT c.relname,c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'newcomer_%' AND c.relkind='r'
      ORDER BY c.relname
    `);
    expect(security).toEqual(NEWCOMER_TABLES.map((relname) => ({ relname, relrowsecurity: true })));

    const grants = await sql.unsafe<{ table_name: string; grantee: string; privilege_type: string }[]>(`
      SELECT table_name,grantee,privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema='public' AND table_name LIKE 'newcomer_%'
        AND grantee IN ('anon','authenticated')
      ORDER BY table_name,grantee,privilege_type
    `);
    expect(grants).toEqual([]);

    const ownerHash = '9'.repeat(64);
    await sql.unsafe(`INSERT INTO newcomer_rate_limits VALUES
      ('${ownerHash}','2026-08-12 12:30:00',1,'2026-08-14 12:30:00')`);
    await sql.unsafe(`UPDATE newcomer_rate_limits SET attempts=2
      WHERE bucket_hash='${ownerHash}' AND window_start='2026-08-12 12:30:00'`);
    const [row] = await sql.unsafe<{ attempts: number }[]>(`
      SELECT attempts FROM newcomer_rate_limits
      WHERE bucket_hash='${ownerHash}' AND window_start='2026-08-12 12:30:00'
    `);
    expect(row?.attempts).toBe(2);
    await sql.unsafe(`DELETE FROM newcomer_rate_limits
      WHERE bucket_hash='${ownerHash}' AND window_start='2026-08-12 12:30:00'`);
  });

  it('keeps core field carriers immutable and answers/options custom-only', async () => {
    for (const statement of [
      "INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (89,'custom_fixed','text',0,1,89,1)",
      "INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (89,'name','text',0,1,89,0)",
      "INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (7,'custom_core_id','text',0,1,89,0)",
      "UPDATE newcomer_fields SET key='renamed_name' WHERE id=1",
      "UPDATE newcomer_fields SET id=8 WHERE id=1",
      "UPDATE newcomer_fields SET type='textarea' WHERE id=1",
      "UPDATE newcomer_fields SET fixed=0 WHERE id=1",
      "UPDATE newcomer_fields SET active=0 WHERE id=1",
      "UPDATE newcomer_fields SET required=1 WHERE id=1",
      "DELETE FROM newcomer_fields WHERE id=1",
    ]) await rejects(statement);

    await sql.unsafe("UPDATE newcomer_fields SET sort=88 WHERE id=1");
    await sql.unsafe("UPDATE newcomer_field_i18n SET label='Display name' WHERE field_id=1 AND locale='en'");
    const [label] = await sql.unsafe<{ label: string }[]>(`
      SELECT label FROM newcomer_field_i18n WHERE field_id=1 AND locale='en'
    `);
    expect(label?.label).toBe('Display name');

    await sql.unsafe("INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (89,'custom_select','select',0,1,89,0)");
    await sql.unsafe(`INSERT INTO newcomer_submissions
      (id,name,locale,visit_date,source,created_at,updated_at)
      VALUES ('61000000-0000-4000-8000-000000000001','Core boundary','en','2026-08-12','staff',
        '2026-08-12 12:00:00','2026-08-12 12:00:00')`);
    await rejects(`INSERT INTO newcomer_answers (submission_id,field_id,value)
      VALUES ('61000000-0000-4000-8000-000000000001',1,'must use submission column')`);
    await sql.unsafe(`INSERT INTO newcomer_answers (submission_id,field_id,value)
      VALUES ('61000000-0000-4000-8000-000000000001',89,'custom value')`);
    await rejects(`UPDATE newcomer_answers SET field_id=1
      WHERE submission_id='61000000-0000-4000-8000-000000000001' AND field_id=89`);
    await rejects("UPDATE newcomer_fields SET fixed=1 WHERE id=89");
    await rejects("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (4,'en',1,1)");
    await rejects("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (6,'service_9801',1,1)");
    await sql.unsafe("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (89,'first_visit',1,1)");
    await rejects("UPDATE newcomer_field_options SET field_id=4 WHERE field_id=89 AND value='first_visit'");
  });

  it('rejects every post-seed core insert or upsert without changing its bilingual labels', async () => {
    const readCore = async () => (await sql.unsafe<Record<string, string | number>[]>(`
      SELECT id,key,type,required,active,sort,fixed FROM newcomer_fields WHERE id=1
    `))[0];
    const readLabels = () => sql.unsafe<Record<string, string | null>[]>(`
      SELECT locale,label,help FROM newcomer_field_i18n WHERE field_id=1 ORDER BY locale
    `);
    const beforeCore = await readCore();
    const beforeLabels = await readLabels();
    const statements = [
      "INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (1,'name','text',0,1,1,1) ON CONFLICT (id) DO UPDATE SET sort=EXCLUDED.sort",
      "INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (1,'name','text',0,1,1,1)",
      "INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (1,'custom_core_id','text',0,1,1,0) ON CONFLICT (id) DO UPDATE SET key=EXCLUDED.key",
      "INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (89,'name','text',0,1,89,0) ON CONFLICT (key) DO UPDATE SET sort=EXCLUDED.sort",
    ];
    const rejected: boolean[] = [];
    for (const statement of statements) {
      try {
        await sql.unsafe(statement);
        rejected.push(false);
      } catch {
        rejected.push(true);
      }
    }
    expect(rejected).toEqual([true, true, true, true]);
    expect(await readCore()).toEqual(beforeCore);
    expect(await readLabels()).toEqual(beforeLabels);
    expect(beforeLabels).toHaveLength(2);

    await sql.unsafe(`
      INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed)
      VALUES (188,'ordinary_custom','text',0,1,188,0)
    `);
  });

  it('enforces every newcomer foreign key with real Postgres mutations', async () => {
    await sql.unsafe("INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (97,'fk_custom','text',0,1,97,0)");
    await sql.unsafe(`INSERT INTO newcomer_submissions
      (id,name,locale,visit_date,source,created_at,updated_at)
      VALUES ('62000000-0000-4000-8000-000000000001','FK owner','en','2026-08-12','staff',
        '2026-08-12 12:00:00','2026-08-12 12:00:00')`);

    const statements = [
      "INSERT INTO newcomer_status_i18n (status_id,locale,label) VALUES (999999,'en','Missing')",
      "INSERT INTO newcomer_field_i18n (field_id,locale,label) VALUES (999999,'en','Missing')",
      "INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (999999,'missing',1,1)",
      "INSERT INTO newcomer_field_option_i18n (field_id,value,locale,label) VALUES (999999,'missing','en','Missing')",
      submission("'62000000-0000-4000-8000-000000000002','Missing service',NULL,NULL,'en','2026-08-12',999999,NULL,'staff',1,NULL,NULL,NULL,0,NULL,NULL,NULL,'2026-08-12 12:00:00','2026-08-12 12:00:00'"),
      submission("'62000000-0000-4000-8000-000000000003','Missing status',NULL,NULL,'en','2026-08-12',NULL,NULL,'staff',999999,NULL,NULL,NULL,0,NULL,NULL,NULL,'2026-08-12 12:00:00','2026-08-12 12:00:00'"),
      submission("'62000000-0000-4000-8000-000000000004','Missing assignee',NULL,NULL,'en','2026-08-12',NULL,NULL,'staff',1,999999,NULL,NULL,0,NULL,NULL,NULL,'2026-08-12 12:00:00','2026-08-12 12:00:00'"),
      submission("'62000000-0000-4000-8000-000000000005','Missing linked',NULL,NULL,'en','2026-08-12',NULL,NULL,'staff',1,NULL,999999,NULL,0,NULL,NULL,NULL,'2026-08-12 12:00:00','2026-08-12 12:00:00'"),
      "INSERT INTO newcomer_answers (submission_id,field_id,value) VALUES ('62000000-0000-4000-8000-999999999999',97,'Missing')",
      "INSERT INTO newcomer_answers (submission_id,field_id,value) VALUES ('62000000-0000-4000-8000-000000000001',999999,'Missing')",
      "INSERT INTO newcomer_notes (id,submission_id,author_person_id,body) VALUES ('63000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-999999999999',9802,'Missing')",
      "INSERT INTO newcomer_notes (id,submission_id,author_person_id,body) VALUES ('63000000-0000-4000-8000-000000000002','62000000-0000-4000-8000-000000000001',999999,'Missing')",
      "INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json) VALUES ('64000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-999999999999','submission_created','{}')",
      "INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind,metadata_json) VALUES ('64000000-0000-4000-8000-000000000002','62000000-0000-4000-8000-000000000001',999999,'submission_created','{}')",
    ];
    for (const statement of statements) await rejects(statement, '23503');
  });

  it('repeats workflow, field, option, and single-initial constraint behavior', async () => {
    for (const statement of [
      "INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (90,'closed','closed',90,1,1)",
      "INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (91,'new','open',91,0,1)",
      "INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (92,'assigned','open',92,1,1)",
      "INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (93,'contacted','pending',93,1,0)",
      "INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (94,'connected','open',-1,2,0)",
      "INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (95,'NEW','open',95,1,0)",
      "INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (96,'other','open',96,1,0)",
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
      base('10000000-0000-4000-8000-000000000014', { email: "'@@@'" }),
      base('10000000-0000-4000-8000-000000000015', { email: "'@example.test'" }),
      base('10000000-0000-4000-8000-000000000016', { email: "'local@'" }),
      base('10000000-0000-4000-8000-000000000017', { email: "'a@@example.test'" }),
      base('10000000-0000-4000-8000-000000000018', { email: "('a' || chr(10) || '@example.test')" }),
      base('10000000-0000-4000-8000-000000000019', { email: "('a' || chr(9) || '@example.test')" }),
      base('10000000-0000-4000-8000-00000000001a', { email: "('a' || chr(31) || '@example.test')" }),
      base('10000000-0000-4000-8000-00000000001b', { email: "('a' || chr(127) || '@example.test')" }),
      base('10000000-0000-4000-8000-00000000001c', { email: "'a @example.test'" }),
      base('10000000-0000-4000-8000-00000000001d', { email: "('a' || chr(0) || '@example.test')" }),
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

  it('rejects every invalid calendar or timestamp parse, including metadata and rate windows', async () => {
    const base = (id: string, overrides: Partial<Record<string, string>> = {}) => submission([
      `'${id}'`, "'Date Visitor'", 'NULL', 'NULL', "'en'", overrides.visitDate ?? "'2026-08-12'", 'NULL',
      overrides.consentAt ?? 'NULL', "'staff'", '1', '9801', 'NULL', overrides.followUp ?? 'NULL', '0', 'NULL',
      overrides.closedAt ?? 'NULL', overrides.deletedAt ?? 'NULL',
      overrides.createdAt ?? "'2026-08-12 12:00:00'", overrides.updatedAt ?? "'2026-08-12 12:00:00'",
    ].join(','));
    for (const statement of [
      base('51000000-0000-4000-8000-000000000001', { visitDate: "'2026-13-01'" }),
      base('51000000-0000-4000-8000-000000000002', { visitDate: "'2026/08/12'" }),
      base('51000000-0000-4000-8000-000000000003', { followUp: "'2026-13-01'" }),
      base('51000000-0000-4000-8000-000000000004', { consentAt: "'2026-13-01 12:00:00'" }),
      base('51000000-0000-4000-8000-000000000005', { closedAt: "'2026-02-30 12:00:00'" }),
      base('51000000-0000-4000-8000-000000000006', { deletedAt: "'2026/08/12 12:00:00'" }),
      base('51000000-0000-4000-8000-000000000007', { createdAt: "'2026-13-01 12:00:00'" }),
      base('51000000-0000-4000-8000-000000000008', { updatedAt: "'2026-02-30 12:00:00'" }),
    ]) await rejects(statement);

    await sql.unsafe(base('51000000-0000-4000-8000-000000000010'));
    for (const statement of [
      `INSERT INTO newcomer_notes (id,submission_id,author_person_id,body,created_at)
       VALUES ('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000010',9801,
         'Strict timestamp','2026-13-01 12:00:00')`,
      `INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json,created_at)
       VALUES ('53000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000010',
         'follow_up_scheduled','{"follow_up_date":"2026-13-01"}','2026-08-12 12:00:00')`,
      `INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json,created_at)
       VALUES ('53000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000010',
         'submission_created','{}','2026-02-30 12:00:00')`,
      `INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
       VALUES ('${'f'.repeat(64)}','2026-13-01 12:10:00',1,'2026-08-14 12:10:00')`,
    ]) await rejects(statement);
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
      `INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
       VALUES ('40000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000001','person_linked',
         '{"person_id":"private@example.test","person_id":9802}')`,
      `INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
       VALUES ('40000000-0000-4000-8000-000000000008','20000000-0000-4000-8000-000000000001','person_linked',
         '{ "person_id":9802}')`,
      `INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
       VALUES ('40000000-0000-4000-8000-000000000009','20000000-0000-4000-8000-000000000001','status_changed',
         '{"to_status_id":2,"from_status_id":1}')`,
      `INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
       VALUES ('40000000-0000-4000-8000-00000000000a','20000000-0000-4000-8000-000000000001','status_changed',
         '{"from_status_id":1, "to_status_id":2}')`,
    ]) await rejects(statement);
  });

  it('repeats lowercase-hex bucket shape, window, attempt, uniqueness, and expiry behavior', async () => {
    // HMAC provenance belongs to newcomerDb/rate-limiter Task 3; this schema
    // only guarantees an opaque lowercase-hex storage shape with no raw suffix.
    const hash = 'a'.repeat(64);
    await sql.unsafe(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${hash}','2026-08-12 12:10:00',1,'2026-08-14 12:10:00')`);
    for (const statement of [
      `INSERT INTO newcomer_rate_limits VALUES ('${'A'.repeat(64)}','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${'b'.repeat(63)}','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${hash}1.2.3.4','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${hash}visitor@example.test','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${'b'.repeat(64)}','2026-08-12 12:11:00',1,'2026-08-14 12:11:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${'c'.repeat(64)}','2026-02-30 12:20:00',1,'2026-03-04 12:20:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${'d'.repeat(64)}','2026-08-12 12:20:00',0,'2026-08-14 12:20:00')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${'e'.repeat(64)}','2026-08-12 12:20:00',1,'2026-08-14 12:19:59')`,
      `INSERT INTO newcomer_rate_limits VALUES ('${hash}','2026-08-12 12:10:00',2,'2026-08-14 12:10:00')`,
    ]) await rejects(statement);
  });

  it('cascades owned rows, nulls nullable external references, and restricts required references', async () => {
    await sql.unsafe(`INSERT INTO people (id,display_name,email) VALUES
      (9861,'FK assignee','fk-assignee@example.test'),
      (9862,'FK linked','fk-linked@example.test'),
      (9863,'FK author','fk-author@example.test');
      INSERT INTO service_types (id,sort) VALUES (9861,9861);
      INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed)
        VALUES (195,'fk_lifecycle','select',0,1,195,0);
      INSERT INTO newcomer_field_i18n VALUES (195,'en','FK lifecycle',NULL);
      INSERT INTO newcomer_field_options VALUES (195,'keep',1,1);
      INSERT INTO newcomer_field_option_i18n VALUES (195,'keep','en','Keep');
      INSERT INTO newcomer_submissions
        (id,name,locale,visit_date,service_type_id,source,status_id,assignee_person_id,linked_person_id)
        VALUES ('76000000-0000-4000-8000-000000000001','FK lifecycle','en','2026-08-12',9861,
          'staff',3,9861,9862);
      INSERT INTO newcomer_answers VALUES ('76000000-0000-4000-8000-000000000001',195,'keep');
      INSERT INTO newcomer_notes (id,submission_id,author_person_id,body)
        VALUES ('76100000-0000-4000-8000-000000000001','76000000-0000-4000-8000-000000000001',9863,'Private');
      INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind)
        VALUES ('76200000-0000-4000-8000-000000000001','76000000-0000-4000-8000-000000000001',9861,'assigned');
    `);

    await rejects('DELETE FROM newcomer_statuses WHERE id=3', '23503');
    await rejects('DELETE FROM newcomer_fields WHERE id=195', '23503');
    await rejects('DELETE FROM people WHERE id=9863', '23503');

    await sql.unsafe('DELETE FROM service_types WHERE id=9861');
    await sql.unsafe('DELETE FROM people WHERE id=9861');
    await sql.unsafe('DELETE FROM people WHERE id=9862');
    const [submissionRefs] = await sql.unsafe<Record<string, number | null>[]>(`
      SELECT service_type_id,assignee_person_id,linked_person_id
      FROM newcomer_submissions WHERE id='76000000-0000-4000-8000-000000000001'
    `);
    expect(submissionRefs).toEqual({ service_type_id: null, assignee_person_id: null, linked_person_id: null });
    const [activityRef] = await sql.unsafe<{ actor_person_id: number | null }[]>(`
      SELECT actor_person_id FROM newcomer_activity WHERE id='76200000-0000-4000-8000-000000000001'
    `);
    expect(activityRef).toEqual({ actor_person_id: null });

    await sql.unsafe("DELETE FROM newcomer_submissions WHERE id='76000000-0000-4000-8000-000000000001'");
    for (const table of ['newcomer_answers', 'newcomer_notes', 'newcomer_activity']) {
      const [{ count }] = await sql.unsafe<{ count: number }[]>(`SELECT COUNT(*) AS count FROM ${table}
        WHERE submission_id='76000000-0000-4000-8000-000000000001'`);
      expect(count).toBe(0);
    }
    const [{ count: authorCount }] = await sql.unsafe<{ count: number }[]>('SELECT COUNT(*) AS count FROM people WHERE id=9863');
    expect(authorCount).toBe(1);

    await sql.unsafe('DELETE FROM newcomer_fields WHERE id=195');
    for (const table of ['newcomer_field_i18n', 'newcomer_field_options', 'newcomer_field_option_i18n']) {
      const [{ count }] = await sql.unsafe<{ count: number }[]>(`SELECT COUNT(*) AS count FROM ${table} WHERE field_id=195`);
      expect(count).toBe(0);
    }
  });

  it('relies on PostgreSQL zero-byte rejection and enforces the same UTF-8 byte bounds', async () => {
    await rejects(`INSERT INTO newcomer_submissions (id,name,locale,visit_date,source)
      VALUES ('75000000-0000-4000-8000-000000000001',
        convert_from(decode('00','hex'),'UTF8'),'en','2026-08-12','staff')`, '22021');
    await rejects(`UPDATE newcomer_status_i18n SET label='${'名'.repeat(34)}'
      WHERE status_id=2 AND locale='en'`);
  });
});
