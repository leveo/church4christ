import type { AppDb, AppStatement } from './appDb';
import type { EmailEnv } from './email';
import {
  sendIdentityRecoveryCompletedNotice,
  sendIdentityRecoveryHoldNotice,
  sendIdentityRecoveryNotice,
} from './identityNotify';
import {
  decryptIdentityRecoveryPayload,
  encryptIdentityRecoveryPayload,
  hmacIdentityRecoveryValue,
  identityRecoveryKeyMaterial,
  type IdentityRecoveryKeyEnv,
} from './identityRecoveryKey';
import type { Locale } from './locales';

export type IdentityRecoveryNotificationCategory = 'request_old_contact' | 'hold_old_contact' | 'completed_old_contact';
type DeliveryEnv = IdentityRecoveryKeyEnv & EmailEnv;

function format(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseInstant(value: string): Date {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(date.getTime()) || format(date) !== value) throw new Error('identity_recovery_outbox_clock_invalid');
  return date;
}

type NotificationInput = Readonly<{
  caseId: number;
  category: IdentityRecoveryNotificationCategory;
  recipient: string;
  contactPointId?: number;
  locale: Locale;
  vetoToken?: string;
}>;

export async function prepareIdentityRecoveryNotification(db: AppDb, env: IdentityRecoveryKeyEnv,
  input: NotificationInput): Promise<AppStatement | null> {
  if (!Number.isSafeInteger(input.caseId) || input.caseId <= 0) return null;
  const normalized = input.recipient.trim().toLowerCase();
  const contactPointId = input.contactPointId ?? await db.prepare("SELECT id FROM contact_points WHERE kind='email' AND normalized_value=?1")
    .bind(normalized).first<number>('id');
  if (!contactPointId) return null;
  const material = await identityRecoveryKeyMaterial(db, env);
  const recipientHash = await hmacIdentityRecoveryValue(material, 'notification-recipient', normalized);
  const payload = input.category === 'hold_old_contact'
    ? await encryptIdentityRecoveryPayload(material, input.vetoToken ?? '')
    : null;
  return db.prepare(`INSERT INTO identity_recovery_notification_outbox
      (case_id,category,contact_point_id,recipient_hash,locale,payload_key_id,payload_ciphertext)
    VALUES(?1,?2,?3,?4,?5,?6,?7)
    ON CONFLICT(case_id,category,contact_point_id) DO NOTHING`)
    .bind(input.caseId, input.category, contactPointId, recipientHash, input.locale,
      input.category === 'hold_old_contact' ? material.keyId : null, payload);
}

export async function enqueueIdentityRecoveryNotification(db: AppDb, env: IdentityRecoveryKeyEnv,
  input: NotificationInput): Promise<boolean> {
  const statement = await prepareIdentityRecoveryNotification(db, env, input);
  if (!statement) return false;
  const inserted = await statement.run();
  return inserted.meta.changes > 0;
}

type OutboxRow = {
  id: number;
  category: IdentityRecoveryNotificationCategory;
  normalized_value: string;
  locale: Locale;
  payload_key_id: string | null;
  payload_ciphertext: string | null;
};

export async function deliverIdentityRecoveryNotifications(db: AppDb, env: DeliveryEnv, input: Readonly<{
  caseId?: number;
  now?: string;
  limit?: number;
}> = {}): Promise<{ attempted: number; sent: number; failed: number }> {
  const material = await identityRecoveryKeyMaterial(db, env);
  const now = input.now ?? format(new Date());
  const nowDate = parseInstant(now);
  const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? Math.min(input.limit!, 50) : 25;
  const { results } = await db.prepare(`SELECT o.id,o.category,cp.normalized_value,o.locale,o.payload_key_id,o.payload_ciphertext
    FROM identity_recovery_notification_outbox o JOIN contact_points cp ON cp.id=o.contact_point_id AND cp.kind='email'
    WHERE (?1 IS NULL OR o.case_id=?1) AND (
      o.state IN ('pending','failed') OR (o.state='claimed' AND o.lease_expires_at<=?2)
    ) ORDER BY o.id LIMIT ?3`).bind(input.caseId ?? null, now, limit).all<OutboxRow>();
  if (results.some((row) => row.category === 'hold_old_contact' && row.payload_key_id !== material.keyId)) {
    throw new Error('identity_recovery_key_configuration_mismatch');
  }
  let attempted = 0;
  let sent = 0;
  let failed = 0;
  for (const row of results) {
    const rawLease = crypto.randomUUID();
    const leaseHash = await hmacIdentityRecoveryValue(material, 'notification-lease', rawLease);
    const leaseExpiresAt = format(new Date(nowDate.getTime() + 5 * 60_000));
    const claimed = await db.prepare(`UPDATE identity_recovery_notification_outbox
      SET state='claimed',attempt_count=attempt_count+1,lease_token_hash=?1,lease_expires_at=?2,last_error_code=NULL,sent_at=NULL
      WHERE id=?3 AND (state IN ('pending','failed') OR (state='claimed' AND lease_expires_at<=?4))`)
      .bind(leaseHash, leaseExpiresAt, row.id, now).run();
    // D1 includes the append-only transition receipt in `changes`; the guarded
    // row update is still a single-winner CAS, while a lost claim reports zero.
    if (claimed.meta.changes === 0) continue;
    attempted += 1;
    let ok = false;
    let errorCode: 'send_failed' | 'payload_invalid' = 'send_failed';
    try {
      if (row.category === 'request_old_contact') {
        ok = await sendIdentityRecoveryNotice(env, db, { to: row.normalized_value, locale: row.locale });
      } else if (row.category === 'completed_old_contact') {
        ok = await sendIdentityRecoveryCompletedNotice(env, db, { to: row.normalized_value, locale: row.locale });
      } else {
        const vetoToken = await decryptIdentityRecoveryPayload(material, row.payload_key_id ?? '', row.payload_ciphertext ?? '');
        if (!/^[A-Za-z0-9_-]{43}$/u.test(vetoToken)) throw new Error('identity_recovery_outbox_payload_invalid');
        ok = await sendIdentityRecoveryHoldNotice(env, db, { to: row.normalized_value, locale: row.locale, vetoToken });
      }
    } catch {
      errorCode = 'payload_invalid';
    }
    if (ok) {
      const acknowledged = await db.prepare(`UPDATE identity_recovery_notification_outbox
        SET state='sent',lease_token_hash=NULL,lease_expires_at=NULL,last_error_code=NULL,sent_at=?1
        WHERE id=?2 AND state='claimed' AND lease_token_hash=?3`).bind(now, row.id, leaseHash).run();
      if (acknowledged.meta.changes > 0) sent += 1;
    } else {
      const acknowledged = await db.prepare(`UPDATE identity_recovery_notification_outbox
        SET state='failed',lease_token_hash=NULL,lease_expires_at=NULL,last_error_code=?1,sent_at=NULL
        WHERE id=?2 AND state='claimed' AND lease_token_hash=?3`).bind(errorCode, row.id, leaseHash).run();
      if (acknowledged.meta.changes > 0) failed += 1;
    }
  }
  return { attempted, sent, failed };
}

/** Hourly bounded fallback; request waitUntil delivery is only a latency hint. */
export function runIdentityRecoveryNotificationSweep(env: DeliveryEnv, db: AppDb) {
  return deliverIdentityRecoveryNotifications(db, env, { limit: 25 });
}
