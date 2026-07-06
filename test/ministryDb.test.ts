// Workers project (live, migrated D1). Covers ministryDb.ts: getMinistryBySlug's
// full assembled shape (localized-then-en fallback for ministry/team/position
// names, distinct non-deleted member counts, is_leader leader names, and
// openSignupCount limited to future non-deleted plans), its null result for an
// unknown/inactive/soft-deleted slug, and listPublishedTestimonies' locale-first
// ordering, published_at recency, limit, and exclusion of pending/rejected/deleted.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getMinistryBySlug, listPublishedTestimonies } from '../src/lib/ministryDb';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM testimonies'),
    env.DB.prepare('DELETE FROM plan_positions'),
    env.DB.prepare('DELETE FROM plans'),
    env.DB.prepare('DELETE FROM position_i18n'),
    env.DB.prepare('DELETE FROM positions'),
    env.DB.prepare('DELETE FROM team_members'),
    env.DB.prepare('DELETE FROM team_i18n'),
    env.DB.prepare('DELETE FROM teams'),
    env.DB.prepare('DELETE FROM service_types'),
    env.DB.prepare('DELETE FROM ministry_i18n'),
    env.DB.prepare('DELETE FROM ministries'),
    env.DB.prepare('DELETE FROM people'),
  ]);
});

describe('getMinistryBySlug', () => {
  async function seedWorship() {
    const db = env.DB;
    // People: named lead, a team leader, two members, and a soft-deleted person.
    await db.batch([
      db.prepare("INSERT INTO people (id, display_name, email) VALUES (1, 'Pastor Sam', 'sam@example.com')"),
      db.prepare("INSERT INTO people (id, display_name, email) VALUES (2, 'Alice', 'alice@example.com')"),
      db.prepare("INSERT INTO people (id, display_name, email) VALUES (3, 'Bob', 'bob@example.com')"),
      db.prepare("INSERT INTO people (id, display_name, email) VALUES (4, 'Tina Lead', 'tina@example.com')"),
      db.prepare("INSERT INTO people (id, display_name, email, deleted_at) VALUES (5, 'Ghost', 'ghost@example.com', datetime('now'))"),
    ]);
    await db.prepare(
      "INSERT INTO ministries (id, slug, category, icon, meeting_time, leader_person_id, active, sort) VALUES (1, 'worship', 'worship', '🎵', 'Sundays', 1, 1, 0)",
    ).run();
    await db.batch([
      db.prepare("INSERT INTO ministry_i18n (ministry_id, locale, name, intro) VALUES (1, 'en', 'Worship', 'Worship intro EN')"),
      db.prepare("INSERT INTO ministry_i18n (ministry_id, locale, name, intro) VALUES (1, 'zh', '敬拜', '敬拜简介')"),
    ]);
    // Teams: 10 (zh+en), 11 (en only → fallback), 12 (soft-deleted → excluded).
    await db.batch([
      db.prepare('INSERT INTO teams (id, ministry_id, sort) VALUES (10, 1, 1), (11, 1, 2)'),
      db.prepare("INSERT INTO teams (id, ministry_id, sort, deleted_at) VALUES (12, 1, 3, datetime('now'))"),
      db.prepare("INSERT INTO team_i18n (team_id, locale, name) VALUES (10, 'en', 'AV Team'), (10, 'zh', '媒体组'), (11, 'en', 'Greeters'), (12, 'en', 'Ghost Team')"),
    ]);
    // Members: team 10 has Tina (leader) + Alice + Ghost (deleted, uncounted);
    // team 11 has only Bob (not a leader).
    await db.batch([
      db.prepare('INSERT INTO team_members (team_id, person_id, is_leader) VALUES (10, 4, 1), (10, 2, 0), (10, 5, 0), (11, 3, 0)'),
    ]);
    // Positions: team 10 → 100 (zh+en), 101 (en only), 102 (soft-deleted);
    // team 11 → 103 (zh+en).
    await db.batch([
      db.prepare('INSERT INTO positions (id, team_id, sort) VALUES (100, 10, 1), (101, 10, 2), (103, 11, 1)'),
      db.prepare("INSERT INTO positions (id, team_id, sort, deleted_at) VALUES (102, 10, 3, datetime('now'))"),
      db.prepare("INSERT INTO position_i18n (position_id, locale, name) VALUES (100, 'en', 'Sound'), (100, 'zh', '音控'), (101, 'en', 'Slides'), (102, 'en', 'Gone'), (103, 'en', 'Greeter'), (103, 'zh', '迎新')"),
    ]);
    // Plans: one future, one past. Open-signup on 100 in both, but only the
    // future one should count toward team 10's openSignupCount.
    await db.prepare('INSERT INTO service_types (id) VALUES (1)').run();
    await db.prepare("INSERT INTO plans (id, service_type_id, plan_date) VALUES (200, 1, '2999-01-01'), (201, 1, '2000-01-01')").run();
    await db.prepare('INSERT INTO plan_positions (plan_id, position_id, needed, open_signup) VALUES (200, 100, 1, 1), (200, 101, 1, 0), (201, 100, 1, 1)').run();
  }

  it('assembles the localized ministry with fallback, member counts, and future open-signup counts', async () => {
    await seedWorship();
    const m = await getMinistryBySlug(env.DB, 'worship', 'zh');
    expect(m).not.toBeNull();
    expect(m!.name).toBe('敬拜');
    expect(m!.intro).toBe('敬拜简介');
    expect(m!.icon).toBe('🎵');
    expect(m!.meetingTime).toBe('Sundays');
    expect(m!.leaderName).toBe('Pastor Sam');

    expect(m!.teams.map((t) => t.id)).toEqual([10, 11]); // sort order, deleted 12 gone

    const av = m!.teams[0];
    expect(av.name).toBe('媒体组'); // zh present
    expect(av.memberCount).toBe(2); // Tina + Alice; Ghost (deleted) excluded
    expect(av.leaderNames).toEqual(['Tina Lead']);
    expect(av.positions.map((p) => p.name)).toEqual(['音控', 'Slides']); // 100 zh, 101 en fallback, 102 deleted gone
    expect(av.openSignupCount).toBe(1); // future open only

    const greeters = m!.teams[1];
    expect(greeters.name).toBe('Greeters'); // en fallback for zh request
    expect(greeters.memberCount).toBe(1);
    expect(greeters.leaderNames).toEqual([]);
    expect(greeters.positions.map((p) => p.name)).toEqual(['迎新']);
    expect(greeters.openSignupCount).toBe(0);
  });

  it('falls back to the en ministry name when the requested locale row is missing', async () => {
    const db = env.DB;
    await db.prepare("INSERT INTO ministries (id, slug, category, active) VALUES (1, 'care', 'care', 1)").run();
    await db.prepare("INSERT INTO ministry_i18n (ministry_id, locale, name, intro) VALUES (1, 'en', 'Care', 'Care intro')").run();
    const m = await getMinistryBySlug(db, 'care', 'zh');
    expect(m!.name).toBe('Care');
    expect(m!.leaderName).toBeNull();
    expect(m!.teams).toEqual([]);
  });

  it('returns null for an unknown, inactive, or soft-deleted slug', async () => {
    const db = env.DB;
    await db.prepare("INSERT INTO ministries (id, slug, category, active) VALUES (1, 'hidden', 'care', 0)").run();
    await db.prepare("INSERT INTO ministry_i18n (ministry_id, locale, name) VALUES (1, 'en', 'Hidden')").run();
    await db.prepare("INSERT INTO ministries (id, slug, category, active, deleted_at) VALUES (2, 'gone', 'care', 1, datetime('now'))").run();
    await db.prepare("INSERT INTO ministry_i18n (ministry_id, locale, name) VALUES (2, 'en', 'Gone')").run();

    expect(await getMinistryBySlug(db, 'nope', 'en')).toBeNull();
    expect(await getMinistryBySlug(db, 'hidden', 'en')).toBeNull(); // inactive
    expect(await getMinistryBySlug(db, 'gone', 'en')).toBeNull(); // soft-deleted
  });
});

