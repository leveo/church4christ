// Show-if for the registration forms (the sign-up form and the edit form of a registration), in the
// browser. It uses the SAME evaluator as the server's validator (regConditions.visibleQuestionIds), so a
// question is shown or hidden by exactly the rule that decides on the server whether its answer counts.
// A question that is not shown is hidden, cleared and disabled (so it is neither required nor submitted);
// a person's block that is collapsed ("Add another person" not pressed yet) hides all of that person's
// questions. Without JavaScript every question shows and the server ignores the answers of hidden ones.
// Bundled with the page (no inline script), so it works under a strict script policy.
import { visibleQuestionIds, type AnswerMap, type ConditionQuestion } from './regConditions';

/** One set of questions that share their answers: the registration's, or one person's. */
export interface ShowIfGroup {
  /** False for a person's collapsed block: none of its questions is shown. */
  active: boolean;
  /** The current answer(s) of a question (a hidden or disabled control reads as nothing). */
  read(questionId: number): string[];
  /** Show or hide one question (hiding clears it and takes it out of the submit). */
  apply(questionId: number, shown: boolean): void;
}

/**
 * Work out what is shown and apply it: the registration-scoped questions from the registration's
 * answers, then each active person's per-person questions from that person's answers (a
 * per-person condition may also depend on a registration answer).
 */
export function refreshShowIf(questions: readonly ConditionQuestion[], registration: ShowIfGroup, people: readonly ShowIfGroup[]): void {
  const registrationIds = questions.filter((q) => q.scope === 'registration').map((q) => q.id);
  const personIds = questions.filter((q) => q.scope === 'attendee').map((q) => q.id);
  const readAll = (group: ShowIfGroup, ids: number[]): AnswerMap => Object.fromEntries(ids.map((id) => [String(id), group.read(id)]));

  const registrationAnswers = readAll(registration, registrationIds);
  const shown = visibleQuestionIds(questions, registrationAnswers);
  for (const id of registrationIds) registration.apply(id, shown.has(id));

  for (const person of people) {
    if (!person.active) {
      for (const id of personIds) person.apply(id, false);
      continue;
    }
    const visible = visibleQuestionIds(questions, registrationAnswers, readAll(person, personIds));
    for (const id of personIds) person.apply(id, visible.has(id));
  }
}

// ── DOM adapter ─────────────────────────────────────────────────────────────

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const controlsIn = (el: Element): Control[] => Array.from(el.querySelectorAll('input, select, textarea')) as Control[];

/** Switch a set of controls on or off: off means cleared, disabled and not required (locked ones stay disabled). */
function setControls(controls: Control[], on: boolean): void {
  for (const control of controls) {
    if (!on) {
      if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) control.checked = false;
      else if (control.type !== 'hidden') control.value = '';
    }
    control.disabled = !on || control.hasAttribute('data-locked');
    if (control.hasAttribute('data-req')) control.required = on;
  }
}

function readWrapper(wrapper: HTMLElement): string[] {
  const out: string[] = [];
  for (const control of controlsIn(wrapper)) {
    if (control.disabled) continue;
    if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
      if (control.checked) out.push(control.value);
    } else if (control.value !== '') out.push(control.value);
  }
  return out;
}

function groupOf(scope: Element, selector: string, active: () => boolean): ShowIfGroup {
  const wrappers = new Map<number, HTMLElement>();
  for (const wrapper of scope.querySelectorAll<HTMLElement>(selector)) wrappers.set(Number(wrapper.dataset.qid), wrapper);
  return {
    get active() {
      return active();
    },
    read: (id) => {
      const wrapper = wrappers.get(id);
      return wrapper && !wrapper.hidden ? readWrapper(wrapper) : [];
    },
    apply: (id, shown) => {
      const wrapper = wrappers.get(id);
      if (!wrapper) return;
      wrapper.hidden = !shown;
      setControls(controlsIn(wrapper), shown);
    },
  };
}

/**
 * Wire show-if on one form that carries its questions as JSON (`<script type="application/json" data-reg-conditions>`
 * inside it). Registration questions are the `[data-qid][data-scope="registration"]` wrappers outside any person block;
 * each `[data-person-block]` holds one person's per-person questions and ticket picker. Returns the refresh function so a
 * caller that changes a person block (adds, removes) can run it again; null when the form has no conditions to wire.
 */
export function initShowIf(form: HTMLElement): (() => void) | null {
  const json = form.querySelector<HTMLScriptElement>('script[data-reg-conditions]');
  if (!json) return null;
  let questions: ConditionQuestion[];
  try {
    questions = JSON.parse(json.textContent ?? '[]') as ConditionQuestion[];
  } catch {
    return null;
  }
  const registration = groupOf(form, '[data-qid][data-scope="registration"]', () => true);
  // Registration wrappers must not include a person block's own questions (they are attendee-scoped, so they do not).
  const blocks = [...form.querySelectorAll<HTMLElement>('[data-person-block]')];
  const people = blocks.map((block) => groupOf(block, '[data-qid]', () => !block.hidden));
  const refresh = (): void => {
    // A collapsed block takes its ticket picker and every other control out of the submit.
    for (const block of blocks) for (const ticket of block.querySelectorAll<HTMLElement>('[data-ticket]')) setControls(controlsIn(ticket), !block.hidden);
    refreshShowIf(questions, registration, people);
  };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  refresh();
  return refresh;
}
