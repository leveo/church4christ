// Pledges ↔ Giving against real Postgres: the seeded "Room to Grow" campaign is
// linked to a fund, gifts arrive by card (guest email) and by check (a known
// person), and loadPledgeGiving matches them per household with Giving's own
// counting rules (succeeded, net of refunds, in the window, same currency,
// test-mode only when asked). Self-skips without DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { hasPg, pgClient, resetSchema, DATABASE_URL } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';
import type { AppDb } from '../../src/lib/appDb';
import { saveFund } from '../../src/lib/fundDb';
import { insertCardGift, recordManualGift, applyGiftRefund, findGiftByPaymentIntent } from '../../src/lib/givingDb';
import { getCampaign } from '../../src/lib/pledgeDb';
import { loadPledgeGiving } from '../../src/lib/pledgeGiving';
import { getTrip } from '../../src/lib/missionDb';
import { todayInTz } from '../../src/lib/dates';

describe.skipIf(!hasPg)('pledge giving progress (Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;
  let fund: number;
  const run = (script: string) =>
    execFileSync('node', [`scripts/db/${script}`], { env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8' });

  beforeAll(async () => {
    await resetSchema(sql);
    run('migrate-supabase.mjs');
    run('seed-supabase.mjs');
    db = new PgAdapter(sql);
    fund = await saveFund(db, { fund_number: 'B300', name_en: 'Building', name_zh: '建堂', active: 1, sort: 3 });
    await db.prepare('UPDATE pledge_campaigns SET fund_id = ?1 WHERE id = 1').bind(fund).run();
    // Grace (pledges 1 and 2, one household) gives by card as a guest: test mode.
    for (const [pi, cents] of [['pi_grace_1', 90000], ['pi_grace_2', 50000]] as const) {
      await insertCardGift(db, {
        personId: null, donorName: 'Grace Chen', donorEmail: 'Grace.Chen@example.com', fundId: fund, amountCents: cents,
        currency: 'usd', sessionId: `cs_${pi}`, paymentIntentId: pi, paidAt: null, livemode: false,
      });
    }
    // A refund takes part of the second gift back.
    const second = await findGiftByPaymentIntent(db, 'pi_grace_2');
    await applyGiftRefund(db, second!.id, { amountRefundedCents: 20000, fullyRefunded: false });
    // Sarah has no pledge: her check counts toward the fund only. An old check is outside the window.
    await recordManualGift(db, { personId: 3, fundId: fund, amountCents: 7000, method: 'check', receivedOn: todayInTz(), recordedBy: 1, currency: 'usd' });
    await recordManualGift(db, { personId: 3, fundId: fund, amountCents: 5000, method: 'check', receivedOn: '2001-01-01', recordedBy: 1, currency: 'usd' });
  });
  afterAll(async () => {
    await sql?.end();
  });

  it('matches gifts per household with net amounts and keeps unpledged money in the fund total', async () => {
    const campaign = (await getCampaign(db, 1, 'en'))!;
    expect(campaign.fund_id).toBe(fund);
    const s = (await loadPledgeGiving(db, campaign, { givingOn: true, includeTest: true, today: todayInTz() }))!;
    const grace = s.byPledge.get(1)!;
    expect(s.byPledge.get(2)).toBe(grace);
    expect(grace).toMatchObject({ pledgedCents: 480000, receivedCents: 120000, giftCount: 2 });
    expect(s.byPledge.get(3)?.status).toBe('unmatched');
    expect(s.receivedFromPledgers).toBe(120000);
    expect(s.fundReceived).toBe(127000);
  });

  it('counts only gifts in the campaign currency', async () => {
    await recordManualGift(db, { personId: 3, fundId: fund, amountCents: 9900, method: 'check', receivedOn: todayInTz(), recordedBy: 1, currency: 'cad' });
    const campaign = (await getCampaign(db, 1, 'en'))!;
    const usd = (await loadPledgeGiving(db, campaign, { givingOn: true, includeTest: true, today: todayInTz() }))!;
    expect(usd.fundReceived).toBe(127000);
    const cad = (await loadPledgeGiving(db, { ...campaign, currency: 'cad' }, { givingOn: true, includeTest: true, today: todayInTz() }))!;
    expect(cad.fundReceived).toBe(9900);
  });

  it('leaves test-mode card gifts out of a live deployment', async () => {
    const campaign = (await getCampaign(db, 1, 'en'))!;
    const s = (await loadPledgeGiving(db, campaign, { givingOn: true, includeTest: false, today: todayInTz() }))!;
    expect(s.byPledge.get(1)?.receivedCents).toBe(0);
    expect(s.fundReceived).toBe(7000);
  });

  it('stores a mission trip fund link on Postgres', async () => {
    await db.prepare('UPDATE mission_trips SET fund_id = ?1 WHERE id = 1').bind(fund).run();
    expect((await getTrip(db, 1, 'en'))?.fund_id).toBe(fund);
  });
});
