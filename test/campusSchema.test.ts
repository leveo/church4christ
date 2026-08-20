import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { D1_CAMPUS_SCOPED_TABLES } from '../src/lib/campusScope';

const db = env.DB;

const REPRESENTATIVE_SCOPED_TABLES = [
  'ministries',
  'teams',
  'households',
  'bulletins',
  'sermons',
  'events',
  'prayer_requests',
  'media',
  'groups',
  'group_events',
  'checkins',
  'service_attendance',
  'newcomer_submissions',
  'activity_score_config',
  'learning_provider_connections',
  'learning_programs',
] as const;

const ALL_SCOPED_TABLES = [
  'activity_score_config',
  'activity_score_dimensions',
  'announcement_i18n',
  'announcements',
  'audit_events',
  'blockout_dates',
  'bulletin_announcements',
  'bulletins',
  'checkin_events',
  'checkins',
  'custom_page_i18n',
  'custom_pages',
  'email_log',
  'email_rules',
  'email_templates',
  'event_i18n',
  'events',
  'external_ids',
  'gift_results',
  'group_attendance',
  'group_attendance_tokens',
  'group_event_occurrences',
  'group_events',
  'group_join_requests',
  'group_members',
  'groups',
  'household_members',
  'households',
  'learning_activities',
  'learning_activity_events',
  'learning_canvas_cleanup_tasks',
  'learning_canvas_event_receipts',
  'learning_canvas_oauth_states',
  'learning_canvas_webhook_configs',
  'learning_courses',
  'learning_enrollments',
  'learning_google_cleanup_tasks',
  'learning_google_notification_receipts',
  'learning_google_oauth_states',
  'learning_google_registrations',
  'learning_identity_links',
  'learning_programs',
  'learning_provider_connections',
  'learning_provider_credentials',
  'learning_resources',
  'learning_submission_snapshots',
  'learning_sync_runs',
  'media',
  'ministries',
  'ministry_i18n',
  'newcomer_activity',
  'newcomer_answers',
  'newcomer_field_i18n',
  'newcomer_field_option_i18n',
  'newcomer_field_options',
  'newcomer_fields',
  'newcomer_notes',
  'newcomer_rate_limits',
  'newcomer_status_i18n',
  'newcomer_statuses',
  'newcomer_submissions',
  'onboarding_acknowledgements',
  'people_import_mappings',
  'person_interests',
  'person_notes',
  'plan_positions',
  'plans',
  'position_i18n',
  'positions',
  'prayer_activity',
  'prayer_requests',
  'prayer_sheets',
  'revisions',
  'roster_assignments',
  'sermons',
  'service_attendance',
  'service_checkin_link_state',
  'service_type_checkin_events',
  'service_type_i18n',
  'service_types',
  'team_applications',
  'team_i18n',
  'team_members',
  'teams',
  'testimonies',
] as const;

