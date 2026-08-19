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

const dbResult = (results: unknown[]) => ({ results, meta: { changes: 0 } });

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
  return { statuses, fields, results: [dbResult(statuses), dbResult(fields), dbResult([]), dbResult([]), dbResult([])] };
};

const formSnapshot = (field: Record<string, unknown>, options: unknown[] = []) => {
  const { statuses } = configurationSnapshot();
  return [dbResult(statuses), dbResult([field]), dbResult(options), dbResult([]), dbResult([])];
};

const queueDbRow = (overrides: Record<string, unknown> = {}) => ({
  id: '10000000-0000-4000-8000-000000000002', name: 'Safe', email: null, phone: null,
  locale: 'en', visit_date: '2026-08-12', service_type_id: null, service_label: null,
  contact_consent_at: null, source: 'staff', status_id: 1, status_label: 'New',
  assignee_person_id: null, next_follow_up_date: null, version: 0,
  created_at: '2026-08-12 10:00:00', updated_at: '2026-08-12 11:00:00',
  ...overrides,
});

const detailSubmissionRow = () => ({
  ...queueDbRow({ id: '10000000-0000-4000-8000-000000000001' }),
  linked_person_id: null,
  closed_at: null,
});

const detailSnapshot = ({
  answers = [], notes = [], activity = [],
}: { answers?: unknown[]; notes?: unknown[]; activity?: unknown[] } = {}) => [
  dbResult([detailSubmissionRow()]), dbResult(answers), dbResult(notes), dbResult(activity),
];

