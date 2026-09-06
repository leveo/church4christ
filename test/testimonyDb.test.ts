// testimonyDb writes + review queue (workers project, live D1): submit files a
// pending row; the pending list/count exclude approved/returned/deleted; approve
// publishes (stamps published_at) and is idempotent; return sends to 'R'; and
// neither action touches a row that is no longer pending.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  approveTestimony,
  countPendingTestimonies,
  listPendingTestimonies,
  returnTestimony,
  submitTestimony,
} from '../src/lib/testimonyDb';

const input = (over: Partial<Parameters<typeof submitTestimony>[1]> = {}) => ({
  person_id: null,
  author_name: 'Anonymous 匿名',
  locale: 'en' as const,
  title: 'God is faithful',
  body: 'A short story of grace.',
  category: null,
  ...over,
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM testimonies'),
    env.DB.prepare('DELETE FROM people'),
  ]);
});

describe('submitTestimony / listPendingTestimonies / countPendingTestimonies', () => {
  it('uses an anonymous label in the submission language when no author is supplied', async () => {
    await submitTestimony(env.DB, input({ title: 'English anonymous', author_name: '', locale: 'en' }));
    await submitTestimony(env.DB, input({ title: 'Chinese anonymous', author_name: '  ', locale: 'zh' }));
    const pending = await listPendingTestimonies(env.DB);
    expect(pending.map(({ author_name }) => author_name)).toEqual(['Anonymous', '匿名']);
  });

  it('keeps a supplied author name unchanged in either locale', async () => {
    const name = 'David Chen 陈大卫';
    await submitTestimony(env.DB, input({ title: 'Named English', author_name: name, locale: 'en' }));
    await submitTestimony(env.DB, input({ title: 'Named Chinese', author_name: name, locale: 'zh' }));
    expect((await listPendingTestimonies(env.DB)).map(({ author_name }) => author_name)).toEqual([name, name]);
  });

  it('files a pending row and surfaces it in the review queue (oldest first)', async () => {
    const id1 = await submitTestimony(env.DB, input({ title: 'First', author_name: 'Ada' }));
    const id2 = await submitTestimony(env.DB, input({ title: 'Second', locale: 'zh', author_name: '志明' }));
    expect(id2).toBeGreaterThan(id1);

    const pending = await listPendingTestimonies(env.DB);
    expect(pending.map((p) => p.title)).toEqual(['First', 'Second']);
    expect(pending[1]).toMatchObject({ locale: 'zh', author_name: '志明', person_id: null });
    expect(await countPendingTestimonies(env.DB)).toBe(2);
  });

  it('excludes non-pending and soft-deleted rows from the queue and count', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO testimonies (author_name, locale, title, body, status) VALUES ('A', 'en', 'approved', 'b', 'A')"),
      env.DB.prepare("INSERT INTO testimonies (author_name, locale, title, body, status) VALUES ('R', 'en', 'returned', 'b', 'R')"),
      env.DB.prepare("INSERT INTO testimonies (author_name, locale, title, body, status, deleted_at) VALUES ('D', 'en', 'gone', 'b', 'P', datetime('now'))"),
    ]);
    await submitTestimony(env.DB, input({ title: 'live-pending' }));
    expect((await listPendingTestimonies(env.DB)).map((p) => p.title)).toEqual(['live-pending']);
    expect(await countPendingTestimonies(env.DB)).toBe(1);
  });
});

describe('approveTestimony (idempotent)', () => {
  it('publishes a pending row once and no-ops on a second approve', async () => {
    const id = await submitTestimony(env.DB, input());
    expect(await approveTestimony(env.DB, id)).toBe(true);

    const row1 = await env.DB
      .prepare(`SELECT status, published_at FROM testimonies WHERE id = ?`)
      .bind(id)
      .first<{ status: string; published_at: string }>();
    expect(row1?.status).toBe('A');
    expect(row1?.published_at).not.toBeNull();

    // Second approve: no row moves, published_at is not re-stamped.
    expect(await approveTestimony(env.DB, id)).toBe(false);
    const row2 = await env.DB
      .prepare(`SELECT status, published_at FROM testimonies WHERE id = ?`)
      .bind(id)
      .first<{ status: string; published_at: string }>();
    expect(row2?.published_at).toBe(row1?.published_at);

    expect(await countPendingTestimonies(env.DB)).toBe(0);
  });
});

describe('returnTestimony', () => {
  it('returns a pending row and is a no-op once it is no longer pending', async () => {
    const id = await submitTestimony(env.DB, input());
    expect(await returnTestimony(env.DB, id)).toBe(true);
    expect(
      (await env.DB.prepare(`SELECT status FROM testimonies WHERE id = ?`).bind(id).first<{ status: string }>())?.status,
    ).toBe('R');

    // Already returned → neither approve nor a second return changes it.
    expect(await approveTestimony(env.DB, id)).toBe(false);
    expect(await returnTestimony(env.DB, id)).toBe(false);
    expect(
      (await env.DB.prepare(`SELECT status FROM testimonies WHERE id = ?`).bind(id).first<{ status: string }>())?.status,
    ).toBe('R');
  });
});
