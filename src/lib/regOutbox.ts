// Messaging and refund DATA for the registration back office: which registrations are due a reminder (and
// the stamp that claims them), the bulk-email audience and outbox (enqueue, claim, mark), and the refund
// bookkeeping. No email and no Stripe call lives here: the messaging layer sends, the Stripe layer refunds,
// and both call these functions for the state changes. Runs on D1 and Postgres.
import type { AppDb, AppStatement } from './appDb';
import { toUtcSql } from './dates';
import { activityStatement, intLit } from './regAdminCore';
import type { RegStatus } from './regDb';

const DAY_MS = 86_400_000;

// ── Reminders ────────────────────────────────────────────────────────────────

export interface ReminderCandidate {
  registrationId: number;
  eventId: number;
  campusId: number;
}

export const REMINDER_BATCH = 50;

/**
 * Confirmed registrations that are due a reminder at `now`: their event is active, not a template, has
 * reminder_days set, starts in the future within that many days, and the registration has an email and no
 * reminder_sent_at yet. The day arithmetic runs in code (portable); at most `limit` rows, oldest first.
 * Claim each with claimReminder before sending.
 */
export async function findReminderCandidates(db: AppDb, now: Date = new Date(), limit = REMINDER_BATCH): Promise<ReminderCandidate[]> {
  const from = toUtcSql(now);
  const horizon = toUtcSql(new Date(now.getTime() + 30 * DAY_MS));
  const { results: events } = await db
    .prepare(
      `SELECT id, starts_at, reminder_days FROM reg_events
       WHERE active = 1 AND is_template = 0 AND reminder_days IS NOT NULL AND starts_at > ?1 AND starts_at <= ?2`,
    )
    .bind(from, horizon)
    .all<{ id: number; starts_at: string; reminder_days: number }>();
  const due = events
    .filter((e) => Date.parse(`${e.starts_at.replace(' ', 'T')}Z`) - now.getTime() <= e.reminder_days * DAY_MS)
    .map((e) => e.id);
  if (due.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT id, event_id, campus_id FROM registrations
       WHERE event_id IN (${due.map((id) => intLit(id)).join(',')}) AND status = 'confirmed' AND reminder_sent_at IS NULL AND email != ''
       ORDER BY id LIMIT ${intLit(Math.min(Math.max(1, Math.trunc(limit)), 500))}`,
    )
    .all<{ id: number; event_id: number; campus_id: number }>();
  return results.map((r) => ({ registrationId: r.id, eventId: r.event_id, campusId: r.campus_id }));
}

/** Stamp reminder_sent_at. True only for the caller that stamped it, so two overlapping cron runs never both send. */
export async function claimReminder(db: AppDb, registrationId: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE registrations SET reminder_sent_at = datetime('now') WHERE id = ?1 AND status = 'confirmed' AND reminder_sent_at IS NULL`)
    .bind(registrationId)
    .run();
  return result.meta.changes > 0;
}

/** Undo a claim whose mail failed, so the next run tries again. */
export async function releaseReminder(db: AppDb, registrationId: number): Promise<void> {
  await db.prepare(`UPDATE registrations SET reminder_sent_at = NULL WHERE id = ?1`).bind(registrationId).run();
}

// ── Bulk mail audience ───────────────────────────────────────────────────────

export interface AudienceFilter {
  /** Default: confirmed only. */
  statuses?: RegStatus[];
  ticketTypeId?: number;
}

export interface AudienceMember {
  registrationId: number;
  name: string;
  email: string;
  status: RegStatus;
}

export const MAX_BULK_RECIPIENTS = 5000;

