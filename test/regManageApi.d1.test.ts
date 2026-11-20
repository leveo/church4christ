// The private registration manage API on D1: the token is the only credential, one uniform
// 404 for any bad token, the summary carries no token or hash, updates re-validate, a cancel
// tells notifyAfterRelease who left (the person's name only when the registration goes on),
// and the endpoint is rate limited per address.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createManageHandler } from '../src/pages/api/register/manage';
import { createRegistration, listQuestions, listTicketTypes, saveEvent, saveEventForm, saveQuestions } from '../src/lib/regDb';
import { findRegistrationByToken, issueManageToken } from '../src/lib/regManage';
import { buildRegistrationView, performManageAction } from '../src/lib/regManageApi';

const DAY = 24 * 3600_000;
const ts = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
let seq = 0;

const notify = vi.fn(async (..._args: unknown[]) => {});
const makeHandler = (over: { limit?: number; secret?: string | undefined } = {}) =>
  createManageHandler(() => ({
    secret: 'secret' in over ? over.secret : 'manage-api-test-secret-0123456789abcdef',
    notifyEnv: { APP_ORIGIN: 'https://church.example' },
    findByToken: findRegistrationByToken,
    perform: performManageAction,
    notify: notify as never,
    limit: over.limit ?? 1000,
  }));

