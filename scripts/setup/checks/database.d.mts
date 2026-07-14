import type { ReadinessResult } from '../readiness.mjs';
export function checkDatabase(options: unknown): Promise<readonly ReadinessResult[]>;
export function missingRequiredTables(catalog: unknown, database: 'd1' | 'supabase', createdTables: Set<string>): string[];
export function qualifiedBaseTableNames(tableRows: unknown): Set<string>;
export const ALWAYS_REQUIRED_TABLES: readonly string[];
export const FINAL_SHARED_TABLES: readonly string[];
export const PRIVATE_TABLES_BY_CAPABILITY: Readonly<Record<string, readonly string[]>>;
export const SUPABASE_TABLES_BY_CAPABILITY: Readonly<Record<string, readonly string[]>>;
export const TABLES_BY_CAPABILITY: Readonly<Record<string, readonly string[]>>;
