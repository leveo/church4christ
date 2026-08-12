import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import {
  NewcomerConflictError,
  NewcomerEmailRequiredError,
  addNewcomerNote,
  assignNewcomer,
  changeNewcomerStatus,
  createNewcomerSubmission,
  createNewcomerVisitor,
  linkNewcomerPerson,
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

  afterAll(async () => { await sql?.end(); });

  it('uses the same segment-safe scoped assignee grant and canonical CAS activity', async () => {
    await expect(assignNewcomer(
      db,
      worker,
      {
        submissionId: '71000000-0000-4000-8000-000000000001',
        expectedVersion: 0,
        assigneePersonId: 9902,
      },
      runtime([
        '71000000-0000-4000-8000-000000000011',
        '71000000-0000-4000-8000-000000000012',
      ]),
    )).resolves.toEqual({ version: 1 });
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
      runtime([
        '72000000-0000-4000-8000-000000000001',
        '72000000-0000-4000-8000-000000000002',
      ]),
    )).resolves.toEqual({ id: '72000000-0000-4000-8000-000000000001', version: 0 });
    const [created] = await sql.unsafe<{ contact_consent_at: string | null; actor_person_id: number; metadata_json: string }[]>(`
      SELECT submission.contact_consent_at,activity.actor_person_id,activity.metadata_json
      FROM newcomer_submissions submission JOIN newcomer_activity activity ON activity.submission_id=submission.id
      WHERE submission.id='72000000-0000-4000-8000-000000000001'
    `);
    expect(created).toEqual({ contact_consent_at: null, actor_person_id: 9901, metadata_json: '{}' });

    await changeNewcomerStatus(db, worker, {
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, statusId: 4,
    }, runtime([
      '72000000-0000-4000-8000-000000000011',
      '72000000-0000-4000-8000-000000000012',
    ], '2026-08-12 18:01:00'));
    await scheduleNewcomerFollowUp(db, worker, {
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 1, followUpDate: '2026-08-25',
    }, runtime([
      '72000000-0000-4000-8000-000000000013',
      '72000000-0000-4000-8000-000000000014',
    ], '2026-08-12 18:02:00'));
    await addNewcomerNote(db, worker, {
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 2, body: 'PG note',
    }, runtime([
      '72000000-0000-4000-8000-000000000015',
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
      { kind: 'note_added', metadata_json: '{"note_id":"72000000-0000-4000-8000-000000000016"}' },
    ]);
  });

  it('serializes two transactions claiming the same expected version so the loser has no residue', async () => {
    const attempts = await Promise.allSettled([
      assignNewcomer(db, worker, {
        submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, assigneePersonId: 9902,
      }, runtime([
        '73000000-0000-4000-8000-000000000011',
        '73000000-0000-4000-8000-000000000012',
      ])),
      assignNewcomer(db, worker, {
        submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, assigneePersonId: 9903,
      }, runtime([
        '73000000-0000-4000-8000-000000000013',
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
    const linkAttempt = linkNewcomerPerson(db, worker, {
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, personId: 9903,
    }, runtime([
      '74000000-0000-4000-8000-000000000011',
      '74000000-0000-4000-8000-000000000012',
    ]));
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    const assignmentAttempt = assignNewcomer(db, worker, {
      submissionId: '71000000-0000-4000-8000-000000000001', expectedVersion: 0, assigneePersonId: 9902,
    }, runtime([
      '74100000-0000-4000-8000-000000000011',
      '74100000-0000-4000-8000-000000000012',
    ]));
    await new Promise((resolve) => setTimeout(resolve, 20));
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
      createNewcomerVisitor(db, peopleAdmin, {
        submissionId: '75000000-0000-4000-8000-000000000001', expectedVersion: 0,
      }, runtime([
        '75000000-0000-4000-8000-000000000011',
        '75000000-0000-4000-8000-000000000012',
      ])),
      createNewcomerVisitor(db, peopleAdmin, {
        submissionId: '75000000-0000-4000-8000-000000000002', expectedVersion: 0,
      }, runtime([
        '75000000-0000-4000-8000-000000000013',
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
      INSERT INTO people (id,display_name,email,active,deleted_at)
        VALUES (9910,'Deleted Identity','pg-deleted@example.test',1,'2026-08-01 10:00:00');
      INSERT INTO newcomer_notes (id,submission_id,author_person_id,body,created_at) VALUES
        ('76000000-0000-4000-8000-000000000010','76000000-0000-4000-8000-000000000002',9901,
          'Private newcomer note','2026-08-12 10:00:00');
    `);
    const peopleAdmin = { ...worker, id: 9904, email: 'pg-people-admin@example.test', role: 'admin' as const,
      isAdmin: true, adminAreas: ['newcomers', 'people'] as SessionUser['adminAreas'] };

    await expect(createNewcomerVisitor(db, peopleAdmin, {
      submissionId: '76000000-0000-4000-8000-000000000001', expectedVersion: 0,
    }, runtime([
      '76000000-0000-4000-8000-000000000011',
      '76000000-0000-4000-8000-000000000012',
    ]))).rejects.toBeInstanceOf(NewcomerEmailRequiredError);
    await expect(createNewcomerVisitor(db, peopleAdmin, {
      submissionId: '76000000-0000-4000-8000-000000000002', expectedVersion: 0,
    }, runtime([
      '76000000-0000-4000-8000-000000000013',
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
});
