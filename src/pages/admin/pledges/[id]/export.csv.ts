// CSV export of one campaign's pledges: one row per pledge (active and archived,
// with an archived column), plus every planned gift as date:amount pairs. Same
// access as the dashboard. Cells are formula-neutralized by csvCell.
import type { APIRoute } from 'astro';
import { hasAreaAccess } from '../../../../lib/adminAreas';
import { csvCell } from '../../../../lib/csv';
import { env } from 'cloudflare:workers';
import { getCampaign, listPledges } from '../../../../lib/pledgeDb';
import { canSeePledgeGiving, loadPledgeGiving } from '../../../../lib/pledgeGiving';
import { stripeMode, type StripeEnv } from '../../../../lib/stripe';
import { todayInTz } from '../../../../lib/dates';

export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
  const user = locals.user;
  if (!user || !hasAreaAccess(user, 'pledges')) return new Response(null, { status: 403 });
  const id = /^\d+$/.test(params.id ?? '') ? Number(params.id) : 0;
  const campaign = id ? await getCampaign(locals.db, id, user.lang ?? 'en') : null;
  if (!campaign) return new Response(null, { status: 404 });
  const db = locals.db;
  const rows = [...(await listPledges(db, id, false)), ...(await listPledges(db, id, true))];
  const { results: gifts } = await db
    .prepare(
      `SELECT i.pledge_id, i.gift_date, i.amount_cents FROM pledge_installments i JOIN pledges p ON p.id = i.pledge_id
       WHERE p.campaign_id = ?1 ORDER BY i.pledge_id, i.seq`,
    )
    .bind(id)
    .all<{ pledge_id: number; gift_date: string; amount_cents: number }>();
  const byPledge = new Map<number, string[]>();
  for (const g of gifts) {
    const list = byPledge.get(g.pledge_id) ?? [];
    list.push(`${g.gift_date}:${(g.amount_cents / 100).toFixed(2)}`);
    byPledge.set(g.pledge_id, list);
  }
  // Giving columns only with Giving on and for people who may see giving (finance data).
  const canSeeGiving = canSeePledgeGiving(user, locals.modules);
  const giving = canSeeGiving
    ? await loadPledgeGiving(db, campaign, { givingOn: true, includeTest: stripeMode(env as unknown as StripeEnv) !== 'live', today: todayInTz() })
    : null;
  const header = [
    'code', 'type', 'adds_to', 'name', 'email', 'phone', 'household', 'address', 'total', 'installment', 'gifts',
    'frequency', 'interval_months', 'first_gift', 'last_gift', 'giving_method', 'giving_note', 'signer_name',
    'source', 'email_status', 'staff_note', 'archived', 'created_at', 'schedule',
    ...(giving ? ['household_given', 'household_due', 'household_pledged', 'giving_status'] : []),
  ];
  const lines = [header.join(',')];
  for (const p of rows) {
    lines.push(
      [
        p.code, p.pledge_type, p.parent_code ?? '', p.name, p.email ?? '', p.phone, p.household, p.address,
        (p.total_cents / 100).toFixed(2), (p.installment_cents / 100).toFixed(2), p.gift_count, p.frequency,
        p.interval_months, p.start_date, p.end_date, p.giving_method, p.giving_note, p.signer_name, p.source,
        p.email_status, p.staff_note, p.archived_at ? 'yes' : 'no', p.created_at, (byPledge.get(p.id) ?? []).join(' '),
        ...(giving
          ? (() => {
              const h = giving.byPledge.get(p.id);
              return h ? [(h.receivedCents / 100).toFixed(2), (h.dueCents / 100).toFixed(2), (h.pledgedCents / 100).toFixed(2), h.status] : ['', '', '', ''];
            })()
          : []),
      ].map((c) => csvCell(c as string | number)).join(','),
    );
  }
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="pledges-${campaign.slug}.csv"`,
      'cache-control': 'no-store',
    },
  });
};
