import { describe, expect, it } from 'vitest';
import {
  PEOPLE_IMPORT_HEADERS,
  PEOPLE_IMPORT_LIMITS,
  parsePeopleImport,
  type PeopleImportHeader,
} from '../src/lib/peopleImport';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const quoteCell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

const csvBytes = (
  records: Array<Partial<Record<PeopleImportHeader, string>>>,
  headers: readonly string[] = PEOPLE_IMPORT_HEADERS,
): Uint8Array => {
  const lines = [
    headers.map(quoteCell).join(','),
    ...records.map((record) =>
      headers
        .map((header) => quoteCell(record[header as PeopleImportHeader] ?? ''))
        .join(','),
    ),
  ];
  return encode(`${lines.join('\n')}\n`);
};

const parse = (
  records: Array<Partial<Record<PeopleImportHeader, string>>>,
  headers: readonly string[] = PEOPLE_IMPORT_HEADERS,
) => parsePeopleImport(csvBytes(records, headers), { today: '2026-08-11' });

const validPerson = (overrides: Partial<Record<PeopleImportHeader, string>> = {}) => ({
  record_type: 'person',
  display_name: 'Alice Example',
  email: 'alice@example.com',
  ...overrides,
});

const validDependent = (overrides: Partial<Record<PeopleImportHeader, string>> = {}) => ({
  record_type: 'dependent',
  display_name: 'Child Example',
  household_key: 'example-family',
  ...overrides,
});

