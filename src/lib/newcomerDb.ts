import { readSnapshotBatch, type AppDb, type AppDbResult, type SnapshotBackend } from './appDb';
import { hasAreaAccess } from './adminAreas';
import { isValidDateStr } from './dates';
import { normalizeNewcomerEmail, normalizeNewcomerPhone, type NewcomerFieldType, type NewcomerQueueFilters } from './newcomerValidation';
import type { SessionUser } from './types';

export class NewcomerInvalidError extends Error {
  readonly code = 'newcomer_invalid' as const;
  constructor() { super('Newcomer input is invalid'); this.name = 'NewcomerInvalidError'; }
}

export class NewcomerForbiddenError extends Error {
  readonly code = 'newcomer_forbidden' as const;
  constructor() { super('Newcomer access is forbidden'); this.name = 'NewcomerForbiddenError'; }
}

export class NewcomerLimitError extends Error {
  readonly code = 'newcomer_limit' as const;
  constructor() { super('Newcomer result exceeds its safe limit'); this.name = 'NewcomerLimitError'; }
}

export class NewcomerConflictError extends Error {
  readonly code = 'newcomer_conflict' as const;
  constructor() { super('Newcomer data conflicts with current state'); this.name = 'NewcomerConflictError'; }
}

export class NewcomerPersistenceError extends Error {
  readonly code = 'newcomer_failed' as const;
  constructor() { super('Newcomer persistence failed'); this.name = 'NewcomerPersistenceError'; }
}

export const NEWCOMER_DB_LIMITS = {
  statuses: 100,
  customFields: 100,
  allFields: 107,
  optionsPerField: 100,
  optionsTotal: 1_000,
  serviceTypes: 100,
  answers: 100,
  notes: 5_000,
  activity: 5_000,
  duplicateHints: 25,
} as const;

type DataRow = Record<string, unknown>;

function plainRow(value: unknown, fields: readonly string[]): DataRow | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
      return null;
    }
    const row: DataRow = Object.create(null) as DataRow;
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || !('value' in descriptor)) return null;
      row[field] = descriptor.value;
    }
    return row;
  } catch {
    return null;
  }
}

function capturedArray(value: unknown, maximumWithSentinel: number): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number') return null;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumWithSentinel) return null;
    if (Reflect.ownKeys(descriptors).length !== length + 1) return null;
    const output: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor)) return null;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return null;
  }
}

function resultRows(result: unknown, sentinel: number): unknown[] {
  try {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new NewcomerPersistenceError();
    const descriptor = Object.getOwnPropertyDescriptor(result, 'results');
    if (!descriptor || !('value' in descriptor)) throw new NewcomerPersistenceError();
    const rows = capturedArray(descriptor.value, sentinel);
    if (!rows) throw new NewcomerPersistenceError();
    return rows;
  } catch (error) {
    if (error instanceof NewcomerPersistenceError) throw error;
    throw new NewcomerPersistenceError();
  }
}

function batchResults(value: unknown, count: number): AppDbResult<unknown>[] {
  const results = capturedArray(value, count);
  if (!results || results.length !== count) throw new NewcomerPersistenceError();
  return results as AppDbResult<unknown>[];
}

function integer(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string' || value.length > 16 || !/^(?:0|-?[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

function positiveId(value: unknown): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed > 0 && parsed <= 2_147_483_647 ? parsed : null;
}

function bool(value: unknown): boolean | null {
  const parsed = integer(value);
  return parsed === 0 ? false : parsed === 1 ? true : null;
}

function text(value: unknown, maximum = 10_000, nullable = false): string | null {
  if (value === null && nullable) return null;
  return typeof value === 'string' && value.length <= maximum && !value.includes('\0') ? value : null;
}

function timestamp(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)
    && isValidDateStr(value.slice(0, 10))
    ? value
    : null;
}

function locale(value: unknown): 'en' | 'zh' | null {
  return value === 'en' || value === 'zh' ? value : null;
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}

function assertLocale(value: unknown): asserts value is 'en' | 'zh' {
  if (value !== 'en' && value !== 'zh') throw new NewcomerInvalidError();
}

