import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  validateReadinessCatalog,
  productionReadinessCodes,
} from '../../../scripts/lib/validate-readiness-catalog.mjs';
import {
  doctorExitCode,
  result,
  summarizeReadiness,
} from '../../../scripts/setup/readiness.mjs';

const catalog = JSON.parse(readFileSync('config/readiness.json', 'utf8'));

describe('shared readiness catalog', () => {
  it('has the strict bilingual selector and surface schema with stable required ids', () => {
    expect(validateReadinessCatalog(catalog)).toBe(catalog);
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.checks.map((entry: { id: string }) => entry.id)).toEqual(expect.arrayContaining([
      'identity', 'locales', 'service-times', 'admin-grants', 'people-migration',
      'newcomer-owner', 'attendance-checkin-mapping', 'origin-domain-email',
      'routes-jobs', 'backups', 'restore-drill',
    ]));
  });

  it('catalogs every literal production adapter outcome including reserved exceptions', () => {
    const codes = new Set(catalog.checks.flatMap((entry: { legacyCodes: string[] }) => entry.legacyCodes));
    expect([...productionReadinessCodes(process.cwd())].filter((code) => !codes.has(code))).toEqual([]);
    for (const code of ['manifest.exception', 'config.exception', 'database.exception', 'services.exception']) {
      expect(codes.has(code), code).toBe(true);
    }
  });
});

describe('doctor JSON schema v2', () => {
  const check = (checkId: string, status: 'pass' | 'action_required' | 'manual' | 'not_applicable', severity: 'error' | 'warning' | 'info') =>
    result(checkId, status, severity, `${checkId}.legacy`, 'message', 'remediation');

  it('emits exact item fields and preserves legacy code', () => {
    const item = check('identity', 'pass', 'info');
    expect(Object.keys(item).sort()).toEqual(['checkId', 'code', 'message', 'remediation', 'severity', 'status'].sort());
    expect(summarizeReadiness([item])).toEqual({ schemaVersion: 2, status: 'ready', checks: [item] });
  });

  it('implements the approved normal and strict truth table', () => {
    const cases = [
      [check('identity', 'pass', 'info'), 'ready', 0, 0],
      [check('routes-jobs', 'not_applicable', 'info'), 'ready', 0, 0],
      [check('identity', 'action_required', 'error'), 'not-ready', 1, 1],
      [check('origin-domain-email', 'action_required', 'warning'), 'ready-with-limitations', 0, 1],
      [check('restore-drill', 'manual', 'info'), 'ready-with-limitations', 0, 1],
    ] as const;
    for (const [item, summary, normal, strict] of cases) {
      expect(summarizeReadiness([item]).status).toBe(summary);
      expect(doctorExitCode([item], false)).toBe(normal);
      expect(doctorExitCode([item], true)).toBe(strict);
    }
  });
});
