import { defineConfig } from 'vitest/config';
// Same package-entry export deviation as vitest.config.ts (0.17.0 has no
// `/config` subpath): both come off the main entrypoint.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { ignoreKnownUnhandledError } from './test/e2e/knownUnhandledConfig';

// End-to-end suite: exercises the BUILT Astro worker via SELF.fetch (real
// middleware + routes), separate from the unit config so `npm test` stays fast.
// Run with `npm run test:e2e`, which builds first. See test/e2e/wrangler.e2e.jsonc
// for the worker + bindings and test/e2e/setup.ts for migrations + seed loading.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './test/e2e/wrangler.e2e.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ['test/e2e/**/*.test.ts'],
      setupFiles: ['./test/e2e/knownUnhandled.ts', './test/e2e/setup.ts'],
      // The worker pool reports this dependency rejection to Vitest's host
      // rather than dispatching it in the worker isolate. Ignore only that
      // exact CompileError; every other unhandled error remains fatal.
      onUnhandledError: ignoreKnownUnhandledError,
    },
  };
});
