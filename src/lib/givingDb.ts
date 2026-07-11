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
}

// The gifts columns behind GiftRow (fund_name is added by the localized join).
const GIFT_COLS = `g.id AS id, g.person_id AS person_id, g.donor_name AS donor_name, g.donor_email AS donor_email,
  g.fund_id AS fund_id, g.amount_cents AS amount_cents, g.currency AS currency, g.method AS method,
  g.status AS status, g.received_on AS received_on, g.check_number AS check_number, g.note AS note,
  g.created_at AS created_at`;

// A card/manual gift's effective calendar date: manual entries carry received_on
// (YYYY-MM-DD); card gifts fall back to the date part of created_at. Used for the
// ledger date filter and the year rollup so both gift kinds sort/group together.
const EFFECTIVE_DATE = `COALESCE(g.received_on, substr(g.created_at, 1, 10))`;

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
              received_on, check_number, recorded_by, note)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'succeeded', ?7, ?8, ?9, ?10) RETURNING id`,
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
  filter: { fundId?: number; from?: string; to?: string; method?: string; limit?: number; offset?: number },
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
       ORDER BY COALESCE(g.received_on, g.created_at) DESC, g.id DESC
       ${tail}`,
    )
    .bind(...binds)
    .all<GiftRow>();
  return results;
}

/**
 * Per-fund succeeded-money totals over an optional effective-date window. Every
 * fund appears (LEFT JOIN), so a fund with no gifts in range reports total 0 /
 * count 0; refunded gifts never contribute (status='succeeded' in the join).
 */
export async function fundTotals(
  db: AppDb,
  locale: Locale,
  filter: { from?: string; to?: string },
): Promise<Array<{ fund_id: number; fund_name: string; fund_number: string; total_cents: number; gift_count: number }>> {
  const binds: (string | number)[] = [locale];
  let dateFilter = '';
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
              COALESCE(SUM(g.amount_cents), 0) AS total_cents, COUNT(g.id) AS gift_count
       FROM funds f
       LEFT JOIN fund_i18n fl ON fl.fund_id = f.id AND fl.locale = ?1
       LEFT JOIN fund_i18n fd ON fd.fund_id = f.id AND fd.locale = 'en'
       LEFT JOIN gifts g ON g.fund_id = f.id AND g.status = 'succeeded'${dateFilter}
       GROUP BY f.id, fl.name, fd.name, f.fund_number, f.sort
       ORDER BY f.sort, f.id`,
    )
    .bind(...binds)
    .all<{ fund_id: number; fund_name: string; fund_number: string; total_cents: number; gift_count: number }>();
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

/**
 * Household giving ledger for the self-service view: every succeeded OR refunded
 * gift of every real member of the viewer's live household (just the viewer when
 * household-less), newest first. giver_name resolves the giver's display name,
 * falling back to the stored donor_name.
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
         AND g.status IN ('succeeded', 'refunded')
       ORDER BY COALESCE(g.received_on, g.created_at) DESC, g.id DESC`,
    )
    .bind(personId, locale)
    .all<GiftRow & { giver_name: string }>();
  return results;
}

/**
 * Per-calendar-year succeeded-money totals for the viewer's whole household
 * (the giving statement summary), newest year first. Refunded gifts excluded.
 */
export async function householdYearTotals(
  db: AppDb,
  personId: number,
): Promise<Array<{ year: string; total_cents: number }>> {
  const { results } = await db
    .prepare(
      `SELECT substr(COALESCE(g.received_on, g.created_at), 1, 4) AS year,
              COALESCE(SUM(g.amount_cents), 0) AS total_cents
       FROM gifts g
       WHERE g.person_id IN (${HOUSEHOLD_PERSON_IDS})
         AND g.status = 'succeeded'
       GROUP BY substr(COALESCE(g.received_on, g.created_at), 1, 4)
       ORDER BY year DESC`,
    )
    .bind(personId)
    .all<{ year: string; total_cents: number }>();
  return results;
}

/**
 * A single person's own gift ledger (succeeded + refunded), newest first — the
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
         AND g.status IN ('succeeded', 'refunded')
       ORDER BY COALESCE(g.received_on, g.created_at) DESC, g.id DESC`,
    )
    .bind(personId, locale)
    .all<GiftRow & { giver_name: string }>();
  return results;
}

/**
 * Per-calendar-year succeeded-money totals for a single person (the non-owner
 * giving summary), newest year first. Refunded gifts excluded — the
 * person-scoped sibling of householdYearTotals.
 */
export async function personYearTotals(
  db: AppDb,
  personId: number,
): Promise<Array<{ year: string; total_cents: number }>> {
  const { results } = await db
    .prepare(
      `SELECT substr(COALESCE(g.received_on, g.created_at), 1, 4) AS year,
              COALESCE(SUM(g.amount_cents), 0) AS total_cents
       FROM gifts g
       WHERE g.person_id = ?1
         AND g.status = 'succeeded'
       GROUP BY substr(COALESCE(g.received_on, g.created_at), 1, 4)
       ORDER BY year DESC`,
    )
    .bind(personId)
    .all<{ year: string; total_cents: number }>();
  return results;
}

