import { describe, expect, it } from 'vitest';
import {
  NEWCOMER_VALIDATION_LIMITS,
  normalizeNewcomerEmail,
  normalizeNewcomerPhone,
  parseNewcomerQueueFilters,
  validateNewcomerIntake,
  type NewcomerIntakeDefinition,
} from '../src/lib/newcomerValidation';

const definition = (): NewcomerIntakeDefinition => ({
  activeServiceTypeIds: [10, 20],
  fields: [
    { id: 8, key: 'welcome_note', type: 'text', required: true, options: [] },
    { id: 9, key: 'background', type: 'textarea', required: false, options: [] },
    { id: 10, key: 'next_step', type: 'select', required: true, options: ['learn', 'serve'] },
    { id: 11, key: 'needs_ride', type: 'checkbox', required: false, options: [] },
  ],
});

const validRaw = () => ({
  name: '  Ada Visitor  ',
  email: '  ADA@Example.Test ',
  phone: '+1 (312) 555-0100',
  locale: 'en',
  visitDate: '2028-02-29',
  serviceTypeId: 10,
  contactConsent: true,
  answers: [
    { fieldId: 8, value: '  Hello  ' },
    { fieldId: 9, value: 'A longer answer' },
    { fieldId: 10, value: 'learn' },
    { fieldId: 11, value: false },
  ],
});

