// Runs in the workers project against a live, migrated D1 binding (test/setup.ts
// applies every migration first). Loads seed/dev-seed.sql via vite's `?raw`
// import, executes it statement-by-statement, then asserts the demo seed is
// internally consistent and exercises the public readers (settings, ministries).
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import seedSql from '../seed/dev-seed.sql?raw';
import manifest from '../seed/media/manifest.json';
import { listServiceAttendanceReport } from '../src/lib/serviceAttendanceDb';
import { getSiteIdentity, getTheme } from '../src/lib/settings';
import { reconcileCanvasCourse } from '../src/lib/learningCanvasReconcile';
import { importLearningCredentialKeyRing } from '../src/lib/learningCredentials';
import { getLearningCourseForLearner, listLearningCoursesForLearner } from '../src/lib/learningLearnerDb';
import type { AppDb } from '../src/lib/appDb';
import { normalizeLearningResource } from '../src/lib/learningModel';

// The seed file never uses ';' except to terminate statements and keeps every
// comment on its own line, so we can strip comment lines and split on ';'.
function seedStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

beforeAll(async () => {
  for (const statement of seedStatements(seedSql)) {
    await env.DB.prepare(statement).run();
  }
});

describe('demo seed: people', () => {
  it('has the admin person with role admin', async () => {
    const row = await env.DB.prepare(
      "SELECT display_name, role FROM people WHERE email = 'admin@example.com'",
    ).first<{ display_name: string; role: string }>();
    expect(row?.role).toBe('admin');
    expect(row?.display_name).toBe('Alex Admin');
  });

  it('has an editor pastor and eight volunteers, all @example.com', async () => {
    const editor = await env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE role = 'editor'").first<{ n: number }>();
    expect(editor?.n).toBeGreaterThanOrEqual(1);
    const bad = await env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE email NOT LIKE '%@example.com'").first<{
      n: number;
    }>();
    expect(bad?.n).toBe(0);
  });
});

describe('demo seed: ministries have both locales', () => {
  it('every ministry has exactly one en and one zh i18n row', async () => {
    const ministries = await env.DB.prepare('SELECT COUNT(*) AS n FROM ministries').first<{ n: number }>();
    const i18n = await env.DB.prepare('SELECT COUNT(*) AS n FROM ministry_i18n').first<{ n: number }>();
    expect(ministries?.n).toBe(10);
    expect(i18n?.n).toBe((ministries?.n ?? 0) * 2);

    const missing = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ministries m WHERE NOT EXISTS (SELECT 1 FROM ministry_i18n WHERE ministry_id = m.id AND locale = 'en') OR NOT EXISTS (SELECT 1 FROM ministry_i18n WHERE ministry_id = m.id AND locale = 'zh')",
    ).first<{ n: number }>();
    expect(missing?.n).toBe(0);
  });
});

describe('demo seed: plans, bulletins, sermons', () => {
  it('seeds 16 plans (8 Sundays x 2 service types)', async () => {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM plans').first<{ n: number }>();
    expect(row?.n).toBe(16);
  });

  it('has at least two published bulletins', async () => {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bulletins WHERE status = 'published'").first<{ n: number }>();
    expect(row?.n).toBeGreaterThanOrEqual(2);
  });

  it('has at least 8 published sermons across 2 service types', async () => {
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM sermons WHERE status = 'published'").first<{ n: number }>();
    expect(total?.n).toBeGreaterThanOrEqual(8);
    const types = await env.DB.prepare(
      "SELECT COUNT(DISTINCT service_type_id) AS n FROM sermons WHERE status = 'published'",
    ).first<{ n: number }>();
    expect(types?.n).toBe(2);
  });
});

