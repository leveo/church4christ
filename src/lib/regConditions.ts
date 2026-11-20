// Show-if conditions for registration questions: one pure, dependency-free module that
// the server validator (regManage.validateSubmission), the form-builder's save validator
// (regDb.saveEventForm) and the public form's inline script all import, so a question is
// shown or hidden by exactly the same rule in the browser and on the server. No imports, no
// database, no DOM: safe to bundle into a browser script.
//
// A condition is { q, op, value? } stored as JSON on reg_questions.condition:
//   eq / neq   - the target's answer is (not) the option key / string `value`
//   in         - the target's answer is one of the keys in `value` (an array)
//   checked    - a yes/no target is "yes", or a checkbox target has any choice
//   answered   - the target has a non-blank answer
// Allowed targets: an EARLIER question (by sort) that is registration-scoped, or, for an
// attendee-scoped question, an earlier attendee-scoped question (answered by the same
// person). Never a section or a terms question. A hidden target hides its dependents.

export const CONDITION_OPS = ['eq', 'neq', 'in', 'checked', 'answered'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface Condition {
  q: number;
  op: ConditionOp;
  value?: string | string[];
}

/** A raw or stored answer: a single string, the choices of a checkbox, or nothing. */
export type AnswerValue = string | readonly string[] | null | undefined;
/** Answers keyed by question id (as a string, like form fields). */
export type AnswerMap = Readonly<Record<string, AnswerValue>>;

export type ConditionScope = 'registration' | 'attendee';

/** The slice of a question the evaluator and validator need. Questions are passed in sort order. */
export interface ConditionQuestion {
  id: number;
  type: string;
  scope: ConditionScope;
  options?: readonly string[] | null;
  condition?: Condition | null;
}

const YES = new Set(['yes', 'y', 'true', '1', 'on']);
const NO = new Set(['no', 'n', 'false', '0', 'off']);
const MAX_VALUE_LENGTH = 200;

/** The non-blank trimmed values of an answer (a yes/no answer is folded to 'yes' / 'no'). */
export function answerValues(answer: AnswerValue, type?: string): string[] {
  const list = answer == null ? [] : typeof answer === 'string' ? [answer] : [...answer];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (value === '') continue;
    if (type === 'yesno') {
      const lower = value.toLowerCase();
      out.push(YES.has(lower) ? 'yes' : NO.has(lower) ? 'no' : value);
    } else out.push(value);
  }
  return out;
}

/** Whether one condition holds for the target's answer. `type` is the target question's type. */
export function evaluateCondition(condition: Condition, answer: AnswerValue, type?: string): boolean {
  const values = answerValues(answer, type);
  switch (condition.op) {
    case 'answered':
      return values.length > 0;
    case 'checked':
      return type === 'yesno' ? values.includes('yes') : values.length > 0;
    case 'eq':
      return typeof condition.value === 'string' && values.includes(condition.value);
    case 'neq':
      return typeof condition.value === 'string' && !values.includes(condition.value);
    case 'in':
      return Array.isArray(condition.value) && condition.value.some((v) => values.includes(v));
    default:
      return false;
  }
}

/**
 * The ids of the questions that are shown, in sort order. `registrationAnswers` answers the
 * registration-scoped questions; `attendeeAnswers` (omit to skip attendee-scoped questions)
 * answers one person's. A question is shown when it has no condition, or its target is shown
 * and the condition holds for the target's answer; an unknown target hides it.
 */
export function visibleQuestionIds(
  questions: readonly ConditionQuestion[],
  registrationAnswers: AnswerMap,
  attendeeAnswers?: AnswerMap,
): Set<number> {
  const byId = new Map<number, ConditionQuestion>();
  const shown = new Set<number>();
  for (const question of questions) {
    byId.set(question.id, question);
    if (question.scope === 'attendee' && attendeeAnswers === undefined) continue;
    const condition = question.condition;
    if (!condition) {
      shown.add(question.id);
      continue;
    }
    const target = byId.get(condition.q);
    if (!target || !shown.has(target.id)) continue;
    const answers = target.scope === 'attendee' ? attendeeAnswers : registrationAnswers;
    if (evaluateCondition(condition, answers?.[String(target.id)], target.type)) shown.add(question.id);
  }
  return shown;
}

