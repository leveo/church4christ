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

  it('requires exact canonical headers instead of trimming header cells', () => {
    const headers: string[] = [...PEOPLE_IMPORT_HEADERS];
    headers[0] = ' record_type';
    headers[2] = 'email ';
    const result = parsePeopleImport(encode(`${headers.join(',')}\n`), { today: '2026-08-11' });

    expect(result.model).toBeNull();
    expect(result.errors.filter((issue) => issue.code === 'unknown_header')).toHaveLength(2);
    expect(result.errors).toEqual(expect.arrayContaining([
      { severity: 'error', code: 'missing_header', row: 1, field: 'record_type' },
      { severity: 'error', code: 'missing_header', row: 1, field: 'email' },
    ]));
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
    const householdFields = field.startsWith('household_')
      ? {
          household_key: 'family',
          household_name: field === 'household_name' ? '😀'.repeat(limit) : 'Family',
          household_role: 'adult',
          household_primary: 'true',
        }
      : {};
    const boundary = parse([validPerson({ ...householdFields, [field]: '😀'.repeat(limit) })]);
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

  it('normalizes a valid person household reference and groups it', () => {
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
    expect(result.model?.households).toHaveLength(1);
    expect(result.model?.households[0]).toMatchObject({
      key: 'family.one',
      name: 'Example Family',
      address: '1 Main St',
      phone: '555-0100',
      primaryEmail: 'alice@example.com',
    });
  });
});