function assertPrivateAccess(user: SessionUser | null): asserts user is SessionUser {
  if (!hasAreaAccess(user, 'newcomers')) throw new NewcomerForbiddenError();
}

function snapshot(
  db: AppDb,
  backend: SnapshotBackend,
  statements: ReturnType<AppDb['prepare']>[],
): Promise<AppDbResult<unknown>[]> {
  return readSnapshotBatch<unknown>(db, backend, statements);
}

interface ConfigurationFieldOption {
  value: string;
  label: string;
  active: boolean;
  sort: number;
}

export interface NewcomerConfigurationField {
  id: number;
  key: string;
  type: NewcomerFieldType;
  required: boolean;
  active: boolean;
  sort: number;
  fixed: boolean;
  label: string;
  help: string | null;
  options: ConfigurationFieldOption[];
}

export interface NewcomerConfigurationStatus {
  id: number;
  key: string;
  category: 'open' | 'closed';
  sort: number;
  active: boolean;
  initial: boolean;
  label: string;
}

export interface NewcomerAdminConfiguration {
  statuses: NewcomerConfigurationStatus[];
  fields: NewcomerConfigurationField[];
  serviceTypes: Array<{ id: number; label: string }>;
}

export interface NewcomerFormDefinition {
  activeServiceTypeIds: number[];
  fields: Array<{
    id: number;
    key: string;
    type: NewcomerFieldType;
    required: boolean;
    label: string;
    help: string | null;
    options: Array<{ value: string; label: string }>;
  }>;
}

function configStatements(db: AppDb, requested: 'en' | 'zh', activeOnly: boolean) {
  const statusWhere = activeOnly ? 'WHERE status.active=1' : '';
  const fieldWhere = activeOnly ? 'WHERE field.active=1 AND field.id>7' : '';
  const optionWhere = activeOnly ? 'WHERE option.active=1 AND field.active=1 AND field.id>7' : '';
  return [
    db.prepare(`
      SELECT status.id,status.key,status.category,status.sort,status.active,status.is_initial,
             COALESCE(localized.label,english.label,status.key) AS label
      FROM newcomer_statuses status
      LEFT JOIN newcomer_status_i18n localized ON localized.status_id=status.id AND localized.locale=?
      LEFT JOIN newcomer_status_i18n english ON english.status_id=status.id AND english.locale='en'
      ${statusWhere}
      ORDER BY status.sort,status.id
      LIMIT 101
    `).bind(requested),
    db.prepare(`
      SELECT field.id,field.key,field.type,field.required,field.active,field.sort,field.fixed,
             COALESCE(localized.label,english.label,field.key) AS label,
             COALESCE(localized.help,english.help) AS help
      FROM newcomer_fields field
      LEFT JOIN newcomer_field_i18n localized ON localized.field_id=field.id AND localized.locale=?
      LEFT JOIN newcomer_field_i18n english ON english.field_id=field.id AND english.locale='en'
      ${fieldWhere}
      ORDER BY field.sort,field.id
      LIMIT 108
    `).bind(requested),
    db.prepare(`
      SELECT option.field_id,option.value,option.sort,option.active,
             COALESCE(localized.label,english.label,option.value) AS label
      FROM newcomer_field_options option
      JOIN newcomer_fields field ON field.id=option.field_id
      LEFT JOIN newcomer_field_option_i18n localized
        ON localized.field_id=option.field_id AND localized.value=option.value AND localized.locale=?
      LEFT JOIN newcomer_field_option_i18n english
        ON english.field_id=option.field_id AND english.value=option.value AND english.locale='en'
      ${optionWhere}
      ORDER BY option.field_id,option.sort,option.value
      LIMIT 1001
    `).bind(requested),
    db.prepare(`
      SELECT service.id,COALESCE(localized.name,english.name,'service-' || service.id) AS label
      FROM service_types service
      LEFT JOIN service_type_i18n localized
        ON localized.service_type_id=service.id AND localized.locale=?
      LEFT JOIN service_type_i18n english
        ON english.service_type_id=service.id AND english.locale='en'
      WHERE service.deleted_at IS NULL
      ORDER BY service.sort,service.id
      LIMIT 101
    `).bind(requested),
  ];
}

