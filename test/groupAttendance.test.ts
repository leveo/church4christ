// groupAttendance (workers project, live D1). Token mint/verify/expiry/tamper,
// atomic email claim, saveAttendance upsert, the canRecordAttendance session
// check, and sendAttendanceEmails end-to-end with the EMAIL_DEV_LOG stub (see
// digest.test.ts) — asserting the returned count + email_log rows.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearModuleCache } from '../src/lib/modules';
import { setSetting } from '../src/lib/settings';
import {
  canRecordAttendance,
  claimOccurrenceForEmail,
  createAttendanceToken,
  getAttendanceMap,
  saveAttendance,
  sendAttendanceEmails,
  verifyAttendanceToken,
} from '../src/lib/groupAttendance';

const ENV = { EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' };

async function reset(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM group_attendance'),
    env.DB.prepare('DELETE FROM group_attendance_tokens'),
    env.DB.prepare('DELETE FROM group_event_occurrences'),
    env.DB.prepare('DELETE FROM group_events'),
    env.DB.prepare('DELETE FROM group_members'),
    env.DB.prepare('DELETE FROM groups'),
    env.DB.prepare('DELETE FROM people'),
    env.DB.prepare('DELETE FROM email_log'),
  ]);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO people (id, display_name, email, role, active) VALUES (1, 'Site Admin', 'admin@example.com', 'admin', 1)"),
    env.DB.prepare("INSERT INTO people (id, display_name, email, role, active) VALUES (2, 'Member Two', 'p2@example.com', 'member', 1)"),
    env.DB.prepare("INSERT INTO people (id, display_name, email, role, active, lang) VALUES (3, 'Group Admin', 'p3@example.com', 'member', 1, 'en')"),
  ]);
  clearModuleCache();
}
beforeEach(reset);

/** A group with a tracked event and one materialized occurrence; returns ids. */
async function scaffold(opts: { endsAt?: string; startsOn?: string } = {}): Promise<{ groupId: number; occId: number }> {
  const g = await env.DB.prepare(`INSERT INTO groups (name) VALUES ('YA') RETURNING id`).first<{ id: number }>();
  const ev = await env.DB
    .prepare(
      `INSERT INTO group_events (group_id, title, recurrence, starts_on, start_time, track_attendance, active)
       VALUES (?1, 'Study', 'none', ?2, '19:00', 1, 1) RETURNING id`,
    )
    .bind(g!.id, opts.startsOn ?? '2030-06-20')
    .first<{ id: number }>();
  const occ = await env.DB
    .prepare(
      `INSERT INTO group_event_occurrences (event_id, occurs_on, starts_at, ends_at)
       VALUES (?1, '2030-06-09', '2030-06-09 23:00:00', ?2) RETURNING id`,
    )
    .bind(ev!.id, opts.endsAt ?? '2030-06-10 11:00:00')
    .first<{ id: number }>();
  return { groupId: g!.id, occId: occ!.id };
}

describe('attendance tokens', () => {
  it('mints, verifies (multi-use), and stamps used_at on first use', async () => {
    const { occId } = await scaffold();
    const raw = await createAttendanceToken(env.DB, occId, 3);

    const first = await verifyAttendanceToken(env.DB, raw);
    expect(first).toEqual({ occurrence_id: occId, person_id: 3 });
    const stamped = await env.DB.prepare('SELECT used_at FROM group_attendance_tokens WHERE person_id = 3').first<{ used_at: string | null }>();
    expect(stamped?.used_at).not.toBeNull();

    // Still valid after first use (multi-use until expiry).
    expect(await verifyAttendanceToken(env.DB, raw)).toEqual({ occurrence_id: occId, person_id: 3 });
  });

  it('rejects a tampered token', async () => {
    const { occId } = await scaffold();
    await createAttendanceToken(env.DB, occId, 3);
    expect(await verifyAttendanceToken(env.DB, 'not-a-real-token')).toBeNull();
  });

  it('rejects an expired token (past expires_at)', async () => {
    const { occId } = await scaffold();
    // Insert a token whose hash we know, with an expiry in the past.
    const raw = 'expired-raw-token';
    const hash = await sha256Hex(raw);
    await env.DB
      .prepare(`INSERT INTO group_attendance_tokens (occurrence_id, person_id, token_hash, expires_at) VALUES (?1, 3, ?2, datetime('now','-1 hour'))`)
      .bind(occId, hash)
      .run();
    expect(await verifyAttendanceToken(env.DB, raw)).toBeNull();
  });
});

describe('claimOccurrenceForEmail', () => {
  it('is won exactly once', async () => {
    const { occId } = await scaffold();
    expect(await claimOccurrenceForEmail(env.DB, occId)).toBe(true);
    expect(await claimOccurrenceForEmail(env.DB, occId)).toBe(false);
  });
});

describe('canRecordAttendance', () => {
  it('allows a group admin and a site admin, rejects a plain member', async () => {
    const { groupId, occId } = await scaffold();
    // Person 3 is a group admin, person 2 a plain member.
    await env.DB.prepare(`INSERT INTO group_members (group_id, person_id, display_name, is_admin) VALUES (?1, 3, 'Group Admin', 1)`).bind(groupId).run();
    await env.DB.prepare(`INSERT INTO group_members (group_id, person_id, display_name, is_admin) VALUES (?1, 2, 'Member Two', 0)`).bind(groupId).run();

    expect(await canRecordAttendance(env.DB, occId, 3)).toBe(true); // group admin
    expect(await canRecordAttendance(env.DB, occId, 2)).toBe(false); // plain member
    expect(await canRecordAttendance(env.DB, occId, 1)).toBe(true); // site admin, not a member
  });
});

