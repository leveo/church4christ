// Giving data access: the admin gift ledger (manual check/cash entries plus the
// Stripe-materialized card gifts), the household-scoped self-service giving view,
// per-fund and per-year totals, recurring subscriptions, and the idempotent
// webhook writers a Stripe handler calls. Supabase-only module (schema in
// migrations-supabase/0002_giving.sql); tests run against real Postgres in
// test/pg/. Money is integer cents everywhere — no floats ever cross this seam.
//
// Idempotency (webhook redelivery): gifts carries two partial UNIQUE indexes,
// gifts_pi (stripe_payment_intent_id) and gifts_invoice (stripe_invoice_id). A
// single card gift may carry a PI id, an invoice id, or both, so insertCardGift
// uses a bare `ON CONFLICT DO NOTHING` (no conflict target): Postgres then
// arbitrates against whichever partial index the incoming row's non-null id
// satisfies, deduping PI-only, invoice-only, and PI+invoice gifts alike in one
// atomic statement. A single targeted conflict clause could only cover one of the
// two indexes, so it would let an invoice-carrying redelivery collide.
//
// Totals count only status='succeeded' money — a 'refunded' gift is money handed
// back, so it is excluded from fundTotals and householdYearTotals (the admin and
// the giver both want real net totals). The household LEDGER (listHouseholdGifts)
// still shows refunded rows so the giver sees the refund in their history.
//
// Privacy: listHouseholdGifts / householdYearTotals scope to the viewer's LIVE
// household (soft-deleted households excluded), falling back to just the viewer
// when they belong to none — a giver never sees an outsider's gifts. Every admin
// function assumes the calling page has gated the request to finance/admin.
import type { AppDb } from './appDb';
import type { Locale } from './db';
import { CHURCH_TZ } from './dates';
import { isUniqueViolation } from './adminDb';
import { recordGivingAudit } from './givingAudit';

export type GiftStatus = 'pending' | 'succeeded' | 'failed' | 'refunded' | 'disputed';
export type GiftMethod = 'card' | 'us_bank_account' | 'check' | 'cash';

export interface GiftRow {
  id: number;
  person_id: number | null;
  donor_name: string | null;
  donor_email: string | null;
  fund_id: number;
  fund_name: string;
  amount_cents: number;
  currency: string;
  method: string;
  status: string;
  received_on: string | null;
  check_number: string | null;
  note: string | null;
  created_at: string;
  livemode: boolean;
  paid_at: string | null;
  refunded_cents: number;
  /** The effective calendar date in the church time zone (see EFFECTIVE_DATE). */
  gift_date: string;
}

// A gift's effective calendar date IN THE CHURCH TIME ZONE. Manual entries carry
// received_on (a date already). Stripe gifts carry paid_at (UTC, from the Stripe
// object); pre-0039 rows fall back to created_at. The UTC timestamp is converted to
// the church zone before the date part is taken, so a gift paid at 23:30 Central on
// Dec 31 counts in that year even though it is already Jan 1 in UTC. Statements,
// year totals, ledger filters, and the CSV export all use this single rule.
const CHURCH_TZ_SQL = CHURCH_TZ.replace(/[^A-Za-z_/]/g, '');
const LOCAL_DATE_OF = (col: string) =>
  `to_char((${col}::timestamp AT TIME ZONE 'UTC') AT TIME ZONE '${CHURCH_TZ_SQL}', 'YYYY-MM-DD')`;
export const EFFECTIVE_DATE = `COALESCE(g.received_on, ${LOCAL_DATE_OF('COALESCE(g.paid_at, g.created_at)')})`;
const EFFECTIVE_YEAR = `substr(${EFFECTIVE_DATE}, 1, 4)`;

// The gifts columns behind GiftRow (fund_name is added by the localized join).
const GIFT_COLS = `g.id AS id, g.person_id AS person_id, g.donor_name AS donor_name, g.donor_email AS donor_email,
  g.fund_id AS fund_id, g.amount_cents AS amount_cents, g.currency AS currency, g.method AS method,
  g.status AS status, g.received_on AS received_on, g.check_number AS check_number, g.note AS note,
  g.created_at AS created_at, g.livemode AS livemode, g.paid_at AS paid_at, g.refunded_cents AS refunded_cents,
  ${EFFECTIVE_DATE} AS gift_date`;

