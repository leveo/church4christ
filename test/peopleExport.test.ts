import { describe, expect, expectTypeOf, it } from 'vitest';
import { csvCell } from '../src/lib/csv';
import {
  PEOPLE_IMPORT_HEADERS,
  PEOPLE_IMPORT_LIMITS,
  parsePeopleImport,
  type PeopleImportHeader,
} from '../src/lib/peopleImport';
import {
  buildCanonicalExportParts,
  type CanonicalPeopleExportDependent,
  type CanonicalPeopleExportDependentHouseholdReference,
  type CanonicalPeopleExportHouseholdReference,
  type CanonicalPeopleExportPerson,
  type CanonicalPeopleExportSource,
  type CanonicalExportPart,
  type CanonicalExportRepairCounts,
  type CanonicalExportResult,
} from '../src/lib/peopleExport';

const TODAY = '2026-08-11';

const household = (
  stableKey: string,
  overrides: Partial<CanonicalPeopleExportHouseholdReference> = {},
): CanonicalPeopleExportHouseholdReference => ({
  stableKey,
  name: 'Fictional Household',
  address: null,
  phone: null,
  role: 'adult',
  primary: true,
  ...overrides,
});

const person = (
  stableKey: string,
  email: string,
  overrides: Partial<CanonicalPeopleExportPerson> = {},
): CanonicalPeopleExportPerson => ({
  stableKey,
  displayName: `Person ${stableKey}`,
  email,
  firstName: null,
  lastName: null,
  phone: null,
  language: null,
  membershipStatus: 'visitor',
  birthday: null,
  joinedOn: null,
  address: null,
  active: true,
  household: null,
  ...overrides,
});

const dependentHousehold = (
  stableKey: string,
  overrides: Partial<CanonicalPeopleExportDependentHouseholdReference> = {},
): CanonicalPeopleExportDependentHouseholdReference => ({
  stableKey,
  name: 'Fictional Household',
  address: null,
  phone: null,
  role: 'child',
  ...overrides,
});

const dependent = (
  stableKey: string,
  householdReference: CanonicalPeopleExportDependentHouseholdReference,
  overrides: Partial<CanonicalPeopleExportDependent> = {},
): CanonicalPeopleExportDependent => ({
  stableKey,
  displayName: `Dependent ${stableKey}`,
  household: householdReference,
  ...overrides,
});

const source = (
  people: readonly CanonicalPeopleExportPerson[],
  dependents: readonly CanonicalPeopleExportDependent[] = [],
  today = TODAY,
): CanonicalPeopleExportSource => ({ today, people, dependents });

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const standaloneCsv = (people: readonly CanonicalPeopleExportPerson[]): string => {
  const rows = people.map((entry) => {
    const record: Record<PeopleImportHeader, string> = {
      record_type: 'person',
      display_name: entry.displayName.trim().normalize('NFC'),
      email: entry.email.trim().normalize('NFC').toLowerCase(),
      first_name: entry.firstName?.trim().normalize('NFC') ?? '',
      last_name: entry.lastName?.trim().normalize('NFC') ?? '',
      phone: entry.phone?.trim().normalize('NFC') ?? '',
      language: entry.language ?? '',
      membership_status: entry.membershipStatus,
      birthday: entry.birthday ?? '',
      joined_on: entry.joinedOn ?? '',
      address: entry.address?.trim().normalize('NFC') ?? '',
      active: String(entry.active),
      household_key: '',
      household_name: '',
      household_address: '',
      household_phone: '',
      household_role: '',
      household_primary: '',
    };
    return PEOPLE_IMPORT_HEADERS.map((header) => csvCell(record[header])).join(',');
  });
  return `${PEOPLE_IMPORT_HEADERS.join(',')}\r\n${rows.map((row) => `${row}\r\n`).join('')}`;
};

