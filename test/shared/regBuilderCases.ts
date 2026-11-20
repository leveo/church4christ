// Registration event-builder behavior that must hold on BOTH backends (Phase 3): the validated form
// writer (questions, options with stable keys, conditions, ticket types), per-person answers,
// ticket-type capacity and promotion, templates, and the v2 summary / self-service edit. Run against
// D1 (test/regBuilder.d1.test.ts) and Postgres (test/pg/regBuilder.pg.test.ts). No cloudflare:test or
// node imports, and the name does not end in .test.ts, so neither project collects it on its own.
import { describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import type { DbBackend } from '../../src/lib/dbProvider';
import {
  cancelRegistration,
  cloneEvent,
  createFromTemplate,
  createRegistration,
  deleteTemplate,
  getEventAdmin,
  getOpenEvent,
  getPublicEvent,
  listAllEvents,
  listEventsAdmin,
  listOpenEvents,
  listPublicEvents,
  listQuestions,
  listQuestionsAdmin,
  listRegistrationsForPerson,
  listTemplatesAdmin,
  listTicketTypes,
  listTicketTypesAdmin,
  promoteWaitlist,
  registrationPricing,
  saveAsTemplate,
  saveEvent,
  saveEventForm,
  saveQuestions,
  setEventLifecycle,
  type EventFormPayload,
  type RegAttendeeInput,
} from '../../src/lib/regDb';
import { listLinkableEvents, listOpenSpecialEventsForGroup } from '../../src/lib/groupRegDb';
import { cancelAttendee, registrationSummary, updateRegistrationSelf, validateSubmission } from '../../src/lib/regManage';
import { TERMS_ACCEPTED } from '../../src/lib/regDb';

const DAY = 24 * 3600_000;
export const tsAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

let keySeq = 0;
const key = () => `builder-${Date.now()}-${++keySeq}`;

export function defineRegBuilderCases(label: string, getDb: () => AppDb, backend: DbBackend): void {
  const newEvent = (over: Partial<Parameters<typeof saveEvent>[1]> = {}) =>
    saveEvent(getDb(), { title_en: 'Camp', title_zh: '营会', starts_at: tsAt(30 * DAY), active: 1, max_party_size: 6, ...over });
  const form = (eventId: number, payload: EventFormPayload) => saveEventForm(getDb(), eventId, payload, { backend });
  const mustSave = async (eventId: number, payload: EventFormPayload) => {
    const result = await form(eventId, payload);
    expect(result).toEqual({ ok: true });
  };
  const errorsOf = async (eventId: number, payload: EventFormPayload) => {
    const result = await form(eventId, payload);
    return result.ok ? [] : result.errors.map((e) => `${e.path}:${e.code}`);
  };
  const count = async (sql: string, ...binds: unknown[]) => Number((await getDb().prepare(sql).bind(...binds).first<{ n: number }>())!.n);
  const register = (eventId: number, attendees: RegAttendeeInput[], over: Partial<Parameters<typeof createRegistration>[1]> = {}) =>
    createRegistration(getDb(), {
      eventId, personId: null, name: attendees[0]?.name ?? 'Ada', email: 'ada@example.com', status: 'confirmed',
      amountCents: 0, currency: 'usd', answers: [], attendees, submissionKey: key(), ...over,
    });
  const ticketIds = async (eventId: number) => (await listTicketTypesAdmin(getDb(), eventId)).map((t) => t.id);
  const adults = { labels: { en: 'Adult', zh: '成人' }, descriptions: { en: 'Ages 13 and up' } };
  const kids = { labels: { en: 'Child', zh: '儿童' } };

  describe(`registration builder (${label})`, () => {
    // ── saveEventForm: questions ───────────────────────────────────────────────
    describe('saveEventForm questions', () => {
      it('writes every type with per-language texts and options with keys, and reads them back localized', async () => {
        const id = await newEvent();
        await mustSave(id, {
          questions: [
            { type: 'section', labels: { en: 'About you', zh: '关于你' }, help: { en: 'Intro text' } },
            { type: 'select', required: true, labels: { en: 'Shirt', zh: '衬衫' }, help: { en: 'Pick one', zh: '选一个' }, placeholder: { en: 'Size' },
              options: [{ key: 's', labels: { en: 'Small', zh: '小' } }, { key: 'l', labels: { en: 'Large' } }] },
            { type: 'text', scope: 'attendee', max_length: 20, labels: { en: 'Nickname' } },
            { type: 'terms', required: true, labels: { en: 'I agree' }, help: { en: 'The rules are ...' } },
            { type: 'number', labels: { en: 'Age' } },
            { type: 'date', labels: { en: 'Birthday' } },
            { type: 'email', labels: { en: 'Contact email' } },
            { type: 'phone', labels: { en: 'Emergency phone' } },
            { type: 'yesno', labels: { en: 'First time?' } },
            { type: 'checkbox', labels: { en: 'Allergies' }, options: [{ labels: { en: 'Nuts' } }, { labels: { en: 'Dairy' } }] },
            { type: 'textarea', labels: { en: 'Notes' } },
          ],
        });
        const zh = await listQuestions(getDb(), 'zh', id);
        expect(zh.map((q) => [q.type, q.scope, q.sort])).toEqual([
          ['section', 'registration', 0], ['select', 'registration', 1], ['text', 'attendee', 2], ['terms', 'registration', 3],
          ['number', 'registration', 4], ['date', 'registration', 5], ['email', 'registration', 6], ['phone', 'registration', 7],
          ['yesno', 'registration', 8], ['checkbox', 'registration', 9], ['textarea', 'registration', 10],
        ]);
        const shirt = zh[1];
        expect(shirt).toMatchObject({ label: '衬衫', help: '选一个', placeholder: 'Size', required: 1, options: ['s', 'l'] });
        // per key: zh where present, else the fallback chain (en) - the key itself is never a label here
        expect(shirt.option_labels).toEqual({ s: '小', l: 'Large' });
        expect(zh[0].required).toBe(0);
        expect(zh[2].max_length).toBe(20);
        expect(zh[3].help).toBe('The rules are ...');
        // generated option keys are valid and unique
        const allergies = zh[9];
        expect(allergies.options).toHaveLength(2);
        for (const k of allergies.options!) expect(k).toMatch(/^[a-z0-9_-]{1,40}$/);
        expect(new Set(allergies.options).size).toBe(2);
        expect(Object.values(allergies.option_labels).sort()).toEqual(['Dairy', 'Nuts']);

        const admin = await listQuestionsAdmin(getDb(), id);
        expect(admin[1].labels).toEqual({ en: 'Shirt', zh: '衬衫' });
        expect(admin[1].help).toEqual({ en: 'Pick one', zh: '选一个' });
        expect(admin[1].option_labels).toEqual({ en: { s: 'Small', l: 'Large' }, zh: { s: '小' } });
        expect(admin[2].max_length).toBe(20);
      });

      it('keeps surviving ids (and their answers) through a reorder, deletes absent ones, inserts new ones', async () => {
        const id = await newEvent();
        await mustSave(id, { questions: [{ type: 'text', labels: { en: 'A' } }, { type: 'text', labels: { en: 'B' } }, { type: 'text', labels: { en: 'C' } }] });
        const [a, b, c] = await listQuestions(getDb(), 'en', id);
        const r = await register(id, [{ name: 'Ada' }], { answers: [[a.id, 'a1'], [b.id, 'b1'], [c.id, 'c1']] });
        await mustSave(id, {
          questions: [
            { id: c.id, type: 'text', labels: { en: 'C!' } },
            { type: 'text', labels: { en: 'New' } },
            { id: a.id, type: 'text', labels: { en: 'A' } },
          ],
        });
        const after = await listQuestions(getDb(), 'en', id);
        expect(after.map((q) => q.label)).toEqual(['C!', 'New', 'A']);
        expect(after[0].id).toBe(c.id);
        expect(after[2].id).toBe(a.id);
        expect(after[1].id).not.toBe(b.id);
        const summary = (await registrationSummary(getDb(), r.id, 'en'))!;
        expect(summary.answers.map((x) => [x.label, x.value])).toEqual([['C!', 'c1'], ['A', 'a1']]);
        expect(await count(`SELECT count(*) AS n FROM reg_answers WHERE question_id = ?1`, b.id)).toBe(0);
      });

      it('an id that belongs to another event is a new question and never touches that event', async () => {
        const mine = await newEvent();
        const other = await newEvent();
        await mustSave(other, { questions: [{ type: 'text', labels: { en: 'Theirs' } }] });
        const [theirs] = await listQuestions(getDb(), 'en', other);
        await mustSave(mine, { questions: [{ id: theirs.id, type: 'text', labels: { en: 'Mine' } }] });
        expect((await listQuestions(getDb(), 'en', other)).map((q) => q.label)).toEqual(['Theirs']);
        const [created] = await listQuestions(getDb(), 'en', mine);
        expect(created.label).toBe('Mine');
        expect(created.id).not.toBe(theirs.id);
      });

      it('returns field-path errors for bad input and writes nothing', async () => {
        const id = await newEvent();
        await mustSave(id, { questions: [{ type: 'text', labels: { en: 'Keep me' } }] });
        const bad = await errorsOf(id, {
          questions: [
            { type: 'bogus', labels: { en: 'x' } },
            { type: 'text', labels: { zh: '只有中文' } },
            { type: 'select', labels: { en: 'No options' }, options: [] },
            { type: 'select', labels: { en: 'Bad key' }, options: [{ key: 'Has Space', labels: { en: 'x' } }] },
            { type: 'select', labels: { en: 'Dup' }, options: [{ key: 'a', labels: { en: 'A' } }, { key: 'a', labels: { en: 'A2' } }] },
            { type: 'select', labels: { en: 'No option label' }, options: [{ key: 'a', labels: {} }] },
            { type: 'text', labels: { en: 'Long' }, max_length: 5001 },
            { type: 'text', scope: 'group', labels: { en: 'Scope' } },
            { type: 'text', labels: { xx: 'bad locale', en: 'ok' } as never },
          ],
        });
        expect(bad).toEqual([
          'questions.0.type:unknown_type',
          'questions.1.labels.en:required',
          'questions.2.options:required',
          'questions.3.options.0.key:invalid',
          'questions.4.options.1.key:duplicate',
          'questions.5.options.0.labels.en:required',
          'questions.6.max_length:invalid',
          'questions.7.scope:invalid',
          'questions.8.labels.xx:locale_unsupported',
        ]);
        expect((await listQuestions(getDb(), 'en', id)).map((q) => q.label)).toEqual(['Keep me']);
        expect(await errorsOf(987654, { questions: [] })).toEqual([':event_not_found']);
        const notAnObject = await saveEventForm(getDb(), id, 'nope', { backend });
        expect(notAnObject).toEqual({ ok: false, errors: [{ path: '', code: 'invalid' }] });
      });

      it('legacy option strings stay valid keys on re-save; new keys must be new-style', async () => {
        const id = await newEvent();
        await saveQuestions(getDb(), id, [{ sort: 0, type: 'select', required: 0, options: ['Large (XL)', 'Small'], labels: { en: 'Size' } }]);
        const [legacy] = await listQuestionsAdmin(getDb(), id);
        expect(legacy.options).toEqual(['Large (XL)', 'Small']);
        // the legacy reader shows the string itself as the label
        const [read] = await listQuestions(getDb(), 'en', id);
        expect(read.options).toEqual(['Large (XL)', 'Small']);
        expect(read.option_labels).toEqual({});
        await mustSave(id, {
          questions: [{ id: legacy.id, type: 'select', labels: { en: 'Size' }, options: [{ key: 'Large (XL)', labels: { en: 'Large (XL)' } }, { key: 'Small', labels: { en: 'Small' } }] }],
        });
        expect(await errorsOf(id, {
          questions: [{ id: legacy.id, type: 'select', labels: { en: 'Size' }, options: [{ key: 'Brand New', labels: { en: 'x' } }] }],
        })).toEqual(['questions.0.options.0.key:invalid']);
        // a different question does not inherit another question's legacy keys
        expect(await errorsOf(id, {
          questions: [{ type: 'select', labels: { en: 'Other' }, options: [{ key: 'Large (XL)', labels: { en: 'x' } }] }],
        })).toEqual(['questions.0.options.0.key:invalid']);
      });

      it('options and answers round trip through the checker with keys', async () => {
        const id = await newEvent();
        await mustSave(id, { questions: [{ type: 'select', required: true, labels: { en: 'Pick' }, options: [{ key: 'a', labels: { en: 'Alpha' } }, { key: 'b', labels: { en: 'Beta' } }] }] });
        const questions = await listQuestions(getDb(), 'en', id);
        const bad = validateSubmission({ max_party_size: 1 }, questions, { contact: { name: 'Ada', email: 'a@example.com' }, answers: { [String(questions[0].id)]: 'Alpha' } });
        expect(!bad.ok && bad.errors).toEqual([{ path: `q.${questions[0].id}`, code: 'bad_answer' }]);
        const good = validateSubmission({ max_party_size: 1 }, questions, { contact: { name: 'Ada', email: 'a@example.com' }, answers: { [String(questions[0].id)]: 'a' } });
        expect(good.ok && good.value.answers).toEqual([[questions[0].id, 'a']]);
      });
    });

    // ── saveEventForm: conditions ──────────────────────────────────────────────
    describe('saveEventForm conditions', () => {
      const base: EventFormPayload['questions'] = [
        { id: undefined, key: 'size', type: 'select', labels: { en: 'Size' }, options: [{ key: 's', labels: { en: 'S' } }, { key: 'l', labels: { en: 'L' } }] },
      ];

      it('stores conditions between new questions (by key), and surviving questions may point at new ones', async () => {
        const id = await newEvent();
        await mustSave(id, {
          questions: [
            ...base!,
            { key: 'why', type: 'text', labels: { en: 'Why large?' }, condition: { q: 'size', op: 'eq', value: 'l' } },
            { type: 'text', labels: { en: 'More' }, condition: { q: 'why', op: 'answered' } },
          ],
        });
        const [size, why, more] = await listQuestions(getDb(), 'en', id);
        expect(why.condition).toEqual({ q: size.id, op: 'eq', value: 'l' });
        expect(more.condition).toEqual({ q: why.id, op: 'answered' });
        // an existing question gains a condition on a NEW earlier question
        await mustSave(id, {
          questions: [
            { id: size.id, type: 'select', labels: { en: 'Size' }, options: [{ key: 's', labels: { en: 'S' } }, { key: 'l', labels: { en: 'L' } }] },
            { key: 'fresh', type: 'yesno', labels: { en: 'Fresh?' } },
            { id: why.id, type: 'text', labels: { en: 'Why large?' }, condition: { q: 'fresh', op: 'checked' } },
            { id: more.id, type: 'text', labels: { en: 'More' }, condition: { q: why.id, op: 'answered' } },
          ],
        });
        const after = await listQuestions(getDb(), 'en', id);
        expect(after.map((q) => q.label)).toEqual(['Size', 'Fresh?', 'Why large?', 'More']);
        expect(after[2].condition).toEqual({ q: after[1].id, op: 'checked' });
        expect(after[3].condition).toEqual({ q: why.id, op: 'answered' });
        // a re-save without a condition clears it
        await mustSave(id, { questions: [{ id: size.id, type: 'select', labels: { en: 'Size' }, options: [{ key: 's', labels: { en: 'S' } }] }, { id: why.id, type: 'text', labels: { en: 'Why large?' } }] });
        expect((await listQuestions(getDb(), 'en', id))[1].condition).toBeNull();
      });

      it('refuses bad targets, forward references, cycles, section/terms targets, scope mix-ups, bad operators and values', async () => {
        const id = await newEvent();
        await mustSave(id, { questions: [...base!, { type: 'text', labels: { en: 'Later' } }] });
        const [size, later] = await listQuestions(getDb(), 'en', id);
        const sizeInput = { id: size.id, type: 'select', labels: { en: 'Size' }, options: [{ key: 's', labels: { en: 'S' } }, { key: 'l', labels: { en: 'L' } }] };
        const text = (over: Record<string, unknown>) => ({ type: 'text', labels: { en: 'T' }, ...over });
        expect(await errorsOf(id, { questions: [sizeInput, text({ condition: { q: 99999, op: 'answered' } })] })).toEqual(['questions.1.condition.q:condition_target_unknown']);
        expect(await errorsOf(id, { questions: [sizeInput, text({ condition: { q: 'nope', op: 'answered' } })] })).toEqual(['questions.1.condition.q:condition_target_unknown']);
        // forward reference: the target comes later
        expect(await errorsOf(id, { questions: [text({ key: 'a', condition: { q: 'b', op: 'answered' } }), text({ key: 'b' })] })).toEqual(['questions.0.condition.q:condition_target_forward']);
        // a cycle (A shows if B answered, B shows if A answered) needs a forward edge
        expect(await errorsOf(id, { questions: [text({ key: 'a', condition: { q: 'b', op: 'answered' } }), text({ key: 'b', condition: { q: 'a', op: 'answered' } })] }))
          .toEqual(['questions.0.condition.q:condition_target_forward']);
        // itself
        expect(await errorsOf(id, { questions: [text({ key: 'a', condition: { q: 'a', op: 'answered' } })] })).toEqual(['questions.0.condition.q:condition_target_forward']);
        // section / terms targets
        expect(await errorsOf(id, { questions: [{ type: 'section', key: 's', labels: { en: 'H' } }, text({ condition: { q: 's', op: 'answered' } })] })).toEqual(['questions.1.condition.q:condition_target_type']);
        expect(await errorsOf(id, { questions: [{ type: 'terms', key: 't', labels: { en: 'T' } }, text({ condition: { q: 't', op: 'answered' } })] })).toEqual(['questions.1.condition.q:condition_target_type']);
        // a registration-scoped question cannot depend on a per-person one
        expect(await errorsOf(id, { questions: [text({ key: 'p', scope: 'attendee' }), text({ condition: { q: 'p', op: 'answered' } })] })).toEqual(['questions.1.condition.q:condition_target_scope']);
        // operators and values
        expect(await errorsOf(id, { questions: [sizeInput, text({ condition: { q: size.id, op: 'checked' } })] })).toEqual(['questions.1.condition.op:condition_op_invalid']);
        expect(await errorsOf(id, { questions: [sizeInput, text({ condition: { q: size.id, op: 'eq', value: 'xl' } })] })).toEqual(['questions.1.condition.value:condition_value_invalid']);
        expect(await errorsOf(id, { questions: [sizeInput, text({ condition: { q: size.id, op: 'in', value: ['s', 'zz'] } })] })).toEqual(['questions.1.condition.value:condition_value_invalid']);
        expect(await errorsOf(id, { questions: [sizeInput, text({ condition: 'nope' as never })] })).toEqual(['questions.1.condition:invalid']);
        // nothing was written
        expect((await listQuestions(getDb(), 'en', id)).map((q) => q.id)).toEqual([size.id, later.id]);
      });

      it('refuses deleting a question another question still points at, with a clear code', async () => {
        const id = await newEvent();
        await mustSave(id, { questions: [...base!, { key: 'why', type: 'text', labels: { en: 'Why' }, condition: { q: 'size', op: 'eq', value: 'l' } }] });
        const [size, why] = await listQuestions(getDb(), 'en', id);
        expect(await errorsOf(id, { questions: [{ id: why.id, type: 'text', labels: { en: 'Why' }, condition: { q: size.id, op: 'eq', value: 'l' } }] }))
          .toEqual(['questions.0.condition.q:condition_target_deleted']);
        expect(await listQuestions(getDb(), 'en', id)).toHaveLength(2);
        // deleting both is fine
        await mustSave(id, { questions: [] });
        expect(await listQuestions(getDb(), 'en', id)).toHaveLength(0);
      });

      it('the legacy saveQuestions also refuses to delete a referenced question', async () => {
        const id = await newEvent();
        await mustSave(id, { questions: [...base!, { key: 'why', type: 'text', labels: { en: 'Why' }, condition: { q: 'size', op: 'eq', value: 'l' } }] });
        const [size, why] = await listQuestions(getDb(), 'en', id);
        await expect(saveQuestions(getDb(), id, [{ id: why.id, sort: 0, type: 'text', required: 0, labels: { en: 'Why' } }])).rejects.toThrow('question_referenced');
        // keeping the target keeps the condition
        await saveQuestions(getDb(), id, [{ id: size.id, sort: 0, type: 'select', required: 0, options: ['s', 'l'], labels: { en: 'Size' } }, { id: why.id, sort: 1, type: 'text', required: 0, labels: { en: 'Why' } }]);
        expect((await listQuestions(getDb(), 'en', id))[1].condition).toEqual({ q: size.id, op: 'eq', value: 'l' });
      });
    });

    // ── Ticket types ───────────────────────────────────────────────────────────
    describe('saveEventForm ticket types', () => {
      it('writes, reads (localized, admin raw), reorders, updates and deletes unused types', async () => {
        const id = await newEvent();
        await mustSave(id, { tickets: [{ ...adults, capacity: 10 }, { ...kids, capacity: null }] });
        const zh = await listTicketTypes(getDb(), 'zh', id);
        expect(zh.map((t) => [t.label, t.description, t.price_cents, t.capacity, t.seats_left, t.taken])).toEqual([
          ['成人', 'Ages 13 and up', 0, 10, 10, 0], ['儿童', null, 0, null, null, 0],
        ]);
        const admin = await listTicketTypesAdmin(getDb(), id);
        expect(admin[0].labels).toEqual({ en: 'Adult', zh: '成人' });
        const [adult, child] = admin;
        await mustSave(id, { tickets: [{ id: child.id, ...kids, capacity: 5 }, { id: adult.id, ...adults, capacity: 10, active: false }] });
        const reordered = await listTicketTypes(getDb(), 'en', id);
        expect(reordered.map((t) => [t.id, t.active, t.capacity])).toEqual([[child.id, 1, 5], [adult.id, 0, 10]]);
        expect((await listTicketTypes(getDb(), 'en', id, { activeOnly: true })).map((t) => t.id)).toEqual([child.id]);
        await mustSave(id, { tickets: [{ id: child.id, ...kids }] });
        expect(await ticketIds(id)).toEqual([child.id]);
        // tickets undefined leaves them alone; questions saves do not touch them
        await mustSave(id, { questions: [] });
        expect(await ticketIds(id)).toEqual([child.id]);
      });

      it('validates price, limit, labels and refuses deleting a type people hold', async () => {
        const id = await newEvent();
        expect(await errorsOf(id, {
          tickets: [
            { labels: { en: 'A' }, price_cents: -1 },
            { labels: { en: 'B' }, price_cents: 1.5 },
            { labels: { en: 'C' }, capacity: 0 },
            { labels: { zh: '只有中文' } },
          ],
        })).toEqual(['tickets.0.price_cents:invalid', 'tickets.1.price_cents:invalid', 'tickets.2.capacity:invalid', 'tickets.3.labels.en:required']);
        await mustSave(id, { tickets: [adults, kids] });
        const [adult, child] = await ticketIds(id);
        await register(id, [{ name: 'Ada', ticketTypeId: adult }]);
        expect(await errorsOf(id, { tickets: [{ id: child, ...kids }] })).toEqual(['tickets:delete_in_use']);
        expect(await ticketIds(id)).toEqual([adult, child]);
        await mustSave(id, { tickets: [{ id: adult, ...adults, active: false }] }); // deactivate keeps it; the unused one goes
        expect(await ticketIds(id)).toEqual([adult]);
      });

      it(backend === 'd1' ? 'refuses a ticket price above 0 on D1 (paid registration needs Postgres)' : 'accepts ticket prices on Postgres', async () => {
        const id = await newEvent();
        const result = await errorsOf(id, { tickets: [{ ...adults, price_cents: 2500 }] });
        if (backend === 'd1') expect(result).toEqual(['tickets.0.price_cents:paid_unavailable']);
        else {
          expect(result).toEqual([]);
          expect((await listTicketTypes(getDb(), 'en', id))[0].price_cents).toBe(2500);
        }
      });
    });

    // ── validateSubmission v2 ──────────────────────────────────────────────────
    describe('validateSubmission v2', () => {
      const contact = { name: 'Ada', email: 'ada@example.com' };
      const setup = async () => {
        const id = await newEvent();
        await mustSave(id, {
          questions: [
            { key: 'diet', type: 'select', required: true, labels: { en: 'Diet' }, options: [{ key: 'veg', labels: { en: 'Vegetarian' } }, { key: 'other', labels: { en: 'Other' } }] },
            { key: 'detail', type: 'text', required: true, max_length: 10, labels: { en: 'Detail' }, condition: { q: 'diet', op: 'eq', value: 'other' } },
            { key: 'terms', type: 'terms', required: true, labels: { en: 'Agree' } },
            { key: 'age', type: 'number', scope: 'attendee', required: true, labels: { en: 'Age' } },
            { key: 'dob', type: 'date', scope: 'attendee', labels: { en: 'Birthday' } },
            { key: 'allergy', type: 'yesno', scope: 'attendee', labels: { en: 'Allergies?' } },
            { key: 'allergyDetail', type: 'textarea', scope: 'attendee', required: true, labels: { en: 'Which?' }, condition: { q: 'allergy', op: 'checked' } },
            { key: 'mail', type: 'email', labels: { en: 'Email' } },
            { key: 'tel', type: 'phone', labels: { en: 'Phone' } },
          ],
        });
        const qs = await listQuestions(getDb(), 'en', id);
        const idOf = (label: string) => String(qs.find((q) => q.label === label)!.id);
        return { id, qs, idOf };
      };

      it('collects per-person answers under attendees.<i>.q.<id> and registration answers under q.<id>', async () => {
        const { qs, idOf } = await setup();
        const result = validateSubmission({ max_party_size: 3 }, qs, {
          contact,
          answers: { [idOf('Diet')]: 'veg', [idOf('Agree')]: 'on' },
          attendees: [
            { name: '', answers: { [idOf('Age')]: '41', [idOf('Allergies?')]: 'no' } },
            { name: 'Bob', answers: { [idOf('Age')]: '8', [idOf('Birthday')]: '2018-02-28', [idOf('Allergies?')]: 'yes', [idOf('Which?')]: ' peanuts ' } },
            { name: '   ', answers: { [idOf('Age')]: 'ignored for a blank row' } },
          ],
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.answers).toEqual([[Number(idOf('Diet')), 'veg'], [Number(idOf('Agree')), TERMS_ACCEPTED]]);
        expect(result.value.attendees).toEqual([
          { name: 'Ada', personId: null, ticketTypeId: null, answers: [[Number(idOf('Age')), '41'], [Number(idOf('Allergies?')), 'no']] },
          { name: 'Bob', personId: null, ticketTypeId: null, answers: [[Number(idOf('Age')), '8'], [Number(idOf('Birthday')), '2018-02-28'], [Number(idOf('Allergies?')), 'yes'], [Number(idOf('Which?')), 'peanuts']] },
        ]);
      });

      it('conditions: a hidden question is never required and its value is dropped; shown ones are required', async () => {
        const { qs, idOf } = await setup();
        const hidden = validateSubmission({ max_party_size: 1 }, qs, {
          contact, answers: { [idOf('Diet')]: 'veg', [idOf('Detail')]: 'stale value is dropped', [idOf('Agree')]: 'on' },
          attendees: [{ name: '', answers: { [idOf('Age')]: '5', [idOf('Which?')]: 'stale', [idOf('Allergies?')]: 'no' } }],
        });
        expect(hidden.ok && hidden.value.answers.map(([q]) => q)).toEqual([Number(idOf('Diet')), Number(idOf('Agree'))]);
        expect(hidden.ok && hidden.value.attendees[0].answers.map(([q]) => q)).toEqual([Number(idOf('Age')), Number(idOf('Allergies?'))]);
        const shown = validateSubmission({ max_party_size: 1 }, qs, {
          contact, answers: { [idOf('Diet')]: 'other', [idOf('Agree')]: 'on' },
          attendees: [{ name: '', answers: { [idOf('Age')]: '5', [idOf('Allergies?')]: 'yes' } }],
        });
        expect(!shown.ok && shown.errors).toEqual([
          { path: `attendees.0.q.${idOf('Which?')}`, code: 'missing_required' },
          { path: `q.${idOf('Detail')}`, code: 'missing_required' },
        ]);
      });

      it('checks every type: number, date, email, phone, max_length, terms, required per person', async () => {
        const { qs, idOf } = await setup();
        const result = validateSubmission({ max_party_size: 2 }, qs, {
          contact,
          answers: { [idOf('Diet')]: 'other', [idOf('Detail')]: 'x'.repeat(11), [idOf('Agree')]: 'off', [idOf('Email')]: 'not-an-email', [idOf('Phone')]: 'abc' },
          attendees: [{ name: '', answers: { [idOf('Age')]: 'forty' } }, { name: 'Bob', answers: { [idOf('Birthday')]: '2018-02-30' } }],
        });
        expect(!result.ok && result.errors).toEqual([
          { path: `attendees.0.q.${idOf('Age')}`, code: 'bad_answer' },
          { path: `attendees.1.q.${idOf('Age')}`, code: 'missing_required' },
          { path: `attendees.1.q.${idOf('Birthday')}`, code: 'bad_answer' },
          { path: `q.${idOf('Detail')}`, code: 'too_long' },
          { path: `q.${idOf('Agree')}`, code: 'missing_required' },
          { path: `q.${idOf('Email')}`, code: 'bad_answer' },
          { path: `q.${idOf('Phone')}`, code: 'bad_answer' },
        ]);
        const ok = validateSubmission({ max_party_size: 1 }, qs, {
          contact, answers: { [idOf('Diet')]: 'veg', [idOf('Agree')]: 'yes', [idOf('Email')]: ' Pat@Example.COM ', [idOf('Phone')]: '+1 555 0100' },
          attendees: [{ name: '', answers: { [idOf('Age')]: '-3.5' } }],
        });
        expect(ok.ok && ok.value.answers.find(([q]) => q === Number(idOf('Email')))?.[1]).toBe('pat@example.com');
      });

      it('terms are boolean-only for clients: a posted timestamp or the internal marker is rejected, any checked value is accepted', async () => {
        const id = await newEvent();
        await mustSave(id, { questions: [{ type: 'terms', required: true, labels: { en: 'Agree' } }] });
        const qs = await listQuestions(getDb(), 'en', id);
        const run = (value: string) => validateSubmission({ max_party_size: 1 }, qs, { contact, answers: { [String(qs[0].id)]: value } });
        for (const forged of ['2020-01-01 00:00:00', TERMS_ACCEPTED]) {
          const r = run(forged);
          expect(!r.ok && r.errors).toEqual([{ path: `q.${qs[0].id}`, code: 'bad_answer' }]);
        }
        for (const checked of ['on', 'yes', 'true', '1']) {
          const r = run(checked);
          expect(r.ok && r.value.answers).toEqual([[qs[0].id, TERMS_ACCEPTED]]);
        }
      });

      it('ticket types: required per person when the event has active types, must be active and belong to the event', async () => {
        const id = await newEvent();
        const other = await newEvent();
        await mustSave(id, { tickets: [adults, kids] });
        await mustSave(other, { tickets: [adults] });
        const [adult, child] = await ticketIds(id);
        const [foreign] = await ticketIds(other);
        await mustSave(id, { tickets: [{ id: adult, ...adults }, { id: child, ...kids, active: false }] });
        const types = await listTicketTypes(getDb(), 'en', id);
        const check = (attendees: Array<Record<string, unknown>>) => {
          const r = validateSubmission({ max_party_size: 4 }, [], { contact, attendees }, { ticketTypes: types });
          return r.ok ? r.value.attendees.map((a) => a.ticketTypeId) : r.errors.map((e) => `${e.path}:${e.code}`);
        };
        expect(check([{ name: '', ticketTypeId: adult }, { name: 'Bob', ticketTypeId: String(adult) }])).toEqual([adult, adult]);
        expect(check([{ name: '' }, { name: 'Bob', ticketTypeId: child }, { name: 'Cy', ticketTypeId: foreign }, { name: 'Di', ticketTypeId: 'x' }]))
          .toEqual(['attendees.0.ticket:required', 'attendees.1.ticket:invalid', 'attendees.2.ticket:invalid', 'attendees.3.ticket:invalid']);
        expect(check([{ name: '', ticketTypeId: adult }, { name: '  ' }])).toEqual([adult]); // a blank extra row needs no ticket
        // no active type -> the field is ignored (today's behavior)
        const none = validateSubmission({ max_party_size: 2 }, [], { contact, attendees: [{ name: '', ticketTypeId: 77 }] }, { ticketTypes: [{ id: 1, active: 0 }] });
        expect(none.ok && none.value.attendees[0].ticketTypeId).toBeNull();
        expect(validateSubmission({ max_party_size: 2 }, [], { contact }).ok).toBe(true);
      });
    });

    // ── Writer: ticket types, per-person answers ───────────────────────────────
    describe('registration writer with ticket types and per-person answers', () => {
      it('stores each attendee\'s ticket type and per-person answers; terms get a stamped time; amount follows the types', async () => {
        const id = await newEvent({ capacity: 10 });
        await mustSave(id, {
          questions: [
            { type: 'text', labels: { en: 'Group note' } },
            { type: 'text', scope: 'attendee', labels: { en: 'Shirt' } },
            { type: 'terms', labels: { en: 'Agree' } },
          ],
          tickets: [adults, kids],
        });
        const [note, shirt, terms] = await listQuestions(getDb(), 'en', id);
        const [adult, child] = await ticketIds(id);
        const r = await register(id, [
          { name: 'Ada', ticketTypeId: adult, answers: [[shirt.id, 'M'], [terms.id, TERMS_ACCEPTED]] },
          { name: 'Bo', ticketTypeId: child, answers: [[shirt.id, 'S']] },
        ], { answers: [[note.id, 'together'], [terms.id, TERMS_ACCEPTED]], amountCents: 12345 });
        expect(r.status).toBe('confirmed');
        const rows = (await getDb().prepare(
          `SELECT a.name AS name, a.ticket_type_id AS t, aa.value AS v, aa.question_id AS q
           FROM reg_attendees a LEFT JOIN reg_attendee_answers aa ON aa.attendee_id = a.id
           WHERE a.registration_id = ?1 ORDER BY a.sort, aa.question_id`,
        ).bind(r.id).all<{ name: string; t: number; v: string; q: number }>()).results;
        expect(rows.map((x) => [x.name, Number(x.t), x.q === terms.id ? 'terms' : x.v])).toEqual([
          ['Ada', adult, 'M'], ['Ada', adult, 'terms'], ['Bo', child, 'S'],
        ]);
        // the acceptance time is a UTC timestamp, never the sentinel
        const stamped = rows.find((x) => x.q === terms.id)!.v;
        expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        const regTerms = await getDb().prepare(`SELECT value FROM reg_answers WHERE registration_id = ?1 AND question_id = ?2`).bind(r.id, terms.id).first<{ value: string }>();
        expect(regTerms!.value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        // free types: the passed amount is ignored (sum of type prices = 0)
        expect((await getDb().prepare(`SELECT amount_cents FROM registrations WHERE id = ?1`).bind(r.id).first<{ amount_cents: number }>())!.amount_cents).toBe(0);
        const types = await listTicketTypes(getDb(), 'en', id);
        expect(types.map((t) => t.taken)).toEqual([1, 1]);
      });

      it('requires a type on an event that has active types, and refuses one on an event that has none', async () => {
        const typed = await newEvent();
        await mustSave(typed, { tickets: [adults] });
        const [adult] = await ticketIds(typed);
        await expect(register(typed, [{ name: 'Ada' }])).rejects.toThrow('ticket_type_required');
        await expect(register(typed, [{ name: 'Ada', ticketTypeId: adult + 9999 }])).rejects.toThrow('ticket_type_invalid');
        const plain = await newEvent();
        await expect(register(plain, [{ name: 'Ada', ticketTypeId: adult }])).rejects.toThrow('ticket_type_invalid');
        const other = await newEvent();
        await mustSave(other, { tickets: [kids] });
        await expect(register(other, [{ name: 'Ada', ticketTypeId: adult }])).rejects.toThrow('ticket_type_invalid');
        // a deactivated type cannot be chosen
        await mustSave(typed, { tickets: [{ id: adult, ...adults, active: false }] });
        await expect(register(typed, [{ name: 'Ada', ticketTypeId: adult }])).rejects.toThrow('ticket_type_invalid');
        expect(await count(`SELECT count(*) AS n FROM registrations WHERE event_id IN (?1, ?2, ?3)`, typed, plain, other)).toBe(0);
      });

      it('a free party over a ticket-type limit waitlists whole; other types and smaller parties still fit', async () => {
        const id = await newEvent({ capacity: 20 });
        await mustSave(id, { tickets: [{ ...adults, capacity: 2 }, { ...kids, capacity: 1 }] });
        const [adult, child] = await ticketIds(id);
        expect((await register(id, [{ name: 'A1', ticketTypeId: adult }])).status).toBe('confirmed');
        // two adults would make 3 > 2: the whole party (including its child) waitlists
        const over = await register(id, [{ name: 'A2', ticketTypeId: adult }, { name: 'A3', ticketTypeId: adult }, { name: 'C1', ticketTypeId: child }]);
        expect(over.status).toBe('waitlist');
        expect((await listTicketTypes(getDb(), 'en', id)).map((t) => [t.taken, t.seats_left])).toEqual([[1, 1], [0, 1]]);
        // a child alone and one more adult still fit
        expect((await register(id, [{ name: 'C2', ticketTypeId: child }])).status).toBe('confirmed');
        expect((await register(id, [{ name: 'A4', ticketTypeId: adult }])).status).toBe('confirmed');
        expect((await register(id, [{ name: 'A5', ticketTypeId: adult }])).status).toBe('waitlist');
        expect((await listTicketTypes(getDb(), 'en', id)).map((t) => t.taken)).toEqual([2, 1]);
      });

      it('a type limit with the waitlist off throws event_full and inserts nothing', async () => {
        const id = await newEvent({ waitlist_enabled: 0 });
        await mustSave(id, { tickets: [{ ...adults, capacity: 1 }] });
        const [adult] = await ticketIds(id);
        await register(id, [{ name: 'A1', ticketTypeId: adult }]);
        await expect(register(id, [{ name: 'A2', ticketTypeId: adult }])).rejects.toThrow('event_full');
        expect(await count(`SELECT count(*) AS n FROM registrations WHERE event_id = ?1`, id)).toBe(1);
        // allowWaitlist: false behaves the same on an event with the waitlist on
        const on = await newEvent();
        await mustSave(on, { tickets: [{ ...adults, capacity: 1 }] });
        const [onAdult] = await ticketIds(on);
        await register(on, [{ name: 'A1', ticketTypeId: onAdult }]);
        await expect(register(on, [{ name: 'A2', ticketTypeId: onAdult }], { allowWaitlist: false })).rejects.toThrow('event_full');
      });

      it('promotion respects type limits and event capacity; a cancelled person frees a seat of their type', async () => {
        const id = await newEvent({ capacity: 10 });
        await mustSave(id, { tickets: [{ ...adults, capacity: 1 }, { ...kids, capacity: 1 }] });
        const [adult, child] = await ticketIds(id);
        const a1 = await register(id, [{ name: 'A1', ticketTypeId: adult }]);
        const c1 = await register(id, [{ name: 'C1', ticketTypeId: child }]);
        const mixed = await register(id, [{ name: 'A2', ticketTypeId: adult }, { name: 'C2', ticketTypeId: child }]);
        const adultOnly = await register(id, [{ name: 'A3', ticketTypeId: adult }]);
        expect([mixed.status, adultOnly.status]).toEqual(['waitlist', 'waitlist']);
        // nothing freed: nothing promoted
        expect(await promoteWaitlist(getDb(), id)).toEqual([]);
        // freeing the adult seat: the older MIXED party still lacks a child seat, so the adult-only party takes it
        expect(await cancelRegistration(getDb(), a1.id)).toBe(true);
        expect((await getDb().prepare(`SELECT status FROM registrations WHERE id = ?1`).bind(mixed.id).first<{ status: string }>())!.status).toBe('waitlist');
        expect((await getDb().prepare(`SELECT status FROM registrations WHERE id = ?1`).bind(adultOnly.id).first<{ status: string }>())!.status).toBe('confirmed');
        // freeing the child seat too: the mixed party needs an adult seat as well -> still waits
        await cancelRegistration(getDb(), c1.id);
        expect((await getDb().prepare(`SELECT status FROM registrations WHERE id = ?1`).bind(mixed.id).first<{ status: string }>())!.status).toBe('waitlist');
      });

      it('self-cancelling one person frees a seat of that type for the waitlist', async () => {
        const id = await newEvent();
        await mustSave(id, { tickets: [{ ...adults, capacity: 2 }] });
        const [adult] = await ticketIds(id);
        const first = await register(id, [{ name: 'A1', ticketTypeId: adult }, { name: 'A2', ticketTypeId: adult }]);
        const waiting = await register(id, [{ name: 'A3', ticketTypeId: adult }]);
        expect(waiting.status).toBe('waitlist');
        const summary = (await registrationSummary(getDb(), first.id, 'en'))!;
        const result = await cancelAttendee(getDb(), first.id, summary.attendees[1].id);
        expect(result).toMatchObject({ ok: true, promoted: [waiting.id] });
        expect((await listTicketTypes(getDb(), 'en', id))[0].taken).toBe(2);
      });

      it('registrationPricing sums type prices, or multiplies the event price when there are no types', () => {
        const types = [{ id: 1, active: 1, price_cents: 2500, label: 'Adult' }, { id: 2, active: 1, price_cents: 1000, label: 'Child' }, { id: 3, active: 0, price_cents: 1, label: 'Off' }];
        expect(registrationPricing({ price_cents: 9999 }, types, [{ ticketTypeId: 1 }, { ticketTypeId: 2 }, { ticketTypeId: 2 }])).toEqual({
          amountCents: 4500,
          lines: [{ ticketTypeId: 1, label: 'Adult', unitAmountCents: 2500, quantity: 1 }, { ticketTypeId: 2, label: 'Child', unitAmountCents: 1000, quantity: 2 }],
        });
        expect(registrationPricing({ price_cents: 1500 }, [], [{}, {}])).toEqual({ amountCents: 3000, lines: [{ ticketTypeId: null, label: null, unitAmountCents: 1500, quantity: 2 }] });
        expect(registrationPricing({ price_cents: null }, [{ id: 3, active: 0, price_cents: 1, label: 'Off' }], [{}])).toEqual({ amountCents: 0, lines: [{ ticketTypeId: null, label: null, unitAmountCents: 0, quantity: 1 }] });
      });
    });

    // ── Templates and clone ────────────────────────────────────────────────────
    describe('templates', () => {
      const fullEvent = async () => {
        const id = await newEvent({ capacity: 40, price_cents: backend === 'd1' ? null : 1500 });
        await mustSave(id, {
          questions: [
            { key: 'size', type: 'select', labels: { en: 'Size', zh: '尺寸' }, help: { en: 'Pick' }, options: [{ key: 's', labels: { en: 'Small', zh: '小' } }, { key: 'l', labels: { en: 'Large' } }] },
            { type: 'text', scope: 'attendee', max_length: 30, labels: { en: 'Why large?' }, condition: { q: 'size', op: 'eq', value: 'l' } },
          ],
          tickets: [{ ...adults, capacity: 20 }, { ...kids, active: false }],
        });
        return id;
      };

      it('saveAsTemplate copies the whole model into an inactive template that never appears publicly', async () => {
        const id = await fullEvent();
        const templateId = await saveAsTemplate(getDb(), id);
        expect(templateId).not.toBe(id);
        const template = (await getEventAdmin(getDb(), templateId))!;
        expect([template.is_template, template.active, template.next_confirmation]).toEqual([1, 0, 1]);
        expect((await getEventAdmin(getDb(), id))!.is_template).toBe(0);
        expect((await listTemplatesAdmin(getDb())).map((t) => t.id)).toContain(templateId);
        expect((await listEventsAdmin(getDb())).map((e) => e.id)).not.toContain(templateId);
        expect((await listEventsAdmin(getDb())).map((e) => e.id)).toContain(id);
        expect((await listAllEvents(getDb(), 'en')).map((e) => e.id)).not.toContain(templateId);
        // copy is complete
        const [size, why] = await listQuestions(getDb(), 'zh', templateId);
        expect([size.label, size.help, size.options, size.option_labels]).toEqual(['尺寸', 'Pick', ['s', 'l'], { s: '小', l: 'Large' }]);
        expect(why).toMatchObject({ scope: 'attendee', max_length: 30, condition: { q: size.id, op: 'eq', value: 'l' } });
        const types = await listTicketTypes(getDb(), 'en', templateId);
        expect(types.map((t) => [t.label, t.capacity, t.active])).toEqual([['Adult', 20, 1], ['Child', null, 0]]);
        // the original is untouched
        expect((await listQuestions(getDb(), 'en', id)).map((q) => q.label)).toEqual(['Size', 'Why large?']);
        // a template cannot be saved as a template
        await expect(saveAsTemplate(getDb(), templateId)).rejects.toThrow('event_not_found');
      });

      it('is excluded from every public reader, the open writer, lifecycle actions and group pickers', async () => {
        const id = await fullEvent();
        const templateId = await saveAsTemplate(getDb(), id);
        // force the worst case: an active, open template (an editor could set these fields)
        await getDb().prepare(`UPDATE reg_events SET active = 1 WHERE id = ?1`).bind(templateId).run();
        expect((await listOpenEvents(getDb(), 'en')).map((e) => e.id)).not.toContain(templateId);
        expect(await getOpenEvent(getDb(), 'en', templateId)).toBeNull();
        expect((await listPublicEvents(getDb(), 'en')).map((e) => e.id)).not.toContain(templateId);
        expect(await getPublicEvent(getDb(), 'en', templateId)).toBeNull();
        await expect(register(templateId, [{ name: 'Ada' }])).rejects.toThrow('event_not_found');
        await expect(setEventLifecycle(getDb(), templateId, 'open_now')).rejects.toThrow('template_not_allowed');
        await expect(setEventLifecycle(getDb(), templateId, 'show')).rejects.toThrow('template_not_allowed');
        expect(await count(`SELECT count(*) AS n FROM registrations WHERE event_id = ?1`, templateId)).toBe(0);
        const group = (await getDb().prepare(`INSERT INTO groups (name) VALUES ('Template group') RETURNING id`).first<{ id: number }>())!;
        expect((await listLinkableEvents(getDb(), group.id)).map((e) => e.id)).not.toContain(templateId);
        await getDb().prepare(`INSERT INTO group_reg_events (group_id, reg_event_id) VALUES (?1, ?2)`).bind(group.id, templateId).run();
        expect((await listOpenSpecialEventsForGroup(getDb(), group.id, 'en')).map((e) => e.id)).not.toContain(templateId);
        // the visible original still shows
        expect((await listPublicEvents(getDb(), 'en')).map((e) => e.id)).toContain(id);
        // even a registration row somehow attached to a template never shows in "my events"
        await getDb().prepare(`INSERT INTO registrations (event_id, name, email, status, submission_key) VALUES (?1, 'T', 'tpl-owner@example.com', 'confirmed', ?2)`).bind(templateId, key()).run();
        await getDb().prepare(`INSERT INTO registrations (event_id, name, email, status, submission_key) VALUES (?1, 'T', 'tpl-owner@example.com', 'confirmed', ?2)`).bind(id, key()).run();
        expect((await listRegistrationsForPerson(getDb(), 'en', 987654, 'tpl-owner@example.com')).map((r) => r.event_id)).toEqual([id]);
      });

      it('createFromTemplate makes a regular inactive event with everything copied; only a template qualifies', async () => {
        const id = await fullEvent();
        const templateId = await saveAsTemplate(getDb(), id);
        const fresh = await createFromTemplate(getDb(), templateId);
        const event = (await getEventAdmin(getDb(), fresh))!;
        expect([event.is_template, event.active, event.capacity, event.next_confirmation]).toEqual([0, 0, 40, 1]);
        expect((await listEventsAdmin(getDb())).map((e) => e.id)).toContain(fresh);
        const [size, why] = await listQuestions(getDb(), 'en', fresh);
        expect(why.condition).toEqual({ q: size.id, op: 'eq', value: 'l' });
        expect((await listTicketTypes(getDb(), 'en', fresh)).map((t) => t.label)).toEqual(['Adult', 'Child']);
        await expect(createFromTemplate(getDb(), id)).rejects.toThrow('template_not_found');
        await expect(createFromTemplate(getDb(), 987654321)).rejects.toThrow('template_not_found');
        // question ids are the copy's own
        const original = await listQuestions(getDb(), 'en', id);
        expect(original.map((q) => q.id)).not.toEqual([size.id, why.id]);
      });

      it('deleteTemplate deletes only templates (and cascades); regular events stay', async () => {
        const id = await fullEvent();
        const templateId = await saveAsTemplate(getDb(), id);
        expect(await deleteTemplate(getDb(), id)).toBe(false);
        expect(await getEventAdmin(getDb(), id)).not.toBeNull();
        expect(await deleteTemplate(getDb(), templateId)).toBe(true);
        expect(await getEventAdmin(getDb(), templateId)).toBeNull();
        expect(await count(`SELECT count(*) AS n FROM reg_questions WHERE event_id = ?1`, templateId)).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM reg_ticket_types WHERE event_id = ?1`, templateId)).toBe(0);
        expect(await deleteTemplate(getDb(), templateId)).toBe(false);
      });

      it('cloneEvent copies ticket types and the v2 question model (conditions remapped, sorts renumbered)', async () => {
        const id = await fullEvent();
        const copy = await cloneEvent(getDb(), id);
        const [size, why] = await listQuestions(getDb(), 'en', copy);
        const [origSize] = await listQuestions(getDb(), 'en', id);
        expect(size.id).not.toBe(origSize.id);
        expect(why).toMatchObject({ scope: 'attendee', max_length: 30, condition: { q: size.id, op: 'eq', value: 'l' } });
        expect(size.option_labels).toEqual({ s: 'Small', l: 'Large' });
        expect((await listTicketTypes(getDb(), 'en', copy)).map((t) => [t.label, t.capacity, t.active, t.taken])).toEqual([['Adult', 20, 1, 0], ['Child', null, 0, 0]]);
        expect((await getEventAdmin(getDb(), copy))!.is_template).toBe(0);
      });
    });

    // ── Summary v2 and self-service ────────────────────────────────────────────
    describe('summary v2 and self-service', () => {
      const setup = async () => {
        const id = await newEvent();
        await mustSave(id, {
          questions: [
            { type: 'section', labels: { en: 'Group' } },
            { key: 'meal', type: 'select', labels: { en: 'Meal', zh: '餐食' }, options: [{ key: 'veg', labels: { en: 'Vegetarian', zh: '素食' } }, { key: 'meat', labels: { en: 'Meat' } }] },
            { type: 'checkbox', labels: { en: 'Allergies', zh: '过敏' }, options: [{ key: 'nuts', labels: { en: 'Nuts', zh: '坚果' } }, { key: 'dairy', labels: { en: 'Dairy', zh: '乳制品' } }] },
            { type: 'terms', required: true, labels: { en: 'Agree' } },
            { type: 'text', scope: 'attendee', labels: { en: 'Shirt', zh: '衬衫' } },
            { key: 'sick', type: 'yesno', scope: 'attendee', labels: { en: 'Unwell?' } },
            { type: 'text', scope: 'attendee', labels: { en: 'Details' }, condition: { q: 'sick', op: 'checked' } },
          ],
          tickets: [{ ...adults, capacity: 5 }, kids],
        });
        const qs = await listQuestions(getDb(), 'en', id);
        const by = (label: string) => qs.find((q) => q.label === label)!;
        const [adult, child] = await ticketIds(id);
        const r = await register(id, [
          { name: 'Ada', ticketTypeId: adult, answers: [[by('Shirt').id, 'M']] },
          { name: 'Bo', ticketTypeId: child, answers: [[by('Shirt').id, 'S'], [by('Unwell?').id, 'yes'], [by('Details').id, 'cough']] },
        ], { answers: [[by('Meal').id, 'veg'], [by('Allergies').id, JSON.stringify(['nuts', 'dairy'])], [by('Agree').id, TERMS_ACCEPTED]] });
        return { id, qs, by, r, adult, child };
      };

      it('shows per-person answers, ticket type labels and option labels in the requested language, skipping sections', async () => {
        const { by, r, adult, child } = await setup();
        const zh = (await registrationSummary(getDb(), r.id, 'zh'))!;
        expect(zh.answers.map((a) => [a.label, a.value.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, 'TIME')])).toEqual([
          ['餐食', '素食'], ['过敏', '坚果, 乳制品'], ['Agree', 'TIME'],
        ]);
        expect(zh.attendees.map((a) => [a.name, a.ticket_type_id, a.ticket_label])).toEqual([['Ada', adult, '成人'], ['Bo', child, '儿童']]);
        expect(zh.attendees[1].answers.map((a) => [a.label, a.value])).toEqual([['衬衫', 'S'], ['Unwell?', 'yes'], ['Details', 'cough']]);
        expect(zh.attendees[0].answers.map((a) => a.question_id)).toEqual([by('Shirt').id]);
        const en = (await registrationSummary(getDb(), r.id, 'en'))!;
        expect(en.answers[0]).toMatchObject({ label: 'Meal', value: 'Vegetarian' });
        expect(en.answers[1].value).toBe('Nuts, Dairy');
        expect(en.attendees.map((a) => a.ticket_price_cents)).toEqual([0, 0]);
      });

      it('a legacy answer (the option string stored as the key) still displays with its migrated label', async () => {
        const id = await newEvent();
        await saveQuestions(getDb(), id, [{ sort: 0, type: 'select', required: 0, options: ['Small', 'Large (XL)'], labels: { en: 'Size', zh: '尺寸' } }]);
        const [q] = await listQuestions(getDb(), 'en', id);
        // the migration copies each option string into option_labels per language row
        await getDb().prepare(`UPDATE reg_question_i18n SET option_labels = ?2 WHERE question_id = ?1 AND locale = 'en'`).bind(q.id, JSON.stringify({ Small: 'Small', 'Large (XL)': 'Large (XL)' })).run();
        const r = await register(id, [{ name: 'Ada' }], { answers: [[q.id, 'Large (XL)']] });
        const summary = (await registrationSummary(getDb(), r.id, 'zh'))!;
        expect(summary.answers).toEqual([{ question_id: q.id, label: '尺寸', value: 'Large (XL)' }]);
      });

      it('self-edit replaces per-registration and per-person answers under the same rules; the ticket type is read-only', async () => {
        const { by, r, adult, child } = await setup();
        const before = (await registrationSummary(getDb(), r.id, 'en'))!;
        const [ada, bo] = before.attendees;
        const result = await updateRegistrationSelf(getDb(), r.id, {
          answers: { [String(by('Meal').id)]: 'meat', [String(by('Agree').id)]: 'on' },
          attendees: [
            { id: ada.id, answers: { [String(by('Shirt').id)]: 'XL' } },
            { id: bo.id, name: 'Bobby', answers: { [String(by('Shirt').id)]: 'M', [String(by('Unwell?').id)]: 'no', [String(by('Details').id)]: 'stale, hidden now' } },
          ],
        });
        expect(result).toEqual({ ok: true });
        const after = (await registrationSummary(getDb(), r.id, 'en'))!;
        expect(after.answers.map((a) => [a.label, a.value.length > 5 ? a.value : a.value])).toEqual([['Meal', 'Meat'], ['Agree', before.answers[2].value]]);
        expect(after.attendees.map((a) => [a.name, a.ticket_type_id])).toEqual([['Ada', adult], ['Bobby', child]]);
        expect(after.attendees[0].answers.map((a) => a.value)).toEqual(['XL']);
        // Details is hidden once "Unwell?" is no: its value is dropped
        expect(after.attendees[1].answers.map((a) => [a.label, a.value])).toEqual([['Shirt', 'M'], ['Unwell?', 'no']]);
      });

      it('self-edit keeps the original terms acceptance time and validates per-person answers with field paths', async () => {
        const { by, r } = await setup();
        const first = (await registrationSummary(getDb(), r.id, 'en'))!;
        const acceptedAt = first.answers.find((a) => a.label === 'Agree')!.value;
        expect(acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        // simulate an acceptance in the past: the edit must not move it
        const past = '2020-01-02 03:04:05';
        await getDb().prepare(`UPDATE reg_answers SET value = ?2 WHERE registration_id = ?1 AND question_id = ?3`).bind(r.id, past, by('Agree').id).run();
        expect(await updateRegistrationSelf(getDb(), r.id, { answers: { [String(by('Meal').id)]: 'veg', [String(by('Agree').id)]: 'on' } })).toEqual({ ok: true });
        expect((await registrationSummary(getDb(), r.id, 'en'))!.answers.find((a) => a.label === 'Agree')!.value).toBe(past);
        // unchecking a required terms box is refused
        const refused = await updateRegistrationSelf(getDb(), r.id, { answers: { [String(by('Meal').id)]: 'veg' } });
        expect(refused).toEqual({ ok: false, errors: [{ path: `q.${by('Agree').id}`, code: 'missing_required' }] });
        // per-person: a bad value comes back under attendees.<index>.q.<id>
        const bad = await updateRegistrationSelf(getDb(), r.id, { attendees: [{ id: first.attendees[1].id, answers: { [String(by('Unwell?').id)]: 'maybe' } }] });
        expect(bad).toEqual({ ok: false, errors: [{ path: `attendees.0.q.${by('Unwell?').id}`, code: 'bad_answer' }] });
        // an attendee that is not on this registration is refused
        expect(await updateRegistrationSelf(getDb(), r.id, { attendees: [{ id: 99999999, answers: {} }] })).toEqual({ ok: false, errors: [{ path: 'attendees.0.id', code: 'not_found' }] });
      });
    });
  });
}
