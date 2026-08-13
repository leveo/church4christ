import { isValidDateStr } from './dates';

const UTF8 = new TextEncoder();
const KEY = /^[a-z][a-z0-9_]{0,63}$/;
const OPTION = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const EMAIL_LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const EMAIL_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export const NEWCOMER_VALIDATION_LIMITS = {
  maxNameBytes: 200,
  maxEmailBytes: 254,
  maxTextBytes: 500,
  maxTextareaBytes: 4_000,
  maxAnswerBytes: 32 * 1024,
  maxAnswers: 100,
  maxCustomFields: 100,
  maxOptionsPerField: 100,
  maxOptionsTotal: 1_000,
  maxServiceTypes: 100,
  maxIssues: 25,
  maxPage: 10_000,
  maxPageSize: 100,
} as const;

export type NewcomerFieldType = 'text' | 'textarea' | 'select' | 'checkbox';

export function isNewcomerFieldType(value: unknown): value is NewcomerFieldType {
  return value === 'text' || value === 'textarea' || value === 'select' || value === 'checkbox';
}

export interface NewcomerIntakeFieldDefinition {
  id: number;
  key: string;
  type: NewcomerFieldType;
  required: boolean;
  options: readonly string[];
}

export interface NewcomerIntakeDefinition {
  activeServiceTypeIds: readonly number[];
  fields: readonly NewcomerIntakeFieldDefinition[];
}

export type NewcomerNormalizationResult =
  | { ok: true; value: string }
  | { ok: false; code: 'newcomer_email_invalid' | 'newcomer_phone_invalid' };

export type NewcomerValidationIssue = {
  code: string;
  field?: 'input' | 'name' | 'email' | 'phone' | 'locale' | 'visitDate' | 'serviceTypeId' | 'contactConsent' | 'answers';
  fieldId?: number;
};

export interface ValidatedNewcomerAnswer {
  fieldId: number;
  value: string;
}

export interface ValidatedNewcomerIntake {
  name: string;
  email: string | null;
  phone: string | null;
  locale: 'en' | 'zh';
  visitDate: string;
  serviceTypeId: number | null;
  contactConsent: boolean;
  answers: ValidatedNewcomerAnswer[];
}

export type NewcomerIntakeValidationResult =
  | { ok: true; value: ValidatedNewcomerIntake }
  | { ok: false; issues: NewcomerValidationIssue[] };

type DataRecord = Record<string, unknown>;

function bytes(value: string): number {
  return UTF8.encode(value).byteLength;
}

function normalizeText(value: string): string | null {
  try {
    const normalized = value.normalize('NFC').trim();
    return normalized.includes('\0') ? null : normalized;
  } catch {
    return null;
  }
}

function plainDataRecord(value: unknown, allowed: readonly string[]): DataRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) return null;
    const snapshot: DataRecord = Object.create(null) as DataRecord;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function plainDataArray(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !('value' in lengthDescriptor)) return null;
    const length = lengthDescriptor.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum) return null;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== length + 1) return null;
    const out: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor)) return null;
      out.push(descriptor.value);
    }
    return out;
  } catch {
    return null;
  }
}

function positiveId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
    ? value
    : null;
}

export function normalizeNewcomerEmail(input: unknown): NewcomerNormalizationResult {
  if (typeof input !== 'string') return { ok: false, code: 'newcomer_email_invalid' };
  const text = normalizeText(input)?.toLowerCase();
  if (
    !text
    || bytes(text) < 3
    || bytes(text) > NEWCOMER_VALIDATION_LIMITS.maxEmailBytes
    || !/^[\x21-\x7e]+$/.test(text)
  ) return { ok: false, code: 'newcomer_email_invalid' };
  const first = text.indexOf('@');
  if (first < 1 || first !== text.lastIndexOf('@') || first === text.length - 1) {
    return { ok: false, code: 'newcomer_email_invalid' };
  }
  const localPart = text.slice(0, first);
  const domainPart = text.slice(first + 1);
  if (!EMAIL_LOCAL.test(localPart) || !EMAIL_DOMAIN.test(domainPart)) {
    return { ok: false, code: 'newcomer_email_invalid' };
  }
  return { ok: true, value: text };
}