describe('parsePeopleImport headers and parser boundaries', () => {
  it('normalizes a valid person without importing privileges', () => {
    const result = parse([
      validPerson({
        record_type: ' PERSON ',
        display_name: ' Alice ',
        email: ' ALICE@EXAMPLE.COM ',
        first_name: ' Alice ',
        last_name: ' Example ',
      }),
    ]);

    expect(result).toEqual({
      model: {
        people: [
          {
            row: 2,
            recordType: 'person',
            displayName: 'Alice',
            email: 'alice@example.com',
            firstName: 'Alice',
            lastName: 'Example',
            phone: null,
            language: null,
            membershipStatus: 'visitor',
            birthday: null,
            joinedOn: null,
            address: null,
            active: true,
            role: 'member',
            household: null,
          },
        ],
        dependents: [],
        households: [],
        summary: { dataRows: 1, people: 1, dependents: 0, households: 0, inactivePeople: 0 },
      },
      errors: [],
      warnings: [],
    });
  });

  it('accepts canonical headers in a different order and pads short rows', () => {
    const headers = ['email', 'record_type', 'display_name', ...PEOPLE_IMPORT_HEADERS.filter((header) => !['email', 'record_type', 'display_name'].includes(header))];
    const result = parse([validPerson()], headers);

    expect(result.errors).toEqual([]);
    expect(result.model?.people[0]).toMatchObject({ email: 'alice@example.com', displayName: 'Alice Example' });

    const short = encode(`${headers.join(',')}\nalice@example.com,person,Alice\n`);
    expect(parsePeopleImport(short, { today: '2026-08-11' }).errors).toEqual([]);
  });

  it('rejects empty input and input without a meaningful header', () => {
    expect(parsePeopleImport(encode(''), { today: '2026-08-11' })).toEqual({
      model: null,
      errors: [{ severity: 'error', code: 'empty_file', row: null, field: null }],
      warnings: [],
    });
    expect(parsePeopleImport(encode(' , \n'), { today: '2026-08-11' })).toEqual({
      model: null,
      errors: [{ severity: 'error', code: 'missing_header', row: 1, field: null }],
      warnings: [],
    });
  });

  it('blocks duplicate, unknown, missing, and uppercase headers without echoing unknown text', () => {
    const headers: string[] = [...PEOPLE_IMPORT_HEADERS];
    headers[1] = 'email';
    headers[3] = 'mystery_pii';
    headers[4] = 'DISPLAY_NAME';
    const result = parsePeopleImport(encode(`${headers.join(',')}\n`), { today: '2026-08-11' });

    expect(result.model).toBeNull();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        { severity: 'error', code: 'duplicate_header', row: 1, field: 'email' },
        { severity: 'error', code: 'unknown_header', row: 1, field: null },
        { severity: 'error', code: 'missing_header', row: 1, field: 'display_name' },
        { severity: 'error', code: 'missing_header', row: 1, field: 'first_name' },
      ]),
    );
    expect(JSON.stringify(result.errors)).not.toContain('mystery_pii');
    expect(JSON.stringify(result.errors)).not.toContain('DISPLAY_NAME');
  });

  it.each([
    ['invalid UTF-8', new Uint8Array([0xc3, 0x28]), 'invalid_utf8', null],
    ['NUL', encode('record_type\0'), 'nul_byte', null],
    ['unclosed quote', encode('"record_type'), 'unclosed_quote', 1],
    ['illegal quote', encode('record"_type'), 'illegal_quote', 1],
    ['lone CR', encode('record_type\rdisplay_name'), 'lone_cr', 1],
  ])('maps the %s parser error to a safe domain issue', (_label, bytes, code, row) => {
    expect(parsePeopleImport(bytes, { today: '2026-08-11' })).toEqual({
      model: null,
      errors: [{ severity: 'error', code, row, field: null }],
      warnings: [],
    });
  });

  it('maps byte, retained-row, column, and cell caps to safe domain issues', () => {
    const oversized = new Uint8Array(PEOPLE_IMPORT_LIMITS.maxBytes + 1);
    expect(parsePeopleImport(oversized, { today: '2026-08-11' }).errors).toEqual([
      { severity: 'error', code: 'file_too_large', row: null, field: null },
    ]);

    const rows = Array.from({ length: PEOPLE_IMPORT_LIMITS.maxDataRows + 1 }, (_, index) =>
      validPerson({ email: `person-${index}@example.com` }),
    );
    expect(parse(rows).errors).toEqual([
      { severity: 'error', code: 'too_many_rows', row: 202, field: null },
    ]);

    const tooManyColumns = `${PEOPLE_IMPORT_HEADERS.join(',')},extra\n`;
    expect(parsePeopleImport(encode(tooManyColumns), { today: '2026-08-11' }).errors).toEqual([
      { severity: 'error', code: 'too_many_columns', row: 1, field: null },
    ]);

    const tooLong = csvBytes([validPerson({ display_name: 'x'.repeat(PEOPLE_IMPORT_LIMITS.maxCellChars + 1) })]);
    expect(parsePeopleImport(tooLong, { today: '2026-08-11' }).errors).toEqual([
      { severity: 'error', code: 'cell_too_long', row: 2, field: null },
    ]);
  });

  it.each(['2026-8-11', '2026-02-30', '', 'not-a-date'])('throws for invalid programmer-supplied today: %s', (today) => {
    expect(() => parsePeopleImport(csvBytes([validPerson()]), { today })).toThrow(RangeError);
  });
});

