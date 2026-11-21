// pledgeDb against a live, migrated D1 (workers project): campaigns and their
// localized text, the atomic pledge + schedule + history write, idempotent
// replays, the per-email brake, additional pledges, staff edits and archiving,
// and the goal progress summary.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  campaignPhase,
  campaignSummary,
  createCampaign,
  createPaperPledge,
  getCampaign,
  getCampaignTexts,
  getPublicCampaign,
  listInstallments,
  listPledgeEvents,
  listPledges,
  pledgeFingerprint,
  recordEmailOutcome,
  setPledgeArchived,
  submitOnlinePledge,
  updateCampaign,
  updatePledge,
  type CampaignInput,
  type OnlineSubmission,
  type PledgeWrite,
} from '../src/lib/pledgeDb';
import { calculatePledgePlan } from '../src/lib/pledgePlan';

const db = env.DB;

const campaignInput: CampaignInput = {
  slug: 'new-hall',
  status: 'published',
  pledgeOpens: '2026-11-01',
  pledgeCloses: '2027-02-15',
  givingStart: '2027-01-01',
  givingEnd: '2029-12-31',
  maxMonths: 36,
  goalCents: 100_000_00,
  householdGoal: 10,
  giftGuide: [
    { households: 1, totalCents: 50_000_00 },
    { households: 5, totalCents: 10_000_00 },
  ],
  text: { en: { title: 'A New Hall', intro: 'Pray first.' }, zh: { title: '新礼堂', intro: '先祷告。' } },
};

function write(over: Partial<{ name: string; email: string | null; amount: string; months: number }> = {}): PledgeWrite {
  const r = calculatePledgePlan(
    { mode: 'total', amount: over.amount ?? '1200', frequency: 'monthly', durationMonths: over.months ?? 12, startDate: '2027-01-01' },
    { givingStart: '2027-01-01', givingEnd: '2029-12-31', maxMonths: 36 },
  );
  if (!r.ok) throw new Error('bad plan');
  return {
    person: { name: over.name ?? 'Grace Chen', email: over.email === undefined ? 'grace@example.org' : over.email, phone: '', household: '', address: '' },
    plan: r.plan,
    givingMethod: 'online',
    givingNote: '',
    signerName: over.name ?? 'Grace Chen',
    consent: true,
    locale: 'en',
  };
}

async function online(campaignId: number, key: string, over: Parameters<typeof write>[0] = {}, originalCode: string | null = null) {
  const w = write(over);
  const s: OnlineSubmission = {
    ...w,
    idempotencyKey: key,
    fingerprint: await pledgeFingerprint({ name: w.person.name, email: w.person.email, total: w.plan.totalCents, originalCode }),
    originalCode,
    dayAgoUtc: '2000-01-01 00:00:00',
  };
  return submitOnlinePledge(db, campaignId, s);
}

let campaignId = 0;
beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM pledge_events'),
    db.prepare('DELETE FROM pledge_installments'),
    db.prepare('DELETE FROM pledges'),
    db.prepare('DELETE FROM pledge_campaign_i18n'),
    db.prepare('DELETE FROM pledge_campaigns'),
  ]);
  campaignId = await createCampaign(db, campaignInput);
});

