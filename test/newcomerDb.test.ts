import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  NewcomerForbiddenError,
  NewcomerLimitError,
  NewcomerConflictError,
  NewcomerInvalidError,
  NewcomerPersistenceError,
  createNewcomerField,
  createNewcomerStatus,
  decodeNewcomerActivityMetadata,
  findNewcomerDuplicateHints,
  getNewcomerDetail,
  listNewcomerAdminConfiguration,
  listNewcomerFormDefinition,
  listNewcomerQueue,
  updateNewcomerField,
  updateNewcomerStatus,
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

const superAdmin = user({
  role: 'admin', isAdmin: true, isSuperAdmin: true, adminAreas: [],
});

const configurationSnapshot = () => {
  const statuses = [
    [1, 'new', 'open', 1, 1, 1, 'New'],
    [2, 'assigned', 'open', 2, 1, 0, 'Assigned'],
    [3, 'contacted', 'open', 3, 1, 0, 'Contacted'],
    [4, 'connected', 'closed', 4, 1, 0, 'Connected'],
    [5, 'closed', 'closed', 5, 1, 0, 'Closed'],
  ].map(([id, key, category, sort, active, is_initial, label]) => ({ id, key, category, sort, active, is_initial, label }));
  const fields = [
    [1, 'name', 'text'], [2, 'email', 'text'], [3, 'phone', 'text'],
    [4, 'preferred_language', 'select'], [5, 'visit_date', 'text'],
    [6, 'service_type', 'select'], [7, 'contact_consent', 'checkbox'],
  ].map(([id, key, type]) => ({
    id, key, type, required: 0, active: 1, sort: id, fixed: 1, label: key, help: null,
  }));
  const result = (results: unknown[]) => ({ results, meta: { changes: 0 } });
  return { statuses, fields, results: [result(statuses), result(fields), result([]), result([]), result([])] };
};

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

  it('requires super-admin for the full configuration read before preparing SQL', async () => {
    let prepares = 0;
    const untouchedDb = {
      prepare() { prepares += 1; throw new Error('SQL must not be touched'); },
      batch() { throw new Error('batch must not be touched'); },
    } as AppDb;
    await expect(listNewcomerAdminConfiguration(untouchedDb, 'd1', user(), 'en'))
      .rejects.toBeInstanceOf(NewcomerForbiddenError);
    expect(prepares).toBe(0);
  });

  it('rejects every settings mutation before preparing SQL unless the actor is super-admin', async () => {
    let prepares = 0;
    const forbiddenDb = {
      prepare() { prepares += 1; throw new Error('SQL must not be touched'); },
      batch() { throw new Error('batch must not be touched'); },
    } as AppDb;
    const scoped = user();
    await expect(createNewcomerStatus(forbiddenDb, scoped, {
      key: 'reviewing', category: 'open', sort: 6, active: true, labelEn: 'Reviewing', labelZh: '审核中',
    })).rejects.toBeInstanceOf(NewcomerForbiddenError);
    await expect(updateNewcomerStatus(forbiddenDb, scoped, {
      id: 1, sort: 1, active: true, initialStatusId: 1, labelEn: 'New', labelZh: '新朋友',
    })).rejects.toBeInstanceOf(NewcomerForbiddenError);
    await expect(createNewcomerField(forbiddenDb, scoped, {
      key: 'story', type: 'textarea', required: false, active: true, sort: 8,
      labelEn: 'Story', labelZh: '故事', helpEn: null, helpZh: null, options: [],
    })).rejects.toBeInstanceOf(NewcomerForbiddenError);
    await expect(updateNewcomerField(forbiddenDb, scoped, {
      id: 1, required: false, active: true, sort: 1,
      labelEn: 'Name', labelZh: '姓名', helpEn: null, helpZh: null, options: [],
    })).rejects.toBeInstanceOf(NewcomerForbiddenError);
    expect(prepares).toBe(0);
  });

  it('fails closed on accessor-backed result wrappers without invoking private getters', async () => {
    let invoked = 0;
    const hostileResult = { meta: { changes: 0 }, success: true } as Record<string, unknown>;
    Object.defineProperty(hostileResult, 'results', {
      enumerable: true,
      get() { invoked += 1; return [{ private_contact: 'must-not-read' }]; },
    });
    const fakeDb = {
      prepare() {
        return { bind() { return this; }, first: async () => null, all: async () => hostileResult, run: async () => hostileResult };
      },
      batch: async () => [hostileResult, hostileResult, hostileResult, hostileResult, hostileResult],
    } as unknown as AppDb;
    const error = await listNewcomerAdminConfiguration(fakeDb, 'd1', superAdmin, 'en')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NewcomerPersistenceError);
    expect(String(error)).not.toContain('must-not-read');
    expect(invoked).toBe(0);
  });

  it('rejects malformed non-null contact rows without returning them as null', async () => {
    const unsafeEmail = 'PRIVATE VALUE';
    const result = {
      results: [{
        id: '10000000-0000-4000-8000-000000000001', name: 'Safe', email: unsafeEmail, phone: null,
        locale: 'en', visit_date: '2026-08-12', service_type_id: null, service_label: null,
        contact_consent_at: null, source: 'staff', status_id: 1, status_label: 'New',
        assignee_person_id: null, next_follow_up_date: null, version: 0,
        created_at: '2026-08-12 10:00:00', updated_at: '2026-08-12 10:00:00',
      }],
      meta: { changes: 0 },
    };
    const statement = { bind() { return this; }, first: async () => null, all: async () => result, run: async () => result };
    const fakeDb = { prepare: () => statement, batch: async () => [] } as unknown as AppDb;
    const error = await listNewcomerQueue(fakeDb, user(), 'en', { page: 1, limit: 25 }, '2026-08-12')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NewcomerPersistenceError);
    expect(String(error)).not.toContain(unsafeEmail);
  });

  it('rejects coercible numeric database rows instead of normalizing adapter output', async () => {
    const result = {
      results: [{
        id: '10000000-0000-4000-8000-000000000001', name: 'Safe', email: null, phone: null,
        locale: 'en', visit_date: '2026-08-12', service_type_id: null, service_label: null,
        contact_consent_at: null, source: 'staff', status_id: '1', status_label: 'New',
        assignee_person_id: null, next_follow_up_date: null, version: 0,
        created_at: '2026-08-12 10:00:00', updated_at: '2026-08-12 10:00:00',
      }],
      meta: { changes: 0 },
    };
    const statement = { bind() { return this; }, first: async () => null, all: async () => result, run: async () => result };
    const fakeDb = { prepare: () => statement, batch: async () => [] } as unknown as AppDb;
    await expect(listNewcomerQueue(fakeDb, user(), 'en', { page: 1, limit: 25 }, '2026-08-12'))
      .rejects.toBeInstanceOf(NewcomerPersistenceError);
  });

  it('strictly decodes configuration relationships without coercing row values', async () => {
    let coercions = 0;
    const snapshot = configurationSnapshot();
    snapshot.fields[0].type = {
      toString() { coercions += 1; return 'text'; },
      valueOf() { coercions += 1; return 'text'; },
      [Symbol.toPrimitive]() { coercions += 1; return 'text'; },
    } as never;
    const statement = { bind() { return this; }, first: async () => null, all: async () => ({ results: [], meta: { changes: 0 } }), run: async () => ({ results: [], meta: { changes: 0 } }) };
    const fakeDb = { prepare: () => statement, batch: async () => snapshot.results } as unknown as AppDb;
    await expect(listNewcomerAdminConfiguration(fakeDb, 'd1', superAdmin, 'en'))
      .rejects.toBeInstanceOf(NewcomerPersistenceError);
    expect(coercions).toBe(0);

    const duplicate = configurationSnapshot();
    duplicate.statuses[1].key = 'new';
    const duplicateDb = { prepare: () => statement, batch: async () => duplicate.results } as unknown as AppDb;
    await expect(listNewcomerAdminConfiguration(duplicateDb, 'd1', superAdmin, 'en'))
      .rejects.toBeInstanceOf(NewcomerPersistenceError);
  });

  it('uses kind-specific allowlists and scalar validation for activity metadata', () => {
    expect(decodeNewcomerActivityMetadata('submission_created', '{}')).toEqual({});
    expect(decodeNewcomerActivityMetadata('assigned', '{"from_assignee_person_id":1,"to_assignee_person_id":2}'))
      .toEqual({ from_assignee_person_id: 1, to_assignee_person_id: 2 });
    expect(decodeNewcomerActivityMetadata('status_changed', '{"from_status_id":1,"to_status_id":2}'))
      .toEqual({ from_status_id: 1, to_status_id: 2 });
    expect(decodeNewcomerActivityMetadata('follow_up_scheduled', '{"follow_up_date":"2026-08-20"}'))
      .toEqual({ follow_up_date: '2026-08-20' });
    expect(decodeNewcomerActivityMetadata('follow_up_scheduled', '{}')).toEqual({});
    expect(decodeNewcomerActivityMetadata('note_added', '{"note_id":"20000000-0000-4000-8000-000000000001"}'))
      .toEqual({ note_id: '20000000-0000-4000-8000-000000000001' });
    expect(decodeNewcomerActivityMetadata('person_linked', '{"person_id":9701}')).toEqual({ person_id: 9701 });
    expect(decodeNewcomerActivityMetadata('visitor_created', '{"person_id":9701}')).toEqual({ person_id: 9701 });
    expect(decodeNewcomerActivityMetadata('assigned', '{"status_id":1}')).toBeNull();
    expect(decodeNewcomerActivityMetadata('status_changed', '{"to_status_id":2}')).toBeNull();
    expect(decodeNewcomerActivityMetadata('note_added', '{"note_id":"private-text"}')).toBeNull();
  });
});

