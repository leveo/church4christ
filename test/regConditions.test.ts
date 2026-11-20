import { describe, expect, it } from 'vitest';
import {
  evaluateCondition,
  parseCondition,
  validateConditions,
  visibleQuestionIds,
  type ConditionQuestion,
  type DraftConditionQuestion,
} from '../src/lib/regConditions';

describe('evaluateCondition', () => {
  it('eq / neq compare a single answer and treat a checkbox as "contains"', () => {
    expect(evaluateCondition({ q: 1, op: 'eq', value: 'a' }, 'a')).toBe(true);
    expect(evaluateCondition({ q: 1, op: 'eq', value: 'a' }, ' a ')).toBe(true);
    expect(evaluateCondition({ q: 1, op: 'eq', value: 'a' }, 'b')).toBe(false);
    expect(evaluateCondition({ q: 1, op: 'eq', value: 'a' }, ['b', 'a'])).toBe(true);
    expect(evaluateCondition({ q: 1, op: 'neq', value: 'a' }, 'b')).toBe(true);
    expect(evaluateCondition({ q: 1, op: 'neq', value: 'a' }, ['a', 'b'])).toBe(false);
    expect(evaluateCondition({ q: 1, op: 'neq', value: 'a' }, undefined)).toBe(true);
    expect(evaluateCondition({ q: 1, op: 'eq', value: 'a' }, undefined)).toBe(false);
  });

  it('in matches when any listed key was chosen', () => {
    const c = { q: 1, op: 'in' as const, value: ['a', 'b'] };
    expect(evaluateCondition(c, 'b')).toBe(true);
    expect(evaluateCondition(c, ['x', 'a'])).toBe(true);
    expect(evaluateCondition(c, 'x')).toBe(false);
    expect(evaluateCondition(c, [])).toBe(false);
  });

  it('checked reads yes/no synonyms for yesno and any choice for a checkbox', () => {
    const c = { q: 1, op: 'checked' as const };
    for (const yes of ['yes', 'Y', 'true', '1', 'on']) expect(evaluateCondition(c, yes, 'yesno')).toBe(true);
    for (const no of ['no', 'off', '', undefined]) expect(evaluateCondition(c, no, 'yesno')).toBe(false);
    expect(evaluateCondition(c, ['a'], 'checkbox')).toBe(true);
    expect(evaluateCondition(c, [], 'checkbox')).toBe(false);
  });

  it('answered is true for any non-blank answer', () => {
    const c = { q: 1, op: 'answered' as const };
    expect(evaluateCondition(c, 'x')).toBe(true);
    expect(evaluateCondition(c, '   ')).toBe(false);
    expect(evaluateCondition(c, [''])).toBe(false);
    expect(evaluateCondition(c, null)).toBe(false);
  });

  it('yesno equality accepts the same synonyms the server normalizes', () => {
    expect(evaluateCondition({ q: 1, op: 'eq', value: 'yes' }, 'on', 'yesno')).toBe(true);
    expect(evaluateCondition({ q: 1, op: 'eq', value: 'no' }, 'false', 'yesno')).toBe(true);
  });
});

describe('visibleQuestionIds', () => {
  const questions: ConditionQuestion[] = [
    { id: 1, type: 'select', scope: 'registration', options: ['a', 'b'] },
    { id: 2, type: 'text', scope: 'registration', condition: { q: 1, op: 'eq', value: 'a' } },
    { id: 3, type: 'text', scope: 'registration', condition: { q: 2, op: 'answered' } },
    { id: 4, type: 'yesno', scope: 'attendee' },
    { id: 5, type: 'text', scope: 'attendee', condition: { q: 4, op: 'checked' } },
    { id: 6, type: 'text', scope: 'attendee', condition: { q: 1, op: 'eq', value: 'b' } },
  ];

  it('shows unconditional questions and the ones whose condition holds', () => {
    expect([...visibleQuestionIds(questions, { '1': 'a', '2': 'hi' }, {})]).toEqual([1, 2, 3, 4]);
    expect([...visibleQuestionIds(questions, { '1': 'b' }, {})]).toEqual([1, 4, 6]);
  });

  it('a hidden target hides its dependents even when their operator would hold', () => {
    // 2 is hidden (1 != a), so 3 (answered 2) stays hidden even though a stale answer exists.
    expect(visibleQuestionIds(questions, { '1': 'b', '2': 'stale' }, {}).has(3)).toBe(false);
    const neq: ConditionQuestion[] = [
      { id: 1, type: 'select', scope: 'registration', options: ['a'] },
      { id: 2, type: 'text', scope: 'registration', condition: { q: 1, op: 'eq', value: 'a' } },
      { id: 3, type: 'text', scope: 'registration', condition: { q: 2, op: 'neq', value: 'x' } },
    ];
    expect(visibleQuestionIds(neq, { '1': 'z' }).has(3)).toBe(false);
  });

  it('answers attendee-scoped questions per person and skips them without attendee answers', () => {
    expect(visibleQuestionIds(questions, { '1': 'a' }, { '4': 'yes' }).has(5)).toBe(true);
    expect(visibleQuestionIds(questions, { '1': 'a' }, { '4': 'no' }).has(5)).toBe(false);
    expect(visibleQuestionIds(questions, { '1': 'a' }).has(4)).toBe(false);
  });

  it('hides a question whose target is unknown', () => {
    expect(visibleQuestionIds([{ id: 9, type: 'text', scope: 'registration', condition: { q: 99, op: 'answered' } }], {}).size).toBe(0);
  });
});

