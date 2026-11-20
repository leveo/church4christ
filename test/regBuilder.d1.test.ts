// Registration event-builder behavior on D1, plain and through the campus SQL scoper the request
// handlers use. The cases live in test/shared/regBuilderCases.ts and also run on Postgres.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { scopeDatabase } from '../src/lib/campusScope';
import { defineRegBuilderCases } from './shared/regBuilderCases';

defineRegBuilderCases('D1', () => env.DB, 'd1');
defineRegBuilderCases('D1, campus-scoped', () => scopeDatabase(env.DB, 1), 'd1');

describe('registration builder schema (D1, migration 0052)', () => {
  const exec = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();

  it('constrains scope, max_length, ticket types and cascades attendee answers', async () => {
    const event = await env.DB.prepare(`INSERT INTO reg_events (starts_at) VALUES ('2032-01-01 09:00:00') RETURNING id, is_template`).first<{ id: number; is_template: number }>();
    expect(event!.is_template).toBe(0);
    await expect(exec('UPDATE reg_events SET is_template = 2 WHERE id = ?1', event!.id)).rejects.toThrow();
    const question = await env.DB.prepare(`INSERT INTO reg_questions (event_id, type) VALUES (?1, 'text') RETURNING id, scope, condition, max_length`).bind(event!.id).first<{ id: number; scope: string; condition: string | null; max_length: number | null }>();
    expect([question!.scope, question!.condition, question!.max_length]).toEqual(['registration', null, null]);
    await expect(exec(`UPDATE reg_questions SET scope = 'group' WHERE id = ?1`, question!.id)).rejects.toThrow();
    await expect(exec('UPDATE reg_questions SET max_length = 0 WHERE id = ?1', question!.id)).rejects.toThrow();
    await expect(exec('UPDATE reg_questions SET max_length = 5001 WHERE id = ?1', question!.id)).rejects.toThrow();
    await exec('UPDATE reg_questions SET max_length = 5000 WHERE id = ?1', question!.id);
    await expect(exec('INSERT INTO reg_ticket_types (event_id, price_cents) VALUES (?1, -1)', event!.id)).rejects.toThrow();
    await expect(exec('INSERT INTO reg_ticket_types (event_id, capacity) VALUES (?1, 0)', event!.id)).rejects.toThrow();
    const type = await env.DB.prepare('INSERT INTO reg_ticket_types (event_id, price_cents, capacity) VALUES (?1, 0, 3) RETURNING id').bind(event!.id).first<{ id: number }>();
    await expect(exec(`INSERT INTO reg_ticket_type_i18n (ticket_type_id, locale, label) VALUES (?1, 'xx', 'Bad')`, type!.id)).rejects.toThrow(/FOREIGN KEY/i);
    await exec(`INSERT INTO reg_ticket_type_i18n (ticket_type_id, locale, label) VALUES (?1, 'en', 'Adult')`, type!.id);
    const registration = await env.DB.prepare(`INSERT INTO registrations (event_id, name, email, submission_key) VALUES (?1, 'A', 'a@example.com', 'd1-builder-a') RETURNING id`).bind(event!.id).first<{ id: number }>();
    const attendee = await env.DB.prepare(`INSERT INTO reg_attendees (registration_id, name, ticket_type_id) VALUES (?1, 'A', ?2) RETURNING id`).bind(registration!.id, type!.id).first<{ id: number }>();
    await exec(`INSERT INTO reg_attendee_answers (attendee_id, question_id, value) VALUES (?1, ?2, 'hi')`, attendee!.id, question!.id);
    await expect(exec(`INSERT INTO reg_attendee_answers (attendee_id, question_id, value) VALUES (?1, ?2, 'dup')`, attendee!.id, question!.id)).rejects.toThrow(/UNIQUE/i);
    await exec('DELETE FROM reg_ticket_types WHERE id = ?1', type!.id);
    expect((await env.DB.prepare('SELECT ticket_type_id FROM reg_attendees WHERE id = ?1').bind(attendee!.id).first<{ ticket_type_id: number | null }>())!.ticket_type_id).toBeNull();
    await exec('DELETE FROM reg_attendees WHERE id = ?1', attendee!.id);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM reg_attendee_answers WHERE attendee_id = ?1').bind(attendee!.id).first<{ n: number }>())!.n).toBe(0);
  });
});