function decodeConfiguration(resultsValue: unknown, activeOnly: boolean): NewcomerAdminConfiguration {
  const results = batchResults(resultsValue, 4);
  const statusRows = resultRows(results[0], 101);
  const fieldRows = resultRows(results[1], 108);
  const optionRows = resultRows(results[2], 1001);
  const serviceRows = resultRows(results[3], 101);
  if (statusRows.length > NEWCOMER_DB_LIMITS.statuses) throw new NewcomerLimitError();
  const fieldMaximum = activeOnly ? NEWCOMER_DB_LIMITS.customFields : NEWCOMER_DB_LIMITS.allFields;
  if (fieldRows.length > fieldMaximum || optionRows.length > NEWCOMER_DB_LIMITS.optionsTotal) {
    throw new NewcomerLimitError();
  }
  if (serviceRows.length > NEWCOMER_DB_LIMITS.serviceTypes) throw new NewcomerLimitError();

  const statuses: NewcomerConfigurationStatus[] = statusRows.map((value) => {
    const row = plainRow(value, ['id', 'key', 'category', 'sort', 'active', 'is_initial', 'label']);
    const id = row ? positiveId(row.id) : null;
    const key = row ? text(row.key, 64) : null;
    const sort = row ? integer(row.sort) : null;
    const active = row ? bool(row.active) : null;
    const initial = row ? bool(row.is_initial) : null;
    const label = row ? text(row.label, 100) : null;
    const category = row?.category === 'open' || row?.category === 'closed' ? row.category : null;
    if (id === null || !key || sort === null || sort < 0 || active === null || initial === null || !label || !category) {
      throw new NewcomerPersistenceError();
    }
    return { id, key, category, sort, active, initial, label };
  });
  let initials = 0;
  for (const status of statuses) if (status.active && status.category === 'open' && status.initial) initials += 1;
  if (!activeOnly && initials !== 1) throw new NewcomerPersistenceError();

  const fieldsById = new Map<number, NewcomerConfigurationField>();
  const fields: NewcomerConfigurationField[] = fieldRows.map((value) => {
    const row = plainRow(value, ['id', 'key', 'type', 'required', 'active', 'sort', 'fixed', 'label', 'help']);
    const id = row ? positiveId(row.id) : null;
    const key = row ? text(row.key, 64) : null;
    const type = row && ['text', 'textarea', 'select', 'checkbox'].includes(String(row.type))
      ? row.type as NewcomerFieldType : null;
    const required = row ? bool(row.required) : null;
    const active = row ? bool(row.active) : null;
    const sort = row ? integer(row.sort) : null;
    const fixed = row ? bool(row.fixed) : null;
    const label = row ? text(row.label, 100) : null;
    const help = row ? text(row.help, 500, true) : null;
    if (id === null || !key || !type || required === null || active === null || sort === null || fixed === null || !label) {
      throw new NewcomerPersistenceError();
    }
    const field = { id, key, type, required, active, sort, fixed, label, help, options: [] };
    if (fieldsById.has(id)) throw new NewcomerPersistenceError();
    fieldsById.set(id, field);
    return field;
  });
  const optionCounts = new Map<number, number>();
  for (const value of optionRows) {
    const row = plainRow(value, ['field_id', 'value', 'sort', 'active', 'label']);
    const fieldId = row ? positiveId(row.field_id) : null;
    const optionValue = row ? text(row.value, 80) : null;
    const sort = row ? integer(row.sort) : null;
    const active = row ? bool(row.active) : null;
    const label = row ? text(row.label, 100) : null;
    if (fieldId === null) throw new NewcomerPersistenceError();
    const field = fieldsById.get(fieldId);
    if (!field || !optionValue || sort === null || active === null || !label) throw new NewcomerPersistenceError();
    const count = (optionCounts.get(fieldId) ?? 0) + 1;
    if (count > NEWCOMER_DB_LIMITS.optionsPerField) throw new NewcomerLimitError();
    optionCounts.set(fieldId, count);
    field.options.push({ value: optionValue, label, active, sort });
  }
  const serviceTypes = serviceRows.map((value) => {
    const row = plainRow(value, ['id', 'label']);
    const id = row ? positiveId(row.id) : null;
    const label = row ? text(row.label, 1_000) : null;
    if (id === null || !label) throw new NewcomerPersistenceError();
    return { id, label };
  });
  return { statuses, fields, serviceTypes };
}

