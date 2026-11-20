// Pure state model for the registration form builder island: question and ticket-type drafts, an
// undo-capable reducer, the save payload, client-side validation (the shared show-if validator plus the
// writer's field rules, so problems show before a round trip), and the mapping of server error paths to
// cards. React components stay thin views over this file; every mutation is unit-tested
// (test/regBuilderModel.test.ts). Imports only the dependency-free condition module, never server code.
import {
  conditionOpsFor,
  isConditionTargetAllowed,
  validateConditions,
  type ConditionOp,
  type ConditionScope,
} from '../../lib/regConditions';
import { uid } from '../builder/uid';

export const QUESTION_TYPES = ['text', 'textarea', 'select', 'checkbox', 'yesno', 'section', 'number', 'date', 'email', 'phone', 'terms'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const hasOptions = (type: string): boolean => type === 'select' || type === 'checkbox';
export const hasMaxLength = (type: string): boolean => type === 'text' || type === 'textarea';

/** Texts keyed by language code (only the languages the form is edited in). */
export type TextMap = Record<string, string>;

export interface DraftOption {
  /** Stable key; generated on the client for a new option so conditions can point at it before the first save. */
  key: string;
  labels: TextMap;
}

export interface DraftCondition {
  /** The target question's client id (`cid`). */
  q: string;
  op: ConditionOp;
  /** eq / neq operand. */
  value: string;
  /** `in` operand. */
  values: string[];
}

export interface DraftQuestion {
  /** Client id: stable across edits, reorders and saves. */
  cid: string;
  /** Server id; null until the question is first saved. */
  id: number | null;
  type: QuestionType;
  scope: ConditionScope;
  required: boolean;
  /** Text field: '' or the number as typed. */
  maxLength: string;
  labels: TextMap;
  help: TextMap;
  placeholder: TextMap;
  options: DraftOption[];
  condition: DraftCondition | null;
  /** Answers exist (informational: the writer refuses a scope change). */
  answered?: boolean;
}

export interface DraftTicket {
  cid: string;
  id: number | null;
  /** Dollars as typed ('' = free). */
  price: string;
  /** '' = unlimited. */
  capacity: string;
  active: boolean;
  labels: TextMap;
  descriptions: TextMap;
  /** People holding a seat on it (informational). */
  taken: number;
}

export interface FormDraft {
  questions: DraftQuestion[];
  tickets: DraftTicket[];
}

export interface FormState extends FormDraft {
  past: FormDraft[];
  future: FormDraft[];
  /** The edit being typed, so consecutive keystrokes in one field share one undo step. */
  lastEdit: string | null;
}

const HISTORY_CAP = 100;

// ── Drafts from stored data ─────────────────────────────────────────────────

export interface StoredQuestion {
  id: number;
  type: string;
  scope: string;
  required: number;
  options: string[] | null;
  condition: { q: number; op: string; value?: string | string[] } | null;
  max_length: number | null;
  labels: Partial<Record<string, string>>;
  help: Partial<Record<string, string>>;
  placeholder: Partial<Record<string, string>>;
  option_labels: Partial<Record<string, Record<string, string>>>;
}

export interface StoredTicket {
  id: number;
  price_cents: number;
  capacity: number | null;
  active: number;
  labels: Partial<Record<string, string>>;
  descriptions: Partial<Record<string, string>>;
  taken?: number;
}

const pick = (map: Partial<Record<string, string>>, locales: readonly string[]): TextMap => {
  const out: TextMap = {};
  for (const code of locales) out[code] = map[code] ?? '';
  return out;
};

export const centsToDollars = (cents: number): string => (cents > 0 ? (cents / 100).toFixed(2) : '');

/** '' / '0' = free; otherwise a decimal with at most two places. NaN when not a price. */
export function dollarsToCents(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  if (!/^\d{1,7}(\.\d{1,2})?$/u.test(trimmed)) return Number.NaN;
  return Math.round(Number(trimmed) * 100);
}

/** The editable drafts for stored questions and ticket types, texts restricted to `locales`. */
export function toDrafts(questions: readonly StoredQuestion[], tickets: readonly StoredTicket[], locales: readonly string[]): FormDraft {
  const cidById = new Map<number, string>();
  const drafts: DraftQuestion[] = questions.map((q) => {
    const cid = uid();
    cidById.set(q.id, cid);
    return {
      cid,
      id: q.id,
      type: (QUESTION_TYPES as readonly string[]).includes(q.type) ? (q.type as QuestionType) : 'text',
      scope: q.scope === 'attendee' ? 'attendee' : 'registration',
      required: q.required === 1,
      maxLength: q.max_length == null ? '' : String(q.max_length),
      labels: pick(q.labels, locales),
      help: pick(q.help, locales),
      placeholder: pick(q.placeholder, locales),
      options: (q.options ?? []).map((key) => ({
        key,
        labels: Object.fromEntries(locales.map((code) => [code, q.option_labels[code]?.[key] ?? ''])),
      })),
      condition: null,
    };
  });
  questions.forEach((q, i) => {
    const c = q.condition;
    const target = c ? cidById.get(c.q) : undefined;
    if (!c || !target) return;
    drafts[i].condition = {
      q: target,
      op: c.op as ConditionOp,
      value: typeof c.value === 'string' ? c.value : '',
      values: Array.isArray(c.value) ? [...c.value] : [],
    };
  });
  return {
    questions: drafts,
    tickets: tickets.map((t) => ({
      cid: uid(),
      id: t.id,
      price: centsToDollars(t.price_cents),
      capacity: t.capacity == null ? '' : String(t.capacity),
      active: t.active === 1,
      labels: pick(t.labels, locales),
      descriptions: pick(t.descriptions, locales),
      taken: t.taken ?? 0,
    })),
  };
}

export function initialState(draft: FormDraft): FormState {
  return { ...draft, past: [], future: [], lastEdit: null };
}

/** After a successful save: adopt the server's drafts (ids, generated keys) but keep each card's client id by position. */
export function adoptSaved(state: FormState, saved: FormDraft): FormState {
  const questions = saved.questions.map((q, i) => ({ ...q, cid: state.questions[i]?.cid ?? q.cid }));
  // conditions in `saved` point at the server drafts' own cids; re-point them at the kept ones
  const remap = new Map(saved.questions.map((q, i) => [q.cid, questions[i].cid]));
  for (const q of questions) if (q.condition) q.condition = { ...q.condition, q: remap.get(q.condition.q) ?? q.condition.q };
  const tickets = saved.tickets.map((t, i) => ({ ...t, cid: state.tickets[i]?.cid ?? t.cid }));
  return { questions, tickets, past: [], future: [], lastEdit: null };
}

// ── Fresh rows ──────────────────────────────────────────────────────────────

export function newOptionKey(taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
    const key = `o${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`;
    if (!taken.has(key)) return key;
  }
}