const fakeReadDb = (results: Array<{ results: unknown[]; meta: { changes: number } }>): AppDb => {
  const statement = {
    bind() { return this; },
    first: async () => null,
    all: async () => results[0],
    run: async () => results[0],
  };
  return { prepare: () => statement, batch: async () => results } as unknown as AppDb;
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

  it('requires active custom form fields and never reads accessor/proxy-backed field values', async () => {
    const inactiveField = {
      id: 8, key: 'private_field', type: 'text', required: 0, active: 0, sort: 8, fixed: 0,
      label: 'PRIVATE INACTIVE LABEL', help: null,
    };
    const inactiveError = await listNewcomerFormDefinition(
      fakeReadDb(formSnapshot(inactiveField)), 'd1', 'en',
    ).catch((caught: unknown) => caught);
    expect(inactiveError).toBeInstanceOf(NewcomerPersistenceError);
    expect(inactiveError).toMatchObject({ code: 'newcomer_failed' });
    expect(String(inactiveError)).not.toContain('PRIVATE INACTIVE LABEL');

    const inactiveOptionError = await listNewcomerFormDefinition(fakeReadDb(formSnapshot({
      id: 8, key: 'private_select', type: 'select', required: 0, active: 1, sort: 8, fixed: 0,
      label: 'Safe select', help: null,
    }, [{ field_id: 8, value: 'private_option', sort: 1, active: 0, label: 'PRIVATE OPTION LABEL' }])), 'd1', 'en')
      .catch((caught: unknown) => caught);
    expect(inactiveOptionError).toMatchObject({ code: 'newcomer_failed' });
    expect(String(inactiveOptionError)).not.toContain('PRIVATE OPTION LABEL');

    let getterReads = 0;
    const accessorField = {
      id: 8, key: 'accessor_field', type: 'text', required: 0, active: 1, sort: 8, fixed: 0,
      help: null,
    } as Record<string, unknown>;
    Object.defineProperty(accessorField, 'label', {
      enumerable: true,
      get() { getterReads += 1; return 'PRIVATE GETTER LABEL'; },
    });
    const accessorError = await listNewcomerFormDefinition(
      fakeReadDb(formSnapshot(accessorField)), 'd1', 'en',
    ).catch((caught: unknown) => caught);
    expect(accessorError).toBeInstanceOf(NewcomerPersistenceError);
    expect(String(accessorError)).not.toContain('PRIVATE GETTER LABEL');
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxyField = new Proxy({
      id: 8, key: 'proxy_field', type: 'text', required: 0, active: 1, sort: 8, fixed: 0,
      label: 'Safe proxy label', help: null,
    }, {
      get() { proxyReads += 1; return 'PRIVATE PROXY VALUE'; },
      ownKeys() { throw new Error('PRIVATE PROXY VALUE'); },
    });
    const proxyError = await listNewcomerFormDefinition(
      fakeReadDb(formSnapshot(proxyField)), 'd1', 'en',
    ).catch((caught: unknown) => caught);
    expect(proxyError).toBeInstanceOf(NewcomerPersistenceError);
    expect(String(proxyError)).not.toContain('PRIVATE PROXY VALUE');
    expect(proxyReads).toBe(0);
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
    await env.DB.prepare(`INSERT INTO newcomer_submissions
      (id,name,locale,visit_date,source) VALUES
      ('40000000-0000-4000-8000-000000000001','Historical answer','en','2026-08-12','staff')`).run();
    await env.DB.prepare(`INSERT INTO newcomer_answers (submission_id,field_id,value) VALUES
      ('40000000-0000-4000-8000-000000000001',?,'serve')`).bind(fieldId).run();
    await updateNewcomerField(env.DB, superAdmin, {
      id: fieldId, required: false, active: true, sort: 9,
      labelEn: 'Next step', labelZh: '下一步', helpEn: null, helpZh: '请选择',
      options: [{ value: 'group', sort: 2, active: true, labelEn: 'A group', labelZh: '一个小组' }],
    });
    expect(await env.DB.prepare('SELECT key,type,required,active,sort FROM newcomer_fields WHERE id=8').first())
      .toEqual({ key: 'connection_path', type: 'select', required: 0, active: 1, sort: 9 });
    expect((await env.DB.prepare('SELECT value,sort,active FROM newcomer_field_options WHERE field_id=8 ORDER BY value').all()).results)
      .toEqual([{ value: 'group', sort: 2, active: 1 }, { value: 'serve', sort: 2, active: 1 }]);
    expect(await env.DB.prepare(`SELECT label FROM newcomer_field_option_i18n
      WHERE field_id=8 AND value='serve' AND locale='zh'`).first('label')).toBe('服事');
    expect(await env.DB.prepare(`SELECT value FROM newcomer_answers
      WHERE submission_id='40000000-0000-4000-8000-000000000001' AND field_id=8`).first('value')).toBe('serve');
    expect(await env.DB.prepare("SELECT help FROM newcomer_field_i18n WHERE field_id=8 AND locale='zh'").first('help'))
      .toBe('请选择');

    await updateNewcomerField(env.DB, superAdmin, {
      id: fieldId, required: false, active: true, sort: 9,
      labelEn: 'Next step', labelZh: '下一步', helpEn: null, helpZh: '请选择',
      options: [{ value: 'serve', sort: 3, active: false, labelEn: 'Archived serve', labelZh: '已停用服事' }],
    });
    expect((await env.DB.prepare('SELECT value,sort,active FROM newcomer_field_options WHERE field_id=8 ORDER BY value').all()).results)
      .toEqual([{ value: 'group', sort: 2, active: 1 }, { value: 'serve', sort: 3, active: 0 }]);
    expect(await env.DB.prepare(`SELECT label FROM newcomer_field_option_i18n
      WHERE field_id=8 AND value='serve' AND locale='zh'`).first('label')).toBe('已停用服事');
    expect(await env.DB.prepare(`SELECT value FROM newcomer_answers
      WHERE submission_id='40000000-0000-4000-8000-000000000001' AND field_id=8`).first('value')).toBe('serve');
  });

  it('rolls back labels and option upserts when the merged option set exceeds 100', async () => {
    const options = Array.from({ length: 100 }, (_, index) => ({
      value: `v_${index}`, sort: index, active: index === 0,
      labelEn: `Value ${index}`, labelZh: `值 ${index}`,
    }));
    const fieldId = await createNewcomerField(env.DB, superAdmin, {
      key: 'bounded_select', type: 'select', required: false, active: true, sort: 8,
      labelEn: 'Bounded select', labelZh: '有界选项', helpEn: null, helpZh: null, options,
    });
    await expect(updateNewcomerField(env.DB, superAdmin, {
      id: fieldId, required: false, active: true, sort: 99,
      labelEn: 'Must roll back', labelZh: '必须回滚', helpEn: null, helpZh: null,
      options: [{ value: 'new_value', sort: 100, active: true, labelEn: 'New', labelZh: '新' }],
    })).rejects.toBeInstanceOf(NewcomerConflictError);
    expect(await env.DB.prepare('SELECT sort FROM newcomer_fields WHERE id=?').bind(fieldId).first('sort')).toBe(8);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_field_options WHERE field_id=?').bind(fieldId).first('n')).toBe(100);
    expect(await env.DB.prepare("SELECT label FROM newcomer_field_i18n WHERE field_id=? AND locale='en'")
      .bind(fieldId).first('label')).toBe('Bounded select');
  });

  it('rolls back every write when an unchanged non-select field rejects submitted options', async () => {
    const fieldId = await createNewcomerField(env.DB, superAdmin, {
      key: 'plain_story', type: 'textarea', required: false, active: true, sort: 8,
      labelEn: 'Story', labelZh: '故事', helpEn: 'Original help', helpZh: null, options: [],
    });
    const before = {
      field: await env.DB.prepare('SELECT required,active,sort,type,fixed FROM newcomer_fields WHERE id=?')
        .bind(fieldId).first(),
      i18n: (await env.DB.prepare('SELECT locale,label,help FROM newcomer_field_i18n WHERE field_id=? ORDER BY locale')
        .bind(fieldId).all()).results,
      options: (await env.DB.prepare('SELECT value,sort,active FROM newcomer_field_options WHERE field_id=? ORDER BY value')
        .bind(fieldId).all()).results,
    };
    const error = await updateNewcomerField(env.DB, superAdmin, {
      id: fieldId, required: false, active: true, sort: 8,
      labelEn: 'PRIVATE CHANGED LABEL', labelZh: '私密变更', helpEn: 'PRIVATE CHANGED HELP', helpZh: null,
      options: [{ value: 'invalid_for_textarea', sort: 1, active: true, labelEn: 'Bad', labelZh: '错误' }],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NewcomerConflictError);
    expect(String(error)).not.toContain('PRIVATE CHANGED');
    expect({
      field: await env.DB.prepare('SELECT required,active,sort,type,fixed FROM newcomer_fields WHERE id=?')
        .bind(fieldId).first(),
      i18n: (await env.DB.prepare('SELECT locale,label,help FROM newcomer_field_i18n WHERE field_id=? ORDER BY locale')
        .bind(fieldId).all()).results,
      options: (await env.DB.prepare('SELECT value,sort,active FROM newcomer_field_options WHERE field_id=? ORDER BY value')
        .bind(fieldId).all()).results,
    }).toEqual(before);
  });

  it('does not partially add missing translations when create capacity guards reject', async () => {
    await env.DB.batch(Array.from({ length: 95 }, (_, index) => env.DB.prepare(
      'INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (?,?,?,?,1,0)',
    ).bind(100 + index, `full_status_${index}`, 'open', 100 + index)));
    await expect(createNewcomerStatus(env.DB, superAdmin, {
      key: 'full_status_94', category: 'open', sort: 194, active: true,
      labelEn: 'Must not persist', labelZh: '不得保存',
    })).rejects.toBeInstanceOf(Error);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_status_i18n WHERE status_id=194').first('n')).toBe(0);

    await env.DB.batch(Array.from({ length: 100 }, (_, index) => env.DB.prepare(
      'INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (?,?,\'text\',0,1,?,0)',
    ).bind(100 + index, `full_field_${index}`, 100 + index)));
    await expect(createNewcomerField(env.DB, superAdmin, {
      key: 'full_field_99', type: 'text', required: false, active: true, sort: 199,
      labelEn: 'Must not persist', labelZh: '不得保存', helpEn: null, helpZh: null, options: [],
    })).rejects.toBeInstanceOf(Error);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM newcomer_field_i18n WHERE field_id=199').first('n')).toBe(0);
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
      env.DB.prepare("INSERT INTO service_type_i18n (service_type_id,locale,name) VALUES (9701,'en','Welcome Service')"),
      env.DB.prepare("INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial) VALUES (6,'awaiting_host','open',6,1,0)"),
      env.DB.prepare("INSERT INTO newcomer_status_i18n (status_id,locale,label) VALUES (6,'en','Awaiting host')"),
      env.DB.prepare("INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (8,'connection_path','select',1,1,8,0)"),
      env.DB.prepare("INSERT INTO newcomer_field_i18n (field_id,locale,label,help) VALUES (8,'en','Connection path',NULL)"),
      env.DB.prepare("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (8,'group',1,1)"),
      env.DB.prepare("INSERT INTO newcomer_field_options (field_id,value,sort,active) VALUES (8,'serve',2,1)"),
      env.DB.prepare("INSERT INTO newcomer_field_option_i18n (field_id,value,locale,label) VALUES (8,'group','en','Small group')"),
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
      env.DB.prepare("INSERT INTO service_type_i18n (service_type_id,locale,name) VALUES (9701,'en','Welcome')"),
      env.DB.prepare("INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed) VALUES (8,'story','textarea',0,1,8,0)"),
      env.DB.prepare("INSERT INTO newcomer_field_i18n (field_id,locale,label,help) VALUES (8,'en','Story',NULL)"),
      env.DB.prepare(`INSERT INTO newcomer_submissions
        (id,name,email,phone,locale,visit_date,service_type_id,contact_consent_at,source,status_id,
         assignee_person_id,next_follow_up_date,created_at,updated_at)
        VALUES
        ('10000000-0000-4000-8000-000000000001','First','live@example.test',NULL,'en','2026-08-10',9701,
          '2026-08-10 10:00:00','public',1,9703,'2026-08-11','2026-08-10 10:00:00','2026-08-12 10:00:00'),
        ('10000000-0000-4000-8000-000000000002','Second',NULL,'+13125550102','zh','2026-08-11',9702,
          NULL,'staff',2,NULL,NULL,'2026-08-11 10:00:00','2026-08-12 11:00:00')`),
      env.DB.prepare(`INSERT INTO newcomer_answers (submission_id,field_id,value) VALUES
        ('10000000-0000-4000-8000-000000000001',8,'Private answer')`),
      env.DB.prepare(`INSERT INTO newcomer_notes
        (id,submission_id,author_person_id,body,created_at) VALUES
        ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',9703,
          'Private note','2026-08-12 10:01:00')`),
      env.DB.prepare(`INSERT INTO newcomer_activity
        (id,submission_id,actor_person_id,kind,metadata_json,operation_id,result_version,created_at) VALUES
        ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',9703,
          'assigned','{"to_assignee_person_id":9703}','30100000-0000-4000-8000-000000000001',1,
          '2026-08-12 10:02:00')`),
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
      notes: {
        items: [{ authorPersonId: 9703, body: 'Private note' }], hasNext: false,
        nextCursor: { createdAt: '2026-08-12 10:01:00', id: '20000000-0000-4000-8000-000000000001' },
      },
      activity: {
        items: [{ kind: 'assigned', metadata: { to_assignee_person_id: 9703 } }], hasNext: false,
        nextCursor: { createdAt: '2026-08-12 10:02:00', id: '30000000-0000-4000-8000-000000000001' },
      },
    });
    expect(JSON.stringify(detail)).not.toContain('worker@example.test');
    expect(JSON.stringify(detail)).not.toContain('30100000-0000-4000-8000-000000000001');
    expect(Object.keys(detail!.activity.items[0])).toEqual([
      'id', 'actorPersonId', 'kind', 'metadata', 'createdAt',
    ]);
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

  it.each([
    ['malformed sentinel row', [
      queueDbRow(),
      queueDbRow({ id: '10000000-0000-4000-8000-000000000001', email: 'PRIVATE SENTINEL' }),
    ], 1],
    ['duplicate submission identity', [
      queueDbRow(),
      queueDbRow({ updated_at: '2026-08-12 10:00:00' }),
    ], 2],
    ['ascending update time', [
      queueDbRow({ id: '10000000-0000-4000-8000-000000000001', updated_at: '2026-08-12 10:00:00' }),
      queueDbRow({ updated_at: '2026-08-12 11:00:00' }),
    ], 2],
    ['ascending id at equal update time', [
      queueDbRow({ id: '10000000-0000-4000-8000-000000000001' }),
      queueDbRow({ id: '10000000-0000-4000-8000-000000000002' }),
    ], 2],
  ])('rejects %s before slicing or returning queue rows', async (_name, rows, limit) => {
    const error = await listNewcomerQueue(
      fakeReadDb([dbResult(rows)]), user(), 'en', { page: 1, limit }, '2026-08-12',
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NewcomerPersistenceError);
    expect(String(error)).not.toContain('PRIVATE SENTINEL');
  });

  it('captures exact queue filters once before SQL and rejects hostile descriptors', async () => {
    let getterReads = 0;
    let prepares = 0;
    const accessorFilters = { limit: 25 } as Record<string, unknown>;
    Object.defineProperty(accessorFilters, 'page', {
      enumerable: true,
      get() { getterReads += 1; return 1; },
    });
    const untouchedDb = {
      prepare() { prepares += 1; throw new Error('SQL must not be prepared'); },
      batch() { throw new Error('batch must not run'); },
    } as AppDb;
    await expect(listNewcomerQueue(
      untouchedDb, user(), 'en', accessorFilters as never, '2026-08-12',
    )).rejects.toBeInstanceOf(NewcomerInvalidError);
    expect({ getterReads, prepares }).toEqual({ getterReads: 0, prepares: 0 });

    let proxyGets = 0;
    const proxyFilters = new Proxy({ page: 1, limit: 25 }, {
      get() { proxyGets += 1; return 1; },
      ownKeys() { throw new Error('PRIVATE FILTER VALUE'); },
    });
    const proxyError = await listNewcomerQueue(
      untouchedDb, user(), 'en', proxyFilters, '2026-08-12',
    ).catch((caught: unknown) => caught);
    expect(proxyError).toBeInstanceOf(NewcomerInvalidError);
    expect(String(proxyError)).not.toContain('PRIVATE FILTER VALUE');
    expect({ proxyGets, prepares }).toEqual({ proxyGets: 0, prepares: 0 });

    await expect(listNewcomerQueue(
      untouchedDb, user(), 'en', { page: 1, limit: 25, unknown: 'PRIVATE' } as never, '2026-08-12',
    )).rejects.toBeInstanceOf(NewcomerInvalidError);
    expect(prepares).toBe(0);
  });

  it('binds and returns only detached queue filter scalars within the fixed bind cap', async () => {
    let bound: unknown[] = [];
    const filters = {
      statusId: 1, assigneePersonId: 9703, due: 'overdue' as const,
      visitFrom: '2026-08-01', visitTo: '2026-08-31', serviceTypeId: 9701,
      source: 'public' as const, page: 2, limit: 10,
    };
    const result = dbResult([]);
    const statement = {
      bind(...values: unknown[]) { bound = values; return this; },
      async all() { filters.page = 99; filters.limit = 99; return result; },
      async first() { return null; }, async run() { return result; },
    };
    const page = await listNewcomerQueue(
      { prepare: () => statement, batch: async () => [] } as unknown as AppDb,
      user(), 'en', filters, '2026-08-12',
    );
    expect(page).toEqual({ rows: [], page: 2, limit: 10, hasNext: false });
    expect(bound).toHaveLength(10);
    expect(bound.slice(-2)).toEqual([11, 10]);
  });

  it.each([
    ['duplicate identity', [
      { kind_order: 1, kind: 'person_live', record_id: '9701', status_id: null },
      { kind_order: 1, kind: 'person_live', record_id: '9701', status_id: null },
    ]],
    ['descending record order', [
      { kind_order: 1, kind: 'person_live', record_id: '9702', status_id: null },
      { kind_order: 1, kind: 'person_live', record_id: '9701', status_id: null },
    ]],
    ['descending kind order', [
      { kind_order: 2, kind: 'person_deleted', record_id: '9701', status_id: null },
      { kind_order: 1, kind: 'person_live', record_id: '9702', status_id: null },
    ]],
  ])('rejects duplicate hints with %s', async (_name, rows) => {
    await expect(findNewcomerDuplicateHints(fakeReadDb([dbResult(rows)]), user(), {
      email: 'live@example.test', phone: null, excludeSubmissionId: null,
    })).rejects.toBeInstanceOf(NewcomerPersistenceError);
  });

  it('allows the same duplicate record id across distinct ordered kinds', async () => {
    await expect(findNewcomerDuplicateHints(fakeReadDb([dbResult([
      { kind_order: 1, kind: 'person_live', record_id: '9701', status_id: null },
      { kind_order: 2, kind: 'person_deleted', record_id: '9701', status_id: null },
    ])]), user(), {
      email: 'live@example.test', phone: null, excludeSubmissionId: null,
    })).resolves.toEqual([
      { kind: 'person_live', id: 9701 },
      { kind: 'person_deleted', id: 9701 },
    ]);
  });

  it('decodes answer sort keys but returns only the stable answer DTO', async () => {
    const detail = await getNewcomerDetail(fakeReadDb(detailSnapshot({ answers: [
      { field_id: 8, field_sort: 8, field_label: 'First field', value: 'First answer' },
      { field_id: 9, field_sort: 9, field_label: 'Second field', value: 'Second answer' },
    ] })), 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en');
    expect(detail?.answers).toEqual([
      { fieldId: 8, fieldLabel: 'First field', value: 'First answer' },
      { fieldId: 9, fieldLabel: 'Second field', value: 'Second answer' },
    ]);
    expect(JSON.stringify(detail?.answers)).not.toContain('field_sort');
  });

  it('rejects out-of-order answers, notes, and activity without reordering them', async () => {
    await expect(getNewcomerDetail(fakeReadDb(detailSnapshot({ answers: [
      { field_id: 9, field_sort: 8, field_label: 'Second', value: 'Second' },
      { field_id: 8, field_sort: 8, field_label: 'First', value: 'First' },
    ] })), 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en'))
      .rejects.toBeInstanceOf(NewcomerPersistenceError);

    await expect(getNewcomerDetail(fakeReadDb(detailSnapshot({ notes: [
      { id: '20000000-0000-4000-8000-000000000001', author_person_id: 9701, body: 'Earlier', created_at: '2026-08-12 10:00:00' },
      { id: '20000000-0000-4000-8000-000000000002', author_person_id: 9701, body: 'Later', created_at: '2026-08-12 11:00:00' },
    ] })), 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en'))
      .rejects.toBeInstanceOf(NewcomerPersistenceError);

    await expect(getNewcomerDetail(fakeReadDb(detailSnapshot({ activity: [
      { id: '30000000-0000-4000-8000-000000000001', actor_person_id: null, kind: 'submission_created', metadata_json: '{}', created_at: '2026-08-12 10:00:00' },
      { id: '30000000-0000-4000-8000-000000000002', actor_person_id: null, kind: 'submission_created', metadata_json: '{}', created_at: '2026-08-12 11:00:00' },
    ] })), 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en'))
      .rejects.toBeInstanceOf(NewcomerPersistenceError);
  });

  it('rejects duplicate answer, note, and activity identities', async () => {
    await expect(getNewcomerDetail(fakeReadDb(detailSnapshot({ answers: [
      { field_id: 8, field_sort: 8, field_label: 'First', value: 'One' },
      { field_id: 8, field_sort: 9, field_label: 'First', value: 'Two' },
    ] })), 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en'))
      .rejects.toBeInstanceOf(NewcomerPersistenceError);

    await expect(getNewcomerDetail(fakeReadDb(detailSnapshot({ notes: [
      { id: '20000000-0000-4000-8000-000000000001', author_person_id: 9701, body: 'One', created_at: '2026-08-12 10:00:00' },
      { id: '20000000-0000-4000-8000-000000000001', author_person_id: 9701, body: 'Two', created_at: '2026-08-12 11:00:00' },
    ] })), 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en'))
      .rejects.toBeInstanceOf(NewcomerPersistenceError);

    await expect(getNewcomerDetail(fakeReadDb(detailSnapshot({ activity: [
      { id: '30000000-0000-4000-8000-000000000001', actor_person_id: null, kind: 'submission_created', metadata_json: '{}', created_at: '2026-08-12 10:00:00' },
      { id: '30000000-0000-4000-8000-000000000001', actor_person_id: null, kind: 'submission_created', metadata_json: '{}', created_at: '2026-08-12 11:00:00' },
    ] })), 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en'))
      .rejects.toBeInstanceOf(NewcomerPersistenceError);
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

  it('rejects hostile history input before SQL without invoking getters or proxies', async () => {
    let getterReads = 0;
    let prepares = 0;
    const history = {} as Record<string, unknown>;
    Object.defineProperty(history, 'limit', {
      enumerable: true,
      get() { getterReads += 1; return 25; },
    });
    const untouchedDb = {
      prepare() { prepares += 1; throw new Error('SQL must not be prepared'); },
      batch() { throw new Error('batch must not run'); },
    } as AppDb;
    await expect(getNewcomerDetail(
      untouchedDb, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', history as never,
    )).rejects.toBeInstanceOf(NewcomerInvalidError);
    expect({ getterReads, prepares }).toEqual({ getterReads: 0, prepares: 0 });

    let proxyGets = 0;
    const proxyHistory = new Proxy({ limit: 25 }, {
      get() { proxyGets += 1; return 25; },
      ownKeys() { throw new Error('PRIVATE HISTORY VALUE'); },
    });
    const proxyError = await getNewcomerDetail(
      untouchedDb, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', proxyHistory,
    ).catch((caught: unknown) => caught);
    expect(proxyError).toBeInstanceOf(NewcomerInvalidError);
    expect(String(proxyError)).not.toContain('PRIVATE HISTORY VALUE');
    expect({ proxyGets, prepares }).toEqual({ proxyGets: 0, prepares: 0 });

    let cursorGetterReads = 0;
    const cursor = { id: '20000000-0000-4000-8000-000000000001' } as Record<string, unknown>;
    Object.defineProperty(cursor, 'createdAt', {
      enumerable: true,
      get() { cursorGetterReads += 1; return '2026-08-12 10:00:00'; },
    });
    await expect(getNewcomerDetail(
      untouchedDb, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en',
      { limit: 25, noteCursor: cursor as never },
    )).rejects.toBeInstanceOf(NewcomerInvalidError);
    expect({ cursorGetterReads, prepares }).toEqual({ cursorGetterReads: 0, prepares: 0 });

    await expect(getNewcomerDetail(
      untouchedDb, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en',
      { limit: 101 },
    )).rejects.toBeInstanceOf(NewcomerInvalidError);
    expect(prepares).toBe(0);
  });

  it('paginates note and activity history by strict descending tuple without duplicates', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO newcomer_notes (id,submission_id,author_person_id,body,created_at) VALUES
        ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',9703,
          'Second note','2026-08-12 10:01:00')`),
      env.DB.prepare(`INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind,metadata_json,created_at) VALUES
        ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',9703,
          'submission_created','{}','2026-08-12 10:02:00')`),
    ]);
    const first = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', { limit: 1 },
    );
    expect(first?.notes).toEqual({
      items: [expect.objectContaining({ id: '20000000-0000-4000-8000-000000000002' })],
      hasNext: true,
      nextCursor: { createdAt: '2026-08-12 10:01:00', id: '20000000-0000-4000-8000-000000000002' },
    });
    expect(first?.activity).toEqual({
      items: [expect.objectContaining({ id: '30000000-0000-4000-8000-000000000002' })],
      hasNext: true,
      nextCursor: { createdAt: '2026-08-12 10:02:00', id: '30000000-0000-4000-8000-000000000002' },
    });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO newcomer_notes (id,submission_id,author_person_id,body,created_at) VALUES
        ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',9703,
          'New after page one','2026-08-12 10:01:00')`),
      env.DB.prepare(`INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind,metadata_json,created_at) VALUES
        ('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',9703,
          'submission_created','{}','2026-08-12 10:02:00')`),
    ]);
    const second = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', {
        limit: 1,
        noteCursor: first?.notes.nextCursor ?? undefined,
        activityCursor: first?.activity.nextCursor ?? undefined,
      },
    );
    expect(second?.notes.items.map((item) => item.id)).toEqual(['20000000-0000-4000-8000-000000000001']);
    expect(second?.activity.items.map((item) => item.id)).toEqual(['30000000-0000-4000-8000-000000000001']);
    const refreshed = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', { limit: 1 },
    );
    expect(refreshed?.notes.items[0].id).toBe('20000000-0000-4000-8000-000000000003');
    expect(refreshed?.activity.items[0].id).toBe('30000000-0000-4000-8000-000000000003');
    const stale = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', {
        limit: 1,
        noteCursor: { createdAt: '2026-08-12 10:01:00', id: '20000001-0000-4000-8000-000000000000' },
        activityCursor: { createdAt: '2026-08-12 10:02:00', id: '30000001-0000-4000-8000-000000000000' },
      },
    );
    expect(stale?.notes.items[0].id).toBe('20000000-0000-4000-8000-000000000003');
    expect(stale?.activity.items[0].id).toBe('30000000-0000-4000-8000-000000000003');
  });

  it('keeps a terminal note cursor while activity continues across three pages', async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind,metadata_json,created_at) VALUES
        ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',NULL,
          'submission_created','{}','2026-08-12 10:03:00'),
        ('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',NULL,
          'submission_created','{}','2026-08-12 10:04:00')`),
    ]);
    const first = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', { limit: 1 },
    );
    expect(first?.notes.hasNext).toBe(false);
    expect(first?.notes.nextCursor).toEqual({
      createdAt: '2026-08-12 10:01:00', id: '20000000-0000-4000-8000-000000000001',
    });
    expect(first?.activity.hasNext).toBe(true);
    const noteCursor = { ...first!.notes.nextCursor! };
    const activityCursor = { ...first!.activity.nextCursor! };
    const second = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', {
        limit: 1,
        noteCursor,
        activityCursor,
      },
    );
    expect(second?.notes.items).toEqual([]);
    expect(second?.notes.nextCursor).toEqual(noteCursor);
    expect(second?.notes.nextCursor).not.toBe(noteCursor);
    expect(second?.activity.items.map((item) => item.id)).toEqual(['30000000-0000-4000-8000-000000000002']);
    noteCursor.id = '99999999-0000-4000-8000-000000000999';
    expect(second?.notes.nextCursor).toEqual({
      createdAt: '2026-08-12 10:01:00', id: '20000000-0000-4000-8000-000000000001',
    });
    const third = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', {
        limit: 1,
        noteCursor: second!.notes.nextCursor!,
        activityCursor: second!.activity.nextCursor!,
      },
    );
    expect(third?.notes).toEqual({
      items: [], hasNext: false,
      nextCursor: { createdAt: '2026-08-12 10:01:00', id: '20000000-0000-4000-8000-000000000001' },
    });
    expect(third?.activity).toEqual({
      items: [expect.objectContaining({ id: '30000000-0000-4000-8000-000000000001' })],
      hasNext: false,
      nextCursor: { createdAt: '2026-08-12 10:02:00', id: '30000000-0000-4000-8000-000000000001' },
    });
  });

  it('keeps a terminal activity cursor while notes continue across three pages', async () => {
    await env.DB.prepare(`INSERT INTO newcomer_notes (id,submission_id,author_person_id,body,created_at) VALUES
      ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',9703,
        'Second note','2026-08-12 10:03:00'),
      ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',9703,
        'Third note','2026-08-12 10:04:00')`).run();
    const first = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', { limit: 1 },
    );
    expect(first?.notes.items.map((item) => item.id)).toEqual(['20000000-0000-4000-8000-000000000003']);
    expect(first?.activity.hasNext).toBe(false);
    const second = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', {
        limit: 1,
        noteCursor: first!.notes.nextCursor!,
        activityCursor: first!.activity.nextCursor!,
      },
    );
    expect(second?.notes.items.map((item) => item.id)).toEqual(['20000000-0000-4000-8000-000000000002']);
    expect(second?.activity).toEqual({
      items: [], hasNext: false,
      nextCursor: { createdAt: '2026-08-12 10:02:00', id: '30000000-0000-4000-8000-000000000001' },
    });
    const third = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', {
        limit: 1,
        noteCursor: second!.notes.nextCursor!,
        activityCursor: second!.activity.nextCursor!,
      },
    );
    expect(third?.notes).toEqual({
      items: [expect.objectContaining({ id: '20000000-0000-4000-8000-000000000001' })],
      hasNext: false,
      nextCursor: { createdAt: '2026-08-12 10:01:00', id: '20000000-0000-4000-8000-000000000001' },
    });
    expect(third?.activity).toEqual({
      items: [], hasNext: false,
      nextCursor: { createdAt: '2026-08-12 10:02:00', id: '30000000-0000-4000-8000-000000000001' },
    });
  });

  it('returns null for an empty first page and preserves detached stale cursors', async () => {
    const empty = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000002', 'en', { limit: 1 },
    );
    expect(empty?.notes).toEqual({ items: [], hasNext: false, nextCursor: null });
    expect(empty?.activity).toEqual({ items: [], hasNext: false, nextCursor: null });

    const noteCursor = {
      createdAt: '2020-01-01 00:00:00', id: '40000000-0000-4000-8000-000000000001',
    };
    const activityCursor = {
      createdAt: '2020-01-01 00:00:00', id: '40000000-0000-4000-8000-000000000002',
    };
    const stale = await getNewcomerDetail(
      env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', {
        limit: 1, noteCursor, activityCursor,
      },
    );
    expect(stale?.notes).toEqual({ items: [], hasNext: false, nextCursor: noteCursor });
    expect(stale?.activity).toEqual({ items: [], hasNext: false, nextCursor: activityCursor });
    expect(stale?.notes.nextCursor).not.toBe(noteCursor);
    expect(stale?.activity.nextCursor).not.toBe(activityCursor);
    noteCursor.id = '99999999-0000-4000-8000-000000000001';
    activityCursor.id = '99999999-0000-4000-8000-000000000002';
    expect(stale?.notes.nextCursor?.id).toBe('40000000-0000-4000-8000-000000000001');
    expect(stale?.activity.nextCursor?.id).toBe('40000000-0000-4000-8000-000000000002');
  });

  it('uses bounded 101-row history queries and safely applies a stale tuple cursor', async () => {
    const notes = Array.from({ length: 101 }, (_, index) => {
      const value = 101 - index;
      const hex = value.toString(16).padStart(8, '0');
      return {
        id: `${hex}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`,
        author_person_id: 9701,
        body: 'x'.repeat(10_000),
        created_at: '2026-08-11 09:00:00',
      };
    });
    const statements: Array<{ sql: string; binds: unknown[] }> = [];
    const results = detailSnapshot({ notes });
    let prepared = 0;
    const db = {
      prepare(sql: string) {
        const recorded = { sql, binds: [] as unknown[] };
        statements.push(recorded);
        prepared += 1;
        return {
          bind(...values: unknown[]) { recorded.binds = values; return this; },
          async first() { return null; }, async all() { return results[0]; }, async run() { return results[0]; },
        };
      },
      async batch() { return results; },
    } as unknown as AppDb;
    const detail = await getNewcomerDetail(
      db, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', {
        limit: 100,
        noteCursor: { createdAt: '2026-08-12 12:00:00', id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      },
    );
    expect(prepared).toBe(4);
    expect(statements[2].sql).toMatch(/ORDER BY created_at DESC,id DESC LIMIT \?/);
    expect(statements[2].binds).toEqual([
      '10000000-0000-4000-8000-000000000001',
      '2026-08-12 12:00:00', '2026-08-12 12:00:00', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 101,
    ]);
    expect(statements[3].binds.at(-1)).toBe(101);
    expect(new TextEncoder().encode(JSON.stringify(notes)).byteLength).toBeLessThan(1_048_576);
    expect(detail?.notes.items).toHaveLength(100);
    expect(detail?.notes.hasNext).toBe(true);
  });

  it('fails closed on accessor-backed history rows without invoking their getter', async () => {
    let getterReads = 0;
    const note = {
      id: '20000000-0000-4000-8000-000000000001', author_person_id: 9701,
      created_at: '2026-08-12 10:00:00',
    } as Record<string, unknown>;
    Object.defineProperty(note, 'body', {
      enumerable: true,
      get() { getterReads += 1; return 'PRIVATE HISTORY BODY'; },
    });
    const error = await getNewcomerDetail(
      fakeReadDb(detailSnapshot({ notes: [note] })), 'd1', user(),
      '10000000-0000-4000-8000-000000000001', 'en',
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NewcomerPersistenceError);
    expect(String(error)).not.toContain('PRIVATE HISTORY BODY');
    expect(getterReads).toBe(0);
  });

  it('traverses 5001 small note/activity rows and bounds every history query to 101 rows', async () => {
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<5001)
        INSERT INTO newcomer_notes (id,submission_id,author_person_id,body,created_at)
        SELECT printf('%08x-0000-4000-8000-%012x',n,n),
          '10000000-0000-4000-8000-000000000001',9703,'n','2026-08-11 09:00:00' FROM seq`),
      env.DB.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<5001)
        INSERT INTO newcomer_activity (id,submission_id,actor_person_id,kind,metadata_json,created_at)
        SELECT printf('%08x-0000-4000-8000-%012x',n+65536,n),
          '10000000-0000-4000-8000-000000000001',NULL,'submission_created','{}','2026-08-11 09:00:00' FROM seq`),
    ]);
    const noteIds = new Set<string>();
    const activityIds = new Set<string>();
    let noteCursor: { createdAt: string; id: string } | undefined;
    let activityCursor: { createdAt: string; id: string } | undefined;
    do {
      const detail = await getNewcomerDetail(
        env.DB, 'd1', user(), '10000000-0000-4000-8000-000000000001', 'en', {
          limit: 100, noteCursor, activityCursor,
        },
      );
      expect(detail).not.toBeNull();
      for (const note of detail!.notes.items) expect(noteIds.has(note.id)).toBe(false), noteIds.add(note.id);
      for (const item of detail!.activity.items) expect(activityIds.has(item.id)).toBe(false), activityIds.add(item.id);
      noteCursor = detail!.notes.nextCursor ?? undefined;
      activityCursor = detail!.activity.nextCursor ?? undefined;
      if (!detail!.notes.hasNext && !detail!.activity.hasNext) break;
    } while (true);
    expect(noteIds.size).toBe(5002);
    expect(activityIds.size).toBe(5002);
  });
});
