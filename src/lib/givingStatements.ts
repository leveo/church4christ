// Annual giving statements: the durable outbox behind "send statements for year N".
// An admin enqueues one row per donor (UNIQUE person/year/batch); the */5 Stripe
// recovery cron drains a bounded batch per tick. Each send is leased so overlapping
// ticks never double-send, retries back off, and permanent problems end 'failed'
// with a bounded reason the admin can read. The email links to the printable
// statement page; no PDF/attachment is generated and no card or bank data is
// involved. Supabase-only (the giving tables do not exist on D1).
import type { AppDb } from './appDb';
import { scopeDatabase } from './campusScope';
import { recordGivingAudit } from './givingAudit';
import { listStatementRecipients, statementTotals } from './givingDb';
import type { EmailEnv } from './email';
import { sendEmail } from './email';
import { toUtcSql } from './dates';
import { openDb, type DbEnv } from './dbProvider';
import { parseLocale, type Locale } from './locales';
import { bilingualEmail } from './notify';
import { isHouseholdOwner } from './portalDb';
import { getSiteIdentity } from './settings';

export const STATEMENT_DRAIN_LIMIT = 10;
export const STATEMENT_MAX_ATTEMPTS = 5;
export const STATEMENT_LEASE_MS = 10 * 60_000;
/** Minutes to wait before attempt N+1: 5, 20, 80, 320. */
export const statementBackoffMinutes = (attempts: number): number => 5 * 4 ** Math.max(0, attempts - 1);

const sqlTime = (d: Date) => toUtcSql(d);

export interface StatementBatchSummary {
  batch_id: string;
  year: number;
  total: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  created_at: string;
}

/**
 * Queue a statement for every donor with statement-eligible giving in `year`. The
 * database passed in is the admin's campus-scoped request database, so a campus
 * finance team only ever queues its own donors. Returns the new batch id.
 */
export async function enqueueStatementBatch(
  db: AppDb,
  year: number,
  actorPersonId: number,
  opts: { batchId?: string } = {},
): Promise<{ batchId: string; queued: number }> {
  if (!Number.isSafeInteger(year) || year < 2000 || year > 2200) throw new Error('statement_year_invalid');
  const recipients = await listStatementRecipients(db, year);
  const batchId = opts.batchId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  if (recipients.length > 0) {
    await db.batch(
      recipients.map((personId) =>
        db
          .prepare(`INSERT INTO giving_statement_outbox (person_id, year, batch_id) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING`)
          .bind(personId, year, batchId),
      ),
    );
  }
  await recordGivingAudit(db, { actorPersonId, action: 'statements_queued', refId: year });
  return { batchId, queued: recipients.length };
}

/** Progress per batch for the admin page (campus-scoped), newest batch first. */
export async function listStatementBatches(db: AppDb, limit = 10): Promise<StatementBatchSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT batch_id, MAX(year) AS year, COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending,
              SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              MIN(created_at) AS created_at
       FROM giving_statement_outbox
       GROUP BY batch_id
       ORDER BY MIN(created_at) DESC, batch_id DESC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<StatementBatchSummary>();
  return results;
}

