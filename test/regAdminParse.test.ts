// Pure parsers for the registration admin (no DB, no request lifecycle): the
// event editor's money/date/capacity normalization and the question builder's
// indexed-field → saveQuestions mapping. Runs ungated in the workers project.
import { describe, expect, it } from 'vitest';
import { parseRegEventForm, parseQuestionsForm } from '../src/lib/regForms';

/** Build a FormData from a plain record; array values append repeats. */
function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  }
  return fd;
}

describe('parseRegEventForm', () => {
  const base = { title_en: 'Retreat', starts_at: '2026-09-01T09:00' };

  it('parses a full paid event', () => {
    const r = parseRegEventForm(
      form({ ...base, title_zh: '退修会', description_en: 'Come', capacity: '40', price: '25', location: 'Camp', active: 'on' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.title_en).toBe('Retreat');
    expect(r.data.title_zh).toBe('退修会');
    expect(r.data.capacity).toBe(40);
    expect(r.data.price_cents).toBe(2500);
    expect(r.data.location).toBe('Camp');
    expect(r.data.active).toBe(1);
    expect(r.data.starts_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('empty price is free (NULL), not an error', () => {
    const r = parseRegEventForm(form({ ...base, price: '' }));
    expect(r.ok && r.data.price_cents).toBe(null);
  });

  it('zero price is free (NULL) — handled before the $1 floor', () => {
    for (const price of ['0', '0.00', '0.0']) {
      const r = parseRegEventForm(form({ ...base, price }));
      expect(r.ok && r.data.price_cents).toBe(null);
    }
  });

  it('a positive amount below $1.00 is rejected (floor kept for paid events)', () => {
    const r = parseRegEventForm(form({ ...base, price: '0.50' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.price).toBe('errors.amountInvalid');
  });

  it('a non-numeric price is rejected', () => {
    const r = parseRegEventForm(form({ ...base, price: 'free' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.price).toBe('errors.amountInvalid');
  });

  it('blank capacity is unlimited (NULL); a non-positive one errors', () => {
    expect((parseRegEventForm(form({ ...base, capacity: '' })) as { data: { capacity: number | null } }).data.capacity).toBe(null);
    const bad = parseRegEventForm(form({ ...base, capacity: '0' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.capacity).toBe('errors.integerInvalid');
  });

  it('requires a title (en)', () => {
    const r = parseRegEventForm(form({ starts_at: '2026-09-01T09:00' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.title_en).toBe('errors.required');
  });

  it('requires a valid starts_at and rejects a malformed one', () => {
    expect(parseRegEventForm(form({ title_en: 'X' })).ok).toBe(false);
    const bad = parseRegEventForm(form({ title_en: 'X', starts_at: 'not-a-date' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.starts_at).toBe('errors.datetimeInvalid');
  });

  it('optional windows: blank opens/closes stay null, a bad one errors', () => {
    const ok = parseRegEventForm(form({ ...base, opens_at: '', closes_at: '2026-08-30T00:00' }));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.data.opens_at).toBe(null);
      expect(ok.data.closes_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
    const bad = parseRegEventForm(form({ ...base, opens_at: 'xyz' }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.opens_at).toBe('errors.datetimeInvalid');
  });
});

describe('parseQuestionsForm', () => {
  it('maps indexed fields into ordered saveQuestions input', () => {
    const r = parseQuestionsForm(
      form({
        'q[0][id]': '7',
        'q[0][sort]': '0',
        'q[0][type]': 'text',
        'q[0][required]': '1',
        'q[0][label_en]': 'Full name',
        'q[0][label_zh]': '姓名',
        'q[1][sort]': '1',
        'q[1][type]': 'select',
        'q[1][label_en]': 'Shirt size',
        'q[1][label_zh]': '',
        'q[1][options]': 'S\nM\nL',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.questions).toEqual([
      { id: 7, sort: 0, type: 'text', required: 1, options: null, label_en: 'Full name', label_zh: '姓名' },
      { sort: 1, type: 'select', required: 0, options: ['S', 'M', 'L'], label_en: 'Shirt size', label_zh: '' },
    ]);
  });

  it('splits, trims, and drops empty option lines (select/checkbox only)', () => {
    const r = parseQuestionsForm(
      form({ 'q[0][type]': 'checkbox', 'q[0][label_en]': 'Meals', 'q[0][options]': '  Beef \n\n Veg \n' }),
    );
    expect(r.ok && r.questions[0].options).toEqual(['Beef', 'Veg']);
  });

  it('drops options for a non-option type', () => {
    const r = parseQuestionsForm(form({ 'q[0][type]': 'text', 'q[0][label_en]': 'Name', 'q[0][options]': 'ignored' }));
    // options present makes the row non-blank; label_en is set, so it is kept with null options.
    expect(r.ok && r.questions[0].options).toBe(null);
  });

  it('skips a wholly-empty row', () => {
    const r = parseQuestionsForm(
      form({
        'q[0][type]': 'text',
        'q[0][label_en]': '',
        'q[0][label_zh]': '',
        'q[0][options]': '',
        'q[1][type]': 'text',
        'q[1][label_en]': 'Kept',
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.questions.map((q) => q.label_en)).toEqual(['Kept']);
  });

  it('rejects a bad type', () => {
    const r = parseQuestionsForm(form({ 'q[0][type]': 'radio', 'q[0][label_en]': 'X' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('bad_type');
  });

  it('rejects a started row missing its en label', () => {
    const r = parseQuestionsForm(form({ 'q[0][type]': 'text', 'q[0][label_en]': '', 'q[0][label_zh]': '有中文' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('missing_label');
  });

  it('falls back to row position for a blank sort', () => {
    const r = parseQuestionsForm(
      form({ 'q[0][type]': 'text', 'q[0][label_en]': 'A', 'q[5][type]': 'text', 'q[5][label_en]': 'B' }),
    );
    expect(r.ok && r.questions.map((q) => q.sort)).toEqual([0, 1]);
  });

  it('returns an empty set when no rows are present', () => {
    expect(parseQuestionsForm(form({ action: 'saveQuestions' }))).toEqual({ ok: true, questions: [] });
  });
});