describe('newcomer super-admin configuration mutations', () => {
  it('rejects coercible field types without invoking coercion or preparing SQL', async () => {
    let coercions = 0;
    let prepares = 0;
    const hostileType = {
      toString() { coercions += 1; return 'text'; },
      valueOf() { coercions += 1; return 'text'; },
      [Symbol.toPrimitive]() { coercions += 1; return 'text'; },
    };
    const untouchedDb = {
      prepare() { prepares += 1; throw new Error('SQL must not be touched'); },
      batch() { throw new Error('batch must not be touched'); },
    } as AppDb;
    await expect(createNewcomerField(untouchedDb, superAdmin, {
      key: 'story', type: hostileType, required: false, active: true, sort: 8,
      labelEn: 'Story', labelZh: '故事', helpEn: null, helpZh: null, options: [],
    } as never)).rejects.toBeInstanceOf(NewcomerInvalidError);
    expect({ coercions, prepares }).toEqual({ coercions: 0, prepares: 0 });
  });

  it('creates custom statuses and atomically switches the one active open initial', async () => {
    const createdId = await createNewcomerStatus(env.DB, superAdmin, {
      key: 'reviewing', category: 'open', sort: 6, active: true,
      labelEn: 'Reviewing', labelZh: '审核中',
    });
    expect(createdId).toBe(6);
    await updateNewcomerStatus(env.DB, superAdmin, {
      id: createdId, sort: 7, active: true, initialStatusId: createdId,
      labelEn: 'Under review', labelZh: '审核中',
    });
    expect(await env.DB.prepare(`SELECT id,key,category,sort,active,is_initial
      FROM newcomer_statuses WHERE id=?`).bind(createdId).first()).toEqual({
      id: 6, key: 'reviewing', category: 'open', sort: 7, active: 1, is_initial: 1,
    });
    expect(await env.DB.prepare('SELECT is_initial FROM newcomer_statuses WHERE id=1').first('is_initial')).toBe(0);
    expect(await env.DB.prepare("SELECT label FROM newcomer_status_i18n WHERE status_id=6 AND locale='en'").first('label'))
      .toBe('Under review');

    await updateNewcomerStatus(env.DB, superAdmin, {
      id: createdId, sort: 7, active: false, initialStatusId: 1,
      labelEn: 'Under review', labelZh: '审核中',
    });
    expect(await env.DB.prepare('SELECT active,is_initial FROM newcomer_statuses WHERE id=6').first())
      .toEqual({ active: 0, is_initial: 0 });
    expect(await env.DB.prepare('SELECT is_initial FROM newcomer_statuses WHERE id=1').first('is_initial')).toBe(1);
  });

  it('rolls back every status change when the desired final initial is invalid', async () => {
    const before = await env.DB.prepare('SELECT sort,active,is_initial FROM newcomer_statuses WHERE id=1').first();
    await expect(updateNewcomerStatus(env.DB, superAdmin, {
      id: 1, sort: 99, active: false, initialStatusId: 4,
      labelEn: 'Changed label must roll back', labelZh: '必须回滚',
    })).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare('SELECT sort,active,is_initial FROM newcomer_statuses WHERE id=1').first()).toEqual(before);
    expect(await env.DB.prepare("SELECT label FROM newcomer_status_i18n WHERE status_id=1 AND locale='en'").first('label'))
      .toBe('New');
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM newcomer_statuses
      WHERE active=1 AND category='open' AND is_initial=1`).first('n')).toBe(1);
  });

  it('creates and updates bounded custom fields/options while keeping type immutable', async () => {
    const fieldId = await createNewcomerField(env.DB, superAdmin, {
      key: 'connection_path', type: 'select', required: true, active: true, sort: 8,
      labelEn: 'Connection path', labelZh: '连接方式', helpEn: 'Choose one', helpZh: null,
      options: [
        { value: 'group', sort: 1, active: true, labelEn: 'Small group', labelZh: '小组' },
        { value: 'serve', sort: 2, active: true, labelEn: 'Serve', labelZh: '服事' },
      ],
    });
    expect(fieldId).toBe(8);
    await updateNewcomerField(env.DB, superAdmin, {
      id: fieldId, required: false, active: true, sort: 9,
      labelEn: 'Next step', labelZh: '下一步', helpEn: null, helpZh: '请选择',
      options: [{ value: 'group', sort: 2, active: true, labelEn: 'A group', labelZh: '一个小组' }],
    });
    expect(await env.DB.prepare('SELECT key,type,required,active,sort FROM newcomer_fields WHERE id=8').first())
      .toEqual({ key: 'connection_path', type: 'select', required: 0, active: 1, sort: 9 });
    expect((await env.DB.prepare('SELECT value,sort FROM newcomer_field_options WHERE field_id=8 ORDER BY value').all()).results)
      .toEqual([{ value: 'group', sort: 2 }]);
    expect(await env.DB.prepare("SELECT help FROM newcomer_field_i18n WHERE field_id=8 AND locale='zh'").first('help'))
      .toBe('请选择');
  });

  it('allows only labels/help/sort changes for fixed fields and rolls back invalid option replacement', async () => {
    await updateNewcomerField(env.DB, superAdmin, {
      id: 1, required: false, active: true, sort: 20,
      labelEn: 'Full name', labelZh: '完整姓名', helpEn: 'As you prefer', helpZh: null, options: [],
    });
    expect(await env.DB.prepare('SELECT type,required,active,sort,fixed FROM newcomer_fields WHERE id=1').first())
      .toEqual({ type: 'text', required: 0, active: 1, sort: 20, fixed: 1 });
    await expect(updateNewcomerField(env.DB, superAdmin, {
      id: 1, required: true, active: true, sort: 30,
      labelEn: 'Must roll back', labelZh: '必须回滚', helpEn: null, helpZh: null,
      options: [{ value: 'bad', sort: 1, active: true, labelEn: 'Bad', labelZh: '错误' }],
    })).rejects.toBeInstanceOf(NewcomerInvalidError);
    expect(await env.DB.prepare('SELECT required,sort FROM newcomer_fields WHERE id=1').first())
      .toEqual({ required: 0, sort: 20 });
    expect(await env.DB.prepare("SELECT label FROM newcomer_field_i18n WHERE field_id=1 AND locale='en'").first('label'))
      .toBe('Full name');
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
    const config = await listNewcomerAdminConfiguration(env.DB, 'd1', superAdmin, 'zh');
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
    await expect(listNewcomerAdminConfiguration(env.DB, 'd1', superAdmin, 'en'))
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

  it('applies the 1000 total sentinel to active options without hiding bounded inactive options', async () => {
    await env.DB.batch(Array.from({ length: 11 }, (_, fieldIndex) => env.DB.prepare(
      'INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (?,?,?,?,1,?,0)',
    ).bind(200 + fieldIndex, `archived_${fieldIndex}`, 'select', 0, 200 + fieldIndex)));
    const statements = [];
    for (let fieldIndex = 0; fieldIndex < 11; fieldIndex += 1) {
      for (let optionIndex = 0; optionIndex < 100; optionIndex += 1) {
        statements.push(env.DB.prepare(
          'INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (?,?,?,?)',
        ).bind(200 + fieldIndex, `v_${optionIndex}`, optionIndex, optionIndex === 0 ? 1 : 0));
      }
    }
    await env.DB.batch(statements);
    const config = await listNewcomerAdminConfiguration(env.DB, 'd1', superAdmin, 'en');
    expect(config.fields.filter((field) => field.id >= 200)
      .reduce((count, field) => count + field.options.length, 0)).toBe(1_100);
  });
});

describe('newcomer queue, detail, and duplicate hints', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO people (id,display_name,email,phone,deleted_at) VALUES
        (9701,'Live exact','live@example.test','+1 (312) 555-0101',NULL),
        (9702,'Deleted exact','deleted@example.test','+1.312.555.0102','2026-08-01 12:00:00'),
        (9703,'Worker','worker@example.test',NULL,NULL),
        (9704,'Invalid raw','invalid-phone@example.test','+1/312/555/0104',NULL)`),
      env.DB.prepare("INSERT INTO service_types (id,sort) VALUES (9701,1),(9702,2)"),
      env.DB.prepare("INSERT INTO service_type_i18n VALUES (9701,'en','Welcome')"),
      env.DB.prepare("INSERT INTO newcomer_fields VALUES (8,'story','textarea',0,1,8,0)"),
      env.DB.prepare("INSERT INTO newcomer_field_i18n VALUES (8,'en','Story',NULL)"),
      env.DB.prepare(`INSERT INTO newcomer_submissions
        (id,name,email,phone,locale,visit_date,service_type_id,contact_consent_at,source,status_id,
         assignee_person_id,next_follow_up_date,created_at,updated_at)
        VALUES
        ('10000000-0000-4000-8000-000000000001','First','live@example.test',NULL,'en','2026-08-10',9701,
          '2026-08-10 10:00:00','public',1,9703,'2026-08-11','2026-08-10 10:00:00','2026-08-12 10:00:00'),
        ('10000000-0000-4000-8000-000000000002','Second',NULL,'+13125550102','zh','2026-08-11',9702,
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
          'assigned','{"to_assignee_person_id":9703}','2026-08-12 10:02:00')`),
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
      activity: [{ kind: 'assigned', metadata: { to_assignee_person_id: 9703 } }],
    });
    expect(JSON.stringify(detail)).not.toContain('worker@example.test');
    const untranslated = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000002', 'zh',
    );
    expect(untranslated?.submission.serviceLabel).toBe('service-9702');
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

    expect(await findNewcomerDuplicateHints(env.DB, user(), {
      email: null, phone: '+13125550101', excludeSubmissionId: null,
    })).toEqual([{ kind: 'person_live', id: 9701 }]);
    expect(await findNewcomerDuplicateHints(env.DB, user(), {
      email: null, phone: '+13125550104', excludeSubmissionId: null,
    })).toEqual([]);
  });

  it('rejects activity metadata that does not match its activity kind', async () => {
    await env.DB.prepare(`INSERT INTO newcomer_activity
      (id,submission_id,actor_person_id,kind,metadata_json,created_at) VALUES
      ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',9703,
        'assigned','{"status_id":1}','2026-08-12 10:03:00')`).run();
    await expect(getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en',
    )).rejects.toBeInstanceOf(NewcomerPersistenceError);
  });
});
