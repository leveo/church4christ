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
  [1, 'open', 1, 1, 1, 'New', '新朋友'],
  [2, 'open', 2, 1, 0, 'Assigned', '已分配'],
  [3, 'open', 3, 1, 0, 'Contacted', '已联系'],
  [4, 'closed', 4, 1, 0, 'Connected', '已连接'],
  [5, 'closed', 5, 1, 0, 'Closed', '已关闭'],
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
      SELECT s.id,s.category,s.sort,s.active,s.is_initial,en.label AS en_label,zh.label AS zh_label
      FROM newcomer_statuses s
      JOIN newcomer_status_i18n en ON en.status_id=s.id AND en.locale='en'
      JOIN newcomer_status_i18n zh ON zh.status_id=s.id AND zh.locale='zh'
      ORDER BY s.id
    `).all<Record<string, string | number>>();
    expect(statuses.results.map((row) => [
      row.id, row.category, row.sort, row.active, row.is_initial, row.en_label, row.zh_label,
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
  });

  it('rejects invalid workflow initial states, enums, booleans, ranges, and labels', async () => {
    await reject("INSERT INTO newcomer_statuses (id,category,sort,active,is_initial) VALUES (90,'closed',90,1,1)");
    await reject("INSERT INTO newcomer_statuses (id,category,sort,active,is_initial) VALUES (91,'open',91,0,1)");
    await reject("INSERT INTO newcomer_statuses (id,category,sort,active,is_initial) VALUES (92,'open',92,1,1)");
    await reject("INSERT INTO newcomer_statuses (id,category,sort,active,is_initial) VALUES (93,'pending',93,1,0)");
    await reject("INSERT INTO newcomer_statuses (id,category,sort,active,is_initial) VALUES (94,'open',-1,2,0)");
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
  });

  it('stores only canonical HMAC buckets in ten-minute windows with exact 48-hour expiry', async () => {
    const hash = 'a'.repeat(64);
    await env.DB.prepare(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES (?,'2026-08-12 12:10:00',1,'2026-08-14 12:10:00')`).bind(hash).run();
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${'A'.repeat(64)}','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`);
    await reject(`INSERT INTO newcomer_rate_limits (bucket_hash,window_start,attempts,expires_at)
      VALUES ('${'b'.repeat(63)}','2026-08-12 12:20:00',1,'2026-08-14 12:20:00')`);
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
});
