// Node project (pure logic). The ministry-category → UI-group mapping must be
// total (every seeded category lands in exactly one group) and surjective (no
// empty group), and its labels must resolve to real dictionary keys.
import { describe, expect, it } from 'vitest';
import {
  MINISTRY_CATEGORIES,
  MINISTRY_GROUPS,
  groupOf,
  groupLabelKey,
  type FilterGroup,
} from '../src/lib/ministryMeta';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';

describe('ministryMeta', () => {
  it('maps every category to exactly one known group', () => {
    for (const category of MINISTRY_CATEGORIES) {
      const group = groupOf(category);
      expect(group, category).not.toBeNull();
      expect(MINISTRY_GROUPS, category).toContain(group);
    }
  });

  it('covers the seeded categories (worship … av-tech) and no unknowns map', () => {
    expect([...MINISTRY_CATEGORIES].sort()).toEqual(
      ['av-tech', 'care', 'children', 'college', 'family', 'hospitality', 'missions', 'seniors', 'worship', 'youth'],
    );
    expect(groupOf('not-a-category')).toBeNull();
  });

  it('leaves no group empty — each group owns at least one category', () => {
    const covered = new Set<FilterGroup>();
    for (const category of MINISTRY_CATEGORIES) {
      const group = groupOf(category);
      if (group) covered.add(group);
    }
    expect([...covered].sort()).toEqual([...MINISTRY_GROUPS].sort());
  });

  it('gives each group a label key that exists in both dictionaries', () => {
    for (const group of MINISTRY_GROUPS) {
      const key = groupLabelKey(group);
      expect(key).toBe(`ministries.group.${group}`);
      expect(en, key).toHaveProperty(key);
      expect(zh, key).toHaveProperty(key);
    }
  });
});
