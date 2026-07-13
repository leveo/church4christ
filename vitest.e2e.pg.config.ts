import { defineConfig } from 'vitest/config';
// Same package-entry export deviation as vitest.config.ts (0.17.0 has no
// `/config` subpath): cloudflareTest comes off the main entrypoint.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { ignoreKnownUnhandledError } from './test/e2e/knownUnhandledConfig';

// Postgres-backed e2e smoke: drives the BUILT worker (SELF.fetch) with the Supabase
// backend selected (DB_BACKEND=supabase) and a HYPERDRIVE binding pointed at local
// Postgres. miniflare's hyperdrive plugin, given a plain postgres:// URL (sslmode
// defaults to `disable`), wires workerd straight to the host:port over TCP — no
// proxy, no TLS — so the worker's postgres.js client reaches localhost:5434.
// Requires DATABASE_URL; `npm test` never loads this config.
//   Scope: test/e2e-pg/smoke.test.ts — the public render path + the authenticated
//   admin/leader console, proving the whole middleware→route→postgres.js stack
//   serves real pages against Postgres. The full test/e2e/** suite is NOT reused
//   here: those tests seed and verify through the D1 `env.DB` binding (98 direct
//   uses), which the Supabase-backed worker never reads, so it stays a D1-only
//   suite; this smoke test is the Postgres-side coverage instead.
// Migrate + seed: test/e2e-pg/global-setup.ts (Node, once) + test/e2e-pg/setup.ts
// (in-pool, per file). Run via `npm run test:e2e:pg`, which builds the worker first.
const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) {
  throw new Error('vitest.e2e.pg.config.ts requires DATABASE_URL (local Postgres)');
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/e2e/wrangler.e2e.jsonc' },
      miniflare: {
        hyperdrives: { HYPERDRIVE: DATABASE_URL },
        bindings: { DB_BACKEND: 'supabase' },
      },
    }),
  ],
  test: {
    include: ['test/e2e-pg/**/*.test.ts'],
    setupFiles: ['./test/e2e/knownUnhandled.ts', './test/e2e-pg/setup.ts'],
    onUnhandledError: ignoreKnownUnhandledError,
    globalSetup: ['./test/e2e-pg/global-setup.ts'],
    // One shared Postgres database, reseeded per file — files must not run
    // concurrently or they clobber each other's TRUNCATE + reseed.
    fileParallelism: false,
  },
});
