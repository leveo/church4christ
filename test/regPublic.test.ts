// The public registration helpers: reading a posted form into the shared submission input,
// echoing the form's identity fields safely, mapping every validation code to copy, the
// party-versus-seats rule, and the redirect targets (the token only ever in the fragment).
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/en';
import {
  bagFromFormData,
  editFromBag,
  echoIntentId,
  echoSubmissionKey,
  fieldIdForPath,
  manageLanding,
  myEventLanding,
  replayLanding,
  partyFit,
  partyRowCount,
  seatsLeft,
  submissionErrorKey,
  submissionFromBag,
} from '../src/lib/regPublic';
import { validateSubmission } from '../src/lib/regManage';
import type { RegQuestion } from '../src/lib/regDb';

const questions: RegQuestion[] = [
  { id: 11, sort: 0, type: 'text', required: 1, options: null, label: 'Dish', scope: 'registration', condition: null, max_length: null, help: null, placeholder: null, option_labels: {} },
  { id: 12, sort: 1, type: 'checkbox', required: 0, options: ['a', 'b'], label: 'Allergies', scope: 'registration', condition: null, max_length: null, help: null, placeholder: null, option_labels: {} },
];

const formOf = (entries: Array<[string, string]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
};

describe('submissionFromBag', () => {
  it('reads the contact, the people rows (row 0 blank = the contact) and the answers by question id', () => {
    const bag = bagFromFormData(formOf([
      ['name', 'Ada'], ['email', 'ada@example.com'], ['phone', '555 0100'],
      ['person_name_1', 'Byron'], ['person_id_1', '7'], ['person_name_2', ''], ['person_id_2', 'x'],
      ['11', 'Salad'], ['12', 'a'], ['12', 'b'], ['person_name_9', 'ignored'],
    ]));
    const input = submissionFromBag(bag, questions, 3);
    expect(input.contact).toEqual({ name: 'Ada', email: 'ada@example.com', phone: '555 0100' });
    expect(input.attendees).toEqual([{ name: '' }, { name: 'Byron', personId: 7 }, { name: '', personId: null }]);
    expect(input.answers).toEqual({ '11': ['Salad'], '12': ['a', 'b'] });
    const result = validateSubmission({ max_party_size: 3 }, questions, input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.attendees.map((a) => a.name)).toEqual(['Ada', 'Byron']);
  });

  it('lets the signed-in account override the posted contact, and ignores rows past the event limit', () => {
    const bag = bagFromFormData(formOf([['name', 'Forged'], ['email', 'forged@example.com'], ['person_name_1', 'B'], ['person_name_2', 'C']]));
    const input = submissionFromBag(bag, [], 2, { name: 'Real', email: 'real@example.com' });
    expect(input.contact).toMatchObject({ name: 'Real', email: 'real@example.com' });
    expect(input.attendees).toHaveLength(2);
  });

  it('treats a missing or odd max party size as one person', () => {
    expect(partyRowCount(undefined)).toBe(1);
    expect(partyRowCount(0)).toBe(1);
    expect(partyRowCount(99)).toBe(20);
    expect(submissionFromBag({}, [], undefined as never).attendees).toHaveLength(1);
  });
});

describe('editFromBag', () => {
  it('collects names, phone, people by attendee id and the full answer set', () => {
    const edit = editFromBag({ name: ['Ada'], phone: [''], attendee_5: ['Ada'], attendee_6: ['Byron'], a_11: ['Pie'], a_12: ['a', 'b'], other: ['x'] });
    expect(edit).toEqual({ name: 'Ada', phone: '', attendees: [{ id: 5, name: 'Ada' }, { id: 6, name: 'Byron' }], answers: { '11': ['Pie'], '12': ['a', 'b'] } });
    expect(editFromBag({}).answers).toEqual({}); // an edit always carries an answer set
  });
});