describe('parsePeopleImport person fields', () => {
  it.each([
    ['record_type', validPerson({ record_type: '' })],
    ['display_name', validPerson({ display_name: '' })],
    ['email', validPerson({ email: '' })],
  ] as const)('requires %s and excludes the invalid row', (field, record) => {
    const result = parse([record]);
    expect(result.errors).toContainEqual({ severity: 'error', code: 'required', row: 2, field });
    expect(result.model?.people).toEqual([]);
    expect(result.model?.summary.dataRows).toBe(0);
  });

  it.each([
    ['display_name', 80],
    ['first_name', 80],
    ['last_name', 80],
    ['phone', 40],
    ['address', 200],
    ['household_name', 80],
    ['household_address', 200],
    ['household_phone', 40],
  ] as const)('enforces the %s code-point limit', (field, limit) => {
    const boundary = parse([validPerson({ [field]: '😀'.repeat(limit), ...(field.startsWith('household_') ? { household_key: 'family', household_role: 'adult', household_primary: 'true' } : {}) })]);
    expect(boundary.errors).toEqual([]);

    const over = parse([validPerson({ [field]: '😀'.repeat(limit + 1), ...(field.startsWith('household_') ? { household_key: 'family', household_role: 'adult', household_primary: 'true' } : {}) })]);
    expect(over.errors).toContainEqual({ severity: 'error', code: 'too_long', row: 2, field });
    expect(over.model?.people).toEqual([]);
  });

  it('enforces the email length and format after normalization', () => {
    const tooLongEmail = `${'a'.repeat(243)}@example.com`;
    expect(tooLongEmail).toHaveLength(255);
    expect(parse([validPerson({ email: tooLongEmail })]).errors).toContainEqual({
      severity: 'error', code: 'too_long', row: 2, field: 'email',
    });
    expect(parse([validPerson({ email: 'not-an-email' })]).errors).toContainEqual({
      severity: 'error', code: 'invalid_email', row: 2, field: 'email',
    });
  });

  it.each([
    ['language', 'fr'],
    ['membership_status', 'prospect'],
    ['active', 'yes'],
  ] as const)('rejects an unsupported %s option', (field, value) => {
    expect(parse([validPerson({ [field]: value })]).errors).toContainEqual({
      severity: 'error', code: 'invalid_option', row: 2, field,
    });
  });

  it('normalizes supported language, membership status, and strict active booleans', () => {
    const result = parse([
      validPerson({ language: ' ZH ', membership_status: ' MEMBER ', active: ' FALSE ' }),
      validPerson({ email: 'second@example.com', active: ' true ' }),
    ]);
    expect(result.errors).toEqual([]);
    expect(result.model?.people).toMatchObject([
      { language: 'zh', membershipStatus: 'member', active: false },
      { language: null, membershipStatus: 'visitor', active: true },
    ]);
    expect(result.model?.summary.inactivePeople).toBe(1);
  });

  it.each([
    ['birthday', '2026-02-30', 'invalid_date'],
    ['joined_on', '2026-00-01', 'invalid_date'],
    ['birthday', '2026-08-12', 'future_date'],
  ] as const)('rejects %s=%s with %s', (field, value, code) => {
    expect(parse([validPerson({ [field]: value })]).errors).toContainEqual({
      severity: 'error', code, row: 2, field,
    });
  });

  it('accepts strict dates, including a future joined_on date', () => {
    const result = parse([validPerson({ birthday: '2000-02-29', joined_on: '2027-01-01' })]);
    expect(result.errors).toEqual([]);
    expect(result.model?.people[0]).toMatchObject({ birthday: '2000-02-29', joinedOn: '2027-01-01' });
  });

  it.each(['Name', 'Address', '555-0100', 'adult', 'true'])('blocks household metadata without a household key', (value) => {
    const field = ['Name', 'Address', '555-0100', 'adult', 'true'].indexOf(value);
    const key = ['household_name', 'household_address', 'household_phone', 'household_role', 'household_primary'][field] as PeopleImportHeader;
    expect(parse([validPerson({ [key]: value })]).errors).toContainEqual({
      severity: 'error', code: 'household_fields_without_key', row: 2, field: key,
    });
  });

  it.each([
    [{ household_key: 'bad key', household_role: 'adult', household_primary: 'true' }, 'household_key', 'invalid_option'],
    [{ household_key: 'family', household_role: '', household_primary: 'true' }, 'household_role', 'required'],
    [{ household_key: 'family', household_role: 'parent', household_primary: 'true' }, 'household_role', 'invalid_option'],
    [{ household_key: 'family', household_role: 'adult', household_primary: '' }, 'household_primary', 'required'],
    [{ household_key: 'family', household_role: 'adult', household_primary: 'yes' }, 'household_primary', 'invalid_option'],
  ] as const)('validates household person fields %#', (household, field, code) => {
    expect(parse([validPerson(household)]).errors).toContainEqual({ severity: 'error', code, row: 2, field });
  });

  it('normalizes a valid person household reference without grouping it yet', () => {
    const result = parse([validPerson({
      household_key: ' FAMILY.ONE ',
      household_name: ' Example Family ',
      household_address: ' 1 Main St ',
      household_phone: ' 555-0100 ',
      household_role: ' ADULT ',
      household_primary: ' TRUE ',
    })]);
    expect(result.errors).toEqual([]);
    expect(result.model?.people[0].household).toEqual({
      key: 'family.one', name: 'Example Family', address: '1 Main St', phone: '555-0100', role: 'adult', primary: true,
    });
    expect(result.model?.households).toEqual([]);
  });
});

