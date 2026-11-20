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
  partyFit,
  partyRowCount,
  seatsLeft,
  submissionErrorKey,
  submissionFromBag,
} from '../src/lib/regPublic';
import { validateSubmission } from '../src/lib/regManage';
import type { RegQuestion } from '../src/lib/regDb';

const questions: RegQuestion[] = [
  { id: 11, sort: 0, type: 'text', required: 1, options: null, label: 'Dish' },
  { id: 12, sort: 1, type: 'checkbox', required: 0, options: ['a', 'b'], label: 'Allergies' },
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
});