// Net money a gift contributes: what was paid minus what Stripe has refunded.
const NET = `(g.amount_cents - g.refunded_cents)`;
const LIVE_ONLY = `g.livemode = true`;

/**
 * Record a manual check/cash gift (status 'succeeded' — the money is in hand).
 * personId links a known giver; donorName captures an unlinked one. Returns the
 * new gift id.
 */
export async function recordManualGift(
  db: AppDb,
  input: {
    personId?: number | null;
    donorName?: string;
    fundId: number;
    amountCents: number;
    method: 'check' | 'cash';
    checkNumber?: string;
    receivedOn: string;
    note?: string;
    recordedBy: number;
    currency: string;
  },
): Promise<number> {
  const created = await db
    .prepare(
      `INSERT INTO gifts (person_id, donor_name, fund_id, amount_cents, currency, method, status,
              received_on, check_number, recorded_by, note, livemode)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'succeeded', ?7, ?8, ?9, ?10, true) RETURNING id`,
    )
    .bind(
      input.personId ?? null,
      input.donorName ?? null,
      input.fundId,
      input.amountCents,
      input.currency,
      input.method,
      input.receivedOn,
      input.checkNumber ?? null,
      input.recordedBy,
      input.note ?? null,
    )
    .first<{ id: number }>();
  await recordGivingAudit(db, {
    actorPersonId: input.recordedBy,
    action: 'manual_gift_recorded',
    refId: created!.id,
    amountCents: input.amountCents,
    currency: input.currency,
  });
  return created!.id;
}

/**
 * The admin gift ledger, newest first, localized fund name (en fallback).
 * Filters (all optional): fund, method, and an effective-date window [from,to]
 * inclusive, plus limit/offset paging.
 */