describe('echoed identity fields', () => {
  it('keeps a well-formed key or id and replaces anything else', () => {
    expect(echoSubmissionKey('abcdefghij123456')).toBe('abcdefghij123456');
    for (const bad of ['', 'short', 'srv:abcdefghijklmnop', 'has space in it long enough']) expect(echoSubmissionKey(bad)).toMatch(/^[a-f0-9]{32}$/);
    const id = '00000000-0000-4000-8000-000000000901';
    expect(echoIntentId(id.toUpperCase())).toBe(id);
    expect(echoIntentId('nope')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('validation copy', () => {
  it('maps every code validateSubmission and the edit path can emit to a real dictionary key', () => {
    const codes = ['required', 'too_long', 'invalid', 'too_many', 'missing_required', 'bad_answer', 'not_found', 'not_allowed', 'no_room', 'something_new'];
    const paths = ['contact.name', 'contact.email', 'contact.phone', 'attendees', 'attendees.2.name', 'q.4', ''];
    for (const code of codes) for (const path of paths) expect(en).toHaveProperty([submissionErrorKey({ path, code })]);
    expect(submissionErrorKey({ path: 'contact.email', code: 'invalid' })).toBe('register.err.email');
    expect(submissionErrorKey({ path: 'contact.phone', code: 'invalid' })).toBe('register.err.phone');
  });

  it('points each path at the control to focus', () => {
    expect(fieldIdForPath('contact.name')).toBe('f-name');
    expect(fieldIdForPath('attendees.0.name')).toBe('f-name');
    expect(fieldIdForPath('attendees.2.name')).toBe('f-person-2');
    expect(fieldIdForPath('attendees')).toBe('f-party');
    expect(fieldIdForPath('q.14')).toBe('f-q-14');
    expect(fieldIdForPath('')).toBe('f-form');
  });
});

describe('party versus seats', () => {
  const free = { capacity: 5, taken_count: 3, price_cents: null, waitlist_enabled: 1 };
  it('fits, waitlists the whole party, or has no room', () => {
    expect(partyFit(free, 2)).toBe('fits');
    expect(partyFit(free, 3)).toBe('waitlist');
    expect(partyFit({ ...free, waitlist_enabled: 0 }, 3)).toBe('no_room');
    expect(partyFit({ ...free, price_cents: 2500 }, 3)).toBe('no_room');
    expect(partyFit({ ...free, capacity: null }, 20)).toBe('fits');
    expect(seatsLeft(free)).toBe(2);
    expect(seatsLeft({ capacity: null, taken_count: 9 })).toBeNull();
  });
});

describe('landing targets', () => {
  it('keeps the token in the fragment, never the query', () => {
    const url = manageLanding('en', 'T'.repeat(43));
    const parsed = new URL(url, 'https://church.example');
    expect(parsed.search).toBe('?new=1');
    expect(parsed.hash).toBe(`#t=${'T'.repeat(43)}`);
    expect(myEventLanding('zh', 12)).toBe('/zh/my/events/12?new=1');
    expect(myEventLanding('zh', undefined)).toBe('/zh/my/events');
  });

  it('sends a replay to the done page for its status when the Member Portal is off', () => {
    expect(replayLanding('en', 12, 'confirmed', true)).toBe('/en/my/events/12?new=1');
    expect(replayLanding('en', 12, 'confirmed', false)).toBe('/en/register/done?ok=1');
    expect(replayLanding('en', 12, 'waitlist', false)).toBe('/en/register/done?status=waitlist');
    expect(replayLanding('zh', 12, 'review', false)).toBe('/zh/register/done?status=review');
    expect(replayLanding('en', 12, 'cancelled', false)).toBe('/en/register');
  });
});

// ── Phase 3: ticket types and per-person questions ──────────────────────────

const q = (over: Partial<RegQuestion> & Pick<RegQuestion, 'id' | 'type'>): RegQuestion => ({
  sort: over.id, required: 0, options: null, label: `Q${over.id}`, scope: 'registration', condition: null, max_length: null, help: null, placeholder: null, option_labels: {}, ...over,
});
const phase3: RegQuestion[] = [
  q({ id: 31, type: 'yesno', label: 'Bringing a car seat?' }),
  q({ id: 32, type: 'select', scope: 'attendee', options: ['vegan', 'plain'], required: 1, label: 'Meal' }),
  q({ id: 33, type: 'text', scope: 'attendee', condition: { q: 32, op: 'eq', value: 'vegan' }, label: 'Notes' }),
  q({ id: 34, type: 'terms', required: 1, label: 'Photo release' }),
  q({ id: 35, type: 'section', scope: 'attendee', label: 'About you' }),
];
const types = [{ id: 7, active: 1 }, { id: 8, active: 1 }];

describe('submissionFromBag: ticket types and per-person answers', () => {
  const bag = bagFromFormData(formOf([
    ['name', 'Ada'], ['email', 'ada@example.com'],
    ['ticket_0', '7'], ['pq_0_32', 'vegan'], ['pq_0_33', 'no nuts'],
    ['person_name_1', 'Byron'], ['ticket_1', '8'], ['pq_1_32', 'plain'], ['pq_1_33', 'ignored: hidden'],
    ['person_name_2', ''], ['ticket_2', '7'],
    ['31', 'yes'], ['34', 'on'], ['32', 'forged registration-level answer'],
  ]));

  it('reads each row\'s ticket type and per-person answers, including the rows added with "Add another person"', () => {
    const input = submissionFromBag(bag, phase3, 3);
    expect(input.attendees).toEqual([
      { name: '', ticketTypeId: '7', answers: { '32': ['vegan'], '33': ['no nuts'] } },
      { name: 'Byron', personId: null, ticketTypeId: '8', answers: { '32': ['plain'], '33': ['ignored: hidden'] } },
      { name: '', personId: null, ticketTypeId: '7', answers: { '32': [], '33': [] } },
    ]);
    // Only the once-per-registration questions are read at registration level (a forged key for a per-person question is not).
    expect(input.answers).toEqual({ '31': ['yes'], '34': ['on'] });
  });

  it('validates to one ticket and one answer set per person, drops a hidden answer and makes terms a plain checkbox', () => {
    const result = validateSubmission({ max_party_size: 3 }, phase3, submissionFromBag(bag, phase3, 3), { ticketTypes: types });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attendees.map((a) => [a.name, a.ticketTypeId, a.answers])).toEqual([
      ['Ada', 7, [[32, 'vegan'], [33, 'no nuts']]],
      ['Byron', 8, [[32, 'plain']]], // Notes depends on Meal = vegan, so Byron's value is dropped
    ]);
    expect(result.value.answers.map(([id]) => id)).toEqual([31, 34]);
  });

  it('asks every person for a ticket type and reports it by row', () => {
    const noTicket = bagFromFormData(formOf([['name', 'Ada'], ['email', 'a@b.co'], ['person_name_1', 'Byron'], ['ticket_0', '7'], ['pq_0_32', 'plain'], ['pq_1_32', 'plain'], ['34', 'on']]));
    const result = validateSubmission({ max_party_size: 2 }, phase3, submissionFromBag(noTicket, phase3, 2), { ticketTypes: types });
    expect(result.ok ? [] : result.errors.map((e) => `${e.path}:${e.code}`)).toEqual(['attendees.1.ticket:required']);
    const missingTerms = bagFromFormData(formOf([['name', 'Ada'], ['email', 'a@b.co'], ['ticket_0', '7'], ['pq_0_32', 'plain']]));
    const terms = validateSubmission({ max_party_size: 1 }, phase3, submissionFromBag(missingTerms, phase3, 1), { ticketTypes: types });
    expect(terms.ok ? [] : terms.errors.map((e) => `${e.path}:${e.code}`)).toEqual(['q.34:missing_required']);
  });

  it('leaves a plain form exactly as it was (no ticket or answer keys unless the form has them)', () => {
    const plain = submissionFromBag(bagFromFormData(formOf([['name', 'A'], ['email', 'a@b.co']])), questions, 2);
    expect(plain.attendees).toEqual([{ name: '' }, { name: '', personId: null }]);
  });
});

describe('editFromBag: per-person answers', () => {
  it('collects each person\'s full answer set, and the marker alone means "all cleared"', () => {
    const edit = editFromBag({ attendee_5: ['Ada'], attendee_6: ['Byron'], pa_5: ['1'], pa_5_32: ['vegan'], pa_6: ['1'], a_31: ['yes'] });
    expect(edit.attendees).toEqual([{ id: 5, name: 'Ada', answers: { '32': ['vegan'] } }, { id: 6, name: 'Byron', answers: {} }]);
    expect(editFromBag({ attendee_5: ['Ada'] }).attendees).toEqual([{ id: 5, name: 'Ada' }]); // no per-person questions: not edited
  });
});

describe('validation copy and focus for the new fields', () => {
  it('reads a ticket problem, a missing terms box and a bad number as what they are', () => {
    const typesById = new Map<number, string>([[34, 'terms'], [40, 'number'], [32, 'select']]);
    expect(submissionErrorKey({ path: 'attendees.1.ticket', code: 'required' })).toBe('register.err.ticketRequired');
    expect(submissionErrorKey({ path: 'attendees.1.ticket', code: 'invalid' })).toBe('register.err.ticketInvalid');
    expect(submissionErrorKey({ path: 'q.34', code: 'missing_required' }, typesById)).toBe('register.err.termsRequired');
    expect(submissionErrorKey({ path: 'attendees.0.q.40', code: 'bad_answer' }, typesById)).toBe('register.err.invalid');
    expect(submissionErrorKey({ path: 'attendees.0.q.32', code: 'bad_answer' }, typesById)).toBe('register.err.answerInvalid');
    for (const key of ['register.err.ticketRequired', 'register.err.ticketInvalid', 'register.err.termsRequired']) expect(en).toHaveProperty([key]);
    expect(fieldIdForPath('attendees.2.ticket')).toBe('f-ticket-2');
    expect(fieldIdForPath('attendees.1.q.32')).toBe('f-pq-1-32');
  });
});

describe('party versus seats with ticket types', () => {
  const free = { capacity: 10, taken_count: 2, price_cents: null, waitlist_enabled: 1 };
  const child = { id: 8, seats_left: 1 };
  it('waitlists the whole party when a type limit is exceeded, even with seats left in the event', () => {
    expect(partyFit(free, 2, { types: [{ id: 7, seats_left: null }, child], picks: [7, 8] })).toBe('fits');
    expect(partyFit(free, 3, { types: [{ id: 7, seats_left: null }, child], picks: [7, 8, 8] })).toBe('waitlist');
    expect(partyFit({ ...free, waitlist_enabled: 0 }, 2, { types: [child], picks: [8, 8] })).toBe('no_room');
    expect(partyFit(free, 2, { types: [child], picks: [8, 8], free: false })).toBe('no_room'); // a paid total never waitlists
  });
  it('counts the seats left as the smaller of the event and its (all limited) types', () => {
    expect(seatsLeft(free, [{ seats_left: 3 }, { seats_left: 2 }])).toBe(5);
    expect(seatsLeft(free, [{ seats_left: 9 }, { seats_left: 9 }])).toBe(8);
    expect(seatsLeft({ capacity: null, taken_count: 0 }, [{ seats_left: 3 }, { seats_left: 2 }])).toBe(5);
    expect(seatsLeft({ capacity: null, taken_count: 0 }, [{ seats_left: 3 }, { seats_left: null }])).toBeNull();
  });
});
