// New-ministry wizard (workers project, migrated D1). A weekly + auto-generate
// submit creates the ministry, its first team, positions, the leader's
// membership, a service type, and 8 weeks of plans with needs applied; a
// non-weekly submit creates no service type or plans.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMinistryFromWizard, type MinistryWizardInput } from '../src/lib/ministryDb';

// Fixed Wednesday so the weekly generation is deterministic (Sundays 06-07 … 07-26 = 8).
const NOW = new Date('2030-06-05T12:00:00-05:00');

beforeAll(async () => {
  await env.DB.prepare(`INSERT INTO people (id, display_name, email) VALUES (1, 'Leader', 'leader@example.com')`).run();
});

const base: MinistryWizardInput = {
  name_en: 'Prayer Team',
  name_zh: '祷告组',
  category: 'care',
  icon: '🙏',
  intro_en: 'We pray.',
  intro_zh: '我们祷告。',
  leader_person_id: 1,
  meeting_time: 'Sundays',
  positions: [
    { name_en: 'Intercessor', name_zh: '代祷者', needed: 2, open: true },
    { name_en: 'Coordinator', name_zh: '统筹', needed: 1, open: false },
  ],
  frequency: 'sun',
  autoGenerate: true,
};

describe('createMinistryFromWizard — weekly + autoGenerate', () => {
  it('creates the ministry, team, positions, leader membership, service type, and 8 plans', async () => {
    const ministryId = await createMinistryFromWizard(env.DB, base, NOW);

    const min = await env.DB.prepare(`SELECT slug, category, icon FROM ministries WHERE id = ?`).bind(ministryId).first<{ slug: string; category: string; icon: string }>();
    expect(min).toMatchObject({ slug: 'prayer-team', category: 'care', icon: '🙏' });
    const names = await env.DB.prepare(`SELECT locale, name FROM ministry_i18n WHERE ministry_id = ? ORDER BY locale`).bind(ministryId).all<{ locale: string; name: string }>();
    expect(names.results.map((r) => `${r.locale}:${r.name}`)).toEqual(['en:Prayer Team', 'zh:祷告组']);

    const team = await env.DB.prepare(`SELECT id FROM teams WHERE ministry_id = ?`).bind(ministryId).first<{ id: number }>();
    expect(team).not.toBeNull();
    const leaderRow = await env.DB.prepare(`SELECT is_leader FROM team_members WHERE team_id = ? AND person_id = 1`).bind(team!.id).first<{ is_leader: number }>();
    expect(leaderRow?.is_leader).toBe(1);
    const posCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM positions WHERE team_id = ?`).bind(team!.id).first<{ n: number }>();
    expect(posCount!.n).toBe(2);

    // A service type was created; 8 weekly plans, each carrying both position needs.
    const st = await env.DB.prepare(`SELECT service_type_id AS id FROM service_type_i18n WHERE name = 'Prayer Team' AND locale = 'en'`).first<{ id: number }>();
    expect(st).not.toBeNull();
    const plans = await env.DB.prepare(`SELECT COUNT(*) AS n FROM plans WHERE service_type_id = ?`).bind(st!.id).first<{ n: number }>();
    expect(plans!.n).toBe(8);
    const needs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM plan_positions pp JOIN plans p ON p.id = pp.plan_id WHERE p.service_type_id = ?`,
    ).bind(st!.id).first<{ n: number }>();
    expect(needs!.n).toBe(16); // 8 plans × 2 positions
  });
});

describe('createMinistryFromWizard — non-weekly', () => {
  it('creates no service type and no plans', async () => {
    const before = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM service_types`).first<{ n: number }>())!.n;
    await createMinistryFromWizard(env.DB, { ...base, name_en: 'Meals', name_zh: '爱筵', frequency: 'monthly' }, NOW);
    const after = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM service_types`).first<{ n: number }>())!.n;
    expect(after).toBe(before);
  });
});