export async function listGifts(
  db: AppDb,
  locale: Locale,
  filter: { fundId?: number; from?: string; to?: string; method?: string; status?: string; limit?: number; offset?: number },
): Promise<GiftRow[]> {
  const binds: (string | number)[] = [locale];
  const conditions: string[] = [];
  if (filter.fundId !== undefined) {
    conditions.push('g.fund_id = ?');
    binds.push(filter.fundId);
  }
  if (filter.method !== undefined) {
    conditions.push('g.method = ?');
    binds.push(filter.method);
  }
  if (filter.status !== undefined) {
    conditions.push('g.status = ?');
    binds.push(filter.status);
  }
  if (filter.from !== undefined) {
    conditions.push(`${EFFECTIVE_DATE} >= ?`);
    binds.push(filter.from);
  }
  if (filter.to !== undefined) {
    conditions.push(`${EFFECTIVE_DATE} <= ?`);
    binds.push(filter.to);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  let tail = '';
  if (filter.limit !== undefined) {
    tail += ' LIMIT ?';
    binds.push(filter.limit);
  }
  if (filter.offset !== undefined) {
    tail += ' OFFSET ?';
    binds.push(filter.offset);
  }
  const { results } = await db
    .prepare(
      `SELECT ${GIFT_COLS}, COALESCE(fl.name, fd.name, '') AS fund_name
       FROM gifts g
       LEFT JOIN fund_i18n fl ON fl.fund_id = g.fund_id AND fl.locale = ?1
       LEFT JOIN fund_i18n fd ON fd.fund_id = g.fund_id AND fd.locale = 'en'
       ${where}
       ORDER BY COALESCE(g.received_on, g.paid_at, g.created_at) DESC, g.id DESC
       ${tail}`,
    )
    .bind(...binds)
    .all<GiftRow>();
  return results;
}

export interface FundTotalRow {
  fund_id: number;
  fund_name: string;
  fund_number: string;
  currency: string;
  total_cents: number;
  gift_count: number;
}

export interface GiftExportRow {
  id: number;
  gift_date: string;
  donor_name: string;
  donor_email: string;
  fund_number: string;
  fund_name: string;
  amount_cents: number;
  refunded_cents: number;
  currency: string;
  method: string;
  status: string;
  livemode: boolean;
  check_number: string | null;
  note: string | null;
  stripe_payment_intent_id: string | null;
}

/**
 * Every gift (all statuses, both modes) in an optional effective-date window with
 * the donor resolved and the church-zone date, oldest first, for the finance CSV
 * export. Reads through whatever (campus-scoped) database the caller passes.
 */
export async function listGiftsForExport(
  db: AppDb,
  filter: { from?: string; to?: string; fundId?: number },
): Promise<GiftExportRow[]> {
  const conditions: string[] = [];
  const binds: (string | number)[] = [];
  if (filter.fundId !== undefined) {
    conditions.push('g.fund_id = ?');
    binds.push(filter.fundId);
  }
  if (filter.from !== undefined) {
    conditions.push(`${EFFECTIVE_DATE} >= ?`);
    binds.push(filter.from);
  }
  if (filter.to !== undefined) {
    conditions.push(`${EFFECTIVE_DATE} <= ?`);
    binds.push(filter.to);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { results } = await db
    .prepare(
      `SELECT g.id AS id, ${EFFECTIVE_DATE} AS gift_date,
              COALESCE(p.display_name, g.donor_name, '') AS donor_name,
              COALESCE(p.email, g.donor_email, '') AS donor_email,
              f.fund_number AS fund_number, COALESCE(fd.name, '') AS fund_name,
              g.amount_cents AS amount_cents, g.refunded_cents AS refunded_cents, g.currency AS currency,
              g.method AS method, g.status AS status, g.livemode AS livemode,
              g.check_number AS check_number, g.note AS note,
              g.stripe_payment_intent_id AS stripe_payment_intent_id
       FROM gifts g
       JOIN funds f ON f.id = g.fund_id
       LEFT JOIN fund_i18n fd ON fd.fund_id = f.id AND fd.locale = 'en'
       LEFT JOIN people p ON p.id = g.person_id
       ${where}
       ORDER BY ${EFFECTIVE_DATE}, g.id`,
    )
    .bind(...binds)
    .all<GiftExportRow>();
  return results;
}

/**
 * Per-fund, per-currency succeeded-money totals over an optional effective-date
 * window, NET of refunds. Every fund appears (LEFT JOIN), so a fund with no gifts
 * in range reports one row of total 0 / count 0 in `defaultCurrency`. Pending,
 * failed, refunded, and disputed gifts never contribute. Test-mode (livemode =
 * false) Stripe gifts are excluded unless `includeTest` — a test-mode deployment
 * opts in; a live one never mixes rehearsal money into real totals.
 */
export async function fundTotals(
  db: AppDb,
  locale: Locale,
  filter: { from?: string; to?: string; includeTest?: boolean; defaultCurrency?: string },
): Promise<FundTotalRow[]> {
  const binds: (string | number)[] = [locale, filter.defaultCurrency ?? 'usd'];
  let dateFilter = filter.includeTest ? '' : ` AND ${LIVE_ONLY}`;
  if (filter.from !== undefined) {
    dateFilter += ` AND ${EFFECTIVE_DATE} >= ?`;
    binds.push(filter.from);
  }
  if (filter.to !== undefined) {
    dateFilter += ` AND ${EFFECTIVE_DATE} <= ?`;
    binds.push(filter.to);
  }
  const { results } = await db
    .prepare(
      `SELECT f.id AS fund_id, COALESCE(fl.name, fd.name, '') AS fund_name, f.fund_number AS fund_number,
              COALESCE(g.currency, ?2) AS currency,
              COALESCE(SUM(${NET}), 0) AS total_cents, COUNT(g.id) AS gift_count
       FROM funds f
       LEFT JOIN fund_i18n fl ON fl.fund_id = f.id AND fl.locale = ?1
       LEFT JOIN fund_i18n fd ON fd.fund_id = f.id AND fd.locale = 'en'
       LEFT JOIN gifts g ON g.fund_id = f.id AND g.status = 'succeeded'${dateFilter}
       GROUP BY f.id, fl.name, fd.name, f.fund_number, f.sort, g.currency
       ORDER BY f.sort, f.id, g.currency`,
    )
    .bind(...binds)
    .all<FundTotalRow>();
  return results;
}

// The set of person_ids whose gifts the viewer may see: every real member of the
// viewer's live household, plus the viewer themselves (the UNION covers the
// household-less case, where the self-join yields nothing). Mirrors
// getLiveHouseholdForPerson's deleted_at guard — a soft-deleted household drops
// out, so its former members no longer share a view.
const HOUSEHOLD_PERSON_IDS = `
  SELECT hm2.person_id FROM household_members hm1
  JOIN household_members hm2 ON hm2.household_id = hm1.household_id
  JOIN households h ON h.id = hm1.household_id AND h.deleted_at IS NULL
  WHERE hm1.person_id = ?1 AND hm2.person_id IS NOT NULL
  UNION
  SELECT ?1`;

// The ledger statuses a donor sees: settled money, money in flight, and the two
// states that explain a reversal. Failed attempts stay out of the donor's history.
const DONOR_VISIBLE_STATUSES = `('succeeded', 'refunded', 'pending', 'disputed')`;

/**
 * Household giving ledger for the self-service view: every visible gift (see
 * DONOR_VISIBLE_STATUSES) of every real member of the viewer's live household
 * (just the viewer when household-less), newest first. giver_name resolves the
 * giver's display name, falling back to the stored donor_name.
 */
export async function listHouseholdGifts(
  db: AppDb,
  locale: Locale,
  personId: number,
): Promise<Array<GiftRow & { giver_name: string }>> {
  const { results } = await db
    .prepare(
      `SELECT ${GIFT_COLS}, COALESCE(fl.name, fd.name, '') AS fund_name,
              COALESCE(p.display_name, g.donor_name, '') AS giver_name
       FROM gifts g
       LEFT JOIN fund_i18n fl ON fl.fund_id = g.fund_id AND fl.locale = ?2
       LEFT JOIN fund_i18n fd ON fd.fund_id = g.fund_id AND fd.locale = 'en'
       LEFT JOIN people p ON p.id = g.person_id
       WHERE g.person_id IN (${HOUSEHOLD_PERSON_IDS})
         AND g.status IN ${DONOR_VISIBLE_STATUSES}
       ORDER BY COALESCE(g.received_on, g.paid_at, g.created_at) DESC, g.id DESC`,
    )
    .bind(personId, locale)
    .all<GiftRow & { giver_name: string }>();
  return results;
}

export interface YearTotalRow {
  year: string;
  currency: string;
  total_cents: number;
}

/**
 * Per-calendar-year (church time zone) succeeded-money totals for the viewer's
 * whole household, newest year first, one row per currency, net of refunds.
 * Pending, failed, refunded, and disputed gifts are excluded; test-mode gifts only
 * count with `includeTest` (a test-mode deployment).
 */
export async function householdYearTotals(
  db: AppDb,
  personId: number,
  opts: { includeTest?: boolean } = {},
): Promise<YearTotalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${EFFECTIVE_YEAR} AS year, g.currency AS currency,
              COALESCE(SUM(${NET}), 0) AS total_cents
       FROM gifts g
       WHERE g.person_id IN (${HOUSEHOLD_PERSON_IDS})
         AND g.status = 'succeeded'${opts.includeTest ? '' : ` AND ${LIVE_ONLY}`}
       GROUP BY ${EFFECTIVE_YEAR}, g.currency
       HAVING COALESCE(SUM(${NET}), 0) > 0
       ORDER BY year DESC, g.currency`,
    )
    .bind(personId)
    .all<YearTotalRow>();
  return results;
}

/**
 * A single person's own gift ledger (visible statuses), newest first — the
 * person-scoped sibling of listHouseholdGifts. Used on /my/giving for a viewer
 * who is NOT a household owner: a housemate's gift never appears for them.
 */
export async function listPersonGifts(
  db: AppDb,
  locale: Locale,
  personId: number,
): Promise<Array<GiftRow & { giver_name: string }>> {
  const { results } = await db
    .prepare(
      `SELECT ${GIFT_COLS}, COALESCE(fl.name, fd.name, '') AS fund_name,
              COALESCE(p.display_name, g.donor_name, '') AS giver_name
       FROM gifts g
       LEFT JOIN fund_i18n fl ON fl.fund_id = g.fund_id AND fl.locale = ?2
       LEFT JOIN fund_i18n fd ON fd.fund_id = g.fund_id AND fd.locale = 'en'
       LEFT JOIN people p ON p.id = g.person_id
       WHERE g.person_id = ?1
         AND g.status IN ${DONOR_VISIBLE_STATUSES}
       ORDER BY COALESCE(g.received_on, g.paid_at, g.created_at) DESC, g.id DESC`,
    )
    .bind(personId, locale)
    .all<GiftRow & { giver_name: string }>();
  return results;
}

/** Per-calendar-year totals for a single person (the non-owner giving summary). */
export async function personYearTotals(
  db: AppDb,
  personId: number,
  opts: { includeTest?: boolean } = {},
): Promise<YearTotalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${EFFECTIVE_YEAR} AS year, g.currency AS currency,
              COALESCE(SUM(${NET}), 0) AS total_cents
       FROM gifts g
       WHERE g.person_id = ?1
         AND g.status = 'succeeded'${opts.includeTest ? '' : ` AND ${LIVE_ONLY}`}
       GROUP BY ${EFFECTIVE_YEAR}, g.currency
       HAVING COALESCE(SUM(${NET}), 0) > 0
       ORDER BY year DESC, g.currency`,
    )
    .bind(personId)
    .all<YearTotalRow>();
  return results;
}

