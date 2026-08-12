import type { AppDb } from './appDb';
import type {
  CanonicalPeopleExportDependent,
  CanonicalPeopleExportHouseholdReference,
  CanonicalPeopleExportPerson,
  CanonicalPeopleExportSource,
} from './peopleExport';
import type {
  PastoralNotesExportSource,
  PastoralNotesExportSourceNote,
} from './pastoralNotesExport';
import { MEMBERSHIP_STATUSES, type MembershipStatus } from './validate';

const EXPORT_SNAPSHOT_LIMIT = 5_001;

type DbRow = Record<string, unknown>;

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function zeroOrOne(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function membershipStatus(value: unknown): value is MembershipStatus {
  return (MEMBERSHIP_STATUSES as readonly unknown[]).includes(value);
}

interface SafePerson {
  id: number;
  export: Omit<CanonicalPeopleExportPerson, 'household'>;
}

interface SafeHousehold {
  id: number;
  stableKey: string;
  name: string;
  address: string | null;
  phone: string | null;
}

interface SafeMembership {
  id: number;
  householdId: number;
  personId: number | null;
  displayName: string;
  role: 'adult' | 'child';
  primary: boolean;
  householdExists: boolean;
  householdLive: boolean;
  personExists: boolean;
  personLive: boolean;
}

function safePerson(row: DbRow): SafePerson | null {
  if (
    !positiveInteger(row.id)
    || typeof row.first_name !== 'string'
    || typeof row.last_name !== 'string'
    || typeof row.display_name !== 'string'
    || typeof row.email !== 'string'
    || !nullableString(row.phone)
    || !zeroOrOne(row.active)
    || (row.lang !== null && row.lang !== 'en' && row.lang !== 'zh')
    || !nullableString(row.birthday)
    || !nullableString(row.address)
    || !membershipStatus(row.membership_status)
    || !nullableString(row.joined_on)
  ) return null;
  return {
    id: row.id,
    export: {
      stableKey: `person-${row.id}`,
      displayName: row.display_name,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      language: row.lang,
      membershipStatus: row.membership_status,
      birthday: row.birthday,
      joinedOn: row.joined_on,
      address: row.address,
      active: row.active === 1,
    },
  };
}

function safeHousehold(row: DbRow): SafeHousehold | null {
  if (
    !positiveInteger(row.id)
    || typeof row.name !== 'string'
    || !nullableString(row.address)
    || !nullableString(row.phone)
  ) return null;
  return {
    id: row.id,
    stableKey: `household-${row.id}`,
    name: row.name,
    address: row.address,
    phone: row.phone,
  };
}

function safeMembership(row: DbRow): SafeMembership | null {
  if (
    !positiveInteger(row.id)
    || !positiveInteger(row.household_id)
    || (row.person_id !== null && !positiveInteger(row.person_id))
    || typeof row.display_name !== 'string'
    || (row.role !== 'adult' && row.role !== 'child')
    || !zeroOrOne(row.is_primary)
    || !zeroOrOne(row.household_exists)
    || !zeroOrOne(row.household_live)
    || !zeroOrOne(row.person_exists)
    || !zeroOrOne(row.person_live)
  ) return null;
  return {
    id: row.id,
    householdId: row.household_id,
    personId: row.person_id,
    displayName: row.display_name,
    role: row.role,
    primary: row.is_primary === 1,
    householdExists: row.household_exists === 1,
    householdLive: row.household_live === 1,
    personExists: row.person_exists === 1,
    personLive: row.person_live === 1,
  };
}

/** Read one cross-backend snapshot and convert internal IDs only to file-local-safe stable keys. */
export async function loadCanonicalPeopleExport(
  db: AppDb,
  today: string,
): Promise<CanonicalPeopleExportSource> {
  const [peopleResult, householdsResult, membershipsResult] = await db.batch<DbRow>([
    db.prepare(`
      SELECT id, first_name, last_name, display_name, email, phone, active, lang,
             birthday, address, membership_status, joined_on
      FROM people
      WHERE deleted_at IS NULL
      ORDER BY id
      LIMIT 5001
    `),
    db.prepare(`
      SELECT id, name, address, phone
      FROM households
      WHERE deleted_at IS NULL
      ORDER BY id
      LIMIT 5001
    `),
    db.prepare(`
      SELECT hm.id, hm.household_id, hm.person_id, hm.display_name, hm.role, hm.is_primary,
             CASE WHEN h.id IS NULL THEN 0 ELSE 1 END AS household_exists,
             CASE WHEN h.id IS NOT NULL AND h.deleted_at IS NULL THEN 1 ELSE 0 END AS household_live,
             CASE WHEN hm.person_id IS NULL OR p.id IS NOT NULL THEN 1 ELSE 0 END AS person_exists,
             CASE WHEN hm.person_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL) THEN 1 ELSE 0 END AS person_live
      FROM household_members hm
      LEFT JOIN households h ON h.id = hm.household_id
      LEFT JOIN people p ON p.id = hm.person_id
      ORDER BY hm.id
      LIMIT 5001
    `),
  ]);

  let integrityIssues = 0;
  if (
    peopleResult.results.length >= EXPORT_SNAPSHOT_LIMIT
    || householdsResult.results.length >= EXPORT_SNAPSHOT_LIMIT
    || membershipsResult.results.length >= EXPORT_SNAPSHOT_LIMIT
  ) integrityIssues += 1;

  const peopleById = new Map<number, SafePerson>();
  for (const row of peopleResult.results) {
    const person = safePerson(row);
    if (!person || peopleById.has(person.id)) {
      integrityIssues += 1;
      continue;
    }
    peopleById.set(person.id, person);
  }

  const householdsById = new Map<number, SafeHousehold>();
  for (const row of householdsResult.results) {
    const household = safeHousehold(row);
    if (!household || householdsById.has(household.id)) {
      integrityIssues += 1;
      continue;
    }
    householdsById.set(household.id, household);
  }

  const membershipByPerson = new Map<number, SafeMembership>();
  const dependents: CanonicalPeopleExportDependent[] = [];
  const liveHouseholdsWithMembership = new Set<number>();
  for (const row of membershipsResult.results) {
    const membership = safeMembership(row);
    if (!membership) {
      integrityIssues += 1;
      continue;
    }
    if (!membership.householdExists) {
      integrityIssues += 1;
      continue;
    }
    if (!membership.householdLive) {
      integrityIssues += 1;
      continue;
    }
    const household = householdsById.get(membership.householdId);
    if (!household) {
      integrityIssues += 1;
      continue;
    }
    liveHouseholdsWithMembership.add(household.id);

    if (membership.personId === null) {
      dependents.push({
        stableKey: `dependent-${membership.id}`,
        displayName: membership.displayName,
        household: {
          stableKey: household.stableKey,
          name: household.name,
          address: household.address,
          phone: household.phone,
          role: membership.role,
        },
      });
      continue;
    }
    if (!membership.personExists || !membership.personLive || !peopleById.has(membership.personId)) {
      integrityIssues += 1;
      continue;
    }
    if (membershipByPerson.has(membership.personId)) {
      integrityIssues += 1;
      continue;
    }
    membershipByPerson.set(membership.personId, membership);
  }

  for (const householdId of householdsById.keys()) {
    if (!liveHouseholdsWithMembership.has(householdId)) integrityIssues += 1;
  }

  const people: CanonicalPeopleExportPerson[] = [];
  for (const person of peopleById.values()) {
    const membership = membershipByPerson.get(person.id);
    let household: CanonicalPeopleExportHouseholdReference | null = null;
    if (membership) {
      const source = householdsById.get(membership.householdId);
      if (!source) {
        integrityIssues += 1;
      } else {
        household = {
          stableKey: source.stableKey,
          name: source.name,
          address: source.address,
          phone: source.phone,
          role: membership.role,
          primary: membership.primary,
        };
      }
    }
    people.push({ ...person.export, household });
  }

  return {
    today,
    people,
    dependents,
    ...(integrityIssues > 0 ? { integrityIssues } : {}),
  };
}

function notesSourceRow(row: DbRow): { note: PastoralNotesExportSourceNote; valid: boolean } {
  const valid = positiveInteger(row.note_id)
    && positiveInteger(row.person_id)
    && typeof row.person_email === 'string'
    && typeof row.author_attribution === 'string'
    && typeof row.body === 'string'
    && typeof row.created_at === 'string';
  return {
    note: {
      stableKey: positiveInteger(row.note_id) ? `note-${row.note_id}` : '',
      personStableKey: positiveInteger(row.person_id) ? `person-${row.person_id}` : '',
      personEmail: typeof row.person_email === 'string' ? row.person_email : '',
      authorAttribution: typeof row.author_attribution === 'string' ? row.author_attribution : '',
      body: typeof row.body === 'string' ? row.body : '',
      createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    },
    valid,
  };
}

/** Load only live notes for live subjects; the serializer owns final byte validation. */
export async function loadPastoralNotesExport(db: AppDb): Promise<PastoralNotesExportSource> {
  const [result] = await db.batch<DbRow>([
    db.prepare(`
      SELECT n.id AS note_id, n.person_id,
             CASE WHEN length(p.email) <= 320 THEN p.email ELSE NULL END AS person_email,
             CASE WHEN length(n.author_email) <= 320 THEN n.author_email ELSE NULL END AS author_attribution,
             CASE WHEN length(n.body) <= 4000 THEN n.body ELSE NULL END AS body,
             CASE WHEN length(n.created_at) <= 64 THEN n.created_at ELSE NULL END AS created_at
      FROM person_notes n
      JOIN people p ON p.id = n.person_id
      WHERE n.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY n.id
      LIMIT 5001
    `),
  ]);
  const mapped = result.results.map(notesSourceRow);
  const integrityIssues = mapped.filter((row) => !row.valid).length;
  return {
    notes: mapped.map((row) => row.note),
    ...(integrityIssues > 0 ? { integrityIssues } : {}),
  };
}
