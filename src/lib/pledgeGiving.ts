// Pledges ↔ Giving. When the Giving module is on and a campaign is linked to a
// fund, money actually given to that fund is matched to pledges, so staff see
// real progress per household: pledged, due by today, received, and a status.
//
// Matching is per HOUSEHOLD, not per pledge row: a first pledge and the pledges
// that add to it share one household (the first pledge's email), so the same
// gifts are never counted twice. A gift matches a household when the email of
// the person it is linked to, or the email stored on the gift, equals the
// household's email. A pledge without an email (a paper card) cannot be matched
// automatically and says so; it is never shown as "behind".
//
// Without Giving (always the case on D1, where the funds and gifts tables do not
// exist) `loadPledgeGiving` returns null before any query, and the module works
// on its own.
import type { AppDb } from './appDb';
import type { Campaign } from './pledgeDb';
import { householdKey } from './pledgePlan';
import { fundGiftsByGiver, type FundGiverRow } from './givingDb';
import { getFund, type Fund } from './fundDb';
import { localePath, type Locale } from './locales';
import { hasAreaAccess } from './adminAreas';
import type { SessionUser } from './types';

export type HouseholdStatus = 'unmatched' | 'behind' | 'on_track' | 'complete';

export interface PledgeForMatch {
  id: number;
  name: string;
  email: string | null;
  root_name: string | null;
  root_email: string | null;
  total_cents: number;
  due_cents: number;
}

export interface HouseholdProgress {
  key: string;
  email: string | null;
  pledgedCents: number;
  dueCents: number;
  receivedCents: number;
  giftCount: number;
  lastGiftDate: string | null;
  status: HouseholdStatus;
}

export interface PledgeGivingSummary {
  byPledge: Map<number, HouseholdProgress>;
  households: HouseholdProgress[];
  /** Money from matched pledging households. */
  receivedFromPledgers: number;
  /** Everything given to the fund in the window, pledged or not. */
  fundReceived: number;
  counts: Record<HouseholdStatus, number>;
}

const clean = (email: string | null | undefined) => (email ?? '').trim().toLowerCase() || null;

/** Pure: combine pledges (with what is due by today) and the fund's gifts by giver. */
export function matchPledgeGiving(pledges: readonly PledgeForMatch[], givers: readonly FundGiverRow[]): PledgeGivingSummary {
  const households = new Map<string, HouseholdProgress>();
  const byPledge = new Map<number, HouseholdProgress>();
  const byEmail = new Map<string, HouseholdProgress>();
  for (const p of pledges) {
    const owner = p.root_name !== null ? { name: p.root_name, email: p.root_email } : { name: p.name, email: p.email };
    const key = householdKey(owner);
    let h = households.get(key);
    if (!h) {
      h = { key, email: clean(owner.email), pledgedCents: 0, dueCents: 0, receivedCents: 0, giftCount: 0, lastGiftDate: null, status: 'unmatched' };
      households.set(key, h);
      if (h.email) byEmail.set(h.email, h);
    }
    h.pledgedCents += Number(p.total_cents);
    h.dueCents += Number(p.due_cents);
    byPledge.set(p.id, h);
  }
  let fundReceived = 0;
  let receivedFromPledgers = 0;
  for (const g of givers) {
    fundReceived += g.received_cents;
    // Each giver row counts once: the linked person's email first, then the gift's own.
    const h = (g.person_email && byEmail.get(g.person_email)) || (g.donor_email && byEmail.get(g.donor_email)) || null;
    if (!h) continue;
    h.receivedCents += g.received_cents;
    h.giftCount += g.gift_count;
    if (!h.lastGiftDate || g.last_gift_date > h.lastGiftDate) h.lastGiftDate = g.last_gift_date;
    receivedFromPledgers += g.received_cents;
  }
  const counts: Record<HouseholdStatus, number> = { unmatched: 0, behind: 0, on_track: 0, complete: 0 };
  for (const h of households.values()) {
    h.status = !h.email ? 'unmatched' : h.receivedCents >= h.pledgedCents ? 'complete' : h.receivedCents >= h.dueCents ? 'on_track' : 'behind';
    counts[h.status] += 1;
  }
  return { byPledge, households: [...households.values()], receivedFromPledgers, fundReceived, counts };
}

/** The window of gifts that count toward a campaign: from when pledging opened (or giving starts, if earlier) to the giving end. */
export function campaignGiftWindow(c: Pick<Campaign, 'pledge_opens' | 'giving_start' | 'giving_end'>): { from: string; to: string } {
  const from = c.pledge_opens && c.pledge_opens < c.giving_start ? c.pledge_opens : c.giving_start;
  return { from, to: c.giving_end };
}

/**
 * Real giving progress for a campaign, or null when Giving is off or the
 * campaign has no fund. The flag comes from the caller (`locals.modules`), so a
 * D1 installation never reaches a giving query.
 */
export async function loadPledgeGiving(
  db: AppDb,
  campaign: Campaign,
  opts: { givingOn: boolean; includeTest: boolean; today: string },
): Promise<PledgeGivingSummary | null> {
  if (!opts.givingOn || campaign.fund_id === null || campaign.fund_id === undefined) return null;
  const { results: pledges } = await db
    .prepare(
      `SELECT p.id, p.name, p.email, root.name AS root_name, root.email AS root_email, p.total_cents,
              (SELECT COALESCE(SUM(i.amount_cents), 0) FROM pledge_installments i WHERE i.pledge_id = p.id AND i.gift_date <= ?2) AS due_cents
       FROM pledges p LEFT JOIN pledges root ON root.id = p.parent_id
       WHERE p.campaign_id = ?1 AND p.archived_at IS NULL`,
    )
    .bind(campaign.id, opts.today)
    .all<PledgeForMatch>();
  const window = campaignGiftWindow(campaign);
  const givers = await fundGiftsByGiver(db, {
    fundId: Number(campaign.fund_id),
    from: window.from,
    to: window.to,
    currency: campaign.currency,
    includeTest: opts.includeTest,
  });
  return matchPledgeGiving(pledges, givers);
}

/**
 * The fund behind a public "Give" link (a pledge campaign or a mission trip):
 * only while Giving is on and the fund still exists and is active. Null otherwise,
 * without querying when Giving is off.
 */
export async function linkedGivingFund(
  db: AppDb,
  locale: Locale,
  fundId: number | null | undefined,
  givingOn: boolean,
): Promise<Fund | null> {
  if (!givingOn || fundId === null || fundId === undefined) return null;
  try {
    const fund = await getFund(db, locale, Number(fundId));
    return fund && Number(fund.active) === 1 ? fund : null;
  } catch (e) {
    console.error('linked giving fund: load failed', e);
    return null;
  }
}

/** The public give page with this fund preselected. */
export function giveHref(locale: Locale, fundId: number): string {
  return `${localePath(locale, '/give')}?fund=${fundId}`;
}

/**
 * Whether this person may see real gift amounts next to pledges. Gift amounts
 * are finance data, so the rule is the one /admin/giving uses (the giving area or
 * the finance flag), and only while Giving is on. Pledge admins without it see
 * pledged amounts only.
 */
export function canSeePledgeGiving(user: SessionUser | null, modules: ReadonlySet<string>): boolean {
  if (!user || !modules.has('giving')) return false;
  return hasAreaAccess(user, 'giving') || user.finance === 1;
}
