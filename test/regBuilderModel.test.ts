// Registration form builder island model: reducer, undo coalescing, payload, client validation, error-path
// mapping and condition-target filtering. Pure logic, no DOM.
import { describe, expect, it } from 'vitest';
import {
  QUESTION_TYPES,
  adoptSaved,
  buildPayload,
  centsToDollars,
  conditionIssues,
  conditionSentence,
  conditionTargets,
  defaultCondition,
  dependentsOf,
  dollarsToCents,
  errorKey,
  formReducer,
  initialState,
  issuesByCard,
  newOption,
  newQuestion,
  newTicket,
  parseErrorPath,
  toDrafts,
  validateDraft,
  withOp,
  type DraftQuestion,
  type FormState,
} from '../src/components/regBuilder/model';
import { QUESTION_TYPES as SERVER_TYPES } from '../src/lib/regDb';
import { validateConditions } from '../src/lib/regConditions';

const L = ['en', 'zh'];

function q(type: DraftQuestion['type'], label: string, over: Partial<DraftQuestion> = {}): DraftQuestion {
  return { ...newQuestion(type, L), labels: { en: label, zh: '' }, ...over };
}

function stateOf(...questions: DraftQuestion[]): FormState {
  return initialState({ questions, tickets: [] });
}

describe('question types', () => {
  it('match the server list', () => {
    expect([...QUESTION_TYPES]).toEqual([...SERVER_TYPES]);
  });
});

describe('formReducer questions', () => {
  it('adds at the end or at an index, removes, and records undo/redo', () => {
    const a = q('text', 'A');
    const b = q('text', 'B');
    const c = q('text', 'C');
    let s = stateOf(a);
    s = formReducer(s, { type: 'addQuestion', question: b });
    s = formReducer(s, { type: 'addQuestion', question: c, index: 0 });
    expect(s.questions.map((x) => x.labels.en)).toEqual(['C', 'A', 'B']);
    s = formReducer(s, { type: 'removeQuestion', cid: a.cid });
    expect(s.questions.map((x) => x.labels.en)).toEqual(['C', 'B']);
    s = formReducer(s, { type: 'undo' });
    expect(s.questions.map((x) => x.labels.en)).toEqual(['C', 'A', 'B']);
    s = formReducer(s, { type: 'redo' });
    expect(s.questions.map((x) => x.labels.en)).toEqual(['C', 'B']);
    expect(formReducer(s, { type: 'redo' })).toBe(s);
  });

  it('moves with drag targets and keyboard nudges; boundaries are no-ops', () => {
    const [a, b, c] = [q('text', 'A'), q('text', 'B'), q('text', 'C')];
    let s = stateOf(a, b, c);
    s = formReducer(s, { type: 'moveQuestion', cid: a.cid, to: 2 });
    expect(s.questions.map((x) => x.labels.en)).toEqual(['B', 'C', 'A']);
    s = formReducer(s, { type: 'nudgeQuestion', cid: a.cid, direction: -1 });
    expect(s.questions.map((x) => x.labels.en)).toEqual(['B', 'A', 'C']);
    expect(formReducer(s, { type: 'nudgeQuestion', cid: b.cid, direction: -1 })).toBe(s);
    expect(formReducer(s, { type: 'nudgeQuestion', cid: c.cid, direction: 1 })).toBe(s);
    expect(formReducer(s, { type: 'moveQuestion', cid: 'nope', to: 0 })).toBe(s);
  });

  it('refuses to remove a question another question depends on, and lists the dependents', () => {
    const target = q('yesno', 'Need childcare?');
    const dependent = q('text', 'How many children?', { condition: { q: target.cid, op: 'eq', value: 'yes', values: [] } });
    const s = stateOf(target, dependent);
    expect(dependentsOf(s.questions, target.cid).map((x) => x.cid)).toEqual([dependent.cid]);
    expect(formReducer(s, { type: 'removeQuestion', cid: target.cid })).toBe(s);
    expect(formReducer(s, { type: 'removeQuestion', cid: dependent.cid }).questions).toHaveLength(1);
  });

  it('changing the type fixes the fields that no longer apply', () => {
    const a = q('text', 'A', { required: true, maxLength: '40' });
    let s = stateOf(a);
    s = formReducer(s, { type: 'patchQuestion', cid: a.cid, patch: { type: 'section' } });
    expect(s.questions[0]).toMatchObject({ type: 'section', required: false, maxLength: '' });
    s = formReducer(s, { type: 'patchQuestion', cid: a.cid, patch: { type: 'select' } });
    expect(s.questions[0].options).toHaveLength(2);
  });

  it('options add, reorder and remove; removing one clears it from conditions that use it', () => {
    const pick = q('select', 'Meal', { options: [] });
    const veg = newOption();
    const meat = newOption();
    const dependent = q('text', 'Why vegetarian?');
    let s = stateOf(pick, dependent);
    s = formReducer(s, { type: 'addOption', cid: pick.cid, option: veg });
    s = formReducer(s, { type: 'addOption', cid: pick.cid, option: meat });
    s = formReducer(s, { type: 'moveOption', cid: pick.cid, key: meat.key, direction: -1 });
    expect(s.questions[0].options.map((o) => o.key)).toEqual([meat.key, veg.key]);
    expect(formReducer(s, { type: 'moveOption', cid: pick.cid, key: meat.key, direction: -1 })).toBe(s);
    s = formReducer(s, { type: 'setCondition', cid: dependent.cid, condition: { q: pick.cid, op: 'in', value: '', values: [veg.key, meat.key] } });
    s = formReducer(s, { type: 'removeOption', cid: pick.cid, key: veg.key });
    expect(s.questions[0].options.map((o) => o.key)).toEqual([meat.key]);
    expect(s.questions[1].condition?.values).toEqual([meat.key]);
  });

  it('typing in one field is a single undo step; different fields are separate', () => {
    const a = q('text', '');
    let s = stateOf(a);
    for (const value of ['H', 'He', 'Hel']) s = formReducer(s, { type: 'setText', cid: a.cid, field: 'labels', locale: 'en', value });
    expect(s.past).toHaveLength(1);
    s = formReducer(s, { type: 'setText', cid: a.cid, field: 'help', locale: 'en', value: 'Tip' });
    expect(s.past).toHaveLength(2);
    s = formReducer(s, { type: 'undo' });
    expect(s.questions[0].help.en).toBe('');
    expect(s.questions[0].labels.en).toBe('Hel');
    s = formReducer(s, { type: 'undo' });
    expect(s.questions[0].labels.en).toBe('');
  });

  it('adoptSaved keeps client ids by position and re-points conditions', () => {
    const t = q('yesno', 'T');
    const d = q('text', 'D', { condition: { q: t.cid, op: 'eq', value: 'yes', values: [] } });
    const s = stateOf(t, d);
    const server = toDrafts(
      [
        { id: 7, type: 'yesno', scope: 'registration', required: 0, options: null, condition: null, max_length: null, labels: { en: 'T' }, help: {}, placeholder: {}, option_labels: {} },
        { id: 8, type: 'text', scope: 'registration', required: 0, options: null, condition: { q: 7, op: 'eq', value: 'yes' }, max_length: null, labels: { en: 'D' }, help: {}, placeholder: {}, option_labels: {} },
      ],
      [],
      L,
    );
    const next = adoptSaved(s, server);
    expect(next.questions.map((x) => [x.cid, x.id])).toEqual([[t.cid, 7], [d.cid, 8]]);
    expect(next.questions[1].condition?.q).toBe(t.cid);
    expect(next.past).toEqual([]);
  });
});

