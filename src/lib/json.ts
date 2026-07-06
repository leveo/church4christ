// Defensive JSON parsing for editor-authored content columns (bulletin
// program/offering/attendance, prayer-sheet sections). These hold arrays of
// small objects; malformed or non-array content must degrade to an empty list
// rather than throwing and 500ing a public page.
export function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}
