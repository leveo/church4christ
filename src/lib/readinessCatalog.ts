import rawCatalog from '../../config/readiness.json';

export type ReadinessStatus = 'pass' | 'action_required' | 'manual' | 'not_applicable';
export type ReadinessSeverity = 'error' | 'warning' | 'info';
export type ReadinessSurface = 'cli' | 'admin';
export type BilingualText = Readonly<{ en: string; zh: string }>;
export type ReadinessDefinition = Readonly<{
  id: string;
  category: 'foundation' | 'people' | 'operations';
  severity: ReadinessSeverity;
  selectors: Readonly<{ capabilities: readonly string[]; services: readonly string[] }>;
  surfaces: readonly ReadinessSurface[];
  title: BilingualText;
  description: BilingualText;
  remediation: BilingualText;
  adminPath: string | null;
  manualVersion: number | null;
  legacyCodes: readonly string[];
}>;

export const READINESS_CATALOG = rawCatalog as Readonly<{ schemaVersion: 1; categories: readonly string[]; checks: readonly ReadinessDefinition[] }>;
export const READINESS_BY_ID = new Map(READINESS_CATALOG.checks.map((check) => [check.id, check]));
export const READINESS_BY_LEGACY_CODE = new Map(READINESS_CATALOG.checks.flatMap((check) => check.legacyCodes.map((code) => [code, check] as const)));
export const MANUAL_READINESS_IDS = new Set(READINESS_CATALOG.checks.filter((check) => check.manualVersion !== null).map((check) => check.id));