describe('listPublishedTestimonies', () => {
  async function seedTestimonies() {
    const db = env.DB;
    // A-en (old) / B-en (new) / C-zh (mid) / D-zh (newest) approved; plus a
    // pending, a rejected, and a soft-deleted-approved that must all be excluded.
    await db.batch([
      db.prepare("INSERT INTO testimonies (id, author_name, locale, title, body, status, published_at) VALUES (1, 'A', 'en', 'A-en', 'body', 'A', '2026-01-01 00:00:00')"),
      db.prepare("INSERT INTO testimonies (id, author_name, locale, title, body, status, published_at) VALUES (2, 'B', 'en', 'B-en', 'body', 'A', '2026-03-01 00:00:00')"),
      db.prepare("INSERT INTO testimonies (id, author_name, locale, title, body, status, published_at) VALUES (3, 'C', 'zh', 'C-zh', 'body', 'A', '2026-02-01 00:00:00')"),
      db.prepare("INSERT INTO testimonies (id, author_name, locale, title, body, status, published_at) VALUES (4, 'D', 'zh', 'D-zh', 'body', 'A', '2026-04-01 00:00:00')"),
      db.prepare("INSERT INTO testimonies (id, author_name, locale, title, body, status, published_at) VALUES (5, 'P', 'en', 'P-pending', 'body', 'P', NULL)"),
      db.prepare("INSERT INTO testimonies (id, author_name, locale, title, body, status, published_at) VALUES (6, 'R', 'zh', 'R-rejected', 'body', 'R', NULL)"),
      db.prepare("INSERT INTO testimonies (id, author_name, locale, title, body, status, published_at, deleted_at) VALUES (7, 'X', 'en', 'X-deleted', 'body', 'A', '2026-05-01 00:00:00', datetime('now'))"),
    ]);
  }

  it('orders requested-locale rows first, then by published_at desc, excluding non-approved/deleted', async () => {
    await seedTestimonies();
    const rows = await listPublishedTestimonies(env.DB, 'en', 10);
    expect(rows.map((r) => r.title)).toEqual(['B-en', 'A-en', 'D-zh', 'C-zh']);
    expect(rows.map((r) => r.locale)).toEqual(['en', 'en', 'zh', 'zh']);
  });

  it('puts zh rows first for a zh request', async () => {
    await seedTestimonies();
    const rows = await listPublishedTestimonies(env.DB, 'zh', 10);
    expect(rows.map((r) => r.title)).toEqual(['D-zh', 'C-zh', 'B-en', 'A-en']);
  });

  it('applies the limit after the locale-first ordering', async () => {
    await seedTestimonies();
    const rows = await listPublishedTestimonies(env.DB, 'en', 2);
    expect(rows.map((r) => r.title)).toEqual(['B-en', 'A-en']);
  });

  it('returns an empty array when nothing is approved', async () => {
    const db = env.DB;
    await db.prepare("INSERT INTO testimonies (id, author_name, locale, title, body, status) VALUES (1, 'P', 'en', 'pend', 'body', 'P')").run();
    expect(await listPublishedTestimonies(db, 'en', 3)).toEqual([]);
  });
});
