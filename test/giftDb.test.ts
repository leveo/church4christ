// giftDb persistence (workers project, live D1): INSERT-only result history with
// latest-wins reads, JSON round-trip + null-safety, and the additive
// (INSERT OR IGNORE) interest merge that never removes an existing interest.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { addRecommendedToInterests, getLatestGiftResult, saveGiftResult } from '../src/lib/giftDb';

async function wipe(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM gift_results'),
    env.DB.prepare('DELETE FROM person_interests'),
    env.DB.prepare('DELETE FROM people'),
  ]);
  await env.DB.prepare(`INSERT INTO people (id, display_name, email) VALUES (1, 'Ana', 'ana@example.com')`).run();
}

beforeEach(wipe);

describe('saveGiftResult / getLatestGiftResult', () => {
  it('returns null when the person has no result', async () => {
    expect(await getLatestGiftResult(env.DB, 1)).toBeNull();
  });

  it('keeps history and returns the newest row (latest wins), JSON parsed', async () => {
    await env.DB
      .prepare(`INSERT INTO gift_results (person_id, top_gifts_json, recommended_json, created_at)
                VALUES (1, '["service"]', '["care"]', '2020-01-01 00:00:00')`)
      .run();
    await saveGiftResult(env.DB, 1, ['teaching', 'mercy', 'giving'], ['children', 'youth', 'care']);

    const latest = await getLatestGiftResult(env.DB, 1);
    expect(latest).toMatchObject({
      top_gifts: ['teaching', 'mercy', 'giving'],
      recommended: ['children', 'youth', 'care'],
    });

    // Both rows are retained as history.
    const { results } = await env.DB
      .prepare(`SELECT id FROM gift_results WHERE person_id = 1`)
      .all<{ id: number }>();
    expect(results).toHaveLength(2);
  });

  it('parses malformed JSON columns to empty arrays', async () => {
    await env.DB
      .prepare(`INSERT INTO gift_results (person_id, top_gifts_json, recommended_json) VALUES (1, 'not json', '{}')`)
      .run();
    const latest = await getLatestGiftResult(env.DB, 1);
    expect(latest).toMatchObject({ top_gifts: [], recommended: [] });
  });
});

describe('addRecommendedToInterests', () => {
  it('adds new categories without removing existing ones, deduping via INSERT OR IGNORE', async () => {
    await env.DB.prepare(`INSERT INTO person_interests (person_id, category) VALUES (1, 'worship')`).run();
    await addRecommendedToInterests(env.DB, 1, ['care', 'youth', 'care']); // 'care' duplicated in input
    await addRecommendedToInterests(env.DB, 1, ['worship', 'missions']); // 'worship' already present

    const { results } = await env.DB
      .prepare(`SELECT category FROM person_interests WHERE person_id = 1 ORDER BY category`)
      .all<{ category: string }>();
    expect(results.map((r) => r.category)).toEqual(['care', 'missions', 'worship', 'youth']);
  });

  it('is a no-op for an empty (or all-blank) list', async () => {
    await addRecommendedToInterests(env.DB, 1, []);
    await addRecommendedToInterests(env.DB, 1, ['  ', '']);
    const { results } = await env.DB
      .prepare(`SELECT category FROM person_interests WHERE person_id = 1`)
      .all<{ category: string }>();
    expect(results).toHaveLength(0);
  });
});