// ── Annual giving statement ───────────────────────────────────────────────────
// A statement reports TAX-DEDUCTIBLE, LIVE money only: succeeded gifts (a won
// dispute is back to succeeded; a lost one stays 'disputed' and drops out), net of
// refunded_cents, in funds flagged tax_deductible, bucketed by the church-zone year.
// Manual check/cash gifts are livemode = true; Stripe test-mode rows never count.

export interface StatementLine {
  fund_id: number;
  fund_name: string;
  currency: string;
  total_cents: number;
  gift_count: number;
}

const STATEMENT_WHERE = `g.status = 'succeeded' AND ${LIVE_ONLY} AND f.tax_deductible = true`;

/** Per-fund, per-currency statement totals for one calendar year. */
export async function statementTotals(
  db: AppDb,
  locale: Locale,
  scope: { personId: number; household: boolean },
  year: number,
): Promise<StatementLine[]> {
  const personFilter = scope.household ? `g.person_id IN (${HOUSEHOLD_PERSON_IDS})` : 'g.person_id = ?1';
  const { results } = await db
    .prepare(
      `SELECT f.id AS fund_id, COALESCE(fl.name, fd.name, '') AS fund_name, g.currency AS currency,
              SUM(${NET}) AS total_cents, COUNT(g.id) AS gift_count
       FROM gifts g
       JOIN funds f ON f.id = g.fund_id
       LEFT JOIN fund_i18n fl ON fl.fund_id = f.id AND fl.locale = ?2
       LEFT JOIN fund_i18n fd ON fd.fund_id = f.id AND fd.locale = 'en'
       WHERE ${personFilter} AND ${STATEMENT_WHERE} AND ${EFFECTIVE_YEAR} = ?3
       GROUP BY f.id, fl.name, fd.name, f.sort, g.currency
       HAVING SUM(${NET}) > 0
       ORDER BY f.sort, f.id, g.currency`,
    )
    .bind(scope.personId, locale, String(year))
    .all<StatementLine>();
  return results;
}