export function newOption(taken: ReadonlySet<string> = new Set()): DraftOption {
  return { key: newOptionKey(taken), labels: {} };
}

export function newQuestion(type: QuestionType, locales: readonly string[]): DraftQuestion {
  const blank = (): TextMap => Object.fromEntries(locales.map((code) => [code, '']));
  return {
    cid: uid(), id: null, type, scope: 'registration', required: false, maxLength: '',
    labels: blank(), help: blank(), placeholder: blank(),
    options: hasOptions(type) ? [newOption(), newOption()] : [],
    condition: null,
  };
}

export function newTicket(locales: readonly string[]): DraftTicket {
  const blank = (): TextMap => Object.fromEntries(locales.map((code) => [code, '']));
  return { cid: uid(), id: null, price: '', capacity: '', active: true, labels: blank(), descriptions: blank(), taken: 0 };
}

// ── Reducer ─────────────────────────────────────────────────────────────────

export type FormAction =
  | { type: 'addQuestion'; question: DraftQuestion; index?: number }
  | { type: 'removeQuestion'; cid: string }
  | { type: 'moveQuestion'; cid: string; to: number }
  | { type: 'nudgeQuestion'; cid: string; direction: -1 | 1 }
  | { type: 'patchQuestion'; cid: string; patch: Partial<Pick<DraftQuestion, 'type' | 'scope' | 'required' | 'maxLength'>> }
  | { type: 'setText'; cid: string; field: 'labels' | 'help' | 'placeholder'; locale: string; value: string }
  | { type: 'addOption'; cid: string; option: DraftOption }
  | { type: 'removeOption'; cid: string; key: string }
  | { type: 'moveOption'; cid: string; key: string; direction: -1 | 1 }
  | { type: 'setOptionLabel'; cid: string; key: string; locale: string; value: string }
  | { type: 'setCondition'; cid: string; condition: DraftCondition | null }
  | { type: 'addTicket'; ticket: DraftTicket }
  | { type: 'removeTicket'; cid: string }
  | { type: 'moveTicket'; cid: string; to: number }
  | { type: 'nudgeTicket'; cid: string; direction: -1 | 1 }
  | { type: 'patchTicket'; cid: string; patch: Partial<Pick<DraftTicket, 'price' | 'capacity' | 'active'>> }
  | { type: 'setTicketText'; cid: string; field: 'labels' | 'descriptions'; locale: string; value: string }
  | { type: 'saved'; draft: FormDraft }
  | { type: 'undo' }
  | { type: 'redo' };

