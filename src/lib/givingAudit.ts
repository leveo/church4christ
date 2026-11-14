// PII-free audit trail for the Giving module (Supabase/PostgreSQL only). Rows hold
// ids, an amount, and a currency — never donor names, emails, notes, or card data.
// The generic audit_events table is a closed, D1-shared structure for people
// exports, so Giving keeps its own table (migrations-supabase/0039).
import type { AppDb } from './appDb';

export type GivingAuditAction = 'manual_gift_recorded' | 'fund_saved' | 'statements_queued' | 'gifts_exported';

/** Append one audit row. Failures propagate so the caller never silently loses the trail. */
export async function recordGivingAudit(
  db: AppDb,
  input: {
    actorPersonId: number;
    action: GivingAuditAction;
    refId?: number | null;
    amountCents?: number | null;
    currency?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO giving_audit_events (actor_person_id, action, ref_id, amount_cents, currency)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(input.actorPersonId, input.action, input.refId ?? null, input.amountCents ?? null, input.currency ?? null)
    .run();
}
