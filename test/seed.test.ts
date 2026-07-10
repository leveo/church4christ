// Runs in the workers project against a live, migrated D1 binding (test/setup.ts
// applies every migration first). Loads seed/dev-seed.sql via vite's `?raw`
// import, executes it statement-by-statement, then asserts the demo seed is
// internally consistent and exercises the public readers (settings, ministries).
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import seedSql from '../seed/dev-seed.sql?raw';
import manifest from '../seed/media/manifest.json';
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

describe('demo seed: referential integrity', () => {
  it('has no foreign-key violations', async () => {
    const { results } = await env.DB.prepare('PRAGMA foreign_key_check').all();
    expect(results).toEqual([]);
  });
});
