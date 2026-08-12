import { describe, expect, it } from 'vitest';
import { PEOPLE_IMPORT_HEADERS, validatePeopleImportRows } from '../src/lib/peopleImport';
import {
  PEOPLE_IMPORT_MAPPING_CONSTANT_FIELDS,
  PEOPLE_IMPORT_MAPPING_ENUM_FIELDS,
  PEOPLE_IMPORT_MAPPING_LIMITS,
  inspectPeopleImportMappingSource,
  snapshotPeopleImportMappingContract,
  transformPeopleImportMapping,
  type PeopleImportMappingContract,
} from '../src/lib/peopleImportMapping';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const mappingContract = (
  expectedHeaders: string[],
  overrides: Partial<PeopleImportMappingContract> = {},
): PeopleImportMappingContract => ({
  version: 1,
  expectedHeaders,
  fieldMappings: Object.fromEntries(PEOPLE_IMPORT_HEADERS.map((header) => [header, null])) as Record<
    (typeof PEOPLE_IMPORT_HEADERS)[number],
    number | null
  >,
  constants: {},
  enumTranslations: {},
  ...overrides,
});

const mappedContract = (
  expectedHeaders: string[],
  mappings: Partial<Record<(typeof PEOPLE_IMPORT_HEADERS)[number], number>>,
  overrides: Partial<PeopleImportMappingContract> = {},
): PeopleImportMappingContract => {
  const contract = mappingContract(expectedHeaders, overrides);
  for (const [field, source] of Object.entries(mappings)) {
    contract.fieldMappings[field as (typeof PEOPLE_IMPORT_HEADERS)[number]] = source;
  }
  return contract;
};

describe('people import mapping canonical validation dependency', () => {
  it('accepts an exact canonical row matrix without serializing it back to CSV', () => {
    const row = Object.fromEntries(PEOPLE_IMPORT_HEADERS.map((header) => [header, ''])) as Record<
      (typeof PEOPLE_IMPORT_HEADERS)[number],
      string
    >;
    row.record_type = 'person';
    row.display_name = 'Alice Example';
    row.email = 'alice@example.com';

    expect(validatePeopleImportRows({
      rows: [
        [...PEOPLE_IMPORT_HEADERS],
        PEOPLE_IMPORT_HEADERS.map((header) => row[header]),
      ],
      rowNumbers: [1, 2],
    }, { today: '2026-08-12' }).errors).toEqual([]);
  });
});

describe('people import mapping source inspection', () => {
  it('owns independent parser and issue limits', () => {
    expect(PEOPLE_IMPORT_MAPPING_LIMITS).toEqual({
      maxBytes: 256 * 1024,
      maxRows: 201,
      maxColumns: 128,
      maxCellChars: 5_000,
      maxIssues: 100,
    });
  });

  it('normalizes headers with trim, NFC, and lowercase while retaining the physical line', () => {
    const result = inspectPeopleImportMappingSource(encode('\n" NA\u0301ME ", EMAIL\nvalue,a@example.com\n'));

    expect(result).toEqual({
      headers: ['náme', 'email'],
      headerRowNumber: 2,
      issues: [],
    });
  });

  it('rejects empty and duplicate normalized headers without echoing source values in issues', () => {
    const result = inspectPeopleImportMappingSource(encode(' Name , ,NAME\nAlice,secret,alice@example.com\n'));

    expect(result).toEqual({
      headers: null,
      headerRowNumber: 1,
      issues: [
        { code: 'empty_header', row: 1, column: 2, field: null },
        { code: 'duplicate_header', row: 1, column: 3, field: null },
      ],
    });
    expect(JSON.stringify(result.issues)).not.toContain('Name');
    expect(JSON.stringify(result.issues)).not.toContain('secret');
  });

  it.each([18, 19, 128])('accepts %i source columns', (count) => {
    const headers = Array.from({ length: count }, (_, index) => `column_${index + 1}`);
    expect(inspectPeopleImportMappingSource(encode(`${headers.join(',')}\n`))).toEqual({
      headers,
      headerRowNumber: 1,
      issues: [],
    });
  });

  it('rejects 129 source columns at the independent parser boundary', () => {
    const headers = Array.from({ length: 129 }, (_, index) => `column_${index + 1}`);
    expect(inspectPeopleImportMappingSource(encode(`${headers.join(',')}\n`))).toEqual({
      headers: null,
      headerRowNumber: null,
      issues: [{ code: 'too_many_columns', row: 1, column: 129, field: null }],
    });
  });

  it('caps safe header issues at 100', () => {
    const result = inspectPeopleImportMappingSource(encode(`${Array.from({ length: 128 }, () => 'name').join(',')}\n`));

    expect(result.issues).toHaveLength(100);
    expect(result.issues.at(-1)).toEqual({
      code: 'issues_truncated',
      row: null,
      column: null,
      field: null,
    });
  });
});

