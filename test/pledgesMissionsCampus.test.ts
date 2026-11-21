// Multi-campus isolation for Pledges and Missions: every read and write goes
// through the request-scoped database, so one campus never sees another's
// campaigns, pledges (personal details), or mission trips.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { scopeDatabase } from '../src/lib/campusScope';
import {
  campaignSummary,
  createCampaign,
  getCampaign,
  getPublicCampaign,
  listCampaigns,
  listInstallments,
  listPledges,
  pledgeFingerprint,
  submitOnlinePledge,
  type CampaignInput,
} from '../src/lib/pledgeDb';
import { calculatePledgePlan } from '../src/lib/pledgePlan';
import { createTrip, listPublishedTrips, listTrips } from '../src/lib/missionDb';

const raw = env.DB;
const north = scopeDatabase(raw, 1);
const south = scopeDatabase(raw, 2);

const campaign: CampaignInput = {
  slug: 'hall', status: 'published', pledgeOpens: null, pledgeCloses: null, givingStart: '2027-01-01', givingEnd: '2029-12-31',
  maxMonths: 36, goalCents: null, householdGoal: null, giftGuide: [], text: { en: { title: 'North hall', intro: '' } },
};

beforeEach(async () => {
  await raw.batch([
    raw.prepare('DELETE FROM pledge_events'), raw.prepare('DELETE FROM pledge_installments'), raw.prepare('DELETE FROM pledges'),
    raw.prepare('DELETE FROM pledge_campaign_i18n'), raw.prepare('DELETE FROM pledge_campaigns'),
    raw.prepare('DELETE FROM mission_trip_photos'), raw.prepare('DELETE FROM mission_trip_i18n'), raw.prepare('DELETE FROM mission_trips'),
    raw.prepare(`INSERT INTO campuses (id, slug, name, active) VALUES (2, 'south', 'South', 1) ON CONFLICT(id) DO NOTHING`),
  ]);
});

describe('campus scoping', () => {
  it('keeps campaigns, pledges and their schedules inside one campus', async () => {
    const id = await createCampaign(north, campaign);
    const plan = calculatePledgePlan({ mode: 'total', amount: '1200', frequency: 'monthly', durationMonths: 12, startDate: '2027-01-01' },
      { givingStart: '2027-01-01', givingEnd: '2029-12-31', maxMonths: 36 });
    if (!plan.ok) throw new Error('plan');
    const r = await submitOnlinePledge(north, id, {
      person: { name: 'Ann', email: 'ann@example.org', phone: '', household: '', address: '' }, plan: plan.plan,
      givingMethod: 'online', givingNote: '', signerName: 'Ann', consent: true, locale: 'en',
      idempotencyKey: '00000000-0000-4000-8000-0000000000c1', fingerprint: await pledgeFingerprint({ a: 1 }), originalCode: null, dayAgoUtc: '2000-01-01 00:00:00',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = await raw.prepare('SELECT DISTINCT campus_id FROM pledge_installments').all<{ campus_id: number }>();
    expect(rows.results).toEqual([{ campus_id: 1 }]);
    expect(await listInstallments(north, r.id)).toHaveLength(12);

    expect(await listCampaigns(south, 'en')).toEqual([]);
    expect(await getCampaign(south, id, 'en')).toBeNull();
    expect(await getPublicCampaign(south, 'hall', 'en')).toBeNull();
    expect(await listPledges(south, id, false)).toEqual([]);
    expect(await listInstallments(south, r.id)).toEqual([]);
    // The same slug is free in another campus.
    const southId = await createCampaign(south, { ...campaign, text: { en: { title: 'South hall', intro: '' } } });
    expect((await getPublicCampaign(south, 'hall', 'en'))?.title).toBe('South hall');
    const s = await campaignSummary(south, (await getCampaign(south, southId, 'en'))!, '2000-01-01 00:00:00');
    expect([s.pledgeCount, s.totalCents]).toEqual([0, 0]);
  });

  it('keeps mission trips inside one campus', async () => {
    await createTrip(north, {
      slug: 'trip', status: 'published', year: 2026, startDate: null, endDate: null, countryCode: 'GH', latitude: 5, longitude: -1,
      teamSize: null, videoUrl: null, text: { en: { title: 'North trip', location: '', summary: '', story_md: '', team_note: '' } },
    });
    expect((await listPublishedTrips(north, 'en')).map((t) => t.title)).toEqual(['North trip']);
    expect(await listTrips(south, 'en')).toEqual([]);
    expect(await listPublishedTrips(south, 'en')).toEqual([]);
  });
});
