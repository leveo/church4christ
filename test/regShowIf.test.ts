// The show-if wiring of the registration forms: the page script hands the shared evaluator each group's
// answers and applies the result. There is no DOM test setup, so this drives refreshShowIf with fake groups
// (the browser adapter only maps controls to these three calls).
import { describe, expect, it } from 'vitest';
import { refreshShowIf, type ShowIfGroup } from '../src/lib/reg-showif-client';
import type { ConditionQuestion } from '../src/lib/regConditions';

// 1 yes/no (registration) -> 2 text (registration, shown when 1 = yes)
// 3 select (person) -> 4 text (person, shown when 3 = vegan); 5 person text shown when registration 1 = yes
const questions: ConditionQuestion[] = [
  { id: 1, type: 'yesno', scope: 'registration' },
  { id: 2, type: 'text', scope: 'registration', condition: { q: 1, op: 'eq', value: 'yes' } },
  { id: 3, type: 'select', scope: 'attendee', options: ['vegan', 'plain'] },
  { id: 4, type: 'text', scope: 'attendee', condition: { q: 3, op: 'eq', value: 'vegan' } },
  { id: 5, type: 'text', scope: 'attendee', condition: { q: 1, op: 'checked' } },
];

function group(answers: Record<number, string[]>, active = true) {
  const shown = new Map<number, boolean>();
  const g: ShowIfGroup & { shown: Map<number, boolean> } = {
    active,
    shown,
    read: (id) => answers[id] ?? [],
    apply: (id, on) => void shown.set(id, on),
  };
  return g;
}

describe('refreshShowIf', () => {
  it('shows a registration question only when its condition holds, with the shared evaluator', () => {
    const yes = group({ 1: ['yes'] });
    refreshShowIf(questions, yes, []);
    expect([yes.shown.get(1), yes.shown.get(2)]).toEqual([true, true]);
    const no = group({ 1: ['no'] });
    refreshShowIf(questions, no, []);
    expect(no.shown.get(2)).toBe(false);
    const blank = group({});
    refreshShowIf(questions, blank, []);
    expect(blank.shown.get(2)).toBe(false);
  });

  it('decides per-person questions from each person\'s own answers, and from the registration answers', () => {
    const registration = group({ 1: ['yes'] });
    const ada = group({ 3: ['vegan'] });
    const mia = group({ 3: ['plain'] });
    refreshShowIf(questions, registration, [ada, mia]);
    expect([ada.shown.get(4), mia.shown.get(4)]).toEqual([true, false]);
    expect([ada.shown.get(5), mia.shown.get(5)]).toEqual([true, true]); // depends on the registration-level yes
    const none = group({ 1: ['no'] });
    const bob = group({ 3: ['vegan'] });
    refreshShowIf(questions, none, [bob]);
    expect(bob.shown.get(5)).toBe(false);
  });

  it('hides every per-person question of a collapsed person block', () => {
    const registration = group({ 1: ['yes'] });
    const extra = group({ 3: ['vegan'] }, false);
    refreshShowIf(questions, registration, [extra]);
    expect([3, 4, 5].map((id) => extra.shown.get(id))).toEqual([false, false, false]);
  });

  it('hides the dependents of a hidden question (a chain)', () => {
    const chain: ConditionQuestion[] = [
      { id: 1, type: 'yesno', scope: 'registration' },
      { id: 2, type: 'text', scope: 'registration', condition: { q: 1, op: 'eq', value: 'yes' } },
      { id: 3, type: 'text', scope: 'registration', condition: { q: 2, op: 'answered' } },
    ];
    // The answer to 2 is still typed, but 2 is hidden (1 = no), so 3 must not show.
    const g = group({ 1: ['no'], 2: ['stale'] });
    refreshShowIf(chain, g, []);
    expect([g.shown.get(2), g.shown.get(3)]).toEqual([false, false]);
  });
});
