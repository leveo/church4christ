import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  NewcomerForbiddenError,
  NewcomerLimitError,
  findNewcomerDuplicateHints,
  getNewcomerDetail,
  listNewcomerAdminConfiguration,
  listNewcomerFormDefinition,
  listNewcomerQueue,
} from '../src/lib/newcomerDb';
import type { SessionUser } from '../src/lib/types';

const user = (overrides: Partial<SessionUser> = {}): SessionUser => ({
  id: 7001,
  email: 'worker@example.test',
  displayName: 'Worker',
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

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM newcomer_activity'),
    env.DB.prepare('DELETE FROM newcomer_notes'),
    env.DB.prepare('DELETE FROM newcomer_answers'),
    env.DB.prepare('DELETE FROM newcomer_submissions'),
    env.DB.prepare('DELETE FROM newcomer_field_option_i18n WHERE field_id > 7'),
    env.DB.prepare('DELETE FROM newcomer_field_options WHERE field_id > 7'),
    env.DB.prepare('DELETE FROM newcomer_field_i18n WHERE field_id > 7'),
    env.DB.prepare('DELETE FROM newcomer_fields WHERE id > 7'),
    env.DB.prepare('DELETE FROM newcomer_status_i18n WHERE status_id > 5'),
    env.DB.prepare('DELETE FROM newcomer_statuses WHERE id > 5'),
    env.DB.prepare('DELETE FROM service_type_i18n WHERE service_type_id >= 9700'),
    env.DB.prepare('DELETE FROM service_types WHERE id >= 9700'),
    env.DB.prepare('DELETE FROM people WHERE id >= 9700'),
  ]);
});

describe('newcomer read authorization', () => {
  it('rejects every private read before preparing SQL', async () => {
    let prepares = 0;
    const forbiddenDb = {
      prepare() { prepares += 1; throw new Error('SQL must not be touched'); },
      batch() { throw new Error('batch must not be touched'); },
    } as AppDb;
    const denied = user({ adminAreas: [] });
    await expect(listNewcomerAdminConfiguration(forbiddenDb, 'd1', denied, 'en'))
      .rejects.toBeInstanceOf(NewcomerForbiddenError);
    await expect(listNewcomerQueue(forbiddenDb, denied, 'en', { page: 1, limit: 25 }, '2026-08-12'))
      .rejects.toBeInstanceOf(NewcomerForbiddenError);
    await expect(getNewcomerDetail(forbiddenDb, 'd1', denied, '10000000-0000-4000-8000-000000000001', 'en'))
      .rejects.toBeInstanceOf(NewcomerForbiddenError);
    await expect(findNewcomerDuplicateHints(forbiddenDb, denied, {
      email: 'private@example.test', phone: null, excludeSubmissionId: null,
    })).rejects.toBeInstanceOf(NewcomerForbiddenError);
    expect(prepares).toBe(0);
  });
});

describe('newcomer localized configuration reads', () => {
  it('reads one bounded snapshot with requested, English, then stable fallback labels', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO service_types (id,sort) VALUES (9701,1)"),
      env.DB.prepare("INSERT INTO service_type_i18n VALUES (9701,'en','Welcome Service')"),
      env.DB.prepare("INSERT INTO newcomer_statuses VALUES (6,'awaiting_host','open',6,1,0)"),
      env.DB.prepare("INSERT INTO newcomer_status_i18n VALUES (6,'en','Awaiting host')"),
      env.DB.prepare("INSERT INTO newcomer_fields VALUES (8,'connection_path','select',1,1,8,0)"),
      env.DB.prepare("INSERT INTO newcomer_field_i18n VALUES (8,'en','Connection path',NULL)"),
      env.DB.prepare("INSERT INTO newcomer_field_options VALUES (8,'group',1,1)"),
      env.DB.prepare("INSERT INTO newcomer_field_options VALUES (8,'serve',2,1)"),
      env.DB.prepare("INSERT INTO newcomer_field_option_i18n VALUES (8,'group','en','Small group')"),
    ]);
    const form = await listNewcomerFormDefinition(env.DB, 'd1', 'zh');
    expect(form).toEqual({
      activeServiceTypeIds: [9701],
      fields: [{
        id: 8,
        key: 'connection_path',
        type: 'select',
        required: true,
        label: 'Connection path',
        help: null,
        options: [
          { value: 'group', label: 'Small group' },
          { value: 'serve', label: 'serve' },
        ],
      }],
    });
    const config = await listNewcomerAdminConfiguration(env.DB, 'd1', user(), 'zh');
    expect(config.statuses.find((status) => status.id === 6)).toMatchObject({
      key: 'awaiting_host', label: 'Awaiting host', category: 'open', active: true,
    });
    expect(config.fields.find((field) => field.id === 8)?.options[1]).toEqual({
      value: 'serve', label: 'serve', active: true, sort: 2,
    });
    expect(config.serviceTypes).toEqual([{ id: 9701, label: 'Welcome Service' }]);
  });

  it('fails instead of truncating a 101st status or 1001st active option', async () => {
    await env.DB.batch(Array.from({ length: 96 }, (_, index) => env.DB.prepare(
      'INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (?,?,?,?,1,0)',
    ).bind(100 + index, `custom_${index}`, 'open', 100 + index)));
    await expect(listNewcomerAdminConfiguration(env.DB, 'd1', user(), 'en'))
      .rejects.toBeInstanceOf(NewcomerLimitError);
    await env.DB.batch(Array.from({ length: 96 }, (_, index) => env.DB.prepare(
      'DELETE FROM newcomer_statuses WHERE id=?',
    ).bind(100 + index)));

    await env.DB.batch(Array.from({ length: 11 }, (_, fieldIndex) => env.DB.prepare(
      'INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (?,?,?,?,1,?,0)',
    ).bind(100 + fieldIndex, `select_${fieldIndex}`, 'select', 0, 100 + fieldIndex)));
    const statements = [];
    for (let fieldIndex = 0; fieldIndex < 11; fieldIndex += 1) {
      const count = fieldIndex === 10 ? 1 : 100;
      for (let optionIndex = 0; optionIndex < count; optionIndex += 1) {
        statements.push(env.DB.prepare(
          'INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (?,?,?,1)',
        ).bind(100 + fieldIndex, `v_${optionIndex}`, optionIndex));
      }
    }
    await env.DB.batch(statements);
    await expect(listNewcomerFormDefinition(env.DB, 'd1', 'en')).rejects.toBeInstanceOf(NewcomerLimitError);
  });
});

