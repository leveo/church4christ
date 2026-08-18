import {
  ACTIVITY_DIMENSIONS,
  ACTIVITY_MEMBERSHIP_STATUSES,
  validateActivityScoreConfig,
  type ActivityDimensionKey,
  type ActivityMembershipStatus,
  type ActivityScoreConfig,
} from './activityScoreModel';
import type { FormResult } from './validate';

export const ACTIVITY_SCORE_FORM_ERROR_CODES = [
  'activityScoreActionInvalid',
  'activityScoreRevisionInvalid',
  'activityScoreWindowInvalid',
  'activityScoreMembershipInvalid',
  'activityScoreDimensionsInvalid',
  'activityScoreWeightInvalid',
  'activityScoreTargetInvalid',
  'activityScoreThresholdInvalid',
  'activityScoreConfigInvalid',
] as const;

export type ActivityScoreFormErrorCode = (typeof ACTIVITY_SCORE_FORM_ERROR_CODES)[number];

export interface ActivityScoreConfigSaveInput {
  expectedRevision: number;
  config: ActivityScoreConfig;
}

function scalar(form: FormData, name: string): string | null {
  const values = form.getAll(name);
  return values.length === 1 ? String(values[0]).trim() : null;
}

function integer(value: string | null, minimum: number, maximum: number): number | null {
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function repeated(form: FormData, name: string): string[] {
  return form.getAll(name).map((value) => String(value).trim());
}

export function parseActivityScoreConfigForm(form: FormData): FormResult<ActivityScoreConfigSaveInput> {
  const errors: Record<string, ActivityScoreFormErrorCode> = {};
  if (scalar(form, 'action') !== 'save_config') errors.action = 'activityScoreActionInvalid';

  const revision = integer(scalar(form, 'revision'), 0, Number.MAX_SAFE_INTEGER);
  if (revision === null) errors.revision = 'activityScoreRevisionInvalid';

  const windowDays = integer(scalar(form, 'window_days'), 30, 180);
  if (windowDays !== 30 && windowDays !== 60 && windowDays !== 90 && windowDays !== 180) {
    errors.window_days = 'activityScoreWindowInvalid';
  }

  const statusValues = repeated(form, 'membership_status');
  const statusSet = new Set(statusValues);
  if (
    statusValues.length < 1 || statusValues.length > ACTIVITY_MEMBERSHIP_STATUSES.length
    || statusSet.size !== statusValues.length
    || statusValues.some((status) => !(ACTIVITY_MEMBERSHIP_STATUSES as readonly string[]).includes(status))
  ) errors.membership_status = 'activityScoreMembershipInvalid';
  const includedStatuses = ACTIVITY_MEMBERSHIP_STATUSES.filter((status) => statusSet.has(status));

  const dimensionValues = repeated(form, 'dimension');
  const dimensionSet = new Set(dimensionValues);
  if (
    dimensionValues.length < 1 || dimensionValues.length > ACTIVITY_DIMENSIONS.length
    || dimensionSet.size !== dimensionValues.length
    || dimensionValues.some((key) => !(ACTIVITY_DIMENSIONS as readonly string[]).includes(key))
  ) errors.dimension = 'activityScoreDimensionsInvalid';

  const weights = Object.create(null) as Record<ActivityDimensionKey, number>;
  for (const key of ACTIVITY_DIMENSIONS) {
    const value = integer(scalar(form, `weight_${key}`), 0, 100);
    if (value === null) errors[`weight_${key}`] = 'activityScoreWeightInvalid';
    else weights[key] = value;
  }
  const servingTarget = integer(scalar(form, 'target_serving'), 1, 100);
  const registrationTarget = integer(scalar(form, 'target_registration'), 1, 100);
  const learningTarget = integer(scalar(form, 'target_learning_engagement'), 1, 100);
  if (servingTarget === null) errors.target_serving = 'activityScoreTargetInvalid';
  if (registrationTarget === null) errors.target_registration = 'activityScoreTargetInvalid';
  if (learningTarget === null) errors.target_learning_engagement = 'activityScoreTargetInvalid';

  const activeThreshold = integer(scalar(form, 'active_threshold'), 1, 100);
  const watchThreshold = integer(scalar(form, 'watch_threshold'), 0, 99);
  if (activeThreshold === null || watchThreshold === null || watchThreshold >= activeThreshold) {
    errors.active_threshold = 'activityScoreThresholdInvalid';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const config: ActivityScoreConfig = {
    windowDays: windowDays as 30 | 60 | 90 | 180,
    includedStatuses: includedStatuses as ActivityMembershipStatus[],
    activeThreshold: activeThreshold!,
    watchThreshold: watchThreshold!,
    revision: revision!,
    dimensions: {
      group_attendance: {
        enabled: dimensionSet.has('group_attendance'),
        weight: weights.group_attendance,
        targetCount: null,
      },
      serving: {
        enabled: dimensionSet.has('serving'),
        weight: weights.serving,
        targetCount: servingTarget!,
      },
      registration: {
        enabled: dimensionSet.has('registration'),
        weight: weights.registration,
        targetCount: registrationTarget!,
      },
      learning_engagement: {
        enabled: dimensionSet.has('learning_engagement'),
        weight: weights.learning_engagement,
        targetCount: learningTarget!,
      },
    },
  };
  try {
    const validated = validateActivityScoreConfig(config);
    return { ok: true, data: { expectedRevision: revision!, config: validated } };
  } catch {
    return { ok: false, errors: { config: 'activityScoreConfigInvalid' } };
  }
}
