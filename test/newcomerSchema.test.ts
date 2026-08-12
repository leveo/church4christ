import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const NEWCOMER_TABLES = [
  'newcomer_statuses',
  'newcomer_status_i18n',
  'newcomer_fields',
  'newcomer_field_i18n',
  'newcomer_field_options',
  'newcomer_field_option_i18n',
  'newcomer_submissions',
  'newcomer_answers',
  'newcomer_notes',
  'newcomer_activity',
  'newcomer_rate_limits',
] as const;

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

async function reject(statement: string): Promise<void> {
  await expect(env.DB.prepare(statement).run()).rejects.toThrow();
}

function submission(values: string): string {
  return `INSERT INTO newcomer_submissions
    (id,name,email,phone,locale,visit_date,service_type_id,contact_consent_at,source,status_id,
     assignee_person_id,linked_person_id,next_follow_up_date,version,last_mutation_id,closed_at,deleted_at,
     created_at,updated_at)
    VALUES (${values})`;
}

describe('newcomer foundation schema (D1)', () => {
  it('creates all eleven relations with stable keys, foreign keys, and query indexes', async () => {
    const tables = await env.DB.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'newcomer_%' ORDER BY name
    `).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([...NEWCOMER_TABLES].sort());

    const statusColumns = await env.DB.prepare('PRAGMA table_info(newcomer_statuses)')
      .all<{ name: string; type: string; notnull: number; pk: number }>();
    expect(statusColumns.results.map((column) => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['id', 'INTEGER', 1, 1],
      ['key', 'TEXT', 1, 0],
      ['category', 'TEXT', 1, 0],
      ['sort', 'INTEGER', 1, 0],
      ['active', 'INTEGER', 1, 0],
      ['is_initial', 'INTEGER', 1, 0],
    ]);

    const submissionFks = await env.DB.prepare('PRAGMA foreign_key_list(newcomer_submissions)')
      .all<{ table: string; from: string; to: string }>();
    expect(submissionFks.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'service_types', from: 'service_type_id', to: 'id' }),
      expect.objectContaining({ table: 'newcomer_statuses', from: 'status_id', to: 'id' }),
      expect.objectContaining({ table: 'people', from: 'assignee_person_id', to: 'id' }),
      expect.objectContaining({ table: 'people', from: 'linked_person_id', to: 'id' }),
    ]));
    const optionLabelFks = await env.DB.prepare('PRAGMA foreign_key_list(newcomer_field_option_i18n)')
      .all<{ table: string; from: string; to: string }>();
    expect(optionLabelFks.results.filter((row) => row.table === 'newcomer_field_options')).toHaveLength(2);

    const indexes = await env.DB.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'idx_newcomer_%' ORDER BY name
    `).all<{ name: string; sql: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      'idx_newcomer_statuses_one_initial',
      'idx_newcomer_fields_active_sort',
      'idx_newcomer_options_field_sort',
      'idx_newcomer_submissions_status_follow_up',
      'idx_newcomer_submissions_assignee',
      'idx_newcomer_submissions_visit_date',
      'idx_newcomer_submissions_last_mutation',
      'idx_newcomer_answers_field',
      'idx_newcomer_notes_submission_created',
      'idx_newcomer_activity_submission_created',
      'idx_newcomer_rate_limits_expires',
    ]));
    expect(indexes.results.find((row) => row.name === 'idx_newcomer_statuses_one_initial')?.sql)
      .toMatch(/UNIQUE[\s\S]*is_initial[\s\S]*active\s*=\s*1[\s\S]*category\s*=\s*'open'/i);
  });

  it('seeds the exact stable workflow and fixed bilingual core-field catalog', async () => {
    const statuses = await env.DB.prepare(`
      SELECT s.id,s.key,s.category,s.sort,s.active,s.is_initial,en.label AS en_label,zh.label AS zh_label
      FROM newcomer_statuses s
      JOIN newcomer_status_i18n en ON en.status_id=s.id AND en.locale='en'
      JOIN newcomer_status_i18n zh ON zh.status_id=s.id AND zh.locale='zh'
      ORDER BY s.id
    `).all<Record<string, string | number>>();
    expect(statuses.results.map((row) => [
      row.id, row.key, row.category, row.sort, row.active, row.is_initial, row.en_label, row.zh_label,
    ])).toEqual(STATUS_ROWS);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM newcomer_statuses
      WHERE active=1 AND category='open' AND is_initial=1
    `).first<number>('n')).toBe(1);

    const fields = await env.DB.prepare(`
      SELECT f.id,f.key,f.type,f.required,f.active,f.sort,f.fixed,en.label AS en_label,zh.label AS zh_label
      FROM newcomer_fields f
      JOIN newcomer_field_i18n en ON en.field_id=f.id AND en.locale='en'
      JOIN newcomer_field_i18n zh ON zh.field_id=f.id AND zh.locale='zh'
      ORDER BY f.id
    `).all<Record<string, string | number>>();
    expect(fields.results.map((row) => [
      row.id, row.key, row.type, row.required, row.active, row.sort, row.fixed, row.en_label, row.zh_label,
    ])).toEqual(FIELD_ROWS);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM newcomer_field_options WHERE field_id BETWEEN 1 AND 7
    `).first<number>('n')).toBe(0);
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
    ]) await reject(statement);

    await env.DB.prepare("UPDATE newcomer_fields SET sort=88 WHERE id=1").run();
    await env.DB.prepare("UPDATE newcomer_field_i18n SET label='Display name' WHERE field_id=1 AND locale='en'").run();
    expect(await env.DB.prepare("SELECT label FROM newcomer_field_i18n WHERE field_id=1 AND locale='en'").first('label'))
      .toBe('Display name');

    await env.DB.prepare(`
      INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed)
      VALUES (89,'custom_select','select',0,1,89,0)
    `).run();
    await env.DB.prepare(`INSERT INTO newcomer_submissions
      (id,name,locale,visit_date,source,created_at,updated_at)
      VALUES ('61000000-0000-4000-8000-000000000001','Core boundary','en','2026-08-12','staff',
        '2026-08-12 12:00:00','2026-08-12 12:00:00')`).run();
    await reject(`INSERT INTO newcomer_answers (submission_id,field_id,value)
      VALUES ('61000000-0000-4000-8000-000000000001',1,'must use submission column')`);
    await env.DB.prepare(`INSERT INTO newcomer_answers (submission_id,field_id,value)
      VALUES ('61000000-0000-4000-8000-000000000001',89,'custom value')`).run();
    await reject(`UPDATE newcomer_answers SET field_id=1
      WHERE submission_id='61000000-0000-4000-8000-000000000001' AND field_id=89`);
    await reject("UPDATE newcomer_fields SET fixed=1 WHERE id=89");
    await reject("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (4,'en',1,1)");
    await reject("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (6,'service_9801',1,1)");
    await env.DB.prepare("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (89,'first_visit',1,1)").run();
    await reject("UPDATE newcomer_field_options SET field_id=4 WHERE field_id=89 AND value='first_visit'");
  });

  it('rejects every post-seed core insert without replacing its bilingual labels', async () => {
    const readCore = () => env.DB.prepare(`
      SELECT id,key,type,required,active,sort,fixed FROM newcomer_fields WHERE id=1
    `).first<Record<string, string | number>>();
    const readLabels = () => env.DB.prepare(`
      SELECT locale,label,help FROM newcomer_field_i18n WHERE field_id=1 ORDER BY locale
    `).all<Record<string, string | null>>();
    const beforeCore = await readCore();
    const beforeLabels = (await readLabels()).results;
    const statements = [
      "INSERT OR REPLACE INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (1,'name','text',0,1,1,1)",
      "INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (1,'name','text',0,1,1,1)",
      "INSERT OR REPLACE INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (1,'custom_core_id','text',0,1,1,0)",
      "INSERT OR REPLACE INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (89,'name','text',0,1,89,0)",
    ];
    const rejected: boolean[] = [];
    for (const statement of statements) {
      try {
        await env.DB.prepare(statement).run();
        rejected.push(false);
      } catch {
        rejected.push(true);
      }
    }
    expect(rejected).toEqual([true, true, true, true]);
    expect(await readCore()).toEqual(beforeCore);
    expect((await readLabels()).results).toEqual(beforeLabels);
    expect(beforeLabels).toHaveLength(2);

    await env.DB.prepare(`
      INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed)
      VALUES (188,'ordinary_custom','text',0,1,188,0)
    `).run();
  });

  it('allows bounded custom statuses while preserving core identity and immutable categories', async () => {
    await env.DB.prepare(`
      INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial)
      VALUES (90,'awaiting_host','open',90,1,0)
    `).run();
    expect(await env.DB.prepare("SELECT category FROM newcomer_statuses WHERE key='awaiting_host'").first('category'))
      .toBe('open');

    for (const statement of [
      "UPDATE newcomer_statuses SET id=91 WHERE id=1",
      "UPDATE newcomer_statuses SET key='renamed_new' WHERE id=1",
      "UPDATE newcomer_statuses SET category='closed' WHERE id=1",
      "UPDATE newcomer_statuses SET category='closed' WHERE id=90",
      "DELETE FROM newcomer_statuses WHERE id=1",
      "INSERT OR REPLACE INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (1,'new','open',1,1,1)",
      "INSERT OR REPLACE INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (91,'new','open',91,1,0)",
    ]) await reject(statement);

    await env.DB.prepare("UPDATE newcomer_statuses SET sort=91,active=0 WHERE id=90").run();
    expect(await env.DB.prepare('SELECT sort,active FROM newcomer_statuses WHERE id=90').first())
      .toEqual({ sort: 91, active: 0 });
    await env.DB.prepare('DELETE FROM newcomer_statuses WHERE id=90').run();
  });

  it('rejects invalid workflow initial states, keys, enums, booleans, ranges, and labels', async () => {
    await reject("INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (90,'closed','closed',90,1,1)");
    await reject("INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (91,'new','open',91,0,1)");
    await reject("INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (92,'assigned','open',92,1,1)");
    await reject("INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (93,'contacted','pending',93,1,0)");
    await reject("INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (94,'connected','open',-1,2,0)");
    await reject("INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (95,'NEW','open',95,1,0)");
    await reject("INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (96,'9other','open',96,1,0)");
    await reject("INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (97,'bad-key','open',97,1,0)");
    await reject(`INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial)
      VALUES (98,'${'a'.repeat(65)}','open',98,1,0)`);
    await reject("INSERT INTO newcomer_status_i18n (status_id,locale,label) VALUES (1,'fr','Nouveau')");
    await reject("INSERT INTO newcomer_status_i18n (status_id,locale,label) VALUES (1,'en','')");
  });

  it('locks bounded field and option carriers while leaving select ownership to application validation', async () => {
    await env.DB.prepare(`
      INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed)
      VALUES (90,'custom_path','textarea',1,1,90,0)
    `).run();
    await env.DB.prepare(`
      INSERT INTO newcomer_field_i18n (field_id,locale,label,help)
      VALUES (90,'en','Custom path','A bounded custom question')
    `).run();
    await env.DB.prepare(`
      INSERT INTO newcomer_field_options (field_id,value,sort,active)
      VALUES (90,'first_visit',1,1)
    `).run();
    await env.DB.prepare(`
      INSERT INTO newcomer_field_option_i18n (field_id,value,locale,label)
      VALUES (90,'first_visit','en','First visit')
    `).run();

    await reject("INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (91,'bad','radio',0,1,1,0)");
    await reject("INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (92,'BAD KEY','text',0,1,1,0)");
    await reject("INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (93,'bad_bool','text',2,1,1,0)");
    await reject("INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (94,'bad_sort','text',0,1,100001,0)");
    await reject("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (999,'missing',1,1)");
    await reject("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (90,'',1,1)");
    await reject("INSERT INTO newcomer_field_option_i18n (field_id,value,locale,label) VALUES (90,'missing','en','Missing')");
  });

  it('accepts a bounded normalized submission and defaults it to the initial status/version', async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO service_types (id,sort) VALUES (9801,1)").run();
    await env.DB.prepare(`INSERT INTO newcomer_submissions
      (id,name,email,phone,locale,visit_date,service_type_id,contact_consent_at,source,next_follow_up_date)
      VALUES ('10000000-0000-4000-8000-000000000001','Ada Visitor','ada@example.test','+13125550100',
        'en','2028-02-29',9801,'2026-08-12 12:00:00','public','2026-08-20')`).run();
    const row = await env.DB.prepare(`
      SELECT status_id,version,source,created_at,updated_at FROM newcomer_submissions
      WHERE id='10000000-0000-4000-8000-000000000001'
    `).first<Record<string, string | number>>();
    expect(row).toMatchObject({ status_id: 1, version: 0, source: 'public' });
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('rejects malformed or unnormalized submission identifiers, contacts, dates, enums, counts, timestamps, and FKs', async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO people (id,display_name,email) VALUES (9801,'Newcomer Owner','newcomer-owner@example.test')").run();
    await env.DB.prepare("INSERT OR IGNORE INTO service_types (id,sort) VALUES (9801,1)").run();
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
      base('10000000-0000-4000-8000-000000000018', { email: "('a' || char(10) || '@example.test')" }),
      base('10000000-0000-4000-8000-000000000019', { email: "('a' || char(9) || '@example.test')" }),
      base('10000000-0000-4000-8000-00000000001a', { email: "('a' || char(31) || '@example.test')" }),
      base('10000000-0000-4000-8000-00000000001b', { email: "('a' || char(127) || '@example.test')" }),
      base('10000000-0000-4000-8000-00000000001c', { email: "'a @example.test'" }),
      base('10000000-0000-4000-8000-00000000001d', { email: "('a' || char(0) || '@example.test')" }),
      base('10000000-0000-4000-8000-000000000004', { phone: "' +13125550100'" }),
      base('10000000-0000-4000-8000-000000000005', { locale: "'fr'" }),
      base('10000000-0000-4000-8000-000000000006', { visitDate: "'2026-02-30'" }),
      base('10000000-0000-4000-8000-000000000007', { visitDate: "'0000-01-01'" }),
      base('10000000-0000-4000-8000-000000000008', { followUp: "'abcd-01-01'" }),
      base('10000000-0000-4000-8000-000000000009', { source: "'import'" }),
      base('10000000-0000-4000-8000-00000000000a', { version: '-1' }),
      base('10000000-0000-4000-8000-00000000000b', { mutation: `''` }),
      base('10000000-0000-4000-8000-00000000000c', { consentAt: "'2026-02-30 12:00:00'" }),
      base('10000000-0000-4000-8000-00000000000d', { closedAt: "'2026-08-12'" }),
      base('10000000-0000-4000-8000-00000000000e', { deletedAt: "'2026-08-12 25:00:00'" }),
      base('10000000-0000-4000-8000-00000000000f', { createdAt: "'bad'" }),
      base('10000000-0000-4000-8000-000000000010', { serviceType: '999999' }),
      base('10000000-0000-4000-8000-000000000011', { status: '999999' }),
      base('10000000-0000-4000-8000-000000000012', { assignee: '999999' }),
      base('10000000-0000-4000-8000-000000000013', { linked: '999999' }),
    ];
    for (const statement of invalid) await reject(statement);
  });

  it('rejects every NULL-producing SQLite date or timestamp parse, including metadata and rate windows', async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO people (id,display_name,email) VALUES (9810,'Date Author','date-author@example.test')").run();
    const base = (id: string, overrides: Partial<Record<string, string>> = {}) => submission([
      `'${id}'`, "'Date Visitor'", 'NULL', 'NULL', "'en'", overrides.visitDate ?? "'2026-08-12'", 'NULL',
      overrides.consentAt ?? 'NULL', "'staff'", '1', '9810', 'NULL', overrides.followUp ?? 'NULL', '0', 'NULL',
      overrides.closedAt ?? 'NULL', overrides.deletedAt ?? 'NULL',
      overrides.createdAt ?? "'2026-08-12 12:00:00'", overrides.updatedAt ?? "'2026-08-12 12:00:00'",
    ].join(','));
    const invalidSubmissions = [
      base('51000000-0000-4000-8000-000000000001', { visitDate: "'2026-13-01'" }),
      base('51000000-0000-4000-8000-000000000002', { visitDate: "'2026/08/12'" }),
      base('51000000-0000-4000-8000-000000000003', { followUp: "'2026-13-01'" }),
      base('51000000-0000-4000-8000-000000000004', { consentAt: "'2026-13-01 12:00:00'" }),
      base('51000000-0000-4000-8000-000000000005', { closedAt: "'2026-02-30 12:00:00'" }),
      base('51000000-0000-4000-8000-000000000006', { deletedAt: "'2026/08/12 12:00:00'" }),
      base('51000000-0000-4000-8000-000000000007', { createdAt: "'2026-13-01 12:00:00'" }),
      base('51000000-0000-4000-8000-000000000008', { updatedAt: "'2026-02-30 12:00:00'" }),
    ];
    for (const statement of invalidSubmissions) await reject(statement);

    await env.DB.prepare(base('51000000-0000-4000-8000-000000000010')).run();
    await reject(`INSERT INTO newcomer_notes (id,submission_id,author_person_id,body,created_at)
      VALUES ('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000010',9810,
        'Strict timestamp','2026-13-01 12:00:00')`);
    await reject(`INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json,created_at)
      VALUES ('53000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000010',
        'follow_up_scheduled','{"follow_up_date":"2026-13-01"}','2026-08-12 12:00:00')`);
    await reject(`INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json,created_at)
      VALUES ('53000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000010',
        'submission_created','{}','2026-02-30 12:00:00')`);
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${'f'.repeat(64)}','2026-13-01 12:10:00',1,'2026-08-14 12:10:00')`);
  });

  it('enforces bounded answer, private-note, and structural activity carriers without accepting arbitrary PII keys', async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO people (id,display_name,email) VALUES (9802,'Newcomer Author','newcomer-author@example.test')").run();
    await env.DB.prepare(submission(`
      '20000000-0000-4000-8000-000000000001','Answer Owner',NULL,NULL,'zh','2026-08-12',NULL,NULL,
      'staff',1,9802,NULL,NULL,0,NULL,NULL,NULL,'2026-08-12 12:00:00','2026-08-12 12:00:00'
    `)).run();
    await env.DB.prepare("INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (98,'custom_question','textarea',0,1,98,0)").run();
    await env.DB.prepare(`INSERT INTO newcomer_answers (submission_id,field_id,value)
      VALUES ('20000000-0000-4000-8000-000000000001',98,'Bounded answer')`).run();
    await env.DB.prepare(`INSERT INTO newcomer_notes (id,submission_id,author_person_id,body,created_at)
      VALUES ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',9802,
      'Private follow-up note','2026-08-12 12:01:00')`).run();
    await env.DB.prepare(`INSERT INTO newcomer_activity
      (id,submission_id,actor_person_id,kind,metadata_json,created_at)
      VALUES ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',9802,
      'status_changed','{"from_status_id":1,"to_status_id":2}','2026-08-12 12:02:00')`).run();

    await reject(`INSERT INTO newcomer_answers (submission_id,field_id,value)
      VALUES ('20000000-0000-4000-8000-000000000001',98,'${'x'.repeat(4001)}')`);
    await reject(`INSERT INTO newcomer_notes (id,submission_id,author_person_id,body)
      VALUES ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',9802,'')`);
    await reject(`INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
      VALUES ('40000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','emailed','{}')`);
    await reject(`INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
      VALUES ('40000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','submission_created','not json')`);
    await reject(`INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
      VALUES ('40000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001','submission_created','[]')`);
    await reject(`INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
      VALUES ('40000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000001','submission_created','{"email":"private@example.test"}')`);
    await reject(`INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
      VALUES ('40000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000001','person_linked','{"person_id":"9802"}')`);
    await reject(`INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
      VALUES ('40000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000001','person_linked',
        '{"person_id":"private@example.test","person_id":9802}')`);
    await reject(`INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
      VALUES ('40000000-0000-4000-8000-000000000008','20000000-0000-4000-8000-000000000001','person_linked',
        '{ "person_id":9802}')`);
    await reject(`INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
      VALUES ('40000000-0000-4000-8000-000000000009','20000000-0000-4000-8000-000000000001','status_changed',
        '{"to_status_id":2,"from_status_id":1}')`);
    await reject(`INSERT INTO newcomer_activity (id,submission_id,kind,metadata_json)
      VALUES ('40000000-0000-4000-8000-00000000000a','20000000-0000-4000-8000-000000000001','status_changed',
        '{"from_status_id":1, "to_status_id":2}')`);
  });

  it('stores only lowercase-hex bucket shapes in ten-minute windows with exact 48-hour expiry', async () => {
    // HMAC provenance belongs to newcomerDb/rate-limiter Task 3; this schema
    // only guarantees an opaque lowercase-hex storage shape with no raw suffix.
    const hash = 'a'.repeat(64);
    await env.DB.prepare(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES (?,'2026-08-12 12:10:00',1,'2026-08-14 12:10:00')`).bind(hash).run();
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${'A'.repeat(64)}','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`);
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${'b'.repeat(63)}','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`);
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${hash}1.2.3.4','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`);
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${hash}visitor@example.test','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`);
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${'b'.repeat(64)}','2026-08-12 12:11:00',1,'2026-08-14 12:11:00')`);
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${'c'.repeat(64)}','2026-02-30 12:20:00',1,'2026-03-04 12:20:00')`);
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${'d'.repeat(64)}','2026-08-12 12:20:00',0,'2026-08-14 12:20:00')`);
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${'e'.repeat(64)}','2026-08-12 12:20:00',1,'2026-08-14 12:19:59')`);
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${hash}','2026-08-12 12:10:00',2,'2026-08-14 12:10:00')`);
  });

  it('cascades owned rows, nulls nullable external references, and restricts required references', async () => {
    await env.DB.prepare(`INSERT INTO people (id,display_name,email) VALUES
      (9861,'FK assignee','fk-assignee@example.test'),
      (9862,'FK linked','fk-linked@example.test'),
      (9863,'FK author','fk-author@example.test')`).run();
    await env.DB.prepare("INSERT INTO service_types (id,sort) VALUES (9861,9861)").run();
    await env.DB.prepare(`INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed)
      VALUES (195,'fk_lifecycle','select',0,1,195,0)`).run();
    await env.DB.prepare("INSERT INTO newcomer_field_i18n VALUES (195,'en','FK lifecycle',NULL)").run();
    await env.DB.prepare("INSERT INTO newcomer_field_options VALUES (195,'keep',1,1)").run();
    await env.DB.prepare("INSERT INTO newcomer_field_option_i18n VALUES (195,'keep','en','Keep')").run();
    await env.DB.prepare(`INSERT INTO newcomer_submissions
      (id,name,locale,visit_date,service_type_id,source,status_id,assignee_person_id,linked_person_id)
      VALUES ('76000000-0000-4000-8000-000000000001','FK lifecycle','en','2026-08-12',9861,
        'staff',3,9861,9862)`).run();
    await env.DB.prepare("INSERT INTO newcomer_answers VALUES ('76000000-0000-4000-8000-000000000001',195,'keep')").run();
    await env.DB.prepare(`INSERT INTO newcomer_notes (id,submission_id,author_person_id,body)
      VALUES ('76100000-0000-4000-8000-000000000001','76000000-0000-4000-8000-000000000001',9863,'Private')`).run();
    await env.DB.prepare(`INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind)
      VALUES ('76200000-0000-4000-8000-000000000001','76000000-0000-4000-8000-000000000001',9861,'assigned')`).run();

    await reject('DELETE FROM newcomer_statuses WHERE id=3');
    await reject('DELETE FROM newcomer_fields WHERE id=195');
    await reject('DELETE FROM people WHERE id=9863');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_statuses WHERE id=3').first<number>('n')).toBe(1);
    expect(await env.DB.prepare("SELECT status_id FROM newcomer_submissions WHERE id='76000000-0000-4000-8000-000000000001'").first())
      .toEqual({ status_id: 3 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_fields WHERE id=195').first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_answers
      WHERE submission_id='76000000-0000-4000-8000-000000000001' AND field_id=195`).first<number>('n')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people WHERE id=9863').first<number>('n')).toBe(1);
    expect(await env.DB.prepare("SELECT author_person_id FROM newcomer_notes WHERE id='76100000-0000-4000-8000-000000000001'").first())
      .toEqual({ author_person_id: 9863 });

    await env.DB.prepare('DELETE FROM service_types WHERE id=9861').run();
    await env.DB.prepare('DELETE FROM people WHERE id=9861').run();
    await env.DB.prepare('DELETE FROM people WHERE id=9862').run();
    expect(await env.DB.prepare(`SELECT service_type_id,assignee_person_id,linked_person_id
      FROM newcomer_submissions WHERE id='76000000-0000-4000-8000-000000000001'`).first())
      .toEqual({ service_type_id: null, assignee_person_id: null, linked_person_id: null });
    expect(await env.DB.prepare("SELECT actor_person_id FROM newcomer_activity WHERE id='76200000-0000-4000-8000-000000000001'").first())
      .toEqual({ actor_person_id: null });

    await env.DB.prepare("DELETE FROM newcomer_submissions WHERE id='76000000-0000-4000-8000-000000000001'").run();
    for (const table of ['newcomer_answers', 'newcomer_notes', 'newcomer_activity']) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}
        WHERE submission_id='76000000-0000-4000-8000-000000000001'`).first<number>('n')).toBe(0);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people WHERE id=9863').first<number>('n')).toBe(1);

    await env.DB.prepare('DELETE FROM newcomer_fields WHERE id=195').run();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_field_i18n WHERE field_id=195').first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_field_options WHERE field_id=195').first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_field_option_i18n WHERE field_id=195').first<number>('n')).toBe(0);
  });

  it('rejects U+0000 and actual UTF-8 byte overlimits across every newcomer TEXT carrier', async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO people (id,display_name,email) VALUES (9850,'NUL Author','nul-author@example.test')").run();
    await env.DB.prepare(`INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed)
      VALUES (181,'nul_probe_select','select',0,1,181,0)`).run();
    await env.DB.prepare("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (181,'valid',1,1)").run();
    await env.DB.prepare(`INSERT INTO newcomer_submissions
      (id,name,locale,visit_date,source,created_at,updated_at)
      VALUES ('71000000-0000-4000-8000-000000000001','NUL owner','en','2026-08-12','staff',
        '2026-08-12 12:00:00','2026-08-12 12:00:00')`).run();

    const baseSubmission = (id: string, column: string, value: string) => `INSERT INTO newcomer_submissions
      (id,name,locale,visit_date,source,created_at,updated_at,${column})
      VALUES ('${id}','NUL probe','en','2026-08-12','staff','2026-08-12 12:00:00','2026-08-12 12:00:00',${value})`;
    const probes: Array<[string, string]> = [
      ['status.key', "INSERT INTO newcomer_statuses VALUES (80,('new'||char(0)),'open',80,1,0)"],
      ['status.category', "UPDATE newcomer_statuses SET category=('open'||char(0)) WHERE id=2"],
      ['status_i18n.locale', "INSERT INTO newcomer_status_i18n VALUES (1,('en'||char(0)),'NUL')"],
      ['status_i18n.label', "UPDATE newcomer_status_i18n SET label=('New'||char(0)||'hidden') WHERE status_id=1 AND locale='en'"],
      ['field.key', "INSERT INTO newcomer_fields VALUES (182,('custom'||char(0)||'hidden'),'text',0,1,182,0)"],
      ['field.type', "INSERT INTO newcomer_fields VALUES (183,'bad_type',('text'||char(0)),0,1,183,0)"],
      ['field_i18n.locale', "INSERT INTO newcomer_field_i18n VALUES (181,('en'||char(0)),'NUL',NULL)"],
      ['field_i18n.label', "INSERT INTO newcomer_field_i18n VALUES (181,'en',('Label'||char(0)||'hidden'),NULL)"],
      ['field_i18n.help', `INSERT INTO newcomer_field_i18n VALUES (181,'zh','帮助',(char(0)||'${'x'.repeat(501)}'))`],
      ['field_option.value', "INSERT INTO newcomer_field_options VALUES (181,('valid'||char(0)||'hidden'),2,1)"],
      ['option_i18n.value', "INSERT INTO newcomer_field_option_i18n VALUES (181,('valid'||char(0)||'hidden'),'zh','NUL')"],
      ['option_i18n.locale', "INSERT INTO newcomer_field_option_i18n VALUES (181,'valid',('en'||char(0)),'NUL')"],
      ['option_i18n.label', "INSERT INTO newcomer_field_option_i18n VALUES (181,'valid','en',('Label'||char(0)||'hidden'))"],
      ['submission.id', "INSERT INTO newcomer_submissions (id,name,locale,visit_date,source) VALUES (('72000000-0000-4000-8000-000000000001'||char(0)),'NUL','en','2026-08-12','staff')"],
      ['submission.name', `INSERT INTO newcomer_submissions
        (id,name,locale,visit_date,source,created_at,updated_at)
        VALUES ('72000000-0000-4000-8000-000000000002',('A'||char(0)||'${'x'.repeat(200)}'),'en',
          '2026-08-12','staff','2026-08-12 12:00:00','2026-08-12 12:00:00')`],
      ['submission.email', baseSubmission('72000000-0000-4000-8000-000000000003', 'email', "('a'||char(0)||'@example.test')")],
      ['submission.phone', baseSubmission('72000000-0000-4000-8000-000000000004', 'phone', "('+13125550100'||char(0))")],
      ['submission.locale', "INSERT INTO newcomer_submissions (id,name,locale,visit_date,source) VALUES ('72000000-0000-4000-8000-000000000005','NUL',('en'||char(0)),'2026-08-12','staff')"],
      ['submission.visit_date', "INSERT INTO newcomer_submissions (id,name,locale,visit_date,source) VALUES ('72000000-0000-4000-8000-000000000006','NUL','en',('2026-08-12'||char(0)),'staff')"],
      ['submission.contact_consent_at', baseSubmission('72000000-0000-4000-8000-000000000007', 'contact_consent_at', "('2026-08-12 12:00:00'||char(0))")],
      ['submission.source', "INSERT INTO newcomer_submissions (id,name,locale,visit_date,source) VALUES ('72000000-0000-4000-8000-000000000008','NUL','en','2026-08-12',('staff'||char(0)))"],
      ['submission.next_follow_up_date', baseSubmission('72000000-0000-4000-8000-000000000009', 'next_follow_up_date', "('2026-08-13'||char(0))")],
      ['submission.last_mutation_id', baseSubmission('72000000-0000-4000-8000-00000000000a', 'last_mutation_id', `('m'||char(0)||'${'x'.repeat(64)}')`)],
      ['submission.closed_at', baseSubmission('72000000-0000-4000-8000-00000000000b', 'closed_at', "('2026-08-12 12:00:00'||char(0))")],
      ['submission.deleted_at', baseSubmission('72000000-0000-4000-8000-00000000000c', 'deleted_at', "('2026-08-12 12:00:00'||char(0))")],
      ['submission.created_at', "INSERT INTO newcomer_submissions (id,name,locale,visit_date,source,created_at) VALUES ('72000000-0000-4000-8000-00000000000d','NUL','en','2026-08-12','staff',('2026-08-12 12:00:00'||char(0)))"],
      ['submission.updated_at', "INSERT INTO newcomer_submissions (id,name,locale,visit_date,source,updated_at) VALUES ('72000000-0000-4000-8000-00000000000e','NUL','en','2026-08-12','staff',('2026-08-12 12:00:00'||char(0)))"],
      ['answer.submission_id', "INSERT INTO newcomer_answers VALUES (('71000000-0000-4000-8000-000000000001'||char(0)),181,'NUL')"],
      ['answer.value', `INSERT INTO newcomer_answers VALUES ('71000000-0000-4000-8000-000000000001',181,(char(0)||'${'x'.repeat(4001)}'))`],
      ['note.id', "INSERT INTO newcomer_notes VALUES (('73000000-0000-4000-8000-000000000001'||char(0)),'71000000-0000-4000-8000-000000000001',9850,'NUL','2026-08-12 12:00:00')"],
      ['note.submission_id', "INSERT INTO newcomer_notes VALUES ('73000000-0000-4000-8000-000000000002',('71000000-0000-4000-8000-000000000001'||char(0)),9850,'NUL','2026-08-12 12:00:00')"],
      ['note.body', `INSERT INTO newcomer_notes VALUES ('73000000-0000-4000-8000-000000000003','71000000-0000-4000-8000-000000000001',9850,('A'||char(0)||'${'x'.repeat(10000)}'),'2026-08-12 12:00:00')`],
      ['note.created_at', "INSERT INTO newcomer_notes VALUES ('73000000-0000-4000-8000-000000000004','71000000-0000-4000-8000-000000000001',9850,'NUL',('2026-08-12 12:00:00'||char(0)))"],
      ['activity.id', "INSERT INTO newcomer_activity VALUES (('74000000-0000-4000-8000-000000000001'||char(0)),'71000000-0000-4000-8000-000000000001',9850,'submission_created','{}','2026-08-12 12:00:00')"],
      ['activity.submission_id', "INSERT INTO newcomer_activity VALUES ('74000000-0000-4000-8000-000000000002',('71000000-0000-4000-8000-000000000001'||char(0)),9850,'submission_created','{}','2026-08-12 12:00:00')"],
      ['activity.kind', "INSERT INTO newcomer_activity VALUES ('74000000-0000-4000-8000-000000000003','71000000-0000-4000-8000-000000000001',9850,('submission_created'||char(0)),'{}','2026-08-12 12:00:00')"],
      ['activity.metadata_json', "INSERT INTO newcomer_activity VALUES ('74000000-0000-4000-8000-000000000004','71000000-0000-4000-8000-000000000001',9850,'submission_created',('{}'||char(0)),'2026-08-12 12:00:00')"],
      ['activity.created_at', "INSERT INTO newcomer_activity VALUES ('74000000-0000-4000-8000-000000000005','71000000-0000-4000-8000-000000000001',9850,'submission_created','{}',('2026-08-12 12:00:00'||char(0)))"],
      ['rate.bucket_hash', `INSERT INTO newcomer_rate_limits VALUES (('${'a'.repeat(64)}'||char(0)||'1.2.3.4'),'2026-08-12 12:10:00',1,'2026-08-14 12:10:00')`],
      ['rate.window_start', `INSERT INTO newcomer_rate_limits VALUES ('${'b'.repeat(64)}',('2026-08-12 12:10:00'||char(0)),1,'2026-08-14 12:10:00')`],
      ['rate.expires_at', `INSERT INTO newcomer_rate_limits VALUES ('${'c'.repeat(64)}','2026-08-12 12:10:00',1,('2026-08-14 12:10:00'||char(0)))`],
      ['status_i18n.label UTF-8 bytes', `UPDATE newcomer_status_i18n SET label='${'名'.repeat(34)}' WHERE status_id=2 AND locale='en'`],
    ];
    const accepted: string[] = [];
    for (const [name, statement] of probes) {
      try {
        await env.DB.prepare(statement).run();
        accepted.push(name);
      } catch {
        // Rejection is the contract under test.
      }
    }
    expect(accepted).toEqual([]);
  });
});
