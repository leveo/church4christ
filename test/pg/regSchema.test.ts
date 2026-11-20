// Registration module schema — reg_events, reg_event_i18n, reg_questions,
// reg_question_i18n, registrations, reg_answers, reg_attendees. Applied via the
// real migration runner against a freshly reset schema (the way an operator
// ships it), so this suite exercises migrations-supabase/0003_registration.sql
// and 0042_registration_v2.sql end to end, including the 0042 backfill of
// registrations that existed before it. Self-skips without DATABASE_URL, like every test/pg suite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { listQuestions } from '../../src/lib/regDb';
import { registrationSummary } from '../../src/lib/regManage';

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
      "INSERT INTO registrations (event_id, name, email, submission_key) " +
        "VALUES ($1, 'Jane Doe', 'jane@example.com', 'k-jane') RETURNING id, status, amount_cents, currency, created_at, party_size, confirmation_no",
      [eventId],
    );
    const regId = Number(reg.id);
    expect(regId).toBeGreaterThan(0);
    expect(reg.status).toBe('pending');
    expect(reg.amount_cents).toBe(0);
    expect(reg.currency).toBe('usd');
    expect(reg.created_at).toBeTruthy();
    expect(reg.party_size).toBe(1);
    expect(reg.confirmation_no).toBeNull();

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
      "INSERT INTO registrations (event_id, name, email, stripe_checkout_session_id, submission_key) " +
        "VALUES ($1, 'A', 'a@example.com', 'cs_dup', 'k-a')",
      [eventId],
    );
    await expect(
      sql.unsafe(
        "INSERT INTO registrations (event_id, name, email, stripe_checkout_session_id, submission_key) " +
          "VALUES ($1, 'B', 'b@example.com', 'cs_dup', 'k-b')",
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
      "INSERT INTO registrations (event_id, name, email, submission_key) VALUES ($1, 'C', 'c@example.com', 'k-c') RETURNING id",
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

  it('adds the v2 event defaults and rejects a bad confirmation prefix', async () => {
    const [event] = await sql.unsafe(
      "INSERT INTO reg_events (starts_at) VALUES ('2026-11-01 09:00:00') RETURNING visible_from, waitlist_enabled, confirmation_prefix, next_confirmation, poster",
    );
    expect(event).toMatchObject({ visible_from: null, waitlist_enabled: 1, confirmation_prefix: null, next_confirmation: 1, poster: null });
    for (const prefix of ['abc', 'TOOLONG1', '']) {
      await expect(
        sql.unsafe("INSERT INTO reg_events (starts_at, confirmation_prefix) VALUES ('2026-11-01 09:00:00', $1)", [prefix]),
      ).rejects.toMatchObject({ code: '23514' });
    }
    await expect(
      sql.unsafe("INSERT INTO reg_events (starts_at, waitlist_enabled) VALUES ('2026-11-01 09:00:00', 2)"),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts the six statuses and the widened question types, and rejects unknown ones', async () => {
    const [event] = await sql.unsafe("INSERT INTO reg_events (starts_at) VALUES ('2026-12-01 09:00:00') RETURNING id");
    const eventId = Number(event.id);
    let n = 0;
    for (const status of ['pending', 'review', 'confirmed', 'waitlist', 'declined', 'cancelled']) {
      n += 1;
      await sql.unsafe(
        'INSERT INTO registrations (event_id, name, email, status, submission_key) VALUES ($1, $2, $3, $4, $5)',
        [eventId, `S${n}`, `s${n}@example.com`, status, `status-${n}`],
      );
    }
    await expect(
      sql.unsafe("INSERT INTO registrations (event_id, name, email, status, submission_key) VALUES ($1, 'X', 'x@example.com', 'paid', 'status-x')", [eventId]),
    ).rejects.toMatchObject({ code: '23514' });
    for (const type of ['text', 'textarea', 'select', 'checkbox', 'yesno', 'section', 'number', 'date', 'email', 'phone', 'terms']) {
      await sql.unsafe('INSERT INTO reg_questions (event_id, type) VALUES ($1, $2)', [eventId, type]);
    }
    await expect(sql.unsafe("INSERT INTO reg_questions (event_id, type) VALUES ($1, 'file')", [eventId])).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces party_size 1-50 and unique submission keys and confirmation numbers per event', async () => {
    const [event] = await sql.unsafe("INSERT INTO reg_events (starts_at) VALUES ('2027-01-01 09:00:00') RETURNING id");
    const eventId = Number(event.id);
    const [otherEvent] = await sql.unsafe("INSERT INTO reg_events (starts_at) VALUES ('2027-02-01 09:00:00') RETURNING id");
    const other = Number(otherEvent.id);
    const insert = (id: number, key: string, no: string | null, size = 1) =>
      sql.unsafe(
        'INSERT INTO registrations (event_id, name, email, submission_key, confirmation_no, party_size) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, 'P', 'p@example.com', key, no, size],
      );
    await insert(eventId, 'u1', 'R27-0001');
    await expect(insert(eventId, 'u1', 'R27-0002')).rejects.toMatchObject({ code: '23505' });
    await expect(insert(eventId, 'u2', 'R27-0001')).rejects.toMatchObject({ code: '23505' });
    await insert(eventId, 'u3', null);
    await insert(eventId, 'u4', null);
    await insert(other, 'u1', 'R27-0001');
    await expect(insert(eventId, 'u5', null, 0)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(eventId, 'u6', null, 51)).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps attendees per registration, cascades on delete, and nulls a deleted person', async () => {
    const [event] = await sql.unsafe("INSERT INTO reg_events (starts_at) VALUES ('2027-03-01 09:00:00') RETURNING id");
    const [person] = await sql.unsafe("INSERT INTO people (display_name, email) VALUES ('Att Person', 'att-person@example.com') RETURNING id");
    const [reg] = await sql.unsafe(
      "INSERT INTO registrations (event_id, name, email, submission_key) VALUES ($1, 'Att', 'att@example.com', 'att-1') RETURNING id",
      [event.id],
    );
    const [attendee] = await sql.unsafe(
      "INSERT INTO reg_attendees (registration_id, name, person_id) VALUES ($1, 'Att', $2) RETURNING id, campus_id, sort, status",
      [reg.id, person.id],
    );
    expect(attendee).toMatchObject({ campus_id: 1, sort: 0, status: 'active' });
    await expect(
      sql.unsafe("INSERT INTO reg_attendees (registration_id, name, status) VALUES ($1, 'Bad', 'gone')", [reg.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await sql.unsafe('DELETE FROM people WHERE id = $1', [person.id]);
    const [kept] = await sql.unsafe('SELECT person_id FROM reg_attendees WHERE id = $1', [attendee.id]);
    expect(kept.person_id).toBeNull();
    await sql.unsafe('DELETE FROM registrations WHERE id = $1', [reg.id]);
    const left = await sql.unsafe('SELECT count(*)::int AS n FROM reg_attendees WHERE registration_id = $1', [reg.id]);
    expect(left[0].n).toBe(0);
  });

  it('adds the party columns with their constraints (0043)', async () => {
    const [event] = await sql.unsafe("INSERT INTO reg_events (starts_at) VALUES ('2027-01-01 09:00:00') RETURNING id, max_party_size, allow_self_edit");
    expect([event.max_party_size, event.allow_self_edit]).toEqual([1, 1]);
    const eventId = Number(event.id);
    await expect(sql.unsafe('UPDATE reg_events SET max_party_size = 0 WHERE id = $1', [eventId])).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe('UPDATE reg_events SET max_party_size = 21 WHERE id = $1', [eventId])).rejects.toMatchObject({ code: '23514' });
    await sql.unsafe('UPDATE reg_events SET max_party_size = 20 WHERE id = $1', [eventId]);
    await expect(sql.unsafe('UPDATE reg_events SET allow_self_edit = 2 WHERE id = $1', [eventId])).rejects.toMatchObject({ code: '23514' });

    await sql.unsafe("INSERT INTO reg_event_i18n (event_id, locale, title, notes) VALUES ($1, 'en', 'T', 'Bring a Bible')", [eventId]);
    const [reg] = await sql.unsafe(
      "INSERT INTO registrations (event_id, name, email, submission_key, locale, phone, manage_token_hash) " +
        "VALUES ($1, 'P', 'p@example.com', 'k-party', 'zh', '555', $2) RETURNING locale, phone, confirmation_sent_at, cancelled_at",
      [eventId, 'a'.repeat(64)],
    );
    expect(reg).toMatchObject({ locale: 'zh', phone: '555', confirmation_sent_at: null, cancelled_at: null });
    await expect(sql.unsafe("UPDATE registrations SET locale = 'xx' WHERE submission_key = 'k-party'")).rejects.toMatchObject({ code: '23503' });
    await expect(
      sql.unsafe(
        "INSERT INTO registrations (event_id, name, email, submission_key, manage_token_hash) VALUES ($1, 'Q', 'q@example.com', 'k-party-2', $2)",
        [eventId, 'a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // many registrations may have no token
    await sql.unsafe("INSERT INTO registrations (event_id, name, email, submission_key) VALUES ($1, 'R', 'r@example.com', 'k-n1'), ($1, 'S', 's@example.com', 'k-n2')", [eventId]);
  });
});

// 0042 on a database that already holds registrations: migrate through 0041 in a
// scratch copy of the migration folder, insert rows the way v1 stored them, then
// apply 0042 and check the backfill.
describe.skipIf(!hasPg)('Postgres registration v2 backfill (0042)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const repo = resolve(process.cwd());
  const scratch = hasPg ? mkdtempSync(join(tmpdir(), 'c4c-reg-migrate-')) : '';
  const run = () =>
    execFileSync('node', [join(repo, 'scripts/db/migrate-supabase.mjs')], {
      cwd: scratch,
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    mkdirSync(join(scratch, 'migrations-supabase'));
    for (const file of readdirSync(join(repo, 'migrations-supabase'))) {
      if (file.endsWith('.sql') && file < '0042') cpSync(join(repo, 'migrations-supabase', file), join(scratch, 'migrations-supabase', file));
    }
    run();
    await sql.unsafe(`
      INSERT INTO people (id, display_name, email) VALUES (9001, 'Linked Member', 'linked-member@example.com');
      INSERT INTO reg_events (id, starts_at, capacity) VALUES
        (801, '2026-08-01 09:00:00', 10), (802, '2031-05-01 09:00:00', NULL), (803, '2026-09-01 09:00:00', NULL);
      INSERT INTO registrations (id, event_id, person_id, name, email, status) VALUES
        (701, 801, 9001, 'First', 'first@example.com', 'confirmed'),
        (702, 801, NULL, 'Second', 'second@example.com', 'cancelled'),
        (703, 802, NULL, 'Third', 'third@example.com', 'pending'),
        (704, 801, NULL, 'Fourth', 'fourth@example.com', 'pending');
    `);
    cpSync(join(repo, 'migrations-supabase/0042_registration_v2.sql'), join(scratch, 'migrations-supabase/0042_registration_v2.sql'));
    run();
  });
  afterAll(async () => {
    await sql?.end();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('gives existing registrations a legacy submission key and party size 1', async () => {
    const rows = await sql.unsafe('SELECT id, submission_key, party_size FROM registrations ORDER BY id');
    expect(rows.map((r) => [Number(r.id), r.submission_key, r.party_size])).toEqual([
      [701, 'legacy-701', 1], [702, 'legacy-702', 1], [703, 'legacy-703', 1], [704, 'legacy-704', 1],
    ]);
    const [column] = await sql.unsafe(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'registrations' AND column_name = 'submission_key'",
    );
    expect(column.is_nullable).toBe('NO');
  });

  it('numbers confirmations per event in id order with the start-year prefix and advances next_confirmation', async () => {
    const rows = await sql.unsafe('SELECT id, confirmation_no FROM registrations ORDER BY id');
    expect(rows.map((r) => [Number(r.id), r.confirmation_no])).toEqual([
      [701, 'R26-0001'], [702, 'R26-0002'], [703, 'R31-0001'], [704, 'R26-0003'],
    ]);
    const events = await sql.unsafe('SELECT id, next_confirmation FROM reg_events ORDER BY id');
    expect(events.map((r) => [Number(r.id), r.next_confirmation])).toEqual([[801, 4], [802, 2], [803, 1]]);
  });

  it('creates one attendee per registration, cancelled only when the registration was', async () => {
    const rows = await sql.unsafe(
      'SELECT registration_id, name, person_id, status, sort, campus_id FROM reg_attendees ORDER BY registration_id',
    );
    expect(rows.map((r) => [Number(r.registration_id), r.name, r.person_id === null ? null : Number(r.person_id), r.status, r.sort, r.campus_id])).toEqual([
      [701, 'First', 9001, 'active', 0, 1],
      [702, 'Second', null, 'cancelled', 0, 1],
      [703, 'Third', null, 'active', 0, 1],
      [704, 'Fourth', null, 'active', 0, 1],
    ]);
  });
});

// 0043 on a database that already holds registrations and a guest continuation: nothing is
// backfilled, every existing event is single-person with self-service on, and the party
// column joins the continuation's immutable set.
describe.skipIf(!hasPg)('Postgres registration party migration (0043) on existing data', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const repo = resolve(process.cwd());
  const scratch = hasPg ? mkdtempSync(join(tmpdir(), 'c4c-reg-party-')) : '';
  const run = () =>
    execFileSync('node', [join(repo, 'scripts/db/migrate-supabase.mjs')], {
      cwd: scratch,
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    mkdirSync(join(scratch, 'migrations-supabase'));
    for (const file of readdirSync(join(repo, 'migrations-supabase'))) {
      if (file.endsWith('.sql') && file < '0043') cpSync(join(repo, 'migrations-supabase', file), join(scratch, 'migrations-supabase', file));
    }
    run();
    await sql.unsafe(`
      INSERT INTO reg_events (id, starts_at, capacity) VALUES (901, '2026-08-01 09:00:00', 10);
      INSERT INTO reg_event_i18n (event_id, locale, title) VALUES (901, 'en', 'Old event');
      INSERT INTO registrations (id, event_id, name, email, status, submission_key, confirmation_no)
        VALUES (951, 901, 'Old', 'old@example.com', 'confirmed', 'legacy-951', 'R26-0001');
    `);
    cpSync(join(repo, 'migrations-supabase/0043_registration_party.sql'), join(scratch, 'migrations-supabase/0043_registration_party.sql'));
    run();
  });
  afterAll(async () => {
    await sql?.end();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('leaves existing events single-person with self-service on, and existing registrations without a token, locale or phone', async () => {
    const [event] = await sql.unsafe('SELECT max_party_size, allow_self_edit FROM reg_events WHERE id = 901');
    expect([event.max_party_size, event.allow_self_edit]).toEqual([1, 1]);
    const [reg] = await sql.unsafe('SELECT party_size, manage_token_hash, locale, phone, confirmation_sent_at, cancelled_at FROM registrations WHERE id = 951');
    expect(reg).toEqual({ party_size: 1, manage_token_hash: null, locale: null, phone: null, confirmation_sent_at: null, cancelled_at: null });
    const [i18n] = await sql.unsafe("SELECT notes FROM reg_event_i18n WHERE event_id = 901 AND locale = 'en'");
    expect(i18n.notes).toBeNull();
  });

  it('puts continuation party_json in the immutable column set and keeps the locale foreign key', async () => {
    const [trigger] = await sql.unsafe(
      "SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'identity_registration_continuation_identity_immutable'",
    );
    expect(trigger.def).toContain('party_json');
    const columns = await sql.unsafe(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'identity_registration_continuations' AND column_name = 'party_json'",
    );
    expect(columns.map((c) => [c.column_name, c.is_nullable])).toEqual([['party_json', 'YES']]);
    const [fk] = await sql.unsafe(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'registrations_locale_locale_fk'",
    );
    expect(fk.def).toBe('FOREIGN KEY (locale) REFERENCES supported_locales(code)');
  });
});

// 0044 on a database that already holds v1 questions: every existing option string becomes its
// own key and is copied into option_labels for each language that has a label row; a question
// whose options text is not a JSON array of strings is left alone instead of aborting the
// migration.
describe.skipIf(!hasPg)('Postgres registration builder migration (0044) on existing data', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const repo = resolve(process.cwd());
  const scratch = hasPg ? mkdtempSync(join(tmpdir(), 'c4c-reg-builder-')) : '';
  const run = () =>
    execFileSync('node', [join(repo, 'scripts/db/migrate-supabase.mjs')], {
      cwd: scratch,
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    mkdirSync(join(scratch, 'migrations-supabase'));
    for (const file of readdirSync(join(repo, 'migrations-supabase'))) {
      if (file.endsWith('.sql') && file < '0044') cpSync(join(repo, 'migrations-supabase', file), join(scratch, 'migrations-supabase', file));
    }
    run();
    await sql.unsafe(`
      INSERT INTO reg_events (id, starts_at, capacity) VALUES (1001, '2026-08-01 09:00:00', 10);
      INSERT INTO reg_questions (id, event_id, sort, type, required, options) VALUES
        (2001, 1001, 0, 'select', 1, '["Small","Medium","Large (XL)"]'),
        (2002, 1001, 1, 'text', 0, NULL),
        (2003, 1001, 2, 'checkbox', 0, 'not json at all'),
        (2004, 1001, 3, 'select', 0, '[1,2]'),
        (2005, 1001, 4, 'select', 0, '{"a":"b"}');
      INSERT INTO reg_question_i18n (question_id, locale, label) VALUES
        (2001, 'en', 'Shirt size'), (2001, 'zh', '衬衫尺寸'),
        (2002, 'en', 'Notes'), (2003, 'en', 'Broken'), (2004, 'en', 'Numbers'), (2005, 'en', 'Object');
      INSERT INTO registrations (id, event_id, name, email, status, submission_key, confirmation_no)
        VALUES (3001, 1001, 'Old', 'old@example.com', 'confirmed', 'legacy-3001', 'R26-0001');
      INSERT INTO reg_attendees (registration_id, name) VALUES (3001, 'Old');
      INSERT INTO reg_answers (registration_id, question_id, value) VALUES (3001, 2001, 'Large (XL)');
    `);
    cpSync(join(repo, 'migrations-supabase/0044_registration_builder.sql'), join(scratch, 'migrations-supabase/0044_registration_builder.sql'));
    run();
  });
  afterAll(async () => {
    await sql?.end();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('copies each option string into option_labels for every language row, keeping the stored answer valid', async () => {
    const rows = await sql.unsafe('SELECT locale, option_labels, help, placeholder FROM reg_question_i18n WHERE question_id = 2001 ORDER BY locale');
    expect(rows.map((r) => [r.locale, JSON.parse(r.option_labels), r.help, r.placeholder])).toEqual([
      ['en', { Small: 'Small', Medium: 'Medium', 'Large (XL)': 'Large (XL)' }, null, null],
      ['zh', { Small: 'Small', Medium: 'Medium', 'Large (XL)': 'Large (XL)' }, null, null],
    ]);
    const [question] = await sql.unsafe('SELECT options, scope, condition, max_length FROM reg_questions WHERE id = 2001');
    expect(question).toEqual({ options: '["Small","Medium","Large (XL)"]', scope: 'registration', condition: null, max_length: null });
    const [answer] = await sql.unsafe('SELECT value FROM reg_answers WHERE registration_id = 3001 AND question_id = 2001');
    expect(answer.value).toBe('Large (XL)');
  });

  it('the migrated labels read through the app in every language', async () => {
    const app = new PgAdapter(sql);
    const [en, zh] = [await listQuestions(app, 'en', 1001), await listQuestions(app, 'zh', 1001)];
    expect(en[0].option_labels).toEqual({ Small: 'Small', Medium: 'Medium', 'Large (XL)': 'Large (XL)' });
    expect(zh[0]).toMatchObject({ label: '衬衫尺寸', options: ['Small', 'Medium', 'Large (XL)'] });
    const summary = (await registrationSummary(app, 3001, 'zh'))!;
    expect(summary.answers).toEqual([{ question_id: 2001, label: '衬衫尺寸', value: 'Large (XL)' }]);
  });

  it('leaves non-option and malformed-options questions without labels instead of failing', async () => {
    const rows = await sql.unsafe('SELECT question_id, option_labels FROM reg_question_i18n WHERE question_id IN (2002, 2003, 2004, 2005) ORDER BY question_id');
    expect(rows.map((r) => [Number(r.question_id), r.option_labels])).toEqual([[2002, null], [2003, null], [2004, null], [2005, null]]);
  });

  it('defaults events to regular events and attendees to no ticket type', async () => {
    const [event] = await sql.unsafe('SELECT is_template FROM reg_events WHERE id = 1001');
    expect(event.is_template).toBe(0);
    const [attendee] = await sql.unsafe('SELECT ticket_type_id FROM reg_attendees WHERE registration_id = 3001');
    expect(attendee.ticket_type_id).toBeNull();
  });

  it('constrains scope, max_length, ticket prices and capacity, and cascades attendee answers', async () => {
    await expect(sql.unsafe("UPDATE reg_questions SET scope = 'group' WHERE id = 2001")).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe('UPDATE reg_questions SET max_length = 0 WHERE id = 2002')).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe('UPDATE reg_questions SET max_length = 5001 WHERE id = 2002')).rejects.toMatchObject({ code: '23514' });
    await sql.unsafe('UPDATE reg_questions SET max_length = 5000 WHERE id = 2002');
    await expect(sql.unsafe('INSERT INTO reg_ticket_types (event_id, price_cents) VALUES (1001, -1)')).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe('INSERT INTO reg_ticket_types (event_id, capacity) VALUES (1001, 0)')).rejects.toMatchObject({ code: '23514' });
    const [type] = await sql.unsafe('INSERT INTO reg_ticket_types (event_id, price_cents, capacity) VALUES (1001, 500, 3) RETURNING id');
    await expect(sql.unsafe("INSERT INTO reg_ticket_type_i18n (ticket_type_id, locale, label) VALUES ($1, 'xx', 'Bad')", [type.id])).rejects.toMatchObject({ code: '23503' });
    await sql.unsafe("INSERT INTO reg_ticket_type_i18n (ticket_type_id, locale, label) VALUES ($1, 'en', 'Adult')", [type.id]);
    const [attendee] = await sql.unsafe('SELECT id FROM reg_attendees WHERE registration_id = 3001');
    await sql.unsafe('UPDATE reg_attendees SET ticket_type_id = $1 WHERE id = $2', [type.id, attendee.id]);
    await sql.unsafe("INSERT INTO reg_attendee_answers (attendee_id, question_id, value) VALUES ($1, 2002, 'hi')", [attendee.id]);
    await expect(
      sql.unsafe("INSERT INTO reg_attendee_answers (attendee_id, question_id, value) VALUES ($1, 2002, 'dup')", [attendee.id]),
    ).rejects.toMatchObject({ code: '23505' });
    // Deleting a ticket type keeps the attendee (SET NULL); deleting the attendee drops its answers.
    await sql.unsafe('DELETE FROM reg_ticket_types WHERE id = $1', [type.id]);
    const [kept] = await sql.unsafe('SELECT ticket_type_id FROM reg_attendees WHERE id = $1', [attendee.id]);
    expect(kept.ticket_type_id).toBeNull();
    await sql.unsafe('DELETE FROM reg_attendees WHERE id = $1', [attendee.id]);
    const left = await sql.unsafe('SELECT count(*)::int AS n FROM reg_attendee_answers WHERE attendee_id = $1', [attendee.id]);
    expect(left[0].n).toBe(0);
  });
});

// 0045 on a database that already holds registrations: every registration with a Checkout session is
// backfilled as a card payment, everything else keeps NULL, and the new columns default sensibly.
describe.skipIf(!hasPg)('Postgres registration back office migration (0045) on existing data', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const repo = resolve(process.cwd());
  const scratch = hasPg ? mkdtempSync(join(tmpdir(), 'c4c-reg-office-')) : '';
  const run = () =>
    execFileSync('node', [join(repo, 'scripts/db/migrate-supabase.mjs')], {
      cwd: scratch,
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    mkdirSync(join(scratch, 'migrations-supabase'));
    for (const file of readdirSync(join(repo, 'migrations-supabase'))) {
      if (file.endsWith('.sql') && file < '0045') cpSync(join(repo, 'migrations-supabase', file), join(scratch, 'migrations-supabase', file));
    }
    run();
    await sql.unsafe(`
      INSERT INTO reg_events (id, starts_at) VALUES (1001, '2026-08-01 09:00:00');
      INSERT INTO registrations (id, event_id, name, email, status, submission_key, amount_cents, stripe_checkout_session_id) VALUES
        (3001, 1001, 'Paid', 'paid@example.com', 'confirmed', 'legacy-3001', 500, 'cs_test_3001'),
        (3002, 1001, 'Free', 'free@example.com', 'confirmed', 'legacy-3002', 0, NULL);
    `);
    cpSync(join(repo, 'migrations-supabase/0045_registration_back_office.sql'), join(scratch, 'migrations-supabase/0045_registration_back_office.sql'));
    run();
  });
  afterAll(async () => {
    await sql?.end();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('backfills payment_method only where a Checkout session exists and defaults the new columns', async () => {
    const rows = await sql.unsafe('SELECT id, payment_method, version, refunded_cents, admin_note, decided_at, reminder_sent_at FROM registrations ORDER BY id');
    expect(rows.map((r) => [Number(r.id), r.payment_method, r.version, r.refunded_cents, r.admin_note, r.decided_at, r.reminder_sent_at])).toEqual([
      [3001, 'stripe', 1, 0, null, null, null],
      [3002, null, 1, 0, null, null, null],
    ]);
    const [event] = await sql.unsafe('SELECT requires_approval, reminder_days FROM reg_events WHERE id = 1001');
    expect([event.requires_approval, event.reminder_days]).toEqual([0, null]);
  });

  it('constrains the new columns and tables', async () => {
    await expect(sql.unsafe("UPDATE registrations SET payment_method = 'cash' WHERE id = 3002")).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe('UPDATE registrations SET refunded_cents = -1 WHERE id = 3002')).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe('UPDATE reg_events SET reminder_days = 0 WHERE id = 1001')).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe('UPDATE reg_events SET reminder_days = 31 WHERE id = 1001')).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe('UPDATE reg_events SET requires_approval = 2 WHERE id = 1001')).rejects.toMatchObject({ code: '23514' });
    await sql.unsafe('UPDATE reg_events SET reminder_days = 30 WHERE id = 1001');
    await expect(sql.unsafe("INSERT INTO reg_event_access (event_id, person_id, role) VALUES (1001, 1, 'boss')")).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe("INSERT INTO reg_outbox (event_id, registration_id, kind, subject, body, status) VALUES (1001, 3001, 'bulk', 's', 'b', 'sending')")).rejects.toMatchObject({ code: '23514' });
    await expect(sql.unsafe("INSERT INTO reg_outbox (event_id, registration_id, kind, subject, body) VALUES (1001, 3001, 'promo', 's', 'b')")).rejects.toMatchObject({ code: '23514' });
    const [row] = await sql.unsafe("INSERT INTO reg_outbox (event_id, registration_id, kind, subject, body) VALUES (1001, 3001, 'bulk', 's', 'b') RETURNING status, attempts, claimed_at");
    expect([row.status, row.attempts, row.claimed_at]).toEqual(['queued', 0, null]);
    // Deleting the registration cascades its history and queue rows.
    await sql.unsafe("INSERT INTO reg_activity (event_id, registration_id, action) VALUES (1001, 3001, 'note')");
    await sql.unsafe('DELETE FROM registrations WHERE id = 3001');
    const left = await sql.unsafe('SELECT (SELECT count(*)::int FROM reg_activity) AS a, (SELECT count(*)::int FROM reg_outbox) AS o');
    expect([left[0].a, left[0].o]).toEqual([0, 0]);
  });
});