const snapshot = (state: FormDraft): FormDraft => ({ questions: state.questions, tickets: state.tickets });

function commit(state: FormState, next: FormDraft, edit: string | null = null): FormState {
  // Consecutive keystrokes in the same field are one undo step.
  const coalesce = edit !== null && edit === state.lastEdit && state.past.length > 0;
  return {
    ...next,
    past: coalesce ? state.past : [...state.past.slice(-(HISTORY_CAP - 1)), snapshot(state)],
    future: [],
    lastEdit: edit,
  };
}

const moveItem = <T>(list: readonly T[], from: number, to: number): T[] => {
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
};

/** The questions whose condition points at `cid` (what blocks deleting it). */
export function dependentsOf(questions: readonly DraftQuestion[], cid: string): DraftQuestion[] {
  return questions.filter((q) => q.condition?.q === cid);
}

const withQuestion = (state: FormState, cid: string, change: (q: DraftQuestion) => DraftQuestion): DraftQuestion[] | null => {
  if (!state.questions.some((q) => q.cid === cid)) return null;
  return state.questions.map((q) => (q.cid === cid ? change(q) : q));
};
const withTicket = (state: FormState, cid: string, change: (t: DraftTicket) => DraftTicket): DraftTicket[] | null => {
  if (!state.tickets.some((t) => t.cid === cid)) return null;
  return state.tickets.map((t) => (t.cid === cid ? change(t) : t));
};