describe('campaigns', () => {
  it('stores localized text with fallback and hides drafts from the public', async () => {
    expect((await getCampaign(db, campaignId, 'zh'))?.title).toBe('新礼堂');
    expect((await getCampaign(db, campaignId, 'ja'))?.title).toBe('A New Hall');
    expect((await getCampaignTexts(db, campaignId)).zh).toEqual({ title: '新礼堂', intro: '先祷告。' });
    expect((await getPublicCampaign(db, 'new-hall', 'en'))?.giftGuide).toHaveLength(2);
    const draft = await createCampaign(db, { ...campaignInput, slug: 'later', status: 'draft' });
    expect(draft).toBeGreaterThan(0);
    expect(await getPublicCampaign(db, 'later', 'en')).toBeNull();
  });

  it('creates a campaign in the given currency, defaulting to usd', async () => {
    const cad = await createCampaign(db, { ...campaignInput, slug: 'cad-hall', currency: 'cad' });
    expect((await getCampaign(db, cad, 'en'))?.currency).toBe('cad');
    expect((await getCampaign(db, campaignId, 'en'))?.currency).toBe('usd');
  });

  it('keeps the Giving fund link when a save leaves it out (Giving off) and clears it on an empty choice', async () => {
    await updateCampaign(db, campaignId, { ...campaignInput, fundId: 7 });
    expect((await getCampaign(db, campaignId, 'en'))?.fund_id).toBe(7);
    await updateCampaign(db, campaignId, { ...campaignInput, slug: 'new-hall' });
    expect((await getCampaign(db, campaignId, 'en'))?.fund_id).toBe(7);
    await updateCampaign(db, campaignId, { ...campaignInput, fundId: null });
    expect((await getCampaign(db, campaignId, 'en'))?.fund_id).toBeNull();
  });

  it('tells whether the pledge period is open on a date (inclusive)', () => {
    const c = { pledge_opens: '2026-11-01', pledge_closes: '2027-02-15' };
    expect(campaignPhase(c, '2026-10-31')).toBe('upcoming');
    expect(campaignPhase(c, '2026-11-01')).toBe('open');
    expect(campaignPhase(c, '2027-02-15')).toBe('open');
    expect(campaignPhase(c, '2027-02-16')).toBe('closed');
    expect(campaignPhase({ pledge_opens: null, pledge_closes: null }, '1990-01-01')).toBe('open');
  });
});