async function readConfiguration(
  db: AppDb,
  backend: SnapshotBackend,
  requested: 'en' | 'zh',
  activeOnly: boolean,
): Promise<NewcomerAdminConfiguration> {
  try {
    return decodeConfiguration(await snapshot(db, backend, configStatements(db, requested, activeOnly)), activeOnly);
  } catch (error) {
    if (error instanceof NewcomerLimitError || error instanceof NewcomerPersistenceError) throw error;
    throw new NewcomerPersistenceError();
  }
}

export async function listNewcomerFormDefinition(
  db: AppDb,
  backend: SnapshotBackend,
  requested: 'en' | 'zh',
): Promise<NewcomerFormDefinition> {
  assertLocale(requested);
  const config = await readConfiguration(db, backend, requested, true);
  return {
    activeServiceTypeIds: config.serviceTypes.map((service) => service.id),
    fields: config.fields.map((field) => ({
      id: field.id,
      key: field.key,
      type: field.type,
      required: field.required,
      label: field.label,
      help: field.help,
      options: field.options.map((option) => ({ value: option.value, label: option.label })),
    })),
  };
}

export async function listNewcomerAdminConfiguration(
  db: AppDb,
  backend: SnapshotBackend,
  user: SessionUser | null,
  requested: 'en' | 'zh',
): Promise<NewcomerAdminConfiguration> {
  assertPrivateAccess(user);
  assertLocale(requested);
  return readConfiguration(db, backend, requested, false);
}

export interface NewcomerQueueRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  locale: 'en' | 'zh';
  visitDate: string;
  serviceTypeId: number | null;
  serviceLabel: string | null;
  consent: boolean;
  source: 'public' | 'staff';
  statusId: number;
  statusLabel: string;
  assigneePersonId: number | null;
  nextFollowUpDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

function queueRow(value: unknown): NewcomerQueueRow {
  const row = plainRow(value, [
    'id', 'name', 'email', 'phone', 'locale', 'visit_date', 'service_type_id', 'service_label',
    'contact_consent_at', 'source', 'status_id', 'status_label', 'assignee_person_id',
    'next_follow_up_date', 'version', 'created_at', 'updated_at',
  ]);
  const id = row && validUuid(row.id) ? row.id : null;
  const name = row ? text(row.name, 200) : null;
  const email = row ? text(row.email, 254, true) : null;
  const phone = row ? text(row.phone, 16, true) : null;
  const selectedLocale = row ? locale(row.locale) : null;
  const visitDate = row && typeof row.visit_date === 'string' && isValidDateStr(row.visit_date) ? row.visit_date : null;
  const serviceTypeId = row?.service_type_id === null ? null : positiveId(row?.service_type_id);
  const serviceLabel = row ? text(row.service_label, 1_000, true) : null;
  const consentAt = row ? timestamp(row.contact_consent_at, true) : null;
  const source = row?.source === 'public' || row?.source === 'staff' ? row.source : null;
  const statusId = row ? positiveId(row.status_id) : null;
  const statusLabel = row ? text(row.status_label, 100) : null;
  const assigneePersonId = row?.assignee_person_id === null ? null : positiveId(row?.assignee_person_id);
  const nextFollowUpDate = row?.next_follow_up_date === null
    ? null
    : typeof row?.next_follow_up_date === 'string' && isValidDateStr(row.next_follow_up_date)
      ? row.next_follow_up_date : null;
  const version = row ? integer(row.version) : null;
  const createdAt = row ? timestamp(row.created_at) : null;
  const updatedAt = row ? timestamp(row.updated_at) : null;
  if (
    !id || !name || !selectedLocale || !visitDate || source === null || statusId === null || !statusLabel
    || version === null || version < 0 || !createdAt || !updatedAt
    || (row?.service_type_id !== null && serviceTypeId === null)
    || (row?.assignee_person_id !== null && assigneePersonId === null)
    || (row?.next_follow_up_date !== null && nextFollowUpDate === null)
    || (row?.contact_consent_at !== null && consentAt === null)
  ) throw new NewcomerPersistenceError();
  return {
    id, name, email, phone, locale: selectedLocale, visitDate, serviceTypeId, serviceLabel,
    consent: consentAt !== null, source, statusId, statusLabel, assigneePersonId,
    nextFollowUpDate, version, createdAt, updatedAt,
  };
}