/** Calendar years in which the viewer's scope has statement-eligible giving, newest first. */
export async function statementYears(
  db: AppDb,
  scope: { personId: number; household: boolean },
): Promise<number[]> {
  const personFilter = scope.household ? `g.person_id IN (${HOUSEHOLD_PERSON_IDS})` : 'g.person_id = ?1';
  const { results } = await db
    .prepare(
      `SELECT ${EFFECTIVE_YEAR} AS year
       FROM gifts g
       JOIN funds f ON f.id = g.fund_id
       WHERE ${personFilter} AND ${STATEMENT_WHERE}
       GROUP BY ${EFFECTIVE_YEAR}
       HAVING SUM(${NET}) > 0
       ORDER BY year DESC`,
    )
    .bind(scope.personId)
    .all<{ year: string }>();
  return results.map((r) => Number(r.year));
}

/** People with an email and statement-eligible giving in `year` (the batch recipients). */
export async function listStatementRecipients(db: AppDb, year: number): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT g.person_id AS person_id
       FROM gifts g
       JOIN funds f ON f.id = g.fund_id
       JOIN people p ON p.id = g.person_id AND p.active = 1 AND p.deleted_at IS NULL
         AND p.email IS NOT NULL AND p.email <> ''
       WHERE ${STATEMENT_WHERE} AND ${EFFECTIVE_YEAR} = ?1
       GROUP BY g.person_id
       HAVING SUM(${NET}) > 0
       ORDER BY g.person_id`,
    )
    .bind(String(year))
    .all<{ person_id: number }>();
  return results.map((r) => r.person_id);
}

/** A person's recurring subscriptions with localized fund name, newest first. */
export async function listRecurringForPerson(
  db: AppDb,
  locale: Locale,
  personId: number,
): Promise<Array<{ id: number; fund_name: string; amount_cents: number; currency: string; interval: string; status: string; livemode: boolean }>> {
  const { results } = await db
    .prepare(
      `SELECT r.id AS id, COALESCE(fl.name, fd.name, '') AS fund_name, r.amount_cents AS amount_cents,
              r.currency AS currency, r."interval" AS interval, r.status AS status, r.livemode AS livemode
       FROM recurring_gifts r
       LEFT JOIN fund_i18n fl ON fl.fund_id = r.fund_id AND fl.locale = ?1
       LEFT JOIN fund_i18n fd ON fd.fund_id = r.fund_id AND fd.locale = 'en'
       WHERE r.person_id = ?2
       ORDER BY r.created_at DESC, r.id DESC`,
    )
    .bind(locale, personId)
    .all<{ id: number; fund_name: string; amount_cents: number; currency: string; interval: string; status: string; livemode: boolean }>();
  return results;
}

// ── Webhook writers (all idempotent) ────────────────────────────────────────

/** A Stripe unix timestamp as the UTC 'YYYY-MM-DD HH:MM:SS' shape the schema stores. */
export function unixToUtcSql(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

export interface StripeGiftInput {
  personId: number | null;
  donorName: string | null;
  donorEmail: string | null;
  fundId: number;
  amountCents: number;
  currency: string;
  sessionId: string | null;
  paymentIntentId: string | null;
  invoiceId?: string | null;
  subscriptionId?: string | null;
  chargeId?: string | null;
  /** 'card' (default) or 'us_bank_account' (ACH). */
  method?: 'card' | 'us_bank_account';
  /** 'succeeded' (default), or 'pending' / 'failed' for asynchronous methods. */
  status?: 'succeeded' | 'pending' | 'failed';
  /** UTC SQL time from the Stripe object; null for a still-pending payment. */
  paidAt?: string | null;
  livemode?: boolean;
  campusId?: number | null;
}

/**
 * Materialize a Stripe gift, idempotent on redelivery. See the module header: the
 * bare `ON CONFLICT DO NOTHING` dedups against whichever of gifts_pi / gifts_invoice
 * the row's non-null id satisfies, so a re-sent event is silently a no-op and the
 * FIRST write wins (a later event never downgrades a settled gift; settlement is a
 * separate guarded UPDATE). campus_id is written explicitly because the webhook
 * processor uses an unscoped database.
 */
export async function insertCardGift(db: AppDb, g: StripeGiftInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gifts (person_id, donor_name, donor_email, fund_id, amount_cents, currency, method, status,
              stripe_checkout_session_id, stripe_payment_intent_id, stripe_invoice_id, stripe_subscription_id,
              stripe_charge_id, paid_at, livemode, campus_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, COALESCE(?16, 1))
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      g.personId,
      g.donorName,
      g.donorEmail,
      g.fundId,
      g.amountCents,
      g.currency,
      g.method ?? 'card',
      g.status ?? 'succeeded',
      g.sessionId,
      g.paymentIntentId,
      g.invoiceId ?? null,
      g.subscriptionId ?? null,
      g.chargeId ?? null,
      g.paidAt ?? null,
      g.livemode ?? false,
      g.campusId ?? null,
    )
    .run();
}

/**
 * Settle an asynchronous (ACH) gift: pending -> succeeded|failed, recording the
 * Stripe-side paid time. Only a PENDING row moves, so redelivery and out-of-order
 * events are safe no-ops. Returns true when a row moved.
 */
export async function settlePendingGift(
  db: AppDb,
  paymentIntentId: string,
  outcome: { status: 'succeeded' | 'failed'; paidAt: string | null },
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE gifts SET status = ?1, paid_at = CASE WHEN ?1 = 'succeeded' THEN COALESCE(?2, paid_at) ELSE paid_at END
       WHERE stripe_payment_intent_id = ?3 AND status = 'pending'`,
    )
    .bind(outcome.status, outcome.paidAt, paymentIntentId)
    .run();
  return r.meta.changes > 0;
}

