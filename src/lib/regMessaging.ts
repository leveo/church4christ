// Bulk email for the registration back office: queue a staff-written message for an audience, and drain the
// queue (reg_outbox) one isolated row at a time. The request that queued the mail drains the first rows at
// once (DRAIN_ON_REQUEST); the hourly cron drains up to CRON_DRAIN_LIMIT per run, so a big send finishes in
// the background. Staff text is plain text: it is stored as typed, placeholders are filled and the result is
// escaped into the standard layout when each row is sent (regEmails.bulkEmail). A bulk email carries no manage
// link, so it never rotates (or invalidates) one, and a token never appears here. Never throws.
import type { AppDb } from './appDb';
import { getBackend, type DbEnv } from './dbProvider';
import { getEffectiveCampusModules } from './campusDb';
import { sendEmail } from './email';
import { getEnabledModules } from './modules';
import { bulkEmail } from './regEmails';
import { emailLocale, type RegNotifyEnv } from './regNotify';
import { intLit } from './regAdminCore';
import { registrationSummary } from './regManage';
import {
  bulkAudience, claimOutbox, enqueueOutbox, markOutboxFailed, markOutboxSent, markOutboxSkipped,
  type AudienceFilter, type EnqueueResult, type OutboxRow,
} from './regOutbox';

/** The request that queued a bulk email drains this many rows before it returns. */
export const DRAIN_ON_REQUEST = 20;
/** The hourly cron drains at most this many rows per run. */
export const CRON_DRAIN_LIMIT = 100;

export interface BulkEmailInput {
  eventId: number;
  /** The staff person sending it (the people id), recorded on every row and in each registration's history. */
  actor: number | null;
  subject: string;
  body: string;
  audience: AudienceFilter;
}

/**
 * Queue one row per registration in the audience (see bulkAudience for who that is), validating the subject
 * (1-200 characters) and the plain-text body (1-10,000). Returns how many were queued; nothing is sent here.
 * Each queued registration gets an activity row (never the body or any link).
 */
export async function queueBulkEmail(db: AppDb, input: BulkEmailInput): Promise<EnqueueResult> {
  const audience = await bulkAudience(db, input.eventId, input.audience);
  const queued = await enqueueOutbox(db, {
    eventId: input.eventId, kind: 'bulk', subject: input.subject, body: input.body,
    registrationIds: audience.map((a) => a.registrationId), createdBy: input.actor,
  });
  if (queued.ok && queued.queued > 0) {
    const ids = audience.map((a) => a.registrationId);
    const stmts = [];
    for (let i = 0; i < ids.length; i += 200) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO reg_activity (campus_id, event_id, registration_id, actor_person_id, action, detail_json)
             SELECT r.campus_id, r.event_id, r.id, CAST(?2 AS INTEGER), 'bulk_email', CAST(?3 AS TEXT)
             FROM registrations r WHERE r.event_id = ?1 AND r.id IN (${ids.slice(i, i + 200).map((id) => intLit(id)).join(',')})`,
          )
          .bind(input.eventId, input.actor, JSON.stringify({ subject: input.subject.trim().slice(0, 200) })),
      );
    }
    await db.batch(stmts);
  }
  return queued;
}

export interface DrainResult {
  claimed: number;
  sent: number;
  /** Failed this time and put back in the queue for another try. */
  requeued: number;
  /** Out of attempts: marked failed for good. */
  failed: number;
  skipped: number;
}

const EMPTY: DrainResult = { claimed: 0, sent: 0, requeued: 0, failed: 0, skipped: 0 };

async function sendRow(
  env: RegNotifyEnv,
  db: AppDb,
  row: OutboxRow,
  titles: Map<string, string>,
): Promise<'sent' | 'skipped' | 'failed'> {
  const reg = await db
    .prepare(`SELECT name, email, confirmation_no, locale FROM registrations WHERE id = ?1`)
    .bind(row.registration_id)
    .first<{ name: string; email: string; confirmation_no: string | null; locale: string | null }>();
  // The registration is gone or has no address: nothing to send, never retried.
  if (!reg || !reg.email) return 'skipped';
  const locale = await emailLocale(db, reg.locale);
  const key = `${row.event_id}:${locale}`;
  let title = titles.get(key);
  if (title === undefined) {
    title = (await registrationSummary(db, row.registration_id, locale))?.event.title ?? '';
    titles.set(key, title);
  }
  const built = bulkEmail(
    { subject: row.subject, body: row.body, name: reg.name, eventTitle: title, confirmationNo: reg.confirmation_no },
    { locale },
  );
  const ok = await sendEmail(env, db, {
    to: reg.email, toName: reg.name, kind: 'regBulk', detail: `registration ${row.registration_id}`,
    subject: built.subject, html: built.html, text: built.text,
  });
  return ok ? 'sent' : 'failed';
}

/**
 * Claim up to `limit` queued rows (oldest first, optionally of one event), render and send each, and mark it
 * sent, failed (requeued until it has been tried three times) or skipped. A row that throws is marked failed
 * and the rest still go out. With `respectModules` (the cron) nothing is claimed while the registration module
 * is off, and a row of a campus that has it off is skipped. Never throws.
 */
export async function drainOutbox(
  env: RegNotifyEnv,
  db: AppDb,
  opts: { limit: number; eventId?: number; respectModules?: boolean },
): Promise<DrainResult> {
  const result: DrainResult = { ...EMPTY };
  try {
    let globalModules: ReadonlySet<string> | null = null;
    if (opts.respectModules) {
      globalModules = await getEnabledModules(db, getBackend(env as unknown as DbEnv));
      if (!globalModules.has('registration')) return result;
    }
    const rows = await claimOutbox(db, { limit: opts.limit, eventId: opts.eventId });
    result.claimed = rows.length;
    const campusOn = new Map<number, boolean>();
    const titles = new Map<string, string>();
    for (const row of rows) {
      try {
        if (globalModules) {
          let on = campusOn.get(row.campus_id);
          if (on === undefined) {
            on = (await getEffectiveCampusModules(db, row.campus_id, globalModules as never)).has('registration');
            campusOn.set(row.campus_id, on);
          }
          if (!on) {
            await markOutboxSkipped(db, row.id);
            result.skipped++;
            continue;
          }
        }
        const outcome = await sendRow(env, db, row, titles);
        if (outcome === 'sent') {
          await markOutboxSent(db, row.id);
          result.sent++;
        } else if (outcome === 'skipped') {
          await markOutboxSkipped(db, row.id);
          result.skipped++;
        } else if ((await markOutboxFailed(db, row.id)) === 'failed') result.failed++;
        else result.requeued++;
      } catch (e) {
        console.error(`registration bulk mail failed for outbox row ${row.id}`, e instanceof Error ? e.name : 'unknown');
        try {
          if ((await markOutboxFailed(db, row.id)) === 'failed') result.failed++;
          else result.requeued++;
        } catch {
          /* the lease expires and the row becomes claimable again */
        }
      }
    }
  } catch (e) {
    console.error('registration outbox drain failed', e instanceof Error ? e.name : 'unknown');
  }
  return result;
}

/** The hourly cron's pass: up to CRON_DRAIN_LIMIT rows, honouring the registration module per campus. */
export async function sweepOutbox(env: RegNotifyEnv, db: AppDb): Promise<DrainResult> {
  return drainOutbox(env, db, { limit: CRON_DRAIN_LIMIT, respectModules: true });
}
