import { describe, expect, it } from 'vitest';
import { GRANTABLE_AREAS } from '../src/lib/adminAreas';
import { grantCheckboxStateForRole } from '../src/lib/adminAreaUi';

describe('grantCheckboxStateForRole', () => {
  it('member to admin reveals every typed area while preserving checked Newcomers', () => {
    const before = GRANTABLE_AREAS.map((area) => ({
      area,
      ...grantCheckboxStateForRole('member', area, area === 'newcomers'),
    }));
    expect(before.filter((item) => !item.hidden).map((item) => item.area)).toEqual(['newcomers']);

    const after = before.map((item) => ({
      area: item.area,
      ...grantCheckboxStateForRole('admin', item.area, item.checked),
    }));
    expect(after.every((item) => !item.hidden && !item.roleDisabled)).toBe(true);
    expect(after.filter((item) => item.checked).map((item) => item.area)).toEqual(['newcomers']);
  });

  it('admin to member preserves Newcomers and clears, disables, and hides admin-only grants', () => {
    const checked = new Set(['groups', 'events', 'newcomers']);
    const after = GRANTABLE_AREAS.map((area) => ({
      area,
      ...grantCheckboxStateForRole('member', area, checked.has(area)),
    }));
    expect(after.find((item) => item.area === 'newcomers')).toMatchObject({
      checked: true,
      hidden: false,
      roleDisabled: false,
    });
    for (const item of after.filter((candidate) => candidate.area !== 'newcomers')) {
      expect(item, item.area).toMatchObject({ checked: false, hidden: true, roleDisabled: true });
    }
  });

  it('editor has the same narrow grant surface as member', () => {
    for (const area of GRANTABLE_AREAS) {
      expect(grantCheckboxStateForRole('editor', area, true)).toEqual(
        area === 'newcomers'
          ? { checked: true, hidden: false, roleDisabled: false }
          : { checked: false, hidden: true, roleDisabled: true },
      );
    }
  });
});