export interface GiftIdentity {
  id: number;
  status: GiftStatus;
  method: GiftMethod;
  amount_cents: number;
  refunded_cents: number;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  stripe_charge_id: string | null;
}

const GIFT_IDENTITY_COLS = `id, status, method, amount_cents, refunded_cents, stripe_payment_intent_id,
  stripe_invoice_id, stripe_charge_id`;

export async function findGiftByPaymentIntent(db: AppDb, paymentIntentId: string): Promise<GiftIdentity | null> {
  return db
    .prepare(`SELECT ${GIFT_IDENTITY_COLS} FROM gifts WHERE stripe_payment_intent_id = ?1 LIMIT 1`)
    .bind(paymentIntentId)
    .first<GiftIdentity>();
}

export async function findGiftByInvoice(db: AppDb, invoiceId: string): Promise<GiftIdentity | null> {
  return db
    .prepare(`SELECT ${GIFT_IDENTITY_COLS} FROM gifts WHERE stripe_invoice_id = ?1 LIMIT 1`)
    .bind(invoiceId)
    .first<GiftIdentity>();
}

export async function findGiftByCharge(db: AppDb, chargeId: string): Promise<GiftIdentity | null> {
  return db
    .prepare(`SELECT ${GIFT_IDENTITY_COLS} FROM gifts WHERE stripe_charge_id = ?1 LIMIT 1`)
    .bind(chargeId)
    .first<GiftIdentity>();
}

