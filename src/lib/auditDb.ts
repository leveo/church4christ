import type { AppDb } from './appDb';

export const AUDIT_EVENT_KIND = 'people_notes_export_generated' as const;

export interface AppendAuditEventInput {
  kind: typeof AUDIT_EVENT_KIND;
  actorPersonId: number;
  counts: {
    people: number;
    notes: number;
  };
}

const MAX_STRUCTURAL_COUNT = 5_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_STRUCTURAL_COUNT;
}

function isValidInput(input: unknown): input is AppendAuditEventInput {
  if (!isPlainRecord(input)) return false;
  if (input.kind !== AUDIT_EVENT_KIND) return false;
  if (!Number.isSafeInteger(input.actorPersonId) || (input.actorPersonId as number) <= 0) return false;
  if (!isPlainRecord(input.counts)) return false;
  const keys = Object.keys(input.counts).sort();
  if (keys.length !== 2 || keys[0] !== 'notes' || keys[1] !== 'people') return false;
  return isBoundedCount(input.counts.people) && isBoundedCount(input.counts.notes);
}

/** Append one deliberately PII-free audit record. All failures are safe and fail closed. */
export async function appendAuditEvent(db: AppDb, input: AppendAuditEventInput): Promise<void> {
  try {
    if (!isValidInput(input)) throw new Error('audit_event_invalid');
  } catch {
    throw new Error('audit_event_invalid');
  }

  const countsJson = JSON.stringify({ people: input.counts.people, notes: input.counts.notes });
  try {
    const result = await db.prepare(`
      INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
      VALUES (?, ?, ?)
    `).bind(input.actorPersonId, input.kind, countsJson).run();
    if (result.meta.changes !== 1) throw new Error('audit_event_failed');
  } catch {
    throw new Error('audit_event_failed');
  }
}
