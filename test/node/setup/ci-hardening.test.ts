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

type WorkflowStep = {
  name: string;
  uses?: string;
  with?: Record<string, string>;
  run?: string;
  env?: Record<string, string>;
};

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function meaningfulLines(lines: string[]): string[] {
  return lines.filter((line) => line.trim() && !line.trimStart().startsWith('#'));
}

function nestedBlock(lines: string[], header: string): string[] {
  const start = lines.indexOf(header);
  expect(start, `missing workflow source line: ${header.trim()}`).toBeGreaterThanOrEqual(0);
  const headerIndent = indentation(header);
  let end = start + 1;

  for (; end < lines.length; end += 1) {
    const line = lines[end];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentation(line) <= headerIndent) break;
  }
  return lines.slice(start + 1, end);
}

function directMap(
  lines: string[],
  indent: number,
  nestedKeys: string[] = [],
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  let parentKey: string | undefined;
  for (const line of meaningfulLines(lines)) {
    expect(indentation(line)).toBeGreaterThanOrEqual(indent);
    if (indentation(line) > indent) {
      expect(
        parentKey !== undefined && nestedKeys.includes(parentKey),
        `unconsumed workflow source line: ${line.trim()}`,
      ).toBe(true);
      continue;
    }
    const match = line.trim().match(/^([^:]+):(?:\s(.*))?$/);
    expect(match, `invalid workflow mapping line: ${line.trim()}`).not.toBeNull();
    const key = match![1];
    expect(result, `duplicate workflow key: ${key}`).not.toHaveProperty(key);
    result[key] = match![2] ?? null;
    parentKey = key;
  }
  return result;
}

function scalarMap(lines: string[], indent: number): Record<string, string> {
  const entries = meaningfulLines(lines);
  expect(entries.every((line) => indentation(line) === indent)).toBe(true);
  const parsed = directMap(entries, indent);
  expect(Object.values(parsed).every((value) => value !== null)).toBe(true);
  return parsed as Record<string, string>;
}

function scalarList(lines: string[], indent: number): string[] {
  return meaningfulLines(lines).map((line) => {
    expect(indentation(line)).toBe(indent);
    expect(line.trim()).toMatch(/^- .+$/);
    return line.trim().slice(2);
  });
}

function foldedScalar(lines: string[], header: string, indent: number): string {
  const block = nestedBlock(lines, header).filter((line) => line.trim());
  expect(block.every((line) => indentation(line) === indent)).toBe(true);
  return block.map((line) => line.trim()).join(' ');
}

function parseWorkflowSteps(lines: string[]): WorkflowStep[] {
  const nonEmpty = lines.filter((line) => line.trim());
  const significant = meaningfulLines(lines);
  expect(
    significant
      .filter((line) => indentation(line) === 6)
      .every((line) => /^\s{6}- name: .+$/.test(line)),
  ).toBe(true);
  const starts = nonEmpty
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) => !line.trimStart().startsWith('#') && indentation(line) === 6,
    )
    .map(({ index }) => index);

  return starts.map((start, position) => {
    const segment = nonEmpty.slice(start, starts[position + 1] ?? nonEmpty.length);
    const name = segment[0].trim().slice('- name: '.length);
    const fields = directMap(segment.slice(1), 8, ['with', 'run', 'env']);
    expect(Object.keys(fields).every((key) => ['uses', 'with', 'run', 'env'].includes(key))).toBe(
      true,
    );
    let parentField: string | undefined;
    for (const line of meaningfulLines(segment.slice(1))) {
      if (indentation(line) === 8) {
        parentField = line.trim().split(':', 1)[0];
        continue;
      }
      expect(indentation(line), `unexpected workflow indentation: ${line.trim()}`).toBe(10);
      expect(
        parentField === 'with' ||
          parentField === 'env' ||
          (parentField === 'run' && fields.run === '>-'),
        `unconsumed workflow source line: ${line.trim()}`,
      ).toBe(true);
    }
    const step: WorkflowStep = { name };

    if (fields.uses !== undefined) {
      expect(fields.uses).not.toBeNull();
      step.uses = fields.uses!;
    }
    if (fields.with !== undefined) {
      expect(fields.with).toBeNull();
      step.with = scalarMap(nestedBlock(segment, '        with:'), 10);
    }
    if (fields.run !== undefined) {
      expect(fields.run).not.toBeNull();
      step.run =
        fields.run === '>-' ? foldedScalar(segment, '        run: >-', 10) : fields.run!;
    }
    if (fields.env !== undefined) {
      expect(fields.env).toBeNull();
      step.env = scalarMap(nestedBlock(segment, '        env:'), 10);
    }
    return step;
  });
}