/** A person's recurring subscriptions with localized fund name, newest first. */
export async function listRecurringForPerson(
  db: AppDb,
  locale: Locale,
  personId: number,
): Promise<Array<{ id: number; fund_name: string; amount_cents: number; interval: string; status: string }>> {
  const { results } = await db
    .prepare(
      `SELECT r.id AS id, COALESCE(fl.name, fd.name, '') AS fund_name, r.amount_cents AS amount_cents,
              r."interval" AS interval, r.status AS status
       FROM recurring_gifts r
       LEFT JOIN fund_i18n fl ON fl.fund_id = r.fund_id AND fl.locale = ?1
       LEFT JOIN fund_i18n fd ON fd.fund_id = r.fund_id AND fd.locale = 'en'
       WHERE r.person_id = ?2
       ORDER BY r.created_at DESC, r.id DESC`,
    )
    .bind(locale, personId)
    .all<{ id: number; fund_name: string; amount_cents: number; interval: string; status: string }>();
  return results;
}

// ── Webhook writers (all idempotent) ────────────────────────────────────────

/**
 * Materialize a succeeded card gift from a Stripe event, idempotent on
 * redelivery. See the module header: the bare `ON CONFLICT DO NOTHING` dedups
 * against whichever of gifts_pi / gifts_invoice the row's non-null id satisfies,
 * so a re-sent event is silently a no-op and the FIRST write wins.
 */
export async function insertCardGift(
  db: AppDb,
  g: {
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
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO gifts (person_id, donor_name, donor_email, fund_id, amount_cents, currency, method, status,
              stripe_checkout_session_id, stripe_payment_intent_id, stripe_invoice_id, stripe_subscription_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'card', 'succeeded', ?7, ?8, ?9, ?10)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      g.personId,
      g.donorName,
      g.donorEmail,
      g.fundId,
      g.amountCents,
      g.currency,
      g.sessionId,
      g.paymentIntentId,
      g.invoiceId ?? null,
      g.subscriptionId ?? null,
    )
    .run();
}

/**
 * Flip the succeeded gift for a payment intent to 'refunded'. Returns true when a
 * row moved; false for an unknown PI or an already-refunded gift (so a redelivered
 * charge.refunded event is a safe no-op).
 */
export async function markGiftRefunded(db: AppDb, paymentIntentId: string): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE gifts SET status = 'refunded' WHERE stripe_payment_intent_id = ?1 AND status = 'succeeded'`)
    .bind(paymentIntentId)
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
    interval: 'week' | 'month';
    subscriptionId: string;
    status: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO recurring_gifts (person_id, fund_id, amount_cents, currency, "interval", stripe_subscription_id, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET
         person_id = excluded.person_id, fund_id = excluded.fund_id, amount_cents = excluded.amount_cents,
         currency = excluded.currency, "interval" = excluded."interval", status = excluded.status,
         updated_at = datetime('now')`,
    )
    .bind(r.personId, r.fundId, r.amountCents, r.currency, r.interval, r.subscriptionId, r.status)
    .run();
}

/** Sync a subscription's status (past_due / canceled / active) from a webhook. */
export async function setRecurringStatus(
  db: AppDb,
  subscriptionId: string,
  status: 'active' | 'past_due' | 'canceled',
): Promise<void> {
  await db
    .prepare(`UPDATE recurring_gifts SET status = ?1, updated_at = datetime('now') WHERE stripe_subscription_id = ?2`)
    .bind(status, subscriptionId)
    .run();
}

/** Resolve the giver + fund a subscription belongs to (webhook → gift routing). */
export async function getRecurringBySubscription(
  db: AppDb,
  subscriptionId: string,
): Promise<{ person_id: number; fund_id: number } | null> {
  return db
    .prepare(`SELECT person_id, fund_id FROM recurring_gifts WHERE stripe_subscription_id = ?1`)
    .bind(subscriptionId)
    .first<{ person_id: number; fund_id: number }>();
}

/** Store a person's Stripe customer id (checkout → customer reuse). */
export async function setStripeCustomer(db: AppDb, personId: number, customerId: string): Promise<void> {
  await db
    .prepare(`UPDATE people SET stripe_customer_id = ?1, updated_at = datetime('now') WHERE id = ?2`)
    .bind(customerId, personId)
    .run();
}

/** A person's stored Stripe customer id, or null when none has been created. */
export async function getStripeCustomer(db: AppDb, personId: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT stripe_customer_id FROM people WHERE id = ?1`)
    .bind(personId)
    .first<{ stripe_customer_id: string | null }>();
  return row?.stripe_customer_id ?? null;
}