/** The registrations a bulk email would reach (one per registration, with an email). The preview's count. */
export async function bulkAudience(db: AppDb, eventId: number, filter: AudienceFilter = {}): Promise<AudienceMember[]> {
  const allowed: RegStatus[] = ['pending', 'review', 'confirmed', 'waitlist', 'declined', 'cancelled'];
  const statuses = (filter.statuses && filter.statuses.length > 0 ? filter.statuses : ['confirmed' as RegStatus]).filter((s) => allowed.includes(s));
  if (statuses.length === 0) return [];
  const binds: unknown[] = [eventId];
  let type = '';
  if (filter.ticketTypeId !== undefined) {
    binds.push(filter.ticketTypeId);
    type = `AND EXISTS (SELECT 1 FROM reg_attendees a WHERE a.registration_id = r.id AND a.status = 'active' AND a.ticket_type_id = CAST(?2 AS INTEGER))`;
  }
  const { results } = await db
    .prepare(
      `SELECT r.id AS id, r.name AS name, r.email AS email, r.status AS status FROM registrations r
       WHERE r.event_id = ?1 AND r.status IN (${statuses.map((s) => `'${s}'`).join(',')}) AND r.email != '' ${type}
       ORDER BY r.id LIMIT ${MAX_BULK_RECIPIENTS + 1}`,
    )
    .bind(...binds)
    .all<{ id: number; name: string; email: string; status: RegStatus }>();
  return results.map((r) => ({ registrationId: r.id, name: r.name, email: r.email, status: r.status }));
}

// ── Outbox ───────────────────────────────────────────────────────────────────

export type OutboxKind = 'bulk' | 'reminder' | 'decision';
export type OutboxStatus = 'queued' | 'sent' | 'failed' | 'skipped';

export interface OutboxRow {
  id: number;
  campus_id: number;
  event_id: number;
  registration_id: number;
  kind: OutboxKind;
  subject: string;
  body: string;
  attempts: number;
}

export const OUTBOX_MAX_ATTEMPTS = 3;
/** A claim older than this is considered abandoned (its sender died) and becomes claimable again. */
export const OUTBOX_LEASE_SECONDS = 600;
const MAX_SUBJECT = 200;
const MAX_BODY = 10_000;

export type EnqueueResult =
  | { ok: true; queued: number }
  | { ok: false; code: 'invalid' | 'too_many' | 'event_not_found' };

/**
 * Queue one row per registration for the event (registrations of other events are ignored, so the event comes
 * from the target, never the client). Subject and body are stored as typed (plain text, placeholders such as
 * {name} are filled in when sent). One batch.
 */
export async function enqueueOutbox(
  db: AppDb,
  input: { eventId: number; kind: OutboxKind; subject: string; body: string; registrationIds: number[]; createdBy: number | null },
): Promise<EnqueueResult> {
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!['bulk', 'reminder', 'decision'].includes(input.kind) || subject === '' || body === '' || Array.from(subject).length > MAX_SUBJECT || Array.from(body).length > MAX_BODY) {
    return { ok: false, code: 'invalid' };
  }
  const ids = [...new Set(input.registrationIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length > MAX_BULK_RECIPIENTS) return { ok: false, code: 'too_many' };
  const event = await db.prepare(`SELECT 1 AS present FROM reg_events WHERE id = ?1 AND is_template = 0`).bind(input.eventId).first();
  if (!event) return { ok: false, code: 'event_not_found' };
  if (ids.length === 0) return { ok: true, queued: 0 };
  const stmts: AppStatement[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    stmts.push(
      db
        .prepare(
          `INSERT INTO reg_outbox (campus_id, event_id, registration_id, kind, subject, body, created_by)
           SELECT r.campus_id, r.event_id, r.id, CAST(?2 AS TEXT), CAST(?3 AS TEXT), CAST(?4 AS TEXT), CAST(?5 AS INTEGER)
           FROM registrations r WHERE r.event_id = ?1 AND r.id IN (${chunk.map((id) => intLit(id)).join(',')})`,
        )
        .bind(input.eventId, input.kind, subject, body, input.createdBy),
    );
  }
  const results = await db.batch(stmts);
  return { ok: true, queued: results.reduce((sum, r) => sum + r.meta.changes, 0) };
}

/**
 * Claim up to `limit` queued rows for sending (oldest first), optionally of one event. Safe when two drains
 * overlap: the claim is ONE guarded UPDATE that re-checks `status = 'queued'` and the lease on the outer row, so
 * a row claimed by one drain is never returned to the other (Postgres re-evaluates the outer WHERE after a lock
 * wait); the loser simply gets fewer rows. A claim older than the lease is taken over. attempts is incremented
 * by the claim. Send each row, then markOutboxSent / markOutboxFailed / markOutboxSkipped.
 */
