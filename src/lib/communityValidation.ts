import type { AppDb } from './appDb';
import { campusIdForDatabase } from './campusScope';

export function requireCampus(db: AppDb): number {
  const campusId = campusIdForDatabase(db);
  if (campusId === null)
    throw new Error('Select a campus before making changes.');
  return campusId;
}
export function positiveId(value: unknown): number {
  const id =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error('Choose a valid record.');
  return id;
}
export function cleanText(value: string, max: number, required = true): string {
  const result = value.trim();
  if (
    (required && !result) ||
    result.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)
  ) {
    throw new Error(`Enter ${required ? '1' : '0'} to ${max} characters.`);
  }
  return result;
}
export async function requirePerson(
  db: AppDb,
  personId: number,
): Promise<void> {
  requireCampus(db);
  if (
    !(await db
      .prepare(
        'SELECT id FROM people WHERE id=? AND active=1 AND deleted_at IS NULL',
      )
      .bind(positiveId(personId))
      .first())
  ) {
    throw new Error('Choose an active member of this campus.');
  }
}
export async function requireFellowship(
  db: AppDb,
  fellowshipId: number | null,
): Promise<void> {
  requireCampus(db);
  if (
    fellowshipId !== null &&
    !(await db
      .prepare('SELECT id FROM fellowships WHERE id=? AND active=1')
      .bind(positiveId(fellowshipId))
      .first())
  ) {
    throw new Error('Choose an active fellowship in this campus.');
  }
}
export function utcTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/.test(value))
    throw new Error('Enter a valid UTC date and time.');
  const time = new Date(value);
  if (
    !Number.isFinite(time.getTime()) ||
    time.toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    throw new Error('Enter a valid UTC date and time.');
  return time.toISOString();
}