const exactByteStandalonePeople = (targetBytes: number): CanonicalPeopleExportPerson[] => {
  const people = Array.from({ length: PEOPLE_IMPORT_LIMITS.maxDataRows }, (_, index) =>
    person(`byte-${index.toString().padStart(3, '0')}`, `byte-${index}@example.com`),
  );
  let remaining = targetBytes - utf8Bytes(standaloneCsv(people));
  if (remaining < 0) throw new Error('target too small for boundary fixture');

  const fields = [
    ['displayName', 80],
    ['firstName', 80],
    ['lastName', 80],
    ['phone', 40],
    ['address', 200],
  ] as const;
  for (const entry of people) {
    for (const [field, maximum] of fields) {
      const current = entry[field] ?? '';
      const capacity = maximum - Array.from(current).length;
      if (capacity <= 0 || remaining <= 0) continue;
      const emojiCount = Math.min(capacity, Math.floor(remaining / 4));
      let addition = '😀'.repeat(emojiCount);
      remaining -= emojiCount * 4;
      const asciiCount = Math.min(capacity - emojiCount, remaining);
      addition += 'x'.repeat(asciiCount);
      remaining -= asciiCount;
      (entry as unknown as Record<string, string>)[field] = `${current}${addition}`;
    }
  }
  if (remaining !== 0) throw new Error(`could not construct exact byte fixture: ${remaining}`);
  if (utf8Bytes(standaloneCsv(people)) !== targetBytes) throw new Error('fixture byte size mismatch');
  return people;
};

const expectImporterSafeParts = (
  result: ReturnType<typeof buildCanonicalExportParts>,
  expectedRows: number,
  expectedHouseholds: number,
): void => {
  expect(result.status).toBe('success');
  if (result.status !== 'success') throw new Error('expected success');
  expect(result.parts.map((part) => part.number)).toEqual(
    Array.from({ length: result.parts.length }, (_, index) => index + 1),
  );
  expect(result.parts.reduce((total, part) => total + part.rowCount, 0)).toBe(expectedRows);
  expect(result.parts.reduce((total, part) => total + part.householdCount, 0)).toBe(expectedHouseholds);
  for (const part of result.parts) {
    expect(part.rowCount).toBeLessThanOrEqual(PEOPLE_IMPORT_LIMITS.maxDataRows);
    expect(part.householdCount).toBeLessThanOrEqual(PEOPLE_IMPORT_LIMITS.maxHouseholds);
    expect(utf8Bytes(part.csv)).toBeLessThanOrEqual(PEOPLE_IMPORT_LIMITS.maxBytes);
    expect(part.csv.startsWith(`${PEOPLE_IMPORT_HEADERS.join(',')}\r\n`)).toBe(true);
    expect(parsePeopleImport(new TextEncoder().encode(part.csv), { today: TODAY }).errors).toEqual([]);
  }
};