export interface NewcomerQueuePage {
  rows: NewcomerQueueRow[];
  page: number;
  limit: number;
  hasNext: boolean;
}

export async function listNewcomerQueue(
  db: AppDb,
  user: SessionUser | null,
  requested: 'en' | 'zh',
  filters: NewcomerQueueFilters,
  today: string,
): Promise<NewcomerQueuePage> {
  assertPrivateAccess(user);
  assertLocale(requested);
  if (!isValidDateStr(today) || !Number.isSafeInteger(filters.page) || filters.page < 1 || filters.page > 10_000
    || !Number.isSafeInteger(filters.limit) || filters.limit < 1 || filters.limit > 100) {
    throw new NewcomerInvalidError();
  }
  const conditions = ['submission.deleted_at IS NULL'];
  const values: unknown[] = [requested];
  const idFilter = (column: string, value: number | undefined) => {
    if (value === undefined) return;
    if (positiveId(value) === null) throw new NewcomerInvalidError();
    conditions.push(`${column}=?`);
    values.push(value);
  };
  idFilter('submission.status_id', filters.statusId);
  idFilter('submission.assignee_person_id', filters.assigneePersonId);
  idFilter('submission.service_type_id', filters.serviceTypeId);
  if (filters.due === 'overdue') {
    conditions.push('submission.next_follow_up_date IS NOT NULL AND submission.next_follow_up_date<?');
    values.push(today);
  } else if (filters.due === 'scheduled') conditions.push('submission.next_follow_up_date IS NOT NULL');
  else if (filters.due === 'none') conditions.push('submission.next_follow_up_date IS NULL');
  else if (filters.due !== undefined && filters.due !== 'all') throw new NewcomerInvalidError();
  if (filters.visitFrom !== undefined) {
    if (!isValidDateStr(filters.visitFrom)) throw new NewcomerInvalidError();
    conditions.push('submission.visit_date>=?'); values.push(filters.visitFrom);
  }
  if (filters.visitTo !== undefined) {
    if (!isValidDateStr(filters.visitTo)) throw new NewcomerInvalidError();
    conditions.push('submission.visit_date<=?'); values.push(filters.visitTo);
  }
  if (filters.visitFrom && filters.visitTo && filters.visitFrom > filters.visitTo) throw new NewcomerInvalidError();
  if (filters.source !== undefined) {
    if (filters.source !== 'public' && filters.source !== 'staff') throw new NewcomerInvalidError();
    conditions.push('submission.source=?'); values.push(filters.source);
  }
  const offset = (filters.page - 1) * filters.limit;
  values.push(filters.limit + 1, offset);
  try {
    const result = await db.prepare(`
      SELECT submission.id,submission.name,submission.email,submission.phone,submission.locale,
             submission.visit_date,submission.service_type_id,
             COALESCE(service_local.name,service_en.name) AS service_label,
             submission.contact_consent_at,submission.source,submission.status_id,
             COALESCE(status_local.label,status_en.label,status.key) AS status_label,
             submission.assignee_person_id,submission.next_follow_up_date,submission.version,
             submission.created_at,submission.updated_at
      FROM newcomer_submissions submission
      JOIN newcomer_statuses status ON status.id=submission.status_id
      LEFT JOIN newcomer_status_i18n status_local
        ON status_local.status_id=status.id AND status_local.locale=?
      LEFT JOIN newcomer_status_i18n status_en
        ON status_en.status_id=status.id AND status_en.locale='en'
      LEFT JOIN service_types service ON service.id=submission.service_type_id
      LEFT JOIN service_type_i18n service_local
        ON service_local.service_type_id=service.id AND service_local.locale=?1
      LEFT JOIN service_type_i18n service_en
        ON service_en.service_type_id=service.id AND service_en.locale='en'
      WHERE ${conditions.join(' AND ')}
      ORDER BY submission.updated_at DESC,submission.id DESC
      LIMIT ? OFFSET ?
    `).bind(...values).all<unknown>();
    const rows = resultRows(result, filters.limit + 1);
    const hasNext = rows.length > filters.limit;
    return { rows: rows.slice(0, filters.limit).map(queueRow), page: filters.page, limit: filters.limit, hasNext };
  } catch (error) {
    if (error instanceof NewcomerInvalidError || error instanceof NewcomerPersistenceError) throw error;
    throw new NewcomerPersistenceError();
  }
}

