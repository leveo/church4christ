import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb, AppStatement } from '../../src/lib/appDb';
import {
  NewcomerConflictError,
  NewcomerEmailRequiredError,
  addNewcomerNote,
  assignNewcomer,
  changeNewcomerStatus,
  createNewcomerSubmission,
  createNewcomerVisitor,
  linkNewcomerPerson,
  reconcileNewcomerMutation,
  scheduleNewcomerFollowUp,
} from '../../src/lib/newcomerDb';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { SessionUser } from '../../src/lib/types';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const worker: SessionUser = {
  id: 9901,
  email: 'pg-worker@example.test',
  displayName: 'PG Worker',
  role: 'member',
  isAdmin: false,
  isEditor: false,
  finance: 0,
  memberTeamIds: [],
  leaderTeamIds: [],
  lang: 'en',
  isSuperAdmin: false,
  adminAreas: ['newcomers'],
};

function runtime(ids: string[], now = '2026-08-12 18:00:00') {
  let index = 0;
  return { now: () => now, randomUUID: () => ids[index++] };
}

describe.skipIf(!hasPg)('newcomer mutation parity and races (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const observer = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  async function waitForBlockedTargetMutation() {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [state] = await observer.unsafe<{ blocked: number }[]>(`
        SELECT COUNT(*)::int AS blocked FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%UPDATE people AS person SET updated_at=person.updated_at%'
      `);
      if (state.blocked > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('target mutation did not reach the PostgreSQL lock barrier');
  }

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
      TRUNCATE people RESTART IDENTITY CASCADE;
      DELETE FROM newcomer_field_option_i18n WHERE field_id>7;
      DELETE FROM newcomer_field_options WHERE field_id>7;
      DELETE FROM newcomer_field_i18n WHERE field_id>7;
      DELETE FROM newcomer_fields WHERE id>7;
      UPDATE newcomer_statuses SET active=1,is_initial=0;
      UPDATE newcomer_statuses SET is_initial=1 WHERE id=1;
      INSERT INTO people (id,display_name,email,role,active,super_admin,admin_areas) VALUES
        (9901,'PG Worker','pg-worker@example.test','member',1,0,'newcomers'),
        (9902,'PG Assignee','pg-assignee@example.test','editor',1,0,'newcomers'),
        (9903,'PG Other','pg-other@example.test','member',1,0,'newcomers'),
        (9904,'PG People Admin','pg-people-admin@example.test','admin',1,0,'newcomers,people');
      INSERT INTO newcomer_submissions
        (id,name,email,phone,locale,visit_date,source,status_id,version,created_at,updated_at)
      VALUES ('71000000-0000-4000-8000-000000000001','PG Guest','pg-guest@example.test',
        '+13125550131','en','2026-08-10','staff',1,0,'2026-08-12 09:00:00','2026-08-12 09:00:00');
    `);
  });

  afterAll(async () => { await Promise.all([sql?.end(), observer?.end()]); });

  it('retries caller-owned operations and recovers a committed PostgreSQL transport failure', async () => {
    const operationId = '71200000-0000-4000-8000-000000000001';
    const input = {
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0,
      assigneePersonId: 9902, operationId,
    };
    const first = await assignNewcomer(db, worker, input, runtime([
      '71200000-0000-4000-8000-000000000002',
    ]));
    await expect(assignNewcomer(db, worker, input, runtime([
      '71200000-0000-4000-8000-000000000003',
    ]))).resolves.toEqual(first);
    await expect(assignNewcomer(db, worker, { ...input, assigneePersonId: 9903 }, runtime([
      '71200000-0000-4000-8000-000000000004',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);

    let batchCalls = 0;
    const committedThenRejected: AppDb = {
      prepare(sqlText: string) { return db.prepare(sqlText); },
      async batch<T = unknown>(statements: AppStatement[]) {
        const results = await db.batch<T>(statements);
        batchCalls += 1;
        if (batchCalls === 1) throw new Error('transport failed after commit');
        return results;
      },
    };
    const followOperationId = '71210000-0000-4000-8000-000000000001';
    await expect(scheduleNewcomerFollowUp(committedThenRejected, worker, {
      submissionId: input.submissionId, expectedVersion: 1,
      followUpDate: '2026-08-31', operationId: followOperationId,
    }, runtime(['71210000-0000-4000-8000-000000000002'])))
      .resolves.toEqual({ version: 2, operationId: followOperationId });
  });

  it('reconciles an operation receipt after a later operation overwrites the submission carrier', async () => {
    const submissionId = '71000000-0000-4000-8000-000000000001';
    const operationId = '71211000-0000-4000-8000-000000000001';
    const input = { submissionId, expectedVersion: 0, assigneePersonId: 9902, operationId };
    await expect(assignNewcomer(db, worker, input, runtime([
      '71211000-0000-4000-8000-000000000002',
    ]))).resolves.toEqual({ version: 1, operationId });
    await scheduleNewcomerFollowUp(db, worker, {
      submissionId, expectedVersion: 1, followUpDate: '2026-08-31',
      operationId: '71211000-0000-4000-8000-000000000003',
    }, runtime(['71211000-0000-4000-8000-000000000004']));

    await expect(reconcileNewcomerMutation(db, worker, { submissionId, operationId }))
      .resolves.toEqual({ status: 'applied', version: 1 });
    await expect(assignNewcomer(db, worker, input, runtime([
      '71211000-0000-4000-8000-000000000005',
    ]))).resolves.toEqual({ version: 1, operationId });
    await expect(assignNewcomer(db, worker, { ...input, assigneePersonId: 9903 }, runtime([
      '71211000-0000-4000-8000-000000000006',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
  });

  it('recovers A from its receipt when B commits before A observes a post-commit transport failure', async () => {
    const submissionId = '71000000-0000-4000-8000-000000000001';
    const operationId = '71212000-0000-4000-8000-000000000001';
    let injected = false;
    const commitAThenBThenReject: AppDb = {
      prepare(sqlText: string) { return db.prepare(sqlText); },
      async batch<T = unknown>(statements: AppStatement[]) {
        const results = await db.batch<T>(statements);
        if (!injected) {
          injected = true;
          await scheduleNewcomerFollowUp(db, worker, {
            submissionId, expectedVersion: 1, followUpDate: '2026-09-01',
            operationId: '71212000-0000-4000-8000-000000000003',
          }, runtime(['71212000-0000-4000-8000-000000000004']));
          throw new Error('transport failed after A and B committed');
        }
        return results;
      },
    };

    await expect(assignNewcomer(commitAThenBThenReject, worker, {
      submissionId, expectedVersion: 0, assigneePersonId: 9902, operationId,
    }, runtime(['71212000-0000-4000-8000-000000000002'])))
      .resolves.toEqual({ version: 1, operationId });
    const [state] = await sql.unsafe<{ version: number; follow_up: string }[]>(`
      SELECT version,next_follow_up_date AS follow_up FROM newcomer_submissions WHERE id=$1
    `, [submissionId]);
    expect(state).toEqual({ version: 2, follow_up: '2026-09-01' });
  });

  it('replays every historical action receipt after later operations change current workflow state', async () => {
    const submissionId = '71000000-0000-4000-8000-000000000001';
    const reset = async () => {
      await sql.unsafe(`
        TRUNCATE newcomer_activity,newcomer_notes,newcomer_answers,newcomer_submissions CASCADE;
        DELETE FROM people WHERE email='pg-guest@example.test';
        UPDATE people SET phone=NULL WHERE id IN (9902,9903);
        INSERT INTO newcomer_submissions
          (id,name,email,phone,locale,visit_date,source,status_id,version,created_at,updated_at)
        VALUES ('${submissionId}','PG Guest','pg-guest@example.test','+13125550131','en',
          '2026-08-10','staff',1,0,'2026-08-12 09:00:00','2026-08-12 09:00:00');
      `);
    };

    await reset();
    const assignment = { submissionId, expectedVersion: 0, assigneePersonId: 9902,
      operationId: '71310000-0000-4000-8000-000000000001' };
    const assignmentResult = await assignNewcomer(db, worker, assignment,
      runtime(['71310000-0000-4000-8000-000000000002']));
    await assignNewcomer(db, worker, {
      submissionId, expectedVersion: 1, assigneePersonId: null,
      operationId: '71310000-0000-4000-8000-000000000003',
    }, runtime(['71310000-0000-4000-8000-000000000004']));
    await expect(assignNewcomer(db, worker, assignment,
      runtime(['71310000-0000-4000-8000-000000000005']))).resolves.toEqual(assignmentResult);
    await expect(assignNewcomer(db, worker, { ...assignment, assigneePersonId: null },
      runtime(['71310000-0000-4000-8000-000000000006'])))
      .rejects.toBeInstanceOf(NewcomerConflictError);

    await reset();
    const status = { submissionId, expectedVersion: 0, statusId: 4,
      operationId: '71320000-0000-4000-8000-000000000001' };
    const statusResult = await changeNewcomerStatus(db, worker, status,
      runtime(['71320000-0000-4000-8000-000000000002']));
    await changeNewcomerStatus(db, worker, {
      submissionId, expectedVersion: 1, statusId: 5,
      operationId: '71320000-0000-4000-8000-000000000003',
    }, runtime(['71320000-0000-4000-8000-000000000004']));
    await expect(changeNewcomerStatus(db, worker, status,
      runtime(['71320000-0000-4000-8000-000000000005']))).resolves.toEqual(statusResult);
    await expect(changeNewcomerStatus(db, worker, { ...status, statusId: 5 },
      runtime(['71320000-0000-4000-8000-000000000006'])))
      .rejects.toBeInstanceOf(NewcomerConflictError);

    await reset();
    const follow = { submissionId, expectedVersion: 0, followUpDate: '2026-08-31',
      operationId: '71330000-0000-4000-8000-000000000001' };
    const followResult = await scheduleNewcomerFollowUp(db, worker, follow,
      runtime(['71330000-0000-4000-8000-000000000002']));
    await scheduleNewcomerFollowUp(db, worker, {
      submissionId, expectedVersion: 1, followUpDate: null,
      operationId: '71330000-0000-4000-8000-000000000003',
    }, runtime(['71330000-0000-4000-8000-000000000004']));
    await expect(scheduleNewcomerFollowUp(db, worker, follow,
      runtime(['71330000-0000-4000-8000-000000000005']))).resolves.toEqual(followResult);
    await expect(scheduleNewcomerFollowUp(db, worker, { ...follow, followUpDate: null },
      runtime(['71330000-0000-4000-8000-000000000006'])))
      .rejects.toBeInstanceOf(NewcomerConflictError);

    await reset();
    const note = { submissionId, expectedVersion: 0, body: 'PG historical note',
      operationId: '71340000-0000-4000-8000-000000000001' };
    const noteResult = await addNewcomerNote(db, worker, note,
      runtime(['71340000-0000-4000-8000-000000000002']));
    await scheduleNewcomerFollowUp(db, worker, {
      submissionId, expectedVersion: 1, followUpDate: '2026-09-02',
      operationId: '71340000-0000-4000-8000-000000000003',
    }, runtime(['71340000-0000-4000-8000-000000000004']));
    await expect(addNewcomerNote(db, worker, note,
      runtime(['71340000-0000-4000-8000-000000000005']))).resolves.toEqual(noteResult);
    await expect(addNewcomerNote(db, worker, { ...note, body: 'Different PG note' },
      runtime(['71340000-0000-4000-8000-000000000006'])))
      .rejects.toBeInstanceOf(NewcomerConflictError);

    await reset();
    await sql.unsafe("UPDATE people SET phone='+1 (312) 555-0131' WHERE id IN (9902,9903)");
    const link = { submissionId, expectedVersion: 0, personId: 9903,
      operationId: '71350000-0000-4000-8000-000000000001' };
    const linkResult = await linkNewcomerPerson(db, worker, link,
      runtime(['71350000-0000-4000-8000-000000000002']));
    await linkNewcomerPerson(db, worker, {
      submissionId, expectedVersion: 1, personId: 9902,
      operationId: '71350000-0000-4000-8000-000000000003',
    }, runtime(['71350000-0000-4000-8000-000000000004']));
    await expect(linkNewcomerPerson(db, worker, link,
      runtime(['71350000-0000-4000-8000-000000000005']))).resolves.toEqual(linkResult);
    await expect(linkNewcomerPerson(db, worker, { ...link, personId: 9902 },
      runtime(['71350000-0000-4000-8000-000000000006'])))
      .rejects.toBeInstanceOf(NewcomerConflictError);

    await reset();
    const peopleAdmin = { ...worker, id: 9904, role: 'admin' as const, isAdmin: true,
      adminAreas: ['newcomers', 'people'] as SessionUser['adminAreas'] };
    const visitor = { submissionId, expectedVersion: 0,
      operationId: '71360000-0000-4000-8000-000000000001' };
    const visitorResult = await createNewcomerVisitor(db, peopleAdmin, visitor,
      runtime(['71360000-0000-4000-8000-000000000002']));
    await sql.unsafe("UPDATE people SET phone='+1 (312) 555-0131' WHERE id=9903");
    await linkNewcomerPerson(db, worker, {
      submissionId, expectedVersion: 1, personId: 9903,
      operationId: '71360000-0000-4000-8000-000000000003',
    }, runtime(['71360000-0000-4000-8000-000000000004']));
    await expect(createNewcomerVisitor(db, peopleAdmin, visitor,
      runtime(['71360000-0000-4000-8000-000000000005']))).resolves.toEqual(visitorResult);
    await expect(scheduleNewcomerFollowUp(db, worker, {
      submissionId, expectedVersion: 2, followUpDate: '2026-09-03', operationId: visitor.operationId,
    }, runtime(['71360000-0000-4000-8000-000000000006'])))
      .rejects.toBeInstanceOf(NewcomerConflictError);
  });

  it('reconciles an immutable create receipt after a later PostgreSQL workflow change', async () => {
    const operationId = '71370000-0000-4000-8000-000000000001';
    const input = {
      name: 'PG historical create', email: 'pg-historical-create@example.test', phone: null,
      locale: 'en' as const, visitDate: '2026-08-11', serviceTypeId: null,
      contactConsent: true, answers: [],
    };
    const created = await createNewcomerSubmission(db, null, 'public', input, {
      backend: 'supabase', operationId,
    }, runtime(['71370000-0000-4000-8000-000000000002']));
    await changeNewcomerStatus(db, worker, {
      submissionId: operationId, expectedVersion: 0, statusId: 2,
      operationId: '71370000-0000-4000-8000-000000000003',
    }, runtime(['71370000-0000-4000-8000-000000000004']));
    await expect(createNewcomerSubmission(db, null, 'public', input, {
      backend: 'supabase', operationId,
    }, runtime(['71370000-0000-4000-8000-000000000005']))).resolves.toEqual(created);
    await expect(createNewcomerSubmission(db, null, 'public', { ...input, name: 'Different create' }, {
      backend: 'supabase', operationId,
    }, runtime(['71370000-0000-4000-8000-000000000006'])))
      .rejects.toBeInstanceOf(NewcomerConflictError);
  });

  it('makes concurrent same-operation creates converge to one exact PostgreSQL outcome', async () => {
    const operationId = '71220000-0000-4000-8000-000000000001';
    const input = {
      name: 'Concurrent retry', email: 'pg-retry@example.test', phone: null,
      locale: 'en' as const, visitDate: '2026-08-11', serviceTypeId: null,
      contactConsent: true, answers: [],
    };
    const results = await Promise.all([
      createNewcomerSubmission(db, null, 'public', input, { backend: 'supabase', operationId },
        runtime(['71220000-0000-4000-8000-000000000002'])),
      createNewcomerSubmission(db, null, 'public', input, { backend: 'supabase', operationId },
        runtime(['71220000-0000-4000-8000-000000000003'])),
    ]);
    expect(results).toEqual([
      { id: operationId, version: 0, operationId },
      { id: operationId, version: 0, operationId },
    ]);
    const [counts] = await sql.unsafe<{ submissions: number; activities: number }[]>(`
      SELECT (SELECT COUNT(*)::int FROM newcomer_submissions WHERE id=$1) AS submissions,
        (SELECT COUNT(*)::int FROM newcomer_activity WHERE submission_id=$1) AS activities
    `, [operationId]);
    expect(counts).toEqual({ submissions: 1, activities: 1 });
  });

  it('bulk-inserts 0 through 100 answers with a fixed PostgreSQL statement budget', async () => {
    for (const count of [0, 31, 32, 44, 45, 100]) {
      await sql.unsafe(`
        TRUNCATE newcomer_activity,newcomer_answers,newcomer_submissions CASCADE;
        DELETE FROM newcomer_fields WHERE id>7;
      `);
      if (count > 0) {
        const values = Array.from({ length: count }, (_, index) =>
          `(${index + 8},'pg_bulk_${index + 8}','checkbox',1,1,${index + 8},0)`).join(',');
        await sql.unsafe(`INSERT INTO newcomer_fields
          (id,key,type,required,active,sort,fixed) VALUES ${values}`);
      }
      const bindCounts: number[] = [];
      let statementCount = -1;
      const underlying = new WeakMap<AppStatement, AppStatement>();
      const recordingDb: AppDb = {
        prepare(sqlText: string) {
          let statement = db.prepare(sqlText);
          const wrapper: AppStatement = {
            bind(...values: unknown[]) {
              bindCounts.push(values.length);
              statement = statement.bind(...values);
              underlying.set(wrapper, statement);
              return wrapper;
            },
            first: (column?: string) => column === undefined ? statement.first() : statement.first(column),
            all: () => statement.all(),
            run: () => statement.run(),
          };
          bindCounts.push(0);
          underlying.set(wrapper, statement);
          return wrapper;
        },
        batch(statements: AppStatement[]) {
          statementCount = statements.length;
          return db.batch(statements.map((statement) => underlying.get(statement)!));
        },
      };
      const operationId = `71300000-0000-4000-8000-${String(count).padStart(12, '0')}`;
      const created = await createNewcomerSubmission(recordingDb, null, 'public', {
        name: `PG Bulk ${count}`, email: `pg-bulk-${count}@example.test`, phone: null, locale: 'en',
        visitDate: '2026-08-11', serviceTypeId: null, contactConsent: true,
        answers: Array.from({ length: count }, (_, index) => ({ fieldId: index + 8, value: 'true' })),
      }, { backend: 'supabase', operationId }, runtime([
        '71300000-0000-4000-8000-100000000001',
      ]));
      expect(created).toEqual({ id: operationId, version: 0, operationId });
      expect(statementCount).toBe(7);
      expect(Math.max(...bindCounts)).toBeLessThanOrEqual(100);
      const [answers] = await sql.unsafe<{ count: number }[]>(`
        SELECT COUNT(*)::int AS count FROM newcomer_answers WHERE submission_id=$1
      `, [operationId]);
      expect(answers.count).toBe(count);
    }
  });

  it('uses the same segment-safe scoped assignee grant and canonical CAS activity', async () => {
    await expect(assignNewcomer(
      db,
      worker,
      { operationId: '71000000-0000-4000-8000-000000000011',
        submissionId: '71000000-0000-4000-8000-000000000001',
        expectedVersion: 0,
        assigneePersonId: 9902,
      },
      runtime([
        '71000000-0000-4000-8000-000000000012',
      ]),
    )).resolves.toEqual({
      version: 1, operationId: '71000000-0000-4000-8000-000000000011',
    });
    const [submission] = await sql.unsafe<{ assignee_person_id: number; version: number }[]>(`
      SELECT assignee_person_id,version FROM newcomer_submissions
      WHERE id='71000000-0000-4000-8000-000000000001'
    `);
    expect(submission).toEqual({ assignee_person_id: 9902, version: 1 });
    const [activity] = await sql.unsafe<{ metadata_json: string }[]>(`
      SELECT metadata_json FROM newcomer_activity
    `);
    expect(activity.metadata_json).toBe('{"to_assignee_person_id":9902}');
  });

  it('persists create/status/follow-up/note with byte-for-byte canonical activity', async () => {
    await sql.unsafe(`
      INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed)
      VALUES (8,'story','textarea',1,1,8,0);
    `);
    await expect(createNewcomerSubmission(
      db,
      worker,
      'staff',
      {
        name: 'PG Created', email: 'pg-created@example.test', phone: null, locale: 'zh',
        visitDate: '2026-08-11', serviceTypeId: null, contactConsent: false,
        answers: [{ fieldId: 8, value: 'A safe answer' }],
      },
      { backend: 'supabase', operationId: '72000000-0000-4000-8000-000000000001' },
      runtime([
        '72000000-0000-4000-8000-000000000002',
      ]),
    )).resolves.toEqual({
      id: '72000000-0000-4000-8000-000000000001',
      version: 0,
      operationId: '72000000-0000-4000-8000-000000000001',
    });
    const [created] = await sql.unsafe<{ contact_consent_at: string | null; actor_person_id: number; metadata_json: string }[]>(`
      SELECT submission.contact_consent_at,activity.actor_person_id,activity.metadata_json
      FROM newcomer_submissions submission JOIN newcomer_activity activity ON activity.submission_id=submission.id
      WHERE submission.id='72000000-0000-4000-8000-000000000001'
    `);
    expect(created).toEqual({ contact_consent_at: null, actor_person_id: 9901, metadata_json: '{}' });

    await changeNewcomerStatus(db, worker, { operationId: '72000000-0000-4000-8000-000000000011',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, statusId: 4,
    }, runtime([
      '72000000-0000-4000-8000-000000000012',
    ], '2026-08-12 18:01:00'));
    await scheduleNewcomerFollowUp(db, worker, { operationId: '72000000-0000-4000-8000-000000000013',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 1, followUpDate: '2026-08-25',
    }, runtime([
      '72000000-0000-4000-8000-000000000014',
    ], '2026-08-12 18:02:00'));
    await addNewcomerNote(db, worker, { operationId: '72000000-0000-4000-8000-000000000015',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 2, body: 'PG note',
    }, runtime([
      '72000000-0000-4000-8000-000000000016',
      '72000000-0000-4000-8000-000000000017',
    ], '2026-08-12 18:03:00'));
    const activity = await sql.unsafe<{ kind: string; metadata_json: string }[]>(`
      SELECT kind,metadata_json FROM newcomer_activity
      WHERE submission_id='71000000-0000-4000-8000-000000000001' ORDER BY created_at,id
    `);
    expect(activity).toEqual([
      { kind: 'status_changed', metadata_json: '{"from_status_id":1,"to_status_id":4}' },
      { kind: 'follow_up_scheduled', metadata_json: '{"follow_up_date":"2026-08-25"}' },
      { kind: 'note_added', metadata_json: '{"note_id":"72000000-0000-4000-8000-000000000015"}' },
    ]);
  });

  it('serializes two transactions claiming the same expected version so the loser has no residue', async () => {
    const attempts = await Promise.allSettled([
      assignNewcomer(db, worker, { operationId: '73000000-0000-4000-8000-000000000011',
        submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, assigneePersonId: 9902,
      }, runtime([
        '73000000-0000-4000-8000-000000000012',
      ])),
      assignNewcomer(db, worker, { operationId: '73000000-0000-4000-8000-000000000013',
        submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, assigneePersonId: 9903,
      }, runtime([
        '73000000-0000-4000-8000-000000000014',
      ])),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((item) => item.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(NewcomerConflictError) });
    const [state] = await sql.unsafe<{ version: number; activities: number }[]>(`
      SELECT submission.version,(SELECT COUNT(*)::int FROM newcomer_activity
        WHERE submission_id=submission.id) AS activities
      FROM newcomer_submissions submission
      WHERE id='71000000-0000-4000-8000-000000000001'
    `);
    expect(state).toEqual({ version: 1, activities: 1 });
  });

  it('rechecks a locked link target after a concurrent contact change', async () => {
    await sql.unsafe(`UPDATE people SET phone='+1 (312) 555-0131' WHERE id=9903`);
    let release!: () => void;
    let locked!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    const blocker = sql.begin(async (tx) => {
      await tx.unsafe(`UPDATE people SET phone='+1 (312) 555-0199' WHERE id=9903`);
      locked();
      await releasePromise;
    });
    await lockedPromise;
    const linkAttempt = linkNewcomerPerson(db, worker, { operationId: '74000000-0000-4000-8000-000000000011',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, personId: 9903,
    }, runtime([
      '74000000-0000-4000-8000-000000000012',
    ]));
    await waitForBlockedTargetMutation();
    release();
    await blocker;
    await expect(linkAttempt).rejects.toBeInstanceOf(NewcomerConflictError);
    const [state] = await sql.unsafe<{ version: number; linked_person_id: number | null; activities: number }[]>(`
      SELECT submission.version,submission.linked_person_id,
        (SELECT COUNT(*)::int FROM newcomer_activity WHERE submission_id=submission.id) AS activities
      FROM newcomer_submissions submission
      WHERE id='71000000-0000-4000-8000-000000000001'
    `);
    expect(state).toEqual({ version: 0, linked_person_id: null, activities: 0 });

    await sql.unsafe(`UPDATE people SET phone='+1 (312) 555-0131',deleted_at=NULL WHERE id=9903`);
    let releaseDelete!: () => void;
    let deleteLocked!: () => void;
    const releaseDeletePromise = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const deleteLockedPromise = new Promise<void>((resolve) => { deleteLocked = resolve; });
    const deleteBlocker = sql.begin(async (tx) => {
      await tx.unsafe(`UPDATE people SET deleted_at='2026-08-12 18:00:00' WHERE id=9903`);
      deleteLocked();
      await releaseDeletePromise;
    });
    await deleteLockedPromise;
    const deletedLinkAttempt = linkNewcomerPerson(db, worker, { operationId: '74000000-0000-4000-8000-000000000013',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, personId: 9903,
    }, runtime([
      '74000000-0000-4000-8000-000000000014',
    ]));
    await waitForBlockedTargetMutation();
    releaseDelete();
    await deleteBlocker;
    await expect(deletedLinkAttempt).rejects.toBeInstanceOf(NewcomerConflictError);
    const [deletedState] = await sql.unsafe<{
      version: number; linked_person_id: number | null; activities: number;
    }[]>(`
      SELECT submission.version,submission.linked_person_id,
        (SELECT COUNT(*)::int FROM newcomer_activity WHERE submission_id=submission.id) AS activities
      FROM newcomer_submissions submission
      WHERE id='71000000-0000-4000-8000-000000000001'
    `);
    expect(deletedState).toEqual({ version: 0, linked_person_id: null, activities: 0 });
  });

  it('rechecks a locked assignee after a concurrent Newcomers grant revocation', async () => {
    let release!: () => void;
    let locked!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    const blocker = sql.begin(async (tx) => {
      await tx.unsafe(`UPDATE people SET admin_areas='' WHERE id=9902`);
      locked();
      await releasePromise;
    });
    await lockedPromise;
    const assignmentAttempt = assignNewcomer(db, worker, { operationId: '74100000-0000-4000-8000-000000000011',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, assigneePersonId: 9902,
    }, runtime([
      '74100000-0000-4000-8000-000000000012',
    ]));
    await waitForBlockedTargetMutation();
    release();
    await blocker;
    await expect(assignmentAttempt).rejects.toBeInstanceOf(NewcomerConflictError);
    const [state] = await sql.unsafe<{ version: number; assignee_person_id: number | null; activities: number }[]>(`
      SELECT submission.version,submission.assignee_person_id,
        (SELECT COUNT(*)::int FROM newcomer_activity WHERE submission_id=submission.id) AS activities
      FROM newcomer_submissions submission
      WHERE id='71000000-0000-4000-8000-000000000001'
    `);
    expect(state).toEqual({ version: 0, assignee_person_id: null, activities: 0 });
  });

  it('lets exactly one visitor-email race commit and leaves the loser completely unchanged', async () => {
    await sql.unsafe(`
      INSERT INTO newcomer_submissions
        (id,name,email,locale,visit_date,source,status_id,version,created_at,updated_at) VALUES
        ('75000000-0000-4000-8000-000000000001','Race One','pg-race@example.test','en','2026-08-10',
          'staff',1,0,'2026-08-12 09:00:00','2026-08-12 09:00:00'),
        ('75000000-0000-4000-8000-000000000002','Race Two','pg-race@example.test','en','2026-08-10',
          'staff',1,0,'2026-08-12 09:00:00','2026-08-12 09:00:00');
    `);
    const peopleAdmin = { ...worker, id: 9904, email: 'pg-people-admin@example.test', role: 'admin' as const,
      isAdmin: true, adminAreas: ['newcomers', 'people'] as SessionUser['adminAreas'] };
    const attempts = await Promise.allSettled([
      createNewcomerVisitor(db, peopleAdmin, { operationId: '75000000-0000-4000-8000-000000000011',
        submissionId: '75000000-0000-4000-8000-000000000001', expectedVersion: 0,
      }, runtime([
        '75000000-0000-4000-8000-000000000012',
      ])),
      createNewcomerVisitor(db, peopleAdmin, { operationId: '75000000-0000-4000-8000-000000000013',
        submissionId: '75000000-0000-4000-8000-000000000002', expectedVersion: 0,
      }, runtime([
        '75000000-0000-4000-8000-000000000014',
      ])),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const people = await sql.unsafe<{ id: number }[]>(`SELECT id FROM people WHERE email='pg-race@example.test'`);
    expect(people).toHaveLength(1);
    const rows = await sql.unsafe<{ version: number; linked_person_id: number | null; activities: number }[]>(`
      SELECT submission.version,submission.linked_person_id,
        (SELECT COUNT(*)::int FROM newcomer_activity WHERE submission_id=submission.id) AS activities
      FROM newcomer_submissions submission WHERE id LIKE '75000000-%' ORDER BY id
    `);
    expect(rows.map((row) => [row.version, row.linked_person_id === null, row.activities]).sort())
      .toEqual([[0, true, 0], [1, false, 1]].sort());
  });

  it('types phone-only visitor handoff and never revives or copies a soft-deleted identity', async () => {
    await sql.unsafe(`
      INSERT INTO newcomer_submissions
        (id,name,email,phone,locale,visit_date,source,status_id,version,created_at,updated_at) VALUES
        ('76000000-0000-4000-8000-000000000001','Phone Only',NULL,'+13125550141','en',
          '2026-08-10','staff',1,0,'2026-08-12 09:00:00','2026-08-12 09:00:00'),
        ('76000000-0000-4000-8000-000000000002','Deleted Identity','pg-deleted@example.test',
          '+13125550142','zh','2026-08-10','staff',1,0,'2026-08-12 09:00:00','2026-08-12 09:00:00');
      INSERT INTO newcomer_submissions
        (id,name,email,phone,locale,visit_date,source,status_id,linked_person_id,version,created_at,updated_at)
        VALUES ('76000000-0000-4000-8000-000000000003','Phone Linked',NULL,'+13125550143','en',
          '2026-08-10','staff',1,9903,0,'2026-08-12 09:00:00','2026-08-12 09:00:00');
      INSERT INTO people (id,display_name,email,active,deleted_at)
        VALUES (9910,'Deleted Identity','pg-deleted@example.test',1,'2026-08-01 10:00:00');
      INSERT INTO newcomer_notes (id,submission_id,author_person_id,body,created_at) VALUES
        ('76000000-0000-4000-8000-000000000010','76000000-0000-4000-8000-000000000002',9901,
          'Private newcomer note','2026-08-12 10:00:00');
    `);
    const peopleAdmin = { ...worker, id: 9904, email: 'pg-people-admin@example.test', role: 'admin' as const,
      isAdmin: true, adminAreas: ['newcomers', 'people'] as SessionUser['adminAreas'] };

    await expect(createNewcomerVisitor(db, peopleAdmin, { operationId: '76000000-0000-4000-8000-000000000011',
      submissionId: '76000000-0000-4000-8000-000000000001', expectedVersion: 0,
    }, runtime([
      '76000000-0000-4000-8000-000000000012',
    ]))).rejects.toBeInstanceOf(NewcomerEmailRequiredError);
    await expect(createNewcomerVisitor(db, peopleAdmin, { operationId: '76000000-0000-4000-8000-000000000015',
      submissionId: '76000000-0000-4000-8000-000000000001', expectedVersion: 1,
    }, runtime([
      '76000000-0000-4000-8000-000000000016',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    await expect(createNewcomerVisitor(db, peopleAdmin, { operationId: '76000000-0000-4000-8000-000000000017',
      submissionId: '76000000-0000-4000-8000-000000000003', expectedVersion: 0,
    }, runtime([
      '76000000-0000-4000-8000-000000000018',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    await expect(createNewcomerVisitor(db, peopleAdmin, { operationId: '76000000-0000-4000-8000-000000000013',
      submissionId: '76000000-0000-4000-8000-000000000002', expectedVersion: 0,
    }, runtime([
      '76000000-0000-4000-8000-000000000014',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);

    const submissions = await sql.unsafe<{
      version: number; last_mutation_id: string | null; linked_person_id: number | null;
    }[]>(`
      SELECT version,last_mutation_id,linked_person_id FROM newcomer_submissions
      WHERE id IN ('76000000-0000-4000-8000-000000000001','76000000-0000-4000-8000-000000000002')
      ORDER BY id
    `);
    expect(submissions).toEqual([
      { version: 0, last_mutation_id: null, linked_person_id: null },
      { version: 0, last_mutation_id: null, linked_person_id: null },
    ]);
    const [linkedPhone] = await sql.unsafe<{
      version: number; last_mutation_id: string | null; linked_person_id: number | null;
    }[]>(`SELECT version,last_mutation_id,linked_person_id FROM newcomer_submissions
      WHERE id='76000000-0000-4000-8000-000000000003'`);
    expect(linkedPhone).toEqual({ version: 0, last_mutation_id: null, linked_person_id: 9903 });
    const [deleted] = await sql.unsafe<{
      deleted_at: string; active: number; role: string; super_admin: number; admin_areas: string;
    }[]>(`SELECT deleted_at,active,role,super_admin,admin_areas FROM people WHERE id=9910`);
    expect(deleted).toEqual({
      deleted_at: '2026-08-01 10:00:00', active: 1, role: 'member', super_admin: 0, admin_areas: '',
    });
    const [copied] = await sql.unsafe<{ count: number }[]>(`SELECT COUNT(*)::int AS count FROM person_notes`);
    expect(copied.count).toBe(0);
    const [privateNote] = await sql.unsafe<{ body: string }[]>(`
      SELECT body FROM newcomer_notes WHERE id='76000000-0000-4000-8000-000000000010'
    `);
    expect(privateNote.body).toBe('Private newcomer note');
  });

  it('matches D1 proof semantics for text limits, status state, link no-op, and same-second visitors', async () => {
    await sql.unsafe(`
      INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed)
        VALUES (8,'short_text','text',1,1,8,0);
    `);
    await expect(createNewcomerSubmission(db, null, 'public', {
      name: 'PG Text Too Long', email: 'pg-text@example.test', phone: null, locale: 'en',
      visitDate: '2026-08-11', serviceTypeId: null, contactConsent: true,
      answers: [{ fieldId: 8, value: 'x'.repeat(501) }],
    }, {
      backend: 'supabase', operationId: '77000000-0000-4000-8000-000000000001',
    }, runtime([
      '77000000-0000-4000-8000-000000000002',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    const [textResidue] = await sql.unsafe<{ count: number }[]>(`
      SELECT COUNT(*)::int AS count FROM newcomer_submissions
      WHERE id='77000000-0000-4000-8000-000000000001'
    `);
    expect(textResidue.count).toBe(0);
    await sql.unsafe(`UPDATE newcomer_fields SET required=0 WHERE id=8`);

    await sql.unsafe(`UPDATE newcomer_submissions
      SET closed_at='2026-08-01 10:00:00' WHERE id='71000000-0000-4000-8000-000000000001'`);
    await expect(changeNewcomerStatus(db, worker, { operationId: '77000000-0000-4000-8000-000000000011',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, statusId: 4,
    }, runtime([
      '77000000-0000-4000-8000-000000000012',
    ], '2026-08-12 18:10:00'))).rejects.toBeInstanceOf(NewcomerConflictError);
    await sql.unsafe(`UPDATE newcomer_submissions SET closed_at=NULL
      WHERE id='71000000-0000-4000-8000-000000000001'`);
    await changeNewcomerStatus(db, worker, { operationId: '77000000-0000-4000-8000-000000000013',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, statusId: 4,
    }, runtime([
      '77000000-0000-4000-8000-000000000014',
    ], '2026-08-12 18:11:00'));
    await changeNewcomerStatus(db, worker, { operationId: '77000000-0000-4000-8000-000000000015',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 1, statusId: 5,
    }, runtime([
      '77000000-0000-4000-8000-000000000016',
    ], '2026-08-12 18:12:00'));
    const [closedStatus] = await sql.unsafe<{
      status_id: number; closed_at: string | null; last_mutation_id: string;
    }[]>(`
      SELECT status_id,closed_at,last_mutation_id FROM newcomer_submissions
      WHERE id='71000000-0000-4000-8000-000000000001'
    `);
    expect(closedStatus).toEqual({
      status_id: 5,
      closed_at: '2026-08-12 18:11:00',
      last_mutation_id: '77000000-0000-4000-8000-000000000015|2026-08-12 18:11:00',
    });
    await changeNewcomerStatus(db, worker, { operationId: '77000000-0000-4000-8000-000000000017',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 2, statusId: 1,
    }, runtime([
      '77000000-0000-4000-8000-000000000018',
    ], '2026-08-12 18:13:00'));
    const [openStatus] = await sql.unsafe<{ status_id: number; closed_at: string | null }[]>(`
      SELECT status_id,closed_at FROM newcomer_submissions
      WHERE id='71000000-0000-4000-8000-000000000001'`);
    expect(openStatus).toEqual({ status_id: 1, closed_at: null });

    await sql.unsafe(`UPDATE people SET phone='+1 (312) 555-0131' WHERE id=9903`);
    await linkNewcomerPerson(db, worker, { operationId: '77000000-0000-4000-8000-000000000019',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 3, personId: 9903,
    }, runtime([
      '77000000-0000-4000-8000-000000000020',
    ]));
    const [beforeLinkRetry] = await sql.unsafe<{ version: number; last_mutation_id: string }[]>(`
      SELECT version,last_mutation_id FROM newcomer_submissions
      WHERE id='71000000-0000-4000-8000-000000000001'
    `);
    await expect(linkNewcomerPerson(db, worker, { operationId: '77000000-0000-4000-8000-000000000021',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 4, personId: 9903,
    }, runtime([
      '77000000-0000-4000-8000-000000000022',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    const [afterLinkRetry] = await sql.unsafe<{ version: number; last_mutation_id: string }[]>(`
      SELECT version,last_mutation_id FROM newcomer_submissions
      WHERE id='71000000-0000-4000-8000-000000000001'
    `);
    expect(afterLinkRetry).toEqual(beforeLinkRetry);

    await sql.unsafe(`INSERT INTO newcomer_submissions
      (id,name,email,phone,locale,visit_date,source,status_id,version,created_at,updated_at) VALUES
      ('77000000-0000-4000-8000-000000000031','Same Second','pg-same-second@example.test',
        '+13125550155','en','2026-08-10','staff',1,0,'2026-08-12 09:00:00','2026-08-12 09:00:00')`);
    const peopleAdmin = { ...worker, id: 9904, email: 'pg-people-admin@example.test', role: 'admin' as const,
      isAdmin: true, adminAreas: ['newcomers', 'people'] as SessionUser['adminAreas'] };
    await createNewcomerVisitor(db, peopleAdmin, { operationId: '77000000-0000-4000-8000-000000000032',
      submissionId: '77000000-0000-4000-8000-000000000031', expectedVersion: 0,
    }, runtime([
      '77000000-0000-4000-8000-000000000033',
    ], '2026-08-12 18:20:00'));
    await expect(createNewcomerVisitor(db, peopleAdmin, { operationId: '77000000-0000-4000-8000-000000000034',
      submissionId: '77000000-0000-4000-8000-000000000031', expectedVersion: 1,
    }, runtime([
      '77000000-0000-4000-8000-000000000035',
    ], '2026-08-12 18:20:00'))).rejects.toBeInstanceOf(NewcomerConflictError);
    const [visitorProof] = await sql.unsafe<{ version: number; people: number; activity: number; markers: number }[]>(`
      SELECT submission.version,
        (SELECT COUNT(*)::int FROM people WHERE email='pg-same-second@example.test') AS people,
        (SELECT COUNT(*)::int FROM newcomer_activity WHERE submission_id=submission.id) AS activity,
        (SELECT COUNT(*)::int FROM people WHERE calendar_token IS NOT NULL) AS markers
      FROM newcomer_submissions submission
      WHERE submission.id='77000000-0000-4000-8000-000000000031'
    `);
    expect(visitorProof).toEqual({ version: 1, people: 1, activity: 1, markers: 0 });

    await sql.unsafe(`
      UPDATE people SET calendar_token='77000000-0000-4000-8000-000000000042' WHERE id=9903;
      INSERT INTO newcomer_submissions
        (id,name,email,locale,visit_date,source,status_id,version,created_at,updated_at)
      VALUES ('77000000-0000-4000-8000-000000000040','Marker Collision',
        'pg-marker-collision@example.test','en','2026-08-10','staff',1,0,
        '2026-08-12 09:00:00','2026-08-12 09:00:00');
    `);
    await expect(createNewcomerVisitor(db, peopleAdmin, { operationId: '77000000-0000-4000-8000-000000000041',
      submissionId: '77000000-0000-4000-8000-000000000040', expectedVersion: 0,
    }, runtime([
      '77000000-0000-4000-8000-000000000042',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    const [collisionProof] = await sql.unsafe<{
      version: number; last_mutation_id: string | null; linked_person_id: number | null; people: number;
    }[]>(`
      SELECT submission.version,submission.last_mutation_id,submission.linked_person_id,
        (SELECT COUNT(*)::int FROM people WHERE email='pg-marker-collision@example.test') AS people
      FROM newcomer_submissions submission
      WHERE submission.id='77000000-0000-4000-8000-000000000040'
    `);
    expect(collisionProof).toEqual({
      version: 0, last_mutation_id: null, linked_person_id: null, people: 0,
    });
  });

  it('binds closed timestamp preservation and visitor ids to final transaction proofs', async () => {
    await sql.unsafe(`UPDATE newcomer_submissions
      SET status_id=4,closed_at='2026-08-12 17:00:00'
      WHERE id='71000000-0000-4000-8000-000000000001'`);
    const tamperedStatus: AppDb = {
      prepare(sqlText: string) { return db.prepare(sqlText); },
      batch(statements: AppStatement[]) {
        const injected = statements.slice();
        injected[3] = db.prepare(`
          UPDATE newcomer_submissions
          SET status_id=5,closed_at='2026-08-12 17:59:59'
          WHERE id='71000000-0000-4000-8000-000000000001'
            AND substr(last_mutation_id,1,36)='77100000-0000-4000-8000-000000000011'
        `);
        return db.batch(injected);
      },
    };
    await expect(changeNewcomerStatus(tamperedStatus, worker, { operationId: '77100000-0000-4000-8000-000000000011',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, statusId: 5,
    }, runtime([
      '77100000-0000-4000-8000-000000000012',
    ], '2026-08-12 18:00:00'))).rejects.toBeInstanceOf(NewcomerConflictError);
    const [status] = await sql.unsafe<{
      status_id: number; closed_at: string; version: number; last_mutation_id: string | null; activity: number;
    }[]>(`
      SELECT submission.status_id,submission.closed_at,submission.version,submission.last_mutation_id,
        (SELECT COUNT(*)::int FROM newcomer_activity WHERE submission_id=submission.id) AS activity
      FROM newcomer_submissions submission
      WHERE id='71000000-0000-4000-8000-000000000001'
    `);
    expect(status).toEqual({
      status_id: 4, closed_at: '2026-08-12 17:00:00', version: 0, last_mutation_id: null, activity: 0,
    });

    await sql.unsafe(`UPDATE newcomer_submissions SET status_id=1,closed_at=NULL
      WHERE id='71000000-0000-4000-8000-000000000001'`);
    const tamperedVisitorResults: AppDb = {
      prepare(sqlText: string) { return db.prepare(sqlText); },
      async batch(statements: AppStatement[]) {
        const results = await db.batch(statements);
        results[1] = { ...results[1], results: [{ id: 9901 }] };
        return results as never;
      },
    };
    const peopleAdmin = { ...worker, id: 9904, email: 'pg-people-admin@example.test', role: 'admin' as const,
      isAdmin: true, adminAreas: ['newcomers', 'people'] as SessionUser['adminAreas'] };
    const visitor = await createNewcomerVisitor(tamperedVisitorResults, peopleAdmin, { operationId: '77100000-0000-4000-8000-000000000013',
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0,
    }, runtime([
      '77100000-0000-4000-8000-000000000014',
    ], '2026-08-12 18:01:00'));
    const [visitorState] = await sql.unsafe<{ linked_person_id: number; version: number }[]>(`
      SELECT linked_person_id,version FROM newcomer_submissions
      WHERE id='71000000-0000-4000-8000-000000000001'
    `);
    expect(visitor).toEqual({
      version: 1, personId: visitorState.linked_person_id,
      operationId: '77100000-0000-4000-8000-000000000013',
    });
    expect(visitor.personId).not.toBe(9901);
  });

  it('rolls the complete PostgreSQL snapshot back at every statement boundary for every mutation', async () => {
    const failingDb = (statementIndex: number): AppDb => ({
      prepare(sqlText: string) { return db.prepare(sqlText); },
      batch(statements: AppStatement[]) {
        const injected = statements.slice();
        injected[statementIndex] = db.prepare(`
          INSERT INTO newcomer_status_i18n (status_id,locale,label) VALUES (0,'en','forced failure')
        `);
        return db.batch(injected);
      },
    });
    const peopleAdmin = { ...worker, id: 9904, email: 'pg-people-admin@example.test', role: 'admin' as const,
      isAdmin: true, adminAreas: ['newcomers', 'people'] as SessionUser['adminAreas'] };
    await sql.unsafe(`INSERT INTO newcomer_fields
      (id,key,type,required,active,sort,fixed) VALUES (8,'fault_answer','text',1,1,8,0)`);
    const reset = async (needsSubmission: boolean) => {
      await sql.unsafe(`
        TRUNCATE newcomer_activity,newcomer_notes,newcomer_answers,newcomer_submissions RESTART IDENTITY CASCADE;
        DELETE FROM people WHERE id NOT IN (9901,9902,9903,9904);
        UPDATE people SET phone=CASE WHEN id=9903 THEN '+1 (312) 555-0131' ELSE phone END,
          active=1,deleted_at=NULL;
      `);
      if (needsSubmission) {
        await sql.unsafe(`INSERT INTO newcomer_submissions
          (id,name,email,phone,locale,visit_date,source,status_id,version,created_at,updated_at)
          VALUES ('71000000-0000-4000-8000-000000000001','PG Guest','pg-guest@example.test',
            '+13125550131','en','2026-08-10','staff',1,0,
            '2026-08-12 09:00:00','2026-08-12 09:00:00')`);
      }
    };
    const snapshot = async () => ({
      submissions: await sql.unsafe(`SELECT id,status_id,assignee_person_id,linked_person_id,
        next_follow_up_date,closed_at,version,last_mutation_id,updated_at
        FROM newcomer_submissions ORDER BY id`),
      answers: await sql.unsafe(`SELECT submission_id,field_id,value
        FROM newcomer_answers ORDER BY submission_id,field_id`),
      notes: await sql.unsafe(`SELECT id,submission_id,author_person_id,body,created_at
        FROM newcomer_notes ORDER BY id`),
      activity: await sql.unsafe(`SELECT id,submission_id,actor_person_id,kind,metadata_json,
        operation_id,result_version,created_at
        FROM newcomer_activity ORDER BY id`),
      people: await sql.unsafe(`SELECT id,email,calendar_token,active,deleted_at,admin_areas
        FROM people WHERE id>=9900 ORDER BY id`),
    });
    const cases: Array<{
      name: string; statements: number; needsSubmission: boolean; invoke: (attemptDb: AppDb) => Promise<unknown>;
    }> = [
      {
        name: 'create', statements: 7, needsSubmission: false,
        invoke: (attemptDb) => createNewcomerSubmission(attemptDb, null, 'public', {
          name: 'PG Fault Create', email: 'pg-fault@example.test', phone: null, locale: 'en',
          visitDate: '2026-08-11', serviceTypeId: null, contactConsent: true,
          answers: [{ fieldId: 8, value: 'Safe' }],
        }, {
          backend: 'supabase', operationId: '7d100000-0000-4000-8000-000000000001',
        }, runtime([
          '7d100000-0000-4000-8000-000000000002',
        ])),
      },
      {
        name: 'assignment', statements: 6, needsSubmission: true,
        invoke: (attemptDb) => assignNewcomer(attemptDb, worker, { operationId: '7d200000-0000-4000-8000-000000000001',
          submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0,
          assigneePersonId: 9902,
        }, runtime([
          '7d200000-0000-4000-8000-000000000002',
        ])),
      },
      {
        name: 'status', statements: 6, needsSubmission: true,
        invoke: (attemptDb) => changeNewcomerStatus(attemptDb, worker, { operationId: '7d300000-0000-4000-8000-000000000001',
          submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, statusId: 4,
        }, runtime([
          '7d300000-0000-4000-8000-000000000002',
        ])),
      },
      {
        name: 'follow-up', statements: 5, needsSubmission: true,
        invoke: (attemptDb) => scheduleNewcomerFollowUp(attemptDb, worker, { operationId: '7d400000-0000-4000-8000-000000000001',
          submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0,
          followUpDate: '2026-08-30',
        }, runtime([
          '7d400000-0000-4000-8000-000000000002',
        ])),
      },
      {
        name: 'note', statements: 5, needsSubmission: true,
        invoke: (attemptDb) => addNewcomerNote(attemptDb, worker, { operationId: '7d500000-0000-4000-8000-000000000001',
          submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0,
          body: 'PG must roll back',
        }, runtime([
          '7d500000-0000-4000-8000-000000000002',
          '7d500000-0000-4000-8000-000000000003',
        ])),
      },
      {
        name: 'link', statements: 6, needsSubmission: true,
        invoke: (attemptDb) => linkNewcomerPerson(attemptDb, worker, { operationId: '7d600000-0000-4000-8000-000000000001',
          submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, personId: 9903,
        }, runtime([
          '7d600000-0000-4000-8000-000000000002',
        ])),
      },
      {
        name: 'visitor', statements: 8, needsSubmission: true,
        invoke: (attemptDb) => createNewcomerVisitor(attemptDb, peopleAdmin, { operationId: '7d700000-0000-4000-8000-000000000001',
          submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0,
        }, runtime([
          '7d700000-0000-4000-8000-000000000002',
        ])),
      },
    ];
    for (const candidate of cases) {
      for (let index = 0; index < candidate.statements; index += 1) {
        await reset(candidate.needsSubmission);
        const before = await snapshot();
        const error = await candidate.invoke(failingDb(index)).catch((caught: unknown) => caught);
        expect(error, `${candidate.name} statement ${index}`).toBeInstanceOf(NewcomerConflictError);
        expect((error as Error).message).not.toContain('pg-guest@example.test');
        expect(await snapshot(), `${candidate.name} statement ${index}`).toEqual(before);
      }
    }
  });
});
