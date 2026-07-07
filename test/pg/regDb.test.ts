// regDb (Supabase-only registration module) against real Postgres. Migrates +
// seeds a fresh database the runner way, builds a PgAdapter, and exercises the
// openness windows, seat counting (pending holds a seat, cancel frees it), the
// capacity backstop (event_full + compensating cancel), the answer validator for
// every question type, the Checkout-session confirm/cancel idempotency, the
// replace-all question editor (surviving answers preserved), malformed-options
// tolerance, and RFC4180 CSV quoting. Money is integer cents. Self-skips without
// DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import {
  listOpenEvents,
  getOpenEvent,
  listQuestions,
  validateAnswers,
  createRegistration,
  attachCheckoutSession,
  confirmBySession,
  cancelBySession,
  cancelRegistration,
  listAllEvents,
  saveEvent,
  saveQuestions,
  listRegistrations,
  registrationsCsv,
  type RegQuestion,
} from '../../src/lib/regDb';

const DAY = 24 * 60 * 60 * 1000;
/** A UTC 'YYYY-MM-DD HH:MM:SS' timestamp `offsetMs` from now (matches datetime('now')). */
const ts = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

describe.skipIf(!hasPg)('regDb (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;

  const run = (script: string) =>
    execFileSync('node', [`scripts/db/${script}`], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });

  beforeAll(async () => {
    await resetSchema(sql);
    run('migrate-supabase.mjs');
    run('seed-supabase.mjs');
    db = new PgAdapter(sql);
  });
  afterAll(async () => {
    await sql?.end();
  });

  const openEvent = (over: Partial<Parameters<typeof saveEvent>[1]> = {}) =>
    saveEvent(db, { title_en: 'Retreat', title_zh: '退修会', starts_at: ts(DAY), active: 1, ...over });

  // ── Openness windows ─────────────────────────────────────────────────────────
  it('listOpenEvents / getOpenEvent honor the active + opens_at + closes_at window', async () => {
    const open = await openEvent({ title_en: 'Open', title_zh: '开放' });
    const opensLater = await openEvent({ opens_at: ts(DAY), starts_at: ts(2 * DAY) }); // future opens_at → hidden
    const alreadyClosed = await openEvent({ closes_at: ts(-3600_000), starts_at: ts(2 * DAY) }); // past closes_at → hidden
    const started = await openEvent({ starts_at: ts(-3600_000) }); // NULL closes_at + started → hidden
    const inactive = await openEvent({ active: 0 }); // inactive → hidden

    const ids = (await listOpenEvents(db, 'en')).map((e) => e.id);
    expect(ids).toContain(open);
    expect(ids).not.toContain(opensLater);
    expect(ids).not.toContain(alreadyClosed);
    expect(ids).not.toContain(started);
    expect(ids).not.toContain(inactive);

    // getOpenEvent returns the open one (localized) and null for a closed one.
    expect((await getOpenEvent(db, 'en', open))!.title).toBe('Open');
    expect((await getOpenEvent(db, 'zh', open))!.title).toBe('开放');
    expect(await getOpenEvent(db, 'en', alreadyClosed)).toBeNull();
    expect(await getOpenEvent(db, 'en', 999999)).toBeNull();

    // listAllEvents shows inactive + closed too (admin view, with counts).
    const allIds = (await listAllEvents(db, 'en')).map((e) => e.id);
    expect(allIds).toEqual(expect.arrayContaining([open, inactive, started, alreadyClosed]));
  });

  // ── Capacity counting + backstop ─────────────────────────────────────────────
  it('capacity: pending holds a seat, overflow → event_full (row compensated), cancel frees a seat', async () => {
    const ev = await openEvent({ title_en: 'Capped', title_zh: '限额', capacity: 2 });
    const mk = (name: string, status: 'pending' | 'confirmed') =>
      createRegistration(db, { eventId: ev, personId: null, name, email: `${name}@x.com`, status, amountCents: 0, currency: 'usd', answers: [] });

    const r1 = await mk('A', 'pending');
    let e = (await getOpenEvent(db, 'en', ev))!;
    expect(e.taken_count).toBe(1); // pending holds a seat
    expect(e.confirmed_count).toBe(0);

    await mk('B', 'confirmed');
    e = (await getOpenEvent(db, 'en', ev))!;
    expect(e.taken_count).toBe(2);
    expect(e.confirmed_count).toBe(1);

    // Third exceeds capacity → throw + compensating cancel (seat count stays 2).
    await expect(mk('C', 'pending')).rejects.toThrow('event_full');
    expect((await getOpenEvent(db, 'en', ev))!.taken_count).toBe(2);

    // Cancelling frees a seat; a new registration then fits.
    expect(await cancelRegistration(db, r1)).toBe(true);
    expect((await getOpenEvent(db, 'en', ev))!.taken_count).toBe(1);
    const r4 = await mk('D', 'pending');
    expect(typeof r4).toBe('number');
    expect((await getOpenEvent(db, 'en', ev))!.taken_count).toBe(2);
  });

  // ── validateAnswers (pure) ───────────────────────────────────────────────────
  it('validateAnswers normalizes every question type and enforces required/options', () => {
    const q = (over: Partial<RegQuestion> & Pick<RegQuestion, 'id' | 'type'>): RegQuestion => ({
      sort: 0,
      required: 0,
      options: null,
      label: '',
      ...over,
    });
    const text = q({ id: 1, type: 'text', required: 1 });
    const select = q({ id: 2, type: 'select', required: 1, options: ['S', 'M', 'L'] });
    const checkbox = q({ id: 3, type: 'checkbox', options: ['a', 'b', 'c'] });
    const yesno = q({ id: 4, type: 'yesno', required: 1 });
    const optional = q({ id: 5, type: 'text' });

    expect(() => validateAnswers([text], {})).toThrow('missing_required');
    expect(validateAnswers([text], { '1': '  Bob  ' })).toEqual([[1, 'Bob']]); // trimmed

    expect(() => validateAnswers([select], { '2': 'XL' })).toThrow('bad_answer');
    expect(validateAnswers([select], { '2': 'M' })).toEqual([[2, 'M']]);

    // checkbox: multi-value JSON round-trip, each ∈ options.
    expect(validateAnswers([checkbox], { '3': ['a', 'c'] })).toEqual([[3, JSON.stringify(['a', 'c'])]]);
    expect(() => validateAnswers([checkbox], { '3': ['a', 'z'] })).toThrow('bad_answer');
    expect(() => validateAnswers([{ ...checkbox, required: 1 }], {})).toThrow('missing_required');

    // yesno normalized to 'yes'/'no'; anything else is a bad answer.
    expect(validateAnswers([yesno], { '4': 'YES' })).toEqual([[4, 'yes']]);
    expect(validateAnswers([yesno], { '4': 'no' })).toEqual([[4, 'no']]);
    expect(() => validateAnswers([yesno], { '4': 'maybe' })).toThrow('bad_answer');

    // a blank OPTIONAL answer is dropped (no pair emitted).
    expect(validateAnswers([optional], { '5': '   ' })).toEqual([]);
  });

  // ── Session lifecycle idempotency ────────────────────────────────────────────
  it('confirmBySession / cancelBySession are idempotent pending→X transitions', async () => {
    const ev = await openEvent();
    const mk = (name: string) =>
      createRegistration(db, { eventId: ev, personId: null, name, email: `${name}@x.com`, status: 'pending', amountCents: 0, currency: 'usd', answers: [] });

    const r1 = await mk('conf');
    await attachCheckoutSession(db, r1, 'cs_conf');
    expect(await confirmBySession(db, 'cs_conf', 'pi_1')).toBe(true);
    expect(await confirmBySession(db, 'cs_conf', 'pi_1')).toBe(false); // already confirmed
    const [row] = await sql.unsafe('SELECT status, stripe_payment_intent_id FROM registrations WHERE id = $1', [r1]);
    expect(row.status).toBe('confirmed');
    expect(row.stripe_payment_intent_id).toBe('pi_1');

    const r2 = await mk('canc');
    await attachCheckoutSession(db, r2, 'cs_canc');
    expect(await cancelBySession(db, 'cs_canc')).toBe(true);
    expect(await cancelBySession(db, 'cs_canc')).toBe(false); // already cancelled
    expect(await confirmBySession(db, 'cs_canc', 'pi_x')).toBe(false); // cancelled can't confirm
  });

  // ── saveQuestions replace-all preserves surviving answers ────────────────────
  it('saveQuestions replaces the set, keeps surviving question ids + their answers', async () => {
    const ev = await openEvent();
    await saveQuestions(db, ev, [
      { sort: 0, type: 'text', required: 1, label_en: 'First name', label_zh: '名' },
      { sort: 1, type: 'select', required: 0, options: ['S', 'M', 'L'], label_en: 'Size', label_zh: '尺码' },
    ]);
    const qs = await listQuestions(db, 'en', ev);
    expect(qs.map((x) => x.label)).toEqual(['First name', 'Size']);
    expect(qs[1].options).toEqual(['S', 'M', 'L']);
    expect((await listQuestions(db, 'zh', ev)).map((x) => x.label)).toEqual(['名', '尺码']);

    const answers = validateAnswers(qs, { [String(qs[0].id)]: 'Bob', [String(qs[1].id)]: 'M' });
    const reg = await createRegistration(db, {
      eventId: ev, personId: null, name: 'Bob', email: 'bob@x.com', status: 'confirmed', amountCents: 0, currency: 'usd', answers,
    });

    // Keep q0 (survivor), drop q1, add a new yesno.
    await saveQuestions(db, ev, [
      { id: qs[0].id, sort: 0, type: 'text', required: 1, label_en: 'First name', label_zh: '名' },
      { sort: 1, type: 'yesno', required: 1, label_en: 'Vegetarian?', label_zh: '素食？' },
    ]);
    const qs2 = await listQuestions(db, 'en', ev);
    expect(qs2.map((x) => x.label)).toEqual(['First name', 'Vegetarian?']);
    expect(qs2[0].id).toBe(qs[0].id); // survivor kept its id

    const ansRows = await sql.unsafe('SELECT question_id, value FROM reg_answers WHERE registration_id = $1', [reg]);
    const kept = ansRows.map((r) => Number(r.question_id));
    expect(kept).toContain(qs[0].id); // survivor's answer preserved
    expect(kept).not.toContain(qs[1].id); // removed question's answer cascaded away
    expect(ansRows.find((r) => Number(r.question_id) === qs[0].id)!.value).toBe('Bob');
  });

  it('listQuestions tolerates malformed options JSON (returns null, never throws)', async () => {
    const ev = await openEvent();
    const [{ id: qid }] = await sql.unsafe(
      "INSERT INTO reg_questions (event_id, sort, type, required, options) VALUES ($1, 0, 'select', 0, $2) RETURNING id",
      [ev, 'not-json'],
    );
    await sql.unsafe("INSERT INTO reg_question_i18n (question_id, locale, label) VALUES ($1, 'en', 'Broken')", [qid]);
    const found = (await listQuestions(db, 'en', ev)).find((x) => x.id === Number(qid))!;
    expect(found.options).toBeNull();
  });

  // ── Roster + CSV ─────────────────────────────────────────────────────────────
  it('registrationsCsv is RFC4180-quoted, newest first, dollars amount', async () => {
    const ev = await openEvent();
    await saveQuestions(db, ev, [{ sort: 0, type: 'text', required: 0, label_en: 'Comment', label_zh: '评论' }]);
    const qs = await listQuestions(db, 'en', ev);
    const tricky = 'Smith, "Bob"'; // comma + embedded quotes
    const ans = validateAnswers(qs, { [String(qs[0].id)]: tricky });
    await createRegistration(db, {
      eventId: ev, personId: null, name: 'First Reg', email: 'f@x.com', status: 'confirmed', amountCents: 1500, currency: 'usd', answers: ans,
    });
    await createRegistration(db, {
      eventId: ev, personId: null, name: 'Second Reg', email: 's@x.com', status: 'pending', amountCents: 0, currency: 'usd', answers: [],
    });

    const csv = await registrationsCsv(db, 'en', ev);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Name,Email,Status,Amount,Registered,Comment');
    expect(lines[1].startsWith('Second Reg,')).toBe(true); // newest first (id tiebreak)
    expect(lines[2].startsWith('First Reg,')).toBe(true);
    expect(lines[2]).toContain('15.00'); // integer cents → dollars
    expect(csv).toContain('"Smith, ""Bob"""'); // quoted, embedded quotes doubled

    // listRegistrations groups localized answers under each row.
    const roster = await listRegistrations(db, 'en', ev);
    expect(roster[0].name).toBe('Second Reg');
    const first = roster.find((r) => r.name === 'First Reg')!;
    expect(first.answers).toEqual([{ label: 'Comment', value: tricky }]);
  });
});