export function normalizeNewcomerPhone(input: unknown): NewcomerNormalizationResult {
  if (typeof input !== 'string') return { ok: false, code: 'newcomer_phone_invalid' };
  const text = normalizeText(input);
  if (!text || !text.startsWith('+') || !/^\+[0-9 ()\-.]+$/.test(text)) {
    return { ok: false, code: 'newcomer_phone_invalid' };
  }
  const digits = text.slice(1).replaceAll(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15 || digits[0] === '0') {
    return { ok: false, code: 'newcomer_phone_invalid' };
  }
  return { ok: true, value: `+${digits}` };
}

type SafeDefinition = {
  fields: Map<number, NewcomerIntakeFieldDefinition>;
  serviceTypes: Set<number>;
};

function safeDefinition(value: unknown): SafeDefinition | null {
  const root = plainDataRecord(value, ['activeServiceTypeIds', 'fields']);
  if (!root) return null;
  const serviceValues = plainDataArray(root.activeServiceTypeIds, NEWCOMER_VALIDATION_LIMITS.maxServiceTypes);
  const fieldValues = plainDataArray(root.fields, NEWCOMER_VALIDATION_LIMITS.maxCustomFields);
  if (!serviceValues || !fieldValues) return null;
  const serviceTypes = new Set<number>();
  for (const candidate of serviceValues) {
    const id = positiveId(candidate);
    if (id === null || serviceTypes.has(id)) return null;
    serviceTypes.add(id);
  }
  const fields = new Map<number, NewcomerIntakeFieldDefinition>();
  const keys = new Set<string>();
  let optionCount = 0;
  for (const candidate of fieldValues) {
    const row = plainDataRecord(candidate, ['id', 'key', 'type', 'required', 'options']);
    if (!row) return null;
    const id = positiveId(row.id);
    const key = typeof row.key === 'string' ? row.key : '';
    const type = row.type;
    const options = plainDataArray(row.options, NEWCOMER_VALIDATION_LIMITS.maxOptionsPerField);
    if (
      id === null || id <= 7 || fields.has(id) || !KEY.test(key) || keys.has(key)
      || !isNewcomerFieldType(type)
      || typeof row.required !== 'boolean' || !options
    ) return null;
    const capturedOptions: string[] = [];
    const optionSet = new Set<string>();
    for (const option of options) {
      if (typeof option !== 'string' || !OPTION.test(option) || optionSet.has(option)) return null;
      optionSet.add(option);
      capturedOptions.push(option);
    }
    if ((type === 'select') !== (capturedOptions.length > 0)) return null;
    optionCount += capturedOptions.length;
    if (optionCount > NEWCOMER_VALIDATION_LIMITS.maxOptionsTotal) return null;
    fields.set(id, { id, key, type, required: row.required, options: capturedOptions });
    keys.add(key);
  }
  return { fields, serviceTypes };
}

function oneIssue(code: string, field: NewcomerValidationIssue['field'] = 'input'): NewcomerIntakeValidationResult {
  return { ok: false, issues: [{ code, field }] };
}

