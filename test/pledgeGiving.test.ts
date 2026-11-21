// Pledges ↔ Giving matching (pure) and the gate that keeps a D1 installation
// (or any installation with Giving off) from ever querying the giving tables.
import { describe, expect, it } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import { campaignGiftWindow, canSeePledgeGiving, loadPledgeGiving, matchPledgeGiving, type PledgeForMatch } from '../src/lib/pledgeGiving';
import type { SessionUser } from '../src/lib/types';
import type { Campaign } from '../src/lib/pledgeDb';

const pledge = (over: Partial<PledgeForMatch> & { id: number }): PledgeForMatch => ({
  name: 'Ann', email: 'ann@example.org', root_name: null, root_email: null, total_cents: 120000, due_cents: 30000, ...over,
});
const giver = (person_email: string | null, donor_email: string | null, received_cents: number, last = '2027-03-01') =>
  ({ person_email, donor_email, received_cents, gift_count: 1, last_gift_date: last });

describe('matchPledgeGiving', () => {
  it('matches per household so an additional pledge shares its original household', () => {
    const s = matchPledgeGiving(
      [pledge({ id: 1 }), pledge({ id: 2, email: 'ANN@example.org ', root_name: 'Ann', root_email: 'ann@example.org', total_cents: 60000, due_cents: 0 })],
      [giver('ann@example.org', null, 40000), giver(null, 'ann@example.org', 10000, '2027-04-01')],
    );
    expect(s.households).toHaveLength(1);
    expect(s.byPledge.get(1)).toBe(s.byPledge.get(2));
    expect(s.byPledge.get(1)).toMatchObject({ pledgedCents: 180000, dueCents: 30000, receivedCents: 50000, giftCount: 2, lastGiftDate: '2027-04-01', status: 'on_track' });
    expect(s.receivedFromPledgers).toBe(50000);
  });

  it('counts a giver row once, prefers the linked person, and keeps unpledged money in the fund total only', () => {
    const s = matchPledgeGiving(
      [pledge({ id: 1 }), pledge({ id: 2, name: 'Ben', email: 'ben@example.org' })],
      [giver('ann@example.org', 'ben@example.org', 25000), giver(null, 'stranger@example.org', 99900)],
    );
    expect(s.byPledge.get(1)?.receivedCents).toBe(25000);
    expect(s.byPledge.get(2)?.receivedCents).toBe(0);
    expect(s.fundReceived).toBe(124900);
    expect(s.receivedFromPledgers).toBe(25000);
  });

  it('marks complete, on track, behind, and unmatched (no email) households', () => {
    const s = matchPledgeGiving(
      [
        pledge({ id: 1, email: 'done@example.org', total_cents: 1000, due_cents: 1000 }),
        pledge({ id: 2, email: 'ok@example.org', total_cents: 5000, due_cents: 0 }),
        pledge({ id: 3, email: 'late@example.org', total_cents: 5000, due_cents: 3000 }),
        pledge({ id: 4, name: 'Paper Card', email: null, total_cents: 5000, due_cents: 3000 }),
      ],
      [giver('done@example.org', null, 1500), giver(null, 'late@example.org', 1000)],
    );
    expect([1, 2, 3, 4].map((id) => s.byPledge.get(id)?.status)).toEqual(['complete', 'on_track', 'behind', 'unmatched']);
    expect(s.counts).toEqual({ unmatched: 1, behind: 1, on_track: 1, complete: 1 });
  });
});

describe('campaignGiftWindow', () => {
  it('starts at the earlier of the pledge opening and the giving start', () => {
    expect(campaignGiftWindow({ pledge_opens: '2026-11-15', giving_start: '2027-01-01', giving_end: '2029-12-31' })).toEqual({ from: '2026-11-15', to: '2029-12-31' });
    expect(campaignGiftWindow({ pledge_opens: null, giving_start: '2027-01-01', giving_end: '2029-12-31' })).toEqual({ from: '2027-01-01', to: '2029-12-31' });
  });
});

describe('loadPledgeGiving gate', () => {
  const noQueries = { prepare: () => { throw new Error('giving tables must not be queried'); }, batch: () => { throw new Error('no'); } } as unknown as AppDb;
  const campaign = { id: 1, fund_id: 7, currency: 'usd', pledge_opens: null, giving_start: '2027-01-01', giving_end: '2029-12-31' } as Campaign;
  it('returns null without touching the database when Giving is off or no fund is linked', async () => {
    expect(await loadPledgeGiving(noQueries, campaign, { givingOn: false, includeTest: false, today: '2027-06-01' })).toBeNull();
    expect(await loadPledgeGiving(noQueries, { ...campaign, fund_id: null }, { givingOn: true, includeTest: false, today: '2027-06-01' })).toBeNull();
  });
});

describe('canSeePledgeGiving (finance boundary)', () => {
  const base = { id: 1, email: 'a@example.org', displayName: 'A', role: 'admin', isAdmin: true, isEditor: true, finance: 0, memberTeamIds: [], leaderTeamIds: [], lang: 'en', isSuperAdmin: false, adminAreas: [] } as unknown as SessionUser;
  const on = new Set(['giving', 'pledges']);
  it('hides gift amounts from a pledges-only admin and whenever Giving is off', () => {
    expect(canSeePledgeGiving({ ...base, adminAreas: ['pledges'] } as SessionUser, on)).toBe(false);
    expect(canSeePledgeGiving({ ...base, isSuperAdmin: true } as SessionUser, new Set(['pledges']))).toBe(false);
    expect(canSeePledgeGiving(null, on)).toBe(false);
  });
  it('shows them to people who may open Giving: the giving area, the finance flag, or a super admin', () => {
    expect(canSeePledgeGiving({ ...base, adminAreas: ['pledges', 'giving'] } as SessionUser, on)).toBe(true);
    expect(canSeePledgeGiving({ ...base, adminAreas: ['pledges'], finance: 1 } as SessionUser, on)).toBe(true);
    expect(canSeePledgeGiving({ ...base, isSuperAdmin: true } as SessionUser, on)).toBe(true);
  });
});
