import { csvCell } from './csv';

export const PASTORAL_NOTES_EXPORT_HEADERS = [
  'person_ref',
  'person_email',
  'author_attribution',
  'body',
  'created_at',
] as const;

export const PASTORAL_NOTES_EXPORT_LIMITS = {
  maxNotes: 5_000,
  maxCsvBytes: 10 * 1024 * 1024,
  maxIssues: 100,
} as const;

export interface PastoralNotesExportSourceNote {
  stableKey: string;
  personStableKey: string;
  personEmail: string;
  authorAttribution: string;
  body: string;
  createdAt: string;
}

export interface PastoralNotesExportSource {
  notes: readonly PastoralNotesExportSourceNote[];
  /** Numeric-only loader integrity failures; any positive value suppresses CSV bytes. */
  integrityIssues?: number;
}

export type PastoralNotesExportResult =
  | {
      status: 'success';
      counts: { people: number; notes: number };
      csv: string;
    }
  | {
      status: 'repair_required';
      counts: { people: number; notes: number; issues: number };
    };

type SnapshotNote = PastoralNotesExportSourceNote;
type Subject = { stableKey: string; email: string; ref: string; ordinal: number };

const ENCODER = new TextEncoder();
const HEADER = `${PASTORAL_NOTES_EXPORT_HEADERS.join(',')}\r\n`;

function identity(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

function normalized(value: string): string {
  return value.normalize('NFC');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repair(people: number, notes: number, issues: number): PastoralNotesExportResult {
  return {
    status: 'repair_required',
    counts: {
      people: Math.min(Math.max(0, people), PASTORAL_NOTES_EXPORT_LIMITS.maxNotes + 1),
      notes: Math.min(Math.max(0, notes), PASTORAL_NOTES_EXPORT_LIMITS.maxNotes + 1),
      issues: Math.min(Math.max(1, issues), PASTORAL_NOTES_EXPORT_LIMITS.maxIssues),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snapshot(input: unknown): { notes: SnapshotNote[]; issues: number; observed: number } {
  if (!isRecord(input) || !Array.isArray(input.notes)) return { notes: [], issues: 1, observed: 0 };
  const observed = input.notes.length;
  if (observed > PASTORAL_NOTES_EXPORT_LIMITS.maxNotes) {
    return { notes: [], issues: 1, observed };
  }

  const notes: SnapshotNote[] = [];
  let issues = 0;
  if (input.integrityIssues !== undefined) {
    if (!Number.isSafeInteger(input.integrityIssues) || (input.integrityIssues as number) < 0) issues += 1;
    else issues += Math.min(input.integrityIssues as number, PASTORAL_NOTES_EXPORT_LIMITS.maxIssues);
  }
  for (const value of input.notes) {
    if (!isRecord(value)) {
      issues += 1;
      continue;
    }
    const fields = [
      value.stableKey,
      value.personStableKey,
      value.personEmail,
      value.authorAttribution,
      value.body,
      value.createdAt,
    ];
    if (!fields.every((field) => typeof field === 'string')) {
      issues += 1;
      continue;
    }
    const note: SnapshotNote = {
      stableKey: value.stableKey as string,
      personStableKey: value.personStableKey as string,
      personEmail: value.personEmail as string,
      authorAttribution: value.authorAttribution as string,
      body: value.body as string,
      createdAt: value.createdAt as string,
    };
    if (
      note.stableKey.trim() === ''
      || note.personStableKey.trim() === ''
      || identity(note.personEmail) === ''
      || note.createdAt.trim() === ''
    ) {
      issues += 1;
      continue;
    }
    notes.push(note);
  }
  return { notes, issues, observed };
}

/** Build the separately authorized pastoral-notes CSV without exposing IDs or partial bytes on failure. */
export function buildPastoralNotesExport(input: PastoralNotesExportSource): PastoralNotesExportResult {
  try {
    const captured = snapshot(input);
    if (captured.issues > 0 || captured.observed > PASTORAL_NOTES_EXPORT_LIMITS.maxNotes) {
      return repair(0, captured.observed, captured.issues);
    }

    const subjectByStableKey = new Map<string, { stableKey: string; email: string }>();
    const seenNoteKeys = new Set<string>();
    let issues = 0;
    for (const note of captured.notes) {
      const noteKey = identity(note.stableKey);
      if (seenNoteKeys.has(noteKey)) issues += 1;
      seenNoteKeys.add(noteKey);

      const stableKey = note.personStableKey;
      const email = identity(note.personEmail);
      const existing = subjectByStableKey.get(stableKey);
      if (existing && existing.email !== email) issues += 1;
      else subjectByStableKey.set(stableKey, { stableKey, email });
    }

    const subjects = [...subjectByStableKey.values()].sort(
      (left, right) => compare(left.email, right.email) || compare(identity(left.stableKey), identity(right.stableKey))
        || compare(left.stableKey, right.stableKey),
    );
    const seenEmails = new Set<string>();
    for (const subject of subjects) {
      if (seenEmails.has(subject.email)) issues += 1;
      seenEmails.add(subject.email);
    }
    if (issues > 0) return repair(subjects.length, captured.observed, issues);

    const subjectsWithRefs: Subject[] = subjects.map((subject, index) => ({
      ...subject,
      ref: `person-${index + 1}`,
      ordinal: index + 1,
    }));
    const refByStableKey = new Map(subjectsWithRefs.map((subject) => [subject.stableKey, subject]));
    const orderedNotes = [...captured.notes].sort((left, right) => {
      const leftSubject = refByStableKey.get(left.personStableKey)!;
      const rightSubject = refByStableKey.get(right.personStableKey)!;
      return leftSubject.ordinal - rightSubject.ordinal
        || compare(normalized(left.createdAt.trim()), normalized(right.createdAt.trim()))
        || compare(identity(left.stableKey), identity(right.stableKey))
        || compare(left.stableKey, right.stableKey);
    });

    let csv = HEADER;
    let bytes = ENCODER.encode(HEADER).byteLength;
    for (const note of orderedNotes) {
      const subject = refByStableKey.get(note.personStableKey)!;
      const row = [
        subject.ref,
        subject.email,
        normalized(note.authorAttribution.trim()),
        normalized(note.body),
        normalized(note.createdAt.trim()),
      ].map((cell) => csvCell(cell)).join(',') + '\r\n';
      bytes += ENCODER.encode(row).byteLength;
      if (bytes > PASTORAL_NOTES_EXPORT_LIMITS.maxCsvBytes) {
        return repair(subjects.length, captured.observed, 1);
      }
      csv += row;
    }

    return {
      status: 'success',
      counts: { people: subjects.length, notes: captured.observed },
      csv,
    };
  } catch {
    return repair(0, 0, 1);
  }
}