describe('online pledges', () => {
  it('writes the pledge, one row per gift, and a created event together', async () => {
    const r = await online(campaignId, '00000000-0000-4000-8000-000000000001');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toMatch(/^[A-Z]{8}$/);
    const gifts = await listInstallments(db, r.id);
    expect(gifts).toHaveLength(12);
    expect(gifts.reduce((s, g) => s + g.amount_cents, 0)).toBe(120000);
    const events = await listPledgeEvents(db, r.id);
    expect(events.map((e) => [e.action, e.actor])).toEqual([['created', '']]);
    expect((await listPledges(db, campaignId, false))[0].email_status).toBe('pending');
  });

  it('replays the same submission and refuses a reused key with changed fields', async () => {
    const key = '00000000-0000-4000-8000-000000000002';
    const first = await online(campaignId, key);
    const again = await online(campaignId, key);
    expect(again).toEqual(first.ok ? { ...first, replay: true } : first);
    expect(await online(campaignId, key, { amount: '999' })).toEqual({ ok: false, error: 'conflict' });
    expect(await listPledges(db, campaignId, false)).toHaveLength(1);
  });

  it('limits online pledges per email per day', async () => {
    for (let i = 0; i < 5; i++) expect((await online(campaignId, `00000000-0000-4000-8000-00000000010${i}`)).ok).toBe(true);
    expect(await online(campaignId, '00000000-0000-4000-8000-000000000199')).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('adds to an earlier pledge only with its code and the same email', async () => {
    const first = await online(campaignId, '00000000-0000-4000-8000-000000000003');
    if (!first.ok) throw new Error('first failed');
    expect(await online(campaignId, '00000000-0000-4000-8000-000000000004', { email: 'other@example.org' }, first.code))
      .toEqual({ ok: false, error: 'original_not_found' });
    const added = await online(campaignId, '00000000-0000-4000-8000-000000000005', { email: 'GRACE@example.org' }, first.code);
    expect(added.ok).toBe(true);
    const rows = await listPledges(db, campaignId, false);
    const child = rows.find((p) => added.ok && p.id === added.id)!;
    expect(child.pledge_type).toBe('additional');
    expect(child.parent_code).toBe(first.code);
  });
});

describe('staff work', () => {
  it('enters a paper card without email and records who did it', async () => {
    const r = await createPaperPledge(db, campaignId, write({ email: null, name: 'Li Wei' }), 'staff@example.org', null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [row] = await listPledges(db, campaignId, false);
    expect([row.source, row.email, row.email_status]).toEqual(['paper', null, 'none']);
    expect((await listPledgeEvents(db, r.id))[0].actor).toBe('staff@example.org');
  });

  it('edits a pledge, replacing its schedule and noting changed field names only', async () => {
    const r = await online(campaignId, '00000000-0000-4000-8000-000000000006');
    if (!r.ok) throw new Error('submit failed');
    expect(await updatePledge(db, r.id, write({ amount: '600', months: 6 }), 'staff@example.org')).toBe('ok');
    expect(await listInstallments(db, r.id)).toHaveLength(6);
    const [edited] = await listPledgeEvents(db, r.id);
    expect(edited.action).toBe('edited');
    expect(JSON.parse(edited.changes)).toEqual(['duration_months', 'total_cents']);
    expect(await updatePledge(db, r.id, write({ amount: '600', months: 6 }), 'staff@example.org')).toBe('unchanged');
  });

  it('archives out of every total, refuses edits while archived, and restores', async () => {
    const a = await online(campaignId, '00000000-0000-4000-8000-000000000007', { amount: '60000', email: 'a@example.org' });
    const b = await online(campaignId, '00000000-0000-4000-8000-000000000008', { amount: '12000', email: 'b@example.org' });
    const c = await createPaperPledge(db, campaignId, write({ amount: '500', email: null, name: 'Card Giver' }), 'staff@example.org', null);
    if (!a.ok || !b.ok || !c.ok) throw new Error('setup failed');
    const campaign = (await getCampaign(db, campaignId, 'en'))!;
    let s = await campaignSummary(db, campaign, '2000-01-01 00:00:00');
    expect([s.pledgeCount, s.households, s.totalCents]).toEqual([3, 3, 7250000]);
    expect(s.tiers.map((t) => t.households)).toEqual([1, 1]);
    expect(s.belowGuide).toBe(1);
    expect(s.byYear).toEqual([{ year: '2027', amountCents: 7250000 }]);
    expect(s.last7Days.pledges).toBe(3);

    expect(await setPledgeArchived(db, b.id, true, 'staff@example.org')).toBe(true);
    expect(await setPledgeArchived(db, b.id, true, 'staff@example.org')).toBe(false);
    expect(await updatePledge(db, b.id, write({ amount: '1' }), 'staff@example.org')).toBe('archived');
    s = await campaignSummary(db, campaign, '2000-01-01 00:00:00');
    expect([s.pledgeCount, s.totalCents]).toEqual([2, 6050000]);
    expect(await listPledges(db, campaignId, true)).toHaveLength(1);
    expect(await setPledgeArchived(db, b.id, false, 'staff@example.org')).toBe(true);
    expect((await listPledgeEvents(db, b.id)).map((e) => e.action)).toEqual(['restored', 'archived', 'created']);
  });

  it('counts an additional paper pledge without email toward the original household', async () => {
    const first = await online(campaignId, '00000000-0000-4000-8000-000000000010', { email: 'ruth@example.org', name: 'Ruth Park' });
    if (!first.ok) throw new Error('submit failed');
    const added = await createPaperPledge(db, campaignId, write({ email: null, name: 'R. Park' }), 'staff@example.org', first.code);
    expect(added.ok).toBe(true);
    const s = await campaignSummary(db, (await getCampaign(db, campaignId, 'en'))!, '2000-01-01 00:00:00');
    expect([s.pledgeCount, s.households]).toEqual([2, 1]);
  });

  it('records the confirmation outcome', async () => {
    const r = await online(campaignId, '00000000-0000-4000-8000-000000000009');
    if (!r.ok) throw new Error('submit failed');
    await recordEmailOutcome(db, r.id, false, '');
    expect((await listPledges(db, campaignId, false))[0].email_status).toBe('failed');
    await recordEmailOutcome(db, r.id, true, 'staff@example.org');
    expect((await listPledges(db, campaignId, false))[0].email_status).toBe('sent');
  });
});