describe('formReducer tickets', () => {
  it('adds, edits, reorders, deactivates and removes ticket types', () => {
    const a = { ...newTicket(L), labels: { en: 'Adult', zh: '' } };
    const b = { ...newTicket(L), labels: { en: 'Child', zh: '' } };
    let s = initialState({ questions: [], tickets: [] });
    s = formReducer(s, { type: 'addTicket', ticket: a });
    s = formReducer(s, { type: 'addTicket', ticket: b });
    s = formReducer(s, { type: 'nudgeTicket', cid: b.cid, direction: -1 });
    expect(s.tickets.map((t) => t.labels.en)).toEqual(['Child', 'Adult']);
    s = formReducer(s, { type: 'patchTicket', cid: a.cid, patch: { active: false } });
    expect(s.tickets[1].active).toBe(false);
    for (const price of ['1', '12', '12.5']) s = formReducer(s, { type: 'patchTicket', cid: a.cid, patch: { price } });
    const steps = s.past.length;
    s = formReducer(s, { type: 'patchTicket', cid: a.cid, patch: { price: '12.50' } });
    expect(s.past.length).toBe(steps);
    s = formReducer(s, { type: 'removeTicket', cid: b.cid });
    expect(s.tickets.map((t) => t.labels.en)).toEqual(['Adult']);
  });

  it('converts dollars and cents', () => {
    expect(dollarsToCents('')).toBe(0);
    expect(dollarsToCents('12.5')).toBe(1250);
    expect(dollarsToCents('0.07')).toBe(7);
    expect(dollarsToCents('1.234')).toBeNaN();
    expect(dollarsToCents('-1')).toBeNaN();
    expect(dollarsToCents('abc')).toBeNaN();
    expect(centsToDollars(0)).toBe('');
    expect(centsToDollars(1250)).toBe('12.50');
  });
});