type Reply = Omit<Response, 'json'> & { json(): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(body: unknown, opts: { handler?: ReturnType<typeof makeHandler>; ip?: string } = {}): Promise<Reply> {
  const handler = opts.handler ?? makeHandler();
  return handler({
    request: new Request('https://church.example/api/register/manage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.ip ? { 'cf-connecting-ip': opts.ip } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    locals: { modules: new Set(['registration']), db: env.DB, dbBackend: 'd1', locale: 'en' },
  } as never);
}

async function newEvent(over: Partial<Parameters<typeof saveEvent>[1]> = {}) {
  const eventId = await saveEvent(env.DB, {
    title_en: 'Family Picnic',
    title_zh: '家庭野餐',
    starts_at: ts(10 * DAY),
    active: 1,
    max_party_size: 4,
    titles: { en: { title: 'Family Picnic', notes: 'Bring a blanket.' } },
    ...over,
  });
  await saveQuestions(env.DB, eventId, [
    { sort: 0, type: 'text', required: 1, options: null, labels: { en: 'What will you bring?' } },
  ]);
  const question = await env.DB.prepare(`SELECT id FROM reg_questions WHERE event_id = ?1`).bind(eventId).first<number>('id');
  return { eventId, questionId: question! };
}

const register = (eventId: number, questionId: number, over: Partial<Parameters<typeof createRegistration>[1]> = {}) =>
  createRegistration(env.DB, {
    eventId,
    personId: null,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    status: 'confirmed',
    amountCents: 0,
    currency: 'usd',
    answers: [[questionId, 'Salad']],
    attendees: [{ name: 'Ada Lovelace' }, { name: 'Byron' }, { name: 'Anne' }],
    phone: '555 0100',
    locale: 'en',
    submissionKey: `manage-api-${Date.now()}-${++seq}`,
    ...over,
  });

beforeEach(async () => {
  notify.mockClear();
  await env.DB.prepare(`DELETE FROM newcomer_rate_limits`).run();
});

describe('manage API: authorization', () => {
  it('returns the summary for the right token and never echoes the token or its hash', async () => {
    const { eventId, questionId } = await newEvent();
    const created = await register(eventId, questionId);
    const res = await call({ token: created.manageToken, action: 'view' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const text = await res.text();
    expect(text).not.toContain(created.manageToken!);
    const hash = await env.DB.prepare(`SELECT manage_token_hash AS h FROM registrations WHERE id = ?1`).bind(created.id).first<string>('h');
    expect(text).not.toContain(hash!);
    const body = JSON.parse(text);
    expect(body.ok).toBe(true);
    expect(body.view.event).toMatchObject({ title: 'Family Picnic', notes: 'Bring a blanket.' });
    expect(body.view.registration).toMatchObject({ confirmationNo: created.confirmationNo, status: 'confirmed', partySize: 3, phone: '555 0100' });
    expect(body.view.attendees.map((a: { name: string }) => a.name)).toEqual(['Ada Lovelace', 'Byron', 'Anne']);
    expect(body.view.canEdit).toBe(true);
    expect(body.view.canCancel).toBe(true);
    expect(body.view.questions[0]).toMatchObject({ label: 'What will you bring?', value: ['Salad'] });
    expect(body.view.qrUrl).toBe(`/register/qr/${eventId}/${created.confirmationNo}.png?campus=main`);
  });

  it('answers a wrong, garbled, missing or replaced token with the same bare 404', async () => {
    const { eventId, questionId } = await newEvent();
    const created = await register(eventId, questionId);
    const replaced = await issueManageToken(env.DB, created.id);
    expect(replaced).not.toBe(created.manageToken);
    const bodies: string[] = [];
    for (const token of ['A'.repeat(43), 'short', created.manageToken, undefined, 12345]) {
      const res = await call({ token, action: 'view' });
      expect(res.status).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies)).toEqual(new Set(['{"error":"not_found"}']));
    // The replacement works.
    expect((await call({ token: replaced, action: 'view' })).status).toBe(200);
  });

  it('rejects an unreadable or non-object body', async () => {
    expect((await call('not json')).status).toBe(400);
    expect((await call('[1,2]')).status).toBe(400);
    expect((await call({ token: 'A'.repeat(43), action: 'explode' })).status).toBe(404); // unknown token first: no oracle on actions
  });

  it('404s when the registration module is off', async () => {
    const res = await makeHandler()({
      request: new Request('https://church.example/api/register/manage', { method: 'POST', body: '{}' }),
      locals: { modules: new Set(), db: env.DB, dbBackend: 'd1', locale: 'en' },
    } as never);
    expect(res.status).toBe(404);
  });
});

describe('manage API: rate limit', () => {
  it('limits each address, keeps others working, and fails closed without a secret', async () => {
    const handler = makeHandler({ limit: 2 });
    const send = (ip: string) => call({ token: 'A'.repeat(43), action: 'view' }, { handler, ip });
    expect((await send('203.0.113.7')).status).toBe(404);
    expect((await send('203.0.113.7')).status).toBe(404);
    const limited = await send('203.0.113.7');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect((await send('203.0.113.8')).status).toBe(404);

    const unconfigured = await call({ token: 'A'.repeat(43), action: 'view' }, { handler: makeHandler({ secret: undefined }) });
    expect(unconfigured.status).toBe(503);
  });
});

describe('manage API: edits and cancellations', () => {
  it('updates the contact, people and answers, and reports every validation problem', async () => {
    const { eventId, questionId } = await newEvent();
    const created = await register(eventId, questionId);
    const view = await (await call({ token: created.manageToken, action: 'view' })).json();
    const [ada, byron] = view.view.attendees;

    const bad = await call({
      token: created.manageToken,
      action: 'update',
      fields: { name: [''], phone: ['call me'], [`attendee_${ada.id}`]: ['Ada'], [`attendee_${byron.id}`]: [''], [`a_${questionId}`]: [''] },
    });
    expect(bad.status).toBe(422);
    const failed = await bad.json();
    expect(failed.errors.map((e: { path: string }) => e.path).sort()).toEqual(['attendees.1.name', 'contact.name', 'contact.phone', `q.${questionId}`].sort());
    expect(JSON.stringify(failed)).not.toContain(created.manageToken!);

    const ok = await call({
      token: created.manageToken,
      action: 'update',
      fields: { name: ['Ada L.'], phone: ['555 0199'], [`attendee_${ada.id}`]: ['Ada L.'], [`attendee_${byron.id}`]: ['Lord Byron'], [`a_${questionId}`]: ['Pie'] },
    });
    expect(ok.status).toBe(200);
    const updated = await ok.json();
    expect(updated.notice).toBe('saved');
    expect(updated.view.registration).toMatchObject({ name: 'Ada L.', phone: '555 0199', email: 'ada@example.com' });
    expect(updated.view.attendees.map((a: { name: string }) => a.name)).toEqual(['Ada L.', 'Lord Byron', 'Anne']);
    expect(updated.view.questions[0].value).toEqual(['Pie']);
  });

  it('cancels one person and tells notifyAfterRelease their name; the last person is a plain cancellation', async () => {
    const { eventId, questionId } = await newEvent();
    const created = await register(eventId, questionId, { attendees: [{ name: 'Ada' }, { name: 'Byron' }] });
    const first = await (await call({ token: created.manageToken, action: 'view' })).json();
    const [ada, byron] = first.view.attendees;

    const one = await call({ token: created.manageToken, action: 'cancel_attendee', attendee_id: byron.id });
    expect(one.status).toBe(200);
    expect(notify).toHaveBeenCalledWith(expect.anything(), expect.anything(), { cancelledId: created.id, attendeeName: 'Byron', promoted: [] });
    const afterOne = await one.json();
    expect(afterOne.view.registration.partySize).toBe(1);
    expect(afterOne.view.attendees.find((a: { id: number }) => a.id === byron.id).active).toBe(false);
    expect(afterOne.view.canCancel).toBe(true);

    notify.mockClear();
    const last = await call({ token: created.manageToken, action: 'cancel_attendee', attendee_id: ada.id });
    expect((await last.json()).view.registration.status).toBe('cancelled');
    expect(notify.mock.calls[0][2]).toEqual({ cancelledId: created.id, promoted: [] }); // no attendeeName key at all

    // A cancelled registration stays viewable but nothing more can change.
    const again = await call({ token: created.manageToken, action: 'cancel_all' });
    expect(again.status).toBe(409);
  });

  it('cancels everyone, promotes a waitlisted party that fits, and names the promoted registration', async () => {
    const { eventId, questionId } = await newEvent({ capacity: 3 });
    const first = await register(eventId, questionId);
    const waitlisted = await register(eventId, questionId, { name: 'Wanda', email: 'wanda@example.com', attendees: [{ name: 'Wanda' }, { name: 'Walt' }] });
    expect(waitlisted.status).toBe('waitlist');

    const res = await call({ token: first.manageToken, action: 'cancel_all' });
    expect(res.status).toBe(200);
    expect(notify).toHaveBeenCalledWith(expect.anything(), expect.anything(), { cancelledId: first.id, promoted: [waitlisted.id] });
    const status = await env.DB.prepare(`SELECT status FROM registrations WHERE id = ?1`).bind(waitlisted.id).first<string>('status');
    expect(status).toBe('confirmed');
  });

  it('refuses edits and cancels once the event is closed or self-service is off', async () => {
    const { eventId, questionId } = await newEvent();
    const created = await register(eventId, questionId);
    await env.DB.prepare(`UPDATE reg_events SET allow_self_edit = 0 WHERE id = ?1`).bind(eventId).run();
    const view = await (await call({ token: created.manageToken, action: 'view' })).json();
    expect(view.view.canEdit).toBe(false);
    expect(view.view.canCancel).toBe(false);
    expect(view.view.questions).toEqual([]);
    const denied = await call({ token: created.manageToken, action: 'update', fields: { name: ['Nope'] } });
    expect(denied.status).toBe(409);
    expect((await call({ token: created.manageToken, action: 'cancel_all' })).status).toBe(409);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('manage API: calendar file', () => {
  it('returns the event as a downloadable .ics from a POST, not a token URL', async () => {
    const { eventId, questionId } = await newEvent();
    const created = await register(eventId, questionId);
    const res = await call({ token: created.manageToken, action: 'ics' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const text = await res.text();
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).toContain(`UID:registration-${created.id}@church.example`);
    expect(text).not.toContain(created.manageToken!);
  });
});


describe('manage view and edit with ticket types and per-person answers', () => {
  async function typedEvent() {
    const eventId = await saveEvent(env.DB, { title_en: 'Family Camp', title_zh: '家庭营', starts_at: ts(10 * DAY), active: 1, max_party_size: 4 });
    expect(await saveEventForm(env.DB, eventId, {
      questions: [
        { key: 'meal', type: 'select', scope: 'attendee', required: true, labels: { en: 'Meal' }, options: [{ key: 'veg', labels: { en: 'Vegan' } }, { key: 'any', labels: { en: 'Anything' } }] },
        { type: 'text', scope: 'attendee', labels: { en: 'Notes' }, condition: { q: 'meal', op: 'eq', value: 'veg' } },
      ],
      tickets: [{ labels: { en: 'Adult' }, price_cents: 0 }, { labels: { en: 'Child' }, price_cents: 0, capacity: 1 }],
    }, { backend: 'd1' })).toEqual({ ok: true });
    const [meal, notes] = await listQuestions(env.DB, 'en', eventId);
    const [adult, child] = await listTicketTypes(env.DB, 'en', eventId);
    const created = await createRegistration(env.DB, {
      eventId, personId: null, name: 'Ada', email: 'ada@example.com', status: 'confirmed', amountCents: 0, currency: 'usd', answers: [],
      attendees: [
        { name: 'Ada', ticketTypeId: adult.id, answers: [[meal.id, 'veg'], [notes.id, 'no nuts']] },
        { name: 'Mia', ticketTypeId: child.id, answers: [[meal.id, 'any']] },
      ],
      submissionKey: `manage-typed-${Date.now()}-${++seq}`, locale: 'en',
    });
    return { eventId, meal, notes, adult, child, registrationId: created.id };
  }

  it('shows each person\'s ticket type and answers (as labels) and offers the per-person questions for editing', async () => {
    const { registrationId, meal } = await typedEvent();
    const view = (await buildRegistrationView(env.DB, registrationId, 'en'))!;
    expect(view.attendees.map((a) => [a.name, a.ticketText, a.answers?.map((x) => `${x.label}=${x.value}`)])).toEqual([
      ['Ada', 'Adult', ['Meal=Vegan', 'Notes=no nuts']],
      ['Mia', 'Child', ['Meal=Anything']],
    ]);
    expect(view.personQuestions?.map((q) => q.label)).toEqual(['Meal', 'Notes']);
    expect(view.attendees[0].values).toEqual({ [String(meal.id)]: ['veg'], [String(view.personQuestions![1].id)]: ['no nuts'] });
  });

  it('saves edited per-person answers by attendee id, drops a hidden one, and never changes the ticket type', async () => {
    const { registrationId, meal, notes, child } = await typedEvent();
    const view = (await buildRegistrationView(env.DB, registrationId, 'en'))!;
    const [ada, mia] = view.attendees;
    const ref = { id: registrationId } as never;
    const outcome = await performManageAction(env.DB, ref, 'en', {
      action: 'update',
      fields: {
        name: ['Ada'], [`attendee_${ada.id}`]: ['Ada'], [`attendee_${mia.id}`]: ['Mia'],
        [`pa_${ada.id}`]: ['1'], [`pa_${ada.id}_${meal.id}`]: ['any'], [`pa_${ada.id}_${notes.id}`]: ['stale'],
        [`pa_${mia.id}`]: ['1'], [`pa_${mia.id}_${meal.id}`]: ['veg'], [`pa_${mia.id}_${notes.id}`]: ['likes soup'],
        ticket_0: [String(child.id)], // never read
      },
    }, notify);
    expect(outcome.kind).toBe('view');
    const after = (await buildRegistrationView(env.DB, registrationId, 'en'))!;
    expect(after.attendees.map((a) => [a.name, a.ticketText, a.answers?.map((x) => `${x.label}=${x.value}`)])).toEqual([
      ['Ada', 'Adult', ['Meal=Anything']], // Notes is only asked of people who eat vegan
      ['Mia', 'Child', ['Meal=Vegan', 'Notes=likes soup']],
    ]);
  });

  it('reports a missing required per-person answer under that person (by position)', async () => {
    const { registrationId, meal } = await typedEvent();
    const view = (await buildRegistrationView(env.DB, registrationId, 'en'))!;
    const [ada, mia] = view.attendees;
    const outcome = await performManageAction(env.DB, { id: registrationId } as never, 'en', {
      action: 'update',
      fields: { name: ['Ada'], [`attendee_${ada.id}`]: ['Ada'], [`attendee_${mia.id}`]: ['Mia'], [`pa_${ada.id}`]: ['1'], [`pa_${mia.id}`]: ['1'], [`pa_${ada.id}_${meal.id}`]: ['any'] },
    }, notify);
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind === 'invalid') expect(outcome.errors).toEqual([{ path: `attendees.1.q.${meal.id}`, code: 'missing_required' }]);
  });

  it('frees the seat of that person\'s ticket type when they cannot come', async () => {
    const { eventId, registrationId, child } = await typedEvent();
    expect((await listTicketTypes(env.DB, 'en', eventId)).find((t) => t.id === child.id)!.seats_left).toBe(0);
    const view = (await buildRegistrationView(env.DB, registrationId, 'en'))!;
    const outcome = await performManageAction(env.DB, { id: registrationId } as never, 'en', { action: 'cancel_attendee', attendeeId: view.attendees[1].id }, notify);
    expect(outcome.kind).toBe('view');
    expect((await listTicketTypes(env.DB, 'en', eventId)).find((t) => t.id === child.id)!.seats_left).toBe(1);
  });
});
