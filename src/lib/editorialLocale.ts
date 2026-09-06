// Temporary source eligibility for legacy editorial fields without locale
// metadata. This detects Han text, not language. Never pass dedicated person
// names, volunteer responses, or other user messages through this rule.
export function isEnglishEditorialText(...values: unknown[]): boolean {
  return values.every((value) => typeof value !== 'string' || !/\p{Script=Han}/u.test(value));
}