/** Recent failures with their bounded reason, for the admin page. */
export async function listStatementFailures(
  db: AppDb,
  limit = 20,
): Promise<Array<{ id: number; person_id: number; display_name: string; year: number; attempts: number; last_error: string | null }>> {
  const { results } = await db
    .prepare(
      `SELECT o.id AS id, o.person_id AS person_id, COALESCE(p.display_name, '') AS display_name, o.year AS year,
              o.attempts AS attempts, o.last_error AS last_error
       FROM giving_statement_outbox o LEFT JOIN people p ON p.id = o.person_id
       WHERE o.status = 'failed'
       ORDER BY o.updated_at DESC, o.id DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<{ id: number; person_id: number; display_name: string; year: number; attempts: number; last_error: string | null }>();
  return results;
}

interface ClaimedRow {
  id: number;
  person_id: number;
  year: number;
  campus_id: number;
  attempts: number;
}

async function claimRow(db: AppDb, id: number, token: string, now: Date): Promise<ClaimedRow | null> {
  return db
    .prepare(
      `UPDATE giving_statement_outbox
       SET status = 'sending', lease_token = ?1, lease_expires_at = ?2, attempts = attempts + 1, updated_at = ?3
       WHERE id = ?4
         AND ((status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?3))
              OR (status = 'sending' AND lease_expires_at <= ?3))
       RETURNING id, person_id, year, campus_id, attempts`,
    )
    .bind(token, sqlTime(new Date(now.getTime() + STATEMENT_LEASE_MS)), sqlTime(now), id)
    .first<ClaimedRow>();
}

async function finishRow(
  db: AppDb,
  row: ClaimedRow,
  token: string,
  outcome: { kind: 'sent' } | { kind: 'retry'; error: string } | { kind: 'failed'; error: string },
  now: Date,
): Promise<void> {
  const at = sqlTime(now);
  if (outcome.kind === 'sent') {
    await db
      .prepare(
        `UPDATE giving_statement_outbox SET status = 'sent', sent_at = ?1, lease_token = NULL, lease_expires_at = NULL,
                last_error = NULL, updated_at = ?1 WHERE id = ?2 AND lease_token = ?3`,
      )
      .bind(at, row.id, token)
      .run();
    return;
  }
  const exhausted = outcome.kind === 'failed' || row.attempts >= STATEMENT_MAX_ATTEMPTS;
  await db
    .prepare(
      `UPDATE giving_statement_outbox SET status = ?1, next_attempt_at = ?2, lease_token = NULL, lease_expires_at = NULL,
              last_error = ?3, updated_at = ?4 WHERE id = ?5 AND lease_token = ?6`,
    )
    .bind(
      exhausted ? 'failed' : 'pending',
      exhausted ? null : sqlTime(new Date(now.getTime() + statementBackoffMinutes(row.attempts) * 60_000)),
      outcome.error.slice(0, 200),
      at,
      row.id,
      token,
    )
    .run();
}

type DeliveryEnv = EmailEnv & { APP_ORIGIN?: string };

async function deliver(
  env: DeliveryEnv,
  rawDb: AppDb,
  row: ClaimedRow,
): Promise<{ kind: 'sent' } | { kind: 'retry'; error: string } | { kind: 'failed'; error: string }> {
  // Everything below runs against the donor's own campus, so settings, funds and
  // the email_log row all resolve there.
  const db = scopeDatabase(rawDb, row.campus_id);
  const person = await db
    .prepare(`SELECT display_name, email, lang FROM people WHERE id = ?1 AND active = 1 AND deleted_at IS NULL`)
    .bind(row.person_id)
    .first<{ display_name: string; email: string | null; lang: string | null }>();
  if (!person?.email) return { kind: 'failed', error: 'no_recipient' };
  const lang: Locale = parseLocale(person.lang ?? '') ?? 'en';
  const owner = await isHouseholdOwner(db, row.person_id);
  const lines = await statementTotals(db, lang, { personId: row.person_id, household: owner }, row.year);
  if (lines.length === 0) return { kind: 'failed', error: 'nothing_to_report' };
  if (!env.APP_ORIGIN) return { kind: 'failed', error: 'app_origin_missing' };
  const identity = await getSiteIdentity(db, lang);
  const link = `${env.APP_ORIGIN.replace(/\/+$/, '')}/${lang}/my/giving/statement/${row.year}`;
  const built = bilingualEmail({
    subjectKey: 'giving.statementEmail.subject',
    bodyKey: 'giving.statementEmail.body',
    vars: { name: person.display_name, year: row.year, church: identity.name },
    link,
    only: lang,
  });
  const sent = await sendEmail(env, db, {
    to: person.email,
    toName: person.display_name,
    kind: 'givingStatement',
    detail: String(row.year),
    ...built,
  });
  return sent ? { kind: 'sent' } : { kind: 'retry', error: 'send_failed' };
}

export interface StatementDrainResult {
  attempted: number;
  sent: number;
  retrying: number;
  failed: number;
}

/**
 * Send up to `limit` due statements. Candidate ids are listed first, then each is
 * claimed under its own lease with an atomic UPDATE, so a concurrent tick or a lost
 * lease simply skips the row. One row's failure never stops the rest.
 */
export async function drainStatementOutbox(
  env: DeliveryEnv,
  db: AppDb,
  opts: { now?: Date; limit?: number; newToken?: () => string } = {},
): Promise<StatementDrainResult> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(1, opts.limit ?? STATEMENT_DRAIN_LIMIT), 25);
  const { results } = await db
    .prepare(
      `SELECT id FROM giving_statement_outbox
       WHERE (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1))
          OR (status = 'sending' AND lease_expires_at <= ?1)
       ORDER BY id LIMIT ?2`,
    )
    .bind(sqlTime(now), limit)
    .all<{ id: number }>();
  const result: StatementDrainResult = { attempted: 0, sent: 0, retrying: 0, failed: 0 };
  for (const { id } of results) {
    const token = opts.newToken ? opts.newToken() : crypto.randomUUID();
    const row = await claimRow(db, id, token, now);
    if (!row) continue;
    result.attempted += 1;
    let outcome: Awaited<ReturnType<typeof deliver>>;
    try {
      outcome = await deliver(env, db, row);
    } catch {
      outcome = { kind: 'retry', error: 'delivery_error' };
    }
    await finishRow(db, row, token, outcome, now);
    if (outcome.kind === 'sent') result.sent += 1;
    else if (outcome.kind === 'failed' || row.attempts >= STATEMENT_MAX_ATTEMPTS) result.failed += 1;
    else result.retrying += 1;
  }
  return result;
}

/** Cron entry: open one database client, drain a bounded batch, always release it. */
export async function runStatementDrain(
  env: DeliveryEnv & DbEnv,
  deps: { openDb?: typeof openDb; now?: Date } = {},
): Promise<StatementDrainResult | null> {
  const opened = (deps.openDb ?? openDb)(env);
  try {
    if (opened.backend !== 'supabase') return null;
    return await drainStatementOutbox(env, opened.db, { now: deps.now });
  } finally {
    try {
      await opened.end();
    } catch {
      // Releasing the client must never mask the drain result; the next tick retries.
    }
  }
}