describe('newcomer contact normalization', () => {
  it('normalizes conservative ASCII dot-atom email and international phone separators', () => {
    expect(normalizeNewcomerEmail("  User.Name+tag/box!#$%&'*=?^_`{|}~-@Sub-Domain.Example  ")).toEqual({
      ok: true,
      value: "user.name+tag/box!#$%&'*=?^_`{|}~-@sub-domain.example",
    });
    expect(normalizeNewcomerPhone(' +1 (312) 555-0100. ')).toEqual({
      ok: true,
      value: '+13125550100',
    });
  });

  it.each([
    ['email', 'a@@example.test'],
    ['email', '@example.test'],
    ['email', 'éxample@example.test'],
    ['email', '.a@example.test'],
    ['email', 'a.@example.test'],
    ['email', 'a..b@example.test'],
    ['email', 'a@localhost'],
    ['email', 'a@-example.test'],
    ['email', 'a@example-.test'],
    ['email', 'a@example..test'],
    ['email', 'a@example_test.test'],
    ['email', `a${String.fromCharCode(0)}@example.test`],
    ['email', `${'名'.repeat(83)}@x.test`],
    ['phone', '13125550100'],
    ['phone', '+1/312/555/0100'],
    ['phone', "+1'3125550100"],
    ['phone', '+03125550100'],
    ['phone', '+123456'],
    ['phone', '+1234567890123456'],
  ])('rejects invalid %s without echoing its value', (kind, value) => {
    const result = kind === 'email' ? normalizeNewcomerEmail(value) : normalizeNewcomerPhone(value);
    expect(result).toEqual({ ok: false, code: `newcomer_${kind}_invalid` });
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it('enforces the exact 254-byte normalized email boundary', () => {
    expect(normalizeNewcomerEmail(`${'a'.repeat(242)}@example.com`)).toMatchObject({ ok: true });
    expect(normalizeNewcomerEmail(`${'a'.repeat(243)}@example.com`))
      .toEqual({ ok: false, code: 'newcomer_email_invalid' });
  });
});

describe('shared newcomer intake validation', () => {
  it('returns a detached canonical public value with custom answers', () => {
    const raw = validRaw();
    const result = validateNewcomerIntake('public', raw, definition());
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Ada Visitor',
        email: 'ada@example.test',
        phone: '+13125550100',
        locale: 'en',
        visitDate: '2028-02-29',
        serviceTypeId: 10,
        contactConsent: true,
        answers: [
          { fieldId: 8, value: 'Hello' },
          { fieldId: 9, value: 'A longer answer' },
          { fieldId: 10, value: 'learn' },
          { fieldId: 11, value: 'false' },
        ],
      },
    });
    raw.name = 'Changed';
    raw.answers[0].value = 'Changed';
    expect(result.ok && result.value.name).toBe('Ada Visitor');
    expect(result.ok && result.value.answers[0].value).toBe('Hello');
  });

  it('requires public consent but preserves a truthful false staff value', () => {
    const publicResult = validateNewcomerIntake('public', { ...validRaw(), contactConsent: false }, definition());
    expect(publicResult).toMatchObject({ ok: false, issues: [{ code: 'newcomer_consent_required' }] });
    const staffResult = validateNewcomerIntake('staff', { ...validRaw(), contactConsent: false }, definition());
    expect(staffResult.ok && staffResult.value.contactConsent).toBe(false);
  });

  it('reports wrong-type contacts as field-specific invalid values instead of treating them as absent', () => {
    const result = validateNewcomerIntake('staff', {
      ...validRaw(), email: 1234, phone: { private: 'do-not-coerce' },
    }, definition());
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        { code: 'newcomer_email_invalid', field: 'email' },
        { code: 'newcomer_phone_invalid', field: 'phone' },
      ]),
    });
    expect(JSON.stringify(result)).not.toContain('do-not-coerce');
  });

  it('never coerces definition or queue enum objects while failing closed', () => {
    let coercions = 0;
    const hostileEnum = {
      toString() { coercions += 1; return 'text'; },
      valueOf() { coercions += 1; return 'text'; },
      [Symbol.toPrimitive]() { coercions += 1; return 'text'; },
    };
    const hostileDefinition = definition() as unknown as { activeServiceTypeIds: number[]; fields: Array<Record<string, unknown>> };
    hostileDefinition.fields[0].type = hostileEnum;
    expect(validateNewcomerIntake('public', validRaw(), hostileDefinition as never))
      .toMatchObject({ ok: false, issues: [{ code: 'newcomer_definition_invalid' }] });
    expect(parseNewcomerQueueFilters({ due: hostileEnum }))
      .toEqual({ ok: false, code: 'newcomer_queue_filters_invalid' });
    expect(coercions).toBe(0);
  });

  it.each([
    [{ ...validRaw(), name: '' }, 'newcomer_name_required'],
    [{ ...validRaw(), email: '', phone: '' }, 'newcomer_contact_required'],
    [{ ...validRaw(), locale: 'fr' }, 'newcomer_locale_invalid'],
    [{ ...validRaw(), visitDate: '2026-02-30' }, 'newcomer_visit_date_invalid'],
    [{ ...validRaw(), serviceTypeId: 999 }, 'newcomer_service_invalid'],
    [{ ...validRaw(), answers: [{ fieldId: 999, value: 'unknown' }] }, 'newcomer_answer_unknown'],
    [{ ...validRaw(), answers: [{ fieldId: 8, value: 'one' }, { fieldId: 8, value: 'two' }] }, 'newcomer_answer_duplicate'],
    [{ ...validRaw(), answers: [{ fieldId: 8, value: 'ok' }, { fieldId: 10, value: 'hidden' }] }, 'newcomer_answer_option_invalid'],
    [{ ...validRaw(), answers: [] }, 'newcomer_answer_required'],
    [{ ...validRaw(), answers: [{ fieldId: 8, value: 'ok' }, { fieldId: 10, value: 'learn' }, { fieldId: 11, value: 'yes' }] }, 'newcomer_answer_checkbox_invalid'],
  ])('rejects invalid intake with stable PII-free issue %s', (raw, code) => {
    const result = validateNewcomerIntake('public', raw, definition());
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.some((issue) => issue.code === code)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Ada@Example');
  });

  it('uses UTF-8 byte limits at exact boundaries', () => {
    const exact = validateNewcomerIntake('public', {
      ...validRaw(),
      name: '名'.repeat(66) + 'aa', // 200 bytes
      answers: [
        { fieldId: 8, value: '名'.repeat(166) + 'aa' }, // 500 bytes
        { fieldId: 10, value: 'learn' },
      ],
    }, definition());
    expect(exact.ok).toBe(true);
    const tooLarge = validateNewcomerIntake('public', {
      ...validRaw(),
      name: '名'.repeat(67),
    }, definition());
    expect(tooLarge).toMatchObject({ ok: false, issues: [{ code: 'newcomer_name_invalid' }] });
  });

  it('fails closed before invoking accessors, proxies, or changing-length arrays', () => {
    let invoked = false;
    const getter = { ...validRaw() } as Record<string, unknown>;
    Object.defineProperty(getter, 'name', { enumerable: true, get() { invoked = true; return 'Private'; } });
    const getterResult = validateNewcomerIntake('public', getter, definition());
    expect(getterResult).toMatchObject({ ok: false, issues: [{ code: 'newcomer_input_invalid' }] });
    expect(invoked).toBe(false);

    const proxied = new Proxy(validRaw(), { ownKeys() { throw new Error('trap'); } });
    expect(validateNewcomerIntake('public', proxied, definition()))
      .toMatchObject({ ok: false, issues: [{ code: 'newcomer_input_invalid' }] });

    const answers = validRaw().answers;
    Object.defineProperty(answers, 'length', { value: 1 });
    expect(validateNewcomerIntake('public', { ...validRaw(), answers }, definition()))
      .toMatchObject({ ok: false });
  });

  it('enforces descriptor and catalog count limits without truncation', () => {
    const tooManyAnswers = Array.from({ length: NEWCOMER_VALIDATION_LIMITS.maxAnswers + 1 }, (_, index) => ({
      fieldId: 8 + index,
      value: 'x',
    }));
    const limited = validateNewcomerIntake('public', { ...validRaw(), answers: tooManyAnswers }, definition());
    expect(limited.ok).toBe(false);
    expect(!limited.ok && limited.issues[0]?.code).toBe('newcomer_answers_limit');
    const unknown = { ...validRaw(), privateContact: 'do-not-read' };
    expect(validateNewcomerIntake('public', unknown, definition()))
      .toMatchObject({ ok: false, issues: [{ code: 'newcomer_input_invalid' }] });
  });
});