describe('demo seed: aggregate service attendance', () => {
  it('seeds adult totals without an attendee roster and derives children from real check-ins', async () => {
    const aggregateRows = await env.DB.prepare(
      `SELECT service_type_id, attendance_date, adult_count
       FROM service_attendance ORDER BY attendance_date DESC, service_type_id`,
    ).all<{ service_type_id: number; attendance_date: string; adult_count: number }>();
    expect(aggregateRows.results).toHaveLength(8);
    expect(new Set(aggregateRows.results.map((row) => row.service_type_id))).toEqual(new Set([1, 2]));
    expect(aggregateRows.results.every((row) => Number.isInteger(row.adult_count) && row.adult_count > 0)).toBe(true);

    const attendanceColumns = await env.DB.prepare('PRAGMA table_info(service_attendance)').all<{ name: string }>();
    expect(attendanceColumns.results.map((column) => column.name)).toEqual([
      'service_type_id', 'attendance_date', 'adult_count',
      'recorded_by_person_id', 'updated_by_person_id', 'created_at', 'updated_at',
      'campus_id',
    ]);

    const anchor = await env.DB.prepare("SELECT date('now','weekday 0','-7 days') AS d").first<{ d: string }>();
    const oldest = await env.DB.prepare("SELECT date('now','weekday 0','-28 days') AS d").first<{ d: string }>();
    const report = await listServiceAttendanceReport(env.DB, 'en', { from: oldest!.d, to: anchor!.d });
    const latestEnglish = report.find((row) => row.attendanceDate === anchor!.d && row.serviceTypeId === 1);
    const latestChinese = report.find((row) => row.attendanceDate === anchor!.d && row.serviceTypeId === 2);
    expect(latestEnglish).toMatchObject({ adultCount: 142, childCount: 2, combinedCount: 144 });
    expect(latestChinese).toMatchObject({ adultCount: 118, childCount: null, combinedCount: null });
  });

  it('seeds one effective append-only child-event link and matching CAS state', async () => {
    const links = await env.DB.prepare(
      `SELECT service_type_id, checkin_event_id, starts_on, ends_on
       FROM service_type_checkin_events ORDER BY id`,
    ).all<{ service_type_id: number; checkin_event_id: number; starts_on: string; ends_on: string | null }>();
    expect(links.results).toEqual([
      expect.objectContaining({ service_type_id: 1, checkin_event_id: 1, ends_on: null }),
    ]);
    const state = await env.DB.prepare(
      'SELECT service_type_id, revision, last_mutation_id FROM service_checkin_link_state ORDER BY service_type_id',
    ).all();
    expect(state.results).toEqual([{ service_type_id: 1, revision: 1, last_mutation_id: 'seed-attendance-link' }]);
  });
});

describe('demo seed: announcements and events are bilingual', () => {
  it('every announcement has both en and zh rows', async () => {
    const missing = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM announcements a WHERE NOT EXISTS (SELECT 1 FROM announcement_i18n WHERE announcement_id = a.id AND locale = 'en') OR NOT EXISTS (SELECT 1 FROM announcement_i18n WHERE announcement_id = a.id AND locale = 'zh')",
    ).first<{ n: number }>();
    expect(missing?.n).toBe(0);
  });

  it('every event has both en and zh rows', async () => {
    const missing = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events e WHERE NOT EXISTS (SELECT 1 FROM event_i18n WHERE event_id = e.id AND locale = 'en') OR NOT EXISTS (SELECT 1 FROM event_i18n WHERE event_id = e.id AND locale = 'zh')",
    ).first<{ n: number }>();
    expect(missing?.n).toBe(0);
  });
});

