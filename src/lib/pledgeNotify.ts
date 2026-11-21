// Pledge confirmation email. Sent once after an online pledge is stored, and
// again whenever staff choose to (paper cards, retries). The message is in the
// pledge's own language, carries the code needed for an additional pledge, and
// says plainly that planned gifts are intentions, not charges. Sending never
// throws (email.ts); the outcome is recorded on the pledge and in its history.
import type { AppDb } from './appDb';
import { sendEmail, escapeHtml, type EmailEnv } from './email';
import { formatDate } from './dates';
import { t } from './i18n';
import { formatCents } from './money';
import { isSupportedLocale, localePath, type Locale } from './locales';
import { getCampaign, getPledge, recordEmailOutcome } from './pledgeDb';
import { getSiteIdentity } from './settings';

export type ConfirmationOutcome = 'sent' | 'failed' | 'no_email' | 'archived' | 'not_found';

/** One-line plan description: "$100.00 monthly, 12 gifts, Jan 1, 2027 – Dec 1, 2027". */
export function planLine(
  locale: Locale,
  p: { frequency: string; interval_months: number; gift_count: number; installment_cents: number; total_cents: number; start_date: string; end_date: string },
  currency: string,
): string {
  if (p.gift_count === 1) {
    return t(locale, 'pledges.plan.once', { amount: formatCents(p.total_cents, currency, locale), date: formatDate(p.start_date, locale) });
  }
  return t(locale, 'pledges.plan.recurring', {
    amount: formatCents(p.installment_cents, currency, locale),
    frequency: p.frequency === 'custom' ? t(locale, 'pledges.frequency.everyN', { n: p.interval_months }) : t(locale, `pledges.frequency.${p.frequency}`),
    count: p.gift_count,
    first: formatDate(p.start_date, locale),
    last: formatDate(p.end_date, locale),
  });
}

export async function sendPledgeConfirmation(
  env: EmailEnv,
  db: AppDb,
  pledgeId: number,
  actor: string,
  opts: { giveUrl?: string | null } = {},
): Promise<ConfirmationOutcome> {
  const pledge = await getPledge(db, pledgeId);
  if (!pledge) return 'not_found';
  if (pledge.archived_at) return 'archived';
  if (!pledge.email) return 'no_email';
  const locale: Locale = isSupportedLocale(pledge.locale) ? pledge.locale : 'en';
  const campaign = await getCampaign(db, pledge.campaign_id, locale);
  if (!campaign) return 'not_found';
  const identity = await getSiteIdentity(db, locale);
  const vars = {
    name: pledge.name,
    church: identity.name || t(locale, 'site.name'),
    campaign: campaign.title,
    code: pledge.code,
    total: formatCents(pledge.total_cents, campaign.currency, locale),
    plan: planLine(locale, pledge, campaign.currency),
    method: t(locale, `pledges.method.${pledge.giving_method}`),
  };
  const subject = t(locale, 'pledges.email.subject', vars);
  const paragraphs = [
    t(locale, 'pledges.email.greeting', vars),
    t(locale, 'pledges.email.body', vars),
    t(locale, 'pledges.email.details', vars),
    t(locale, 'pledges.email.additional', vars),
    t(locale, 'pledges.email.intentions'),
  ];
  // With Giving on and a linked fund, the email also offers the give page for that fund.
  if (opts.giveUrl) paragraphs.push(t(locale, 'pledges.email.giveOnline', { url: opts.giveUrl }));
  const origin = env.APP_ORIGIN?.replace(/\/+$/, '');
  const link = origin ? `${origin}${localePath(locale, `/pledge/${campaign.slug}`)}` : '';
  const text = paragraphs.join('\n\n') + (link ? `\n\n${link}\n` : '\n');
  const html =
    paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('') +
    (link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : '');
  const sent = await sendEmail(env, db, {
    to: pledge.email,
    toName: pledge.name,
    kind: 'pledgeConfirmation',
    detail: pledge.code,
    subject,
    html,
    text,
  });
  await recordEmailOutcome(db, pledge.id, sent, actor);
  return sent ? 'sent' : 'failed';
}