export function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'undo': {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return { ...prev, past: state.past.slice(0, -1), future: [snapshot(state), ...state.future], lastEdit: null };
    }
    case 'redo': {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { ...next, past: [...state.past, snapshot(state)], future: rest, lastEdit: null };
    }
    case 'saved':
      return adoptSaved(state, action.draft);

    case 'addQuestion': {
      const questions = [...state.questions];
      questions.splice(Math.min(action.index ?? questions.length, questions.length), 0, action.question);
      return commit(state, { ...state, questions });
    }
    case 'removeQuestion': {
      // A question another question's condition points at cannot be deleted; the view says which ones.
      if (dependentsOf(state.questions, action.cid).length > 0) return state;
      if (!state.questions.some((q) => q.cid === action.cid)) return state;
      return commit(state, { ...state, questions: state.questions.filter((q) => q.cid !== action.cid) });
    }
    case 'moveQuestion': {
      const from = state.questions.findIndex((q) => q.cid === action.cid);
      if (from < 0 || action.to === from || action.to < 0 || action.to >= state.questions.length) return state;
      return commit(state, { ...state, questions: moveItem(state.questions, from, action.to) });
    }
    case 'nudgeQuestion': {
      const from = state.questions.findIndex((q) => q.cid === action.cid);
      return from < 0 ? state : formReducer(state, { type: 'moveQuestion', cid: action.cid, to: from + action.direction });
    }
    case 'patchQuestion': {
      const questions = withQuestion(state, action.cid, (q) => {
        const next = { ...q, ...action.patch };
        if (action.patch.type && action.patch.type !== q.type) {
          if (action.patch.type === 'section') next.required = false;
          if (!hasMaxLength(action.patch.type)) next.maxLength = '';
          if (hasOptions(action.patch.type) && next.options.length === 0) next.options = [newOption(), newOption()];
        }
        return next;
      });
      if (!questions) return state;
      const edit = `patch:${action.cid}:${Object.keys(action.patch).join(',')}`;
      return commit(state, { ...state, questions }, 'maxLength' in action.patch ? edit : null);
    }
    case 'setText': {
      const questions = withQuestion(state, action.cid, (q) => ({ ...q, [action.field]: { ...q[action.field], [action.locale]: action.value } }));
      return questions ? commit(state, { ...state, questions }, `text:${action.cid}:${action.field}:${action.locale}`) : state;
    }
    case 'addOption': {
      const questions = withQuestion(state, action.cid, (q) => ({ ...q, options: [...q.options, action.option] }));
      return questions ? commit(state, { ...state, questions }) : state;
    }
    case 'removeOption': {
      const questions = withQuestion(state, action.cid, (q) => ({
        ...q,
        options: q.options.filter((o) => o.key !== action.key),
        // a condition aimed at this question that used the option loses it
      }));
      if (!questions) return state;
      return commit(state, { ...state, questions: scrubConditionValues(questions, action.cid, action.key) });
    }
    case 'moveOption': {
      const questions = withQuestion(state, action.cid, (q) => {
        const from = q.options.findIndex((o) => o.key === action.key);
        const to = from + action.direction;
        return from < 0 || to < 0 || to >= q.options.length ? q : { ...q, options: moveItem(q.options, from, to) };
      });
      if (!questions || questions === state.questions) return state;
      const before = state.questions.find((q) => q.cid === action.cid)!.options.map((o) => o.key).join();
      const after = questions.find((q) => q.cid === action.cid)!.options.map((o) => o.key).join();
      return before === after ? state : commit(state, { ...state, questions });
    }
    case 'setOptionLabel': {
      const questions = withQuestion(state, action.cid, (q) => ({
        ...q,
        options: q.options.map((o) => (o.key === action.key ? { ...o, labels: { ...o.labels, [action.locale]: action.value } } : o)),
      }));
      return questions ? commit(state, { ...state, questions }, `opt:${action.cid}:${action.key}:${action.locale}`) : state;
    }
    case 'setCondition': {
      const questions = withQuestion(state, action.cid, (q) => ({ ...q, condition: action.condition }));
      return questions ? commit(state, { ...state, questions }, action.condition?.op === 'eq' && action.condition.value !== '' ? `cond:${action.cid}` : null) : state;
    }

    case 'addTicket': {
      return commit(state, { ...state, tickets: [...state.tickets, action.ticket] });
    }
    case 'removeTicket': {
      if (!state.tickets.some((t) => t.cid === action.cid)) return state;
      return commit(state, { ...state, tickets: state.tickets.filter((t) => t.cid !== action.cid) });
    }
    case 'moveTicket': {
      const from = state.tickets.findIndex((t) => t.cid === action.cid);
      if (from < 0 || action.to === from || action.to < 0 || action.to >= state.tickets.length) return state;
      return commit(state, { ...state, tickets: moveItem(state.tickets, from, action.to) });
    }
    case 'nudgeTicket': {
      const from = state.tickets.findIndex((t) => t.cid === action.cid);
      return from < 0 ? state : formReducer(state, { type: 'moveTicket', cid: action.cid, to: from + action.direction });
    }
    case 'patchTicket': {
      const tickets = withTicket(state, action.cid, (t) => ({ ...t, ...action.patch }));
      if (!tickets) return state;
      const typed = 'price' in action.patch || 'capacity' in action.patch;
      return commit(state, { ...state, tickets }, typed ? `ticket:${action.cid}:${Object.keys(action.patch).join(',')}` : null);
    }
    case 'setTicketText': {
      const tickets = withTicket(state, action.cid, (t) => ({ ...t, [action.field]: { ...t[action.field], [action.locale]: action.value } }));
      return tickets ? commit(state, { ...state, tickets }, `ticketText:${action.cid}:${action.field}:${action.locale}`) : state;
    }
  }
}

