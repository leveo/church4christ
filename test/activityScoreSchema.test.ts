import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('activity score schema', () => {
  it('seeds one bounded model and the exact supported dimensions', async () => {
    const config = await env.DB.prepare(`
      SELECT id, window_days, include_visitor, include_regular, include_member,
             include_inactive, active_threshold, watch_threshold, revision,
             updated_by_person_id
      FROM activity_score_config
    `).first();
    expect(config).toEqual({
      id: 1,
      window_days: 90,
      include_visitor: 0,
      include_regular: 1,
      include_member: 1,
      include_inactive: 0,
      active_threshold: 70,
      watch_threshold: 40,
      revision: 0,
      updated_by_person_id: null,
    });

    const dimensions = await env.DB.prepare(`
      SELECT dimension_key, enabled, weight, target_count
      FROM activity_score_dimensions ORDER BY dimension_key
    `).all();
    expect(dimensions.results).toEqual([
      { dimension_key: 'group_attendance', enabled: 1, weight: 50, target_count: null },
      { dimension_key: 'learning_engagement', enabled: 0, weight: 0, target_count: 3 },
      { dimension_key: 'registration', enabled: 0, weight: 0, target_count: 2 },
      { dimension_key: 'serving', enabled: 1, weight: 50, target_count: 3 },
    ]);
  });

  it('enforces singleton, window, eligibility, threshold, and revision bounds', async () => {
    await expect(env.DB.prepare(`
      INSERT INTO activity_score_config
        (id, window_days, include_visitor, include_regular, include_member,
         include_inactive, active_threshold, watch_threshold, revision)
      VALUES (2, 90, 0, 1, 1, 0, 70, 40, 0)
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE activity_score_config SET window_days = 45 WHERE id = 1').run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE activity_score_config
      SET include_visitor = 0, include_regular = 0, include_member = 0, include_inactive = 0
      WHERE id = 1
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE activity_score_config SET watch_threshold = 70 WHERE id = 1').run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE activity_score_config SET revision = -1 WHERE id = 1').run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE activity_score_config SET updated_by_person_id = 999999 WHERE id = 1').run()).rejects.toThrow();
  });

  it('indexes only submission event evidence for bounded window reads', async () => {
    const indexes = await env.DB.prepare(`PRAGMA index_list('learning_activity_events')`).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toContain('idx_learning_events_activity_score');
  });

  it('enforces the dimension allowlist and coherent enabled, weight, and target values', async () => {
    await expect(env.DB.prepare(`
      INSERT INTO activity_score_dimensions (dimension_key, enabled, weight, target_count)
      VALUES ('giving', 1, 10, 1)
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE activity_score_dimensions SET enabled = 1, weight = 0
      WHERE dimension_key = 'serving'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE activity_score_dimensions SET enabled = 0, weight = 10
      WHERE dimension_key = 'serving'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE activity_score_dimensions SET target_count = 101
      WHERE dimension_key = 'serving'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE activity_score_dimensions SET target_count = 1
      WHERE dimension_key = 'group_attendance'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE activity_score_dimensions SET target_count = NULL
      WHERE dimension_key = 'registration'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE activity_score_dimensions SET target_count = 0
      WHERE dimension_key = 'learning_engagement'
    `).run()).rejects.toThrow();
  });
});