describe('buildCanonicalExportParts canonical CSV', () => {
  it('exposes an exact discriminated result shape without CSV on repair results', () => {
    expectTypeOf<CanonicalExportPart>().toEqualTypeOf<{
      number: number;
      rowCount: number;
      householdCount: number;
      csv: string;
    }>();
    expectTypeOf<CanonicalExportRepairCounts>().toEqualTypeOf<{
      people: number;
      dependents: number;
      households: number;
      issues: number;
    }>();
    expectTypeOf<Extract<CanonicalExportResult, { status: 'success' }>>().toEqualTypeOf<{
      status: 'success';
      parts: CanonicalExportPart[];
    }>();
    expectTypeOf<Extract<CanonicalExportResult, { status: 'repair_required' }>>().toEqualTypeOf<{
      status: 'repair_required';
      counts: CanonicalExportRepairCounts;
    }>();
  });

  it('emits only the 18 importer fields with the exact header, CRLF, quoting, and formula safety', () => {
    const source = {
      today: TODAY,
      people: [
        {
          stableKey: 'person-primary',
          displayName: 'Alex Example',
          email: 'alex@example.com',
          firstName: 'Alex',
          lastName: 'Example',
          phone: '555-0100',
          language: 'en',
          membershipStatus: 'member',
          birthday: '1990-01-02',
          joinedOn: '2020-03-04',
          address: '1 Fictional Way, Suite 2\nExample City',
          active: true,
          household: {
            stableKey: 'house-source-key',
            name: 'Example Household',
            address: '1 Fictional Way, Suite 2',
            phone: '555-0100',
            role: 'adult',
            primary: true,
          },
          internalId: 42,
          role: 'owner',
          adminAreas: ['people'],
          sessionToken: 'SECRET_SESSION_TOKEN',
          stripeCustomerId: 'STRIPE_SECRET_VALUE',
          pastoralNotes: 'PRIVATE_PASTORAL_NOTE',
        },
        {
          stableKey: 'standalone',
          displayName: '=NOT_A_FORMULA',
          email: 'zeta@example.com',
          firstName: null,
          lastName: null,
          phone: null,
          language: null,
          membershipStatus: 'visitor',
          birthday: null,
          joinedOn: null,
          address: null,
          active: false,
          household: null,
        },
      ],
      dependents: [
        {
          stableKey: 'dependent',
          displayName: 'Casey Example',
          household: {
            stableKey: 'house-source-key',
            name: 'Example Household',
            address: '1 Fictional Way, Suite 2',
            phone: '555-0100',
            role: 'child',
          },
          securityToken: 'DEPENDENT_SECRET_VALUE',
          notes: 'DEPENDENT_PRIVATE_NOTE',
        },
      ],
    } as unknown as CanonicalPeopleExportSource;
    const before = structuredClone(source);

    const result = buildCanonicalExportParts(source);

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({ number: 1, rowCount: 3, householdCount: 1 });
    expect(result.parts[0].csv.startsWith(`${PEOPLE_IMPORT_HEADERS.join(',')}\r\n`)).toBe(true);
    expect(result.parts[0].csv.endsWith('\r\n')).toBe(true);
    expect(result.parts[0].csv).toContain('"1 Fictional Way, Suite 2\nExample City"');
    expect(result.parts[0].csv).toContain("person,'=NOT_A_FORMULA,zeta@example.com");
    expect(result.parts[0].csv).toContain('household-1,Example Household');
    for (const forbidden of [
      'person-primary',
      'house-source-key',
      'SECRET_SESSION_TOKEN',
      'STRIPE_SECRET_VALUE',
      'PRIVATE_PASTORAL_NOTE',
      'DEPENDENT_SECRET_VALUE',
      'DEPENDENT_PRIVATE_NOTE',
      'owner',
    ]) {
      expect(result.parts[0].csv).not.toContain(forbidden);
    }

    const parsed = parsePeopleImport(new TextEncoder().encode(result.parts[0].csv), { today: TODAY });
    expect(parsed.errors).toEqual([]);
    expect(parsed.model?.summary).toEqual({
      dataRows: 3,
      people: 2,
      dependents: 1,
      households: 1,
      inactivePeople: 1,
    });
    expect(source).toEqual(before);
  });

  it('orders normalized households and every member deterministically before assigning file-local keys', () => {
    const firstHouse = 'house-first';
    const secondHouse = 'house-second';
    const people = [
      person('standalone-z', 'standalone-z@example.com'),
      person('second-primary', 'zoe@example.com', {
        household: household(secondHouse, { name: ' E\u0301xample Household ' }),
      }),
      person('first-primary', 'amy@example.com', {
        household: household(firstHouse, { name: 'éxample household' }),
      }),
      person('second-member', 'member-a@example.com', {
        household: household(secondHouse, {
          name: 'Éxample Household',
          primary: false,
        }),
      }),
      person('standalone-a', 'standalone-a@example.com'),
      person('beta-primary', 'beta@example.com', {
        household: household('house-beta', { name: 'Beta Household' }),
      }),
    ];
    const dependents = [
      dependent('zoe-child', dependentHousehold(secondHouse, { name: 'Éxample Household' }), {
        displayName: 'Zoë Example',
      }),
      dependent('anne-child', dependentHousehold(secondHouse, { name: 'Éxample Household' }), {
        displayName: ' Anne Example ',
      }),
      dependent('anne-adult', dependentHousehold(secondHouse, {
        name: 'Éxample Household',
        role: 'adult',
      }), { displayName: 'anne example' }),
    ];

    const forward = buildCanonicalExportParts(source(people, dependents));
    const reversed = buildCanonicalExportParts(source([...people].reverse(), [...dependents].reverse()));

    expect(forward).toEqual(reversed);
    expect(forward.status).toBe('success');
    if (forward.status !== 'success') throw new Error('expected success');
    const parsed = parsePeopleImport(new TextEncoder().encode(forward.parts[0].csv), { today: TODAY });
    expect(parsed.errors).toEqual([]);
    expect(parsed.model?.people.map((entry) => [entry.email, entry.household?.key ?? null])).toEqual([
      ['beta@example.com', 'household-1'],
      ['amy@example.com', 'household-2'],
      ['member-a@example.com', 'household-3'],
      ['zoe@example.com', 'household-3'],
      ['standalone-a@example.com', null],
      ['standalone-z@example.com', null],
    ]);
    expect(parsed.model?.dependents.map((entry) => [
      entry.displayName,
      entry.household.role,
      entry.household.key,
    ])).toEqual([
      ['anne example', 'adult', 'household-3'],
      ['Anne Example', 'child', 'household-3'],
      ['Zoë Example', 'child', 'household-3'],
    ]);
  });

  it('resolves sparse household metadata canonically without treating absence as a conflict', () => {
    const people = [
      person('sparse-primary', 'sparse-primary@example.com', {
        household: household('sparse-house', {
          name: 'Sparse Household',
          address: null,
          phone: null,
        }),
      }),
      person('sparse-member', 'sparse-member@example.com', {
        household: household('sparse-house', {
          name: '',
          address: '9 Fictional Lane',
          phone: '555-0199',
          primary: false,
        }),
      }),
    ];
    const dependents = [
      dependent('sparse-dependent', dependentHousehold('sparse-house', {
        name: '',
        address: null,
        phone: null,
      })),
    ];

    const forward = buildCanonicalExportParts(source(people, dependents));
    const reversed = buildCanonicalExportParts(source([...people].reverse(), [...dependents].reverse()));

    expect(forward).toEqual(reversed);
    expect(forward.status).toBe('success');
    if (forward.status !== 'success') throw new Error('expected success');
    const parsed = parsePeopleImport(new TextEncoder().encode(forward.parts[0].csv), { today: TODAY });
    expect(parsed.errors).toEqual([]);
    expect(parsed.model?.people.map((entry) => entry.household)).toEqual([
      expect.objectContaining({
        name: 'Sparse Household',
        address: '9 Fictional Lane',
        phone: '555-0199',
      }),
      expect.objectContaining({
        name: 'Sparse Household',
        address: '9 Fictional Lane',
        phone: '555-0199',
      }),
    ]);
    expect(parsed.model?.dependents[0].household).toEqual(expect.objectContaining({
      name: 'Sparse Household',
      address: '9 Fictional Lane',
      phone: '555-0199',
    }));
  });
});