/** Drop a removed option key from every condition that targets `cid`. */
function scrubConditionValues(questions: DraftQuestion[], cid: string, key: string): DraftQuestion[] {
  return questions.map((q) => {
    const c = q.condition;
    if (!c || c.q !== cid) return q;
    return { ...q, condition: { ...c, value: c.value === key ? '' : c.value, values: c.values.filter((v) => v !== key) } };
  });
}

// ── Condition targets and wording ───────────────────────────────────────────

/** The questions `questions[index]`'s condition may point at: EARLIER, not a section / terms question, and
 *  per-person only for a per-person question (the shared validator's rule). */
export function conditionTargets(questions: readonly DraftQuestion[], index: number): DraftQuestion[] {
  const question = questions[index];
  if (!question) return [];
  return questions.slice(0, index).filter((target) => isConditionTargetAllowed(target, question));
}

export const conditionOps = (type: string): readonly ConditionOp[] => conditionOpsFor(type);

/** The condition to start from when a target is picked (first operator that suits it). */
export function defaultCondition(target: DraftQuestion): DraftCondition {
  const op = conditionOpsFor(target.type)[0] ?? 'answered';
  return { q: target.cid, op, value: defaultValue(target, op), values: [] };
}

function defaultValue(target: DraftQuestion, op: ConditionOp): string {
  if (op !== 'eq' && op !== 'neq') return '';
  if (target.type === 'yesno') return 'yes';
  return hasOptions(target.type) ? (target.options[0]?.key ?? '') : '';
}

/** Re-point a condition at another operator/target, repairing the operand so it stays valid. */
export function withOp(condition: DraftCondition, target: DraftQuestion, op: ConditionOp): DraftCondition {
  return { q: condition.q, op, value: op === 'eq' || op === 'neq' ? condition.value || defaultValue(target, op) : '', values: op === 'in' ? condition.values : [] };
}

export interface SentenceContext {
  locale: string;
  /** Template strings keyed `eq` | `neq` | `in` | `checked` | `answered` with {q} and {v}, plus `untitled`, `yes`, `no`. */
  text: Record<string, string>;
}

const labelOf = (map: TextMap, locale: string, fallback: string): string => map[locale]?.trim() || fallback;

