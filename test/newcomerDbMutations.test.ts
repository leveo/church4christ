import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb, AppStatement } from '../src/lib/appDb';
import {
  NewcomerConflictError,
  NewcomerEmailRequiredError,
  NewcomerForbiddenError,
  NewcomerInvalidError,
  NewcomerPersistenceError,
  addNewcomerNote,
  assignNewcomer,
  changeNewcomerStatus,
  createNewcomerSubmission,
  createNewcomerVisitor,
  linkNewcomerPerson,
  scheduleNewcomerFollowUp,
} from '../src/lib/newcomerDb';
import type { SessionUser } from '../src/lib/types';

const scopedUser = (overrides: Partial<SessionUser> = {}): SessionUser => ({
  id: 9801,
  email: 'newcomer-worker@example.test',
  displayName: 'Newcomer Worker',
  role: 'member',
  isAdmin: false,
  isEditor: false,
  finance: 0,
  memberTeamIds: [],
  leaderTeamIds: [],
  lang: 'en',
  isSuperAdmin: false,
  adminAreas: ['newcomers'],
  ...overrides,
});

function runtime(ids: string[], now = '2026-08-12 12:34:56') {
  let index = 0;
  return {
    now: () => now,
    randomUUID: () => ids[index++],
  };
}

const intake = (overrides: Record<string, unknown> = {}) => ({
  name: '  not accepted  ',
  email: 'guest@example.test',
  phone: '+13125550123',
  locale: 'en',
  visitDate: '2026-08-10',
  serviceTypeId: null,
  contactConsent: true,
  answers: [],
  ...overrides,
});

const submissionId = '62000000-0000-4000-8000-000000000001';

async function seedSubmission(overrides = '') {
  await env.DB.prepare(`INSERT INTO newcomer_submissions
    (id,name,email,phone,locale,visit_date,source,status_id,version,created_at,updated_at ${overrides ? `,${overrides.split('=')[0]}` : ''})
    VALUES (?,'Mutation Guest','mutation@example.test','+13125550124','en','2026-08-10','staff',1,0,
      '2026-08-12 09:00:00','2026-08-12 09:00:00' ${overrides ? `,${overrides.split('=')[1]}` : ''})`)
    .bind(submissionId).run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM newcomer_activity'),
    env.DB.prepare('DELETE FROM newcomer_notes'),
    env.DB.prepare('DELETE FROM newcomer_answers'),
    env.DB.prepare('DELETE FROM newcomer_submissions'),
    env.DB.prepare('DELETE FROM newcomer_field_option_i18n WHERE field_id>7'),
    env.DB.prepare('DELETE FROM newcomer_field_options WHERE field_id>7'),
    env.DB.prepare('DELETE FROM newcomer_field_i18n WHERE field_id>7'),
    env.DB.prepare('DELETE FROM newcomer_fields WHERE id>7'),
    env.DB.prepare('DELETE FROM service_type_i18n WHERE service_type_id>=9800'),
    env.DB.prepare('DELETE FROM service_types WHERE id>=9800'),
    env.DB.prepare('DELETE FROM people WHERE id>=9800'),
  ]);
  await env.DB.prepare(`INSERT INTO people
    (id,display_name,email,role,active,super_admin,admin_areas)
    VALUES (9801,'Newcomer Worker','newcomer-worker@example.test','member',1,0,'newcomers')`).run();
  await env.DB.prepare(`INSERT INTO people
    (id,display_name,email,role,active,super_admin,admin_areas) VALUES
    (9802,'Assignable Worker','assignable@example.test','editor',1,0,'newcomers'),
    (9803,'Ungrant Admin','ungrant@example.test','admin',1,0,''),
    (9804,'Inactive Worker','inactive@example.test','member',0,0,'newcomers'),
    (9805,'Phone Match','phone-match@example.test','member',1,0,''),
    (9806,'People Admin','people-admin@example.test','admin',1,0,'newcomers,people')`).run();
  await env.DB.prepare(`UPDATE people SET phone='+1 (312) 555-0125' WHERE id=9805`).run();
});

