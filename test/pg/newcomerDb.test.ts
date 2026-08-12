import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import {
  NewcomerConflictError,
  createNewcomerField,
  createNewcomerStatus,
  findNewcomerDuplicateHints,
  listNewcomerAdminConfiguration,
  updateNewcomerField,
  updateNewcomerStatus,
} from '../../src/lib/newcomerDb';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { SessionUser } from '../../src/lib/types';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const superAdmin: SessionUser = {
  id: 9701,
  email: 'super@example.test',
  displayName: 'Super',
  role: 'admin',
  isAdmin: true,
  isEditor: false,
  finance: 0,
  memberTeamIds: [],
  leaderTeamIds: [],
  lang: 'en',
  isSuperAdmin: true,
  adminAreas: [],
};

describe.skipIf(!hasPg)('newcomer read and settings models (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(`
      TRUNCATE newcomer_activity,newcomer_notes,newcomer_answers,newcomer_submissions RESTART IDENTITY CASCADE;
      DELETE FROM newcomer_field_option_i18n WHERE field_id>7;
      DELETE FROM newcomer_field_options WHERE field_id>7;
      DELETE FROM newcomer_field_i18n WHERE field_id>7;
      DELETE FROM newcomer_fields WHERE id>7;
      DELETE FROM newcomer_status_i18n WHERE status_id>5;
      DELETE FROM newcomer_statuses WHERE id>5;
      DELETE FROM service_type_i18n WHERE service_type_id>=9700;
      DELETE FROM service_types WHERE id>=9700;
      DELETE FROM people WHERE id>=9700;
      UPDATE newcomer_statuses SET
        sort=CASE id WHEN 1 THEN 1 WHEN 2 THEN 2 WHEN 3 THEN 3 WHEN 4 THEN 4 ELSE 5 END,
        active=1,is_initial=CASE id WHEN 1 THEN 1 ELSE 0 END;
      UPDATE newcomer_status_i18n SET label=CASE
        WHEN locale='zh' THEN CASE status_id WHEN 1 THEN '新朋友' WHEN 2 THEN '已分配' WHEN 3 THEN '已联系' WHEN 4 THEN '已连接' ELSE '已关闭' END
        ELSE CASE status_id WHEN 1 THEN 'New' WHEN 2 THEN 'Assigned' WHEN 3 THEN 'Contacted' WHEN 4 THEN 'Connected' ELSE 'Closed' END END;
      UPDATE newcomer_fields SET sort=id WHERE id<=7;
    `);
  });

  afterAll(async () => { await sql?.end(); });

  it('matches localized configuration and minimal duplicate-hint reads', async () => {
    await sql.unsafe(`
      INSERT INTO people (id,display_name,email,phone,deleted_at) VALUES
        (9701,'Live exact','live@example.test','+13125550101',NULL),
        (9702,'Deleted exact','deleted@example.test','+13125550102','2026-08-01 12:00:00');
      INSERT INTO service_types (id,sort) VALUES (9701,1);
      INSERT INTO service_type_i18n VALUES (9701,'en','Welcome');
      INSERT INTO newcomer_fields VALUES (8,'connection_path','select',1,1,8,0);
      INSERT INTO newcomer_field_i18n VALUES (8,'en','Connection path',NULL);
      INSERT INTO newcomer_field_options VALUES (8,'group',1,1);
      INSERT INTO newcomer_field_option_i18n VALUES (8,'group','en','Small group');
      INSERT INTO newcomer_submissions
        (id,name,email,locale,visit_date,source,status_id,created_at,updated_at)
      VALUES ('10000000-0000-4000-8000-000000000001','First','deleted@example.test','en',
        '2026-08-10','public',1,'2026-08-10 10:00:00','2026-08-12 10:00:00');
    `);
    const config = await listNewcomerAdminConfiguration(db, 'supabase', superAdmin, 'zh');
    expect(config.fields.find((field) => field.id === 8)).toMatchObject({
      label: 'Connection path', options: [{ value: 'group', label: 'Small group' }],
    });
    expect(config.serviceTypes).toEqual([{ id: 9701, label: 'Welcome' }]);
    expect(await findNewcomerDuplicateHints(db, superAdmin, {
      email: 'deleted@example.test', phone: '+13125550102', excludeSubmissionId: null,
    })).toEqual([
      { kind: 'person_deleted', id: 9702 },
      { kind: 'submission_open', id: '10000000-0000-4000-8000-000000000001', statusId: 1 },
    ]);
  });

  it('creates and updates statuses/fields with the same transactional results', async () => {
    const statusId = await createNewcomerStatus(db, superAdmin, {
      key: 'reviewing', category: 'open', sort: 6, active: true,
      labelEn: 'Reviewing', labelZh: '审核中',
    });
    await updateNewcomerStatus(db, superAdmin, {
      id: statusId, sort: 7, active: true, initialStatusId: statusId,
      labelEn: 'Under review', labelZh: '审核中',
    });
    const fieldId = await createNewcomerField(db, superAdmin, {
      key: 'connection_path', type: 'select', required: true, active: true, sort: 8,
      labelEn: 'Connection path', labelZh: '连接方式', helpEn: null, helpZh: null,
      options: [{ value: 'group', sort: 1, active: true, labelEn: 'Group', labelZh: '小组' }],
    });
    await updateNewcomerField(db, superAdmin, {
      id: fieldId, required: false, active: true, sort: 9,
      labelEn: 'Next step', labelZh: '下一步', helpEn: 'Choose', helpZh: null,
      options: [{ value: 'serve', sort: 2, active: true, labelEn: 'Serve', labelZh: '服事' }],
    });
    const [initial] = await sql.unsafe<{ id: number }[]>(`SELECT id FROM newcomer_statuses
      WHERE active=1 AND category='open' AND is_initial=1`);
    expect(Number(initial.id)).toBe(statusId);
    expect((await sql.unsafe<{ value: string }[]>(`SELECT value FROM newcomer_field_options
      WHERE field_id=$1`, [fieldId]))[0].value).toBe('serve');
  });

  it('rolls back an invalid last-initial update without leaking database text', async () => {
    const error = await updateNewcomerStatus(db, superAdmin, {
      id: 1, sort: 99, active: false, initialStatusId: 4,
      labelEn: 'Must roll back', labelZh: '必须回滚',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NewcomerConflictError);
    expect(String(error)).not.toMatch(/foreign|constraint|postgres|status_id/i);
    const [stored] = await sql.unsafe<{ sort: number; active: number; is_initial: number }[]>(
      'SELECT sort,active,is_initial FROM newcomer_statuses WHERE id=1',
    );
    expect(stored).toEqual({ sort: 1, active: 1, is_initial: 1 });
  });

  it('maps concurrent MAX(id) and initial-switch races to safe conflicts without zero/multiple initials', async () => {
    const clientA = pgClient();
    const clientB = pgClient();
    try {
      const createResults = await Promise.allSettled([
        createNewcomerStatus(new PgAdapter(clientA), superAdmin, {
          key: 'race_a', category: 'open', sort: 6, active: true, labelEn: 'A', labelZh: '甲',
        }),
        createNewcomerStatus(new PgAdapter(clientB), superAdmin, {
          key: 'race_b', category: 'open', sort: 7, active: true, labelEn: 'B', labelZh: '乙',
        }),
      ]);
      expect(createResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejectedCreate = createResults.find((result) => result.status === 'rejected');
      expect(rejectedCreate?.status === 'rejected' && rejectedCreate.reason).toBeInstanceOf(NewcomerConflictError);

      const [{ id: customId }] = await sql.unsafe<{ id: number }[]>(
        'SELECT id FROM newcomer_statuses WHERE id>5 ORDER BY id',
      );
      const switches = await Promise.allSettled([
        updateNewcomerStatus(new PgAdapter(clientA), superAdmin, {
          id: 2, sort: 2, active: true, initialStatusId: 2, labelEn: 'Assigned', labelZh: '已分配',
        }),
        updateNewcomerStatus(new PgAdapter(clientB), superAdmin, {
          id: Number(customId), sort: 6, active: true, initialStatusId: Number(customId),
          labelEn: 'Custom', labelZh: '自定义',
        }),
      ]);
      expect(switches.some((result) => result.status === 'fulfilled')).toBe(true);
      for (const rejected of switches.filter((result) => result.status === 'rejected')) {
        expect(rejected.status === 'rejected' && rejected.reason).toBeInstanceOf(NewcomerConflictError);
      }
      const [{ count }] = await sql.unsafe<{ count: number }[]>(`SELECT COUNT(*)::int AS count
        FROM newcomer_statuses WHERE active=1 AND category='open' AND is_initial=1`);
      expect(Number(count)).toBe(1);
    } finally {
      await Promise.all([clientA.end(), clientB.end()]);
    }
  });

  it('serializes active-option cap checks across different field transactions', async () => {
    const fieldRows = Array.from({ length: 11 }, (_, index) =>
      `(${8 + index},'cap_${index}','select',0,1,${8 + index},0)`).join(',');
    const optionRows: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const count = index < 2 ? 99 : index === 2 ? 1 : 100;
      for (let option = 0; option < count; option += 1) {
        optionRows.push(`(${8 + index},'v_${option}',${option},1)`);
      }
    }
    await sql.unsafe(`INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES ${fieldRows};
      INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES ${optionRows.join(',')}`);
    const replacement = (prefix: string) => Array.from({ length: 100 }, (_, index) => ({
      value: `${prefix}_${index}`, sort: index, active: true,
      labelEn: `${prefix} ${index}`, labelZh: `${prefix} ${index}`,
    }));
    const clientA = pgClient();
    const clientB = pgClient();
    let guardArrivals = 0;
    let releaseGuards = () => {};
    const guardGate = new Promise<void>((resolve) => { releaseGuards = resolve; });
    const atGuard = async () => {
      guardArrivals += 1;
      if (guardArrivals === 2) releaseGuards();
      await Promise.race([guardGate, new Promise<void>((resolve) => setTimeout(resolve, 150))]);
    };
    const barrierClient = (client: ReturnType<typeof pgClient>) => ({
      begin: async (callback: (transaction: { unsafe: typeof client.unsafe }) => Promise<unknown>) => client.begin(
        async (transaction) => callback({
          unsafe: (async (query: string, parameters?: never[]) => {
            const rows = await transaction.unsafe(query, parameters);
            if (query.includes("SELECT 0,'en','guard'")) await atGuard();
            return rows;
          }) as typeof client.unsafe,
        }),
      ),
    });
    try {
      const results = await Promise.allSettled([
        updateNewcomerField(new PgAdapter(barrierClient(clientA) as never), superAdmin, {
          id: 8, required: false, active: true, sort: 8,
          labelEn: 'Cap A', labelZh: '上限 A', helpEn: null, helpZh: null,
          options: replacement('a'),
        }),
        updateNewcomerField(new PgAdapter(barrierClient(clientB) as never), superAdmin, {
          id: 9, required: false, active: true, sort: 9,
          labelEn: 'Cap B', labelZh: '上限 B', helpEn: null, helpZh: null,
          options: replacement('b'),
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(NewcomerConflictError);
      const [{ count }] = await sql.unsafe<{ count: number }[]>(
        'SELECT COUNT(*)::int AS count FROM newcomer_field_options WHERE active=1',
      );
      expect(Number(count)).toBe(1_000);
    } finally {
      await Promise.all([clientA.end(), clientB.end()]);
    }
  });
});
