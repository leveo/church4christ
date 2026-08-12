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

  it('uses the current major versions of the checkout and Node setup actions', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('actions/checkout@v7');
    expect(workflow).toContain('actions/setup-node@v7');
    expect(workflow).not.toContain('actions/checkout@v4');
    expect(workflow).not.toContain('actions/setup-node@v4');
  });

  it('uses the exact Node version that satisfies the package engine lower bound', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const exactVersion = readFileSync('.nvmrc', 'utf8').trim();
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      engines: { node: string };
    };

    expect(exactVersion).toBe('22.12.0');
    expect(pkg.engines.node).toBe('>=22.12.0');
    expect(pkg.engines.node).toBe(`>=${exactVersion}`);
    expect(workflow).toContain(
      'uses: actions/setup-node@v7\n        with:\n          node-version-file: .nvmrc\n          cache: npm',
    );
    expect(workflow).not.toMatch(/^\s*node-version:\s/m);
  });

  it('deduplicates pull request runs without cancelling main pushes', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const concurrencyIndex = workflow.indexOf('\nconcurrency:\n');
    const jobsIndex = workflow.indexOf('\njobs:\n');
    const cancelEvent = workflow.match(
      /cancel-in-progress: \$\{\{ github\.event_name == '([^']+)' \}\}/,
    )?.[1];

    expect(concurrencyIndex).toBeGreaterThan(-1);
    expect(concurrencyIndex).toBeLessThan(jobsIndex);
    expect(workflow).toContain(
      'group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(cancelEvent).toBe('pull_request');
    expect('pull_request' === cancelEvent).toBe(true);
    expect('push' === cancelEvent).toBe(false);
  });

  it('limits the build-test job to thirty minutes', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain(
      'build-test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30',
    );
  });

  it('preserves permissions, Postgres, caching, and every CI run step', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const runCommands = [
      'npm ci',
      'test -f src/styles/tokens.generated.css && test -f src/lib/themeMeta.generated.ts',
      'npx wrangler types',
      `node -e "require('node:fs').mkdirSync('.tmp', { recursive: true })"`,
      'npm run docs:check',
      'npx vitest run --project node test/setup/dry-run.test.ts test/setup/clean-room-d1.test.ts',
      'npx vitest run --project node test/setup/clean-room-pg.test.ts --reporter=json --outputFile=.tmp/setup-pg.json',
      'node scripts/ci/assert-vitest-json.mjs .tmp/setup-pg.json 1',
      'npm run tokens',
      'npm run tokens:check',
      'npm test',
      'npm run check',
      'npm run build',
      'npm run db:migrate:local',
      'npm run db:seed:local',
      'npm run db:seed-media:local',
      'bash scripts/smoke.sh',
      'npm run test:e2e',
      'npm run db:migrate:supabase',
      'npm run db:seed:supabase',
      'npx vitest run --project pg --reporter=json --outputFile=.tmp/pg.json',
      'node scripts/ci/assert-vitest-json.mjs .tmp/pg.json 1',
      'npm run test:e2e:pg',
    ];
    const criticalDatabaseSteps = [
      'Prove setup dry-run and clean D1 install',
      'Prove clean Supabase setup',
      'Apply D1 migrations (local)',
      'Seed demo data (local)',
      'Apply Supabase migrations (Postgres)',
      'Seed demo data (Postgres)',
    ];

    expect(workflow).toContain('permissions:\n      contents: read');
    expect(workflow).toContain('services:\n      postgres:\n        image: postgres:16');
    expect(workflow).toContain('cache: npm');
    expect(workflow.match(/^\s+run:(?:\s|$)/gm)).toHaveLength(runCommands.length);
    for (const command of runCommands) expect(workflow).toContain(command);
    for (const step of criticalDatabaseSteps) expect(workflow).toContain(`- name: ${step}`);
  });
});
