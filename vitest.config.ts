import { defineConfig } from 'vitest/config';
// In @cloudflare/vitest-pool-workers@0.17.0, both `cloudflareTest` and
// `readD1Migrations` are exported from the package's main entrypoint (there is
// no `/config` subpath export) — same deviation as the reference stack config.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Pure-node tests — no `cloudflare:test` imports; they exercise build scripts
// that do real filesystem reads/writes (readFileSync/writeFileSync) and call
// process.exit/process.argv, which workerd (the workers pool) cannot run.
// Everything NOT listed here defaults into the `workers` project below, so new
// workers/D1 tests need no registration and can never be silently skipped. If a
// pure test ever fails under the workers pool for an environmental reason, add
// it here with a comment.
const NODE_ONLY = ['test/tokens.test.ts', 'test/themeMeta.test.ts'];

// Three projects in one config, classified by convention (see NODE_ONLY above):
//  - `node`:    pure logic tests that need a real node filesystem/process.
//  - `workers`: everything else under test/ — runs in workerd via the pool with a
//               live D1 binding (asserted queryable in test/security-headers.test.ts).
//               migrations/0001_init.sql (added in slice 2) is applied by
//               test/setup.ts's applyD1Migrations call before test/schema.test.ts's
//               assertions run. Glob-included so any new test/*.test.ts is picked
//               up automatically (test/pg/** is excluded — it runs in the pg project).
//  - `pg`:      the Postgres-backend test layer (test/pg/**). Runs in plain node
//               against a real Postgres via postgres.js. Every suite self-skips when
//               DATABASE_URL is unset, so `npm test` stays green with no Postgres.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    test: {
      projects: [
        {
          test: {
            name: 'node',
            include: NODE_ONLY,
            environment: 'node',
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './test/wrangler.test.jsonc' },
              miniflare: {
                bindings: { TEST_MIGRATIONS: migrations },
              },
            }),
          ],
          test: {
            name: 'workers',
            include: ['test/**/*.test.ts'],
            exclude: ['test/e2e/**', 'test/pg/**', ...NODE_ONLY],
            setupFiles: ['./test/setup.ts'],
          },
        },
        {
          test: {
            name: 'pg',
            include: ['test/pg/**/*.test.ts'],
            environment: 'node',
            testTimeout: 20_000,
          },
        },
      ],
    },
  };
});
