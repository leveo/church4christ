// Registration module schema (Supabase-only) — reg_events, reg_event_i18n,
// reg_questions, reg_question_i18n, registrations, reg_answers. Applied via the
// real migration runner against a freshly reset schema (the way an operator
// ships it), so this suite exercises migrations-supabase/0003_registration.sql
// end to end. Self-skips without DATABASE_URL, like every test/pg suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';

describe.skipIf(!hasPg)('Postgres registration schema', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const migrate = () =>
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    migrate();
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('round-trips an event + i18n + questions + a registration + answers', async () => {
    const [event] = await sql.unsafe(
      "INSERT INTO reg_events (starts_at, capacity, price_cents) " +
        "VALUES ('2026-08-01 09:00:00', 50, 2500) RETURNING id, currency, active, created_at",
    );
    const eventId = Number(event.id);
    expect(eventId).toBeGreaterThan(0);
    expect(event.currency).toBe('usd');
    expect(event.active).toBe(1);
    expect(event.created_at).toBeTruthy();

    await sql.unsafe(
      "INSERT INTO reg_event_i18n (event_id, locale, title, description) " +
        "VALUES ($1, 'en', 'Summer Retreat', 'A weekend away'), ($1, 'zh', '夏令营', '周末退修')",
      [eventId],
    );
    const titles = await sql.unsafe(
      'SELECT locale, title FROM reg_event_i18n WHERE event_id = $1 ORDER BY locale',
      [eventId],
    );
    expect(titles.map((r) => r.locale)).toEqual(['en', 'zh']);
    expect(titles.map((r) => r.title)).toEqual(['Summer Retreat', '夏令营']);

    const [q] = await sql.unsafe(
      "INSERT INTO reg_questions (event_id, sort, type, required, options) " +
        "VALUES ($1, 0, 'select', 1, '[\"S\",\"M\",\"L\"]') RETURNING id, sort, required",
      [eventId],
    );
    const questionId = Number(q.id);
    expect(questionId).toBeGreaterThan(0);
    expect(q.sort).toBe(0);
    expect(q.required).toBe(1);
    await sql.unsafe(
      "INSERT INTO reg_question_i18n (question_id, locale, label) " +
        "VALUES ($1, 'en', 'T-shirt size'), ($1, 'zh', 'T恤尺码')",
      [questionId],
    );

    const [reg] = await sql.unsafe(
      "INSERT INTO registrations (event_id, name, email) " +
        "VALUES ($1, 'Jane Doe', 'jane@example.com') RETURNING id, status, amount_cents, currency, created_at",
      [eventId],
    );
    const regId = Number(reg.id);
    expect(regId).toBeGreaterThan(0);
    expect(reg.status).toBe('pending');
    expect(reg.amount_cents).toBe(0);
    expect(reg.currency).toBe('usd');
    expect(reg.created_at).toBeTruthy();

    await sql.unsafe(
      "INSERT INTO reg_answers (registration_id, question_id, value) VALUES ($1, $2, 'M')",
      [regId, questionId],
    );
    const answers = await sql.unsafe(
      'SELECT value FROM reg_answers WHERE registration_id = $1 AND question_id = $2',
      [regId, questionId],
    );
    expect(answers.map((r) => r.value)).toEqual(['M']);
  });

  it('rejects a duplicate stripe_checkout_session_id with unique_violation (23505)', async () => {
    const [event] = await sql.unsafe(
      "INSERT INTO reg_events (starts_at) VALUES ('2026-09-01 09:00:00') RETURNING id",
    );
    const eventId = Number(event.id);
    await sql.unsafe(
      "INSERT INTO registrations (event_id, name, email, stripe_checkout_session_id) " +
        "VALUES ($1, 'A', 'a@example.com', 'cs_dup')",
      [eventId],
    );
    await expect(
      sql.unsafe(
        "INSERT INTO registrations (event_id, name, email, stripe_checkout_session_id) " +
          "VALUES ($1, 'B', 'b@example.com', 'cs_dup')",
        [eventId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('CASCADE-deletes answers when their registration is deleted', async () => {
    const [event] = await sql.unsafe(
      "INSERT INTO reg_events (starts_at) VALUES ('2026-10-01 09:00:00') RETURNING id",
    );
    const eventId = Number(event.id);
    const [q] = await sql.unsafe(
      "INSERT INTO reg_questions (event_id, type) VALUES ($1, 'text') RETURNING id",
      [eventId],
    );
    const questionId = Number(q.id);
    const [reg] = await sql.unsafe(
      "INSERT INTO registrations (event_id, name, email) VALUES ($1, 'C', 'c@example.com') RETURNING id",
      [eventId],
    );
    const regId = Number(reg.id);
    await sql.unsafe(
      "INSERT INTO reg_answers (registration_id, question_id, value) VALUES ($1, $2, 'hello')",
      [regId, questionId],
    );

    await sql.unsafe('DELETE FROM registrations WHERE id = $1', [regId]);
    const left = await sql.unsafe('SELECT count(*)::int AS n FROM reg_answers WHERE registration_id = $1', [regId]);
    expect(left[0].n).toBe(0);
    // The question survives — only the answers cascade with the registration.
    const questions = await sql.unsafe('SELECT count(*)::int AS n FROM reg_questions WHERE id = $1', [questionId]);
    expect(questions[0].n).toBe(1);
  });
});
