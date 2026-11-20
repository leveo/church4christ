// The registration form builder's save endpoint (saveFormRequest) against D1: a valid island payload
// (a per-person question with a show-if condition on a not-yet-saved question, and a ticket type), the
// stored rows that come back for the island, validation errors by field path, and malformed bodies.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { saveFormRequest } from '../src/lib/regFormSave';
import { listQuestionsAdmin, saveEvent } from '../src/lib/regDb';
import { buildPayload, newQuestion, newTicket, toDrafts } from '../src/components/regBuilder/model';

const opts = { backend: 'd1' as const, defaultLocale: 'en' as const };
const L = ['en', 'zh'];
const newEvent = () => saveEvent(env.DB, { titles: { en: { title: 'Camp' } }, starts_at: '2031-05-01 10:00:00', active: 1 });

describe('saveFormRequest', () => {
  it('saves what the island builds and returns the stored questions and tickets', async () => {
    const id = await newEvent();
    const childcare = { ...newQuestion('yesno', L), labels: { en: 'Need childcare?', zh: '需要托儿吗？' } };
    const age = { ...newQuestion('number', L), scope: 'attendee' as const, required: true, labels: { en: 'Child age', zh: '' }, condition: { q: childcare.cid, op: 'eq' as const, value: 'yes', values: [] } };
    const adult = { ...newTicket(L), labels: { en: 'Adult', zh: '成人' }, capacity: '40' };
    const body = JSON.stringify(buildPayload({ questions: [childcare, age], tickets: [adult] }, L));
    const res = await saveFormRequest(env.DB, id, body, opts);
    expect(res.status).toBe(200);
    if (!res.body.ok) throw new Error('expected ok');
    expect(res.body.questions.map((q) => [q.type, q.scope, q.required])).toEqual([['yesno', 'registration', 0], ['number', 'attendee', 1]]);
    expect(res.body.questions[1].condition).toEqual({ q: res.body.questions[0].id, op: 'eq', value: 'yes' });
    expect(res.body.tickets).toMatchObject([{ price_cents: 0, capacity: 40, active: 1, labels: { en: 'Adult', zh: '成人' } }]);

    // the response round-trips into drafts and back into an identical save
    const draft = toDrafts(res.body.questions, res.body.tickets, L);
    const again = await saveFormRequest(env.DB, id, JSON.stringify(buildPayload(draft, L)), opts);
    expect(again.status).toBe(200);
    expect((await listQuestionsAdmin(env.DB, id)).map((q) => q.id)).toEqual(res.body.questions.map((q) => q.id));
  });

  it('answers 422 with field paths and writes nothing', async () => {
    const id = await newEvent();
    const first = { ...newQuestion('text', L), labels: { en: 'Keep', zh: '' } };
    await saveFormRequest(env.DB, id, JSON.stringify(buildPayload({ questions: [first], tickets: [] }, L)), opts);
    const paid = { ...newTicket(L), labels: { en: 'VIP', zh: '' }, price: '5' };
    const bad = { ...newQuestion('select', L), labels: { en: '', zh: '' } };
    const res = await saveFormRequest(env.DB, id, JSON.stringify(buildPayload({ questions: [bad], tickets: [paid] }, L)), opts);
    expect(res.status).toBe(422);
    if (res.body.ok) throw new Error('expected errors');
    expect(res.body.errors?.map((e) => `${e.path}:${e.code}`)).toEqual([
      'questions.0.labels.en:required',
      'questions.0.options.0.labels.en:required',
      'questions.0.options.1.labels.en:required',
      'tickets.0.price_cents:paid_unavailable',
    ]);
    expect((await listQuestionsAdmin(env.DB, id)).map((q) => q.labels.en)).toEqual(['Keep']);
  });

  it('refuses a malformed body, a non-object payload and an unknown event', async () => {
    const id = await newEvent();
    expect(await saveFormRequest(env.DB, id, '{nope', opts)).toEqual({ status: 400, body: { ok: false, error: 'bad_request' } });
    expect((await saveFormRequest(env.DB, id, '[]', opts)).status).toBe(400);
    expect((await saveFormRequest(env.DB, id, 'null', opts)).status).toBe(400);
    expect(await saveFormRequest(env.DB, 987654, '{"questions":[]}', opts)).toEqual({ status: 404, body: { ok: false, error: 'not_found' } });
  });

  it('works on a template and reports a protected ticket type as delete_in_use', async () => {
    const id = await newEvent();
    await env.DB.prepare(`UPDATE reg_events SET is_template = 1 WHERE id = ?1`).bind(id).run();
    const tk = { ...newTicket(L), labels: { en: 'Free', zh: '' } };
    const saved = await saveFormRequest(env.DB, id, JSON.stringify(buildPayload({ questions: [], tickets: [tk] }, L)), opts);
    expect(saved.status).toBe(200);
    if (!saved.body.ok) throw new Error('expected ok');
    const reg = await env.DB.prepare(`INSERT INTO registrations (event_id, name, email, submission_key) VALUES (?1, 'A', 'a@example.com', 'save-form-a') RETURNING id`).bind(id).first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO reg_attendees (registration_id, name, ticket_type_id) VALUES (?1, 'A', ?2)`).bind(reg!.id, saved.body.tickets[0].id).run();
    const res = await saveFormRequest(env.DB, id, JSON.stringify({ tickets: [] }), opts);
    expect(res.status).toBe(422);
    if (!res.body.ok) expect(res.body.errors).toEqual([{ path: 'tickets', code: 'delete_in_use' }]);
  });
});