describe('demo seed: media references', () => {
  // The content-addressed keys in seed/media/manifest.json are duplicated by hand
  // in dev-seed.sql (media rows + hero/event/ministry/avatar references). If an
  // image is regenerated its key changes, and every copy must move together —
  // these checks fail when manifest.json and dev-seed.sql drift apart.
  it('dev-seed.sql references exactly the manifest asset keys', () => {
    const sqlKeys = new Set([...seedSql.matchAll(/'(?:\/media\/)?(uploads\/[^']+)'/g)].map((m) => m[1]));
    const manifestKeys = new Set(manifest.assets.map((a) => a.key));
    expect([...sqlKeys].sort()).toEqual([...manifestKeys].sort());
  });

  it('every manifest target row carries its manifest key after seeding', async () => {
    for (const asset of manifest.assets) {
      const target = asset.target as { type: string; key?: string; id?: number };
      if (target.type === 'setting') {
        const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(target.key).first<{ value: string }>();
        expect(row?.value).toBe(asset.key);
      } else if (target.type === 'event') {
        const row = await env.DB.prepare('SELECT image_key FROM events WHERE id = ?').bind(target.id).first<{ image_key: string }>();
        expect(row?.image_key).toBe(asset.key);
      } else if (target.type === 'ministry') {
        const row = await env.DB.prepare('SELECT cover_key FROM ministries WHERE id = ?').bind(target.id).first<{ cover_key: string }>();
        expect(row?.cover_key).toBe(asset.key);
      } else if (target.type === 'person') {
        const row = await env.DB.prepare('SELECT avatar_url FROM people WHERE id = ?').bind(target.id).first<{ avatar_url: string }>();
        expect(row?.avatar_url).toBe(`/media/${asset.key}`);
      } else {
        throw new Error(`unknown manifest target type: ${target.type}`);
      }
      const media = await env.DB.prepare('SELECT filename FROM media WHERE r2_key = ?').bind(asset.key).first<{ filename: string }>();
      expect(media?.filename).toBe(asset.file);
    }
  });

  it('seeds media-backed demo image references', async () => {
    const hero = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site.hero_image_key'").first<{ value: string }>();
    expect(hero?.value).toMatch(/^uploads\/[a-f0-9]{16}-hero-worship-gathering\.webp$/);

    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE image_key LIKE 'uploads/%'").first<{ n: number }>();
    expect(events?.n).toBe(3);

    const covers = await env.DB.prepare("SELECT COUNT(*) AS n FROM ministries WHERE cover_key LIKE 'uploads/%'").first<{ n: number }>();
    expect(covers?.n).toBe(6);

    const avatars = await env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE avatar_url LIKE '/media/uploads/%'").first<{ n: number }>();
    expect(avatars?.n).toBe(8);

    const media = await env.DB.prepare("SELECT COUNT(*) AS n FROM media WHERE r2_key LIKE 'uploads/%' AND content_type = 'image/webp'").first<{ n: number }>();
    expect(media?.n).toBeGreaterThanOrEqual(18);
  });
});

describe('demo seed: settings cover every reader key', () => {
  it('getSiteIdentity returns non-empty values in both locales', async () => {
    for (const locale of ['en', 'zh'] as const) {
      const identity = await getSiteIdentity(env.DB, locale);
      expect(identity.name).not.toBe('');
      expect(identity.tagline).not.toBe('');
      expect(identity.address).not.toBe('');
      expect(identity.email).not.toBe('');
      expect(identity.phone).not.toBe('');
      expect(identity.serviceTimes).not.toBe('');
      expect(identity.givingUrl).not.toBe('');
      expect(identity.youtubeUrl).not.toBe('');
      expect(identity.mapUrl).not.toBe('');
    }
    expect((await getSiteIdentity(env.DB, 'en')).name).toBe('Church4Christ');
    expect((await getSiteIdentity(env.DB, 'zh')).name).toBe('四方基督教会');
  });

  it('getTheme returns the seeded sanctuary theme', async () => {
    expect(await getTheme(env.DB)).toEqual({ theme: 'sanctuary', defaultMode: 'light' });
  });
});

describe('demo seed: people module — households, notes, statuses', () => {
  it('seeds three live households (Chen, Lin, Zhao)', async () => {
    const { results } = await env.DB.prepare(
      'SELECT name FROM households WHERE deleted_at IS NULL ORDER BY id',
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(['Chen Family 陈家', 'Lin Family 林家', 'Zhao Household 赵家']);
  });

  it('seeds nine household members with exactly one primary per household', async () => {
    // 6 original members (Task 5) + 3 children's check-in dependents (Task 7):
    // Mia Chen (household 1), Noah Lin + Lily Lin (household 2).
    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM household_members').first<{ n: number }>();
    expect(total?.n).toBe(9);
    const notPrimaryExactlyOne = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM households h
         WHERE h.deleted_at IS NULL
           AND (SELECT COUNT(*) FROM household_members WHERE household_id = h.id AND is_primary = 1) != 1`,
      )
      .first<{ n: number }>();
    expect(notPrimaryExactlyOne?.n).toBe(0);
  });

  it('gives the Chen household two real adults plus two name-only child dependents', async () => {
    const { results } = await env.DB
      .prepare('SELECT person_id, role, is_primary FROM household_members WHERE household_id = 1 ORDER BY id')
      .all<{ person_id: number | null; role: string; is_primary: number }>();
    expect(results).toEqual([
      { person_id: 2, role: 'adult', is_primary: 1 }, // David Chen, primary
      { person_id: 7, role: 'adult', is_primary: 0 }, // Amy Chen
      { person_id: null, role: 'child', is_primary: 0 }, // Ethan — name-only dependent
      { person_id: null, role: 'child', is_primary: 0 }, // Mia — name-only dependent (Task 7)
    ]);
    // 4 name-only dependents total: Ethan + Mia (Chen), Noah + Lily (Lin).
    const dependents = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM household_members WHERE person_id IS NULL`)
      .first<{ n: number }>();
    expect(dependents?.n).toBe(4);
  });

  it('never assigns a real person to more than one household', async () => {
    const dupes = await env.DB
      .prepare(
        `SELECT person_id, COUNT(*) AS n FROM household_members
         WHERE person_id IS NOT NULL GROUP BY person_id HAVING n > 1`,
      )
      .all();
    expect(dupes.results).toEqual([]);
  });

  it('seeds two admin-authored pastoral notes on two different people', async () => {
    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM person_notes WHERE deleted_at IS NULL').first<{ n: number }>();
    expect(total?.n).toBe(2);
    const distinctPeople = await env.DB
      .prepare('SELECT COUNT(DISTINCT person_id) AS n FROM person_notes WHERE deleted_at IS NULL')
      .first<{ n: number }>();
    expect(distinctPeople?.n).toBe(2);
    const nonAdmin = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM person_notes WHERE author_email != 'admin@example.com'")
      .first<{ n: number }>();
    expect(nonAdmin?.n).toBe(0);
  });

  it('spreads membership_status across all four enum values', async () => {
    const { results } = await env.DB
      .prepare('SELECT membership_status AS s, COUNT(*) AS n FROM people GROUP BY membership_status')
      .all<{ s: string; n: number }>();
    const byStatus = new Map(results.map((r) => [r.s, r.n]));
    for (const status of ['visitor', 'regular', 'member', 'inactive']) {
      expect(byStatus.get(status) ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives every member a joined_on date and leaves non-members without one', async () => {
    const membersMissing = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM people WHERE membership_status = 'member' AND joined_on IS NULL")
      .first<{ n: number }>();
    expect(membersMissing?.n).toBe(0);
    const nonMembersWith = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM people WHERE membership_status != 'member' AND joined_on IS NOT NULL")
      .first<{ n: number }>();
    expect(nonMembersWith?.n).toBe(0);
  });
});

describe('demo seed: member portal shared fixtures', () => {
  it('makes David Chen the Chen household owner', async () => {
    const row = await env.DB
      .prepare('SELECT is_owner FROM household_members WHERE household_id = 1 AND person_id = 2')
      .first<{ is_owner: number }>();
    expect(row?.is_owner).toBe(1);
  });

  it('includes an in-session Sunday School group with a term', async () => {
    const row = await env.DB
      .prepare(
        `SELECT kind, term_label, term_start, term_end
         FROM groups
         WHERE kind = 'sunday_school'
           AND term_label IS NOT NULL
           AND term_start <= date('now')
           AND term_end >= date('now')`,
      )
      .first<{ kind: string; term_label: string; term_start: string; term_end: string }>();
    expect(row).toMatchObject({
      kind: 'sunday_school',
      term_label: 'Foundations of Faith 信仰基础',
    });
  });
});

describe('demo seed: fictional Genesis 1 Learning course', () => {
  const courseId = 21000;
  const connectionId = 21000;
  const baseUrl = 'https://canvas-learning.example.test';

  it('seeds one explicitly local fictional Canvas snapshot without credentials', async () => {
    const connection = await env.DB.prepare(`SELECT provider, display_name, base_url, status,
      last_successful_sync_at FROM learning_provider_connections WHERE id=?1`)
      .bind(connectionId).first<Record<string, unknown>>();
    expect(connection).toMatchObject({
      provider: 'canvas',
      display_name: 'Local fictional Canvas snapshot / 本地虚构 Canvas 快照',
      base_url: baseUrl,
      status: 'active',
    });
    expect(Date.now() - Date.parse(String(connection?.last_successful_sync_at))).toBeLessThan(24 * 60 * 60 * 1_000);
    const credentials = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM learning_provider_credentials WHERE connection_id=?1',
    ).bind(connectionId).first<{ n: number }>();
    expect(credentials?.n).toBe(0);
  });

  it('seeds the exact bilingual Sunday-school sequence and safe resource metadata', async () => {
    const course = await env.DB.prepare(`SELECT program.display_name AS program_name,
      course.display_name, course.launch_url, course.last_synced_at
      FROM learning_courses course JOIN learning_programs program ON program.id=course.program_id
      WHERE course.id=?1`).bind(courseId).first<Record<string, unknown>>();
    expect(course).toMatchObject({
      program_name: 'Genesis Sunday School / 创世记主日学',
      display_name: 'Genesis 1: Creation / 创世记第一章：创造',
      launch_url: `${baseUrl}/courses/genesis-1-creation`,
    });
    expect(Date.now() - Date.parse(String(course?.last_synced_at))).toBeLessThan(24 * 60 * 60 * 1_000);

    const activities = await env.DB.prepare(`SELECT id, title, kind, launch_url, due_at
      FROM learning_activities WHERE course_id=?1 ORDER BY id`).bind(courseId)
      .all<{ id: number; title: string; kind: string; launch_url: string; due_at: string | null }>();
    expect(activities.results.map(({ id, title, kind }) => ({ id, title, kind }))).toEqual([
      { id: 21101, title: 'Opening: In the beginning / 开场：起初', kind: 'material' },
      { id: 21102, title: 'Scripture overview: Genesis 1 / 经文概览：创世记第一章', kind: 'material' },
      { id: 21103, title: 'Days 1–3: Forming creation / 第1–3日：塑造创造', kind: 'material' },
      { id: 21104, title: 'Days 4–6: Humanity and stewardship / 第4–6日：人类与管家职分', kind: 'material' },
      { id: 21105, title: 'Assignment: Creation care reflection / 作业：创造关怀反思', kind: 'assignment' },
      { id: 21106, title: 'Quiz: Genesis 1 review / 测验：创世记第一章复习', kind: 'quiz' },
    ]);
    expect(activities.results.slice(0, 4).every((row) => row.due_at === null)).toBe(true);
    expect(Date.parse(activities.results[4].due_at!) - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1_000);
    expect(Date.parse(activities.results[5].due_at!) - Date.now()).toBeGreaterThan(4 * 24 * 60 * 60 * 1_000);
    expect(activities.results.every((row) => row.launch_url.startsWith(`${baseUrl}/`))).toBe(true);

    const resources = await env.DB.prepare(`SELECT id, title, kind, launch_url,
      youtube_video_id, mime_type, size_bytes FROM learning_resources
      WHERE activity_id BETWEEN 21101 AND 21106 ORDER BY id`).all<Record<string, unknown>>();
    expect(resources.results).toEqual([
      expect.objectContaining({ id: 21201, kind: 'youtube', launch_url: 'https://www.youtube-nocookie.com/embed/DemoGen1Vid', youtube_video_id: 'DemoGen1Vid' }),
      expect.objectContaining({ id: 21202, kind: 'provider_file', launch_url: `${baseUrl}/files/genesis-1-learner-handout/download`, mime_type: 'application/pdf' }),
      expect.objectContaining({ id: 21203, kind: 'provider_file', launch_url: `${baseUrl}/files/genesis-1-teacher-guide/download`, mime_type: 'application/pdf' }),
      expect.objectContaining({ id: 21204, kind: 'link', launch_url: `${baseUrl}/courses/genesis-1-creation/pages/creation-and-stewardship` }),
    ]);
    expect(resources.results.every((row) => {
      const url = new URL(String(row.launch_url));
      return url.origin === baseUrl || url.origin === 'https://www.youtube-nocookie.com';
    })).toBe(true);
  });

  it('enrolls an English and a Chinese @example.com learner with useful privacy-minimal states', async () => {
    const learners = await env.DB.prepare(`SELECT person.id AS person_id, person.email, person.lang,
      enrollment.id AS enrollment_id, identity.status, enrollment.state
      FROM learning_enrollments enrollment
      JOIN learning_identity_links identity ON identity.id=enrollment.identity_link_id
      JOIN people person ON person.id=identity.person_id
      WHERE enrollment.course_id=?1 ORDER BY person.id`).bind(courseId).all<Record<string, unknown>>();
    expect(learners.results).toEqual([
      { person_id: 3, email: 'sarah.johnson@example.com', lang: 'en', enrollment_id: 21303, status: 'active', state: 'active' },
      { person_id: 4, email: 'grace.lin@example.com', lang: 'zh', enrollment_id: 21304, status: 'active', state: 'active' },
    ]);

    const snapshots = await env.DB.prepare(`SELECT enrollment_id, activity_id, status, late,
      attempt_number, submitted_at IS NOT NULL AS has_submitted_at,
      returned_at IS NOT NULL AS has_returned_at
      FROM learning_submission_snapshots WHERE course_id=?1 ORDER BY enrollment_id, activity_id`)
      .bind(courseId).all<Record<string, unknown>>();
    expect(snapshots.results).toEqual([
      { enrollment_id: 21303, activity_id: 21105, status: 'submitted', late: 0, attempt_number: 1, has_submitted_at: 1, has_returned_at: 0 },
      { enrollment_id: 21303, activity_id: 21106, status: 'not_submitted', late: 0, attempt_number: 0, has_submitted_at: 0, has_returned_at: 0 },
      { enrollment_id: 21304, activity_id: 21105, status: 'returned', late: 0, attempt_number: 1, has_submitted_at: 1, has_returned_at: 1 },
      { enrollment_id: 21304, activity_id: 21106, status: 'submitted', late: 0, attempt_number: 1, has_submitted_at: 1, has_returned_at: 0 },
    ]);

    const events = await env.DB.prepare(`SELECT event_type, COUNT(*) AS n
      FROM learning_activity_events WHERE course_id=?1 GROUP BY event_type ORDER BY event_type`)
      .bind(courseId).all<Record<string, unknown>>();
    expect(events.results).toEqual([
      { event_type: 'assignment_submitted', n: 2 },
      { event_type: 'enrolled', n: 2 },
      { event_type: 'quiz_submitted', n: 1 },
      { event_type: 'submission_returned', n: 1 },
    ]);
  });

  it('is available only through the exact live learner authorization chain', async () => {
    const rawResources = await env.DB.prepare(`SELECT course.connection_id, course.provider,
      course.external_course_id, activity.external_activity_id, resource.external_resource_id,
      resource.title, resource.kind, resource.launch_url, resource.youtube_video_id,
      resource.mime_type, resource.size_bytes, resource.provider_updated_at, resource.id
      FROM learning_resources resource JOIN learning_activities activity ON activity.id=resource.activity_id
      JOIN learning_courses course ON course.id=activity.course_id
      WHERE course.id=?1 ORDER BY resource.id`).bind(courseId).all<Record<string, unknown>>();
    const policy = {
      connectionId, provider: 'canvas', baseUrl,
      providerLaunchOrigins: [baseUrl], providerFileOrigins: [baseUrl], externalLinkOrigins: [baseUrl],
    } as const;
    for (const row of rawResources.results) {
      expect(() => normalizeLearningResource({
        connectionId: row.connection_id,
        provider: row.provider,
        externalCourseId: row.external_course_id,
        externalActivityId: row.external_activity_id,
        externalResourceId: row.external_resource_id,
        title: row.title,
        kind: row.kind,
        launchUrl: row.launch_url,
        youtubeVideoId: row.youtube_video_id,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        providerUpdatedAt: row.provider_updated_at,
      }, policy), `resource ${String(row.id)}`).not.toThrow();
    }
    const nowEpochMs = Date.now();
    const english = await getLearningCourseForLearner(env.DB as AppDb, { personId: 3, courseId, nowEpochMs });
    const chinese = await listLearningCoursesForLearner(env.DB as AppDb, { personId: 4, nowEpochMs });
    expect(english).toMatchObject({
      courseId,
      displayName: 'Genesis 1: Creation / 创世记第一章：创造',
      provider: 'canvas',
      isStale: false,
    });
    expect(english?.activities).toHaveLength(6);
    expect(chinese.map((course) => course.courseId)).toEqual([courseId]);
    await expect(getLearningCourseForLearner(env.DB as AppDb, { personId: 5, courseId, nowEpochMs })).resolves.toBeNull();
  });

  it('does not assume provider network access for the credential-free local snapshot', async () => {
    const keyRing = await importLearningCredentialKeyRing(JSON.stringify({
      currentVersion: 1,
      keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(71))) },
    }));
    const fetcher = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(reconcileCanvasCourse(env.DB as AppDb, {
      connectionId,
      allowedOrigins: [baseUrl],
      externalCourseId: 'genesis-1-creation',
      trigger: 'manual',
      clientId: 'fictional-client-id',
      clientSecret: 'fictional-client-secret',
      keyRing,
      fetcher,
      now: Date.now,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'learning_canvas_reconcile_failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('demo seed: referential integrity', () => {
  it('has no foreign-key violations', async () => {
    const { results } = await env.DB.prepare('PRAGMA foreign_key_check').all();
    expect(results).toEqual([]);
  });
});
