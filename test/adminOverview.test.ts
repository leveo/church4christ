// Admin console Overview data (workers project, migrated D1 — no seed applied, so
// ministries/teams start empty). Covers role-scoped getStats and the four
// needs-attention buckets. Ported from the reference stack's adminOverview test, adapted to
// church-cms i18n tables + SessionUser shape.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { getNeedsAttention, getStats } from '../src/lib/adminOverviewDb';
import type { SessionUser } from '../src/lib/types';

const admin: SessionUser = { id: 1, email: 'a@x.com', displayName: 'A', role: 'admin', isAdmin: true, isEditor: false, isSuperAdmin: false, adminAreas: [], finance: 0, memberTeamIds: [], leaderTeamIds: [], lang: 'en' };
const leader: SessionUser = { id: 2, email: 'l@x.com', displayName: 'L', role: 'member', isAdmin: false, isEditor: false, isSuperAdmin: false, adminAreas: [], finance: 0, memberTeamIds: [1], leaderTeamIds: [1], lang: 'en' };

const FROM = '2030-01-01';
const TO = '2030-12-31';

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people (id, display_name, email) VALUES (1, 'Admin', 'a@x.com'), (2, 'Lead', 'l@x.com'), (3, 'Vol', 'v@x.com')`),
    env.DB.prepare(`INSERT INTO ministries (id, slug, category) VALUES (101, 'testworship', 'worship')`),
    env.DB.prepare(`INSERT INTO ministry_i18n (ministry_id, locale, name) VALUES (101, 'en', 'TestWorship')`),
    env.DB.prepare(`INSERT INTO teams (id, ministry_id) VALUES (1, 101), (2, NULL)`),
    env.DB.prepare(`INSERT INTO team_i18n (team_id, locale, name) VALUES (1, 'en', 'WT'), (2, 'en', 'Other')`),
    env.DB.prepare(`INSERT INTO positions (id, team_id) VALUES (1, 1), (2, 2)`),
    env.DB.prepare(`INSERT INTO position_i18n (position_id, locale, name) VALUES (1, 'en', 'Vocalist'), (2, 'en', 'Thing')`),
    env.DB.prepare(`INSERT INTO team_members (team_id, person_id, is_leader) VALUES (1, 2, 1), (1, 3, 0)`),
    env.DB.prepare(`INSERT INTO service_types (id) VALUES (1)`),
    env.DB.prepare(`INSERT INTO service_type_i18n (service_type_id, locale, name) VALUES (1, 'en', 'Sun')`),
    env.DB.prepare(`INSERT INTO plans (id, service_type_id, plan_date) VALUES (1, 1, '2030-09-01'), (2, 1, '2030-09-08')`),
    env.DB.prepare(`INSERT INTO plan_positions (plan_id, position_id, needed) VALUES (1, 1, 2), (2, 1, 2)`),
    env.DB.prepare(`INSERT INTO roster_assignments (id, plan_id, position_id, person_id, status, notified_at) VALUES
      (1, 1, 1, 3, 'C', NULL),
      (2, 1, 1, 2, 'U', datetime('now','-5 days'))`),
    env.DB.prepare(`INSERT INTO team_applications (person_id, team_id, status) VALUES (3, 1, 'P')`),
    env.DB.prepare(`INSERT INTO testimonies (person_id, author_name, locale, title, body, status) VALUES (3, 'Vol', 'en', 'T', 'b', 'P')`),
  ]);
});

describe('getStats', () => {
  it('admin scope returns church-wide counts', async () => {
    const byKey = Object.fromEntries((await getStats(env.DB, 'admin', admin, FROM)).map((s) => [s.key, s.value]));
    expect(byKey.ministries).toBe(1);
    expect(byKey.plans).toBe(2);
    expect(byKey.apps).toBe(1);
    expect(byKey.people).toBe(3);
  });

  it('leader scope scopes to led teams', async () => {
    const byKey = Object.fromEntries((await getStats(env.DB, 'leader', leader, FROM)).map((s) => [s.key, s.value]));
    expect(byKey.members).toBe(2); // leader + vol on team 1
    expect(byKey.apps).toBe(1);
    expect(byKey.plans).toBe(2);
    // plan1 pos1 needed 2, filled by 2 non-declined (C + stale U) → 0;
    // plan2 pos1 needed 2, filled by 0 → 2. Total unfilled = 2.
    expect(byKey.unfilled).toBe(2);
  });
});

describe('getNeedsAttention', () => {
  it('surfaces apps, testimonies (admin), understaffed plans, and stale requests', async () => {
    const kinds = (await getNeedsAttention(env.DB, 'admin', admin, FROM, TO, 'en')).map((i) => i.kind);
    expect(kinds).toContain('apps');
    expect(kinds).toContain('testimonies');
    expect(kinds).toContain('understaffed');
    expect(kinds).toContain('stale');
  });

  it('leader scope omits testimonies', async () => {
    const kinds = (await getNeedsAttention(env.DB, 'leader', leader, FROM, TO, 'en')).map((i) => i.kind);
    expect(kinds).not.toContain('testimonies');
    expect(kinds).toContain('apps');
  });
});