describe('newcomer queue filter parser', () => {
  it('parses a bounded strict filter model and defaults pagination', () => {
    expect(parseNewcomerQueueFilters({
      statusId: '2', assigneePersonId: '7', due: 'overdue', visitFrom: '2026-08-01',
      visitTo: '2026-08-31', serviceTypeId: '10', source: 'staff', page: '3', limit: '50',
    })).toEqual({
      ok: true,
      value: {
        statusId: 2, assigneePersonId: 7, due: 'overdue', visitFrom: '2026-08-01',
        visitTo: '2026-08-31', serviceTypeId: 10, source: 'staff', page: 3, limit: 50,
      },
    });
    expect(parseNewcomerQueueFilters({})).toMatchObject({ ok: true, value: { page: 1, limit: 25 } });
  });

  it.each([
    [{ statusId: ['1', '2'] }],
    [{ statusId: '0' }],
    [{ due: 'tomorrow' }],
    [{ visitFrom: '2026-02-30' }],
    [{ visitFrom: '2026-09-01', visitTo: '2026-08-01' }],
    [{ source: 'import' }],
    [{ page: '10001' }],
    [{ limit: '101' }],
    [{ q: 'private@example.test' }],
  ])('rejects ambiguous, invalid, or unknown filters without echoing values', (input) => {
    const result = parseNewcomerQueueFilters(input);
    expect(result).toEqual({ ok: false, code: 'newcomer_queue_filters_invalid' });
    expect(JSON.stringify(result)).not.toContain('private@example.test');
  });
});
