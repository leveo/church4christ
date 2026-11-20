// Registration core behavior on D1, plain and through the campus SQL scoper the
// request handlers use (locals.db is a CampusScopedDb in campus mode). The cases
// live in test/shared/regCoreCases.ts and also run on Postgres.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { scopeDatabase } from '../src/lib/campusScope';
import { defineRegCoreCases } from './shared/regCoreCases';

defineRegCoreCases('D1', () => env.DB);
defineRegCoreCases('D1, campus-scoped', () => scopeDatabase(env.DB, 1));

describe('registration party schema (D1, migration 0051)', () => {
  const exec = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();

  it('defaults events to single-person with self-service on and bounds max_party_size', async () => {
    const event = await env.DB.prepare(
      `INSERT INTO reg_events (starts_at) VALUES ('2032-01-01 09:00:00') RETURNING id, max_party_size, allow_self_edit`,
    ).first<{ id: number; max_party_size: number; allow_self_edit: number }>();
    expect([event!.max_party_size, event!.allow_self_edit]).toEqual([1, 1]);
    await expect(exec('UPDATE reg_events SET max_party_size = 0 WHERE id = ?1', event!.id)).rejects.toThrow();
    await expect(exec('UPDATE reg_events SET max_party_size = 21 WHERE id = ?1', event!.id)).rejects.toThrow();
    await expect(exec('UPDATE reg_events SET allow_self_edit = 2 WHERE id = ?1', event!.id)).rejects.toThrow();
    await exec('UPDATE reg_events SET max_party_size = 20 WHERE id = ?1', event!.id);
  });

  it('references supported_locales for registrations.locale and keeps manage tokens unique', async () => {
    const event = await env.DB.prepare(`INSERT INTO reg_events (starts_at) VALUES ('2032-01-01 09:00:00') RETURNING id`).first<{ id: number }>();
    const insert = (key: string, locale: string | null, hash: string | null) => exec(
      `INSERT INTO registrations (event_id, name, email, submission_key, locale, manage_token_hash) VALUES (?1, 'P', 'p@example.com', ?2, ?3, ?4)`,
      event!.id, key, locale, hash,
    );
    await insert('d1-party-a', 'zh', 'b'.repeat(64));
    await expect(insert('d1-party-b', 'xx', null)).rejects.toThrow(/FOREIGN KEY/i);
    await expect(insert('d1-party-c', null, 'b'.repeat(64))).rejects.toThrow(/UNIQUE/i);
    await insert('d1-party-d', null, null);
    await insert('d1-party-e', null, null);
  });

  it('adds party_json to the continuation immutable columns', async () => {
    const trigger = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'identity_registration_continuation_identity_immutable'`,
    ).first<{ sql: string }>();
    expect(trigger?.sql).toContain('party_json');
  });
});