describe('buildCanonicalExportParts structural preflight', () => {
  const privateName = 'Private Repair Name';
  const privateEmail = 'private-repair@example.com';

  it.each([
    [
      'a dependent-only household',
      source([], [dependent('only-dependent', dependentHousehold('orphan'), { displayName: privateName })]),
    ],
    [
      'a household without a primary',
      source([person('no-primary', privateEmail, {
        displayName: privateName,
        household: household('no-primary-house', { primary: false }),
      })]),
    ],
    [
      'a household with multiple primaries',
      source([
        person('primary-one', privateEmail, {
          displayName: privateName,
          household: household('many-primary-house'),
        }),
        person('primary-two', 'second-private@example.com', {
          household: household('many-primary-house'),
        }),
      ]),
    ],
    [
      'a child primary',
      source([person('child-primary', privateEmail, {
        displayName: privateName,
        household: household('child-primary-house', { role: 'child' }),
      })]),
    ],
    [
      'conflicting household metadata',
      source(
        [person('conflict-primary', privateEmail, {
          displayName: privateName,
          household: household('conflict-house', { name: 'First Private Household' }),
        })],
        [dependent('conflict-dependent', dependentHousehold('conflict-house', {
          name: 'Second Private Household',
        }))],
      ),
    ],
    [
      'records that cannot satisfy the importer contract',
      source([
        person('duplicate-one', privateEmail, { displayName: privateName }),
        person('duplicate-two', privateEmail),
      ]),
    ],
  ])('fails closed for %s without returning CSV or PII', (_label, invalidSource) => {
    const result = buildCanonicalExportParts(invalidSource);

    expect(result.status).toBe('repair_required');
    if (result.status !== 'repair_required') throw new Error('expected repair_required');
    expect(Object.keys(result).sort()).toEqual(['counts', 'status']);
    expect(Object.keys(result.counts).sort()).toEqual(['dependents', 'households', 'issues', 'people']);
    expect(result.counts.issues).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(privateName);
    expect(JSON.stringify(result)).not.toContain(privateEmail);
    expect(JSON.stringify(result)).not.toContain('csv');
  });

  it('bounds every structural count when a source has more invalid rows than importer-safe reporting allows', () => {
    const result = buildCanonicalExportParts(source(Array.from({ length: 250 }, (_, index) =>
      person(`invalid-${index}`, privateEmail),
    )));

    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 201, dependents: 0, households: 0, issues: 100 },
    });
  });
});