describe('newcomer CAS workflow mutations', () => {
  it('checks every private authority before prepare and makes the CAS claim the first SQL statement', async () => {
    const inputs = {
      assign: { submissionId, expectedVersion: 0, assigneePersonId: 9802 },
      status: { submissionId, expectedVersion: 0, statusId: 2 },
      follow: { submissionId, expectedVersion: 0, followUpDate: '2026-08-20' },
      note: { submissionId, expectedVersion: 0, body: 'Safe note' },
      link: { submissionId, expectedVersion: 0, personId: 9805 },
      visitor: { submissionId, expectedVersion: 0 },
    };
    const validRuntime = () => runtime([
      '60000000-0000-4000-8000-000000000011',
      '60000000-0000-4000-8000-000000000012',
      '60000000-0000-4000-8000-000000000013',
    ]);
    const privateCalls = [
      (db: AppDb, actor: SessionUser) => assignNewcomer(db, actor, inputs.assign, validRuntime()),
      (db: AppDb, actor: SessionUser) => changeNewcomerStatus(db, actor, inputs.status, validRuntime()),
      (db: AppDb, actor: SessionUser) => scheduleNewcomerFollowUp(db, actor, inputs.follow, validRuntime()),
      (db: AppDb, actor: SessionUser) => addNewcomerNote(db, actor, inputs.note, validRuntime()),
      (db: AppDb, actor: SessionUser) => linkNewcomerPerson(db, actor, inputs.link, validRuntime()),
    ];
    for (const call of privateCalls) {
      let prepares = 0;
      const untouched = {
        prepare() { prepares += 1; throw new Error('must not prepare'); },
        batch() { throw new Error('must not batch'); },
      } as AppDb;
      await expect(call(untouched, scopedUser({ adminAreas: [] })))
        .rejects.toBeInstanceOf(NewcomerForbiddenError);
      expect(prepares).toBe(0);
    }

    const peopleAdmin = scopedUser({
      id: 9806, role: 'admin', isAdmin: true, adminAreas: ['newcomers', 'people'],
    });
    const calls = [
      ...privateCalls.map((call) => (db: AppDb) => call(db, scopedUser())),
      (db: AppDb) => createNewcomerVisitor(db, peopleAdmin, inputs.visitor, validRuntime()),
    ];
    for (const call of calls) {
      const sql: string[] = [];
      const statement: AppStatement = {
        bind() { return this; }, first: async () => null,
        all: async () => ({ results: [], meta: { changes: 0 } }),
        run: async () => ({ results: [], meta: { changes: 0 } }),
      };
      const recording = {
        prepare(text: string) { sql.push(text); return statement; },
        async batch() { throw new Error('stop before persistence'); },
      } as AppDb;
      await expect(call(recording)).rejects.toBeInstanceOf(NewcomerPersistenceError);
      expect(sql[0]).toMatch(/^\s*UPDATE newcomer_submissions\s+SET version=version\+1,last_mutation_id=/);
    }
  });

  it('rejects client-owned fields and hostile runtime accessors without preparing SQL', async () => {
    let prepares = 0;
    let getterReads = 0;
    const untouched = {
      prepare() { prepares += 1; throw new Error('must not prepare'); },
      batch() { throw new Error('must not batch'); },
    } as AppDb;
    await expect(assignNewcomer(untouched, scopedUser(), {
      submissionId, expectedVersion: 0, assigneePersonId: 9802, actor: 9803,
    } as never)).rejects.toBeInstanceOf(NewcomerInvalidError);
    const hostileRuntime = { randomUUID: () => '60000000-0000-4000-8000-000000000001' } as Record<string, unknown>;
    Object.defineProperty(hostileRuntime, 'now', {
      enumerable: true,
      get() { getterReads += 1; return () => '2026-08-12 12:00:00'; },
    });
    await expect(changeNewcomerStatus(untouched, scopedUser(), {
      submissionId, expectedVersion: 0, statusId: 2,
    }, hostileRuntime as never)).rejects.toBeInstanceOf(NewcomerPersistenceError);
    await expect(addNewcomerNote(untouched, scopedUser(), {
      submissionId, expectedVersion: 0, body: 'private\u0001control',
    }, runtime([
      '60000000-0000-4000-8000-000000000021',
      '60000000-0000-4000-8000-000000000022',
      '60000000-0000-4000-8000-000000000023',
    ]))).rejects.toBeInstanceOf(NewcomerInvalidError);
    expect({ prepares, getterReads }).toEqual({ prepares: 0, getterReads: 0 });
  });

  it('captures the trusted runtime exactly once and requires distinct strict server UUIDs', async () => {
    await seedSubmission();
    let nowCalls = 0;
    let uuidCalls = 0;
    const ids = [
      '60100000-0000-4000-8000-000000000001',
      '60100000-0000-4000-8000-000000000002',
      '60100000-0000-4000-8000-000000000003',
    ];
    await addNewcomerNote(env.DB, scopedUser(), {
      submissionId, expectedVersion: 0, body: 'Runtime capture',
    }, {
      now() { nowCalls += 1; return '2026-08-12 12:00:00'; },
      randomUUID() { uuidCalls += 1; return ids[uuidCalls - 1]; },
    });
    expect({ nowCalls, uuidCalls }).toEqual({ nowCalls: 1, uuidCalls: 3 });

    let prepares = 0;
    const untouched = {
      prepare() { prepares += 1; throw new Error('must not prepare'); },
      batch() { throw new Error('must not batch'); },
    } as AppDb;
    await expect(assignNewcomer(untouched, scopedUser(), {
      submissionId, expectedVersion: 1, assigneePersonId: 9802,
    }, runtime([
      '60100000-0000-4000-8000-000000000011',
      '60100000-0000-4000-8000-000000000011',
    ]))).rejects.toBeInstanceOf(NewcomerPersistenceError);
    expect(prepares).toBe(0);
  });

  it('maps every mutation prepare failure and hostile result getter to one PII-free failed error', async () => {
    const failedPrepare = {
      prepare() { throw new Error('SQL leaked mutation@example.test and private note'); },
      batch() { throw new Error('must not batch'); },
    } as AppDb;
    const ids = [
      '60200000-0000-4000-8000-000000000001',
      '60200000-0000-4000-8000-000000000002',
      '60200000-0000-4000-8000-000000000003',
    ];
    const peopleAdmin = scopedUser({
      id: 9806, role: 'admin', isAdmin: true, adminAreas: ['newcomers', 'people'],
    });
    const calls = [
      () => assignNewcomer(failedPrepare, scopedUser(), {
        submissionId, expectedVersion: 0, assigneePersonId: 9802,
      }, runtime(ids)),
      () => changeNewcomerStatus(failedPrepare, scopedUser(), {
        submissionId, expectedVersion: 0, statusId: 4,
      }, runtime(ids)),
      () => scheduleNewcomerFollowUp(failedPrepare, scopedUser(), {
        submissionId, expectedVersion: 0, followUpDate: '2026-08-30',
      }, runtime(ids)),
      () => addNewcomerNote(failedPrepare, scopedUser(), {
        submissionId, expectedVersion: 0, body: 'Private note',
      }, runtime(ids)),
      () => linkNewcomerPerson(failedPrepare, scopedUser(), {
        submissionId, expectedVersion: 0, personId: 9805,
      }, runtime(ids)),
      () => createNewcomerVisitor(failedPrepare, peopleAdmin, {
        submissionId, expectedVersion: 0,
      }, runtime(ids)),
    ];
    for (const call of calls) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NewcomerPersistenceError);
      expect((error as Error).message).toBe('Newcomer persistence failed');
    }

    let getterReads = 0;
    const statement: AppStatement = {
      bind() { return this; }, first: async () => null,
      all: async () => ({ results: [], meta: { changes: 0 } }),
      run: async () => ({ results: [], meta: { changes: 0 } }),
    };
    const hostileResults: AppDb = {
      prepare() { return statement; },
      async batch(statements) {
        return statements.map(() => {
          const result = { meta: { changes: 0 } } as Record<string, unknown>;
          Object.defineProperty(result, 'results', {
            enumerable: true,
            get() { getterReads += 1; throw new Error('private result'); },
          });
          return result;
        }) as never;
      },
    };
    const error = await assignNewcomer(hostileResults, scopedUser(), {
      submissionId, expectedVersion: 0, assigneePersonId: 9802,
    }, runtime(ids)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NewcomerPersistenceError);
    expect(getterReads).toBe(0);
  });

  it('assigns only a fresh active Newcomers worker and writes canonical server-actor activity', async () => {
    await seedSubmission();
    const result = await assignNewcomer(
      env.DB,
      scopedUser(),
      { submissionId, expectedVersion: 0, assigneePersonId: 9802 },
      runtime([
        '62000000-0000-4000-8000-000000000011',
        '62000000-0000-4000-8000-000000000012',
      ], '2026-08-12 13:00:00'),
    );
    expect(result).toEqual({ version: 1 });
    expect(await env.DB.prepare(`SELECT assignee_person_id,version,last_mutation_id,updated_at
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first()).toEqual({
      assignee_person_id: 9802, version: 1,
      last_mutation_id: '62000000-0000-4000-8000-000000000011',
      updated_at: '2026-08-12 13:00:00',
    });
    expect(await env.DB.prepare(`SELECT actor_person_id,kind,metadata_json,created_at
      FROM newcomer_activity WHERE submission_id=?`).bind(submissionId).first()).toEqual({
      actor_person_id: 9801, kind: 'assigned',
      metadata_json: '{"to_assignee_person_id":9802}', created_at: '2026-08-12 13:00:00',
    });

    const before = await env.DB.prepare(`SELECT assignee_person_id,version,last_mutation_id,updated_at
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first();
    await expect(assignNewcomer(
      env.DB,
      scopedUser(),
      { submissionId, expectedVersion: 1, assigneePersonId: 9802 },
      runtime([
        '62000000-0000-4000-8000-000000000013',
        '62000000-0000-4000-8000-000000000014',
      ]),
    )).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare(`SELECT assignee_person_id,version,last_mutation_id,updated_at
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first()).toEqual(before);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_activity').first<number>('n')).toBe(1);

    for (const personId of [9803, 9804]) {
      await expect(assignNewcomer(
        env.DB,
        scopedUser(),
        { submissionId, expectedVersion: 1, assigneePersonId: personId },
        runtime([
          `62000000-0000-4000-8000-0000000000${personId === 9803 ? '15' : '17'}`,
          `62000000-0000-4000-8000-0000000000${personId === 9803 ? '16' : '18'}`,
        ]),
      )).rejects.toBeInstanceOf(NewcomerConflictError);
    }
  });

  it('unassigns canonically and rejects substring-like persisted grant tokens', async () => {
    await seedSubmission();
    await assignNewcomer(env.DB, scopedUser(), {
      submissionId, expectedVersion: 0, assigneePersonId: 9802,
    }, runtime([
      '6b000000-0000-4000-8000-000000000011',
      '6b000000-0000-4000-8000-000000000012',
    ]));
    await assignNewcomer(env.DB, scopedUser(), {
      submissionId, expectedVersion: 1, assigneePersonId: null,
    }, runtime([
      '6b000000-0000-4000-8000-000000000013',
      '6b000000-0000-4000-8000-000000000014',
    ]));
    expect((await env.DB.prepare(`SELECT metadata_json FROM newcomer_activity
      WHERE submission_id=? ORDER BY created_at,id`).bind(submissionId).all()).results).toEqual([
      { metadata_json: '{"to_assignee_person_id":9802}' },
      { metadata_json: '{"from_assignee_person_id":9802}' },
    ]);
    await env.DB.prepare(`INSERT INTO people
      (id,display_name,email,role,active,admin_areas) VALUES
      (9811,'Token Lookalike','token-lookalike@example.test','admin',1,'notnewcomers,newcomers2')`).run();
    await expect(assignNewcomer(env.DB, scopedUser(), {
      submissionId, expectedVersion: 2, assigneePersonId: 9811,
    }, runtime([
      '6b000000-0000-4000-8000-000000000015',
      '6b000000-0000-4000-8000-000000000016',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare('SELECT version,assignee_person_id FROM newcomer_submissions WHERE id=?')
      .bind(submissionId).first()).toEqual({ version: 2, assignee_person_id: null });
  });

  it('changes status with server-derived category and preserves the first closed timestamp', async () => {
    await seedSubmission();
    await changeNewcomerStatus(
      env.DB,
      scopedUser(),
      { submissionId, expectedVersion: 0, statusId: 4 },
      runtime([
        '63000000-0000-4000-8000-000000000011',
        '63000000-0000-4000-8000-000000000012',
      ], '2026-08-12 14:00:00'),
    );
    expect(await env.DB.prepare(`SELECT status_id,closed_at,version FROM newcomer_submissions WHERE id=?`)
      .bind(submissionId).first()).toEqual({ status_id: 4, closed_at: '2026-08-12 14:00:00', version: 1 });
    expect(await env.DB.prepare('SELECT metadata_json FROM newcomer_activity').first<string>('metadata_json'))
      .toBe('{"from_status_id":1,"to_status_id":4}');

    await changeNewcomerStatus(
      env.DB,
      scopedUser(),
      { submissionId, expectedVersion: 1, statusId: 5 },
      runtime([
        '63000000-0000-4000-8000-000000000013',
        '63000000-0000-4000-8000-000000000014',
      ], '2026-08-12 15:00:00'),
    );
    expect(await env.DB.prepare(`SELECT status_id,closed_at,version FROM newcomer_submissions WHERE id=?`)
      .bind(submissionId).first()).toEqual({ status_id: 5, closed_at: '2026-08-12 14:00:00', version: 2 });

    await changeNewcomerStatus(
      env.DB,
      scopedUser(),
      { submissionId, expectedVersion: 2, statusId: 1 },
      runtime([
        '63000000-0000-4000-8000-000000000015',
        '63000000-0000-4000-8000-000000000016',
      ], '2026-08-12 16:00:00'),
    );
    expect(await env.DB.prepare(`SELECT status_id,closed_at,version FROM newcomer_submissions WHERE id=?`)
      .bind(submissionId).first()).toEqual({ status_id: 1, closed_at: null, version: 3 });
  });

  it('rejects an open-to-closed transition when the old open state has a tampered closed timestamp', async () => {
    await seedSubmission();
    await env.DB.prepare(`UPDATE newcomer_submissions SET closed_at='2026-08-01 10:00:00' WHERE id=?`)
      .bind(submissionId).run();
    const before = await env.DB.prepare(`SELECT status_id,closed_at,version,last_mutation_id
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first();

    await expect(changeNewcomerStatus(env.DB, scopedUser(), {
      submissionId, expectedVersion: 0, statusId: 4,
    }, runtime([
      '63100000-0000-4000-8000-000000000011',
      '63100000-0000-4000-8000-000000000012',
    ], '2026-08-12 14:00:00'))).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare(`SELECT status_id,closed_at,version,last_mutation_id
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first()).toEqual(before);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_activity')
      .first<number>('n')).toBe(0);
  });

  it('sets and clears a follow-up date with exact canonical metadata', async () => {
    await seedSubmission();
    await scheduleNewcomerFollowUp(
      env.DB,
      scopedUser(),
      { submissionId, expectedVersion: 0, followUpDate: '2026-08-20' },
      runtime([
        '64000000-0000-4000-8000-000000000011',
        '64000000-0000-4000-8000-000000000012',
      ]),
    );
    await scheduleNewcomerFollowUp(
      env.DB,
      scopedUser(),
      { submissionId, expectedVersion: 1, followUpDate: null },
      runtime([
        '64000000-0000-4000-8000-000000000013',
        '64000000-0000-4000-8000-000000000014',
      ]),
    );
    expect(await env.DB.prepare(`SELECT next_follow_up_date,version FROM newcomer_submissions WHERE id=?`)
      .bind(submissionId).first()).toEqual({ next_follow_up_date: null, version: 2 });
    expect((await env.DB.prepare(`SELECT metadata_json FROM newcomer_activity
      ORDER BY created_at,id`).all()).results).toEqual([
      { metadata_json: '{"follow_up_date":"2026-08-20"}' },
      { metadata_json: '{}' },
    ]);
  });

  it('adds a normalized private note and exact note activity in the claimed transaction', async () => {
    await seedSubmission();
    const result = await addNewcomerNote(
      env.DB,
      scopedUser(),
      { submissionId, expectedVersion: 0, body: '  Cafe\u0301 follow-up\nSecond line  ' },
      runtime([
        '65000000-0000-4000-8000-000000000011',
        '65000000-0000-4000-8000-000000000012',
        '65000000-0000-4000-8000-000000000013',
      ], '2026-08-12 16:00:00'),
    );
    expect(result).toEqual({ version: 1, noteId: '65000000-0000-4000-8000-000000000012' });
    expect(await env.DB.prepare('SELECT id,submission_id,author_person_id,body,created_at FROM newcomer_notes').first())
      .toEqual({
        id: result.noteId, submission_id: submissionId, author_person_id: 9801,
        body: 'Café follow-up\nSecond line', created_at: '2026-08-12 16:00:00',
      });
    expect(await env.DB.prepare('SELECT actor_person_id,kind,metadata_json FROM newcomer_activity').first())
      .toEqual({
        actor_person_id: 9801, kind: 'note_added',
        metadata_json: '{"note_id":"65000000-0000-4000-8000-000000000012"}',
      });
  });

  it('links only a freshly locked live exact normalized contact match', async () => {
    await seedSubmission();
    await env.DB.prepare('UPDATE newcomer_submissions SET email=NULL,phone=? WHERE id=?')
      .bind('+13125550125', submissionId).run();
    await linkNewcomerPerson(
      env.DB,
      scopedUser(),
      { submissionId, expectedVersion: 0, personId: 9805 },
      runtime([
        '66000000-0000-4000-8000-000000000011',
        '66000000-0000-4000-8000-000000000012',
      ]),
    );
    expect(await env.DB.prepare('SELECT linked_person_id,version FROM newcomer_submissions WHERE id=?')
      .bind(submissionId).first()).toEqual({ linked_person_id: 9805, version: 1 });
    expect(await env.DB.prepare('SELECT kind,metadata_json FROM newcomer_activity').first())
      .toEqual({ kind: 'person_linked', metadata_json: '{"person_id":9805}' });

    await env.DB.prepare(`INSERT INTO people (id,display_name,email) VALUES
      (9807,'No Match','no-match@example.test')`).run();
    const before = await env.DB.prepare('SELECT linked_person_id,version,last_mutation_id FROM newcomer_submissions WHERE id=?')
      .bind(submissionId).first();
    await expect(linkNewcomerPerson(
      env.DB,
      scopedUser(),
      { submissionId, expectedVersion: 1, personId: 9807 },
      runtime([
        '66000000-0000-4000-8000-000000000013',
        '66000000-0000-4000-8000-000000000014',
      ]),
    )).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare('SELECT linked_person_id,version,last_mutation_id FROM newcomer_submissions WHERE id=?')
      .bind(submissionId).first()).toEqual(before);
  });

  it('rolls back a same-target person link as an unaudited no-op', async () => {
    await seedSubmission();
    await env.DB.prepare('UPDATE newcomer_submissions SET email=NULL,phone=? WHERE id=?')
      .bind('+13125550125', submissionId).run();
    await linkNewcomerPerson(env.DB, scopedUser(), {
      submissionId, expectedVersion: 0, personId: 9805,
    }, runtime([
      '66100000-0000-4000-8000-000000000011',
      '66100000-0000-4000-8000-000000000012',
    ]));
    const before = await env.DB.prepare(`SELECT version,last_mutation_id,linked_person_id
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first();

    await expect(linkNewcomerPerson(env.DB, scopedUser(), {
      submissionId, expectedVersion: 1, personId: 9805,
    }, runtime([
      '66100000-0000-4000-8000-000000000013',
      '66100000-0000-4000-8000-000000000014',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);

    expect(await env.DB.prepare(`SELECT version,last_mutation_id,linked_person_id
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first()).toEqual(before);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_activity
      WHERE submission_id=?`).bind(submissionId).first<number>('n')).toBe(1);
  });

  it('creates an unprivileged visitor only with People authority and a current email', async () => {
    await seedSubmission();
    const peopleAdmin = scopedUser({
      id: 9806, email: 'people-admin@example.test', displayName: 'People Admin',
      role: 'admin', isAdmin: true, adminAreas: ['newcomers', 'people'],
    });
    await expect(createNewcomerVisitor(
      { prepare() { throw new Error('must not prepare'); }, batch() { throw new Error('must not batch'); } } as AppDb,
      scopedUser(),
      { submissionId, expectedVersion: 0 },
    )).rejects.toBeInstanceOf(NewcomerForbiddenError);

    const result = await createNewcomerVisitor(
      env.DB,
      peopleAdmin,
      { submissionId, expectedVersion: 0 },
      runtime([
        '67000000-0000-4000-8000-000000000011',
        '67000000-0000-4000-8000-000000000012',
      ], '2026-08-12 17:00:00'),
    );
    expect(result.version).toBe(1);
    expect(await env.DB.prepare(`SELECT first_name,last_name,display_name,email,phone,avatar_url,role,active,
      session_epoch,calendar_token,lang,deleted_at,birthday,address,membership_status,joined_on,
      finance,stripe_customer_id,super_admin,admin_areas,pending_email,created_at,updated_at
      FROM people WHERE id=?`).bind(result.personId).first()).toEqual({
      first_name: '', last_name: '', display_name: 'Mutation Guest', email: 'mutation@example.test',
      phone: '+13125550124', avatar_url: null, role: 'member', active: 1, session_epoch: 0,
      calendar_token: null, lang: 'en', deleted_at: null, birthday: null, address: null,
      membership_status: 'visitor', joined_on: null, finance: 0, stripe_customer_id: null,
      super_admin: 0, admin_areas: '', pending_email: null,
      created_at: '2026-08-12 17:00:00', updated_at: '2026-08-12 17:00:00',
    });
    expect(await env.DB.prepare('SELECT linked_person_id,version FROM newcomer_submissions WHERE id=?')
      .bind(submissionId).first()).toEqual({ linked_person_id: result.personId, version: 1 });
    expect(await env.DB.prepare('SELECT actor_person_id,kind,metadata_json FROM newcomer_activity').first())
      .toEqual({
        actor_person_id: 9806, kind: 'visitor_created', metadata_json: `{"person_id":${result.personId}}`,
      });

    await env.DB.prepare(`INSERT INTO newcomer_submissions
      (id,name,phone,locale,visit_date,source,status_id,version,created_at,updated_at)
      VALUES ('67000000-0000-4000-8000-000000000021','Phone only','+13125550126','en','2026-08-10',
        'staff',1,0,'2026-08-12 09:00:00','2026-08-12 09:00:00')`).run();
    await expect(createNewcomerVisitor(
      env.DB,
      peopleAdmin,
      { submissionId: '67000000-0000-4000-8000-000000000021', expectedVersion: 0 },
      runtime([
        '67000000-0000-4000-8000-000000000022',
        '67000000-0000-4000-8000-000000000023',
      ]),
    )).rejects.toBeInstanceOf(NewcomerEmailRequiredError);
    expect(await env.DB.prepare(`SELECT version,last_mutation_id FROM newcomer_submissions
      WHERE id='67000000-0000-4000-8000-000000000021'`).first())
      .toEqual({ version: 0, last_mutation_id: null });
  });

  it('rolls back a same-second visitor retry without a second person, activity, or version claim', async () => {
    await seedSubmission();
    const peopleAdmin = scopedUser({
      id: 9806, role: 'admin', isAdmin: true, adminAreas: ['newcomers', 'people'],
    });
    const first = await createNewcomerVisitor(env.DB, peopleAdmin, {
      submissionId, expectedVersion: 0,
    }, runtime([
      '67100000-0000-4000-8000-000000000011',
      '67100000-0000-4000-8000-000000000012',
    ], '2026-08-12 17:00:00'));
    const before = await env.DB.prepare(`SELECT version,last_mutation_id,linked_person_id
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first();

    await expect(createNewcomerVisitor(env.DB, peopleAdmin, {
      submissionId, expectedVersion: 1,
    }, runtime([
      '67100000-0000-4000-8000-000000000013',
      '67100000-0000-4000-8000-000000000014',
    ], '2026-08-12 17:00:00'))).rejects.toBeInstanceOf(NewcomerConflictError);

    expect(await env.DB.prepare(`SELECT version,last_mutation_id,linked_person_id
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first()).toEqual(before);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM people
      WHERE email='mutation@example.test'`).first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_activity
      WHERE submission_id=?`).bind(submissionId).first<number>('n')).toBe(1);
    expect(before).toMatchObject({ version: 1, linked_person_id: first.personId });
  });

  it('rolls back visitor creation when its trusted mutation marker collides', async () => {
    await seedSubmission();
    await env.DB.prepare(`UPDATE people SET calendar_token='67110000-0000-4000-8000-000000000011'
      WHERE id=9805`).run();
    const peopleAdmin = scopedUser({
      id: 9806, role: 'admin', isAdmin: true, adminAreas: ['newcomers', 'people'],
    });
    await expect(createNewcomerVisitor(env.DB, peopleAdmin, {
      submissionId, expectedVersion: 0,
    }, runtime([
      '67110000-0000-4000-8000-000000000011',
      '67110000-0000-4000-8000-000000000012',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare(`SELECT version,last_mutation_id,linked_person_id
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first()).toEqual({
      version: 0, last_mutation_id: null, linked_person_id: null,
    });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM people
      WHERE email='mutation@example.test'`).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT calendar_token FROM people WHERE id=9805')
      .first<string>('calendar_token')).toBe('67110000-0000-4000-8000-000000000011');
  });

  it('classifies phone-only visitor creation only when the current submission is still unlinked', async () => {
    await env.DB.prepare(`INSERT INTO newcomer_submissions
      (id,name,phone,locale,visit_date,source,status_id,linked_person_id,version,created_at,updated_at)
      VALUES ('67200000-0000-4000-8000-000000000001','Already linked','+13125550125','en',
        '2026-08-10','staff',1,9805,0,'2026-08-12 09:00:00','2026-08-12 09:00:00')`).run();
    const peopleAdmin = scopedUser({
      id: 9806, role: 'admin', isAdmin: true, adminAreas: ['newcomers', 'people'],
    });
    await expect(createNewcomerVisitor(env.DB, peopleAdmin, {
      submissionId: '67200000-0000-4000-8000-000000000001', expectedVersion: 0,
    }, runtime([
      '67200000-0000-4000-8000-000000000011',
      '67200000-0000-4000-8000-000000000012',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare(`SELECT version,last_mutation_id,linked_person_id
      FROM newcomer_submissions WHERE id='67200000-0000-4000-8000-000000000001'`).first()).toEqual({
      version: 0, last_mutation_id: null, linked_person_id: 9805,
    });
  });

  it('serializes concurrent D1 claims and rolls the stale loser back without activity', async () => {
    await seedSubmission();
    const attempts = await Promise.allSettled([
      assignNewcomer(env.DB, scopedUser(), {
        submissionId, expectedVersion: 0, assigneePersonId: 9802,
      }, runtime([
        '68000000-0000-4000-8000-000000000011',
        '68000000-0000-4000-8000-000000000012',
      ])),
      assignNewcomer(env.DB, scopedUser(), {
        submissionId, expectedVersion: 0, assigneePersonId: 9801,
      }, runtime([
        '68000000-0000-4000-8000-000000000013',
        '68000000-0000-4000-8000-000000000014',
      ])),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect((attempts.find((item) => item.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare('SELECT version FROM newcomer_submissions WHERE id=?')
      .bind(submissionId).first<number>('version')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_activity WHERE submission_id=?')
      .bind(submissionId).first<number>('n')).toBe(1);
  });

  it('rolls create-submission configuration drift and activity collisions back completely', async () => {
    await env.DB.prepare(`INSERT INTO newcomer_fields
      (id,key,type,required,active,sort,fixed) VALUES (8,'required_story','textarea',1,1,8,0)`).run();
    await expect(createNewcomerSubmission(
      env.DB,
      null,
      'public',
      intake({ name: 'Missing required answer' }) as never,
      runtime([
        '69000000-0000-4000-8000-000000000001',
        '69000000-0000-4000-8000-000000000002',
      ]),
    )).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_submissions
      WHERE id='69000000-0000-4000-8000-000000000001'`).first<number>('n')).toBe(0);

    await env.DB.prepare('UPDATE newcomer_fields SET required=0 WHERE id=8').run();
    await env.DB.prepare(`INSERT INTO newcomer_submissions
      (id,name,locale,visit_date,source) VALUES
      ('69000000-0000-4000-8000-000000000010','Existing','en','2026-08-10','staff')`).run();
    await env.DB.prepare(`INSERT INTO newcomer_activity
      (id,submission_id,kind,metadata_json,created_at) VALUES
      ('69000000-0000-4000-8000-000000000012','69000000-0000-4000-8000-000000000010',
        'submission_created','{}','2026-08-12 10:00:00')`).run();
    await expect(createNewcomerSubmission(
      env.DB,
      null,
      'public',
      intake({ name: 'Activity collision' }) as never,
      runtime([
        '69000000-0000-4000-8000-000000000011',
        '69000000-0000-4000-8000-000000000012',
      ]),
    )).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_submissions
      WHERE id='69000000-0000-4000-8000-000000000011'`).first<number>('n')).toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_answers
      WHERE submission_id='69000000-0000-4000-8000-000000000011'`).first<number>('n')).toBe(0);
  });

  it('never revives a soft-deleted email or copies newcomer private data into pastoral notes', async () => {
    await seedSubmission();
    await env.DB.prepare(`INSERT INTO people
      (id,display_name,email,deleted_at) VALUES
      (9810,'Deleted Visitor','mutation@example.test','2026-08-01 10:00:00')`).run();
    await env.DB.prepare(`INSERT INTO newcomer_notes
      (id,submission_id,author_person_id,body,created_at) VALUES
      ('6a000000-0000-4000-8000-000000000001',?,9801,'Private newcomer note','2026-08-12 10:00:00')`)
      .bind(submissionId).run();
    const peopleAdmin = scopedUser({
      id: 9806, role: 'admin', isAdmin: true, adminAreas: ['newcomers', 'people'],
    });
    await expect(createNewcomerVisitor(
      env.DB,
      peopleAdmin,
      { submissionId, expectedVersion: 0 },
      runtime([
        '6a000000-0000-4000-8000-000000000011',
        '6a000000-0000-4000-8000-000000000012',
      ]),
    )).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare(`SELECT deleted_at,active,role,super_admin,admin_areas
      FROM people WHERE id=9810`).first()).toEqual({
      deleted_at: '2026-08-01 10:00:00', active: 1, role: 'member', super_admin: 0, admin_areas: '',
    });
    expect(await env.DB.prepare('SELECT version,last_mutation_id,linked_person_id FROM newcomer_submissions WHERE id=?')
      .bind(submissionId).first()).toEqual({ version: 0, last_mutation_id: null, linked_person_id: null });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM person_notes').first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT body FROM newcomer_notes WHERE submission_id=?')
      .bind(submissionId).first<string>('body')).toBe('Private newcomer note');
  });

  it('rolls back status/follow-up no-ops, inactive targets, note collisions, and inactive link targets', async () => {
    await seedSubmission();
    const base = await env.DB.prepare(`SELECT version,last_mutation_id,status_id,next_follow_up_date,linked_person_id
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first();
    await expect(changeNewcomerStatus(env.DB, scopedUser(), {
      submissionId, expectedVersion: 0, statusId: 1,
    }, runtime([
      '6c000000-0000-4000-8000-000000000011',
      '6c000000-0000-4000-8000-000000000012',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    await env.DB.prepare('UPDATE newcomer_statuses SET active=0 WHERE id=2').run();
    await expect(changeNewcomerStatus(env.DB, scopedUser(), {
      submissionId, expectedVersion: 0, statusId: 2,
    }, runtime([
      '6c000000-0000-4000-8000-000000000013',
      '6c000000-0000-4000-8000-000000000014',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    await expect(scheduleNewcomerFollowUp(env.DB, scopedUser(), {
      submissionId, expectedVersion: 0, followUpDate: null,
    }, runtime([
      '6c000000-0000-4000-8000-000000000015',
      '6c000000-0000-4000-8000-000000000016',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);

    await env.DB.prepare(`INSERT INTO newcomer_notes
      (id,submission_id,author_person_id,body,created_at) VALUES
      ('6c000000-0000-4000-8000-000000000018',?,9801,'Existing','2026-08-12 10:00:00')`)
      .bind(submissionId).run();
    await expect(addNewcomerNote(env.DB, scopedUser(), {
      submissionId, expectedVersion: 0, body: 'Must roll back',
    }, runtime([
      '6c000000-0000-4000-8000-000000000017',
      '6c000000-0000-4000-8000-000000000018',
      '6c000000-0000-4000-8000-000000000019',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    await env.DB.prepare(`UPDATE people SET phone='+1 (312) 555-0124',active=0 WHERE id=9805`).run();
    await expect(linkNewcomerPerson(env.DB, scopedUser(), {
      submissionId, expectedVersion: 0, personId: 9805,
    }, runtime([
      '6c000000-0000-4000-8000-000000000020',
      '6c000000-0000-4000-8000-000000000021',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare(`SELECT version,last_mutation_id,status_id,next_follow_up_date,linked_person_id
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first()).toEqual(base);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_activity WHERE submission_id=?')
      .bind(submissionId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_notes WHERE submission_id=?')
      .bind(submissionId).first<number>('n')).toBe(1);
  });

  it('rolls the complete D1 snapshot back at every statement boundary for every mutation', async () => {
    const failingDb = (statementIndex: number): AppDb => ({
      prepare(sql: string) { return env.DB.prepare(sql); },
      batch(statements: AppStatement[]) {
        const injected = statements.slice();
        injected[statementIndex] = env.DB.prepare(`
          INSERT INTO newcomer_status_i18n (status_id,locale,label) VALUES (0,'en','forced failure')
        `);
        return env.DB.batch(injected as D1PreparedStatement[]) as never;
      },
    });
    const peopleAdmin = scopedUser({
      id: 9806, role: 'admin', isAdmin: true, adminAreas: ['newcomers', 'people'],
    });
    await env.DB.prepare(`INSERT INTO newcomer_fields
      (id,key,type,required,active,sort,fixed) VALUES (8,'fault_answer','text',1,1,8,0)`).run();
    const reset = async (needsSubmission: boolean) => {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM newcomer_activity'),
        env.DB.prepare('DELETE FROM newcomer_notes'),
        env.DB.prepare('DELETE FROM newcomer_answers'),
        env.DB.prepare('DELETE FROM newcomer_submissions'),
        env.DB.prepare(`DELETE FROM people WHERE email='mutation@example.test'`),
        env.DB.prepare(`UPDATE people SET phone='+1 (312) 555-0124',active=1 WHERE id=9805`),
      ]);
      if (needsSubmission) await seedSubmission();
    };
    const snapshot = async () => ({
      submissions: (await env.DB.prepare(`SELECT id,status_id,assignee_person_id,linked_person_id,
        next_follow_up_date,closed_at,version,last_mutation_id,updated_at
        FROM newcomer_submissions ORDER BY id`).all()).results,
      answers: (await env.DB.prepare(`SELECT submission_id,field_id,value
        FROM newcomer_answers ORDER BY submission_id,field_id`).all()).results,
      notes: (await env.DB.prepare(`SELECT id,submission_id,author_person_id,body,created_at
        FROM newcomer_notes ORDER BY id`).all()).results,
      activity: (await env.DB.prepare(`SELECT id,submission_id,actor_person_id,kind,metadata_json,created_at
        FROM newcomer_activity ORDER BY id`).all()).results,
      people: (await env.DB.prepare(`SELECT id,email,calendar_token,active,deleted_at,admin_areas
        FROM people WHERE id>=9800 ORDER BY id`).all()).results,
    });
    const cases: Array<{
      name: string; statements: number; needsSubmission: boolean; invoke: (db: AppDb) => Promise<unknown>;
    }> = [
      {
        name: 'create', statements: 7, needsSubmission: false,
        invoke: (attemptDb) => createNewcomerSubmission(attemptDb, null, 'public', intake({
          name: 'Fault create', answers: [{ fieldId: 8, value: 'Safe' }],
        }) as never, runtime([
          '6d100000-0000-4000-8000-000000000001',
          '6d100000-0000-4000-8000-000000000002',
        ])),
      },
      {
        name: 'assignment', statements: 5, needsSubmission: true,
        invoke: (attemptDb) => assignNewcomer(attemptDb, scopedUser(), {
          submissionId, expectedVersion: 0, assigneePersonId: 9802,
        }, runtime([
          '6d200000-0000-4000-8000-000000000001',
          '6d200000-0000-4000-8000-000000000002',
        ])),
      },
      {
        name: 'status', statements: 5, needsSubmission: true,
        invoke: (attemptDb) => changeNewcomerStatus(attemptDb, scopedUser(), {
          submissionId, expectedVersion: 0, statusId: 4,
        }, runtime([
          '6d300000-0000-4000-8000-000000000001',
          '6d300000-0000-4000-8000-000000000002',
        ])),
      },
      {
        name: 'follow-up', statements: 4, needsSubmission: true,
        invoke: (attemptDb) => scheduleNewcomerFollowUp(attemptDb, scopedUser(), {
          submissionId, expectedVersion: 0, followUpDate: '2026-08-30',
        }, runtime([
          '6d400000-0000-4000-8000-000000000001',
          '6d400000-0000-4000-8000-000000000002',
        ])),
      },
      {
        name: 'note', statements: 4, needsSubmission: true,
        invoke: (attemptDb) => addNewcomerNote(attemptDb, scopedUser(), {
          submissionId, expectedVersion: 0, body: 'Must roll back',
        }, runtime([
          '6d500000-0000-4000-8000-000000000001',
          '6d500000-0000-4000-8000-000000000002',
          '6d500000-0000-4000-8000-000000000003',
        ])),
      },
      {
        name: 'link', statements: 5, needsSubmission: true,
        invoke: (attemptDb) => linkNewcomerPerson(attemptDb, scopedUser(), {
          submissionId, expectedVersion: 0, personId: 9805,
        }, runtime([
          '6d600000-0000-4000-8000-000000000001',
          '6d600000-0000-4000-8000-000000000002',
        ])),
      },
      {
        name: 'visitor', statements: 6, needsSubmission: true,
        invoke: (attemptDb) => createNewcomerVisitor(attemptDb, peopleAdmin, {
          submissionId, expectedVersion: 0,
        }, runtime([
          '6d700000-0000-4000-8000-000000000001',
          '6d700000-0000-4000-8000-000000000002',
        ])),
      },
    ];
    for (const candidate of cases) {
      for (let index = 0; index < candidate.statements; index += 1) {
        await reset(candidate.needsSubmission);
        const before = await snapshot();
        const error = await candidate.invoke(failingDb(index)).catch((caught: unknown) => caught);
        expect(error, `${candidate.name} statement ${index}`).toSatisfy(
          (caught: unknown) => caught instanceof NewcomerConflictError
            || caught instanceof NewcomerPersistenceError,
        );
        expect((error as Error).message).not.toContain('mutation@example.test');
        expect(await snapshot(), `${candidate.name} statement ${index}`).toEqual(before);
      }
    }
  });

  it('rejects structurally valid but non-canonical assignment, status, and visitor activity metadata', async () => {
    const tamperedDb = (activityIndex: number, activitySql: string): AppDb => ({
      prepare(sql: string) { return env.DB.prepare(sql); },
      batch(statements: AppStatement[]) {
        const injected = statements.slice();
        injected[activityIndex] = env.DB.prepare(activitySql);
        return env.DB.batch(injected as D1PreparedStatement[]) as never;
      },
    });
    const base = { version: 0, last_mutation_id: null };

    await seedSubmission();
    const assignmentError = await assignNewcomer(tamperedDb(2, `
      INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind,metadata_json,created_at)
      SELECT '6f000000-0000-4000-8000-000000000012',id,9801,'assigned','{}','2026-08-12 12:34:56'
      FROM newcomer_submissions WHERE id='${submissionId}'
        AND last_mutation_id='6f000000-0000-4000-8000-000000000011'
    `), scopedUser(), {
      submissionId, expectedVersion: 0, assigneePersonId: 9802,
    }, runtime([
      '6f000000-0000-4000-8000-000000000011',
      '6f000000-0000-4000-8000-000000000012',
    ])).catch((error: unknown) => error);
    expect(assignmentError instanceof NewcomerConflictError
      || assignmentError instanceof NewcomerPersistenceError).toBe(true);
    expect(await env.DB.prepare('SELECT version,last_mutation_id FROM newcomer_submissions WHERE id=?')
      .bind(submissionId).first()).toEqual(base);

    const statusError = await changeNewcomerStatus(tamperedDb(2, `
      INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind,metadata_json,created_at)
      SELECT '6f000000-0000-4000-8000-000000000014',id,9801,'status_changed','{}','2026-08-12 12:34:56'
      FROM newcomer_submissions WHERE id='${submissionId}'
        AND last_mutation_id='6f000000-0000-4000-8000-000000000013'
    `), scopedUser(), {
      submissionId, expectedVersion: 0, statusId: 4,
    }, runtime([
      '6f000000-0000-4000-8000-000000000013',
      '6f000000-0000-4000-8000-000000000014',
    ])).catch((error: unknown) => error);
    expect(statusError instanceof NewcomerConflictError
      || statusError instanceof NewcomerPersistenceError).toBe(true);
    expect(await env.DB.prepare('SELECT version,last_mutation_id FROM newcomer_submissions WHERE id=?')
      .bind(submissionId).first()).toEqual(base);

    const peopleAdmin = scopedUser({
      id: 9806, role: 'admin', isAdmin: true, adminAreas: ['newcomers', 'people'],
    });
    const visitorError = await createNewcomerVisitor(tamperedDb(3, `
      INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind,metadata_json,created_at)
      SELECT '6f000000-0000-4000-8000-000000000016',id,9806,'visitor_created','{}','2026-08-12 12:34:56'
      FROM newcomer_submissions WHERE id='${submissionId}'
        AND last_mutation_id='6f000000-0000-4000-8000-000000000015'
    `), peopleAdmin, {
      submissionId, expectedVersion: 0,
    }, runtime([
      '6f000000-0000-4000-8000-000000000015',
      '6f000000-0000-4000-8000-000000000016',
    ])).catch((error: unknown) => error);
    expect(visitorError instanceof NewcomerConflictError
      || visitorError instanceof NewcomerPersistenceError).toBe(true);
    expect(await env.DB.prepare('SELECT version,last_mutation_id FROM newcomer_submissions WHERE id=?')
      .bind(submissionId).first()).toEqual(base);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM people
      WHERE email='mutation@example.test'`).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_activity').first<number>('n')).toBe(0);
  });

  it('requires an unassign state change to depend on the exact old-derived single-key activity', async () => {
    await seedSubmission('assignee_person_id=9802');
    const tamperedDb = {
      prepare(sql: string) { return env.DB.prepare(sql); },
      batch(statements: AppStatement[]) {
        const injected = statements.slice();
        injected[2] = env.DB.prepare(`
          INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind,metadata_json,created_at)
          SELECT '6f100000-0000-4000-8000-000000000012',id,9801,'assigned',
            '{"from_assignee_person_id":9802,"to_assignee_person_id":9801}',
            '2026-08-12 12:34:56'
          FROM newcomer_submissions WHERE id='${submissionId}'
            AND last_mutation_id='6f100000-0000-4000-8000-000000000011'
        `);
        return env.DB.batch(injected as D1PreparedStatement[]) as never;
      },
    } as AppDb;

    await expect(assignNewcomer(tamperedDb, scopedUser(), {
      submissionId, expectedVersion: 0, assigneePersonId: null,
    }, runtime([
      '6f100000-0000-4000-8000-000000000011',
      '6f100000-0000-4000-8000-000000000012',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare(`SELECT version,last_mutation_id,assignee_person_id
      FROM newcomer_submissions WHERE id=?`).bind(submissionId).first()).toEqual({
      version: 0, last_mutation_id: null, assignee_person_id: 9802,
    });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_activity')
      .first<number>('n')).toBe(0);
  });
});

describe('newcomer submission mutation', () => {
  it('authorizes staff before prepare and does not inspect hostile input', async () => {
    let prepares = 0;
    let reads = 0;
    const db = {
      prepare() { prepares += 1; throw new Error('must not prepare'); },
      batch() { throw new Error('must not batch'); },
    } as AppDb;
    const hostile = new Proxy({}, { ownKeys() { reads += 1; throw new Error('private'); } });
    await expect(createNewcomerSubmission(
      db,
      scopedUser({ adminAreas: [] }),
      'staff',
      hostile as never,
    )).rejects.toBeInstanceOf(NewcomerForbiddenError);
    expect({ prepares, reads }).toEqual({ prepares: 0, reads: 0 });
  });

  it('maps create statement preparation failures to a stable PII-free persistence error', async () => {
    const db = {
      prepare() { throw new Error('SQL includes guest@example.test and private answer'); },
      batch() { throw new Error('must not batch'); },
    } as AppDb;
    const error = await createNewcomerSubmission(db, null, 'public', intake({
      name: 'Prepare failure',
    }) as never, runtime([
      '61010000-0000-4000-8000-000000000001',
      '61010000-0000-4000-8000-000000000002',
    ])).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NewcomerPersistenceError);
    expect((error as Error).message).toBe('Newcomer persistence failed');
    expect((error as Error).message).not.toContain('guest@example.test');
  });

  it('atomically creates a public submission, exact answers and canonical activity without People side effects', async () => {
    await env.DB.prepare(`INSERT INTO service_types (id,sort) VALUES (9801,1)`).run();
    await env.DB.prepare(`INSERT INTO newcomer_fields
      (id,key,type,required,active,sort,fixed) VALUES (8,'next_step','select',1,1,8,0)`).run();
    await env.DB.prepare(`INSERT INTO newcomer_field_options
      (field_id,value,sort,active) VALUES (8,'group',1,1)`).run();
    const beforePeople = await env.DB.prepare('SELECT COUNT(*) AS n FROM people').first<number>('n');
    const result = await createNewcomerSubmission(
      env.DB,
      scopedUser(),
      'public',
      intake({ name: 'Guest One', serviceTypeId: 9801, answers: [{ fieldId: 8, value: 'group' }] }) as never,
      runtime([
        '61000000-0000-4000-8000-000000000001',
        '61000000-0000-4000-8000-000000000002',
      ]),
    );
    expect(result).toEqual({ id: '61000000-0000-4000-8000-000000000001', version: 0 });
    expect(await env.DB.prepare(`SELECT name,email,phone,locale,visit_date,service_type_id,
      contact_consent_at,source,status_id,assignee_person_id,linked_person_id,version,last_mutation_id,
      created_at,updated_at FROM newcomer_submissions WHERE id=?`)
      .bind(result.id).first()).toEqual({
      name: 'Guest One', email: 'guest@example.test', phone: '+13125550123', locale: 'en',
      visit_date: '2026-08-10', service_type_id: 9801,
      contact_consent_at: '2026-08-12 12:34:56', source: 'public', status_id: 1,
      assignee_person_id: null, linked_person_id: null, version: 0, last_mutation_id: null,
      created_at: '2026-08-12 12:34:56', updated_at: '2026-08-12 12:34:56',
    });
    expect(await env.DB.prepare('SELECT submission_id,field_id,value FROM newcomer_answers').all())
      .toMatchObject({ results: [{ submission_id: result.id, field_id: 8, value: 'group' }] });
    expect(await env.DB.prepare(`SELECT id,submission_id,actor_person_id,kind,metadata_json,created_at
      FROM newcomer_activity`).first()).toEqual({
      id: '61000000-0000-4000-8000-000000000002', submission_id: result.id,
      actor_person_id: null, kind: 'submission_created', metadata_json: '{}',
      created_at: '2026-08-12 12:34:56',
    });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM people').first<number>('n')).toBe(beforePeople);
  });

  it('rolls back zero-initial, deleted-service, and inactive-select configuration drift without residue', async () => {
    const attempt = async (suffix: string, overrides: Record<string, unknown>) => createNewcomerSubmission(
      env.DB,
      null,
      'public',
      intake({ name: `Drift ${suffix}`, ...overrides }) as never,
      runtime([
        `61100000-0000-4000-8000-0000000000${suffix}1`,
        `61100000-0000-4000-8000-0000000000${suffix}2`,
      ]),
    );

    await env.DB.prepare('UPDATE newcomer_statuses SET is_initial=0 WHERE is_initial=1').run();
    await expect(attempt('1', {})).rejects.toBeInstanceOf(NewcomerConflictError);
    await env.DB.prepare('UPDATE newcomer_statuses SET is_initial=1 WHERE id=1').run();

    await env.DB.prepare(`INSERT INTO service_types (id,sort,deleted_at)
      VALUES (9811,1,'2026-08-01 00:00:00')`).run();
    await expect(attempt('2', { serviceTypeId: 9811 })).rejects.toBeInstanceOf(NewcomerConflictError);

    await env.DB.prepare(`INSERT INTO newcomer_fields
      (id,key,type,required,active,sort,fixed) VALUES (8,'inactive_choice','select',1,1,8,0)`).run();
    await env.DB.prepare(`INSERT INTO newcomer_field_options
      (field_id,value,sort,active) VALUES (8,'was_active',1,0)`).run();
    await expect(attempt('3', {
      answers: [{ fieldId: 8, value: 'was_active' }],
    })).rejects.toBeInstanceOf(NewcomerConflictError);

    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_submissions
      WHERE id LIKE '61100000-%'`).first<number>('n')).toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_answers
      WHERE submission_id LIKE '61100000-%'`).first<number>('n')).toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_activity
      WHERE submission_id LIKE '61100000-%'`).first<number>('n')).toBe(0);
  });

  it('rejects a custom text answer above its current 500-byte type limit without residue', async () => {
    await env.DB.prepare(`INSERT INTO newcomer_fields
      (id,key,type,required,active,sort,fixed) VALUES (8,'short_story','text',1,1,8,0)`).run();
    await expect(createNewcomerSubmission(env.DB, null, 'public', intake({
      name: 'Text too long', answers: [{ fieldId: 8, value: 'x'.repeat(501) }],
    }) as never, runtime([
      '61200000-0000-4000-8000-000000000001',
      '61200000-0000-4000-8000-000000000002',
    ]))).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_submissions
      WHERE id='61200000-0000-4000-8000-000000000001'`).first<number>('n')).toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_answers
      WHERE submission_id='61200000-0000-4000-8000-000000000001'`).first<number>('n')).toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_activity
      WHERE submission_id='61200000-0000-4000-8000-000000000001'`).first<number>('n')).toBe(0);
  });
});