describe('condition targets', () => {
  it('lists only earlier, allowed questions', () => {
    const section = q('section', 'Heading');
    const reg = q('yesno', 'Childcare?');
    const terms = q('terms', 'Agree');
    const person = q('select', 'Shirt', { scope: 'attendee' });
    const later = q('text', 'Later');
    const regDependent = q('text', 'Reg dependent');
    const personDependent = q('text', 'Person dependent', { scope: 'attendee' });
    const all = [section, reg, terms, person, regDependent, personDependent, later];
    expect(conditionTargets(all, 0)).toEqual([]);
    expect(conditionTargets(all, 4).map((x) => x.labels.en)).toEqual(['Childcare?']);
    expect(conditionTargets(all, 5).map((x) => x.labels.en)).toEqual(['Childcare?', 'Shirt', 'Reg dependent']);
    expect(conditionTargets(all, 99)).toEqual([]);
  });

  it('agrees with the shared validator for every target type and scope', () => {
    const scopes = ['registration', 'attendee'] as const;
    for (const type of QUESTION_TYPES) {
      for (const targetScope of scopes) {
        for (const scope of scopes) {
          const target = q(type, 'T', { scope: targetScope });
          const dependent = q('text', 'D', { scope });
          const allowed = conditionTargets([target, dependent], 1).length === 1;
          const d = defaultCondition(target);
          const errors = validateConditions([
            { type: target.type, scope: target.scope, options: target.options.map((o) => o.key) },
            { type: 'text', scope, condition: { target: 0, op: d.op, ...(d.op === 'eq' || d.op === 'neq' ? { value: d.value } : {}) } },
          ]);
          const targetProblem = errors.some((e) => e.code === 'condition_target_type' || e.code === 'condition_target_scope' || e.code === 'condition_op_invalid');
          expect(allowed, `${type}/${targetScope}->${scope}`).toBe(!targetProblem);
        }
      }
    }
  });

  it('builds a valid default condition and repairs the operand when the operator changes', () => {
    const target = q('select', 'Meal', { options: [{ key: 'veg', labels: { en: 'Vegetarian' } }, { key: 'meat', labels: { en: 'Meat' } }] });
    const d = defaultCondition(target);
    expect(d).toEqual({ q: target.cid, op: 'eq', value: 'veg', values: [] });
    expect(withOp(d, target, 'in')).toMatchObject({ op: 'in', value: '', values: [] });
    expect(withOp(d, target, 'answered')).toMatchObject({ op: 'answered', value: '', values: [] });
    expect(defaultCondition(q('yesno', 'Y'))).toMatchObject({ op: 'eq', value: 'yes' });
  });

  it('flags forward references and bad operands live', () => {
    const first = q('text', 'First');
    const second = q('yesno', 'Second');
    first.condition = { q: second.cid, op: 'eq', value: 'yes', values: [] };
    expect(conditionIssues([first, second])).toEqual([{ path: 'questions.0.condition.q', code: 'condition_target_forward' }]);
    const bad = q('text', 'Bad', { condition: { q: second.cid, op: 'eq', value: 'maybe', values: [] } });
    expect(conditionIssues([second, bad])).toEqual([{ path: 'questions.1.condition.value', code: 'condition_value_invalid' }]);
  });

  it('reads as a sentence', () => {
    const target = q('yesno', 'Need childcare?');
    const meal = q('select', 'Meal', { options: [{ key: 'veg', labels: { en: 'Vegetarian', zh: '素食' } }, { key: 'meat', labels: { en: 'Meat' } }] });
    const a = q('text', 'A', { condition: { q: target.cid, op: 'eq', value: 'yes', values: [] } });
    const b = q('text', 'B', { condition: { q: meal.cid, op: 'in', value: '', values: ['veg', 'meat'] } });
    const c = q('text', 'C', { condition: { q: target.cid, op: 'checked', value: '', values: [] } });
    const all = [target, meal, a, b, c];
    const text = { eq: 'Show only if “{q}” is {v}', neq: '{q} is not {v}', in: 'Show only if “{q}” is one of {v}', checked: 'Show only if “{q}” is checked', answered: '{q}?', yes: 'Yes', no: 'No', untitled: '(untitled)' };
    expect(conditionSentence(all, 2, { locale: 'en', text })).toBe('Show only if “Need childcare?” is Yes');
    expect(conditionSentence(all, 3, { locale: 'en', text })).toBe('Show only if “Meal” is one of Vegetarian, Meat');
    expect(conditionSentence(all, 3, { locale: 'zh', text })).toBe('Show only if “(untitled)” is one of 素食, meat');
    expect(conditionSentence(all, 4, { locale: 'en', text })).toBe('Show only if “Need childcare?” is checked');
    expect(conditionSentence(all, 0, { locale: 'en', text })).toBe('');
  });
});