describe('newcomer queue, detail, and duplicate hints', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO people (id,display_name,email,phone,deleted_at) VALUES
        (9701,'Live exact','live@example.test','+13125550101',NULL),
        (9702,'Deleted exact','deleted@example.test','+13125550102','2026-08-01 12:00:00'),
        (9703,'Worker','worker@example.test',NULL,NULL)`),
      env.DB.prepare("INSERT INTO service_types (id,sort) VALUES (9701,1)"),
      env.DB.prepare("INSERT INTO service_type_i18n VALUES (9701,'en','Welcome')"),
      env.DB.prepare("INSERT INTO newcomer_fields VALUES (8,'story','textarea',0,1,8,0)"),
      env.DB.prepare("INSERT INTO newcomer_field_i18n VALUES (8,'en','Story',NULL)"),
      env.DB.prepare(`INSERT INTO newcomer_submissions
        (id,name,email,phone,locale,visit_date,service_type_id,contact_consent_at,source,status_id,
         assignee_person_id,next_follow_up_date,created_at,updated_at)
        VALUES
        ('10000000-0000-4000-8000-000000000001','First','live@example.test',NULL,'en','2026-08-10',9701,
          '2026-08-10 10:00:00','public',1,9703,'2026-08-11','2026-08-10 10:00:00','2026-08-12 10:00:00'),
        ('10000000-0000-4000-8000-000000000002','Second',NULL,'+13125550102','zh','2026-08-11',NULL,
          NULL,'staff',2,NULL,NULL,'2026-08-11 10:00:00','2026-08-12 11:00:00')`),
      env.DB.prepare(`INSERT INTO newcomer_answers VALUES
        ('10000000-0000-4000-8000-000000000001',8,'Private answer')`),
      env.DB.prepare(`INSERT INTO newcomer_notes
        (id,submission_id,author_person_id,body,created_at) VALUES
        ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',9703,
          'Private note','2026-08-12 10:01:00')`),
      env.DB.prepare(`INSERT INTO newcomer_activity
        (id,submission_id,actor_person_id,kind,metadata_json,created_at) VALUES
        ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',9703,
          'assigned','{"assignee_person_id":9703}','2026-08-12 10:02:00')`),
    ]);
  });

  it('lists deterministic pages using fixed filters and no pastoral/security fields', async () => {
    const queue = await listNewcomerQueue(env.DB, user(), 'en', {
      statusId: 1, assigneePersonId: 9703, due: 'overdue', visitFrom: '2026-08-01',
      visitTo: '2026-08-31', serviceTypeId: 9701, source: 'public', page: 1, limit: 1,
    }, '2026-08-12');
    expect(queue).toEqual({
      rows: [expect.objectContaining({
        id: '10000000-0000-4000-8000-000000000001', name: 'First', statusLabel: 'New',
        serviceLabel: 'Welcome', consent: true,
      })],
      page: 1,
      limit: 1,
      hasNext: false,
    });
    expect(JSON.stringify(queue)).not.toContain('Private note');
    expect(JSON.stringify(queue)).not.toContain('session');
  });

  it('loads one strict detail snapshot with answers, notes, and structural activity', async () => {
    const detail = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en',
    );
    expect(detail).toMatchObject({
      submission: { name: 'First', statusLabel: 'New' },
      answers: [{ fieldId: 8, fieldLabel: 'Story', value: 'Private answer' }],
      notes: [{ authorPersonId: 9703, body: 'Private note' }],
      activity: [{ kind: 'assigned', metadata: { assignee_person_id: 9703 } }],
    });
    expect(JSON.stringify(detail)).not.toContain('worker@example.test');
  });

  it('returns exact minimal live/deleted/open hints without contact or person names', async () => {
    const live = await findNewcomerDuplicateHints(env.DB, user(), {
      email: 'live@example.test', phone: null, excludeSubmissionId: '10000000-0000-4000-8000-000000000001',
    });
    expect(live).toEqual([{ kind: 'person_live', id: 9701 }]);
    const deletedAndOpen = await findNewcomerDuplicateHints(env.DB, user(), {
      email: 'deleted@example.test', phone: '+13125550102', excludeSubmissionId: null,
    });
    expect(deletedAndOpen).toEqual([
      { kind: 'person_deleted', id: 9702 },
      { kind: 'submission_open', id: '10000000-0000-4000-8000-000000000002', statusId: 2 },
    ]);
    const serialized = JSON.stringify(deletedAndOpen);
    expect(serialized).not.toContain('deleted@example.test');
    expect(serialized).not.toContain('Deleted exact');
  });
});
