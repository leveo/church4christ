// Prayer-wall admin data-access (workers project, live D1). Ports the reference stack
// prayer-wall suite to our grouped-board API: move logs a 'moved' activity row and
// rejects an unknown status; pray/comment are logged (comment clamped to 2000,
// empty rejected); delete removes the request AND its activity in one batch; the
// two terminal columns fold cards older than 90 days unless {all:true}; and the
// new-request count + per-card activity count.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PRAYER_STATUSES,
  listPrayerRequests,
  listPrayerActivity,
  movePrayerRequest,
  markPrayed,
  addPrayerComment,
  deletePrayerRequest,
  countNewPrayerRequests,
} from '../src/lib/adminDb';

beforeEach(async () => {
  await env.DB.batch(['DELETE FROM prayer_activity', 'DELETE FROM prayer_requests'].map((s) => env.DB.prepare(s)));
});

/** Insert a request (optional status + created_at offset in days from now). */
async function seed(message: string, status = 'new', ageDays = 0): Promise<number> {
  const created = ageDays === 0 ? "datetime('now')" : `datetime('now','-${ageDays} days')`;
  const r = await env.DB.prepare(
    `INSERT INTO prayer_requests (name, email, message, status, created_at) VALUES (?1, ?2, ?3, ?4, ${created})`,
  )
    .bind('Someone', 'someone@example.com', message, status)
    .run();
  return r.meta.last_row_id as number;
}

async function activityCount(id: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prayer_activity WHERE request_id = ?`).bind(id).first<{ n: number }>();
  return row?.n ?? 0;
}

describe('listPrayerRequests — grouped board', () => {
  it('groups every request into its status column, newest first', async () => {
    await seed('a', 'new');
    await seed('b', 'praying');
    const bId = await seed('c', 'new');
    const board = await listPrayerRequests(env.DB);
    expect(Object.keys(board).sort()).toEqual([...PRAYER_STATUSES].sort());
    expect(board.new.map((r) => r.message)).toEqual(['c', 'a']); // newest id first
    expect(board.new[0].id).toBe(bId);
    expect(board.praying.map((r) => r.message)).toEqual(['b']);
    expect(board.long_term).toEqual([]);
  });

  it('carries each card its prayer_activity count', async () => {
    const id = await seed('needs prayer');
    await markPrayed(env.DB, id, 'ed@example.com');
    await markPrayed(env.DB, id, 'ed2@example.com');
    const board = await listPrayerRequests(env.DB);
    expect(board.new[0].activity_count).toBe(2);
  });

  it('folds terminal-column cards older than 90 days unless {all:true}', async () => {
    const oldAnswered = await seed('old answered', 'answered', 100);
    const recentAnswered = await seed('recent answered', 'answered', 5);
    const oldCancelled = await seed('old cancelled', 'cancelled', 120);
    const oldNew = await seed('old but active', 'new', 200); // active columns never fold

    const folded = await listPrayerRequests(env.DB);
    expect(folded.answered.map((r) => r.id)).toEqual([recentAnswered]);
    expect(folded.cancelled).toEqual([]);
    expect(folded.new.map((r) => r.id)).toContain(oldNew);

    const all = await listPrayerRequests(env.DB, { all: true });
    expect(all.answered.map((r) => r.id).sort()).toEqual([recentAnswered, oldAnswered].sort());
    expect(all.cancelled.map((r) => r.id)).toEqual([oldCancelled]);
  });
});

describe('movePrayerRequest', () => {
  it('changes the status and logs a moved activity row (body = new status)', async () => {
    const id = await seed('move me');
    await movePrayerRequest(env.DB, id, 'praying', 'ed@example.com');
    const log = await listPrayerActivity(env.DB, id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'moved', body: 'praying', author: 'ed@example.com' });
    const board = await listPrayerRequests(env.DB);
    expect(board.praying.map((r) => r.id)).toEqual([id]);
  });

  it('a no-op move (same status) logs nothing', async () => {
    const id = await seed('stay');
    await movePrayerRequest(env.DB, id, 'new', 'ed@example.com');
    expect(await activityCount(id)).toBe(0);
  });

  it('rejects an unknown status', async () => {
    const id = await seed('bad');
    await expect(movePrayerRequest(env.DB, id, 'archived', 'ed@example.com')).rejects.toThrow(/invalid prayer status/);
    expect(await activityCount(id)).toBe(0);
  });
});

describe('markPrayed + addPrayerComment', () => {
  it('logs a prayed row and a comment row, oldest-first', async () => {
    const id = await seed('pray + comment');
    await markPrayed(env.DB, id, 'ed@example.com');
    await addPrayerComment(env.DB, id, 'ed@example.com', 'Praying for you.');
    const log = await listPrayerActivity(env.DB, id);
    expect(log.map((a) => a.kind)).toEqual(['prayed', 'comment']);
    expect(log[1].body).toBe('Praying for you.');
  });

  it('clamps a comment to 2000 chars and rejects an empty one', async () => {
    const id = await seed('c');
    await addPrayerComment(env.DB, id, 'ed', 'x'.repeat(2500));
    const log = await listPrayerActivity(env.DB, id);
    expect(log[0].body).toHaveLength(2000);
    await expect(addPrayerComment(env.DB, id, 'ed', '   ')).rejects.toThrow();
  });
});

describe('deletePrayerRequest', () => {
  it('removes the request AND all its activity (same batch)', async () => {
    const id = await seed('delete me');
    await markPrayed(env.DB, id, 'ed');
    await addPrayerComment(env.DB, id, 'ed', 'hi');
    await deletePrayerRequest(env.DB, id);
    const req = await env.DB.prepare(`SELECT COUNT(*) AS n FROM prayer_requests WHERE id = ?`).bind(id).first<{ n: number }>();
    expect(req!.n).toBe(0);
    expect(await activityCount(id)).toBe(0);
  });
});

describe('countNewPrayerRequests', () => {
  it('counts only status = new', async () => {
    await seed('n1', 'new');
    await seed('n2', 'new');
    await seed('p', 'praying');
    expect(await countNewPrayerRequests(env.DB)).toBe(2);
  });
});
