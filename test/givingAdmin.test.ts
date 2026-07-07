// Pure FormData parsing for the giving-admin surfaces (workers pool — FormData is
// a web global, no DB). parseManualGiftForm turns a check/cash entry into integer
// cents + a validated donor/fund/method/date; parseFundForm validates the fund
// create/edit form. Both are the request-lifecycle-free bits worth unit-testing.
import { describe, expect, it } from 'vitest';
import { parseManualGiftForm, parseFundForm } from '../src/lib/validate';

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe('parseManualGiftForm', () => {
  const base = { fund_id: '3', amount: '50', method: 'check', received_on: '2026-03-01', person_id: '7' };

  it('accepts a member check gift and returns integer cents', () => {
    const r = parseManualGiftForm(form({ ...base, check_number: '1024' }));
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.data).toEqual({
        fundId: 3,
        amountCents: 5000,
        method: 'check',
        checkNumber: '1024',
        personId: 7,
        donorName: null,
        receivedOn: '2026-03-01',
        note: null,
      });
  });

  it('accepts a guest cash gift and DROPS any check number (cash never carries one)', () => {
    const r = parseManualGiftForm(
      form({ fund_id: '2', amount: '12.50', method: 'cash', received_on: '2026-01-15', donor_name: 'Jane Doe', check_number: '999', note: 'tithe' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.data).toMatchObject({ fundId: 2, amountCents: 1250, method: 'cash', checkNumber: null, personId: null, donorName: 'Jane Doe', note: 'tithe' });
  });

  it('requires a donor — either a member id or a free-text name', () => {
    const r = parseManualGiftForm(form({ fund_id: '1', amount: '5', method: 'cash', received_on: '2026-02-02' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.donor).toBe('errors.required');
  });

  it('rejects a below-floor amount, a missing fund, a bad method, and a malformed date', () => {
    const r = parseManualGiftForm(form({ fund_id: 'x', amount: '0.50', method: 'venmo', received_on: 'nope', donor_name: 'X' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.amount).toBe('errors.amountInvalid');
      expect(r.errors.fund_id).toBe('errors.required');
      expect(r.errors.method).toBe('errors.invalidOption');
      expect(r.errors.received_on).toBe('errors.dateFormat');
    }
  });
});

describe('parseFundForm', () => {
  it('accepts a fund with both names, active on, explicit sort', () => {
    const r = parseFundForm(form({ fund_number: 'F1', name_en: 'General', name_zh: '总奉献', active: 'on', sort: '3' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ fund_number: 'F1', name_en: 'General', name_zh: '总奉献', active: true, sort: 3 });
  });

  it('requires fund_number and English name', () => {
    const r = parseFundForm(form({ name_zh: '只有中文' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.fund_number).toBe('errors.required');
      expect(r.errors.name_en).toBe('errors.required');
    }
  });

  it('allows an empty Chinese name (en fallback), defaulting sort 0 and active false', () => {
    const r = parseFundForm(form({ fund_number: 'F2', name_en: 'Missions' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ fund_number: 'F2', name_en: 'Missions', name_zh: '', active: false, sort: 0 });
  });

  it('rejects a non-integer sort', () => {
    const r = parseFundForm(form({ fund_number: 'F3', name_en: 'X', sort: '1.5' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.sort).toBe('errors.integerInvalid');
  });
});
