import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_COMMIT,
  assertBaseline,
  assertDisposablePostgresUrl,
  randomSchemaName,
} from '../../../scripts/release/rehearse-upgrade.mjs';

describe('v1.0.0 upgrade rehearsal safety', () => {
  it('accepts only the immutable baseline and fails closed when it is absent', async () => {
    expect(BASELINE_COMMIT).toBe('b85ad362b9f879408797270929c52dab7ad39d1d');
    await expect(assertBaseline(BASELINE_COMMIT, async () => ({ exitCode: 0 }))).resolves.toBeUndefined();
    await expect(assertBaseline('HEAD', async () => ({ exitCode: 0 }))).rejects.toThrow(/baseline/i);
    await expect(assertBaseline(BASELINE_COMMIT, async () => ({ exitCode: 1 }))).rejects.toThrow(/fetch-depth|absent/i);
  });

  it('refuses unmarked or production-like PostgreSQL targets and uses isolated schema names', () => {
    expect(() => assertDisposablePostgresUrl('postgres://postgres:postgres@localhost:5432/church_test?c4c_rehearsal=1')).not.toThrow();
    expect(() => assertDisposablePostgresUrl('postgres://db.example/church_test?c4c_rehearsal=1')).toThrow(/local/i);
    expect(() => assertDisposablePostgresUrl('postgres://localhost/church')).toThrow(/marker/i);
    expect(randomSchemaName()).toMatch(/^c4c_rehearsal_[a-f0-9]{16}$/);
  });

  it('locks archive, temp-target, forward migration, canary, readiness, search_path, and finally-drop source', () => {
    const source = readFileSync('scripts/release/rehearse-upgrade.mjs', 'utf8');
    for (const marker of ['git', 'archive', 'mkdtemp', 'sqlite3', 'search_path', 'finally', 'DROP SCHEMA', 'onboarding_acknowledgements']) {
      expect(source, marker).toContain(marker);
    }
    expect(source).not.toMatch(/git\s+fetch|DROP SCHEMA public|DROP DATABASE/i);
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toMatch(/fetch-depth:\s*0/);
  });
});
