// CSV serialization for the finance gift export. Pure: no DB, no Astro. Every cell
// goes through csvCell, which neutralizes spreadsheet formula injection (a donor
// display name or a free-text note beginning with = + - @ cannot become a formula).
import { csvCell } from './csv';
import type { GiftExportRow } from './givingDb';

/** Integer cents as a plain decimal string ("1234.50") with no float arithmetic. */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const HEADER = [
  'Gift ID', 'Date', 'Donor', 'Email', 'Fund number', 'Fund', 'Amount', 'Refunded', 'Currency',
  'Method', 'Status', 'Mode', 'Check number', 'Note', 'Stripe payment intent',
];

export function buildGiftsCsv(rows: readonly GiftExportRow[]): string {
  const body = rows.map((r) =>
    [
      r.id, r.gift_date, r.donor_name, r.donor_email, r.fund_number, r.fund_name,
      centsToDecimal(r.amount_cents), centsToDecimal(r.refunded_cents), r.currency.toUpperCase(),
      r.method, r.status, r.livemode ? 'live' : 'test', r.check_number, r.note, r.stripe_payment_intent_id,
    ].map((cell) => csvCell(cell)).join(','),
  );
  return [HEADER.join(','), ...body].join('\r\n') + '\r\n';
}
