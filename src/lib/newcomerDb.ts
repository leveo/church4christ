import { readSnapshotBatch, type AppDb, type AppDbResult, type SnapshotBackend } from './appDb';
import { hasAreaAccess } from './adminAreas';
import { isValidDateStr } from './dates';
import {
  isNewcomerFieldType,
  normalizeNewcomerEmail,
  normalizeNewcomerPhone,
  type NewcomerFieldType,
  type NewcomerQueueFilters,
} from './newcomerValidation';
import type { SessionUser } from './types';

const UTF8 = new TextEncoder();

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
  activeOptions: 1_000,
  allOptions: 10_000,
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
    // postgres.js returns a real Array with a fixed set of own, data-only
    // RowList metadata properties.  Accept those without dereferencing them;
    // every index and the length are still snapshotted exactly once below.
    const rowListMetadata = new Set(['count', 'state', 'command', 'columns', 'statement']);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === 'length') continue;
      if (typeof key !== 'string') return null;
      const index = /^(?:0|[1-9]\d*)$/.test(key) ? Number(key) : null;
      if (index !== null && index < length) continue;
      const descriptor = descriptors[key];
      if (!rowListMetadata.has(key) || !descriptor || !('value' in descriptor)) return null;
    }
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
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
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
  return typeof value === 'string' && UTF8.encode(value).byteLength <= maximum && !value.includes('\0') ? value : null;
}

function normalizedText(value: unknown, maximum: number, nullable = false): string | null {
  const captured = text(value, maximum, nullable);
  if (captured === null) return null;
  try {
    return captured.length > 0 && captured === captured.trim() && captured === captured.normalize('NFC')
      ? captured
      : null;
  } catch {
    return null;
  }
}

function positiveTextId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 ? parsed : null;
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