export async function claimOutbox(db: AppDb, opts: { limit: number; eventId?: number; now?: Date }): Promise<OutboxRow[]> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit) || 1), 500);
  const stamp = toUtcSql(now);
  const stale = toUtcSql(new Date(now.getTime() - OUTBOX_LEASE_SECONDS * 1000));
  const binds: unknown[] = [stamp, stale];
  let scope = '';
  if (opts.eventId !== undefined) {
    binds.push(opts.eventId);
    scope = `AND event_id = CAST(?3 AS INTEGER)`;
  }
  const { results } = await db
    .prepare(
      `UPDATE reg_outbox SET claimed_at = CAST(?1 AS TEXT), attempts = attempts + 1
       WHERE id IN (SELECT id FROM reg_outbox WHERE status = 'queued' AND (claimed_at IS NULL OR claimed_at < CAST(?2 AS TEXT)) ${scope}
                    ORDER BY id LIMIT ${intLit(limit)})
         AND status = 'queued' AND (claimed_at IS NULL OR claimed_at < CAST(?2 AS TEXT))
       RETURNING id, campus_id, event_id, registration_id, kind, subject, body, attempts`,
    )
    .bind(...binds)
    .all<OutboxRow>();
  return [...results].sort((a, b) => a.id - b.id);
}