export interface NewcomerDetail {
  submission: NewcomerQueueRow & { linkedPersonId: number | null; closedAt: string | null };
  answers: Array<{ fieldId: number; fieldLabel: string; value: string }>;
  notes: Array<{ id: string; authorPersonId: number; body: string; createdAt: string }>;
  activity: Array<{ id: string; actorPersonId: number | null; kind: string; metadata: Record<string, string | number>; createdAt: string }>;
}

function activityMetadata(value: unknown): Record<string, string | number> | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const allowed = ['assignee_person_id', 'from_assignee_person_id', 'to_assignee_person_id', 'status_id', 'from_status_id', 'to_status_id', 'person_id', 'note_id', 'follow_up_date'];
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(parsed) as Record<string, PropertyDescriptor>;
    const output: Record<string, string | number> = Object.create(null) as Record<string, string | number>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !allowed.includes(key)) return null;
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || (typeof descriptor.value !== 'string' && typeof descriptor.value !== 'number')) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

export async function getNewcomerDetail(
  db: AppDb,
  backend: SnapshotBackend,
  user: SessionUser | null,
  submissionId: string,
  requested: 'en' | 'zh',
): Promise<NewcomerDetail | null> {
  assertPrivateAccess(user);
  assertLocale(requested);
  if (!validUuid(submissionId)) throw new NewcomerInvalidError();
  const statements = [
    db.prepare(`
      SELECT submission.id,submission.name,submission.email,submission.phone,submission.locale,
             submission.visit_date,submission.service_type_id,
             COALESCE(service_local.name,service_en.name) AS service_label,
             submission.contact_consent_at,submission.source,submission.status_id,
             COALESCE(status_local.label,status_en.label,status.key) AS status_label,
             submission.assignee_person_id,submission.next_follow_up_date,submission.version,
             submission.created_at,submission.updated_at,submission.linked_person_id,submission.closed_at
      FROM newcomer_submissions submission
      JOIN newcomer_statuses status ON status.id=submission.status_id
      LEFT JOIN newcomer_status_i18n status_local ON status_local.status_id=status.id AND status_local.locale=?1
      LEFT JOIN newcomer_status_i18n status_en ON status_en.status_id=status.id AND status_en.locale='en'
      LEFT JOIN service_types service ON service.id=submission.service_type_id
      LEFT JOIN service_type_i18n service_local ON service_local.service_type_id=service.id AND service_local.locale=?1
      LEFT JOIN service_type_i18n service_en ON service_en.service_type_id=service.id AND service_en.locale='en'
      WHERE submission.id=?2 AND submission.deleted_at IS NULL
      LIMIT 2
    `).bind(requested, submissionId),
    db.prepare(`
      SELECT answer.field_id,COALESCE(localized.label,english.label,field.key) AS field_label,answer.value
      FROM newcomer_answers answer JOIN newcomer_fields field ON field.id=answer.field_id
      LEFT JOIN newcomer_field_i18n localized ON localized.field_id=field.id AND localized.locale=?1
      LEFT JOIN newcomer_field_i18n english ON english.field_id=field.id AND english.locale='en'
      WHERE answer.submission_id=?2 ORDER BY field.sort,field.id LIMIT 101
    `).bind(requested, submissionId),
    db.prepare(`SELECT id,author_person_id,body,created_at FROM newcomer_notes
      WHERE submission_id=? ORDER BY created_at,id LIMIT 5001`).bind(submissionId),
    db.prepare(`SELECT id,actor_person_id,kind,metadata_json,created_at FROM newcomer_activity
      WHERE submission_id=? ORDER BY created_at,id LIMIT 5001`).bind(submissionId),
  ];
  try {
    const results = batchResults(await snapshot(db, backend, statements), 4);
    const submissionRows = resultRows(results[0], 2);
    if (submissionRows.length === 0) return null;
    if (submissionRows.length !== 1) throw new NewcomerPersistenceError();
    const rawSubmission = plainRow(submissionRows[0], [
      'id', 'name', 'email', 'phone', 'locale', 'visit_date', 'service_type_id', 'service_label',
      'contact_consent_at', 'source', 'status_id', 'status_label', 'assignee_person_id',
      'next_follow_up_date', 'version', 'created_at', 'updated_at', 'linked_person_id', 'closed_at',
    ]);
    if (!rawSubmission) throw new NewcomerPersistenceError();
    const baseValue: DataRow = Object.create(null) as DataRow;
    for (const key of [
      'id', 'name', 'email', 'phone', 'locale', 'visit_date', 'service_type_id', 'service_label',
      'contact_consent_at', 'source', 'status_id', 'status_label', 'assignee_person_id',
      'next_follow_up_date', 'version', 'created_at', 'updated_at',
    ]) baseValue[key] = rawSubmission[key];
    const base = queueRow(baseValue);
    const linkedPersonId = rawSubmission.linked_person_id === null ? null : positiveId(rawSubmission.linked_person_id);
    const closedAt = timestamp(rawSubmission.closed_at, true);
    if ((rawSubmission.linked_person_id !== null && linkedPersonId === null) || (rawSubmission.closed_at !== null && closedAt === null)) {
      throw new NewcomerPersistenceError();
    }
    const answerRows = resultRows(results[1], 101);
    if (answerRows.length > NEWCOMER_DB_LIMITS.answers) throw new NewcomerLimitError();
    const answers = answerRows.map((value) => {
      const row = plainRow(value, ['field_id', 'field_label', 'value']);
      const fieldId = row ? positiveId(row.field_id) : null;
      const fieldLabel = row ? text(row.field_label, 100) : null;
      const answerValue = row ? text(row.value, 4_000) : null;
      if (fieldId === null || !fieldLabel || answerValue === null) throw new NewcomerPersistenceError();
      return { fieldId, fieldLabel, value: answerValue };
    });
    const noteRows = resultRows(results[2], 5001);
    if (noteRows.length > NEWCOMER_DB_LIMITS.notes) throw new NewcomerLimitError();
    const notes = noteRows.map((value) => {
      const row = plainRow(value, ['id', 'author_person_id', 'body', 'created_at']);
      const id = row && validUuid(row.id) ? row.id : null;
      const authorPersonId = row ? positiveId(row.author_person_id) : null;
      const body = row ? text(row.body, 10_000) : null;
      const createdAt = row ? timestamp(row.created_at) : null;
      if (!id || authorPersonId === null || !body || !createdAt) throw new NewcomerPersistenceError();
      return { id, authorPersonId, body, createdAt };
    });
    const activityRows = resultRows(results[3], 5001);
    if (activityRows.length > NEWCOMER_DB_LIMITS.activity) throw new NewcomerLimitError();
    const activity = activityRows.map((value) => {
      const row = plainRow(value, ['id', 'actor_person_id', 'kind', 'metadata_json', 'created_at']);
      const id = row && validUuid(row.id) ? row.id : null;
      const actorPersonId = row?.actor_person_id === null ? null : positiveId(row?.actor_person_id);
      const kind = row ? text(row.kind, 64) : null;
      const metadata = row ? activityMetadata(row.metadata_json) : null;
      const createdAt = row ? timestamp(row.created_at) : null;
      if (!id || (row?.actor_person_id !== null && actorPersonId === null) || !kind || !metadata || !createdAt) {
        throw new NewcomerPersistenceError();
      }
      return { id, actorPersonId, kind, metadata, createdAt };
    });
    return { submission: { ...base, linkedPersonId, closedAt }, answers, notes, activity };
  } catch (error) {
    if (error instanceof NewcomerLimitError || error instanceof NewcomerPersistenceError) throw error;
    throw new NewcomerPersistenceError();
  }
}

