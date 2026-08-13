import { describe, expect, it } from 'vitest';
import { parseActivityScoreConfigForm } from '../src/lib/activityScoreForms';

function form(overrides: Record<string, string | string[] | null> = {}): FormData {
  const values: Record<string, string | string[]> = {
    action: 'save_config',
    revision: '2',
    window_days: '90',
    membership_status: ['regular', 'member'],
    dimension: ['group_attendance', 'serving'],
    weight_group_attendance: '50',
    weight_serving: '50',
    weight_registration: '0',
    target_serving: '3',
    target_registration: '2',
    active_threshold: '70',
    watch_threshold: '40',
    ...overrides,
  };
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

describe('parseActivityScoreConfigForm', () => {
  it('parses one complete strict model', () => {
    expect(parseActivityScoreConfigForm(form())).toEqual({
      ok: true,
      data: {
        expectedRevision: 2,
        config: {
          windowDays: 90,
          includedStatuses: ['regular', 'member'],
          activeThreshold: 70,
          watchThreshold: 40,
          revision: 2,
          dimensions: {
            group_attendance: { enabled: true, weight: 50, targetCount: null },
            serving: { enabled: true, weight: 50, targetCount: 3 },
            registration: { enabled: false, weight: 0, targetCount: 2 },
          },
        },
      },
    });
  });

  it('accepts every supported window and all membership statuses', () => {
    for (const window of ['30', '60', '90', '180']) {
      const result = parseActivityScoreConfigForm(form({
        window_days: window,
        membership_status: ['visitor', 'regular', 'member', 'inactive'],
      }));
      expect(result).toMatchObject({ ok: true, data: { config: { windowDays: Number(window) } } });
    }
  });

  it.each([
    ['action', { action: 'private' }, 'activityScoreActionInvalid'],
    ['revision', { revision: '-1' }, 'activityScoreRevisionInvalid'],
    ['window_days', { window_days: '45' }, 'activityScoreWindowInvalid'],
    ['membership_status', { membership_status: [] }, 'activityScoreMembershipInvalid'],
    ['membership_status', { membership_status: ['member', 'private'] }, 'activityScoreMembershipInvalid'],
    ['dimension', { dimension: ['serving', 'serving'] }, 'activityScoreDimensionsInvalid'],
    ['weight_serving', { weight_serving: '1.5' }, 'activityScoreWeightInvalid'],
    ['target_serving', { target_serving: '101' }, 'activityScoreTargetInvalid'],
    ['active_threshold', { active_threshold: '40', watch_threshold: '40' }, 'activityScoreThresholdInvalid'],
  ] as const)('rejects invalid %s with a fixed non-echoing code', (field, overrides, code) => {
    const result = parseActivityScoreConfigForm(form(overrides));
    expect(result).toEqual({ ok: false, errors: { [field]: code } });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('rejects duplicate scalar keys and a model whose enabled weights do not total 100', () => {
    const duplicate = form();
    duplicate.append('revision', '3');
    expect(parseActivityScoreConfigForm(duplicate)).toEqual({
      ok: false,
      errors: { revision: 'activityScoreRevisionInvalid' },
    });
    expect(parseActivityScoreConfigForm(form({ weight_group_attendance: '40' }))).toEqual({
      ok: false,
      errors: { config: 'activityScoreConfigInvalid' },
    });
  });
});