/** The mail went out. False when the row was not (or no longer) claimed queued. */
export async function markOutboxSent(db: AppDb, id: number): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE reg_outbox SET status = 'sent', sent_at = datetime('now'), claimed_at = NULL WHERE id = ?1 AND status = 'queued'`)
    .bind(id)
    .run();
  return r.meta.changes > 0;
}

/** The send failed: the row goes back to the queue (claim released) until it has been tried OUTBOX_MAX_ATTEMPTS times, then it is failed. */
export async function markOutboxFailed(db: AppDb, id: number): Promise<'requeued' | 'failed' | null> {
  const row = await db
    .prepare(
      `UPDATE reg_outbox SET claimed_at = NULL, status = CASE WHEN attempts >= ${OUTBOX_MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END
       WHERE id = ?1 AND status = 'queued' RETURNING status`,
    )
    .bind(id)
    .first<{ status: OutboxStatus }>();
  return row ? (row.status === 'failed' ? 'failed' : 'requeued') : null;
}

/** Nothing to send (the registration is gone, cancelled, or has no email): never retried. */
export async function markOutboxSkipped(db: AppDb, id: number): Promise<boolean> {
  const r = await db.prepare(`UPDATE reg_outbox SET status = 'skipped', claimed_at = NULL WHERE id = ?1 AND status = 'queued'`).bind(id).run();
  return r.meta.changes > 0;
}

export async function outboxCounts(db: AppDb, eventId: number): Promise<Record<OutboxStatus, number>> {
  const { results } = await db
    .prepare(`SELECT status, COUNT(*) AS n FROM reg_outbox WHERE event_id = ?1 GROUP BY status`)
    .bind(eventId)
    .all<{ status: OutboxStatus; n: number }>();
  const counts: Record<OutboxStatus, number> = { queued: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of results) counts[r.status] = Number(r.n);
  return counts;
}

// ── Refund bookkeeping ───────────────────────────────────────────────────────

export type RefundSource = 'stripe' | 'offline';

export type RefundResult =
  | { ok: true; refundedCents: number; remainingCents: number }
  | { ok: false; code: 'not_found' | 'invalid_amount' | 'exceeds_paid' | 'no_payment' | 'use_stripe' | 'not_stripe' };

const MAX_REFUND_CENTS = 99_999_999;

/**
 * Record a refund of `cents` against a registration: refunded_cents += cents, guarded in ONE statement so the
 * total can never pass what was paid (amount_cents) even with two refunds racing. 'stripe' is for refunds
 * Stripe has accepted (only a card-paid registration); 'offline' records a refund handed back outside Stripe
 * (never for a card payment: refund those through Stripe), `note` goes into the activity row. A comp
 * registration has nothing to refund. No money moves here.
 */
export async function recordRefund(
  db: AppDb,
  registrationId: number,
  cents: number,
  source: RefundSource,
  opts: { actor?: number | null; note?: string } = {},
): Promise<RefundResult> {
  if (!Number.isInteger(cents) || cents < 1 || cents > MAX_REFUND_CENTS) return { ok: false, code: 'invalid_amount' };
  const reg = await db
    .prepare(`SELECT status, amount_cents, refunded_cents, payment_method FROM registrations WHERE id = ?1`)
    .bind(registrationId)
    .first<{ status: RegStatus; amount_cents: number; refunded_cents: number; payment_method: string | null }>();
  if (!reg) return { ok: false, code: 'not_found' };
  if (reg.amount_cents <= 0 || reg.status === 'pending' || reg.payment_method === 'comp') return { ok: false, code: 'no_payment' };
  if (source === 'stripe' && reg.payment_method !== 'stripe') return { ok: false, code: 'not_stripe' };
  if (source === 'offline' && reg.payment_method === 'stripe') return { ok: false, code: 'use_stripe' };
  const row = await db
    .prepare(
      `UPDATE registrations SET refunded_cents = refunded_cents + ?2, version = version + 1, updated_at = datetime('now')
       WHERE id = ?1 AND status != 'pending' AND amount_cents > 0 AND refunded_cents + ?2 <= amount_cents
       RETURNING refunded_cents, amount_cents`,
    )
    .bind(registrationId, cents)
    .first<{ refunded_cents: number; amount_cents: number }>();
  if (!row) return { ok: false, code: 'exceeds_paid' };
  await activityStatement(db, registrationId, opts.actor ?? null, 'refund', {
    cents, source, total: row.refunded_cents, ...(opts.note ? { note: opts.note.slice(0, 500) } : {}),
  }).run();
  return { ok: true, refundedCents: row.refunded_cents, remainingCents: row.amount_cents - row.refunded_cents };
}

/**
 * Bring refunded_cents up to the CUMULATIVE amount Stripe reports (the charge.refunded webhook carries the
 * running total, and is redelivered): never lowers it, never passes amount_cents, and a repeat changes nothing.
 * Returns the cents newly recorded (0 for a repeat). Writes an activity row when it moved.
 */
export async function syncRefundedTotal(
  db: AppDb,
  registrationId: number,
  totalRefundedCents: number,
  /** `via: 'drawer'` is a staff refund converging on the same cumulative total (the activity row carries the actor, not `webhook`); the default is the webhook. */
  opts: { actor?: number | null; via?: 'webhook' | 'drawer' } = {},
): Promise<{ ok: true; added: number } | { ok: false; code: 'not_found' | 'invalid_amount' }> {
  if (!Number.isInteger(totalRefundedCents) || totalRefundedCents < 0 || totalRefundedCents > MAX_REFUND_CENTS) return { ok: false, code: 'invalid_amount' };
  const before = await db.prepare(`SELECT refunded_cents, amount_cents FROM registrations WHERE id = ?1`).bind(registrationId).first<{ refunded_cents: number; amount_cents: number }>();
  if (!before) return { ok: false, code: 'not_found' };
  const row = await db
    .prepare(
      `UPDATE registrations SET refunded_cents = CASE WHEN CAST(?2 AS INTEGER) > amount_cents THEN amount_cents ELSE CAST(?2 AS INTEGER) END,
              version = version + 1, updated_at = datetime('now')
       WHERE id = ?1 AND amount_cents > 0 AND refunded_cents < CAST(?2 AS INTEGER) AND refunded_cents < amount_cents
       RETURNING refunded_cents`,
    )
    .bind(registrationId, totalRefundedCents)
    .first<{ refunded_cents: number }>();
  if (!row) return { ok: true, added: 0 };
  const added = row.refunded_cents - before.refunded_cents;
  await activityStatement(
    db, registrationId, opts.actor ?? null, 'refund',
    { cents: added, source: 'stripe', total: row.refunded_cents, ...(opts.via === 'drawer' ? {} : { webhook: true }) },
  ).run();
  return { ok: true, added };
}

/** The registration paid with this Stripe PaymentIntent, or null (the webhook's way from a charge to its registration). */
export async function registrationIdByPaymentIntent(db: AppDb, paymentIntentId: string): Promise<number | null> {
  const row = await db
    .prepare(`SELECT id FROM registrations WHERE stripe_payment_intent_id = ?1 ORDER BY id LIMIT 1`)
    .bind(paymentIntentId)
    .first<{ id: number }>();
  return row?.id ?? null;
}
