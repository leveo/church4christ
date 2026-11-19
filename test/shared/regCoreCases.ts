// Registration behavior that must hold on BOTH backends. The same cases run
// against D1 (test/regCore.d1.test.ts, Workers pool) and Postgres
// (test/pg/regCore.pg.test.ts); each file hands in its database. This module has
// no cloudflare:test or node imports, and its name does not end in .test.ts, so
// neither project collects it on its own.
import { describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import {
  cloneEvent,
  createRegistration,
  isUniqueViolation,
  registrationInsertStatements,
  getEventAdmin,
  getOpenEvent,
  getPublicEvent,
  listEventsAdmin,
  listPublicEvents,
  listQuestions,
  listQuestionsAdmin,
  listRegistrations,
  listRegistrationsForPerson,
  registrationsCsv,
  saveEvent,
  saveQuestions,
  setEventLifecycle,
  generateManageToken,
  hashManageToken,
  cancelRegistration,
  promoteWaitlist,
  type RegQuestion,
} from '../../src/lib/regDb';
import {
  cancelAttendee,
  cancelRegistrationSelf,
  findRegistrationByToken,
  findRegistrationForPerson,
  issueManageToken,
  registrationSummary,
  restrictAttendeePersons,
  updateRegistrationSelf,
  validateSubmission,
} from '../../src/lib/regManage';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** A UTC 'YYYY-MM-DD HH:MM:SS' timestamp `offsetMs` from now. */
export const ts = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

let keySeq = 0;
const key = () => `case-${Date.now()}-${++keySeq}`;

export function defineRegCoreCases(label: string, getDb: () => AppDb): void {
  const newEvent = (over: Partial<Parameters<typeof saveEvent>[1]> = {}) =>
    saveEvent(getDb(), { title_en: 'Retreat', title_zh: '退修会', starts_at: ts(30 * DAY), active: 1, ...over });
  const register = (
    eventId: number,
    over: Partial<Parameters<typeof createRegistration>[1]> = {},
  ) =>
    createRegistration(getDb(), {
      eventId,
      personId: null,
      name: 'Ada',
      email: 'ada@example.com',
      status: 'confirmed',
      amountCents: 0,
      currency: 'usd',
      answers: [],
      submissionKey: key(),
      ...over,
    });
  const count = async (sql: string, ...binds: unknown[]) =>
    (await getDb().prepare(sql).bind(...binds).first<{ n: number }>())!.n;
  const regCount = (eventId: number) => count(`SELECT count(*) AS n FROM registrations WHERE event_id = ?1`, eventId);

  describe(`registration core (${label})`, () => {
    // ── Capacity, waitlist, party size ─────────────────────────────────────────
    it('confirms until capacity, then waitlists; a waitlist row holds no seat', async () => {
      const id = await newEvent({ capacity: 2 });
      const a = await register(id);
      const b = await register(id);
      const c = await register(id);
      const d = await register(id);
      expect([a.status, b.status, c.status, d.status]).toEqual(['confirmed', 'confirmed', 'waitlist', 'waitlist']);

      const event = (await getOpenEvent(getDb(), 'en', id))!;
      expect(event.taken_count).toBe(2);
      expect(event.confirmed_count).toBe(2);
      expect(event.waitlist_count).toBe(2);
    });

    it('a cancelled seat is released for the next registrant', async () => {
      const id = await newEvent({ capacity: 1 });
      const first = await register(id);
      expect((await register(id)).status).toBe('waitlist');
      await getDb().prepare(`UPDATE registrations SET status = 'cancelled' WHERE id = ?1`).bind(first.id).run();
      expect((await register(id)).status).toBe('confirmed');
    });

    it('a full event with the waitlist off throws event_full and inserts nothing', async () => {
      const id = await newEvent({ capacity: 1, waitlist_enabled: 0 });
      await register(id);
      await expect(register(id)).rejects.toThrow('event_full');
      expect(await regCount(id)).toBe(1);
      expect(await count(
        `SELECT count(*) AS n FROM reg_attendees a JOIN registrations r ON r.id = a.registration_id WHERE r.event_id = ?1`, id,
      )).toBe(1);
    });

    it('a paid registration never waitlists, even when the event allows a waitlist', async () => {
      const id = await newEvent({ capacity: 1, price_cents: 2500 });
      await register(id, { status: 'pending', amountCents: 2500 });
      await expect(register(id, { status: 'pending', amountCents: 2500 })).rejects.toThrow('event_full');
      expect(await regCount(id)).toBe(1);
    });

    it('allowWaitlist: false turns a free full event into event_full', async () => {
      const id = await newEvent({ capacity: 1 });
      await register(id);
      await expect(register(id, { allowWaitlist: false })).rejects.toThrow('event_full');
    });

    it('counts SUM(party_size): a party that does not fit waitlists, a smaller one still fits', async () => {
      const id = await newEvent({ capacity: 5 });
      expect((await register(id, { partySize: 3 })).status).toBe('confirmed');
      expect((await register(id, { partySize: 3 })).status).toBe('waitlist');
      expect((await register(id, { partySize: 2 })).status).toBe('confirmed');
      expect((await register(id, { partySize: 1 })).status).toBe('waitlist');
      const event = (await getOpenEvent(getDb(), 'en', id))!;
      expect(event.taken_count).toBe(5);
      expect(event.waitlist_count).toBe(4);
    });

    it('pending and review rows hold seats; declined and cancelled do not', async () => {
      const id = await newEvent({ capacity: 3 });
      const pending = await register(id, { status: 'pending', amountCents: 1000 });
      const second = await register(id);
      await getDb().prepare(`UPDATE registrations SET status = 'review' WHERE id = ?1`).bind(second.id).run();
      const third = await register(id);
      expect(third.status).toBe('confirmed');
      expect((await register(id)).status).toBe('waitlist');
      await getDb().prepare(`UPDATE registrations SET status = 'declined' WHERE id = ?1`).bind(pending.id).run();
      await getDb().prepare(`UPDATE registrations SET status = 'cancelled' WHERE id = ?1`).bind(second.id).run();
      expect((await getOpenEvent(getDb(), 'en', id))!.taken_count).toBe(1);
    });

    it('an unknown event throws event_not_found', async () => {
      await expect(register(987654)).rejects.toThrow('event_not_found');
    });

    // ── Idempotency ────────────────────────────────────────────────────────────
    it('the same submission key returns the same registration with no second row or attendee', async () => {
      const id = await newEvent({ capacity: 10 });
      const submissionKey = key();
      const first = await register(id, { submissionKey });
      const again = await register(id, { submissionKey, name: 'Someone else' });
      expect(again).toEqual({ ...first, manageToken: null }); // the plaintext token is shown once
      expect(await regCount(id)).toBe(1);
      expect(await count(
        `SELECT count(*) AS n FROM reg_attendees WHERE registration_id = ?1`, first.id,
      )).toBe(1);
    });

    it('a replay of a waitlisted key still returns the waitlist row, even if a seat has since opened', async () => {
      const id = await newEvent({ capacity: 1 });
      const seat = await register(id);
      const submissionKey = key();
      const waiting = await register(id, { submissionKey });
      expect(waiting.status).toBe('waitlist');
      await getDb().prepare(`UPDATE registrations SET status = 'cancelled' WHERE id = ?1`).bind(seat.id).run();
      expect(await register(id, { submissionKey })).toEqual({ ...waiting, manageToken: null });
    });

    it('a duplicate key inside one batch is a unique violation that rolls the whole batch back (counter included)', async () => {
      const id = await newEvent({ capacity: 10 });
      const submissionKey = key();
      await register(id, { submissionKey });
      const input = {
        eventId: id, personId: null, name: 'Dup', email: 'dup@example.com', status: 'confirmed' as const,
        amountCents: 0, currency: 'usd', submissionKey, allowWaitlist: true, answers: [],
      };
      const before = await count(`SELECT next_confirmation AS n FROM reg_events WHERE id = ?1`, id);
      const error = await getDb().batch(registrationInsertStatements(getDb(), input)).then(() => null, (e: unknown) => e);
      expect(isUniqueViolation(error)).toBe(true);
      expect(await count(`SELECT next_confirmation AS n FROM reg_events WHERE id = ?1`, id)).toBe(before);
      expect(await regCount(id)).toBe(1);
    });

    it('a lost idempotency race (unique violation after the lookup) re-reads the winner', async () => {
      const id = await newEvent({ capacity: 10 });
      const submissionKey = key();
      const winner = await register(id, { submissionKey });
      // A database whose first "lookup by key" finds nothing, as if the winner committed just after it.
      const real = getDb();
      let blinded = false;
      const blind: AppDb = {
        prepare(sql: string) {
          if (!blinded && sql.includes('FROM registrations WHERE event_id = ?1 AND submission_key = ?2')) {
            blinded = true;
            return { bind: () => ({ first: async () => null }) } as never;
          }
          return real.prepare(sql);
        },
        batch: (statements) => real.batch(statements),
      };
      const loser = await createRegistration(blind, {
        eventId: id, personId: null, name: 'Late', email: 'late@example.com', status: 'confirmed',
        amountCents: 0, currency: 'usd', answers: [], submissionKey,
      });
      expect(blinded).toBe(true);
      expect(loser).toEqual({ ...winner, manageToken: null });
      expect(await regCount(id)).toBe(1);
    });

    it('the same key on different events creates independent registrations', async () => {
      const a = await newEvent();
      const b = await newEvent();
      const submissionKey = key();
      expect((await register(a, { submissionKey })).id).not.toBe((await register(b, { submissionKey })).id);
    });

    // ── Confirmation numbers ───────────────────────────────────────────────────
    it('numbers registrations sequentially per event with the default R<yy> prefix', async () => {
      const id = await newEvent({ starts_at: '2041-05-01 10:00:00', opens_at: null, closes_at: null });
      const other = await newEvent({ starts_at: '2041-05-01 10:00:00' });
      expect((await register(id)).confirmationNo).toBe('R41-0001');
      expect((await register(id)).confirmationNo).toBe('R41-0002');
      expect((await register(other)).confirmationNo).toBe('R41-0001');
      expect((await register(id)).confirmationNo).toBe('R41-0003');
    });

    it('uses a custom confirmation prefix, waitlist rows included', async () => {
      const id = await newEvent({ capacity: 1, confirmation_prefix: 'RET' });
      expect((await register(id)).confirmationNo).toBe('RET-0001');
      const waiting = await register(id);
      expect(waiting.status).toBe('waitlist');
      expect(waiting.confirmationNo).toBe('RET-0002');
    });

    it('pads to four digits and keeps counting past them', async () => {
      const id = await newEvent({ confirmation_prefix: 'PAD' });
      const setNext = (n: number) => getDb().prepare(`UPDATE reg_events SET next_confirmation = ?1 WHERE id = ?2`).bind(n, id).run();
      await setNext(9);
      expect((await register(id)).confirmationNo).toBe('PAD-0009');
      expect((await register(id)).confirmationNo).toBe('PAD-0010');
      await setNext(99);
      expect((await register(id)).confirmationNo).toBe('PAD-0099');
      expect((await register(id)).confirmationNo).toBe('PAD-0100');
      await setNext(999);
      expect((await register(id)).confirmationNo).toBe('PAD-0999');
      expect((await register(id)).confirmationNo).toBe('PAD-1000');
      await setNext(12344);
      expect((await register(id)).confirmationNo).toBe('PAD-12344');
    });

    it('a custom prefix must be 1-6 characters of A-Z / 0-9', async () => {
      for (const bad of ['', 'abc', 'TOOLONG1', 'A-B']) {
        await expect(newEvent({ confirmation_prefix: bad })).rejects.toThrow('confirmation_prefix_invalid');
      }
    });

    // ── Attendee and answers ───────────────────────────────────────────────────
    it('writes exactly one attendee carrying the registrant, plus the answers', async () => {
      const id = await newEvent();
      await saveQuestions(getDb(), id, [
        { sort: 0, type: 'text', required: 1, label_en: 'Diet', label_zh: '' },
        { sort: 1, type: 'yesno', required: 0, label_en: 'Car', label_zh: '' },
      ]);
      const [diet, car] = await listQuestions(getDb(), 'en', id);
      const reg = await register(id, { name: 'Grace Hopper', answers: [[diet.id, 'None'], [car.id, 'yes']] });
      const attendees = await getDb()
        .prepare(`SELECT name, status, sort, person_id FROM reg_attendees WHERE registration_id = ?1`)
        .bind(reg.id)
        .all<{ name: string; status: string; sort: number; person_id: number | null }>();
      expect(attendees.results).toEqual([{ name: 'Grace Hopper', status: 'active', sort: 0, person_id: null }]);
      const roster = await listRegistrations(getDb(), 'en', id);
      expect(roster[0].answers).toEqual([{ label: 'Diet', value: 'None' }, { label: 'Car', value: 'yes' }]);
    });

    it('an event that is full with the waitlist off leaves no answers behind', async () => {
      const id = await newEvent({ capacity: 1, waitlist_enabled: 0 });
      await saveQuestions(getDb(), id, [{ sort: 0, type: 'text', required: 0, label_en: 'Note', label_zh: '' }]);
      const [q] = await listQuestions(getDb(), 'en', id);
      await register(id, { answers: [[q.id, 'first']] });
      await expect(register(id, { answers: [[q.id, 'second']] })).rejects.toThrow('event_full');
      expect(await count(`SELECT count(*) AS n FROM reg_answers WHERE question_id = ?1`, q.id)).toBe(1);
    });

    // ── Questions ──────────────────────────────────────────────────────────────
    it('saveQuestions keeps existing ids (and their answers), inserts new ones, prunes removed ones', async () => {
      const id = await newEvent();
      await saveQuestions(getDb(), id, [
        { sort: 0, type: 'text', required: 0, label_en: 'One', label_zh: '一' },
        { sort: 1, type: 'text', required: 0, label_en: 'Two', label_zh: '' },
        { sort: 2, type: 'select', required: 1, options: ['a', 'b'], label_en: 'Three', label_zh: '' },
      ]);
      const [one, two, three] = await listQuestions(getDb(), 'en', id);
      await register(id, { answers: [[one.id, 'kept'], [two.id, 'pruned']] });

      await saveQuestions(getDb(), id, [
        { id: one.id, sort: 5, type: 'textarea', required: 1, label_en: 'One!', label_zh: '' },
        { sort: 6, type: 'text', required: 0, labels: { en: 'Four', zh: '四', es: 'Cuatro' } },
        { id: three.id, sort: 7, type: 'select', required: 1, options: ['a', 'b', 'c'], label_en: 'Three', label_zh: '' },
      ]);
      const after = await listQuestionsAdmin(getDb(), id);
      expect(after.map((q) => q.labels.en)).toEqual(['One!', 'Four', 'Three']);
      expect(after[0].id).toBe(one.id);
      expect(after[0].label_zh).toBeNull(); // blank zh deleted the row
      expect(after[1].labels).toEqual({ en: 'Four', zh: '四', es: 'Cuatro' });
      expect(after[2].options).toEqual(['a', 'b', 'c']);
      const roster = await listRegistrations(getDb(), 'en', id);
      expect(roster[0].answers).toEqual([{ label: 'One!', value: 'kept' }]); // 'Two' pruned with its answer
    });

    it('saveQuestions ignores an id owned by another event (treated as new; the other labels survive)', async () => {
      const mine = await newEvent();
      const theirs = await newEvent();
      await saveQuestions(getDb(), theirs, [{ sort: 0, type: 'text', required: 0, label_en: 'Theirs', label_zh: '' }]);
      const [foreign] = await listQuestions(getDb(), 'en', theirs);
      await saveQuestions(getDb(), mine, [{ id: foreign.id, sort: 0, type: 'text', required: 0, label_en: 'Hijack', label_zh: '' }]);
      expect((await listQuestions(getDb(), 'en', theirs)).map((q) => q.label)).toEqual(['Theirs']);
      const own = await listQuestions(getDb(), 'en', mine);
      expect(own.map((q) => q.label)).toEqual(['Hijack']);
      expect(own[0].id).not.toBe(foreign.id);
    });

    it('saveQuestions requires the default-language label and rejects unknown languages', async () => {
      const id = await newEvent();
      await expect(saveQuestions(getDb(), id, [{ sort: 0, type: 'text', required: 0, labels: { zh: '只有中文' } }]))
        .rejects.toThrow('label_required');
      await expect(saveQuestions(getDb(), id, [{ sort: 0, type: 'text', required: 0, labels: { en: 'x', xx: 'y' } as never }]))
        .rejects.toThrow('locale_unsupported');
      expect(await listQuestions(getDb(), 'en', id)).toEqual([]);
    });

    // ── All site languages ─────────────────────────────────────────────────────
    it('saves a title and description per language, deletes a blanked language, and falls back on read', async () => {
      const id = await saveEvent(getDb(), {
        titles: {
          en: { title: 'Camp', description: 'Fun' },
          zh: { title: '营会', description: '好玩' },
          es: { title: 'Campamento', description: 'Divertido' },
          ja: { title: 'キャンプ' },
        },
        starts_at: ts(30 * DAY),
        active: 1,
      });
      const admin = (await getEventAdmin(getDb(), id))!;
      expect(admin.titles).toEqual({ en: 'Camp', zh: '营会', es: 'Campamento', ja: 'キャンプ' });
      expect(admin.descriptions.es).toBe('Divertido');
      expect(admin.descriptions.ja).toBeNull();
      expect(admin.title_zh).toBe('营会');

      // A language with no row falls back to the default (en), a present one wins.
      expect((await getOpenEvent(getDb(), 'es', id))!.title).toBe('Campamento');
      expect((await getOpenEvent(getDb(), 'ko', id))!.title).toBe('Camp');
      expect((await getOpenEvent(getDb(), 'ko', id))!.description).toBe('Fun');

      // Blank deletes that language only; absent languages stay untouched.
      await saveEvent(getDb(), {
        id,
        titles: { en: { title: 'Camp', description: 'Fun' }, es: { title: '  ' }, zh: { title: '营会', description: '' } },
        starts_at: ts(30 * DAY),
        active: 1,
      });
      const after = (await getEventAdmin(getDb(), id))!;
      expect(after.titles).toEqual({ en: 'Camp', zh: '营会', ja: 'キャンプ' });
      expect(after.descriptions.zh).toBeNull();
      expect((await getOpenEvent(getDb(), 'es', id))!.title).toBe('Camp');
    });

    it('the default language title is required and unsupported languages are refused', async () => {
      await expect(saveEvent(getDb(), { titles: { zh: { title: '只有中文' } }, starts_at: ts(DAY), active: 1 }))
        .rejects.toThrow('title_required');
      await expect(saveEvent(getDb(), { titles: { en: { title: 'x' }, xx: { title: 'y' } } as never, starts_at: ts(DAY), active: 1 }))
        .rejects.toThrow('locale_unsupported');
      await expect(saveEvent(getDb(), { titles: { en: { title: 'x' } }, defaultLocale: 'zh', starts_at: ts(DAY), active: 1 }))
        .rejects.toThrow('title_required');
    });

    it('updating an event keeps optional columns that the caller did not mention', async () => {
      const id = await newEvent({ confirmation_prefix: 'KEEP', poster: 'media/p.png', visible_from: ts(-DAY), waitlist_enabled: 0 });
      await saveEvent(getDb(), { id, title_en: 'Retreat', title_zh: '', starts_at: ts(30 * DAY), active: 1 });
      const e = (await getEventAdmin(getDb(), id))!;
      expect([e.confirmation_prefix, e.poster, e.waitlist_enabled]).toEqual(['KEEP', 'media/p.png', 0]);
      expect(e.visible_from).not.toBeNull();
      await saveEvent(getDb(), { id, title_en: 'Retreat', starts_at: ts(30 * DAY), active: 1, visible_from: null, confirmation_prefix: null });
      const cleared = (await getEventAdmin(getDb(), id))!;
      expect([cleared.visible_from, cleared.confirmation_prefix]).toEqual([null, null]);
    });

    // ── Lifecycle ──────────────────────────────────────────────────────────────
    it('public readers classify preview, open and hidden events; closed events leave the list', async () => {
      const open = await newEvent();
      const preview = await newEvent({ opens_at: ts(2 * DAY) });
      const hiddenInactive = await newEvent({ active: 0 });
      const hiddenLater = await newEvent({ visible_from: ts(DAY) });
      const closed = await newEvent({ closes_at: ts(-HOUR) });
      const started = await newEvent({ starts_at: ts(-HOUR) });

      const list = await listPublicEvents(getDb(), 'en');
      const byId = new Map(list.map((e) => [e.id, e.phase]));
      expect(byId.get(open)).toBe('open');
      expect(byId.get(preview)).toBe('preview');
      for (const id of [hiddenInactive, hiddenLater, closed, started]) expect(byId.has(id)).toBe(false);
      // Soonest first.
      const starts = list.map((e) => e.starts_at);
      expect(starts).toEqual([...starts].sort());

      expect((await getPublicEvent(getDb(), 'en', preview))!.phase).toBe('preview');
      expect((await getPublicEvent(getDb(), 'en', closed))!.phase).toBe('closed');
      expect(await getPublicEvent(getDb(), 'en', hiddenInactive)).toBeNull();
      expect(await getPublicEvent(getDb(), 'en', hiddenLater)).toBeNull();

      // Submitting is only possible while open.
      expect(await getOpenEvent(getDb(), 'en', open)).not.toBeNull();
      for (const id of [preview, hiddenInactive, hiddenLater, closed, started]) {
        expect(await getOpenEvent(getDb(), 'en', id)).toBeNull();
      }
    });

    it('the list takes an explicit clock', async () => {
      const id = await newEvent({ opens_at: ts(2 * DAY) });
      expect((await listPublicEvents(getDb(), 'en', ts(0))).find((e) => e.id === id)!.phase).toBe('preview');
      expect((await listPublicEvents(getDb(), 'en', ts(3 * DAY))).find((e) => e.id === id)!.phase).toBe('open');
      expect((await listPublicEvents(getDb(), 'en', ts(31 * DAY))).find((e) => e.id === id)).toBeUndefined();
    });

    it('open_now opens a preview event; close_now closes it; hide / show toggle active', async () => {
      const id = await newEvent({ opens_at: ts(5 * DAY) });
      const phase = async () => (await getEventAdmin(getDb(), id))!.phase;
      expect(await phase()).toBe('preview');
      await setEventLifecycle(getDb(), id, 'open_now');
      expect(await phase()).toBe('open');
      expect(await getOpenEvent(getDb(), 'en', id)).not.toBeNull();
      await setEventLifecycle(getDb(), id, 'close_now');
      expect(await phase()).toBe('closed');
      await setEventLifecycle(getDb(), id, 'hide');
      expect(await phase()).toBe('hidden');
      expect(await getPublicEvent(getDb(), 'en', id)).toBeNull();
      await setEventLifecycle(getDb(), id, 'show');
      expect(await phase()).toBe('closed');
    });

    it('open_now on a closed event needs a new close time in the future (closes_at or the start time)', async () => {
      const closes = await newEvent({ closes_at: ts(-HOUR) });
      await expect(setEventLifecycle(getDb(), closes, 'open_now')).rejects.toThrow('close_required');
      await expect(setEventLifecycle(getDb(), closes, 'open_now', { closesAt: ts(-HOUR / 2) })).rejects.toThrow('close_required');
      expect((await getEventAdmin(getDb(), closes))!.phase).toBe('closed'); // untouched by the refusals
      await setEventLifecycle(getDb(), closes, 'open_now', { closesAt: ts(DAY) });
      expect((await getEventAdmin(getDb(), closes))!.phase).toBe('open');

      // No closes_at but already started: the effective close is the start time.
      const started = await newEvent({ starts_at: ts(-HOUR) });
      await expect(setEventLifecycle(getDb(), started, 'open_now')).rejects.toThrow('close_required');
      await setEventLifecycle(getDb(), started, 'open_now', { closesAt: ts(DAY) });
      expect((await getEventAdmin(getDb(), started))!.phase).toBe('open');
    });

    it('open_now also clears a visible_from that would keep the event hidden; close_now on a preview reads as closed', async () => {
      const id = await newEvent({ visible_from: ts(DAY), opens_at: ts(2 * DAY) });
      await setEventLifecycle(getDb(), id, 'open_now');
      expect((await getEventAdmin(getDb(), id))!.phase).toBe('open');
      const preview = await newEvent({ opens_at: ts(2 * DAY) });
      await setEventLifecycle(getDb(), preview, 'close_now');
      expect((await getEventAdmin(getDb(), preview))!.phase).toBe('closed');
    });

    it('lifecycle on an unknown event throws event_not_found', async () => {
      await expect(setEventLifecycle(getDb(), 987654, 'hide')).rejects.toThrow('event_not_found');
    });

    // ── Clone ──────────────────────────────────────────────────────────────────
    it('cloneEvent copies the event, every language and the questions, never registrations', async () => {
      const id = await saveEvent(getDb(), {
        titles: { en: { title: 'Camp', description: 'Fun' }, zh: { title: '营会' }, de: { title: 'Lager' } },
        starts_at: ts(30 * DAY), ends_at: ts(31 * DAY), location: 'Lake', capacity: 3, active: 1,
        opens_at: ts(-DAY), closes_at: ts(20 * DAY), visible_from: ts(-2 * DAY), waitlist_enabled: 0,
        confirmation_prefix: 'CMP', poster: 'media/camp.png',
      });
      await saveQuestions(getDb(), id, [
        { sort: 0, type: 'text', required: 1, label_en: 'Name tag', label_zh: '姓名牌' },
        { sort: 1, type: 'select', required: 0, options: ['S', 'M'], labels: { en: 'Shirt', de: 'Hemd' } },
      ]);
      const [q1] = await listQuestions(getDb(), 'en', id);
      await register(id, { answers: [[q1.id, 'Ada']] });
      await register(id);

      const copyId = await cloneEvent(getDb(), id);
      expect(copyId).not.toBe(id);
      const src = (await getEventAdmin(getDb(), id))!;
      const copy = (await getEventAdmin(getDb(), copyId))!;
      expect(copy.active).toBe(0);
      expect(copy.next_confirmation).toBe(1);
      expect(copy.titles).toEqual(src.titles);
      expect(copy.descriptions).toEqual(src.descriptions);
      for (const field of ['starts_at', 'ends_at', 'location', 'capacity', 'price_cents', 'opens_at', 'closes_at', 'visible_from',
        'waitlist_enabled', 'confirmation_prefix', 'poster'] as const) {
        expect(copy[field]).toEqual(src[field]);
      }
      const srcQuestions = await listQuestionsAdmin(getDb(), id);
      const copyQuestions = await listQuestionsAdmin(getDb(), copyId);
      expect(copyQuestions.map(({ id: _id, ...rest }) => rest)).toEqual(srcQuestions.map(({ id: _id, ...rest }) => rest));
      expect(copyQuestions.every((q) => !srcQuestions.some((s) => s.id === q.id))).toBe(true);
      expect(await regCount(copyId)).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM reg_answers a JOIN reg_questions q ON q.id = a.question_id WHERE q.event_id = ?1`, copyId)).toBe(0);
      expect(await regCount(id)).toBe(2); // the source is untouched
      expect((await listQuestionsAdmin(getDb(), id)).map((q) => q.id)).toEqual(srcQuestions.map((q) => q.id));
    });

    it('cloneEvent of an unknown event throws event_not_found', async () => {
      await expect(cloneEvent(getDb(), 987654)).rejects.toThrow('event_not_found');
    });

    // ── Roster, CSV, the member portal list ────────────────────────────────────
    it('the roster and CSV carry confirmation number, party size and the waitlist', async () => {
      const id = await newEvent({ capacity: 1, confirmation_prefix: 'CSV' });
      await saveQuestions(getDb(), id, [{ sort: 0, type: 'text', required: 0, label_en: 'Note', label_zh: '' }]);
      const [q] = await listQuestions(getDb(), 'en', id);
      await register(id, { name: 'First', partySize: 1, answers: [[q.id, 'hi']] });
      await register(id, { name: 'Second', partySize: 2 });

      const roster = await listRegistrations(getDb(), 'en', id);
      expect(roster.map((r) => [r.name, r.status, r.confirmation_no, r.party_size]).sort()).toEqual([
        ['First', 'confirmed', 'CSV-0001', 1],
        ['Second', 'waitlist', 'CSV-0002', 2],
      ]);
      const lines = (await registrationsCsv(getDb(), 'en', id)).split('\r\n');
      expect(lines[0]).toBe('Confirmation,Name,Email,Status,Party size,Amount,Registered,Note');
      const rows = lines.slice(1).sort();
      expect(rows[0]).toMatch(/^CSV-0001,First,ada@example\.com,confirmed,1,0\.00,[\d: -]+,hi$/);
      expect(rows[1]).toMatch(/^CSV-0002,Second,ada@example\.com,waitlist,2,0\.00,[\d: -]+,$/);
    });

    it('the member list returns waitlist rows with their confirmation number and hides cancelled ones', async () => {
      const email = `member-${Date.now()}@example.com`;
      const id = await newEvent({ capacity: 1 });
      await register(id);
      const waiting = await register(id, { email });
      const cancelled = await register(id, { email });
      await getDb().prepare(`UPDATE registrations SET status = 'cancelled' WHERE id = ?1`).bind(cancelled.id).run();
      const mine = await listRegistrationsForPerson(getDb(), 'en', 0, email);
      expect(mine.map((r) => [r.id, r.status, r.confirmation_no, r.party_size, r.event_title])).toEqual([
        [waiting.id, 'waitlist', waiting.confirmationNo, 1, 'Retreat'],
      ]);
    });

    it('listEventsAdmin exposes every event with phase and counts', async () => {
      const id = await newEvent({ capacity: 1 });
      await register(id);
      await register(id);
      const row = (await listEventsAdmin(getDb())).find((e) => e.id === id)!;
      expect([row.phase, row.confirmed_count, row.taken_count, row.waitlist_count]).toEqual(['open', 1, 1, 1]);
    });

    // ── Party flow ─────────────────────────────────────────────────────────────
    const party = (...names: string[]) => names.map((name) => ({ name }));
    const attendeeRows = async (registrationId: number) =>
      (await getDb()
        .prepare(`SELECT name, status, sort, person_id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort`)
        .bind(registrationId)
        .all<{ name: string; status: string; sort: number; person_id: number | null }>()).results;
    const field = async (registrationId: number) =>
      (await getDb()
        .prepare(`SELECT status, party_size, phone, locale, cancelled_at, manage_token_hash FROM registrations WHERE id = ?1`)
        .bind(registrationId)
        .first<{ status: string; party_size: number; phone: string | null; locale: string | null; cancelled_at: string | null; manage_token_hash: string | null }>())!;

    describe('party registration', () => {
      it('writes one attendee row per person, party_size, phone and locale, and takes that many seats', async () => {
        const id = await newEvent({ capacity: 5, max_party_size: 4 });
        const r = await register(id, { attendees: party('Ada', 'Bob', 'Cy'), phone: '555-0100', locale: 'zh' });
        expect(r.status).toBe('confirmed');
        expect(await attendeeRows(r.id)).toEqual([
          { name: 'Ada', status: 'active', sort: 0, person_id: null },
          { name: 'Bob', status: 'active', sort: 1, person_id: null },
          { name: 'Cy', status: 'active', sort: 2, person_id: null },
        ]);
        const row = await field(r.id);
        expect([row.party_size, row.phone, row.locale]).toEqual([3, '555-0100', 'zh']);
        expect((await getOpenEvent(getDb(), 'en', id))!.taken_count).toBe(3);
      });

      it('a party that does not fit goes to the waitlist whole, and a smaller one still fits', async () => {
        const id = await newEvent({ capacity: 4, max_party_size: 4 });
        expect((await register(id, { attendees: party('A', 'B', 'C') })).status).toBe('confirmed');
        const big = await register(id, { attendees: party('D', 'E') });
        expect(big.status).toBe('waitlist');
        expect((await register(id, { attendees: party('F') })).status).toBe('confirmed');
        const event = (await getOpenEvent(getDb(), 'en', id))!;
        expect([event.taken_count, event.waitlist_count]).toEqual([4, 2]);
      });

      it('the first attendee inherits the contact person id; later ones take their own', async () => {
        const id = await newEvent({ max_party_size: 3 });
        const personId = (await getDb().prepare(`SELECT id FROM people ORDER BY id LIMIT 1`).first<{ id: number }>())?.id ?? null;
        if (personId === null) return; // no people on this database
        const r = await register(id, { personId, attendees: [{ name: 'Me' }, { name: 'Other', personId: null }] });
        expect((await attendeeRows(r.id)).map((a) => a.person_id)).toEqual([personId, null]);
      });

      it('a single-person registration keeps its old shape (party of 1, contact as the only attendee)', async () => {
        const id = await newEvent();
        const r = await register(id, { name: 'Solo' });
        expect(await attendeeRows(r.id)).toEqual([{ name: 'Solo', status: 'active', sort: 0, person_id: null }]);
        expect((await field(r.id)).party_size).toBe(1);
      });
    });

    // ── Manage token ───────────────────────────────────────────────────────────
    describe('manage token', () => {
      it('is returned once, only its SHA-256 is stored, and a wrong or garbled token finds nothing', async () => {
        const id = await newEvent();
        const r = await register(id);
        expect(r.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const stored = (await field(r.id)).manage_token_hash;
        expect(stored).toBe(await hashManageToken(r.manageToken!));
        expect(stored).toMatch(/^[0-9a-f]{64}$/);
        expect(stored).not.toContain(r.manageToken!);
        expect(await findRegistrationByToken(getDb(), r.manageToken!)).toEqual({ id: r.id, event_id: id, locale: null });
        expect(await findRegistrationByToken(getDb(), (await generateManageToken()).token)).toBeNull();
        for (const bad of ['', 'short', r.manageToken! + 'x', r.manageToken!.slice(1), `${r.manageToken!.slice(0, 42)}!`, stored!, null, 5, undefined]) {
          expect(await findRegistrationByToken(getDb(), bad)).toBeNull();
        }
        const again = await register(id, { submissionKey: 'fixed-' + r.id });
        const replay = await register(id, { submissionKey: 'fixed-' + r.id });
        expect(again.manageToken).not.toBeNull();
        expect(replay.manageToken).toBeNull();
      });

      it('issueManageToken rotates: the old link stops working and the new one works', async () => {
        const id = await newEvent();
        const r = await register(id);
        const fresh = (await issueManageToken(getDb(), r.id))!;
        expect(fresh).not.toBe(r.manageToken);
        expect(await findRegistrationByToken(getDb(), r.manageToken!)).toBeNull();
        expect((await findRegistrationByToken(getDb(), fresh))?.id).toBe(r.id);
        expect(await issueManageToken(getDb(), 987654321)).toBeNull();
      });
    });

    // ── validateSubmission ─────────────────────────────────────────────────────
    describe('validateSubmission', () => {
      const questions: RegQuestion[] = [
        { id: 11, sort: 0, type: 'text', required: 1, options: null, label: 'Diet' },
        { id: 12, sort: 1, type: 'select', required: 0, options: ['S', 'M'], label: 'Size' },
      ];
      const ok = { contact: { name: ' Ada ', email: ' ADA@Example.com ', phone: ' 555 0100 ' }, answers: { '11': ' none ' } };

      it('returns trimmed, normalized values and the answer pairs', () => {
        const result = validateSubmission({ max_party_size: 3 }, questions, ok);
        expect(result).toEqual({
          ok: true,
          value: {
            contact: { name: 'Ada', email: 'ada@example.com', phone: '555 0100' },
            attendees: [{ name: 'Ada', personId: null }],
            answers: [[11, 'none']],
          },
        });
      });

      it('drops blank extra rows, keeps order, and defaults row 0 to the contact', () => {
        const result = validateSubmission({ max_party_size: 4 }, questions, {
          ...ok, attendees: [{ name: '' }, { name: '  ' }, { name: 'Bob', personId: 7 }, { name: '' }, { name: 'Cy', personId: 'x' }],
        });
        expect(result.ok && result.value.attendees).toEqual([
          { name: 'Ada', personId: null }, { name: 'Bob', personId: 7 }, { name: 'Cy', personId: null },
        ]);
      });

      it('collects every error with its field path', () => {
        const result = validateSubmission({ max_party_size: 2 }, questions, {
          contact: { name: '', email: 'nope', phone: 'call me' },
          attendees: [{ name: '' }, { name: 'x'.repeat(121) }, { name: 'Third' }],
          answers: { '12': 'XL' },
        });
        expect(result.ok).toBe(false);
        const errors = !result.ok ? result.errors : [];
        expect(errors).toEqual(expect.arrayContaining([
          { path: 'contact.name', code: 'required' },
          { path: 'contact.email', code: 'invalid' },
          { path: 'contact.phone', code: 'invalid' },
          { path: 'attendees.1.name', code: 'too_long' },
          { path: 'q.11', code: 'missing_required' },
          { path: 'q.12', code: 'bad_answer' },
        ]));
      });

      it('enforces max_party_size and the length limits', () => {
        const three = { ...ok, attendees: party('A', 'B', 'C') };
        expect(validateSubmission({ max_party_size: 2 }, questions, three)).toEqual({ ok: false, errors: [{ path: 'attendees', code: 'too_many' }] });
        expect(validateSubmission({ max_party_size: 3 }, questions, three).ok).toBe(true);
        expect(validateSubmission({ max_party_size: 1 }, questions, { ...ok, attendees: party('A', 'B') }).ok).toBe(false);
        const longPhone = validateSubmission({ max_party_size: 1 }, questions, { ...ok, contact: { ...ok.contact, phone: '1'.repeat(41) } });
        expect(!longPhone.ok && longPhone.errors).toEqual([{ path: 'contact.phone', code: 'too_long' }]);
        const longName = validateSubmission({ max_party_size: 1 }, questions, { ...ok, contact: { ...ok.contact, name: 'n'.repeat(121) } });
        expect(!longName.ok && longName.errors).toEqual([{ path: 'contact.name', code: 'too_long' }]);
        expect(validateSubmission({ max_party_size: 1 }, questions, { ...ok, contact: { ...ok.contact, phone: '+1 (555) 010-0100 x12' } }).ok).toBe(true);
        expect(validateSubmission({ max_party_size: 1 }, questions, { ...ok, contact: { ...ok.contact, phone: '' } }).ok).toBe(true);
      });
    });

    // ── Summary and self-service rules ─────────────────────────────────────────
    describe('registration summary and self-service', () => {
      const withQuestion = async (over: Partial<Parameters<typeof saveEvent>[1]> = {}) => {
        const id = await newEvent({ max_party_size: 4, ...over });
        await saveQuestions(getDb(), id, [{ sort: 0, type: 'text', required: 0, labels: { en: 'Diet', zh: '饮食' } }]);
        const [q] = await listQuestions(getDb(), 'en', id);
        return { id, q };
      };

      it('builds one summary: localized event and labels, attendees, answers, flags', async () => {
        const { id, q } = await withQuestion({
          titles: { en: { title: 'Retreat', notes: 'Bring a Bible' }, zh: { title: '退修会', notes: '请带圣经' } },
          location: 'Hall',
        });
        const r = await register(id, { attendees: party('Ada', 'Bob'), phone: '555 0100', locale: 'zh', answers: [[q.id, 'Vegetarian']] });
        const en = (await registrationSummary(getDb(), r.id, 'en'))!;
        expect(en.event).toMatchObject({ id, title: 'Retreat', notes: 'Bring a Bible', location: 'Hall', phase: 'open', max_party_size: 4 });
        expect(en.registration).toMatchObject({
          id: r.id, confirmation_no: r.confirmationNo, status: 'confirmed', name: 'Ada', email: 'ada@example.com',
          phone: '555 0100', locale: 'zh', party_size: 2, amount_cents: 0, cancelled_at: null,
        });
        expect(en.attendees.map((a) => [a.name, a.status])).toEqual([['Ada', 'active'], ['Bob', 'active']]);
        expect(en.answers).toEqual([{ question_id: q.id, label: 'Diet', value: 'Vegetarian' }]);
        expect([en.canEdit, en.canCancel]).toEqual([true, true]);
        const zh = (await registrationSummary(getDb(), r.id, 'zh'))!;
        expect([zh.event.title, zh.event.notes, zh.answers[0].label]).toEqual(['退修会', '请带圣经', '饮食']);
        expect(await registrationSummary(getDb(), 987654321, 'en')).toBeNull();
      });

      it('canEdit / canCancel follow the event phase, allow_self_edit and the registration status', async () => {
        const open = await newEvent();
        const preview = await newEvent({ opens_at: ts(2 * DAY) });
        const closed = await newEvent({ opens_at: ts(-3 * DAY), closes_at: ts(-1 * DAY), starts_at: ts(DAY) });
        const locked = await newEvent({ allow_self_edit: 0 });
        const flags = async (eventId: number) => {
          const r = await register(eventId);
          const s = (await registrationSummary(getDb(), r.id, 'en'))!;
          return { s, id: r.id, flags: [s.canEdit, s.canCancel] };
        };
        expect((await flags(open)).flags).toEqual([true, true]);
        expect((await flags(preview)).flags).toEqual([true, true]);
        expect((await flags(closed)).flags).toEqual([false, false]);
        expect((await flags(locked)).flags).toEqual([false, false]);
        for (const status of ['cancelled', 'declined']) {
          const r = await register(open);
          await getDb().prepare(`UPDATE registrations SET status = ?1 WHERE id = ?2`).bind(status, r.id).run();
          const s = (await registrationSummary(getDb(), r.id, 'en'))!;
          expect([s.canEdit, s.canCancel]).toEqual([false, false]);
        }
        const waiting = await register(open, { status: 'pending', amountCents: 500 });
        const pending = (await registrationSummary(getDb(), waiting.id, 'en'))!;
        expect([pending.canEdit, pending.canCancel]).toEqual([true, false]); // awaiting payment: no cancel
        // a hidden (inactive) event offers nothing either
        const hidden = await register(open);
        await getDb().prepare(`UPDATE reg_events SET active = 0 WHERE id = ?1`).bind(open).run();
        const h = (await registrationSummary(getDb(), hidden.id, 'en'))!;
        expect([h.canEdit, h.canCancel]).toEqual([false, false]);
      });

      it('updateRegistrationSelf edits name, phone, attendee names and answers, never the email', async () => {
        const { id, q } = await withQuestion();
        const r = await register(id, { attendees: party('Ada', 'Bob'), answers: [[q.id, 'old']] });
        const attendees = await getDb().prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort`).bind(r.id).all<{ id: number }>();
        const result = await updateRegistrationSelf(getDb(), r.id, {
          name: ' Ada L ', phone: '555 0199',
          attendees: [{ id: attendees.results[1].id, name: 'Robert' }],
          answers: { [String(q.id)]: 'new' },
        });
        expect(result).toEqual({ ok: true });
        const s = (await registrationSummary(getDb(), r.id, 'en'))!;
        expect([s.registration.name, s.registration.phone, s.registration.email]).toEqual(['Ada L', '555 0199', 'ada@example.com']);
        expect(s.attendees.map((a) => a.name)).toEqual(['Ada', 'Robert']);
        expect(s.answers.map((a) => a.value)).toEqual(['new']);
      });

      it('updateRegistrationSelf re-validates server side and returns field paths without writing', async () => {
        const id = await newEvent({ max_party_size: 2 });
        await saveQuestions(getDb(), id, [{ sort: 0, type: 'text', required: 1, labels: { en: 'Req' } }]);
        const [q] = await listQuestions(getDb(), 'en', id);
        const r = await register(id, { attendees: party('Ada', 'Bob'), answers: [[q.id, 'x']] });
        const foreign = await register(id, { attendees: party('Zed') });
        const foreignAttendee = (await getDb().prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1`).bind(foreign.id).first<{ id: number }>())!;
        const result = await updateRegistrationSelf(getDb(), r.id, {
          name: '', phone: 'abc', attendees: [{ id: foreignAttendee.id, name: 'Hacked' }], answers: { [String(q.id)]: '' },
        });
        expect(result).toEqual({
          ok: false,
          errors: expect.arrayContaining([
            { path: 'contact.name', code: 'required' },
            { path: 'contact.phone', code: 'invalid' },
            { path: 'attendees.0.id', code: 'not_found' },
            { path: `q.${q.id}`, code: 'missing_required' },
          ]),
        });
        const s = (await registrationSummary(getDb(), r.id, 'en'))!;
        expect([s.registration.name, s.answers[0].value]).toEqual(['Ada', 'x']);
        expect((await attendeeRows(foreign.id))[0].name).toBe('Zed');
      });

      it('updateRegistrationSelf and the cancels refuse when self-service is closed', async () => {
        const locked = await newEvent({ allow_self_edit: 0, max_party_size: 2 });
        const r = await register(locked, { attendees: party('Ada', 'Bob') });
        const a = (await getDb().prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort`).bind(r.id).first<{ id: number }>())!;
        expect(await updateRegistrationSelf(getDb(), r.id, { name: 'X' })).toEqual({ ok: false, errors: [{ path: '', code: 'not_allowed' }] });
        expect(await cancelAttendee(getDb(), r.id, a.id)).toEqual({ ok: false, reason: 'not_allowed' });
        expect(await cancelRegistrationSelf(getDb(), r.id)).toEqual({ ok: false, reason: 'not_allowed' });
        expect(await updateRegistrationSelf(getDb(), 987654321, { name: 'X' })).toEqual({ ok: false, errors: [{ path: '', code: 'not_found' }] });
        expect(await cancelRegistrationSelf(getDb(), 987654321)).toEqual({ ok: false, reason: 'not_found' });
        expect((await field(r.id)).status).toBe('confirmed');
      });

      it('findRegistrationForPerson uses the person-or-email ownership rule', async () => {
        const id = await newEvent();
        const r = await register(id, { email: 'Owner@Example.com' });
        expect(await findRegistrationForPerson(getDb(), r.id, 0, 'owner@example.com')).toEqual({ id: r.id, event_id: id, locale: null });
        expect(await findRegistrationForPerson(getDb(), r.id, 0, 'someone@example.com')).toBeNull();
        const mine = await register(id, { personId: null, email: 'p@example.com' });
        await getDb().prepare(`UPDATE registrations SET status = 'cancelled' WHERE id = ?1`).bind(mine.id).run();
        expect((await findRegistrationForPerson(getDb(), mine.id, 0, 'p@example.com'))?.id).toBe(mine.id);
      });

      it('restrictAttendeePersons keeps only the contact and live household members', async () => {
        const [a, b] = (await getDb().prepare(`SELECT id FROM people ORDER BY id LIMIT 2`).all<{ id: number }>()).results;
        if (!a || !b) return;
        const out = await restrictAttendeePersons(getDb(), a.id, [
          { name: 'Me', personId: b.id }, { name: 'Forged', personId: 999999 }, { name: 'None', personId: null },
        ]);
        expect(out[0].personId).toBe(a.id);
        expect(out[1].personId).toBeNull();
        expect(out[2].personId).toBeNull();
        expect((await restrictAttendeePersons(getDb(), null, [{ name: 'G', personId: a.id }]))[0].personId).toBeNull();
      });
    });

    // ── Cancellation and waitlist promotion ────────────────────────────────────
    describe('cancellation and waitlist promotion', () => {
      const status = async (registrationId: number) => (await field(registrationId)).status;

      it('cancelling one person lowers party_size, frees the seat and promotes the waitlist', async () => {
        const id = await newEvent({ capacity: 3, max_party_size: 3 });
        const family = await register(id, { attendees: party('A', 'B', 'C') });
        const waiting = await register(id, { attendees: party('D') });
        expect(waiting.status).toBe('waitlist');
        const b = (await getDb().prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 AND sort = 1`).bind(family.id).first<{ id: number }>())!;
        const result = await cancelAttendee(getDb(), family.id, b.id);
        expect(result).toEqual({ ok: true, registrationCancelled: false, promoted: [waiting.id] });
        expect((await field(family.id)).party_size).toBe(2);
        expect((await attendeeRows(family.id)).map((a) => a.status)).toEqual(['active', 'cancelled', 'active']);
        expect(await status(waiting.id)).toBe('confirmed');
        expect((await getOpenEvent(getDb(), 'en', id))!.taken_count).toBe(3);
        // cancelling the same person again changes nothing
        expect(await cancelAttendee(getDb(), family.id, b.id)).toEqual({ ok: false, reason: 'not_found' });
        expect((await field(family.id)).party_size).toBe(2);
      });

      it('cancelling the last active person cancels the registration', async () => {
        const id = await newEvent({ capacity: 5, max_party_size: 2 });
        const r = await register(id, { attendees: party('A', 'B') });
        const ids = (await getDb().prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort`).bind(r.id).all<{ id: number }>()).results;
        expect(await cancelAttendee(getDb(), r.id, ids[0].id)).toMatchObject({ ok: true, registrationCancelled: false });
        const last = await cancelAttendee(getDb(), r.id, ids[1].id);
        expect(last).toMatchObject({ ok: true, registrationCancelled: true });
        const row = await field(r.id);
        expect(row.status).toBe('cancelled');
        expect(row.cancelled_at).not.toBeNull();
        expect(row.party_size).toBe(1);
        expect((await getOpenEvent(getDb(), 'en', id))!.taken_count).toBe(0);
      });

      it('cancelRegistrationSelf cancels everyone, stamps cancelled_at and promotes', async () => {
        const id = await newEvent({ capacity: 2, max_party_size: 2 });
        const r = await register(id, { attendees: party('A', 'B') });
        const w = await register(id, { attendees: party('C', 'D') });
        expect(w.status).toBe('waitlist');
        expect(await cancelRegistrationSelf(getDb(), r.id)).toEqual({ ok: true, registrationCancelled: true, promoted: [w.id] });
        const row = await field(r.id);
        expect([row.status, row.cancelled_at === null]).toEqual(['cancelled', false]);
        expect((await attendeeRows(r.id)).map((a) => a.status)).toEqual(['cancelled', 'cancelled']);
        expect(await status(w.id)).toBe('confirmed');
        expect(await cancelRegistrationSelf(getDb(), r.id)).toEqual({ ok: false, reason: 'not_allowed' });
      });

      it('the admin cancel also promotes, and reports whether it cancelled', async () => {
        const id = await newEvent({ capacity: 1 });
        const r = await register(id);
        const w = await register(id);
        expect(await cancelRegistration(getDb(), r.id)).toBe(true);
        expect(await status(w.id)).toBe('confirmed');
        expect(await cancelRegistration(getDb(), r.id)).toBe(false);
        expect((await field(r.id)).cancelled_at).not.toBeNull();
        expect((await attendeeRows(r.id)).every((a) => a.status === 'cancelled')).toBe(true);
        expect(await cancelRegistration(getDb(), 987654321)).toBe(false);
      });

      it('promotes oldest first, skips a party that is too large, and promotes a smaller later one', async () => {
        const id = await newEvent({ capacity: 4, max_party_size: 4 });
        const seated = await register(id, { attendees: party('S1', 'S2', 'S3', 'S4') });
        const big = await register(id, { attendees: party('B1', 'B2', 'B3') });
        const small = await register(id, { attendees: party('M1') });
        const two = await register(id, { attendees: party('T1', 'T2') });
        const last = await register(id, { attendees: party('L1') });
        expect([big.status, small.status, two.status, last.status]).toEqual(['waitlist', 'waitlist', 'waitlist', 'waitlist']);
        const s = (await getDb().prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort`).bind(seated.id).all<{ id: number }>()).results;
        // 1 seat free: the party of 3 is skipped, the single (oldest that fits) is promoted.
        expect(await cancelAttendee(getDb(), seated.id, s[0].id)).toMatchObject({ ok: true, promoted: [small.id] });
        // 1 seat free again: the 3 and the pair are skipped, the later single is promoted.
        expect(await cancelAttendee(getDb(), seated.id, s[1].id)).toMatchObject({ ok: true, promoted: [last.id] });
        // 1 free: nobody fits. 2 free: the pair fits; the party of 3 still waits and stays first in line.
        expect(await cancelAttendee(getDb(), seated.id, s[2].id)).toMatchObject({ ok: true, promoted: [] });
        expect(await cancelAttendee(getDb(), seated.id, s[3].id)).toMatchObject({ ok: true, registrationCancelled: true, promoted: [two.id] });
        expect(await status(big.id)).toBe('waitlist');
      });

      it('promoteWaitlist is a no-op on a paid event and with nothing waiting', async () => {
        const paid = await newEvent({ capacity: 1, price_cents: 1000 });
        const a = await register(paid, { status: 'pending', amountCents: 1000 });
        await getDb().prepare(`UPDATE registrations SET status = 'waitlist' WHERE id = ?1`).bind(a.id).run();
        expect(await promoteWaitlist(getDb(), paid)).toEqual([]);
        expect(await status(a.id)).toBe('waitlist');
        expect(await promoteWaitlist(getDb(), await newEvent({ capacity: 3 }))).toEqual([]);
        expect(await promoteWaitlist(getDb(), 987654321)).toEqual([]);
      });

      it('promotes everyone when the event has no capacity limit', async () => {
        const id = await newEvent({ capacity: 1 });
        const r = await register(id);
        const w1 = await register(id);
        const w2 = await register(id);
        await getDb().prepare(`UPDATE reg_events SET capacity = NULL WHERE id = ?1`).bind(id).run();
        expect(await promoteWaitlist(getDb(), id)).toEqual([w1.id, w2.id]);
        expect(await status(r.id)).toBe('confirmed');
      });
    });

    it('listPublicEvents localizes through the fallback chain', async () => {
      const id = await newEvent({ titles: { en: { title: 'Camp' }, zh: { title: '营会' } } } as never);
      const find = async (locale: 'en' | 'zh' | 'fr') => (await listPublicEvents(getDb(), locale)).find((e) => e.id === id)!.title;
      expect(await find('zh')).toBe('营会');
      expect(await find('fr')).toBe('Camp');
    });
  });
}

export type { RegQuestion };
