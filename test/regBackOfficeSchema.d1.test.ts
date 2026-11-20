// The registration back office tables on D1 (migration 0053): constraints, defaults and cascades.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('registration back office schema (D1, migration 0053)', () => {
  const exec = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();

  it('defaults and constrains the event and registration columns', async () => {
    const event = await env.DB.prepare(`INSERT INTO reg_events (starts_at) VALUES ('2032-01-01 09:00:00') RETURNING id, requires_approval, reminder_days`).first<{ id: number; requires_approval: number; reminder_days: number | null }>();
    expect([event!.requires_approval, event!.reminder_days]).toEqual([0, null]);
    await expect(exec('UPDATE reg_events SET requires_approval = 2 WHERE id = ?1', event!.id)).rejects.toThrow();
    await expect(exec('UPDATE reg_events SET reminder_days = 0 WHERE id = ?1', event!.id)).rejects.toThrow();
    await expect(exec('UPDATE reg_events SET reminder_days = 31 WHERE id = ?1', event!.id)).rejects.toThrow();
    await exec('UPDATE reg_events SET reminder_days = 30 WHERE id = ?1', event!.id);
    const reg = await env.DB.prepare(`INSERT INTO registrations (event_id, name, email, submission_key) VALUES (?1, 'A', 'a@example.com', 'bo-1') RETURNING id, version, refunded_cents, payment_method, admin_note, decided_by`).bind(event!.id).first<Record<string, unknown>>();
    expect([reg!.version, reg!.refunded_cents, reg!.payment_method, reg!.admin_note, reg!.decided_by]).toEqual([1, 0, null, null, null]);
    await expect(exec(`UPDATE registrations SET payment_method = 'cash' WHERE id = ?1`, reg!.id)).rejects.toThrow();
    await expect(exec('UPDATE registrations SET refunded_cents = -1 WHERE id = ?1', reg!.id)).rejects.toThrow();
    for (const method of ['stripe', 'offline', 'comp']) await exec('UPDATE registrations SET payment_method = ?1 WHERE id = ?2', method, reg!.id);
  });

  it('constrains access roles, outbox kind and status, and cascades history', async () => {
    const event = await env.DB.prepare(`INSERT INTO reg_events (starts_at) VALUES ('2032-01-01 09:00:00') RETURNING id`).first<{ id: number }>();
    const person = await env.DB.prepare(`INSERT INTO people (display_name, email, active) VALUES ('Staff', 'bo-staff@example.com', 1) RETURNING id`).first<{ id: number }>();
    const reg = await env.DB.prepare(`INSERT INTO registrations (event_id, name, email, submission_key) VALUES (?1, 'A', 'a@example.com', 'bo-2') RETURNING id`).bind(event!.id).first<{ id: number }>();
    const attendee = await env.DB.prepare(`INSERT INTO reg_attendees (registration_id, name) VALUES (?1, 'A') RETURNING id`).bind(reg!.id).first<{ id: number }>();

    await expect(exec(`INSERT INTO reg_event_access (event_id, person_id, role) VALUES (?1, ?2, 'boss')`, event!.id, person!.id)).rejects.toThrow();
    await exec(`INSERT INTO reg_event_access (event_id, person_id, role) VALUES (?1, ?2, 'desk')`, event!.id, person!.id);
    await expect(exec(`INSERT INTO reg_event_access (event_id, person_id, role) VALUES (?1, ?2, 'viewer')`, event!.id, person!.id)).rejects.toThrow(/UNIQUE/i);

    await expect(exec(`INSERT INTO reg_outbox (event_id, registration_id, kind, subject, body) VALUES (?1, ?2, 'promo', 's', 'b')`, event!.id, reg!.id)).rejects.toThrow();
    await expect(exec(`INSERT INTO reg_outbox (event_id, registration_id, kind, subject, body, status) VALUES (?1, ?2, 'bulk', 's', 'b', 'sending')`, event!.id, reg!.id)).rejects.toThrow();
    const row = await env.DB.prepare(`INSERT INTO reg_outbox (event_id, registration_id, kind, subject, body) VALUES (?1, ?2, 'bulk', 's', 'b') RETURNING status, attempts, claimed_at`).bind(event!.id, reg!.id).first<Record<string, unknown>>();
    expect([row!.status, row!.attempts, row!.claimed_at]).toEqual(['queued', 0, null]);

    await exec(`INSERT INTO reg_checkins (attendee_id, checked_in_by) VALUES (?1, ?2)`, attendee!.id, person!.id);
    await expect(exec(`INSERT INTO reg_checkins (attendee_id) VALUES (?1)`, attendee!.id)).rejects.toThrow(/UNIQUE|PRIMARY/i);
    await exec(`INSERT INTO reg_activity (event_id, registration_id, actor_person_id, action) VALUES (?1, ?2, ?3, 'note')`, event!.id, reg!.id, person!.id);

    // Deleting the staff person clears attribution but keeps the history; deleting the registration cascades.
    await exec('DELETE FROM reg_event_access WHERE person_id = ?1', person!.id);
    await exec('DELETE FROM people WHERE id = ?1', person!.id);
    expect((await env.DB.prepare('SELECT checked_in_by FROM reg_checkins WHERE attendee_id = ?1').bind(attendee!.id).first<{ checked_in_by: number | null }>())!.checked_in_by).toBeNull();
    expect((await env.DB.prepare('SELECT actor_person_id FROM reg_activity WHERE registration_id = ?1').bind(reg!.id).first<{ actor_person_id: number | null }>())!.actor_person_id).toBeNull();
    await exec('DELETE FROM registrations WHERE id = ?1', reg!.id);
    const left = await env.DB.prepare(`SELECT (SELECT count(*) FROM reg_activity WHERE event_id = ?1) AS a, (SELECT count(*) FROM reg_outbox WHERE event_id = ?1) AS o, (SELECT count(*) FROM reg_checkins WHERE attendee_id = ?2) AS c`).bind(event!.id, attendee!.id).first<{ a: number; o: number; c: number }>();
    expect([left!.a, left!.o, left!.c]).toEqual([0, 0, 0]);
  });
});
