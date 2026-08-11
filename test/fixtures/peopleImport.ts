import {
  PEOPLE_IMPORT_HEADERS,
  parsePeopleImport,
  type PeopleImportHeader,
} from '../../src/lib/peopleImport';

const quoteCell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export const peopleImportCsvBytes = (
  records: Array<Partial<Record<PeopleImportHeader, string>>>,
): Uint8Array => {
  const lines = [
    PEOPLE_IMPORT_HEADERS.join(','),
    ...records.map((record) =>
      PEOPLE_IMPORT_HEADERS.map((header) => quoteCell(record[header] ?? '')).join(','),
    ),
  ];
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
};

export const parsePeopleImportRecords = (
  records: Array<Partial<Record<PeopleImportHeader, string>>>,
) => parsePeopleImport(peopleImportCsvBytes(records), { today: '2026-08-11' });

export const emptyPeopleImportFixture = parsePeopleImportRecords([]);

export const peopleImportFixture = parsePeopleImportRecords([
  {
    record_type: 'person',
    display_name: "Standalone O'Neil?",
    email: 'standalone@example.com',
    last_name: "O'Neil",
    phone: '555-0100?',
    language: 'en',
    membership_status: 'inactive',
    birthday: '1990-02-03',
    joined_on: '2020-04-05',
    address: "1 Main St?; DROP TABLE people; --",
    active: 'false',
  },
  {
    record_type: 'person',
    display_name: 'Mina Child',
    email: 'mina@example.com',
    household_key: 'alpha-family',
    household_name: "St. John's Family?",
    household_address: "2 Oak St'; DROP TABLE households; --",
    household_phone: '555-0200',
    household_role: 'child',
    household_primary: 'false',
  },
  {
    record_type: 'dependent',
    display_name: 'Kid ?); DELETE FROM people; --',
    household_key: 'alpha-family',
    household_role: 'child',
  },
  {
    record_type: 'person',
    display_name: "Pat O'Primary",
    email: 'pat@example.com',
    first_name: 'Pat',
    language: 'zh',
    membership_status: 'member',
    household_key: 'alpha-family',
    household_role: 'adult',
    household_primary: 'true',
  },
  {
    record_type: 'person',
    display_name: 'Robin Primary',
    email: 'robin@example.com',
    first_name: 'Robin',
    last_name: 'Question?',
    household_key: 'beta-family',
    household_name: "St. John's Family?",
    household_role: 'adult',
    household_primary: 'true',
  },
  {
    record_type: 'person',
    display_name: 'Taylor Adult',
    email: 'taylor@example.com',
    household_key: 'beta-family',
    household_role: 'adult',
    household_primary: 'false',
  },
]);
