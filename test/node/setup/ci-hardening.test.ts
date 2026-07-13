import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installKnownUnhandledFilter } from '../../e2e/knownUnhandled';

function rejectionEvent(reason: unknown): Event & { reason: unknown } {
  const event = new Event('unhandledrejection', { cancelable: true }) as Event & {
    reason: unknown;
  };
  Object.defineProperty(event, 'reason', { value: reason });
  return event;
}

describe('test runner hardening', () => {
  it('does not mask missing tests or arbitrary unhandled errors', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const d1Config = readFileSync('vitest.e2e.config.ts', 'utf8');
    const pgConfig = readFileSync('vitest.e2e.pg.config.ts', 'utf8');

    expect(pkg.scripts.test).toBe('vitest run');
    expect(d1Config).not.toContain('dangerouslyIgnoreUnhandledErrors');
    expect(pgConfig).not.toContain('dangerouslyIgnoreUnhandledErrors');
    expect(d1Config).toContain('onUnhandledError: ignoreKnownUnhandledError');
    expect(pgConfig).toContain('onUnhandledError: ignoreKnownUnhandledError');
  });

  it('prevents only the reproducible es-module-lexer WebAssembly rejection', () => {
    const target = new EventTarget();
    installKnownUnhandledFilter(target);

    const known = rejectionEvent(
      new WebAssembly.CompileError(
        'WebAssembly.compile(): Wasm code generation disallowed by embedder',
      ),
    );
    const unrelated = rejectionEvent(new Error('database credentials were rejected'));

    expect(target.dispatchEvent(known)).toBe(false);
    expect(known.defaultPrevented).toBe(true);
    expect(target.dispatchEvent(unrelated)).toBe(true);
    expect(unrelated.defaultPrevented).toBe(false);
  });

  it('limits the Postgres socket-cancellation exception to the postgres.js CF reader', () => {
    const target = new EventTarget();
    installKnownUnhandledFilter(target);
    const postgresCancellation = new Error('Stream was cancelled.');
    postgresCancellation.stack =
      'Error: Stream was cancelled.\n    at read (node_modules/postgres/cf/polyfills.js:201:33)';
    const unrelatedCancellation = new Error('Stream was cancelled.');
    unrelatedCancellation.stack =
      'Error: Stream was cancelled.\n    at read (src/lib/unrelated-reader.ts:10:2)';
    const known = rejectionEvent(postgresCancellation);
    const unrelated = rejectionEvent(unrelatedCancellation);

    expect(target.dispatchEvent(known)).toBe(false);
    expect(known.defaultPrevented).toBe(true);
    expect(target.dispatchEvent(unrelated)).toBe(true);
    expect(unrelated.defaultPrevented).toBe(false);
  });

  it('accepts a successful Vitest JSON report with the required tests and no skips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-report-'));
    const report = join(dir, 'report.json');
    writeFileSync(
      report,
      JSON.stringify({
        success: true,
        numPassedTests: 3,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
      }),
    );

    const output = execFileSync(
      process.execPath,
      ['scripts/ci/assert-vitest-json.mjs', report, '3'],
      { encoding: 'utf8' },
    );
    expect(output).toContain('verified 3 passing tests and zero skips');
  });

  it.each([
    ['failed', { success: false, numPassedTests: 2, numFailedTests: 1, numPendingTests: 0 }],
    ['skipped', { success: true, numPassedTests: 2, numFailedTests: 0, numPendingTests: 1 }],
    ['too few', { success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0 }],
  ])('rejects a %s Vitest JSON report', (_label, body) => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-report-'));
    const report = join(dir, 'report.json');
    writeFileSync(report, JSON.stringify(body));

    expect(() =>
      execFileSync(process.execPath, ['scripts/ci/assert-vitest-json.mjs', report, '2'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('makes documentation and both non-skipping Postgres reports mandatory in CI', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('npm run docs:check');
    expect(workflow).toContain('test/setup/dry-run.test.ts test/setup/clean-room-d1.test.ts');
    expect(workflow).toContain('test/setup/clean-room-pg.test.ts --reporter=json --outputFile=.tmp/setup-pg.json');
    expect(workflow).toContain('node scripts/ci/assert-vitest-json.mjs .tmp/setup-pg.json 1');
    expect(workflow).toContain('npx vitest run --project pg --reporter=json --outputFile=.tmp/pg.json');
    expect(workflow).toContain('node scripts/ci/assert-vitest-json.mjs .tmp/pg.json 1');
    expect(workflow).toMatch(/mkdirSync\('\.tmp', \{ recursive: true \}\)/);
  });
});
