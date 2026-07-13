import type { ReadinessSummary } from './readiness.mjs';

export interface DoctorResult extends ReadinessSummary { readonly exitCode: 0 | 1 }
export interface DoctorContext {
  readonly secrets?: readonly string[];
  readonly checkManifest: () => Promise<unknown> | unknown;
  readonly checkConfig: () => Promise<unknown> | unknown;
  readonly checkDatabase: () => Promise<unknown> | unknown;
  readonly checkServices: () => Promise<unknown> | unknown;
}
export function runDoctor(context: DoctorContext, options?: { strict?: boolean }): Promise<DoctorResult>;