describe('parsePeopleImport dependent fields and issue safety', () => {
  it('normalizes a dependent with a default child role and no person record', () => {
    const result = parse([validDependent({ display_name: ' Child ', household_key: ' FAMILY ' })]);
    expect(result).toMatchObject({
      model: {
        people: [],
        dependents: [{
          row: 2,
          recordType: 'dependent',
          displayName: 'Child',
          household: { key: 'family', name: null, address: null, phone: null, role: 'child', primary: false },
        }],
        households: [],
        summary: { dataRows: 1, people: 0, dependents: 1, households: 0, inactivePeople: 0 },
      },
      errors: [],
      warnings: [],
    });
  });

  it.each([
    ['display_name', validDependent({ display_name: '' })],
    ['household_key', validDependent({ household_key: '' })],
  ] as const)('requires dependent %s', (field, record) => {
    expect(parse([record]).errors).toContainEqual({ severity: 'error', code: 'required', row: 2, field });
  });

  it('rejects an invalid dependent key and primary true or invalid primary value', () => {
    expect(parse([validDependent({ household_key: 'bad key' })]).errors).toContainEqual({
      severity: 'error', code: 'invalid_option', row: 2, field: 'household_key',
    });
    expect(parse([validDependent({ household_primary: 'true' })]).errors).toContainEqual({
      severity: 'error', code: 'invalid_option', row: 2, field: 'household_primary',
    });
    expect(parse([validDependent({ household_primary: 'yes' })]).errors).toContainEqual({
      severity: 'error', code: 'invalid_option', row: 2, field: 'household_primary',
    });
  });

  it.each(['email', 'first_name', 'last_name', 'phone', 'language', 'membership_status', 'birthday', 'joined_on', 'address', 'active'] as const)(
    'rejects the dependent person-only field %s',
    (field) => {
      const pii = `PRIVATE-${field}@example.com`;
      const result = parse([validDependent({ [field]: pii })]);
      expect(result.errors).toContainEqual({ severity: 'error', code: 'forbidden_field', row: 2, field });
      expect(result.model?.dependents).toEqual([]);
      expect(JSON.stringify(result.errors)).not.toContain(pii);
    },
  );

  it('caps all issues at 100 with one terminal safe truncation issue', () => {
    const records = Array.from({ length: 20 }, () =>
      validDependent({
        email: 'private@example.com', first_name: 'private', last_name: 'private', phone: 'private',
        language: 'private', membership_status: 'private', birthday: 'private', joined_on: 'private',
        address: 'private', active: 'private', household_primary: 'true',
      }),
    );
    const result = parse(records);
    expect(result.errors).toHaveLength(100);
    expect(result.errors.at(-1)).toEqual({ severity: 'error', code: 'issues_truncated', row: null, field: null });
  });

  it('does not echo invalid record types, names, or emails in serialized issues', () => {
    const secrets = ['PRIVATE_RECORD', 'Private Name', 'PRIVATE@EXAMPLE.COM'];
    const result = parse([{
      record_type: secrets[0], display_name: secrets[1], email: secrets[2],
    }]);
    expect(result.model?.people).toEqual([]);
    expect(result.model?.dependents).toEqual([]);
    expect(result.errors).toContainEqual({ severity: 'error', code: 'invalid_option', row: 2, field: 'record_type' });
    for (const secret of secrets) expect(JSON.stringify(result.errors)).not.toContain(secret);
  });
});