describe('parsePeopleImport dependent fields and issue safety', () => {
  it('normalizes a dependent with a default child role but blocks a dependent-only household', () => {
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
      errors: expect.arrayContaining([
        { severity: 'error', code: 'household_requires_person', row: 2, field: 'household_key' },
        { severity: 'error', code: 'household_name_required', row: 2, field: 'household_name' },
        { severity: 'error', code: 'household_primary_required', row: 2, field: 'household_primary' },
      ]),
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

describe('parsePeopleImport duplicate and household grouping rules', () => {
  it('reports a normalized duplicate email exactly once on every participating row', () => {
    const result = parse([
      validPerson({
        email: ' SHARED@EXAMPLE.COM ', household_key: 'family', household_name: 'Family',
        household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        email: 'shared@example.com', display_name: 'Second', household_key: 'family',
        household_role: 'adult', household_primary: 'false',
      }),
      validPerson({ email: 'shared@example.com', display_name: 'Third' }),
    ]);

    expect(result.errors.filter((issue) => issue.code === 'duplicate_email')).toEqual([
      { severity: 'error', code: 'duplicate_email', row: 2, field: 'email' },
      { severity: 'error', code: 'duplicate_email', row: 3, field: 'email' },
      { severity: 'error', code: 'duplicate_email', row: 4, field: 'email' },
    ]);
    expect(result.model?.people).toHaveLength(3);
    expect(result.model?.households).toEqual([]);
  });

  it('includes a valid email from a row rejected for another field in duplicate detection', () => {
    const result = parse([
      validPerson({ email: ' SHARED@EXAMPLE.COM ' }),
      validPerson({ display_name: '', email: 'shared@example.com' }),
    ]);

    expect(result.errors.filter((issue) => issue.code === 'duplicate_email')).toEqual([
      { severity: 'error', code: 'duplicate_email', row: 2, field: 'email' },
      { severity: 'error', code: 'duplicate_email', row: 3, field: 'email' },
    ]);
    expect(result.errors).toContainEqual({ severity: 'error', code: 'required', row: 3, field: 'display_name' });
    expect(result.model?.people).toHaveLength(1);
  });

  it('does not include invalid emails in duplicate detection', () => {
    const result = parse([
      validPerson({ email: 'not-an-email' }),
      validPerson({ display_name: 'Second', email: 'NOT-AN-EMAIL' }),
    ]);

    expect(result.errors.filter((issue) => issue.code === 'invalid_email')).toHaveLength(2);
    expect(result.errors.filter((issue) => issue.code === 'duplicate_email')).toEqual([]);
  });

  it('collects valid duplicate emails from every data row regardless of record type validity', () => {
    const result = parse([
      validDependent({ email: ' SHARED@EXAMPLE.COM ' }),
      { record_type: 'mystery', display_name: 'Unknown', email: 'shared@example.com' },
      validPerson({ display_name: '', email: 'shared@example.com' }),
    ]);

    expect(result.errors.filter((issue) => issue.code === 'duplicate_email')).toEqual([
      { severity: 'error', code: 'duplicate_email', row: 2, field: 'email' },
      { severity: 'error', code: 'duplicate_email', row: 3, field: 'email' },
      { severity: 'error', code: 'duplicate_email', row: 4, field: 'email' },
    ]);
    expect(result.errors).toEqual(expect.arrayContaining([
      { severity: 'error', code: 'forbidden_field', row: 2, field: 'email' },
      { severity: 'error', code: 'invalid_option', row: 3, field: 'record_type' },
      { severity: 'error', code: 'required', row: 4, field: 'display_name' },
    ]));
  });

  it('keeps a standalone person without creating a household', () => {
    const result = parse([validPerson()]);

    expect(result.errors).toEqual([]);
    expect(result.model?.people[0].household).toBeNull();
    expect(result.model?.households).toEqual([]);
    expect(result.model?.summary.households).toBe(0);
  });

  it('groups a primary, another person, and a dependent in stable CSV order with inherited metadata', () => {
    const result = parse([
      validPerson({
        display_name: 'Second Adult', email: 'second@example.com', active: 'false',
        household_key: 'family', household_role: 'adult', household_primary: 'false',
      }),
      validDependent({ display_name: 'Young Person', household_key: 'family' }),
      validPerson({
        display_name: 'Primary Adult', email: 'primary@example.com',
        household_key: 'family', household_name: 'Family Name', household_address: '1 Main St',
        household_phone: '555-0100', household_role: 'adult', household_primary: 'true',
      }),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.model?.households).toHaveLength(1);
    expect(result.model?.households[0]).toMatchObject({
      key: 'family',
      name: 'Family Name',
      address: '1 Main St',
      phone: '555-0100',
      primaryEmail: 'primary@example.com',
    });
    expect(result.model?.households[0].people.map((person) => person.email)).toEqual([
      'second@example.com',
      'primary@example.com',
    ]);
    expect(result.model?.households[0].dependents.map((dependent) => dependent.displayName)).toEqual(['Young Person']);
    for (const member of [
      ...(result.model?.households[0].people ?? []),
      ...(result.model?.households[0].dependents ?? []),
    ]) {
      expect(member.household).toMatchObject({
        key: 'family', name: 'Family Name', address: '1 Main St', phone: '555-0100',
      });
    }
    expect(result.model?.summary).toEqual({
      dataRows: 3, people: 2, dependents: 1, households: 1, inactivePeople: 1,
    });
  });

  it('requires a household name and excludes the invalid group while retaining preview rows', () => {
    const result = parse([
      validPerson({ household_key: 'family', household_role: 'adult', household_primary: 'true' }),
      validDependent({ household_key: 'family' }),
    ]);

    expect(result.errors).toContainEqual({
      severity: 'error', code: 'household_name_required', row: 2, field: 'household_name',
    });
    expect(result.model?.people).toHaveLength(1);
    expect(result.model?.dependents).toHaveLength(1);
    expect(result.model?.households).toEqual([]);
  });

  it('requires one adult primary when no member is primary', () => {
    const result = parse([validPerson({
      household_key: 'family', household_name: 'Family', household_role: 'adult', household_primary: 'false',
    })]);

    expect(result.errors).toContainEqual({
      severity: 'error', code: 'household_primary_required', row: 2, field: 'household_primary',
    });
    expect(result.model?.households).toEqual([]);
  });

  it('reports every primary row when a household has multiple primaries', () => {
    const result = parse([
      validPerson({
        household_key: 'family', household_name: 'Family', household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        display_name: 'Second', email: 'second@example.com', household_key: 'family',
        household_role: 'adult', household_primary: 'true',
      }),
    ]);

    expect(result.errors.filter((issue) => issue.code === 'household_primary_multiple')).toEqual([
      { severity: 'error', code: 'household_primary_multiple', row: 2, field: 'household_primary' },
      { severity: 'error', code: 'household_primary_multiple', row: 3, field: 'household_primary' },
    ]);
    expect(result.model?.households).toEqual([]);
  });

  it('rejects a child primary and still reports that an adult primary is required', () => {
    const result = parse([validPerson({
      household_key: 'family', household_name: 'Family', household_role: 'child', household_primary: 'true',
    })]);

    expect(result.errors).toEqual(expect.arrayContaining([
      { severity: 'error', code: 'household_primary_must_be_adult', row: 2, field: 'household_primary' },
      { severity: 'error', code: 'household_primary_required', row: 2, field: 'household_primary' },
    ]));
    expect(result.model?.households).toEqual([]);
  });

  it('does not count a child primary as a second primary when an adult primary exists', () => {
    const result = parse([
      validPerson({
        household_key: 'family', household_name: 'Family', household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        display_name: 'Child Person', email: 'child@example.com', household_key: 'family',
        household_role: 'child', household_primary: 'true',
      }),
    ]);

    expect(result.errors.filter((issue) => issue.code === 'household_primary_must_be_adult')).toEqual([
      { severity: 'error', code: 'household_primary_must_be_adult', row: 3, field: 'household_primary' },
    ]);
    expect(result.errors.filter((issue) => issue.code === 'household_primary_multiple')).toEqual([]);
    expect(result.errors.filter((issue) => issue.code === 'household_primary_required')).toEqual([]);
    expect(result.model?.households).toEqual([]);
  });

  it('reports every nonblank contributor for conflicting household metadata', () => {
    const result = parse([
      validPerson({
        household_key: 'family', household_name: 'Family A', household_address: '1 Main St',
        household_phone: '555-0100', household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        display_name: 'Second', email: 'second@example.com', household_key: 'family',
        household_name: 'Family B', household_address: '2 Main St', household_phone: '555-0101',
        household_role: 'adult', household_primary: 'false',
      }),
    ]);

    for (const field of ['household_name', 'household_address', 'household_phone'] as const) {
      expect(result.errors.filter((issue) => issue.code === 'household_metadata_conflict' && issue.field === field)).toEqual([
        { severity: 'error', code: 'household_metadata_conflict', row: 2, field },
        { severity: 'error', code: 'household_metadata_conflict', row: 3, field },
      ]);
    }
    expect(result.model?.households).toEqual([]);
  });

  it('canonicalizes user text to NFC and accepts canonically equivalent household metadata', () => {
    const result = parse([
      validPerson({
        display_name: 'Jos\u00e9', household_key: 'family', household_name: '\u00c9glise',
        household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        display_name: 'Second', email: 'second@example.com', household_key: 'family',
        household_name: 'E\u0301glise', household_role: 'adult', household_primary: 'false',
      }),
    ]);

    expect(result.errors.filter((issue) => issue.code === 'household_metadata_conflict')).toEqual([]);
    expect(result.model?.people[0].displayName).toBe('Jos\u00e9');
    expect(result.model?.people[1].household?.name).toBe('\u00c9glise');
    expect(result.model?.households[0].name).toBe('\u00c9glise');
  });

  it('reports duplicate dependents by normalized display name and role', () => {
    const result = parse([
      validPerson({
        household_key: 'family', household_name: 'Family', household_role: 'adult', household_primary: 'true',
      }),
      validDependent({ display_name: ' Child ', household_key: 'family', household_role: 'child' }),
      validDependent({ display_name: 'child', household_key: 'family', household_role: 'child' }),
    ]);

    expect(result.errors.filter((issue) => issue.code === 'duplicate_dependent')).toEqual([
      { severity: 'error', code: 'duplicate_dependent', row: 3, field: 'display_name' },
      { severity: 'error', code: 'duplicate_dependent', row: 4, field: 'display_name' },
    ]);
    expect(result.model?.dependents).toHaveLength(2);
    expect(result.model?.households).toEqual([]);
  });

  it('detects canonically equivalent dependent identities and returns NFC names', () => {
    const result = parse([
      validPerson({
        household_key: 'family', household_name: 'Family', household_role: 'adult', household_primary: 'true',
      }),
      validDependent({ display_name: 'Jos\u00e9', household_key: 'family', household_role: 'child' }),
      validDependent({ display_name: 'Jose\u0301', household_key: 'family', household_role: 'child' }),
    ]);

    expect(result.errors.filter((issue) => issue.code === 'duplicate_dependent')).toEqual([
      { severity: 'error', code: 'duplicate_dependent', row: 3, field: 'display_name' },
      { severity: 'error', code: 'duplicate_dependent', row: 4, field: 'display_name' },
    ]);
    expect(result.model?.dependents.map((dependent) => dependent.displayName)).toEqual(['Jos\u00e9', 'Jos\u00e9']);
  });

  it('keeps same-named households with different keys and warns on each first row', () => {
    const result = parse([
      validPerson({
        email: 'second@example.com', household_key: 'second', household_name: 'Shared Family',
        household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        email: 'first@example.com', household_key: 'first', household_name: 'Shared Family',
        household_role: 'adult', household_primary: 'true',
      }),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.model?.households.map((household) => household.key)).toEqual(['second', 'first']);
    expect(result.warnings).toEqual([
      { severity: 'warning', code: 'duplicate_household_name', row: 2, field: 'household_name' },
      { severity: 'warning', code: 'duplicate_household_name', row: 3, field: 'household_name' },
    ]);
  });

  it('compares household names case-insensitively across different keys', () => {
    const result = parse([
      validPerson({
        household_key: 'upper', household_name: 'Shared Family', household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        email: 'second@example.com', household_key: 'lower', household_name: 'shared family',
        household_role: 'adult', household_primary: 'true',
      }),
    ]);

    expect(result.model?.households).toHaveLength(2);
    expect(result.warnings.map((warning) => warning.row)).toEqual([2, 3]);
    expect(result.warnings.every((warning) => warning.code === 'duplicate_household_name')).toBe(true);
  });

  it('compares household names with NFC normalization across different keys', () => {
    const result = parse([
      validPerson({
        household_key: 'composed', household_name: '\u00c9glise', household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        email: 'second@example.com', household_key: 'decomposed', household_name: 'E\u0301GLISE',
        household_role: 'adult', household_primary: 'true',
      }),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.model?.households.map((household) => household.name)).toEqual(['\u00c9glise', '\u00c9GLISE']);
    expect(result.warnings.map((warning) => warning.row)).toEqual([2, 3]);
  });

  it('warns on duplicate canonical household names even when one group has no primary', () => {
    const result = parse([
      validPerson({
        household_key: 'valid', household_name: 'Shared Family', household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        email: 'second@example.com', household_key: 'invalid', household_name: 'shared family',
        household_role: 'adult', household_primary: 'false',
      }),
    ]);

    expect(result.errors).toContainEqual({
      severity: 'error', code: 'household_primary_required', row: 3, field: 'household_primary',
    });
    expect(result.model?.households.map((household) => household.key)).toEqual(['valid']);
    expect(result.warnings).toEqual([
      { severity: 'warning', code: 'duplicate_household_name', row: 2, field: 'household_name' },
      { severity: 'warning', code: 'duplicate_household_name', row: 3, field: 'household_name' },
    ]);
  });

  it('warns on duplicate canonical household names when duplicate emails exclude both groups', () => {
    const result = parse([
      validPerson({
        email: 'shared@example.com', household_key: 'first', household_name: 'Shared Family',
        household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        email: 'SHARED@EXAMPLE.COM', household_key: 'second', household_name: 'shared family',
        household_role: 'adult', household_primary: 'true',
      }),
    ]);

    expect(result.model?.households).toEqual([]);
    expect(result.warnings).toEqual([
      { severity: 'warning', code: 'duplicate_household_name', row: 2, field: 'household_name' },
      { severity: 'warning', code: 'duplicate_household_name', row: 3, field: 'household_name' },
    ]);
  });

  it('blocks files with more than 100 distinct household keys and keeps a bounded first-100 preview', () => {
    const result = parse(Array.from({ length: 101 }, (_, index) => validPerson({
      display_name: `Person ${index}`,
      email: `person-${index}@example.com`,
      household_key: `family-${index}`,
      household_name: `Family ${index}`,
      household_role: 'adult',
      household_primary: 'true',
    })));

    expect(result.errors).toContainEqual({
      severity: 'error', code: 'too_many_households', row: 102, field: 'household_key',
    });
    expect(result.model?.households).toHaveLength(100);
    expect(result.model?.households.map((household) => household.key).at(-1)).toBe('family-99');
    expect(result.model?.summary.households).toBe(100);
  });

  it('counts valid normalized keys from rejected person and dependent rows toward the file limit', () => {
    const validHouseholds = Array.from({ length: 99 }, (_, index) => validPerson({
      display_name: `Person ${index}`,
      email: `person-${index}@example.com`,
      household_key: `family-${index}`,
      household_name: `Family ${index}`,
      household_role: 'adult',
      household_primary: 'true',
    }));
    const result = parse([
      ...validHouseholds,
      validPerson({
        display_name: '', email: 'rejected-person@example.com', household_key: 'rejected-person-family',
        household_name: 'Rejected Person Family', household_role: 'adult', household_primary: 'true',
      }),
      validDependent({ household_key: 'rejected-dependent-family', email: 'forbidden@example.com' }),
    ]);

    expect(result.errors).toContainEqual({
      severity: 'error', code: 'too_many_households', row: 102, field: 'household_key',
    });
    expect(result.model?.households).toHaveLength(99);
    expect(result.model?.people).toHaveLength(99);
    expect(result.model?.dependents).toEqual([]);
  });

  it('counts a legal household key from an invalid record type toward the file limit', () => {
    const validHouseholds = Array.from({ length: 100 }, (_, index) => validPerson({
      display_name: `Person ${index}`,
      email: `person-${index}@example.com`,
      household_key: `family-${index}`,
      household_name: `Family ${index}`,
      household_role: 'adult',
      household_primary: 'true',
    }));
    const result = parse([
      ...validHouseholds,
      { record_type: 'mystery', display_name: 'Unknown', household_key: 'unknown-family' },
    ]);

    expect(result.errors).toEqual(expect.arrayContaining([
      { severity: 'error', code: 'too_many_households', row: 102, field: 'household_key' },
      { severity: 'error', code: 'invalid_option', row: 102, field: 'record_type' },
    ]));
    expect(result.model?.households).toHaveLength(100);
  });

  it('does not regress inactive summary counts when a household is invalid', () => {
    const result = parse([
      validPerson({
        active: 'false', household_key: 'family', household_name: 'Family',
        household_role: 'adult', household_primary: 'false',
      }),
      validPerson({ display_name: 'Standalone', email: 'standalone@example.com' }),
    ]);

    expect(result.model?.summary).toEqual({
      dataRows: 2, people: 2, dependents: 0, households: 0, inactivePeople: 1,
    });
  });

  it('keeps grouping issues free of names, emails, keys, and metadata values', () => {
    const secrets = ['PRIVATE FAMILY', 'PRIVATE@EXAMPLE.COM', 'private-family', 'PRIVATE ADDRESS'];
    const result = parse([
      validPerson({
        email: secrets[1], household_key: secrets[2], household_name: secrets[0],
        household_address: secrets[3], household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        display_name: 'Second', email: secrets[1], household_key: secrets[2], household_name: 'OTHER FAMILY',
        household_address: 'OTHER ADDRESS', household_role: 'adult', household_primary: 'false',
      }),
    ]);

    const serialized = JSON.stringify(result.errors);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(result.errors).toEqual(expect.arrayContaining([
      { severity: 'error', code: 'duplicate_email', row: 2, field: 'email' },
      { severity: 'error', code: 'household_metadata_conflict', row: 2, field: 'household_name' },
    ]));
  });

  it('caps grouping issues at 100 with one terminal truncation issue', () => {
    const records = Array.from({ length: 51 }, (_, index) => [
      validPerson({
        display_name: `Primary A ${index}`, email: `a-${index}@example.com`, household_key: `family-${index}`,
        household_name: `Family ${index}`, household_role: 'adult', household_primary: 'true',
      }),
      validPerson({
        display_name: `Primary B ${index}`, email: `b-${index}@example.com`, household_key: `family-${index}`,
        household_role: 'adult', household_primary: 'true',
      }),
    ]).flat();
    const result = parse(records);

    expect(result.errors).toHaveLength(100);
    expect(result.errors.at(-1)).toEqual({
      severity: 'error', code: 'issues_truncated', row: null, field: null,
    });
    expect(result.model?.people).toHaveLength(102);
  });
});
