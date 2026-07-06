// Runs in the workers project against a live, migrated D1 binding (test/setup.ts
// applies every migration; the pool rolls storage back per test). Covers db.ts:
// i18nJoin fragment building + validation, person lookups (soft-delete +
// case-insensitive email), and listMinistries' COALESCE fallback and aggregates.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getPersonByEmail, getPersonById, i18nJoin, listMinistries, type Locale } from '../src/lib/db';

// Storage is isolated per test file but not per test in this pool config, so
// each test starts from a clean slate (children before parents).
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM plan_positions'),
    env.DB.prepare('DELETE FROM plans'),
    env.DB.prepare('DELETE FROM positions'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM service_types'),
    env.DB.prepare('DELETE FROM ministry_i18n'),
    env.DB.prepare('DELETE FROM ministries'),
    env.DB.prepare('DELETE FROM people'),
  ]);
});

describe('i18nJoin', () => {
  it('builds the two LEFT JOINs and COALESCE select for a locale', () => {
    const { select, joins } = i18nJoin('ministry_i18n', 'm', 'ministry_id', ['name', 'intro'], 'zh');
    expect(select).toBe('COALESCE(m_l.name, m_d.name) AS name, COALESCE(m_l.intro, m_d.intro) AS intro');
    expect(joins).toBe(
      "LEFT JOIN ministry_i18n m_l ON m_l.ministry_id = m.id AND m_l.locale = 'zh' " +
        "LEFT JOIN ministry_i18n m_d ON m_d.ministry_id = m.id AND m_d.locale = 'en'",
    );
  });

  it("uses the requested locale for _l and always 'en' for the _d default", () => {
    const { joins } = i18nJoin('team_i18n', 't', 'team_id', ['name'], 'en');
    expect(joins).toContain("t_l.locale = 'en'");
    expect(joins).toContain("t_d.locale = 'en'");
  });

  it('throws on a locale outside LOCALES', () => {
    expect(() => i18nJoin('ministry_i18n', 'm', 'ministry_id', ['name'], 'fr' as Locale)).toThrow();
  });

  it('accepts digit-bearing table names (e.g. ministry_i18n) but rejects unsafe identifiers', () => {
    expect(() => i18nJoin('ministry_i18n', 'm', 'ministry_id', ['name'], 'en')).not.toThrow();
    expect(() => i18nJoin('ministry_i18n; DROP TABLE', 'm', 'ministry_id', ['name'], 'en')).toThrow();
    expect(() => i18nJoin('ministry_i18n', 'MX', 'ministry_id', ['name'], 'en')).toThrow(); // uppercase
    expect(() => i18nJoin('ministry_i18n', 'm', 'ministry_id', ['na me'], 'en')).toThrow(); // space
    expect(() => i18nJoin('ministry_i18n', 'm', 'ministry_id', ["name'"], 'en')).toThrow(); // quote
  });
});

describe('getPersonByEmail / getPersonById', () => {
  it('finds an active person case-insensitively + trimmed, skips soft-deleted and missing', async () => {
    const db = env.DB;
    await db.prepare("INSERT INTO people (display_name, email) VALUES ('Alice Active', 'alice@example.com')").run();
    await db
      .prepare("INSERT INTO people (display_name, email, deleted_at) VALUES ('Deb Deleted', 'deb@example.com', datetime('now'))")
      .run();

    const found = await getPersonByEmail(db, '  ALICE@Example.COM ');
    expect(found?.email).toBe('alice@example.com');
    expect(found?.display_name).toBe('Alice Active');

    expect(await getPersonByEmail(db, 'deb@example.com')).toBeNull();
    expect(await getPersonByEmail(db, 'nobody@example.com')).toBeNull();
  });

  it('getPersonById returns the row and skips soft-deleted', async () => {
    const db = env.DB;
    await db.prepare("INSERT INTO people (display_name, email) VALUES ('Alice Active', 'alice@example.com')").run();
    const active = await db.prepare("SELECT id FROM people WHERE email = 'alice@example.com'").first<{ id: number }>();
    expect((await getPersonById(db, active!.id))?.email).toBe('alice@example.com');

    await db
      .prepare("INSERT INTO people (display_name, email, deleted_at) VALUES ('Deb Deleted', 'deb@example.com', datetime('now'))")
      .run();
    const deleted = await db.prepare("SELECT id FROM people WHERE email = 'deb@example.com'").first<{ id: number }>();
    expect(await getPersonById(db, deleted!.id)).toBeNull();
  });
});