describe('saveAttendance', () => {
  it('upserts present/absent for every active member', async () => {
    const { groupId, occId } = await scaffold();
    const m1 = (await env.DB.prepare(`INSERT INTO group_members (group_id, person_id, display_name) VALUES (?1, 1, 'One') RETURNING id`).bind(groupId).first<{ id: number }>())!.id;
    const m2 = (await env.DB.prepare(`INSERT INTO group_members (group_id, person_id, display_name) VALUES (?1, 2, 'Two') RETURNING id`).bind(groupId).first<{ id: number }>())!.id;
    const m3 = (await env.DB.prepare(`INSERT INTO group_members (group_id, display_name) VALUES (?1, 'Guest') RETURNING id`).bind(groupId).first<{ id: number }>())!.id;

    await saveAttendance(env.DB, occId, [m1, m2], 1);
    expect(await presentSet(occId)).toEqual({ [m1]: 1, [m2]: 1, [m3]: 0 });

    // Re-save flips the set (upsert, not insert).
    await saveAttendance(env.DB, occId, [m3], 1);
    expect(await presentSet(occId)).toEqual({ [m1]: 0, [m2]: 0, [m3]: 1 });
  });
});

describe('getAttendanceMap', () => {
  it('returns member_id → present for recorded rows only (unrecorded members absent)', async () => {
    const { groupId, occId } = await scaffold();
    const m1 = (await env.DB.prepare(`INSERT INTO group_members (group_id, person_id, display_name) VALUES (?1, 1, 'One') RETURNING id`).bind(groupId).first<{ id: number }>())!.id;
    const m2 = (await env.DB.prepare(`INSERT INTO group_members (group_id, person_id, display_name) VALUES (?1, 2, 'Two') RETURNING id`).bind(groupId).first<{ id: number }>())!.id;
    const m3 = (await env.DB.prepare(`INSERT INTO group_members (group_id, display_name) VALUES (?1, 'Guest') RETURNING id`).bind(groupId).first<{ id: number }>())!.id;

    expect(await getAttendanceMap(env.DB, occId)).toEqual({}); // nothing recorded yet

    await saveAttendance(env.DB, occId, [m1], 1); // m1 present, m2/m3 absent
    expect(await getAttendanceMap(env.DB, occId)).toEqual({ [m1]: 1, [m2]: 0, [m3]: 0 });
  });
});

describe('sendAttendanceEmails', () => {
  it('emails each group admin with an email, claims the occurrence, and logs it', async () => {
    const NOW = new Date('2030-06-10T12:00:00Z');
    const { groupId, occId } = await scaffold({ endsAt: '2030-06-10 11:00:00' });
    // Person 3 is the group admin (has an email); person 2 is a non-admin member.
    await env.DB.prepare(`INSERT INTO group_members (group_id, person_id, display_name, is_admin) VALUES (?1, 3, 'Group Admin', 1)`).bind(groupId).run();
    await env.DB.prepare(`INSERT INTO group_members (group_id, person_id, display_name, is_admin) VALUES (?1, 2, 'Member Two', 0)`).bind(groupId).run();

    const sent = await sendAttendanceEmails(ENV, env.DB, NOW);
    expect(sent).toBe(1);

    const log = await env.DB.prepare("SELECT to_email, kind FROM email_log WHERE kind = 'attendance'").all<{ to_email: string; kind: string }>();
    expect(log.results.map((r: { to_email: string }) => r.to_email)).toEqual(['p3@example.com']);

    const claimed = await env.DB.prepare('SELECT attendance_email_sent_at FROM group_event_occurrences WHERE id = ?').bind(occId).first<{ attendance_email_sent_at: string | null }>();
    expect(claimed?.attendance_email_sent_at).not.toBeNull();

    // A second pass sends nothing (already claimed).
    expect(await sendAttendanceEmails(ENV, env.DB, NOW)).toBe(0);
  });

  it('skips entirely when the groups module is disabled', async () => {
    const NOW = new Date('2030-06-10T12:00:00Z');
    const { groupId } = await scaffold({ endsAt: '2030-06-10 11:00:00' });
    await env.DB.prepare(`INSERT INTO group_members (group_id, person_id, display_name, is_admin) VALUES (?1, 3, 'Group Admin', 1)`).bind(groupId).run();

    await setSetting(env.DB, 'module.groups', '0');
    clearModuleCache();
    expect(await sendAttendanceEmails(ENV, env.DB, NOW)).toBe(0);

    await setSetting(env.DB, 'module.groups', '1');
    clearModuleCache();
  });
});

async function presentSet(occId: number): Promise<Record<number, number>> {
  const { results } = await env.DB.prepare('SELECT member_id, present FROM group_attendance WHERE occurrence_id = ?').bind(occId).all<{ member_id: number; present: number }>();
  return Object.fromEntries(results.map((r: { member_id: number; present: number }) => [r.member_id, r.present]));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