const STATUS_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD_KEY = STATUS_KEY;
const OPTION_VALUE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const CORE_STATUSES = new Map<number, { key: string; category: 'open' | 'closed' }>([
  [1, { key: 'new', category: 'open' }],
  [2, { key: 'assigned', category: 'open' }],
  [3, { key: 'contacted', category: 'open' }],
  [4, { key: 'connected', category: 'closed' }],
  [5, { key: 'closed', category: 'closed' }],
]);
const CORE_FIELDS = new Map<number, { key: string; type: NewcomerFieldType }>([
  [1, { key: 'name', type: 'text' }],
  [2, { key: 'email', type: 'text' }],
  [3, { key: 'phone', type: 'text' }],
  [4, { key: 'preferred_language', type: 'select' }],
  [5, { key: 'visit_date', type: 'text' }],
  [6, { key: 'service_type', type: 'select' }],
  [7, { key: 'contact_consent', type: 'checkbox' }],
]);

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
  const optionLimit = activeOnly ? 1_001 : 10_001;
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
      LIMIT ${optionLimit}
    `).bind(requested),
    db.prepare(`
      SELECT service.id,service.sort,COALESCE(localized.name,english.name,'service-' || service.id) AS label
      FROM service_types service
      LEFT JOIN service_type_i18n localized
        ON localized.service_type_id=service.id AND localized.locale=?
      LEFT JOIN service_type_i18n english
        ON english.service_type_id=service.id AND english.locale='en'
      WHERE service.deleted_at IS NULL
      ORDER BY service.sort,service.id
      LIMIT 101
    `).bind(requested),
    db.prepare(`
      SELECT option.field_id
      FROM newcomer_field_options option
      WHERE option.active=1
      ORDER BY option.field_id,option.sort,option.value
      LIMIT 1001
    `),
  ];
}

function decodeConfiguration(resultsValue: unknown, activeOnly: boolean): NewcomerAdminConfiguration {
  const results = batchResults(resultsValue, 5);
  const statusRows = resultRows(results[0], 101);
  const fieldRows = resultRows(results[1], 108);
  const optionRows = resultRows(results[2], activeOnly ? 1001 : 10_001);
  const serviceRows = resultRows(results[3], 101);
  const activeOptionRows = resultRows(results[4], 1001);
  if (statusRows.length > NEWCOMER_DB_LIMITS.statuses) throw new NewcomerLimitError();
  const fieldMaximum = activeOnly ? NEWCOMER_DB_LIMITS.customFields : NEWCOMER_DB_LIMITS.allFields;
  const optionMaximum = activeOnly ? NEWCOMER_DB_LIMITS.activeOptions : NEWCOMER_DB_LIMITS.allOptions;
  if (fieldRows.length > fieldMaximum || optionRows.length > optionMaximum
    || activeOptionRows.length > NEWCOMER_DB_LIMITS.activeOptions) {
    throw new NewcomerLimitError();
  }
  if (serviceRows.length > NEWCOMER_DB_LIMITS.serviceTypes) throw new NewcomerLimitError();
  for (const value of activeOptionRows) {
    const row = plainRow(value, ['field_id']);
    if (!row || positiveId(row.field_id) === null) throw new NewcomerPersistenceError();
  }

  const statusIds = new Set<number>();
  const statusKeys = new Set<string>();
  let previousStatus: [number, number] | null = null;
  const statuses: NewcomerConfigurationStatus[] = statusRows.map((value) => {
    const row = plainRow(value, ['id', 'key', 'category', 'sort', 'active', 'is_initial', 'label']);
    const id = row ? positiveId(row.id) : null;
    const key = row && typeof row.key === 'string' && STATUS_KEY.test(row.key) ? row.key : null;
    const sort = row ? integer(row.sort) : null;
    const active = row ? bool(row.active) : null;
    const initial = row ? bool(row.is_initial) : null;
    const label = row ? normalizedText(row.label, 100) : null;
    const category = row?.category === 'open' || row?.category === 'closed' ? row.category : null;
    if (id === null || !key || sort === null || sort < 0 || sort > 100_000 || active === null || initial === null
      || !label || !category || statusIds.has(id) || statusKeys.has(key) || (initial && (!active || category !== 'open'))) {
      throw new NewcomerPersistenceError();
    }
    const core = CORE_STATUSES.get(id);
    if ((core && (core.key !== key || core.category !== category)) || (!core && id <= 5)) throw new NewcomerPersistenceError();
    const ordering: [number, number] = [sort, id];
    if (previousStatus && (ordering[0] < previousStatus[0]
      || (ordering[0] === previousStatus[0] && ordering[1] <= previousStatus[1]))) throw new NewcomerPersistenceError();
    previousStatus = ordering;
    statusIds.add(id);
    statusKeys.add(key);
    return { id, key, category, sort, active, initial, label };
  });
  let initials = 0;
  for (const status of statuses) if (status.active && status.category === 'open' && status.initial) initials += 1;
  if (initials !== 1 || (!activeOnly && [...CORE_STATUSES.keys()].some((id) => !statusIds.has(id)))) {
    throw new NewcomerPersistenceError();
  }

  const fieldsById = new Map<number, NewcomerConfigurationField>();
  const fieldKeys = new Set<string>();
  let previousField: [number, number] | null = null;
  const fields: NewcomerConfigurationField[] = fieldRows.map((value) => {
    const row = plainRow(value, ['id', 'key', 'type', 'required', 'active', 'sort', 'fixed', 'label', 'help']);
    const id = row ? positiveId(row.id) : null;
    const key = row && typeof row.key === 'string' && FIELD_KEY.test(row.key) ? row.key : null;
    const type = row && isNewcomerFieldType(row.type) ? row.type : null;
    const required = row ? bool(row.required) : null;
    const active = row ? bool(row.active) : null;
    const sort = row ? integer(row.sort) : null;
    const fixed = row ? bool(row.fixed) : null;
    const label = row ? normalizedText(row.label, 100) : null;
    const help = row ? normalizedText(row.help, 500, true) : null;
    if (id === null || !key || !type || required === null || active === null || sort === null || sort < 0 || sort > 100_000
      || fixed === null || !label || (row?.help !== null && help === null) || fieldsById.has(id) || fieldKeys.has(key)) {
      throw new NewcomerPersistenceError();
    }
    const core = CORE_FIELDS.get(id);
    if (activeOnly) {
      if (core || id <= 7 || !active || fixed) throw new NewcomerPersistenceError();
    } else if (core) {
      if (core.key !== key || core.type !== type || required || !active || !fixed) throw new NewcomerPersistenceError();
    } else if (id <= 7 || fixed) throw new NewcomerPersistenceError();
    const ordering: [number, number] = [sort, id];
    if (previousField && (ordering[0] < previousField[0]
      || (ordering[0] === previousField[0] && ordering[1] <= previousField[1]))) throw new NewcomerPersistenceError();
    previousField = ordering;
    const field = { id, key, type, required, active, sort, fixed, label, help, options: [] };
    fieldsById.set(id, field);
    fieldKeys.add(key);
    return field;
  });
  if (!activeOnly && [...CORE_FIELDS.keys()].some((id) => !fieldsById.has(id))) throw new NewcomerPersistenceError();
  const optionCounts = new Map<number, number>();
  const optionKeys = new Set<string>();
  let previousOption: [number, number, string] | null = null;
  for (const value of optionRows) {
    const row = plainRow(value, ['field_id', 'value', 'sort', 'active', 'label']);
    const fieldId = row ? positiveId(row.field_id) : null;
    const optionValue = row && typeof row.value === 'string' && OPTION_VALUE.test(row.value) ? row.value : null;
    const sort = row ? integer(row.sort) : null;
    const active = row ? bool(row.active) : null;
    const label = row ? normalizedText(row.label, 100) : null;
    if (fieldId === null) throw new NewcomerPersistenceError();
    const field = fieldsById.get(fieldId);
    const compound = `${fieldId}:${optionValue ?? ''}`;
    if (!field || field.fixed || field.type !== 'select' || !optionValue || sort === null || sort < 0 || sort > 100_000
      || active === null || (activeOnly && !active) || !label || optionKeys.has(compound)) throw new NewcomerPersistenceError();
    const ordering: [number, number, string] = [fieldId, sort, optionValue];
    if (previousOption && (ordering[0] < previousOption[0]
      || (ordering[0] === previousOption[0] && (ordering[1] < previousOption[1]
        || (ordering[1] === previousOption[1] && ordering[2] <= previousOption[2]))))) throw new NewcomerPersistenceError();
    previousOption = ordering;
    optionKeys.add(compound);
    const count = (optionCounts.get(fieldId) ?? 0) + 1;
    if (count > NEWCOMER_DB_LIMITS.optionsPerField) throw new NewcomerLimitError();
    optionCounts.set(fieldId, count);
    field.options.push({ value: optionValue, label, active, sort });
  }
  for (const field of fields) {
    if (field.type === 'select' && !field.fixed && !field.options.some((option) => option.active)) {
      throw new NewcomerPersistenceError();
    }
    if (field.type !== 'select' && field.options.length > 0) throw new NewcomerPersistenceError();
  }
  const serviceIds = new Set<number>();
  let previousService: [number, number] | null = null;
  const serviceTypes = serviceRows.map((value) => {
    const row = plainRow(value, ['id', 'sort', 'label']);
    const id = row ? positiveId(row.id) : null;
    const sort = row ? integer(row.sort) : null;
    const label = row ? normalizedText(row.label, 1_000) : null;
    if (id === null || sort === null || sort < 0 || sort > 100_000 || !label || serviceIds.has(id)) {
      throw new NewcomerPersistenceError();
    }
    const ordering: [number, number] = [sort, id];
    if (previousService && (ordering[0] < previousService[0]
      || (ordering[0] === previousService[0] && ordering[1] <= previousService[1]))) throw new NewcomerPersistenceError();
    previousService = ordering;
    serviceIds.add(id);
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
  assertSuperAdmin(user);
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
  const name = row ? normalizedText(row.name, 200) : null;
  const email = row ? text(row.email, 254, true) : null;
  const phone = row ? text(row.phone, 16, true) : null;
  const normalizedEmail = email === null ? null : normalizeNewcomerEmail(email);
  const normalizedPhone = phone === null ? null : normalizeNewcomerPhone(phone);
  const selectedLocale = row ? locale(row.locale) : null;
  const visitDate = row && typeof row.visit_date === 'string' && isValidDateStr(row.visit_date) ? row.visit_date : null;
  const serviceTypeId = row?.service_type_id === null ? null : positiveId(row?.service_type_id);
  const serviceLabel = row ? normalizedText(row.service_label, 1_000, true) : null;
  const consentAt = row ? timestamp(row.contact_consent_at, true) : null;
  const source = row?.source === 'public' || row?.source === 'staff' ? row.source : null;
  const statusId = row ? positiveId(row.status_id) : null;
  const statusLabel = row ? normalizedText(row.status_label, 100) : null;
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
    || version === null || version < 0 || version > 2_147_483_647 || !createdAt || !updatedAt
    || (row?.service_type_id !== null && serviceTypeId === null)
    || (serviceTypeId !== null && serviceLabel === null)
    || (serviceTypeId === null && serviceLabel !== null)
    || (row?.email !== null && (email === null || !normalizedEmail?.ok || normalizedEmail.value !== email))
    || (row?.phone !== null && (phone === null || !normalizedPhone?.ok || normalizedPhone.value !== phone))
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
             COALESCE(service_local.name,service_en.name,'service-' || service.id) AS service_label,
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
    const decodedRows = rows.map(queueRow);
    const submissionIds = new Set<string>();
    let previous: NewcomerQueueRow | null = null;
    for (const row of decodedRows) {
      if (submissionIds.has(row.id)
        || (previous && (previous.updatedAt < row.updatedAt
          || (previous.updatedAt === row.updatedAt && previous.id <= row.id)))) {
        throw new NewcomerPersistenceError();
      }
      submissionIds.add(row.id);
      previous = row;
    }
    const hasNext = decodedRows.length > filters.limit;
    return { rows: decodedRows.slice(0, filters.limit), page: filters.page, limit: filters.limit, hasNext };
  } catch (error) {
    if (error instanceof NewcomerInvalidError || error instanceof NewcomerPersistenceError) throw error;
    throw new NewcomerPersistenceError();
  }
}

export interface NewcomerDetail {
  submission: NewcomerQueueRow & { linkedPersonId: number | null; closedAt: string | null };
  answers: Array<{ fieldId: number; fieldLabel: string; value: string }>;
  notes: Array<{ id: string; authorPersonId: number; body: string; createdAt: string }>;
  activity: Array<{ id: string; actorPersonId: number | null; kind: NewcomerActivityKind; metadata: Record<string, string | number>; createdAt: string }>;
}

export const NEWCOMER_ACTIVITY_KINDS = [
  'submission_created', 'assigned', 'status_changed', 'follow_up_scheduled',
  'note_added', 'person_linked', 'visitor_created',
] as const;
export type NewcomerActivityKind = typeof NEWCOMER_ACTIVITY_KINDS[number];

function isActivityKind(value: unknown): value is NewcomerActivityKind {
  return value === 'submission_created' || value === 'assigned' || value === 'status_changed'
    || value === 'follow_up_scheduled' || value === 'note_added' || value === 'person_linked'
    || value === 'visitor_created';
}

function parsedMetadata(value: unknown): DataRow | null {
  if (typeof value !== 'string' || UTF8.encode(value).byteLength > 512) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const prototype = Object.getPrototypeOf(parsed);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(parsed) as Record<string, PropertyDescriptor>;
    const output: DataRow = Object.create(null) as DataRow;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return null;
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function exactKeys(row: DataRow, expected: readonly string[]): boolean {
  const keys = Object.keys(row);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function decodeNewcomerActivityMetadata(
  kind: NewcomerActivityKind,
  value: unknown,
): Record<string, string | number> | null {
  const row = parsedMetadata(value);
  if (!row) return null;
  const output: Record<string, string | number> = Object.create(null) as Record<string, string | number>;
  if (kind === 'submission_created') return exactKeys(row, []) ? output : null;
  if (kind === 'assigned') {
    const keys = Object.keys(row);
    if (keys.length < 1 || keys.length > 2
      || keys.some((key) => key !== 'from_assignee_person_id' && key !== 'to_assignee_person_id')) return null;
    for (const key of keys) {
      const id = positiveId(row[key]);
      if (id === null) return null;
      output[key] = id;
    }
    return output;
  }
  if (kind === 'status_changed') {
    if (!exactKeys(row, ['from_status_id', 'to_status_id'])) return null;
    const from = positiveId(row.from_status_id);
    const to = positiveId(row.to_status_id);
    if (from === null || to === null) return null;
    output.from_status_id = from;
    output.to_status_id = to;
    return output;
  }
  if (kind === 'follow_up_scheduled') {
    if (exactKeys(row, [])) return output;
    if (!exactKeys(row, ['follow_up_date']) || typeof row.follow_up_date !== 'string' || !isValidDateStr(row.follow_up_date)) return null;
    output.follow_up_date = row.follow_up_date;
    return output;
  }
  if (kind === 'note_added') {
    if (!exactKeys(row, ['note_id']) || !validUuid(row.note_id)) return null;
    output.note_id = row.note_id;
    return output;
  }
  if (!exactKeys(row, ['person_id'])) return null;
  const personId = positiveId(row.person_id);
  if (personId === null) return null;
  output.person_id = personId;
  return output;
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
             COALESCE(service_local.name,service_en.name,'service-' || service.id) AS service_label,
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
      SELECT answer.field_id,field.sort AS field_sort,
             COALESCE(localized.label,english.label,field.key) AS field_label,answer.value
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
    const answerFieldIds = new Set<number>();
    let previousAnswer: [number, number] | null = null;
    const answers = answerRows.map((value) => {
      const row = plainRow(value, ['field_id', 'field_sort', 'field_label', 'value']);
      const fieldId = row ? positiveId(row.field_id) : null;
      const fieldSort = row ? integer(row.field_sort) : null;
      const fieldLabel = row ? normalizedText(row.field_label, 100) : null;
      const answerValue = row ? normalizedText(row.value, 4_000) : null;
      if (fieldId === null || fieldSort === null || fieldSort < 0 || fieldSort > 100_000
        || !fieldLabel || answerValue === null || answerFieldIds.has(fieldId)
        || (previousAnswer && (fieldSort < previousAnswer[0]
          || (fieldSort === previousAnswer[0] && fieldId <= previousAnswer[1])))) {
        throw new NewcomerPersistenceError();
      }
      answerFieldIds.add(fieldId);
      previousAnswer = [fieldSort, fieldId];
      return { fieldId, fieldLabel, value: answerValue };
    });
    const noteRows = resultRows(results[2], 5001);
    if (noteRows.length > NEWCOMER_DB_LIMITS.notes) throw new NewcomerLimitError();
    const noteIds = new Set<string>();
    let previousNote: [string, string] | null = null;
    const notes = noteRows.map((value) => {
      const row = plainRow(value, ['id', 'author_person_id', 'body', 'created_at']);
      const id = row && validUuid(row.id) ? row.id : null;
      const authorPersonId = row ? positiveId(row.author_person_id) : null;
      const body = row ? normalizedText(row.body, 10_000) : null;
      const createdAt = row ? timestamp(row.created_at) : null;
      if (!id || authorPersonId === null || !body || !createdAt || noteIds.has(id)
        || (previousNote && (createdAt < previousNote[0] || (createdAt === previousNote[0] && id <= previousNote[1])))) {
        throw new NewcomerPersistenceError();
      }
      noteIds.add(id);
      previousNote = [createdAt, id];
      return { id, authorPersonId, body, createdAt };
    });
    const activityRows = resultRows(results[3], 5001);
    if (activityRows.length > NEWCOMER_DB_LIMITS.activity) throw new NewcomerLimitError();
    const activityIds = new Set<string>();
    let previousActivity: [string, string] | null = null;
    const activity = activityRows.map((value) => {
      const row = plainRow(value, ['id', 'actor_person_id', 'kind', 'metadata_json', 'created_at']);
      const id = row && validUuid(row.id) ? row.id : null;
      const actorPersonId = row?.actor_person_id === null ? null : positiveId(row?.actor_person_id);
      const kind = row && isActivityKind(row.kind) ? row.kind : null;
      const metadata = row && kind ? decodeNewcomerActivityMetadata(kind, row.metadata_json) : null;
      const createdAt = row ? timestamp(row.created_at) : null;
      if (!id || (row?.actor_person_id !== null && actorPersonId === null) || !kind || !metadata || !createdAt
        || activityIds.has(id)
        || (previousActivity && (createdAt < previousActivity[0]
          || (createdAt === previousActivity[0] && id <= previousActivity[1])))) {
        throw new NewcomerPersistenceError();
      }
      activityIds.add(id);
      previousActivity = [createdAt, id];
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
  const inputRow = plainRow(input, ['email', 'phone', 'excludeSubmissionId']);
  if (!inputRow || (inputRow.email !== null && typeof inputRow.email !== 'string')
    || (inputRow.phone !== null && typeof inputRow.phone !== 'string')
    || (inputRow.excludeSubmissionId !== null && typeof inputRow.excludeSubmissionId !== 'string')) {
    throw new NewcomerInvalidError();
  }
  let email: string | null = null;
  let phone: string | null = null;
  if (inputRow.email !== null) {
    const normalized = normalizeNewcomerEmail(inputRow.email);
    if (!normalized.ok || normalized.value !== inputRow.email) throw new NewcomerInvalidError();
    email = normalized.value;
  }
  if (inputRow.phone !== null) {
    const normalized = normalizeNewcomerPhone(inputRow.phone);
    if (!normalized.ok || normalized.value !== inputRow.phone) throw new NewcomerInvalidError();
    phone = normalized.value;
  }
  if (email === null && phone === null) throw new NewcomerInvalidError();
  if (inputRow.excludeSubmissionId !== null && !validUuid(inputRow.excludeSubmissionId)) throw new NewcomerInvalidError();
  const binds = [email, email, phone, phone];
  const normalizedPersonPhone = `('+' || replace(replace(replace(replace(replace(
    substr(trim(person.phone),2),' ',''),'(',''),')',''),'-',''),'.',''))`;
  try {
    const result = await db.prepare(`
      SELECT kind_order,kind,record_id,status_id FROM (
        SELECT 1 AS kind_order,'person_live' AS kind,CAST(person.id AS TEXT) AS record_id,
          CAST(NULL AS INTEGER) AS status_id
        FROM people person
        WHERE person.deleted_at IS NULL
          AND ((CAST(? AS TEXT) IS NOT NULL AND person.email=?)
            OR (CAST(? AS TEXT) IS NOT NULL AND substr(trim(person.phone),1,1)='+'
              AND ${normalizedPersonPhone}=?))
        UNION ALL
        SELECT 2 AS kind_order,'person_deleted' AS kind,CAST(person.id AS TEXT) AS record_id,
          CAST(NULL AS INTEGER) AS status_id
        FROM people person
        WHERE person.deleted_at IS NOT NULL
          AND ((CAST(? AS TEXT) IS NOT NULL AND person.email=?)
            OR (CAST(? AS TEXT) IS NOT NULL AND substr(trim(person.phone),1,1)='+'
              AND ${normalizedPersonPhone}=?))
        UNION ALL
        SELECT 3 AS kind_order,'submission_open' AS kind,CAST(submission.id AS TEXT) AS record_id,submission.status_id
        FROM newcomer_submissions submission
        JOIN newcomer_statuses status ON status.id=submission.status_id AND status.category='open'
        WHERE submission.deleted_at IS NULL AND (CAST(? AS TEXT) IS NULL OR submission.id<>?)
          AND ((CAST(? AS TEXT) IS NOT NULL AND submission.email=?)
            OR (CAST(? AS TEXT) IS NOT NULL AND submission.phone=?))
      ) hints
      ORDER BY kind_order,record_id
      LIMIT 26
    `).bind(
      ...binds,
      ...binds,
      inputRow.excludeSubmissionId, inputRow.excludeSubmissionId,
      ...binds,
    ).all<unknown>();
    const rows = resultRows(result, 26);
    if (rows.length > NEWCOMER_DB_LIMITS.duplicateHints) throw new NewcomerLimitError();
    const decoded = rows.map((value) => {
      const row = plainRow(value, ['kind_order', 'kind', 'record_id', 'status_id']);
      const order = row ? integer(row.kind_order) : null;
      const recordId = row && typeof row.record_id === 'string' ? row.record_id : null;
      if (order === 1 && row?.kind === 'person_live') {
        const id = positiveTextId(recordId);
        if (recordId !== null && id !== null && row.status_id === null) {
          return { order, recordId, hint: { kind: 'person_live', id } as NewcomerDuplicateHint };
        }
      }
      if (order === 2 && row?.kind === 'person_deleted') {
        const id = positiveTextId(recordId);
        if (recordId !== null && id !== null && row.status_id === null) {
          return { order, recordId, hint: { kind: 'person_deleted', id } as NewcomerDuplicateHint };
        }
      }
      if (order === 3 && row?.kind === 'submission_open' && validUuid(recordId)) {
        const statusId = positiveId(row.status_id);
        if (statusId !== null) {
          return {
            order,
            recordId,
            hint: { kind: 'submission_open', id: recordId, statusId } as NewcomerDuplicateHint,
          };
        }
      }
      throw new NewcomerPersistenceError();
    });
    const identities = new Set<string>();
    let previous: { order: number; recordId: string } | null = null;
    for (const item of decoded) {
      const identity = `${item.hint.kind}:${item.recordId}`;
      if (identities.has(identity)
        || (previous && (item.order < previous.order
          || (item.order === previous.order && item.recordId <= previous.recordId)))) {
        throw new NewcomerPersistenceError();
      }
      identities.add(identity);
      previous = item;
    }
    return decoded.map((item) => item.hint);
  } catch (error) {
    if (error instanceof NewcomerLimitError || error instanceof NewcomerPersistenceError) throw error;
    throw new NewcomerPersistenceError();
  }
}

function assertSuperAdmin(user: SessionUser | null): asserts user is SessionUser {
  if (!user?.isAdmin || !user.isSuperAdmin) throw new NewcomerForbiddenError();
}

function boundedSettingText(value: unknown, maximumBytes: number, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string') throw new NewcomerInvalidError();
  let normalized: string;
  try {
    normalized = value.normalize('NFC').trim();
  } catch {
    throw new NewcomerInvalidError();
  }
  if ((!nullable && normalized.length === 0) || normalized.includes('\0') || UTF8.encode(normalized).byteLength > maximumBytes) {
    throw new NewcomerInvalidError();
  }
  return normalized.length === 0 && nullable ? null : normalized;
}

function validSort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
}

function mutationRows(result: unknown, expected: number): unknown[] {
  const rows = resultRows(result, expected);
  if (rows.length !== expected) throw new NewcomerConflictError();
  return rows;
}

function databaseConflict(error: unknown): boolean {
  try {
    if (error === null || typeof error !== 'object') return false;
    const descriptors = Object.getOwnPropertyDescriptors(error) as Record<string, PropertyDescriptor>;
    const code = descriptors.code && 'value' in descriptors.code ? descriptors.code.value : null;
    const message = descriptors.message && 'value' in descriptors.message && typeof descriptors.message.value === 'string'
      ? descriptors.message.value
      : '';
    return code === '23503' || code === '23505' || code === '23514'
      || message.includes('SQLITE_CONSTRAINT')
      || message.includes('FOREIGN KEY constraint failed')
      || message.includes('UNIQUE constraint failed')
      || message.includes('newcomer_status_')
      || message.includes('newcomer_field_');
  } catch {
    return false;
  }
}

function rethrowMutation(error: unknown): never {
  if (
    error instanceof NewcomerInvalidError
    || error instanceof NewcomerForbiddenError
    || error instanceof NewcomerLimitError
    || error instanceof NewcomerConflictError
    || error instanceof NewcomerPersistenceError
  ) throw error;
  if (databaseConflict(error)) throw new NewcomerConflictError();
  throw new NewcomerPersistenceError();
}

export interface CreateNewcomerStatusInput {
  key: string;
  category: 'open' | 'closed';
  sort: number;
  active: boolean;
  labelEn: string;
  labelZh: string;
}

export async function createNewcomerStatus(
  db: AppDb,
  user: SessionUser | null,
  input: CreateNewcomerStatusInput,
): Promise<number> {
  assertSuperAdmin(user);
  const row = plainRow(input, ['key', 'category', 'sort', 'active', 'labelEn', 'labelZh']);
  const key = row && typeof row.key === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(row.key) ? row.key : null;
  const category = row?.category === 'open' || row?.category === 'closed' ? row.category : null;
  const active = row ? row.active : null;
  if (!key || !category || !validSort(row?.sort) || typeof active !== 'boolean') throw new NewcomerInvalidError();
  const labelEn = boundedSettingText(row.labelEn, 100);
  const labelZh = boundedSettingText(row.labelZh, 100);
  try {
    const statements = [
      db.prepare(`
        INSERT INTO newcomer_statuses (id,key,category,sort,active,is_initial)
        SELECT CASE WHEN COUNT(*)<100 THEN COALESCE(MAX(id),5)+1 ELSE 0 END,
          ?1,?2,?3,?4,0 FROM newcomer_statuses
        RETURNING id
      `).bind(key, category, row.sort, active ? 1 : 0),
      db.prepare(`INSERT INTO newcomer_status_i18n (status_id,locale,label)
        SELECT id,'en',?1 FROM newcomer_statuses WHERE key=?2 RETURNING status_id`).bind(labelEn, key),
      db.prepare(`INSERT INTO newcomer_status_i18n (status_id,locale,label)
        SELECT id,'zh',?1 FROM newcomer_statuses WHERE key=?2 RETURNING status_id`).bind(labelZh, key),
    ];
    const results = batchResults(await db.batch(statements), statements.length);
    const created = resultRows(results[0], 1);
    if (created.length === 0) throw new NewcomerLimitError();
    const createdRow = plainRow(created[0], ['id']);
    const id = createdRow ? positiveId(createdRow.id) : null;
    if (id === null || id <= 5) throw new NewcomerPersistenceError();
    for (let index = 1; index < results.length; index += 1) mutationRows(results[index], 1);
    return id;
  } catch (error) {
    rethrowMutation(error);
  }
}

export interface UpdateNewcomerStatusInput {
  id: number;
  sort: number;
  active: boolean;
  initialStatusId: number;
  labelEn: string;
  labelZh: string;
}

export async function updateNewcomerStatus(
  db: AppDb,
  user: SessionUser | null,
  input: UpdateNewcomerStatusInput,
): Promise<void> {
  assertSuperAdmin(user);
  const row = plainRow(input, ['id', 'sort', 'active', 'initialStatusId', 'labelEn', 'labelZh']);
  const id = row ? positiveId(row.id) : null;
  const initialStatusId = row ? positiveId(row.initialStatusId) : null;
  if (id === null || initialStatusId === null || !validSort(row?.sort) || typeof row?.active !== 'boolean') {
    throw new NewcomerInvalidError();
  }
  const labelEn = boundedSettingText(row.labelEn, 100);
  const labelZh = boundedSettingText(row.labelZh, 100);
  const active = row.active ? 1 : 0;
  try {
    const statements = [
      db.prepare(`
        UPDATE newcomer_statuses SET is_initial=0
        WHERE is_initial=1 AND id<>?1 AND EXISTS (
          SELECT 1 FROM newcomer_statuses target
          WHERE target.id=?1 AND target.category='open'
            AND ((target.id<>?2 AND target.active=1) OR (target.id=?2 AND ?3=1))
        )
      `).bind(initialStatusId, id, active),
      db.prepare(`UPDATE newcomer_statuses SET sort=?1,active=?2 WHERE id=?3 RETURNING id`)
        .bind(row.sort, active, id),
      db.prepare(`UPDATE newcomer_statuses SET is_initial=1
        WHERE id=? AND category='open' AND active=1 RETURNING id`).bind(initialStatusId),
      db.prepare(`INSERT INTO newcomer_status_i18n (status_id,locale,label) VALUES (?1,'en',?2)
        ON CONFLICT(status_id,locale) DO UPDATE SET label=excluded.label RETURNING status_id`).bind(id, labelEn),
      db.prepare(`INSERT INTO newcomer_status_i18n (status_id,locale,label) VALUES (?1,'zh',?2)
        ON CONFLICT(status_id,locale) DO UPDATE SET label=excluded.label RETURNING status_id`).bind(id, labelZh),
      db.prepare(`
        INSERT INTO newcomer_status_i18n (status_id,locale,label)
        SELECT 0,'en','guard' WHERE
          NOT EXISTS (SELECT 1 FROM newcomer_statuses WHERE id=?1 AND sort=?2 AND active=?3) OR
          NOT EXISTS (SELECT 1 FROM newcomer_statuses
            WHERE id=?4 AND active=1 AND category='open' AND is_initial=1) OR
          (SELECT COUNT(*) FROM newcomer_statuses
            WHERE active=1 AND category='open' AND is_initial=1)<>1
      `).bind(id, row.sort, active, initialStatusId),
    ];
    const results = batchResults(await db.batch(statements), statements.length);
    mutationRows(results[1], 1);
    mutationRows(results[2], 1);
    mutationRows(results[3], 1);
    mutationRows(results[4], 1);
    if (resultRows(results[5], 1).length !== 0) throw new NewcomerPersistenceError();
  } catch (error) {
    rethrowMutation(error);
  }
}

export interface NewcomerFieldOptionInput {
  value: string;
  sort: number;
  active: boolean;
  labelEn: string;
  labelZh: string;
}

interface SafeOption extends NewcomerFieldOptionInput {}

function safeOptions(value: unknown): SafeOption[] {
  const candidates = capturedArray(value, NEWCOMER_DB_LIMITS.optionsPerField);
  if (!candidates) throw new NewcomerInvalidError();
  const options: SafeOption[] = [];
  const values = new Set<string>();
  for (const candidate of candidates) {
    const row = plainRow(candidate, ['value', 'sort', 'active', 'labelEn', 'labelZh']);
    const optionValue = row && typeof row.value === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(row.value)
      ? row.value : null;
    if (!optionValue || values.has(optionValue) || !validSort(row?.sort) || typeof row?.active !== 'boolean') {
      throw new NewcomerInvalidError();
    }
    values.add(optionValue);
    options.push({
      value: optionValue,
      sort: row.sort,
      active: row.active,
      labelEn: boundedSettingText(row.labelEn, 100) as string,
      labelZh: boundedSettingText(row.labelZh, 100) as string,
    });
  }
  return options;
}

interface CommonFieldInput {
  required: boolean;
  active: boolean;
  sort: number;
  labelEn: string;
  labelZh: string;
  helpEn: string | null;
  helpZh: string | null;
  options: NewcomerFieldOptionInput[];
}

function safeFieldCommon(row: DataRow): CommonFieldInput {
  if (typeof row.required !== 'boolean' || typeof row.active !== 'boolean' || !validSort(row.sort)) {
    throw new NewcomerInvalidError();
  }
  return {
    required: row.required,
    active: row.active,
    sort: row.sort,
    labelEn: boundedSettingText(row.labelEn, 100) as string,
    labelZh: boundedSettingText(row.labelZh, 100) as string,
    helpEn: boundedSettingText(row.helpEn, 500, true),
    helpZh: boundedSettingText(row.helpZh, 500, true),
    options: safeOptions(row.options),
  };
}

function optionStatements(
  db: AppDb,
  fieldLookup: { column: 'key' | 'id'; value: string | number },
  options: SafeOption[],
) {
  const updateExisting = fieldLookup.column === 'id';
  const suffix = fieldLookup.column === 'key'
    ? { insert: 'key=?4', label: 'key=?3' }
    : { insert: "id=?4 AND fixed=0 AND type='select'", label: "id=?3 AND fixed=0 AND type='select'" };
  return options.flatMap((option) => [
    db.prepare(`INSERT INTO newcomer_field_options (field_id,value,sort,active)
      SELECT id,?1,?2,?3 FROM newcomer_fields WHERE ${suffix.insert}
      ${updateExisting ? 'ON CONFLICT(field_id,value) DO UPDATE SET sort=excluded.sort,active=excluded.active' : ''}
      RETURNING field_id,value`).bind(option.value, option.sort, option.active ? 1 : 0, fieldLookup.value),
    db.prepare(`INSERT INTO newcomer_field_option_i18n (field_id,value,locale,label)
      SELECT id,?1,'en',?2 FROM newcomer_fields WHERE ${suffix.label}
      ${updateExisting ? 'ON CONFLICT(field_id,value,locale) DO UPDATE SET label=excluded.label' : ''}
      RETURNING field_id,value`).bind(option.value, option.labelEn, fieldLookup.value),
    db.prepare(`INSERT INTO newcomer_field_option_i18n (field_id,value,locale,label)
      SELECT id,?1,'zh',?2 FROM newcomer_fields WHERE ${suffix.label}
      ${updateExisting ? 'ON CONFLICT(field_id,value,locale) DO UPDATE SET label=excluded.label' : ''}
      RETURNING field_id,value`).bind(option.value, option.labelZh, fieldLookup.value),
  ]);
}

export interface CreateNewcomerFieldInput extends CommonFieldInput {
  key: string;
  type: NewcomerFieldType;
}

export async function createNewcomerField(
  db: AppDb,
  user: SessionUser | null,
  input: CreateNewcomerFieldInput,
): Promise<number> {
  assertSuperAdmin(user);
  const row = plainRow(input, [
    'key', 'type', 'required', 'active', 'sort', 'labelEn', 'labelZh', 'helpEn', 'helpZh', 'options',
  ]);
  const key = row && typeof row.key === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(row.key) ? row.key : null;
  const type = row && isNewcomerFieldType(row.type) ? row.type : null;
  if (!row || !key || !type) throw new NewcomerInvalidError();
  const common = safeFieldCommon(row);
  if ((type === 'select') !== (common.options.length > 0) || (type === 'select' && !common.options.some((option) => option.active))) {
    throw new NewcomerInvalidError();
  }
  const newActiveOptions = common.options.filter((option) => option.active).length;
  try {
    const statements = [
      // A no-op write on one protected core row is the cross-backend mutex for
      // the global active-option cap. D1 serializes the batch; PostgreSQL waits
      // on this row so the following COUNT observes the preceding commit.
      db.prepare('UPDATE newcomer_fields SET sort=sort WHERE id=1 RETURNING id'),
      db.prepare(`
        INSERT INTO newcomer_fields (id,key,type,required,active,sort,fixed)
        SELECT CASE WHEN SUM(CASE WHEN id>7 THEN 1 ELSE 0 END)<100
          AND (SELECT COUNT(*) FROM newcomer_field_options WHERE active=1)+?6<=1000
          THEN COALESCE(MAX(id),7)+1 ELSE 0 END,?1,?2,?3,?4,?5,0 FROM newcomer_fields
        RETURNING id
      `).bind(key, type, common.required ? 1 : 0, common.active ? 1 : 0, common.sort, newActiveOptions),
      db.prepare(`INSERT INTO newcomer_field_i18n (field_id,locale,label,help)
        SELECT id,'en',?1,?2 FROM newcomer_fields WHERE key=?3 RETURNING field_id`)
        .bind(common.labelEn, common.helpEn, key),
      db.prepare(`INSERT INTO newcomer_field_i18n (field_id,locale,label,help)
        SELECT id,'zh',?1,?2 FROM newcomer_fields WHERE key=?3 RETURNING field_id`)
        .bind(common.labelZh, common.helpZh, key),
      ...optionStatements(db, { column: 'key', value: key }, common.options),
    ];
    const results = batchResults(await db.batch(statements), statements.length);
    mutationRows(results[0], 1);
    const created = resultRows(results[1], 1);
    if (created.length === 0) throw new NewcomerLimitError();
    const createdRow = plainRow(created[0], ['id']);
    const id = createdRow ? positiveId(createdRow.id) : null;
    if (id === null || id <= 7) throw new NewcomerPersistenceError();
    for (let index = 2; index < results.length; index += 1) mutationRows(results[index], 1);
    return id;
  } catch (error) {
    rethrowMutation(error);
  }
}

export interface UpdateNewcomerFieldInput extends CommonFieldInput {
  id: number;
}

export async function updateNewcomerField(
  db: AppDb,
  user: SessionUser | null,
  input: UpdateNewcomerFieldInput,
): Promise<void> {
  assertSuperAdmin(user);
  const row = plainRow(input, [
    'id', 'required', 'active', 'sort', 'labelEn', 'labelZh', 'helpEn', 'helpZh', 'options',
  ]);
  if (!row) throw new NewcomerInvalidError();
  const id = positiveId(row.id);
  if (id === null) throw new NewcomerInvalidError();
  const common = safeFieldCommon(row);
  if (id <= 7 && (common.required || !common.active || common.options.length !== 0)) throw new NewcomerInvalidError();
  const optionCount = common.options.length;
  try {
    const optionWrites = optionStatements(db, { column: 'id', value: id }, common.options);
    const statements = [
      db.prepare('UPDATE newcomer_fields SET sort=sort WHERE id=1 RETURNING id'),
      db.prepare(`
        UPDATE newcomer_fields SET
          required=CASE WHEN fixed=1 THEN required ELSE ?1 END,
          active=CASE WHEN fixed=1 THEN active ELSE ?2 END,
          sort=?3
        WHERE id=?4 AND (
          (fixed=1 AND ?1=0 AND ?2=1 AND ?5=0) OR
          (fixed=0 AND (type='select' OR (type<>'select' AND ?5=0)))
        )
        RETURNING id,type,fixed
      `).bind(common.required ? 1 : 0, common.active ? 1 : 0, common.sort, id, optionCount),
      db.prepare(`INSERT INTO newcomer_field_i18n (field_id,locale,label,help) VALUES (?1,'en',?2,?3)
        ON CONFLICT(field_id,locale) DO UPDATE SET label=excluded.label,help=excluded.help RETURNING field_id`)
        .bind(id, common.labelEn, common.helpEn),
      db.prepare(`INSERT INTO newcomer_field_i18n (field_id,locale,label,help) VALUES (?1,'zh',?2,?3)
        ON CONFLICT(field_id,locale) DO UPDATE SET label=excluded.label,help=excluded.help RETURNING field_id`)
        .bind(id, common.labelZh, common.helpZh),
      ...optionWrites,
      db.prepare(`
        INSERT INTO newcomer_field_i18n (field_id,locale,label)
        SELECT 0,'en','guard' WHERE
          NOT EXISTS (SELECT 1 FROM newcomer_fields field
            WHERE field.id=?1 AND field.required=?2 AND field.active=?3 AND field.sort=?4 AND (
              (field.fixed=1 AND ?2=0 AND ?3=1 AND ?5=0) OR
              (field.fixed=0 AND (field.type='select' OR (field.type<>'select' AND ?5=0)))
            )) OR
          (SELECT COUNT(*) FROM newcomer_field_options WHERE field_id=?1)>100 OR
          EXISTS (SELECT 1 FROM newcomer_fields field WHERE field.id=?1 AND (
            (field.fixed=1 AND EXISTS (SELECT 1 FROM newcomer_field_options option WHERE option.field_id=field.id)) OR
            (field.type<>'select' AND EXISTS (SELECT 1 FROM newcomer_field_options option WHERE option.field_id=field.id)) OR
            (field.fixed=0 AND field.type='select' AND NOT EXISTS (
              SELECT 1 FROM newcomer_field_options option WHERE option.field_id=field.id AND option.active=1
            ))
          )) OR
          (SELECT COUNT(*) FROM newcomer_field_options WHERE active=1)>1000
      `).bind(id, common.required ? 1 : 0, common.active ? 1 : 0, common.sort, optionCount),
    ];
    const results = batchResults(await db.batch(statements), statements.length);
    mutationRows(results[0], 1);
    mutationRows(results[1], 1);
    mutationRows(results[2], 1);
    mutationRows(results[3], 1);
    for (let index = 4; index < 4 + optionWrites.length; index += 1) mutationRows(results[index], 1);
    if (resultRows(results[results.length - 1], 1).length !== 0) throw new NewcomerPersistenceError();
  } catch (error) {
    rethrowMutation(error);
  }
}