export type NewcomerDuplicateHint =
  | { kind: 'person_live'; id: number }
  | { kind: 'person_deleted'; id: number }
  | { kind: 'submission_open'; id: string; statusId: number };

export async function findNewcomerDuplicateHints(
  db: AppDb,
  user: SessionUser | null,
  input: { email: string | null; phone: string | null; excludeSubmissionId: string | null },
): Promise<NewcomerDuplicateHint[]> {
  assertPrivateAccess(user);
  let email: string | null = null;
  let phone: string | null = null;
  if (input.email !== null) {
    const normalized = normalizeNewcomerEmail(input.email);
    if (!normalized.ok || normalized.value !== input.email) throw new NewcomerInvalidError();
    email = normalized.value;
  }
  if (input.phone !== null) {
    const normalized = normalizeNewcomerPhone(input.phone);
    if (!normalized.ok || normalized.value !== input.phone) throw new NewcomerInvalidError();
    phone = normalized.value;
  }
  if (email === null && phone === null) throw new NewcomerInvalidError();
  if (input.excludeSubmissionId !== null && !validUuid(input.excludeSubmissionId)) throw new NewcomerInvalidError();
  const binds = [email, email, phone, phone];
  try {
    const result = await db.prepare(`
      SELECT kind_order,kind,record_id,status_id FROM (
        SELECT 1 AS kind_order,'person_live' AS kind,CAST(person.id AS TEXT) AS record_id,NULL AS status_id
        FROM people person
        WHERE person.deleted_at IS NULL AND ((? IS NOT NULL AND person.email=?) OR (? IS NOT NULL AND person.phone=?))
        UNION ALL
        SELECT 2 AS kind_order,'person_deleted' AS kind,CAST(person.id AS TEXT) AS record_id,NULL AS status_id
        FROM people person
        WHERE person.deleted_at IS NOT NULL AND ((? IS NOT NULL AND person.email=?) OR (? IS NOT NULL AND person.phone=?))
        UNION ALL
        SELECT 3 AS kind_order,'submission_open' AS kind,submission.id AS record_id,submission.status_id
        FROM newcomer_submissions submission
        JOIN newcomer_statuses status ON status.id=submission.status_id AND status.category='open'
        WHERE submission.deleted_at IS NULL AND (? IS NULL OR submission.id<>?)
          AND ((? IS NOT NULL AND submission.email=?) OR (? IS NOT NULL AND submission.phone=?))
      ) hints
      ORDER BY kind_order,record_id
      LIMIT 26
    `).bind(
      ...binds,
      ...binds,
      input.excludeSubmissionId, input.excludeSubmissionId,
      ...binds,
    ).all<unknown>();
    const rows = resultRows(result, 26);
    if (rows.length > NEWCOMER_DB_LIMITS.duplicateHints) throw new NewcomerLimitError();
    return rows.map((value) => {
      const row = plainRow(value, ['kind_order', 'kind', 'record_id', 'status_id']);
      const order = row ? integer(row.kind_order) : null;
      if (order === 1 && row?.kind === 'person_live') {
        const id = positiveId(row.record_id);
        if (id !== null && row.status_id === null) return { kind: 'person_live', id };
      }
      if (order === 2 && row?.kind === 'person_deleted') {
        const id = positiveId(row.record_id);
        if (id !== null && row.status_id === null) return { kind: 'person_deleted', id };
      }
      if (order === 3 && row?.kind === 'submission_open' && validUuid(row.record_id)) {
        const statusId = positiveId(row.status_id);
        if (statusId !== null) return { kind: 'submission_open', id: row.record_id, statusId };
      }
      throw new NewcomerPersistenceError();
    });
  } catch (error) {
    if (error instanceof NewcomerLimitError || error instanceof NewcomerPersistenceError) throw error;
    throw new NewcomerPersistenceError();
  }
}
