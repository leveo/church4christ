import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const EXPECTED_CI_WORKFLOW_SHA256 =
  '67eacba244497232d24acde7a4fa25332d9f0ad710f01cab5a1106d1a450381f';

// Any CI workflow modification must be reviewed and this hash updated deliberately.
function validateCiWorkflow(workflow: string): void {
  expect(createHash('sha256').update(workflow.replaceAll('\r\n', '\n')).digest('hex')).toBe(
    EXPECTED_CI_WORKFLOW_SHA256,
  );
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
  });

  it('limits the build-test job to thirty minutes', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain(
      'build-test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 30',
    );
  });

  it('matches the exact reviewed CI workflow source', () => {
    validateCiWorkflow(readFileSync('.github/workflows/ci.yml', 'utf8'));
  });

  it('accepts the exact workflow source with CRLF line endings', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

    expect(() => validateCiWorkflow(workflow.replaceAll('\n', '\r\n'))).not.toThrow();
  });

  it('does not contain deployment, release, or publish commands', () => {
    const executableSource = readFileSync('.github/workflows/ci.yml', 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(executableSource).not.toMatch(
      /npm\s+(?:run\s+)?(?:deploy|release)\b|npm\s+publish\b|(?:npx\s+)?wrangler\s+deploy\b|gh\s+release\b/i,
    );
  });

  it.each([
    [
      'write permission',
      (workflow: string) =>
        workflow.replace('      contents: read', '      contents: read\n      id-token: write'),
    ],
    [
      'checkout fetch-depth override',
      (workflow: string) =>
        workflow.replace(
          '        uses: actions/checkout@v7',
          '        uses: actions/checkout@v7\n        with:\n          fetch-depth: 0',
        ),
    ],
    [
      'rogue indented scalar line',
      (workflow: string) =>
        workflow.replace(
          '        uses: actions/checkout@v7',
          '        uses: actions/checkout@v7\n          rogue scalar',
        ),
    ],
    [
      'rogue job scalar continuation',
      (workflow: string) =>
        workflow.replace(
          '    runs-on: ubuntu-latest',
          '    runs-on: ubuntu-latest\n      rogue job scalar',
        ),
    ],
    [
      'unapproved action',
      (workflow: string) =>
        workflow.replace(
          '      - name: Install dependencies',
          '      - name: Unapproved action\n        uses: example/action@v1\n\n      - name: Install dependencies',
        ),
    ],
    [
      'deployment command suffix',
      (workflow: string) => workflow.replace('        run: npm test', '        run: npm test && npm run deploy'),
    ],
    [
      'deployment command plain-scalar continuation',
      (workflow: string) =>
        workflow.replace('        run: npm test', '        run: npm test\n          && npm run deploy'),
    ],
    [
      'folded command comment content',
      (workflow: string) =>
        workflow.replace(
          `        run: >-\n          node -e "require('node:fs').mkdirSync('.tmp', { recursive: true })"`,
          `        run: >-\n          # disabled by folded content\n          node -e "require('node:fs').mkdirSync('.tmp', { recursive: true })"`,
        ),
    ],
    [
      'folded command blank line',
      (workflow: string) =>
        workflow.replace(
          `        run: >-\n          node -e "require('node:fs').mkdirSync('.tmp', { recursive: true })"`,
          `        run: >-\n\n          node -e "require('node:fs').mkdirSync('.tmp', { recursive: true })"`,
        ),
    ],
    [
      'Postgres image change',
      (workflow: string) => workflow.replace('        image: postgres:16', '        image: postgres:15'),
    ],
    [
      'Postgres environment change',
      (workflow: string) => workflow.replace('          POSTGRES_DB: postgres', '          POSTGRES_DB: app'),
    ],
    [
      'Postgres port change',
      (workflow: string) => workflow.replace('          - 5432:5432', '          - 5433:5432'),
    ],
    [
      'Postgres health option change',
      (workflow: string) => workflow.replace('          --health-interval 10s', '          --health-interval 20s'),
    ],
    [
      'concurrency group change',
      (workflow: string) => workflow.replace('  group: ci-${{ github.workflow }}-', '  group: check-${{ github.workflow }}-'),
    ],
    [
      'main push cancellation',
      (workflow: string) =>
        workflow.replace(
          "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
          "  cancel-in-progress: ${{ github.event_name == 'push' }}",
        ),
    ],
    [
      'job timeout change',
      (workflow: string) => workflow.replace('    timeout-minutes: 30', '    timeout-minutes: 31'),
    ],
    [
      'checkout major change',
      (workflow: string) => workflow.replace('actions/checkout@v7', 'actions/checkout@v6'),
    ],
    [
      'Setup Node extra input',
      (workflow: string) => workflow.replace('          cache: npm', '          cache: npm\n          always-auth: true'),
    ],
    [
      'step name change',
      (workflow: string) => workflow.replace('- name: Install dependencies', '- name: Install packages'),
    ],
    [
      'step order change',
      (workflow: string) =>
        workflow.replace(
          '      - name: Build design tokens\n        run: npm run tokens\n\n      - name: Check token contrast + no hardcoded values\n        run: npm run tokens:check',
          '      - name: Check token contrast + no hardcoded values\n        run: npm run tokens:check\n\n      - name: Build design tokens\n        run: npm run tokens',
        ),
    ],
    [
      'step environment change',
      (workflow: string) =>
        workflow.replace(
          '          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres',
          '          DATABASE_URL: postgres://postgres:postgres@localhost:5433/postgres',
        ),
    ],
    [
      'release command suffix',
      (workflow: string) => workflow.replace('        run: npm test', '        run: npm test && gh release create v1'),
    ],
    [
      'npm publish command suffix',
      (workflow: string) => workflow.replace('        run: npm test', '        run: npm test && npm publish'),
    ],
  ])('rejects CI workflow mutation: %s', (_label, mutate) => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const mutated = mutate(workflow);

    expect(mutated).not.toBe(workflow);
    expect(() => validateCiWorkflow(mutated)).toThrow();
  });
});
