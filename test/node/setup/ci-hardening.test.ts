import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installKnownUnhandledFilter } from '../../e2e/knownUnhandled';
import {
  discoverPostgresCfReaderFrames,
  ignoreKnownUnhandledError as ignoreConfiguredUnhandledError,
} from '../../e2e/knownUnhandledConfig';

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
    const unrelatedBundledCancellation = new Error('Stream was cancelled.');
    unrelatedBundledCancellation.stack =
      'Error: Stream was cancelled.\n    at read (/workspace/dist/server/chunks/modules_unrelated.mjs:42:7)';
    const known = rejectionEvent(postgresCancellation);
    const unrelated = rejectionEvent(unrelatedCancellation);
    const unrelatedBundled = rejectionEvent(unrelatedBundledCancellation);

    expect(target.dispatchEvent(known)).toBe(false);
    expect(known.defaultPrevented).toBe(true);
    expect(target.dispatchEvent(unrelated)).toBe(true);
    expect(unrelated.defaultPrevented).toBe(false);
    expect(target.dispatchEvent(unrelatedBundled)).toBe(true);
    expect(unrelatedBundled.defaultPrevented).toBe(false);
  });

  it('derives an exact bundled postgres.js reader frame from dependency-specific code', () => {
    const root = mkdtempSync(join(tmpdir(), 'postgres-bundle-'));
    const chunks = join(root, 'dist/server/chunks');
    mkdirSync(chunks, { recursive: true });
    const bundle = [
      'const unrelated = true;',
      'async function read() {',
      '  try {',
      '    let done, value;',
      '    while ({done, value} = await tcp.reader.read(), !done) tcp.emit("data", Buffer.from(value));',
      '  } catch (err) {',
      '    error(err);',
      '  }',
      '}',
    ].join('\n');
    writeFileSync(join(chunks, 'modules_probe.mjs'), bundle);

    expect([...discoverPostgresCfReaderFrames(root)]).toEqual([
      'dist/server/chunks/modules_probe.mjs:5:28',
    ]);
    // The configured filter is generated from the real current build and must
    // not infer arbitrary bundled read frames from the error text alone.
    const unrelated = new Error('Stream was cancelled.');
    unrelated.stack =
      'Error: Stream was cancelled.\n    at read (/workspace/dist/server/chunks/modules_other.mjs:5:27)';
    expect(ignoreConfiguredUnhandledError(unrelated)).toBeUndefined();
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
        numTotalTests: 3,
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
    ['failed', { success: false, numPassedTests: 2, numFailedTests: 1, numPendingTests: 0, numTotalTests: 3 }],
    ['skipped', { success: true, numPassedTests: 2, numFailedTests: 0, numPendingTests: 1, numTotalTests: 3 }],
    ['too few', { success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTotalTests: 1 }],
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

  it.each([
    ['array report', []],
    ['null report', null],
    ['string report', 'not an object'],
    ['string counter', { success: true, numPassedTests: '2', numFailedTests: 0, numPendingTests: 0, numTotalTests: 2 }],
    ['boolean counter', { success: true, numPassedTests: true, numFailedTests: 0, numPendingTests: 0, numTotalTests: 1 }],
    ['null counter', { success: true, numPassedTests: null, numFailedTests: 0, numPendingTests: 0, numTotalTests: 0 }],
    ['missing counter', { success: true, numPassedTests: 2, numPendingTests: 0, numTotalTests: 2 }],
    ['negative counter', { success: true, numPassedTests: 2, numFailedTests: -1, numPendingTests: 0, numTotalTests: 1 }],
    ['fractional counter', { success: true, numPassedTests: 2.5, numFailedTests: 0, numPendingTests: 0, numTotalTests: 2.5 }],
    ['NaN-like counter', { success: true, numPassedTests: 'NaN', numFailedTests: 0, numPendingTests: 0, numTotalTests: 0 }],
    ['inconsistent total', { success: true, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTotalTests: 3 }],
    ['string success', { success: 'true', numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTotalTests: 2 }],
    ['invalid todo', { success: true, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: '0', numTotalTests: 2 }],
  ])('rejects malformed Vitest JSON: %s', (_label, body) => {
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