/** "Show only if 'Need childcare?' is Yes" in the editing language, or '' when the question has no (valid) condition. */
export function conditionSentence(questions: readonly DraftQuestion[], index: number, ctx: SentenceContext): string {
  const condition = questions[index]?.condition;
  const target = condition ? questions.find((q) => q.cid === condition.q) : undefined;
  if (!condition || !target) return '';
  const valueLabel = (key: string): string =>
    target.type === 'yesno' ? (ctx.text[key === 'no' ? 'no' : 'yes'] ?? key) : labelOf(target.options.find((o) => o.key === key)?.labels ?? {}, ctx.locale, key);
  const v =
    condition.op === 'in'
      ? condition.values.map(valueLabel).join(', ')
      : condition.op === 'eq' || condition.op === 'neq'
        ? target.type === 'yesno' || hasOptions(target.type) ? valueLabel(condition.value) : condition.value
        : '';
  return (ctx.text[condition.op] ?? '')
    .replace('{q}', labelOf(target.labels, ctx.locale, ctx.text.untitled ?? ''))
    .replace('{v}', v);
}

// ── Save payload ────────────────────────────────────────────────────────────

export interface FormPayload {
  questions: Array<Record<string, unknown>>;
  tickets: Array<Record<string, unknown>>;
}

const textPayload = (map: TextMap, locales: readonly string[]): Record<string, string> =>
  Object.fromEntries(locales.map((code) => [code, (map[code] ?? '').trim()]));

/** The JSON the writer takes. Every question carries its `cid` as `key` so conditions can name a not-yet-saved question. */
export function buildPayload(draft: FormDraft, locales: readonly string[], opts: { includeTickets?: boolean } = {}): FormPayload {
  const questions = draft.questions.map((q) => ({
    ...(q.id !== null ? { id: q.id } : {}),
    key: q.cid,
    type: q.type,
    scope: q.scope,
    required: q.type === 'section' ? false : q.required,
    ...(hasMaxLength(q.type) ? { max_length: q.maxLength.trim() === '' ? null : Number(q.maxLength) } : {}),
    labels: textPayload(q.labels, locales),
    help: textPayload(q.help, locales),
    placeholder: textPayload(q.placeholder, locales),
    ...(hasOptions(q.type) ? { options: q.options.map((o) => ({ key: o.key, labels: textPayload(o.labels, locales) })) } : {}),
    condition: q.condition
      ? {
          q: q.condition.q,
          op: q.condition.op,
          ...(q.condition.op === 'eq' || q.condition.op === 'neq' ? { value: q.condition.value } : {}),
          ...(q.condition.op === 'in' ? { value: q.condition.values } : {}),
        }
      : null,
  }));
  const tickets = draft.tickets.map((t) => ({
    ...(t.id !== null ? { id: t.id } : {}),
    price_cents: dollarsToCents(t.price),
    capacity: t.capacity.trim() === '' ? null : Number(t.capacity),
    active: t.active,
    labels: textPayload(t.labels, locales),
    descriptions: textPayload(t.descriptions, locales),
  }));
  return { questions, tickets: opts.includeTickets === false ? [] : tickets };
}

// ── Validation and error paths ──────────────────────────────────────────────

export interface FormIssue {
  path: string;
  code: string;
}

/** Client-side check mirroring the writer: required default-language texts, options, numbers, and the shared show-if validator. */
export function validateDraft(draft: FormDraft, defaultLocale: string, opts: { d1?: boolean } = {}): FormIssue[] {
  const issues: FormIssue[] = [];
  draft.questions.forEach((q, i) => {
    const at = (field: string) => `questions.${i}.${field}`;
    if (!q.labels[defaultLocale]?.trim()) issues.push({ path: at(`labels.${defaultLocale}`), code: 'required' });
    if (hasOptions(q.type)) {
      if (q.options.length === 0) issues.push({ path: at('options'), code: 'required' });
      q.options.forEach((o, j) => {
        if (!o.labels[defaultLocale]?.trim()) issues.push({ path: at(`options.${j}.labels.${defaultLocale}`), code: 'required' });
      });
    }
    if (hasMaxLength(q.type) && q.maxLength.trim() !== '') {
      const n = Number(q.maxLength);
      if (!Number.isInteger(n) || n < 1 || n > 5000) issues.push({ path: at('max_length'), code: 'invalid' });
    }
    if (q.condition && !draft.questions.some((other) => other.cid === q.condition!.q)) issues.push({ path: at('condition.q'), code: 'condition_target_unknown' });
  });
  issues.push(...conditionIssues(draft.questions));
  draft.tickets.forEach((t, i) => {
    const at = (field: string) => `tickets.${i}.${field}`;
    if (!t.labels[defaultLocale]?.trim()) issues.push({ path: at(`labels.${defaultLocale}`), code: 'required' });
    const cents = dollarsToCents(t.price);
    if (Number.isNaN(cents)) issues.push({ path: at('price_cents'), code: 'invalid' });
    else if (cents > 0 && opts.d1) issues.push({ path: at('price_cents'), code: 'paid_unavailable' });
    if (t.capacity.trim() !== '') {
      const n = Number(t.capacity);
      if (!Number.isInteger(n) || n < 1) issues.push({ path: at('capacity'), code: 'invalid' });
    }
  });
  return issues;
}

