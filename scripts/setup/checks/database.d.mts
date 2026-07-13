import type { ReadinessResult } from '../readiness.mjs';
export function checkDatabase(options: unknown): Promise<readonly ReadinessResult[]>;