describe('buildCanonicalExportParts importer-safe partitioning', () => {
  it('keeps 200 rows in one part and deterministically moves row 201 to part two', () => {
    const firstTwoHundred = Array.from({ length: 200 }, (_, index) =>
      person(`row-${index.toString().padStart(3, '0')}`, `row-${index}@example.com`),
    );
    const atLimit = buildCanonicalExportParts(source(firstTwoHundred));
    const overLimit = buildCanonicalExportParts(source([
      ...firstTwoHundred,
      person('row-200', 'row-200@example.com'),
    ]));

    expectImporterSafeParts(atLimit, 200, 0);
    expectImporterSafeParts(overLimit, 201, 0);
    if (atLimit.status !== 'success' || overLimit.status !== 'success') {
      throw new Error('expected success');
    }
    expect(atLimit.parts.map((part) => part.rowCount)).toEqual([200]);
    expect(overLimit.parts.map((part) => part.rowCount)).toEqual([200, 1]);
    const exportedEmails = overLimit.parts.flatMap((part) =>
      parsePeopleImport(new TextEncoder().encode(part.csv), { today: TODAY }).model?.people.map(
        (entry) => entry.email,
      ) ?? [],
    );
    expect(exportedEmails).toEqual(
      firstTwoHundred.map((entry) => entry.email).concat('row-200@example.com').sort(),
    );
    expect(new Set(exportedEmails).size).toBe(201);
  });

  it('keeps 100 households in one part and deterministically moves household 101 to part two', () => {
    const householdPeople = Array.from({ length: 101 }, (_, index) => {
      const suffix = index.toString().padStart(3, '0');
      return person(`household-person-${suffix}`, `household-${suffix}@example.com`, {
        household: household(`house-${suffix}`, { name: `Household ${suffix}` }),
      });
    });

    const atLimit = buildCanonicalExportParts(source(householdPeople.slice(0, 100)));
    const overLimit = buildCanonicalExportParts(source(householdPeople));

    expectImporterSafeParts(atLimit, 100, 100);
    expectImporterSafeParts(overLimit, 101, 101);
    if (atLimit.status !== 'success' || overLimit.status !== 'success') {
      throw new Error('expected success');
    }
    expect(atLimit.parts.map((part) => [part.rowCount, part.householdCount])).toEqual([[100, 100]]);
    expect(overLimit.parts.map((part) => [part.rowCount, part.householdCount])).toEqual([
      [100, 100],
      [1, 1],
    ]);
    expect(
      parsePeopleImport(new TextEncoder().encode(overLimit.parts[1].csv), { today: TODAY })
        .model?.households[0].key,
    ).toBe('household-1');
  });

  it('allows the exact UTF-8 byte boundary and starts a new part at one byte over', () => {
    const exactPeople = exactByteStandalonePeople(PEOPLE_IMPORT_LIMITS.maxBytes);
    const plusOnePeople = exactByteStandalonePeople(PEOPLE_IMPORT_LIMITS.maxBytes + 1);

    const exact = buildCanonicalExportParts(source(exactPeople));
    const plusOne = buildCanonicalExportParts(source(plusOnePeople));

    expectImporterSafeParts(exact, 200, 0);
    expectImporterSafeParts(plusOne, 200, 0);
    if (exact.status !== 'success' || plusOne.status !== 'success') throw new Error('expected success');
    expect(exact.parts).toHaveLength(1);
    expect(utf8Bytes(exact.parts[0].csv)).toBe(PEOPLE_IMPORT_LIMITS.maxBytes);
    expect(exact.parts[0].csv.length).toBeLessThan(PEOPLE_IMPORT_LIMITS.maxBytes);
    expect(plusOne.parts).toHaveLength(2);
  });

  it('never splits a household when adding its whole bundle would cross a part boundary', () => {
    const householdPeople = [
      person('bundle-primary', 'bundle-primary@example.com', {
        household: household('bundle-house', { name: 'Atomic Household' }),
      }),
      person('bundle-member', 'bundle-member@example.com', {
        household: household('bundle-house', { name: 'Atomic Household', primary: false }),
      }),
    ];
    const standalonePeople = Array.from({ length: 199 }, (_, index) =>
      person(`standalone-${index.toString().padStart(3, '0')}`, `standalone-${index}@example.com`),
    );
    const result = buildCanonicalExportParts(source([...standalonePeople, ...householdPeople]));

    expectImporterSafeParts(result, 201, 1);
    if (result.status !== 'success') throw new Error('expected success');
    expect(result.parts.map((part) => [part.rowCount, part.householdCount])).toEqual([
      [200, 1],
      [1, 0],
    ]);
    const householdKeysByPart = result.parts.map((part) =>
      parsePeopleImport(new TextEncoder().encode(part.csv), { today: TODAY }).model?.people
        .map((entry) => entry.household?.key)
        .filter(Boolean) ?? [],
    );
    expect(householdKeysByPart).toEqual([['household-1', 'household-1'], []]);
  });

  it('fails closed without partial CSV when one household cannot fit one importer file', () => {
    const hugeHouseholdPeople = Array.from({ length: 150 }, (_, index) => {
      const suffix = index.toString().padStart(3, '0');
      return person(`huge-${suffix}`, `huge-${suffix}@example.com`, {
        displayName: '😀'.repeat(80),
        firstName: '😀'.repeat(80),
        lastName: '😀'.repeat(80),
        phone: '😀'.repeat(40),
        address: '😀'.repeat(200),
        household: household('huge-household', {
          name: '😀'.repeat(80),
          address: '😀'.repeat(200),
          phone: '😀'.repeat(40),
          primary: index === 0,
        }),
      });
    });

    const result = buildCanonicalExportParts(source(hugeHouseholdPeople));

    expect(result).toEqual({
      status: 'repair_required',
      counts: { people: 150, dependents: 0, households: 1, issues: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('csv');
  });
});