describe('people import mapping runtime contract', () => {
  it('closes constants and enum translations to the six approved canonical fields', () => {
    expect(PEOPLE_IMPORT_MAPPING_CONSTANT_FIELDS).toEqual([
      'record_type',
      'language',
      'membership_status',
      'active',
      'household_role',
      'household_primary',
    ]);
    expect(PEOPLE_IMPORT_MAPPING_ENUM_FIELDS).toEqual(PEOPLE_IMPORT_MAPPING_CONSTANT_FIELDS);
  });

  it('snapshots and freezes an exact v1 contract while allowing source-column reuse', () => {
    const expectedHeaders = ['name', 'email'];
    const fieldMappings = Object.fromEntries(PEOPLE_IMPORT_HEADERS.map((header) => [header, null])) as Record<
      (typeof PEOPLE_IMPORT_HEADERS)[number],
      number | null
    >;
    fieldMappings.display_name = 0;
    fieldMappings.first_name = 0;
    fieldMappings.email = 1;
    const input = mappingContract(expectedHeaders, {
      fieldMappings,
      constants: { record_type: 'person' },
      enumTranslations: { language: { english: 'en' } },
    });

    const result = snapshotPeopleImportMappingContract(input);
    expectedHeaders[0] = 'mutated';
    input.constants.record_type = 'dependent';

    expect(result.issues).toEqual([]);
    expect(result.contract).toEqual({
      version: 1,
      expectedHeaders: ['name', 'email'],
      fieldMappings,
      constants: { record_type: 'person' },
      enumTranslations: { language: { english: 'en' } },
    });
    expect(Object.isFrozen(result.contract)).toBe(true);
    expect(Object.isFrozen(result.contract?.expectedHeaders)).toBe(true);
    expect(Object.isFrozen(result.contract?.fieldMappings)).toBe(true);
    expect(Object.isFrozen(result.contract?.constants)).toBe(true);
    expect(Object.isFrozen(result.contract?.enumTranslations.language)).toBe(true);
  });

  it.each([
    ['extra top-level key', { ...mappingContract(['name']), surprise: true }],
    ['unnormalized expected header', mappingContract([' Name '])],
    ['duplicate expected header', mappingContract(['name', 'name'])],
    ['missing canonical mapping key', (() => {
      const contract = mappingContract(['name']);
      const { email: _email, ...missing } = contract.fieldMappings;
      return { ...contract, fieldMappings: missing };
    })()],
    ['extra canonical mapping key', (() => {
      const contract = mappingContract(['name']);
      return { ...contract, fieldMappings: { ...contract.fieldMappings, admin_role: 0 } };
    })()],
    ['source index outside expected headers', (() => {
      const contract = mappingContract(['name']);
      return { ...contract, fieldMappings: { ...contract.fieldMappings, display_name: 1 } };
    })()],
    ['constant outside the closed set', { ...mappingContract(['name']), constants: { email: 'private@example.com' } }],
    ['noncanonical constant', { ...mappingContract(['name']), constants: { record_type: 'admin' } }],
    ['empty optional constant', { ...mappingContract(['name']), constants: { active: '' } }],
    ['constant and source on the same field', (() => {
      const contract = mappingContract(['type']);
      return {
        ...contract,
        fieldMappings: { ...contract.fieldMappings, record_type: 0 },
        constants: { record_type: 'person' },
      };
    })()],
    ['translation outside the closed set', { ...mappingContract(['name']), enumTranslations: { email: { secret: 'x' } } }],
    ['explicit empty translation map', { ...mappingContract(['type']), enumTranslations: { record_type: {} } }],
    ['translation to a noncanonical enum', { ...mappingContract(['type']), enumTranslations: { record_type: { human: 'admin' } } }],
    ['translation to an empty target', { ...mappingContract(['active']), enumTranslations: { active: { unknown: '' } } }],
    ['expected header over the cell limit', mappingContract(['x'.repeat(PEOPLE_IMPORT_MAPPING_LIMITS.maxCellChars + 1)])],
  ])('fails closed for %s', (_label, value) => {
    const result = snapshotPeopleImportMappingContract(value);
    expect(result).toEqual({
      contract: null,
      issues: [{ code: 'invalid_contract', row: null, column: null, field: null }],
    });
    expect(JSON.stringify(result.issues)).not.toContain('private@example.com');
    expect(JSON.stringify(result.issues)).not.toContain('secret');
  });

  it('fails closed instead of invoking runtime accessors', () => {
    const hostile = Object.defineProperty({}, 'version', {
      enumerable: true,
      get: () => {
        throw new Error('must not run');
      },
    });

    expect(snapshotPeopleImportMappingContract(hostile)).toEqual({
      contract: null,
      issues: [{ code: 'invalid_contract', row: null, column: null, field: null }],
    });
  });
});