function validateCiWorkflow(workflow: string): void {
  const lines = workflow.split('\n');
  expect(workflow).not.toContain('\t');
  expect(directMap(nestedBlock(lines, 'concurrency:'), 2)).toEqual({
    group: 'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
  });

  const jobs = nestedBlock(lines, 'jobs:');
  expect(directMap(jobs, 2, ['build-test'])).toEqual({ 'build-test': null });
  const job = nestedBlock(jobs, '  build-test:');
  expect(directMap(job, 4, ['permissions', 'services', 'steps'])).toEqual({
    'runs-on': 'ubuntu-latest',
    'timeout-minutes': '30',
    permissions: null,
    services: null,
    steps: null,
  });
  expect(scalarMap(nestedBlock(job, '    permissions:'), 6)).toEqual({ contents: 'read' });

  const services = nestedBlock(job, '    services:');
  expect(directMap(services, 6, ['postgres'])).toEqual({ postgres: null });
  const postgres = nestedBlock(services, '      postgres:');
  expect(directMap(postgres, 8, ['env', 'ports', 'options'])).toEqual({
    image: 'postgres:16',
    env: null,
    ports: null,
    options: '>-',
  });
  expect(scalarMap(nestedBlock(postgres, '        env:'), 10)).toEqual({
    POSTGRES_USER: 'postgres',
    POSTGRES_PASSWORD: 'postgres',
    POSTGRES_DB: 'postgres',
  });
  expect(scalarList(nestedBlock(postgres, '        ports:'), 10)).toEqual(['5432:5432']);
  expect(foldedScalar(postgres, '        options: >-', 10)).toBe(
    '--health-cmd "pg_isready -U postgres" --health-interval 10s --health-timeout 5s --health-retries 5',
  );

  const steps = parseWorkflowSteps(nestedBlock(job, '    steps:'));
  const databaseUrl = { DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/postgres' };
  const supabaseUrl = {
    SUPABASE_DB_URL: 'postgres://postgres:postgres@localhost:5432/postgres',
  };
  const expectedSteps: WorkflowStep[] = [
    { name: 'Checkout', uses: 'actions/checkout@v7' },
    {
      name: 'Setup Node',
      uses: 'actions/setup-node@v7',
      with: { 'node-version-file': '.nvmrc', cache: 'npm' },
    },
    { name: 'Install dependencies', run: 'npm ci' },
    {
      name: 'Verify generated design artifacts',
      run: 'test -f src/styles/tokens.generated.css && test -f src/lib/themeMeta.generated.ts',
    },
    { name: 'Generate Cloudflare Worker types', run: 'npx wrangler types' },
    {
      name: 'Prepare test reports',
      run: `node -e "require('node:fs').mkdirSync('.tmp', { recursive: true })"`,
    },
    { name: 'Check generated capability documentation', run: 'npm run docs:check' },
    {
      name: 'Prove setup dry-run and clean D1 install',
      run: 'npx vitest run --project node test/setup/dry-run.test.ts test/setup/clean-room-d1.test.ts',
    },
    {
      name: 'Prove clean Supabase setup',
      run: 'npx vitest run --project node test/setup/clean-room-pg.test.ts --reporter=json --outputFile=.tmp/setup-pg.json',
      env: databaseUrl,
    },
    {
      name: 'Assert Supabase setup test did not skip',
      run: 'node scripts/ci/assert-vitest-json.mjs .tmp/setup-pg.json 1',
    },
    { name: 'Build design tokens', run: 'npm run tokens' },
    { name: 'Check token contrast + no hardcoded values', run: 'npm run tokens:check' },
    { name: 'Run tests (node + workers projects)', run: 'npm test' },
    { name: 'Type check', run: 'npm run check' },
    { name: 'Build', run: 'npm run build' },
    { name: 'Apply D1 migrations (local)', run: 'npm run db:migrate:local' },
    { name: 'Seed demo data (local)', run: 'npm run db:seed:local' },
    { name: 'Seed local media objects', run: 'npm run db:seed-media:local' },
    { name: 'Smoke test', run: 'bash scripts/smoke.sh' },
    { name: 'End-to-end tests (built worker)', run: 'npm run test:e2e' },
    {
      name: 'Apply Supabase migrations (Postgres)',
      run: 'npm run db:migrate:supabase',
      env: supabaseUrl,
    },
    {
      name: 'Seed demo data (Postgres)',
      run: 'npm run db:seed:supabase',
      env: supabaseUrl,
    },
    {
      name: 'Postgres backend tests (pg project)',
      run: 'npx vitest run --project pg --reporter=json --outputFile=.tmp/pg.json',
      env: databaseUrl,
    },
    {
      name: 'Assert Postgres project did not skip',
      run: 'node scripts/ci/assert-vitest-json.mjs .tmp/pg.json 1',
    },
    { name: 'End-to-end tests (Postgres worker)', run: 'npm run test:e2e:pg', env: databaseUrl },
  ];

  expect(steps).toEqual(expectedSteps);
  for (const command of steps.flatMap((step) => (step.run ? [step.run] : []))) {
    expect(command).not.toMatch(
      /(?:^|(?:&&|\|\||;)\s*)(?:npm\s+(?:run\s+)?(?:deploy|release)\b|npm\s+publish\b|(?:npx\s+)?wrangler\s+deploy\b|gh\s+release\b)/i,
    );
  }
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

  it('preserves permissions, Postgres, caching, and every CI run step', () => {
    validateCiWorkflow(readFileSync('.github/workflows/ci.yml', 'utf8'));
  });

  it('accepts a safe folded multiline run command', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const folded = workflow.replace(
      `          node -e "require('node:fs').mkdirSync('.tmp', { recursive: true })"`,
      `          node -e\n          "require('node:fs').mkdirSync('.tmp', { recursive: true })"`,
    );

    expect(folded).not.toBe(workflow);
    expect(() => validateCiWorkflow(folded)).not.toThrow();
  });

  it('allows comments outside block scalars and between mapping entries', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const commented = workflow
      .replace('name: CI', '# workflow comment\nname: CI')
      .replace(
        '        uses: actions/checkout@v7',
        '        # checkout mapping comment\n        uses: actions/checkout@v7',
      );

    expect(commented).not.toBe(workflow);
    expect(() => validateCiWorkflow(commented)).not.toThrow();
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