export function validateNewcomerIntake(
  mode: 'public' | 'staff',
  raw: unknown,
  definition: NewcomerIntakeDefinition,
): NewcomerIntakeValidationResult {
  if (mode !== 'public' && mode !== 'staff') return oneIssue('newcomer_input_invalid');
  const catalog = safeDefinition(definition);
  if (!catalog) return oneIssue('newcomer_definition_invalid');
  const input = plainDataRecord(raw, [
    'name', 'email', 'phone', 'locale', 'visitDate', 'serviceTypeId', 'contactConsent', 'answers',
  ]);
  if (!input) return oneIssue('newcomer_input_invalid');
  const issues: NewcomerValidationIssue[] = [];
  const add = (code: string, field?: NewcomerValidationIssue['field'], fieldId?: number) => {
    if (issues.length < NEWCOMER_VALIDATION_LIMITS.maxIssues) issues.push({ code, ...(field ? { field } : {}), ...(fieldId ? { fieldId } : {}) });
  };

  const name = typeof input.name === 'string' ? normalizeText(input.name) : null;
  if (!name) add('newcomer_name_required', 'name');
  else if (bytes(name) > NEWCOMER_VALIDATION_LIMITS.maxNameBytes || /[\x00-\x1f\x7f]/.test(name)) {
    add('newcomer_name_invalid', 'name');
  }

  const emailAbsent = input.email === null || input.email === undefined || input.email === '';
  const phoneAbsent = input.phone === null || input.phone === undefined || input.phone === '';
  let email: string | null = null;
  let phone: string | null = null;
  if (!emailAbsent) {
    const normalized = normalizeNewcomerEmail(input.email);
    if (normalized.ok) email = normalized.value;
    else add(normalized.code, 'email');
  }
  if (!phoneAbsent) {
    const normalized = normalizeNewcomerPhone(input.phone);
    if (normalized.ok) phone = normalized.value;
    else add(normalized.code, 'phone');
  }
  if (emailAbsent && phoneAbsent) add('newcomer_contact_required', 'input');

  const locale = input.locale === 'en' || input.locale === 'zh' ? input.locale : null;
  if (!locale) add('newcomer_locale_invalid', 'locale');
  const visitDate = typeof input.visitDate === 'string' && isValidDateStr(input.visitDate) ? input.visitDate : null;
  if (!visitDate) add('newcomer_visit_date_invalid', 'visitDate');
  let serviceTypeId: number | null = null;
  if (input.serviceTypeId !== null && input.serviceTypeId !== undefined && input.serviceTypeId !== '') {
    serviceTypeId = positiveId(input.serviceTypeId);
    if (serviceTypeId === null || !catalog.serviceTypes.has(serviceTypeId)) {
      serviceTypeId = null;
      add('newcomer_service_invalid', 'serviceTypeId');
    }
  }
  const contactConsent = typeof input.contactConsent === 'boolean' ? input.contactConsent : null;
  if (contactConsent === null) add('newcomer_consent_invalid', 'contactConsent');
  else if (mode === 'public' && !contactConsent) add('newcomer_consent_required', 'contactConsent');

  const answerValues = plainDataArray(input.answers, NEWCOMER_VALIDATION_LIMITS.maxAnswers);
  if (!answerValues) {
    add('newcomer_answers_limit', 'answers');
  }
  const answers: ValidatedNewcomerAnswer[] = [];
  const seenAnswers = new Set<number>();
  let answerBytes = 0;
  if (answerValues) {
    for (const candidate of answerValues) {
      const row = plainDataRecord(candidate, ['fieldId', 'value']);
      const fieldId = row ? positiveId(row.fieldId) : null;
      if (!row || fieldId === null) {
        add('newcomer_answer_invalid', 'answers');
        continue;
      }
      if (seenAnswers.has(fieldId)) {
        add('newcomer_answer_duplicate', 'answers', fieldId);
        continue;
      }
      seenAnswers.add(fieldId);
      const field = catalog.fields.get(fieldId);
      if (!field) {
        add('newcomer_answer_unknown', 'answers', fieldId);
        continue;
      }
      let value: string | null = null;
      if (field.type === 'checkbox') {
        if (typeof row.value === 'boolean') value = row.value ? 'true' : 'false';
        else add('newcomer_answer_checkbox_invalid', 'answers', fieldId);
      } else if (typeof row.value === 'string') {
        value = normalizeText(row.value);
        if (value === null || value === '') {
          if (field.required) add('newcomer_answer_required', 'answers', fieldId);
          value = null;
        } else if (field.type === 'select' && !field.options.includes(value)) {
          add('newcomer_answer_option_invalid', 'answers', fieldId);
          value = null;
        } else {
          const maximum = field.type === 'textarea'
            ? NEWCOMER_VALIDATION_LIMITS.maxTextareaBytes
            : NEWCOMER_VALIDATION_LIMITS.maxTextBytes;
          if (bytes(value) > maximum || value.includes('\0')) {
            add('newcomer_answer_invalid', 'answers', fieldId);
            value = null;
          }
        }
      } else {
        add('newcomer_answer_invalid', 'answers', fieldId);
      }
      if (value !== null) {
        answerBytes += bytes(value);
        answers.push({ fieldId, value });
      }
    }
  }
  for (const field of catalog.fields.values()) {
    if (field.required && !seenAnswers.has(field.id)) add('newcomer_answer_required', 'answers', field.id);
  }
  if (answerBytes > NEWCOMER_VALIDATION_LIMITS.maxAnswerBytes) add('newcomer_answers_limit', 'answers');

  if (issues.length > 0 || !name || !locale || !visitDate || contactConsent === null) return { ok: false, issues };
  answers.sort((left, right) => left.fieldId - right.fieldId);
  return {
    ok: true,
    value: { name, email, phone, locale, visitDate, serviceTypeId, contactConsent, answers },
  };
}

