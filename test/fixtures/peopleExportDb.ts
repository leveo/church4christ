import type { AppDb } from '../../src/lib/appDb';
import type { CanonicalPeopleExportSource } from '../../src/lib/peopleExport';

export const EXPORT_TODAY = '2026-08-11';

export async function seedPortableExportFixture(db: AppDb): Promise<void> {
  await db.batch([
    db.prepare(`
      INSERT INTO people (
        id, first_name, last_name, display_name, email, phone, active, lang,
        birthday, address, membership_status, joined_on
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      1,
      'E\u0301lodie',
      'Live',
      'E\u0301lodie Live',
      ' ZETA@EXAMPLE.COM ',
      '555-0101',
      1,
      'en',
      '1990-01-02',
      'Person address',
      'member',
      '2020-03-04',
    ),
    db.prepare(`
      INSERT INTO people (
        id, first_name, last_name, display_name, email, active, lang,
        membership_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(2, 'Beta', 'Inactive', 'Beta Inactive', 'beta@example.com', 0, 'zh', 'regular'),
    db.prepare(`
      INSERT INTO people (id, display_name, email, deleted_at)
      VALUES (?, ?, ?, ?)
    `).bind(3, 'Deleted Person', 'deleted@example.com', '2026-01-01 00:00:00'),
    db.prepare(`
      INSERT INTO people (id, display_name, email)
      VALUES (?, ?, ?)
    `).bind(4, 'Alpha Standalone', 'alpha@example.com'),
    db.prepare(`
      INSERT INTO households (id, name, address, phone)
      VALUES (?, ?, ?, ?)
    `).bind(10, 'Cafe\u0301 Family', '1 Fictional Way', '555-0100'),
    db.prepare(`
      INSERT INTO households (id, name, deleted_at)
      VALUES (?, ?, ?)
    `).bind(11, 'Deleted Household', '2026-01-01 00:00:00'),
    db.prepare(`
      INSERT INTO household_members (
        id, household_id, person_id, display_name, role, is_primary
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(100, 10, 1, 'Historical Display', 'adult', 1),
    db.prepare(`
      INSERT INTO household_members (
        id, household_id, person_id, display_name, role, is_primary
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(101, 10, 2, 'Historical Inactive', 'child', 0),
    db.prepare(`
      INSERT INTO household_members (
        id, household_id, person_id, display_name, role, is_primary
      ) VALUES (?, ?, NULL, ?, ?, 0)
    `).bind(102, 10, '=Formula Child', 'child'),
    db.prepare(`
      INSERT INTO person_notes (id, person_id, author_email, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(200, 1, 'former.author@example.com', '=Call after service', '2026-08-10 09:00:00'),
    db.prepare(`
      INSERT INTO person_notes (id, person_id, author_email, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(201, 2, '+departed.author@example.com', 'Line one,\nline two', '2026-08-09 08:00:00'),
    db.prepare(`
      INSERT INTO person_notes (id, person_id, author_email, body, created_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      202,
      1,
      'deleted-note-author@example.com',
      'Deleted note body',
      '2026-08-08 08:00:00',
      '2026-08-10 00:00:00',
    ),
    db.prepare(`
      INSERT INTO person_notes (id, person_id, author_email, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(203, 3, 'historical@example.com', 'Deleted subject body', '2026-08-07 08:00:00'),
    db.prepare(`
      INSERT INTO person_notes (id, person_id, author_email, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(204, 4, 'standalone.author@example.com', 'Standalone follow-up', '2026-08-11 10:00:00'),
  ]);
}

export function expectedCanonicalPeopleExportSource(): CanonicalPeopleExportSource {
  return {
    today: EXPORT_TODAY,
    people: [
      {
        stableKey: 'person-1',
        displayName: 'E\u0301lodie Live',
        email: ' ZETA@EXAMPLE.COM ',
        firstName: 'E\u0301lodie',
        lastName: 'Live',
        phone: '555-0101',
        language: 'en',
        membershipStatus: 'member',
        birthday: '1990-01-02',
        joinedOn: '2020-03-04',
        address: 'Person address',
        active: true,
        household: {
          stableKey: 'household-10',
          name: 'Cafe\u0301 Family',
          address: '1 Fictional Way',
          phone: '555-0100',
          role: 'adult',
          primary: true,
        },
      },
      {
        stableKey: 'person-2',
        displayName: 'Beta Inactive',
        email: 'beta@example.com',
        firstName: 'Beta',
        lastName: 'Inactive',
        phone: null,
        language: 'zh',
        membershipStatus: 'regular',
        birthday: null,
        joinedOn: null,
        address: null,
        active: false,
        household: {
          stableKey: 'household-10',
          name: 'Cafe\u0301 Family',
          address: '1 Fictional Way',
          phone: '555-0100',
          role: 'child',
          primary: false,
        },
      },
      {
        stableKey: 'person-4',
        displayName: 'Alpha Standalone',
        email: 'alpha@example.com',
        firstName: '',
        lastName: '',
        phone: null,
        language: null,
        membershipStatus: 'visitor',
        birthday: null,
        joinedOn: null,
        address: null,
        active: true,
        household: null,
      },
    ],
    dependents: [{
      stableKey: 'dependent-102',
      displayName: '=Formula Child',
      household: {
        stableKey: 'household-10',
        name: 'Cafe\u0301 Family',
        address: '1 Fictional Way',
        phone: '555-0100',
        role: 'child',
      },
    }],
  };
}
