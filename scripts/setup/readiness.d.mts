export type ReadinessSeverity = 'error' | 'warning' | 'info';
export type ReadinessItemStatus = 'pass' | 'action_required' | 'manual' | 'not_applicable';
export type ReadinessStatus = 'ready' | 'ready-with-limitations' | 'not-ready';
export interface ReadinessResult {
  readonly checkId: string;
  readonly status: ReadinessItemStatus;
  readonly code: string;
  readonly severity: ReadinessSeverity;
  readonly message: string;
  readonly remediation: string;
}
export interface ReadinessSummary {
  readonly schemaVersion: 2;
  readonly status: ReadinessStatus;
  readonly checks: readonly ReadinessResult[];
}
export const READINESS_SCHEMA_VERSION: 2;
export const READINESS_SEVERITIES: readonly ReadinessSeverity[];
export const READINESS_STATUSES: readonly ReadinessItemStatus[];
export function result(code: string, severity: ReadinessSeverity, message: string, remediation: string): ReadinessResult;
export function result(checkId: string, status: ReadinessItemStatus, severity: ReadinessSeverity, code: string, message: string, remediation: string): ReadinessResult;
export function summarizeReadiness(checks: readonly ReadinessResult[]): ReadinessSummary;
export function doctorExitCode(checks: readonly ReadinessResult[], strict: boolean): 0 | 1;
export function deepFreeze<T>(value: T): Readonly<T>;
