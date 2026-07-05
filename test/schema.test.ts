// Runs in the workers project. test/setup.ts already applies every migration
// in migrations/ (via TEST_MIGRATIONS) before this file's tests run, so a live,
// migrated D1 binding is available here for free.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Every table migration 0001 must create (spec §5 identity/volunteer/content/settings).
const TABLES = [
  'people',
  'ministries',
  'ministry_i18n',
  'teams',
  'team_i18n',
  'positions',
  'position_i18n',
  'team_members',
  'service_types',
  'service_type_i18n',
  'plans',
  'plan_positions',
  'roster_assignments',
  'blockout_dates',
  'team_applications',
  'person_interests',
  'gift_results',
  'testimonies',
  'tokens',
  'bulletins',
  'bulletin_announcements',
  'sermons',
  'prayer_sheets',
  'announcements',
  'announcement_i18n',
  'events',
  'event_i18n',
  'prayer_requests',
  'prayer_activity',
  'revisions',
  'media',
  'settings',
  'external_ids',
];

describe('migration 0001: table presence', () => {
  it('creates every table listed in the spec', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const table of TABLES) {
      expect(names).toContain(table);
    }
  });
});

describe('people.role CHECK constraint', () => {
  it('rejects a role outside member/editor/admin', async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO people (display_name, email, role) VALUES ('Owner Person', 'owner@example.com', 'owner')",
      ).run(),
    ).rejects.toThrow();
  });
});

describe('roster_assignments UNIQUE (plan_id, position_id, person_id)', () => {
  it('rejects a duplicate assignment for the same plan/position/person', async () => {
    const db = env.DB;
    await db
      .prepare("INSERT INTO people (display_name, email) VALUES ('Vera Volunteer', 'vera@example.com')")
      .run();
    const person = await db
      .prepare("SELECT id FROM people WHERE email = 'vera@example.com'")
      .first<{ id: number }>();

    await db.prepare("INSERT INTO service_types (start_time) VALUES ('09:30')").run();
    const serviceType = await db.prepare('SELECT id FROM service_types').first<{ id: number }>();

    await db
      .prepare('INSERT INTO plans (service_type_id, plan_date) VALUES (?, ?)')
      .bind(serviceType!.id, '2026-07-12')
      .run();
    const plan = await db.prepare('SELECT id FROM plans').first<{ id: number }>();

    await db.prepare('INSERT INTO teams (ministry_id) VALUES (NULL)').run();
    const team = await db.prepare('SELECT id FROM teams').first<{ id: number }>();

    await db.prepare('INSERT INTO positions (team_id) VALUES (?)').bind(team!.id).run();
    const position = await db.prepare('SELECT id FROM positions').first<{ id: number }>();

    await db
      .prepare('INSERT INTO roster_assignments (plan_id, position_id, person_id) VALUES (?, ?, ?)')
      .bind(plan!.id, position!.id, person!.id)
      .run();

    await expect(
      db
        .prepare('INSERT INTO roster_assignments (plan_id, position_id, person_id) VALUES (?, ?, ?)')
        .bind(plan!.id, position!.id, person!.id)
        .run(),
    ).rejects.toThrow();
  });
});

describe('team_applications partial unique index on pending status', () => {
  it('rejects a second pending application, but allows a new one once the first is decided', async () => {
    const db = env.DB;
    await db
      .prepare("INSERT INTO people (display_name, email) VALUES ('Pat Pending', 'pat@example.com')")
      .run();
    const person = await db.prepare("SELECT id FROM people WHERE email = 'pat@example.com'").first<{
      id: number;
    }>();

    await db.prepare('INSERT INTO teams (ministry_id) VALUES (NULL)').run();
    const team = await db.prepare('SELECT id FROM teams').first<{ id: number }>();

    await db
      .prepare('INSERT INTO team_applications (person_id, team_id) VALUES (?, ?)')
      .bind(person!.id, team!.id)
      .run();

    await expect(
      db
        .prepare('INSERT INTO team_applications (person_id, team_id) VALUES (?, ?)')
        .bind(person!.id, team!.id)
        .run(),
    ).rejects.toThrow();

    await db
      .prepare("UPDATE team_applications SET status = 'A' WHERE person_id = ? AND team_id = ?")
      .bind(person!.id, team!.id)
      .run();

    await expect(
      db
        .prepare('INSERT INTO team_applications (person_id, team_id) VALUES (?, ?)')
        .bind(person!.id, team!.id)
        .run(),
    ).resolves.not.toThrow();
  });
});

describe('settings upsert', () => {
  it('round-trips an INSERT ... ON CONFLICT(key) DO UPDATE', async () => {
    const db = env.DB;
    const upsert = (value: string) =>
      db
        .prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .bind('site.name.en', value)
        .run();

    await upsert('Church4Christ');
    let row = await db.prepare("SELECT value FROM settings WHERE key = 'site.name.en'").first<{
      value: string;
    }>();
    expect(row?.value).toBe('Church4Christ');

    await upsert('Church4Christ Updated');
    row = await db.prepare("SELECT value FROM settings WHERE key = 'site.name.en'").first<{
      value: string;
    }>();
    expect(row?.value).toBe('Church4Christ Updated');

    const count = await db.prepare('SELECT COUNT(*) AS n FROM settings').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
