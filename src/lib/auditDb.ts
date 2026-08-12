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

function snapshotInput(input: unknown): AppendAuditEventInput | null {
  if (!isPlainRecord(input)) return null;
  const kind = input.kind;
  const actorPersonId = input.actorPersonId;
  const countsInput = input.counts;
  if (kind !== AUDIT_EVENT_KIND) return null;
  if (!Number.isSafeInteger(actorPersonId) || (actorPersonId as number) <= 0) return null;
  if (!isPlainRecord(countsInput)) return null;
  const keys = Object.keys(countsInput).sort();
  if (keys.length !== 2 || keys[0] !== 'notes' || keys[1] !== 'people') return null;
  const people = countsInput.people;
  const notes = countsInput.notes;
  if (!isBoundedCount(people) || !isBoundedCount(notes)) return null;
  return {
    kind,
    actorPersonId: actorPersonId as number,
    counts: { people, notes },
  };
}

/** Append one deliberately PII-free audit record. All failures are safe and fail closed. */
export async function appendAuditEvent(db: AppDb, input: AppendAuditEventInput): Promise<void> {
  let captured: AppendAuditEventInput | null;
  try {
    captured = snapshotInput(input);
  } catch {
    throw new Error('audit_event_invalid');
  }
  if (captured === null) throw new Error('audit_event_invalid');

  const countsJson = JSON.stringify(captured.counts);
  try {
    const result = await db.prepare(`
      INSERT INTO audit_events (actor_person_id, action_kind, structural_counts_json)
      VALUES (?, ?, ?)
    `).bind(captured.actorPersonId, captured.kind, countsJson).run();
    if (result.meta.changes !== 1) throw new Error('audit_event_failed');
  } catch {
    throw new Error('audit_event_failed');
  }
}