export interface NewcomerQueueFilters {
  statusId?: number;
  assigneePersonId?: number;
  due?: 'all' | 'overdue' | 'scheduled' | 'none';
  visitFrom?: string;
  visitTo?: string;
  serviceTypeId?: number;
  source?: 'public' | 'staff';
  page: number;
  limit: number;
}

export type NewcomerQueueFilterResult =
  | { ok: true; value: NewcomerQueueFilters }
  | { ok: false; code: 'newcomer_queue_filters_invalid' };

function queryInteger(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || value.length > 10) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

export function parseNewcomerQueueFilters(raw: unknown): NewcomerQueueFilterResult {
  const input = plainDataRecord(raw, [
    'statusId', 'assigneePersonId', 'due', 'visitFrom', 'visitTo', 'serviceTypeId', 'source', 'page', 'limit',
  ]);
  const invalid = (): NewcomerQueueFilterResult => ({ ok: false, code: 'newcomer_queue_filters_invalid' });
  if (!input) return invalid();
  const output: NewcomerQueueFilters = { page: 1, limit: 25 };
  for (const key of ['statusId', 'assigneePersonId', 'serviceTypeId'] as const) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;
    const parsed = queryInteger(input[key], 1, 2_147_483_647);
    if (parsed === null) return invalid();
    output[key] = parsed;
  }
  if (input.due !== undefined && input.due !== null && input.due !== '') {
    if (input.due !== 'all' && input.due !== 'overdue' && input.due !== 'scheduled' && input.due !== 'none') return invalid();
    output.due = input.due;
  }
  for (const key of ['visitFrom', 'visitTo'] as const) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;
    if (typeof input[key] !== 'string' || !isValidDateStr(input[key])) return invalid();
    output[key] = input[key];
  }
  if (output.visitFrom && output.visitTo && output.visitFrom > output.visitTo) return invalid();
  if (input.source !== undefined && input.source !== null && input.source !== '') {
    if (input.source !== 'public' && input.source !== 'staff') return invalid();
    output.source = input.source;
  }
  if (input.page !== undefined && input.page !== null && input.page !== '') {
    const page = queryInteger(input.page, 1, NEWCOMER_VALIDATION_LIMITS.maxPage);
    if (page === null) return invalid();
    output.page = page;
  }
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
    const limit = queryInteger(input.limit, 1, NEWCOMER_VALIDATION_LIMITS.maxPageSize);
    if (limit === null) return invalid();
    output.limit = limit;
  }
  return { ok: true, value: output };
}