describe('multi-campus schema', () => {
  it('creates the campus, membership, module, and setting boundaries', async () => {
    const { results } = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>();
    const names = new Set(results.map(({ name }) => name));

    for (const table of ['campuses', 'campus_memberships', 'campus_modules', 'campus_settings']) {
      expect(names.has(table), table).toBe(true);
    }
  });

  it('seeds exactly one active default campus for an upgraded single-campus install', async () => {
    const { results } = await db
      .prepare('SELECT id, slug, name, active, is_default FROM campuses ORDER BY id')
      .all<{ id: number; slug: string; name: string; active: number; is_default: number }>();

    expect(results).toEqual([
      { id: 1, slug: 'main', name: 'Main Campus', active: 1, is_default: 1 },
    ]);
  });

  it('adds a non-null defaulted campus partition key across feature data', async () => {
    for (const table of REPRESENTATIVE_SCOPED_TABLES) {
      const { results } = await db
        .prepare(`PRAGMA table_info(${table})`)
        .all<{ name: string; notnull: number; dflt_value: string | null }>();
      const campus = results.find(({ name }) => name === 'campus_id');
      expect(campus, table).toMatchObject({ name: 'campus_id', notnull: 1, dflt_value: '1' });
    }
  });

  it('partitions and request-scopes every tenant-owned feature table', async () => {
    expect([...D1_CAMPUS_SCOPED_TABLES].sort()).toEqual([...ALL_SCOPED_TABLES].sort());
    for (const table of ALL_SCOPED_TABLES) {
      const { results } = await db
        .prepare(`PRAGMA table_info(${table})`)
        .all<{ name: string; notnull: number; dflt_value: string | null }>();
      expect(results.find(({ name }) => name === 'campus_id'), table)
        .toMatchObject({ name: 'campus_id', notnull: 1, dflt_value: '1' });
    }
  });

  it('stores independent campus roles, finance access, and validated area grants per person', async () => {
    await db.prepare(
      "INSERT INTO people (id, display_name, email) VALUES (77001, 'Campus Person', 'campus-person@example.test')",
    ).run();
    await db.prepare(
      `INSERT INTO campuses (id, slug, name) VALUES
         (77001, 'north', 'North Campus'),
         (77002, 'south', 'South Campus')`,
    ).run();
    await db.prepare(
      `INSERT INTO campus_memberships (campus_id, person_id, role, finance, admin_areas) VALUES
         (77001, 77001, 'admin', 1, 'people,groups'),
         (77002, 77001, 'member', 0, '')`,
    ).run();

    const { results } = await db.prepare(
      `SELECT campus_id, role, finance, admin_areas
       FROM campus_memberships WHERE person_id = 77001 ORDER BY campus_id`,
    ).all<{ campus_id: number; role: string; finance: number; admin_areas: string }>();
    expect(results).toEqual([
      { campus_id: 1, role: 'member', finance: 0, admin_areas: '' },
      { campus_id: 77001, role: 'admin', finance: 1, admin_areas: 'people,groups' },
      { campus_id: 77002, role: 'member', finance: 0, admin_areas: '' },
    ]);

    await expect(db.prepare(
      "INSERT INTO campus_memberships (campus_id, person_id, role) VALUES (77001, 77001, 'owner')",
    ).run()).rejects.toThrow();
  });

  it('automatically attaches every newly created identity to the default campus', async () => {
    await db.prepare(
      `INSERT INTO people
         (id, display_name, email, role, finance, admin_areas)
       VALUES
         (77201, 'Default Campus Admin', 'default-campus-admin@example.test', 'admin', 1, 'groups')`,
    ).run();
    const membership = await db.prepare(
      `SELECT campus_id, role, finance, admin_areas, active
       FROM campus_memberships WHERE person_id = 77201`,
    ).first<{
      campus_id: number;
      role: string;
      finance: number;
      admin_areas: string;
      active: number;
    }>();
    expect(membership).toEqual({
      campus_id: 1,
      role: 'admin',
      finance: 1,
      admin_areas: 'groups',
      active: 1,
    });
  });

  it('stores a defaulted home campus on shared sign-in identities', async () => {
    const { results } = await db.prepare('PRAGMA table_info(people)')
      .all<{ name: string; notnull: number; dflt_value: string | null }>();
    expect(results.find(({ name }) => name === 'home_campus_id'))
      .toMatchObject({ name: 'home_campus_id', notnull: 1, dflt_value: '1' });
  });

  it('removes owned campus memberships when an identity is hard-deleted', async () => {
    await db.prepare(
      "INSERT INTO people (id, display_name, email) VALUES (77202, 'Delete Me', 'delete-campus-person@example.test')",
    ).run();
    expect(await db.prepare(
      'SELECT person_id FROM campus_memberships WHERE person_id = 77202',
    ).first()).toEqual({ person_id: 77202 });

    await expect(db.prepare('DELETE FROM people WHERE id = 77202').run()).resolves.not.toThrow();
    expect(await db.prepare(
      'SELECT person_id FROM campus_memberships WHERE person_id = 77202',
    ).first()).toBeNull();
  });

  it('allows the same setting and module key to vary independently by campus', async () => {
    await db.prepare(
      `INSERT INTO campuses (id, slug, name) VALUES
         (77101, 'east', 'East Campus'),
         (77102, 'west', 'West Campus')`,
    ).run();
    await db.prepare(
      `INSERT INTO campus_settings (campus_id, key, value) VALUES
         (77101, 'site.name.en', 'East Church'),
         (77102, 'site.name.en', 'West Church')`,
    ).run();
    await db.prepare(
      `INSERT INTO campus_modules (campus_id, module_key, enabled) VALUES
         (77101, 'groups', 1),
         (77102, 'groups', 0)`,
    ).run();

    const settings = await db.prepare(
      "SELECT campus_id, value FROM campus_settings WHERE key = 'site.name.en' ORDER BY campus_id",
    ).all<{ campus_id: number; value: string }>();
    const modules = await db.prepare(
      "SELECT campus_id, enabled FROM campus_modules WHERE module_key = 'groups' ORDER BY campus_id",
    ).all<{ campus_id: number; enabled: number }>();

    expect(settings.results).toEqual([
      { campus_id: 77101, value: 'East Church' },
      { campus_id: 77102, value: 'West Church' },
    ]);
    expect(modules.results).toEqual([
      { campus_id: 77101, enabled: 1 },
      { campus_id: 77102, enabled: 0 },
    ]);
  });
});
