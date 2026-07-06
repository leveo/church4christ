// Presentation grouping for the ministries directory: the 10 fine-grained
// ministry categories (the values seeded in `ministries.category`) collapse into
// 6 coarse UI groups the /ministries page renders as sections. Kept in code, not
// the schema — it is display grouping, not data. Pure + unit-tested: every
// category maps to exactly one group, and every group is non-empty.

/** The six coarse UI groups, in display order. */
export type FilterGroup =
  | 'sunday-service'
  | 'next-gen'
  | 'community'
  | 'outreach'
  | 'care'
  | 'support';

export const MINISTRY_GROUPS: readonly FilterGroup[] = [
  'sunday-service',
  'next-gen',
  'community',
  'outreach',
  'care',
  'support',
] as const;

/** The 10 seeded ministry categories, each mapped to exactly one group. */
const CATEGORY_GROUP: Record<string, FilterGroup> = {
  worship: 'sunday-service',
  'av-tech': 'sunday-service',
  children: 'next-gen',
  youth: 'next-gen',
  college: 'next-gen',
  family: 'community',
  seniors: 'community',
  missions: 'outreach',
  care: 'care',
  hospitality: 'support',
};

/** Every known category, for completeness tests and iteration. */
export const MINISTRY_CATEGORIES: readonly string[] = Object.keys(CATEGORY_GROUP);

/** The UI group a category belongs to, or null for an unknown category. */
export function groupOf(category: string): FilterGroup | null {
  return CATEGORY_GROUP[category] ?? null;
}

/** Dictionary key for a group's localized label (both locales define these). */
export function groupLabelKey(group: FilterGroup): string {
  return `ministries.group.${group}`;
}