/** Just the show-if problems (cheap enough to run on every edit, so they show instantly). */
export function conditionIssues(questions: readonly DraftQuestion[]): FormIssue[] {
  const index = new Map(questions.map((q, i) => [q.cid, i]));
  const resolved = questions.map((q) => ({
    type: q.type,
    scope: q.scope,
    options: hasOptions(q.type) ? q.options.map((o) => o.key) : null,
    condition: q.condition && index.has(q.condition.q)
      ? { target: index.get(q.condition.q)!, op: q.condition.op, ...(q.condition.op === 'eq' || q.condition.op === 'neq' ? { value: q.condition.value } : q.condition.op === 'in' ? { value: q.condition.values } : {}) }
      : null,
  }));
  return validateConditions(resolved).map((e) => ({
    path: `questions.${e.index}.${e.code === 'condition_op_invalid' ? 'condition.op' : e.code === 'condition_value_invalid' ? 'condition.value' : 'condition.q'}`,
    code: e.code,
  }));
}

export type ErrorLocation =
  | { kind: 'question'; index: number; field: string }
  | { kind: 'ticket'; index: number; field: string }
  | { kind: 'form'; scope: 'questions' | 'tickets' | '' };

/** `questions.3.options.1.labels.en` -> card 3, field `options.1.labels.en`; `tickets` / '' -> a form-level message. */
export function parseErrorPath(path: string): ErrorLocation {
  const match = /^(questions|tickets)\.(\d+)(?:\.(.+))?$/u.exec(path);
  if (!match) return { kind: 'form', scope: path === 'questions' || path === 'tickets' ? path : '' };
  return { kind: match[1] === 'questions' ? 'question' : 'ticket', index: Number(match[2]), field: match[3] ?? '' };
}

/** Issues grouped per card: question index -> field -> code (first wins). */
export function issuesByCard(issues: readonly FormIssue[]): { questions: Map<number, Map<string, string>>; tickets: Map<number, Map<string, string>>; form: FormIssue[] } {
  const out = { questions: new Map<number, Map<string, string>>(), tickets: new Map<number, Map<string, string>>(), form: [] as FormIssue[] };
  for (const issue of issues) {
    const where = parseErrorPath(issue.path);
    if (where.kind === 'form') {
      out.form.push(issue);
      continue;
    }
    const bucket = where.kind === 'question' ? out.questions : out.tickets;
    const fields = bucket.get(where.index) ?? bucket.set(where.index, new Map()).get(where.index)!;
    if (!fields.has(where.field)) fields.set(where.field, issue.code);
  }
  return out;
}

/** Message key (under admin.regBuilder.err.) for an error on `field`. */
export function errorKey(field: string, code: string): string {
  if (code === 'invalid' && field === 'price_cents') return 'price';
  if (code === 'invalid' && field === 'capacity') return 'capacity';
  if (code === 'invalid' && field === 'max_length') return 'maxLength';
  return code;
}