/**
 * Back-fill the PaymentIntent and/or charge id on a gift that was keyed by invoice
 * (an invoice.paid payload carries no PaymentIntent on current API versions). Never
 * overwrites an existing value; a UNIQUE collision (that id already belongs to
 * another gift) is swallowed — attribution still resolves through the invoice.
 */
export async function backfillGiftStripeIds(
  db: AppDb,
  giftId: number,
  ids: { paymentIntentId?: string | null; chargeId?: string | null },
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE gifts SET stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?1),
                stripe_charge_id = COALESCE(stripe_charge_id, ?2)
         WHERE id = ?3`,
      )
      .bind(ids.paymentIntentId ?? null, ids.chargeId ?? null, giftId)
      .run();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
}

/**
 * Apply a refund observed on a charge: record the running refunded amount (never
 * decreasing, never above the gift) and flip to 'refunded' only when the charge is
 * fully refunded. A partial refund leaves the gift 'succeeded' with refunded_cents
 * set, so statements and totals are net. Returns true when anything changed.
 */
export async function applyGiftRefund(
  db: AppDb,
  giftId: number,
  refund: { amountRefundedCents: number; fullyRefunded: boolean },
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE gifts SET
         refunded_cents = LEAST(amount_cents, GREATEST(refunded_cents, ?1)),
         status = CASE WHEN ?2 AND status = 'succeeded' THEN 'refunded' ELSE status END
       WHERE id = ?3
         AND (refunded_cents < LEAST(amount_cents, ?1) OR (?2 AND status = 'succeeded'))`,
    )
    .bind(refund.amountRefundedCents, refund.fullyRefunded, giftId)
    .run();
  return r.meta.changes > 0;
}

/** A dispute opened: a settled gift becomes 'disputed' (out of totals and statements). */
export async function markGiftDisputed(db: AppDb, giftId: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE gifts SET status = 'disputed' WHERE id = ?1 AND status IN ('succeeded', 'pending')`)
    .bind(giftId)
    .run();
  return r.meta.changes > 0;
}

/** A dispute closed in our favour: the gift is settled money again. A lost dispute stays 'disputed'. */
export async function reinstateDisputedGift(db: AppDb, giftId: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE gifts SET status = 'succeeded' WHERE id = ?1 AND status = 'disputed'`)
    .bind(giftId)
    .run();
  return r.meta.changes > 0;
}

/** An ACH payment failed or was returned: the gift is no longer money in hand. */
export async function markAchGiftFailed(db: AppDb, giftId: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE gifts SET status = 'failed'
       WHERE id = ?1 AND method = 'us_bank_account' AND status IN ('pending', 'succeeded')`,
    )
    .bind(giftId)
    .run();
  return r.meta.changes > 0;
}

/**
 * Upsert a recurring subscription keyed on its Stripe subscription id (UNIQUE),
 * so subscription.created and every later subscription.updated converge on one
 * row.
 */
export async function upsertRecurringGift(
  db: AppDb,
  r: {
    personId: number;
    fundId: number;
    amountCents: number;
    currency: string;
    interval: 'week' | 'month' | 'year';
    subscriptionId: string;
    status: string;
    livemode?: boolean;
    campusId?: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO recurring_gifts (person_id, fund_id, amount_cents, currency, "interval", stripe_subscription_id, status,
              livemode, campus_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, 1))
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET
         person_id = excluded.person_id, fund_id = excluded.fund_id, amount_cents = excluded.amount_cents,
         currency = excluded.currency, "interval" = excluded."interval", status = excluded.status,
         updated_at = datetime('now')`,
    )
    .bind(r.personId, r.fundId, r.amountCents, r.currency, r.interval, r.subscriptionId, r.status,
      r.livemode ?? false, r.campusId ?? null)
    .run();
}

