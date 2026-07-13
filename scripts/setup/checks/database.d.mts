import type { ReadinessResult } from '../readiness.mjs';
export function checkDatabase(options: unknown): Promise<readonly ReadinessResult[]>;
export const ALWAYS_REQUIRED_TABLES: readonly string[];
export const FINAL_SHARED_TABLES: readonly string[];
export const TABLES_BY_CAPABILITY: Readonly<Record<string, readonly string[]>>;
