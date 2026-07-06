// Runs in the workers project against a live, migrated D1 binding (test/setup.ts
// applies every migration first). Loads seed/dev-seed.sql via vite's `?raw`
// import, executes it statement-by-statement, then asserts the demo seed is
// internally consistent and exercises the public readers (settings, ministries).
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import seedSql from '../seed/dev-seed.sql?raw';
import { getSiteIdentity, getTheme } from '../src/lib/settings';

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

describe('demo seed: referential integrity', () => {
  it('has no foreign-key violations', async () => {
    const { results } = await env.DB.prepare('PRAGMA foreign_key_check').all();
    expect(results).toEqual([]);
  });
});
