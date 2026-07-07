// Pure form parsing for the registration admin — no Astro, no DB — so the event
// editor and the question-builder both unit-test without a request lifecycle. The
// pages stay thin: they read the raw FormData, run it through here, and turn a
// rejection into a re-render (event form) or an error banner (question builder).
// Money crosses as integer cents (parseAmountToCents), datetimes as the app's UTC
// 'YYYY-MM-DD HH:MM:SS' text (datetimeLocalToUtc) — never floats, never a raw
// datetime-local string.
import { parseAmountToCents } from './givingCheckout';
import { datetimeLocalToUtc } from './dates';
import type { RegQuestion } from './regDb';

// ── Event editor ───────────────────────────────────────────────────────────

/** The normalized event fields ready for saveEvent (locale titles/descriptions,
 *  UTC datetimes, integer-cent price with NULL = free). */
export interface RegEventInput {
  title_en: string;
  title_zh: string;
  description_en: string;
  description_zh: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  capacity: number | null;
  price_cents: number | null;
  opens_at: string | null;
  closes_at: string | null;
  active: number;
}

export type RegEventFormResult =
  | { ok: true; data: RegEventInput }
  | { ok: false; errors: Record<string, string> };

/**
 * Parse the event create/edit form. Title (en) is required; a datetime-local
 * `starts_at` is required and every datetime is converted to the app's UTC text
 * (an unparseable one errors). Capacity is blank = unlimited (NULL) or a positive
 * whole number. Price is dollars: blank OR zero means FREE (price_cents NULL,
 * handled here BEFORE parseAmountToCents, whose $1.00 floor would otherwise reject
 * a free event); any other amount goes through parseAmountToCents and keeps that
 * $1 minimum, erroring below it. Errors are i18n keys keyed by field name.
 */
export function parseRegEventForm(fd: FormData): RegEventFormResult {
  const errors: Record<string, string> = {};
  const get = (n: string) => String(fd.get(n) ?? '').trim();

  // A datetime-local field → UTC 'YYYY-MM-DD HH:MM:SS'. A required blank or an
  // unparseable value records errors[name]; an optional blank is null.
  function dt(name: string, required: boolean): string | null {
    const raw = get(name);
    if (raw === '') {
      if (required) errors[name] = 'errors.datetimeInvalid';
      return null;
    }
    const utc = datetimeLocalToUtc(raw);
    if (utc === null) {
      errors[name] = 'errors.datetimeInvalid';
      return null;
    }
    return utc;
  }

  const title_en = get('title_en');
  if (title_en === '') errors.title_en = 'errors.required';

  const starts_at = dt('starts_at', true);
  const ends_at = dt('ends_at', false);
  const opens_at = dt('opens_at', false);
  const closes_at = dt('closes_at', false);

  const capRaw = get('capacity');
  let capacity: number | null = null;
  if (capRaw !== '') {
    if (!/^\d+$/.test(capRaw) || Number(capRaw) < 1) errors.capacity = 'errors.integerInvalid';
    else capacity = Number(capRaw);
  }

  const priceRaw = get('price');
  let price_cents: number | null = null;
  if (priceRaw !== '' && Number(priceRaw) !== 0) {
    const cents = parseAmountToCents(priceRaw);
    if (cents === null) errors.price = 'errors.amountInvalid';
    else price_cents = cents;
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      title_en,
      title_zh: get('title_zh'),
      description_en: get('description_en'),
      description_zh: get('description_zh'),
      starts_at: starts_at as string,
      ends_at,
      location: get('location') || null,
      capacity,
      price_cents,
      opens_at,
      closes_at,
      active: fd.get('active') !== null ? 1 : 0,
    },
  };
}

// ── Question builder ─────────────────────────────────────────────────────────

/** One parsed question row, shaped exactly as saveQuestions expects. */
export interface QuestionInput {
  id?: number;
  sort: number;
  type: RegQuestion['type'];
  required: number;
  options: string[] | null;
  label_en: string;
  label_zh: string;
}

export type QuestionsFormResult =
  | { ok: true; questions: QuestionInput[] }
  | { ok: false; error: 'bad_type' | 'missing_label' };

const QUESTION_TYPES: readonly RegQuestion['type'][] = ['text', 'textarea', 'select', 'checkbox', 'yesno'];
const NEEDS_OPTIONS = new Set<string>(['select', 'checkbox']);

/**
 * Parse the question-builder's indexed fields (`q[0][type]`, `q[0][label_en]`, …)
 * into saveQuestions input, in ascending index order. A wholly-empty row (an
 * untouched "add row") is dropped, mirroring the repeat-row convention. Otherwise
 * label (en) is required — a blank one rejects with 'missing_label'; an
 * unrecognized type rejects with 'bad_type'. Options are split one-per-line,
 * trimmed, and empties dropped — kept only for select/checkbox, null elsewhere.
 * `label_zh` passes through as-is (saveQuestions deletes the zh row when blank, so
 * an empty zh never persists as ''). A numeric `id` marks a surviving question
 * (its answers are preserved); `sort` falls back to the row's position when blank.
 */
export function parseQuestionsForm(fd: FormData): QuestionsFormResult {
  const rows = new Map<number, Record<string, string>>();
  for (const [key, value] of fd.entries()) {
    const m = /^q\[(\d+)\]\[([a-z_]+)\]$/.exec(key);
    if (!m) continue;
    const idx = Number(m[1]);
    const row = rows.get(idx) ?? {};
    row[m[2]] = typeof value === 'string' ? value : '';
    rows.set(idx, row);
  }

  const questions: QuestionInput[] = [];
  let position = 0;
  for (const idx of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(idx)!;
    const label_en = (row.label_en ?? '').trim();
    const label_zh = (row.label_zh ?? '').trim();
    const optionsRaw = row.options ?? '';

    // Drop an untouched row rather than erroring on it.
    if (label_en === '' && label_zh === '' && optionsRaw.trim() === '') continue;

    if (label_en === '') return { ok: false, error: 'missing_label' };
    const type = (row.type ?? '').trim();
    if (!QUESTION_TYPES.includes(type as RegQuestion['type'])) return { ok: false, error: 'bad_type' };

    const options = NEEDS_OPTIONS.has(type)
      ? optionsRaw
          .split('\n')
          .map((o) => o.trim())
          .filter((o) => o !== '')
      : null;

    const sortRaw = (row.sort ?? '').trim();
    const idRaw = (row.id ?? '').trim();
    const id = /^\d+$/.test(idRaw) ? Number(idRaw) : undefined;

    questions.push({
      ...(id !== undefined ? { id } : {}),
      sort: /^-?\d+$/.test(sortRaw) ? Number(sortRaw) : position,
      type: type as RegQuestion['type'],
      required: (row.required ?? '') !== '' ? 1 : 0,
      options,
      label_en,
      label_zh,
    });
    position++;
  }
  return { ok: true, questions };
}