/** Strictly read a stored condition (a JSON string or an object): null when it is not a well-formed one. */
export function parseCondition(raw: unknown): Condition | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { q, op, value: operand } = value as Record<string, unknown>;
  if (typeof q !== 'number' || !Number.isSafeInteger(q) || q <= 0) return null;
  if (typeof op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(op)) return null;
  if (op === 'eq' || op === 'neq') {
    return typeof operand === 'string' ? { q, op, value: operand } : null;
  }
  if (op === 'in') {
    return Array.isArray(operand) && operand.every((v) => typeof v === 'string') ? { q, op, value: operand as string[] } : null;
  }
  return { q, op: op as ConditionOp };
}

/** A draft question for validateConditions: its condition points at another draft question by INDEX. */
export interface DraftConditionQuestion {
  type: string;
  scope: ConditionScope;
  options?: readonly string[] | null;
  condition?: { target: number; op: string; value?: unknown } | null;
}

export type ConditionErrorCode =
  | 'condition_op_invalid'
  | 'condition_target_unknown'
  | 'condition_target_forward'
  | 'condition_target_type'
  | 'condition_target_scope'
  | 'condition_value_invalid';

export interface ConditionError {
  index: number;
  code: ConditionErrorCode;
}

const OPTION_TYPES = new Set(['select', 'checkbox']);
const FREE_TYPES = new Set(['text', 'textarea', 'number', 'date', 'email', 'phone']);

export const conditionOpsFor = (type: string): readonly ConditionOp[] =>
  OPTION_TYPES.has(type)
    ? type === 'checkbox' ? ['eq', 'neq', 'in', 'checked', 'answered'] : ['eq', 'neq', 'in', 'answered']
    : type === 'yesno'
      ? ['eq', 'neq', 'checked', 'answered']
      : FREE_TYPES.has(type) ? ['eq', 'neq', 'answered'] : [];

/** Whether `target` may be the subject of `question`'s condition (the position rule - it must come EARLIER - is the caller's):
 *  not a section or terms question, and a per-person target only for a per-person question. */
export function isConditionTargetAllowed(target: { type: string; scope: ConditionScope }, question: { scope: ConditionScope }): boolean {
  if (target.type === 'section' || target.type === 'terms') return false;
  if (target.scope === 'attendee' && question.scope !== 'attendee') return false;
  return conditionOpsFor(target.type).length > 0;
}

/**
 * Check every draft question's condition (questions in sort order): the target must exist, come
 * EARLIER (so there are no forward references or cycles), not be a section or terms question, and
 * be registration-scoped unless both questions are attendee-scoped; the operator must suit the
 * target's type and the value must be an existing option key (or yes/no, or a short string).
 * At most one error per question.
 */
export function validateConditions(questions: readonly DraftConditionQuestion[]): ConditionError[] {
  const errors: ConditionError[] = [];
  questions.forEach((question, index) => {
    const condition = question.condition;
    if (!condition) return;
    const fail = (code: ConditionErrorCode) => void errors.push({ index, code });
    const target = Number.isInteger(condition.target) ? questions[condition.target] : undefined;
    if (!target) return fail('condition_target_unknown');
    if (condition.target >= index) return fail('condition_target_forward');
    if (target.type === 'section' || target.type === 'terms') return fail('condition_target_type');
    if (target.scope === 'attendee' && question.scope !== 'attendee') return fail('condition_target_scope');
    const allowed = conditionOpsFor(target.type);
    if (!(allowed as readonly string[]).includes(condition.op)) return fail('condition_op_invalid');
    const op = condition.op as ConditionOp;
    const keys = (target.options ?? []) as readonly string[];
    const valid = (v: unknown): v is string =>
      typeof v === 'string'
      && (OPTION_TYPES.has(target.type) ? keys.includes(v)
        : target.type === 'yesno' ? v === 'yes' || v === 'no'
        : v.trim() !== '' && v.length <= MAX_VALUE_LENGTH);
    if (op === 'eq' || op === 'neq') {
      if (!valid(condition.value)) return fail('condition_value_invalid');
    } else if (op === 'in') {
      const list = condition.value;
      if (!Array.isArray(list) || list.length === 0 || list.length > 50 || !list.every(valid)) return fail('condition_value_invalid');
    } else if (condition.value !== undefined) {
      return fail('condition_value_invalid');
    }
  });
  return errors;
}