describe('listMinistries', () => {
  it('returns active, sorted ministries with coalesced name/intro (zh present + en fallback)', async () => {
    const db = env.DB;
    // A: zh + en → zh wins
    await db
      .prepare(
        "INSERT INTO ministries (id, slug, category, icon, cover_key, meeting_time, active, sort) VALUES (1, 'worship', 'sunday', '🎵', 'covers/worship.jpg', 'Sun 10am', 1, 2)",
      )
      .run();
    await db.prepare("INSERT INTO ministry_i18n (ministry_id, locale, name, intro) VALUES (1, 'en', 'Worship', 'Worship intro EN')").run();
    await db.prepare("INSERT INTO ministry_i18n (ministry_id, locale, name, intro) VALUES (1, 'zh', '敬拜', '敬拜简介')").run();
    // B: en only → zh request falls back to en via COALESCE
    await db.prepare("INSERT INTO ministries (id, slug, category, active, sort) VALUES (2, 'prayer', 'care', 1, 1)").run();
    await db.prepare("INSERT INTO ministry_i18n (ministry_id, locale, name, intro) VALUES (2, 'en', 'Prayer', 'Prayer intro EN')").run();
    // C: inactive → excluded
    await db.prepare("INSERT INTO ministries (id, slug, category, active, sort) VALUES (3, 'inactive-min', 'care', 0, 0)").run();
    await db.prepare("INSERT INTO ministry_i18n (ministry_id, locale, name) VALUES (3, 'en', 'Inactive')").run();
    // D: soft-deleted → excluded
    await db
      .prepare("INSERT INTO ministries (id, slug, category, active, sort, deleted_at) VALUES (4, 'deleted-min', 'care', 1, 5, datetime('now'))")
      .run();

    const rows = await listMinistries(db, 'zh');
    expect(rows.map((r) => r.slug)).toEqual(['prayer', 'worship']); // sort 1 before 2

    const worship = rows.find((r) => r.slug === 'worship')!;
    expect(worship.name).toBe('敬拜');
    expect(worship.intro).toBe('敬拜简介');
    expect(worship.icon).toBe('🎵');
    expect(worship.coverKey).toBe('covers/worship.jpg');
    expect(worship.meetingTime).toBe('Sun 10am');

    const prayer = rows.find((r) => r.slug === 'prayer')!;
    expect(prayer.name).toBe('Prayer'); // zh absent → en fallback
    expect(prayer.intro).toBe('Prayer intro EN');
  });

  it('counts non-deleted teams and future open-signup plan positions', async () => {
    const db = env.DB;
    await db.prepare("INSERT INTO ministries (id, slug, category, active, sort) VALUES (1, 'worship', 'sunday', 1, 0)").run();
    await db.prepare("INSERT INTO ministry_i18n (ministry_id, locale, name) VALUES (1, 'en', 'Worship')").run();
    // 2 live teams + 1 soft-deleted (should not count)
    await db.prepare("INSERT INTO teams (id, ministry_id, deleted_at) VALUES (10, 1, NULL), (11, 1, NULL), (12, 1, datetime('now'))").run();
    await db.prepare('INSERT INTO positions (id, team_id) VALUES (100, 10), (101, 11)').run();
    await db.prepare('INSERT INTO service_types (id) VALUES (1)').run();
    // one future plan, one past plan
    await db.prepare("INSERT INTO plans (id, service_type_id, plan_date) VALUES (200, 1, '2999-01-01'), (201, 1, '2000-01-01')").run();
    // future + open_signup → counts; future + not open → no; past + open → no
    await db.prepare('INSERT INTO plan_positions (plan_id, position_id, needed, open_signup) VALUES (200, 100, 1, 1)').run();
    await db.prepare('INSERT INTO plan_positions (plan_id, position_id, needed, open_signup) VALUES (200, 101, 1, 0)').run();
    await db.prepare('INSERT INTO plan_positions (plan_id, position_id, needed, open_signup) VALUES (201, 100, 1, 1)').run();

    const [m] = await listMinistries(db, 'en');
    expect(m.teamCount).toBe(2);
    expect(m.openSignupSlots).toBe(1);
  });

  it('reports zero aggregates for a ministry with no teams/plans', async () => {
    const db = env.DB;
    await db.prepare("INSERT INTO ministries (id, slug, category, active, sort) VALUES (1, 'quiet', 'care', 1, 0)").run();
    await db.prepare("INSERT INTO ministry_i18n (ministry_id, locale, name) VALUES (1, 'en', 'Quiet')").run();
    const [m] = await listMinistries(db, 'en');
    expect(m.teamCount).toBe(0);
    expect(m.openSignupSlots).toBe(0);
  });
});
