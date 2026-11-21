// Pledge plan arithmetic, gift guide parsing, codes, and form parsing (pure).
import { describe, expect, it } from 'vitest';
import {
  addMonthsClamped,
  calculatePledgePlan,
  guideTierIndex,
  householdKey,
  isPledgeCode,
  newPledgeCode,
  normalizePledgeCode,
  parseAmountCents,
  parseGiftGuide,
  giftGuideText,
  readGiftGuide,
} from '../src/lib/pledgePlan';
import { parseCampaignForm, parsePledgeForm } from '../src/lib/pledgeForms';

const bounds = { givingStart: '2027-01-01', givingEnd: '2029-12-31', maxMonths: 36 };

describe('calculatePledgePlan', () => {
  it('splits a total into monthly gifts with the remainder in the last one', () => {
    const r = calculatePledgePlan({ mode: 'total', amount: '1000', frequency: 'monthly', durationMonths: 3, startDate: '2027-01-15' }, bounds);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.schedule).toEqual([
      { date: '2027-01-15', amountCents: 33333 },
      { date: '2027-02-15', amountCents: 33333 },
      { date: '2027-03-15', amountCents: 33334 },
    ]);
    expect(r.plan.totalCents).toBe(100000);
    expect(r.plan.finalCents).toBe(33334);
    expect(r.plan.endDate).toBe('2027-03-15');
  });

  it('multiplies an installment by the number of gifts', () => {
    const r = calculatePledgePlan({ mode: 'installment', amount: '50', frequency: 'quarterly', durationMonths: 12, startDate: '2027-01-01' }, bounds);
    expect(r.ok && r.plan.count).toBe(4);
    expect(r.ok && r.plan.totalCents).toBe(20000);
    expect(r.ok && r.plan.schedule.map((g) => g.date)).toEqual(['2027-01-01', '2027-04-01', '2027-07-01', '2027-10-01']);
  });

  it('rounds the gift count up for a custom interval and treats one-time as a single gift', () => {
    const custom = calculatePledgePlan({ mode: 'installment', amount: '10', frequency: 'custom', intervalMonths: 5, durationMonths: 12, startDate: '2027-01-01' }, bounds);
    expect(custom.ok && custom.plan.count).toBe(3);
    const once = calculatePledgePlan({ mode: 'total', amount: '500', frequency: 'once', durationMonths: 0, startDate: '2028-06-01' }, bounds);
    expect(once.ok && once.plan.count).toBe(1);
    expect(once.ok && once.plan.durationMonths).toBe(1);
  });

  it('clamps month ends instead of skipping a month', () => {
    expect(addMonthsClamped('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    const r = calculatePledgePlan({ mode: 'installment', amount: '1', frequency: 'monthly', durationMonths: 3, startDate: '2027-01-31' }, bounds);
    expect(r.ok && r.plan.schedule.map((g) => g.date)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
  });

  it('keeps every gift inside the giving period and the plan inside the month limit', () => {
    expect(calculatePledgePlan({ mode: 'total', amount: '10', frequency: 'monthly', durationMonths: 3, startDate: '2026-12-31' }, bounds))
      .toEqual({ ok: false, errors: { startDate: true } });
    expect(calculatePledgePlan({ mode: 'total', amount: '10', frequency: 'monthly', durationMonths: 3, startDate: '2029-11-15' }, bounds))
      .toEqual({ ok: false, errors: { endDate: true } });
    expect(calculatePledgePlan({ mode: 'total', amount: '10', frequency: 'monthly', durationMonths: 37, startDate: '2027-01-01' }, bounds))
      .toEqual({ ok: false, errors: { duration: true } });
  });

  it('reports every bad input at once and refuses a total smaller than one cent per gift', () => {
    const r = calculatePledgePlan({ mode: 'x', amount: 'abc', frequency: 'weekly', durationMonths: 2, startDate: 'soon' }, bounds);
    expect(r).toEqual({ ok: false, errors: { amount: true, mode: true, frequency: true, startDate: true } });
    expect(calculatePledgePlan({ mode: 'total', amount: '0.02', frequency: 'monthly', durationMonths: 3, startDate: '2027-01-01' }, bounds))
      .toEqual({ ok: false, errors: { range: true } });
  });
});

describe('amounts and the gift guide', () => {
  it('parses money strings into integer cents', () => {
    expect(parseAmountCents('1,200.5')).toBe(120050);
    expect(parseAmountCents('$75')).toBe(7500);
    expect(parseAmountCents('1.234')).toBeNull();
    expect(parseAmountCents('-5')).toBeNull();
  });

  it('parses one "households x amount" row per line, largest first', () => {
    expect(parseGiftGuide('10 x 1000\n\n2 × $5,000\n')).toEqual({ ok: true, rows: [{ households: 2, totalCents: 500000 }, { households: 10, totalCents: 100000 }] });
    expect(parseGiftGuide('3 x 100\nmany x 5')).toEqual({ ok: false, line: 2 });
    expect(giftGuideText([{ households: 2, totalCents: 500000 }, { households: 1, totalCents: 12550 }])).toBe('2 x 5000\n1 x 125.50');
  });

  it('reads a stored guide defensively and places a household in the largest row it reaches', () => {
    expect(readGiftGuide('not json')).toEqual([]);
    const rows = readGiftGuide('[{"households":1,"totalCents":500000},{"households":5,"totalCents":100000}]');
    expect(guideTierIndex(rows, 600000)).toBe(0);
    expect(guideTierIndex(rows, 100000)).toBe(1);
    expect(guideTierIndex(rows, 99999)).toBe(-1);
  });
});

describe('codes and households', () => {
  it('makes eight-letter codes without I, L or O', () => {
    for (let i = 0; i < 200; i++) {
      const code = newPledgeCode();
      expect(isPledgeCode(code)).toBe(true);
      expect(code).not.toMatch(/[ILO]/);
    }
    expect(normalizePledgeCode(' kqwm-trzb ')).toBe('KQWMTRZB');
    expect(isPledgeCode('KQWMTRZ')).toBe(false);
  });

  it('counts a household by email, or by name for a card without one', () => {
    expect(householdKey({ email: ' Ann@Example.org ', name: 'Ann' })).toBe(householdKey({ email: 'ann@example.org', name: 'Someone' }));
    expect(householdKey({ email: null, name: 'Li  Wei' })).toBe(householdKey({ email: '', name: 'li wei' }));
  });
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const campaign = { giving_start: '2027-01-01', giving_end: '2029-12-31', max_months: 36 };
const valid = {
  name: 'Grace Chen',
  email: 'Grace@Example.org',
  pledge_type: 'initial',
  mode: 'total',
  amount: '3600',
  frequency: 'monthly',
  duration_months: '36',
  start_date: '2027-01-01',
  giving_method: 'online',
  signer_name: 'grace chen',
  consent: 'on',
  idempotency_key: '8d3c2a5e-1b4f-4c7a-9e2d-6f1a3b5c7d9e',
};

describe('parsePledgeForm', () => {
  it('accepts a complete public pledge and recalculates the plan', () => {
    const r = parsePledgeForm(form(valid), campaign, { staff: false, locale: 'en' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.write.person.email).toBe('grace@example.org');
    expect(r.value.write.plan.count).toBe(36);
    expect(r.value.write.plan.installmentCents).toBe(10000);
    expect(r.value.originalCode).toBeNull();
  });

  it('requires email, a matching typed signature, consent, and a fresh form key from the public', () => {
    const r = parsePledgeForm(form({ ...valid, email: '', signer_name: 'Someone Else', consent: '', idempotency_key: '' }), campaign, { staff: false, locale: 'en' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toMatchObject({ email: 'pledges.err.email', signer_name: 'pledges.err.signature', consent: 'pledges.err.consent', form: 'pledges.err.expired' });
  });

  it('lets staff enter a paper card without email, signature or consent', () => {
    const r = parsePledgeForm(form({ ...valid, email: '', signer_name: '', consent: '', idempotency_key: '', staff_note: 'Card 14' }), campaign, { staff: true, locale: 'zh' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.write.person.email).toBeNull();
      expect(r.value.write.staffNote).toBe('Card 14');
    }
  });

  it('needs a valid earlier code for an additional pledge and a note for "other" giving', () => {
    const r = parsePledgeForm(form({ ...valid, pledge_type: 'additional', original_code: 'abc', giving_method: 'other' }), campaign, { staff: false, locale: 'en' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toMatchObject({ original_code: 'pledges.err.originalCode', giving_note: 'pledges.err.givingNote' });
    const ok = parsePledgeForm(form({ ...valid, pledge_type: 'additional', original_code: 'kqwm-trzb' }), campaign, { staff: false, locale: 'en' });
    expect(ok.ok && ok.value.originalCode).toBe('KQWMTRZB');
  });

  it('maps plan problems onto the fields that caused them', () => {
    const r = parsePledgeForm(form({ ...valid, start_date: '2029-12-01' }), campaign, { staff: false, locale: 'en' });
    expect(!r.ok && r.errors.duration_months).toBe('pledges.err.plan.endDate');
  });
});

describe('parseCampaignForm', () => {
  const base = {
    slug: 'building-fund',
    status: 'published',
    giving_start: '2027-01-01',
    giving_end: '2029-12-31',
    max_months: '36',
    goal: '2,500,000',
    household_goal: '300',
    gift_guide: '1 x 100000\n10 x 10000',
    title_en: 'Building for Tomorrow',
    intro_en: 'Pray, then pledge.',
    title_zh: '',
    intro_zh: '',
  };
  it('parses a campaign with localized text and a gift guide', () => {
    const r = parseCampaignForm(form(base));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.goalCents).toBe(250000000);
    expect(r.value.giftGuide).toHaveLength(2);
    expect(r.value.text.en).toEqual({ title: 'Building for Tomorrow', intro: 'Pray, then pledge.' });
    expect(r.value.text.zh).toEqual({ title: '', intro: '' });
    expect(r.value.pledgeOpens).toBeNull();
  });
  it('rejects a bad slug, reversed periods, a bad guide line, and a missing title', () => {
    const r = parseCampaignForm(form({ ...base, slug: 'Bad Slug', giving_end: '2026-01-01', pledge_opens: '2027-02-01', pledge_closes: '2027-01-01', gift_guide: 'lots', title_en: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toMatchObject({
        slug: 'pledges.admin.err.slug',
        giving_end: 'pledges.admin.err.dateOrder',
        pledge_closes: 'pledges.admin.err.dateOrder',
        gift_guide: 'pledges.admin.err.giftGuide',
        title: 'pledges.admin.err.title',
      });
    }
  });
});