describe('parseCondition', () => {
  it('reads a well-formed condition from JSON or an object', () => {
    expect(parseCondition('{"q":3,"op":"eq","value":"a"}')).toEqual({ q: 3, op: 'eq', value: 'a' });
    expect(parseCondition({ q: 3, op: 'in', value: ['a', 'b'] })).toEqual({ q: 3, op: 'in', value: ['a', 'b'] });
    expect(parseCondition({ q: 3, op: 'checked', value: 'ignored' })).toEqual({ q: 3, op: 'checked' });
  });

  it('rejects everything else', () => {
    for (const bad of [null, undefined, 'x', '[]', '{"q":0,"op":"eq","value":"a"}', { q: 1, op: 'gt' }, { q: 1, op: 'eq' },
      { q: 1, op: 'in', value: 'a' }, { q: '1', op: 'answered' }, { q: 1.5, op: 'answered' }, [1]]) {
      expect(parseCondition(bad)).toBeNull();
    }
  });
});

describe('validateConditions', () => {
  const base: DraftConditionQuestion[] = [
    { type: 'select', scope: 'registration', options: ['a', 'b'] },
    { type: 'text', scope: 'registration' },
    { type: 'yesno', scope: 'attendee' },
    { type: 'terms', scope: 'registration' },
    { type: 'section', scope: 'registration' },
  ];
  const withCondition = (condition: DraftConditionQuestion['condition'], scope: 'registration' | 'attendee' = 'registration') => [
    ...base,
    { type: 'text', scope, condition } as DraftConditionQuestion,
  ];
  const codes = (list: DraftConditionQuestion[]) => validateConditions(list).map((e) => `${e.index}:${e.code}`);

  it('accepts valid conditions', () => {
    expect(codes(withCondition({ target: 0, op: 'eq', value: 'a' }))).toEqual([]);
    expect(codes(withCondition({ target: 0, op: 'in', value: ['a', 'b'] }))).toEqual([]);
    expect(codes(withCondition({ target: 1, op: 'answered' }))).toEqual([]);
    expect(codes(withCondition({ target: 1, op: 'eq', value: 'anything' }))).toEqual([]);
    expect(codes(withCondition({ target: 2, op: 'checked' }, 'attendee'))).toEqual([]);
    expect(codes(withCondition({ target: 0, op: 'eq', value: 'b' }, 'attendee'))).toEqual([]);
  });

  it('refuses unknown targets, forward references and self references', () => {
    expect(codes(withCondition({ target: 42, op: 'answered' }))).toEqual(['5:condition_target_unknown']);
    expect(codes(withCondition({ target: -1, op: 'answered' }))).toEqual(['5:condition_target_unknown']);
    expect(codes(withCondition({ target: 5, op: 'answered' }))).toEqual(['5:condition_target_forward']);
    expect(codes([{ type: 'text', scope: 'registration' }, { type: 'text', scope: 'registration' }]
      .map((q, i) => (i === 0 ? { ...q, condition: { target: 1, op: 'answered' } } : q)))).toEqual(['0:condition_target_forward']);
  });

  it('refuses cycles (every cycle needs a forward edge)', () => {
    const cycle: DraftConditionQuestion[] = [
      { type: 'text', scope: 'registration', condition: { target: 1, op: 'answered' } },
      { type: 'text', scope: 'registration', condition: { target: 0, op: 'answered' } },
    ];
    expect(codes(cycle)).toEqual(['0:condition_target_forward']);
  });

  it('refuses section and terms targets and a registration question pointing at a per-person one', () => {
    expect(codes(withCondition({ target: 3, op: 'answered' }))).toEqual(['5:condition_target_type']);
    expect(codes(withCondition({ target: 4, op: 'answered' }))).toEqual(['5:condition_target_type']);
    expect(codes(withCondition({ target: 2, op: 'checked' }))).toEqual(['5:condition_target_scope']);
  });

  it('refuses operators the target type does not support and bad values', () => {
    expect(codes(withCondition({ target: 1, op: 'in', value: ['x'] }))).toEqual(['5:condition_op_invalid']);
    expect(codes(withCondition({ target: 0, op: 'checked' }))).toEqual(['5:condition_op_invalid']);
    expect(codes(withCondition({ target: 0, op: 'gt' }))).toEqual(['5:condition_op_invalid']);
    expect(codes(withCondition({ target: 0, op: 'eq', value: 'nope' }))).toEqual(['5:condition_value_invalid']);
    expect(codes(withCondition({ target: 0, op: 'eq' }))).toEqual(['5:condition_value_invalid']);
    expect(codes(withCondition({ target: 0, op: 'in', value: [] }))).toEqual(['5:condition_value_invalid']);
    expect(codes(withCondition({ target: 0, op: 'in', value: ['a', 'zz'] }))).toEqual(['5:condition_value_invalid']);
    expect(codes(withCondition({ target: 1, op: 'eq', value: '  ' }))).toEqual(['5:condition_value_invalid']);
    expect(codes(withCondition({ target: 1, op: 'answered', value: 'x' }))).toEqual(['5:condition_value_invalid']);
    expect(codes(withCondition({ target: 2, op: 'eq', value: 'maybe' }, 'attendee'))).toEqual(['5:condition_value_invalid']);
  });
});