describe('people import mapping transform', () => {
  const expectedHeaders = ['type', 'full name', 'e-mail', 'lang', 'status', 'enabled'];
  const contract = () => mappedContract(expectedHeaders, {
    record_type: 0,
    display_name: 1,
    email: 2,
    language: 3,
    membership_status: 4,
    active: 5,
  }, {
    enumTranslations: {
      record_type: { human: 'person' },
      language: { english: 'en' },
      membership_status: { attendee: 'regular' },
      active: { yes: 'true' },
    },
  });

  it('returns exact canonical rows with physical coordinates and delegates canonical validation', () => {
    const bytes = encode([
      'Type, Full Name,E-mail,Lang,Status,Enabled',
      'Human,"Alice\nExample",alice@example.com,English,Attendee,Yes',
      '',
      'Human,Bad Email,not-an-email,English,Attendee,Yes',
      '',
    ].join('\n'));

    const result = transformPeopleImportMapping(bytes, contract(), { today: '2026-08-12' });

    expect(result.issues).toEqual([]);
    expect(result.rowNumbers).toEqual([1, 2, 5]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows?.every((row) => row.length === 18)).toBe(true);
    expect(result.rows?.[0]).toEqual(PEOPLE_IMPORT_HEADERS);
    const expectedFirstRow: Partial<Record<(typeof PEOPLE_IMPORT_HEADERS)[number], string>> = {
      record_type: 'person',
      display_name: 'Alice\nExample',
      email: 'alice@example.com',
      language: 'en',
      membership_status: 'regular',
      active: 'true',
    };
    expect(result.rows?.[1]).toEqual(PEOPLE_IMPORT_HEADERS.map((header) => expectedFirstRow[header] ?? ''));
    expect(result.validation?.errors).toContainEqual({
      severity: 'error',
      code: 'invalid_email',
      row: 5,
      field: 'email',
    });
  });

  it('accepts NFC-equivalent headers but blocks ordered header drift by column only', () => {
    const nfcContract = mappedContract(['náme', 'email'], { display_name: 0, email: 1 }, {
      constants: { record_type: 'person' },
    });
    expect(transformPeopleImportMapping(
      encode(' NA\u0301ME ,EMAIL\nAlice,alice@example.com\n'),
      nfcContract,
      { today: '2026-08-12' },
    ).issues).toEqual([]);

    const drift = transformPeopleImportMapping(
      encode('Name,Private Header,Extra PII\nAlice,secret,secret@example.com\n'),
      mappingContract(['name', 'email']),
      { today: '2026-08-12' },
    );
    expect(drift).toEqual({
      rows: null,
      rowNumbers: null,
      validation: null,
      issues: [
        { code: 'header_drift', row: 1, column: 2, field: null },
        { code: 'header_drift', row: 1, column: 3, field: null },
      ],
    });
    expect(JSON.stringify(drift.issues)).not.toContain('Private Header');
    expect(JSON.stringify(drift.issues)).not.toContain('Extra PII');
  });

  it('requires an explicit translation for every nonempty closed-enum source value', () => {
    const profile = mappedContract(['type', 'name', 'email'], {
      record_type: 0,
      display_name: 1,
      email: 2,
    });
    const result = transformPeopleImportMapping(
      encode('type,name,email\nperson,Alice,alice@example.com\nprivate-secret,Bob,bob@example.com\n'),
      profile,
      { today: '2026-08-12' },
    );

    expect(result.rows).toBeNull();
    expect(result.validation).toBeNull();
    expect(result.issues).toEqual([
      { code: 'unknown_enum', row: 2, column: 1, field: 'record_type' },
      { code: 'unknown_enum', row: 3, column: 1, field: 'record_type' },
    ]);
    expect(JSON.stringify(result.issues)).not.toContain('person');
    expect(JSON.stringify(result.issues)).not.toContain('private-secret');
  });

  it('blocks ragged nonempty extra cells but ignores empty trailing cells', () => {
    const profile = mappedContract(['name', 'email'], { display_name: 0, email: 1 }, {
      constants: { record_type: 'person' },
    });
    const accepted = transformPeopleImportMapping(
      encode('name,email\nAlice,alice@example.com,\n'),
      profile,
      { today: '2026-08-12' },
    );
    expect(accepted.issues).toEqual([]);
    expect(accepted.rows?.[1]).toHaveLength(18);

    const blocked = transformPeopleImportMapping(
      encode('name,email\nAlice,alice@example.com,private-value\n'),
      profile,
      { today: '2026-08-12' },
    );
    expect(blocked).toEqual({
      rows: null,
      rowNumbers: null,
      validation: null,
      issues: [{ code: 'extra_column', row: 2, column: 3, field: null }],
    });
    expect(JSON.stringify(blocked.issues)).not.toContain('private-value');
  });

  it('fails closed for a malformed runtime contract before exposing source data', () => {
    const result = transformPeopleImportMapping(
      encode('private-header\nprivate-value\n'),
      { version: 1 },
      { today: '2026-08-12' },
    );
    expect(result).toEqual({
      rows: null,
      rowNumbers: null,
      validation: null,
      issues: [{ code: 'invalid_contract', row: null, column: null, field: null }],
    });
    expect(JSON.stringify(result.issues)).not.toContain('private');
  });

  it('caps unknown-enum issues at 100 without source values', () => {
    const profile = mappedContract(['type', 'name', 'email'], {
      record_type: 0,
      display_name: 1,
      email: 2,
    }, { enumTranslations: { record_type: { human: 'person' } } });
    const rows = Array.from(
      { length: 101 },
      (_, index) => `unknown-${index},Person ${index},person-${index}@example.com`,
    );
    const result = transformPeopleImportMapping(
      encode(`type,name,email\n${rows.join('\n')}\n`),
      profile,
      { today: '2026-08-12' },
    );

    expect(result.issues).toHaveLength(100);
    expect(result.issues.at(-1)).toEqual({
      code: 'issues_truncated',
      row: null,
      column: null,
      field: null,
    });
    expect(JSON.stringify(result.issues)).not.toContain('unknown-');
  });

  it('maps independent byte, row, and cell limits to safe issues', () => {
    expect(transformPeopleImportMapping(
      new Uint8Array(PEOPLE_IMPORT_MAPPING_LIMITS.maxBytes + 1),
      mappingContract(['name']),
      { today: '2026-08-12' },
    ).issues).toEqual([{ code: 'file_too_large', row: null, column: null, field: null }]);

    const tooManyRows = `name\n${Array.from({ length: 201 }, () => 'value').join('\n')}\n`;
    expect(transformPeopleImportMapping(
      encode(tooManyRows),
      mappingContract(['name']),
      { today: '2026-08-12' },
    ).issues).toEqual([{ code: 'too_many_rows', row: 202, column: 1, field: null }]);

    expect(transformPeopleImportMapping(
      encode(`name\n${'x'.repeat(PEOPLE_IMPORT_MAPPING_LIMITS.maxCellChars + 1)}\n`),
      mappingContract(['name']),
      { today: '2026-08-12' },
    ).issues).toEqual([{ code: 'cell_too_long', row: 2, column: 1, field: null }]);
  });
});