/**
 * Sync an existing recurring row from a subscription.updated payload: amount,
 * currency, interval, and fund always follow Stripe (the Billing Portal can change
 * them); status only when the Stripe status maps to one we track. Returns true when
 * a row exists (so the caller can upsert a missing one).
 */
export async function syncRecurringGift(
  db: AppDb,
  subscriptionId: string,
  v: { amountCents: number; currency: string; interval: 'week' | 'month' | 'year'; fundId: number; status: string | null },
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE recurring_gifts SET amount_cents = ?1, currency = ?2, "interval" = ?3, fund_id = ?4,
              status = COALESCE(?5, status), updated_at = datetime('now')
       WHERE stripe_subscription_id = ?6`,
    )
    .bind(v.amountCents, v.currency, v.interval, v.fundId, v.status, subscriptionId)
    .run();
  return r.meta.changes > 0;
}

/** Sync a subscription's status (past_due / canceled / active) from a webhook. */
export async function setRecurringStatus(
  db: AppDb,
  subscriptionId: string,
  status: 'active' | 'past_due' | 'canceled',
): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE recurring_gifts SET status = ?1, updated_at = datetime('now') WHERE stripe_subscription_id = ?2`)
    .bind(status, subscriptionId)
    .run();
  return r.meta.changes > 0;
}

/** invoice.payment_failed: an ACTIVE subscription becomes past_due (a canceled one never reopens). */
export async function markRecurringPastDue(db: AppDb, subscriptionId: string): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE recurring_gifts SET status = 'past_due', updated_at = datetime('now')
       WHERE stripe_subscription_id = ?1 AND status = 'active'`,
    )
    .bind(subscriptionId)
    .run();
  return r.meta.changes > 0;
}

/** Resolve the giver, fund, and campus a subscription belongs to (webhook -> gift routing). */
export async function getRecurringBySubscription(
  db: AppDb,
  subscriptionId: string,
): Promise<{ person_id: number; fund_id: number; campus_id: number } | null> {
  return db
    .prepare(`SELECT person_id, fund_id, campus_id FROM recurring_gifts WHERE stripe_subscription_id = ?1`)
    .bind(subscriptionId)
    .first<{ person_id: number; fund_id: number; campus_id: number }>();
}

/** The campus a fund belongs to, or null for an unknown fund (webhook campus validation). */
export async function getFundCampus(db: AppDb, fundId: number): Promise<number | null> {
  return db.prepare(`SELECT campus_id FROM funds WHERE id = ?1`).bind(fundId).first<number>('campus_id');
}

/**
 * Store a person's Stripe customer id for one mode. A customer id already owned by
 * a different person (UNIQUE) is left alone rather than failing the webhook.
 */
export async function setStripeCustomer(
  db: AppDb,
  personId: number,
  customerId: string,
  livemode: boolean,
  campusId?: number | null,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO stripe_customers (person_id, livemode, customer_id, campus_id)
         VALUES (?1, ?2, ?3, COALESCE(?4, 1))
         ON CONFLICT (person_id, livemode) DO UPDATE SET customer_id = excluded.customer_id`,
      )
      .bind(personId, livemode, customerId, campusId ?? null)
      .run();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
}

/**
 * A person's Stripe customer id for one mode, or null when none exists. For test
 * mode only, the legacy people.stripe_customer_id column (written before 0039,
 * when Stripe was test-only) is a read fallback; live mode never reads it.
 */
export async function getStripeCustomer(db: AppDb, personId: number, livemode = false): Promise<string | null> {
  const row = await db
    .prepare(`SELECT customer_id FROM stripe_customers WHERE person_id = ?1 AND livemode = ?2`)
    .bind(personId, livemode)
    .first<{ customer_id: string }>();
  if (row) return row.customer_id;
  if (livemode) return null;
  const legacy = await db
    .prepare(`SELECT stripe_customer_id FROM people WHERE id = ?1`)
    .bind(personId)
    .first<{ stripe_customer_id: string | null }>();
  return legacy?.stripe_customer_id ?? null;
}