describe('payload and validation', () => {
  it('builds the writer payload with keys, ids, option keys and cents', () => {
    const t = q('yesno', 'Need childcare?', { id: 4 });
    const d = q('select', 'Meal', {
      options: [{ key: 'veg', labels: { en: 'Veg', zh: '素' } }],
      condition: { q: t.cid, op: 'in', value: '', values: ['yes'] },
      required: true,
    });
    const text = q('text', 'Nick', { maxLength: '20' });
    const ticket = { ...newTicket(L), labels: { en: ' Adult ', zh: '' }, price: '12.5', capacity: '30' };
    const payload = buildPayload({ questions: [t, d, text], tickets: [ticket] }, L);
    expect(payload.questions[0]).toMatchObject({ id: 4, key: t.cid, type: 'yesno', scope: 'registration', required: false, labels: { en: 'Need childcare?', zh: '' } });
    expect('max_length' in payload.questions[0]).toBe(false);
    expect(payload.questions[1]).toMatchObject({
      key: d.cid, required: true, options: [{ key: 'veg', labels: { en: 'Veg', zh: '素' } }], condition: { q: t.cid, op: 'in', value: ['yes'] },
    });
    expect('id' in payload.questions[1]).toBe(false);
    expect(payload.questions[2]).toMatchObject({ max_length: 20, condition: null });
    expect(payload.tickets[0]).toEqual({ price_cents: 1250, capacity: 30, active: true, labels: { en: 'Adult', zh: '' }, descriptions: { en: '', zh: '' } });
    expect(buildPayload({ questions: [], tickets: [ticket] }, L, { includeTickets: false }).tickets).toEqual([]);
  });

  it('reports the writer paths for missing labels, options, numbers and D1 prices', () => {
    const blank = q('select', '', { options: [{ key: 'a', labels: { en: '' } }], maxLength: '' });
    const long = q('text', 'Long', { maxLength: '9999' });
    const ticket = { ...newTicket(L), price: '3', capacity: '0' };
    const issues = validateDraft({ questions: [blank, long], tickets: [ticket] }, 'en', { d1: true }).map((i) => `${i.path}:${i.code}`);
    expect(issues).toEqual([
      'questions.0.labels.en:required',
      'questions.0.options.0.labels.en:required',
      'questions.1.max_length:invalid',
      'tickets.0.labels.en:required',
      'tickets.0.price_cents:paid_unavailable',
      'tickets.0.capacity:invalid',
    ]);
    expect(validateDraft({ questions: [q('text', 'Ok')], tickets: [] }, 'en')).toEqual([]);
  });
});

describe('error paths', () => {
  it('maps server paths to cards and fields', () => {
    expect(parseErrorPath('questions.3.options.1.labels.en')).toEqual({ kind: 'question', index: 3, field: 'options.1.labels.en' });
    expect(parseErrorPath('questions.0')).toEqual({ kind: 'question', index: 0, field: '' });
    expect(parseErrorPath('tickets.2.price_cents')).toEqual({ kind: 'ticket', index: 2, field: 'price_cents' });
    expect(parseErrorPath('tickets')).toEqual({ kind: 'form', scope: 'tickets' });
    expect(parseErrorPath('')).toEqual({ kind: 'form', scope: '' });
    expect(parseErrorPath('weird')).toEqual({ kind: 'form', scope: '' });
  });

  it('groups issues per card with the first code per field', () => {
    const grouped = issuesByCard([
      { path: 'questions.1.labels.en', code: 'required' },
      { path: 'questions.1.labels.en', code: 'too_long' },
      { path: 'questions.1.scope', code: 'scope_in_use' },
      { path: 'tickets.0.capacity', code: 'invalid' },
      { path: 'tickets', code: 'delete_in_use' },
    ]);
    expect([...grouped.questions.get(1)!]).toEqual([['labels.en', 'required'], ['scope', 'scope_in_use']]);
    expect([...grouped.tickets.get(0)!]).toEqual([['capacity', 'invalid']]);
    expect(grouped.form).toEqual([{ path: 'tickets', code: 'delete_in_use' }]);
  });

  it('picks specific message keys for numeric fields', () => {
    expect(errorKey('price_cents', 'invalid')).toBe('price');
    expect(errorKey('capacity', 'invalid')).toBe('capacity');
    expect(errorKey('max_length', 'invalid')).toBe('maxLength');
    expect(errorKey('labels.en', 'required')).toBe('required');
  });
});
