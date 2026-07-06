import { defineConfig } from 'vitest/config';
// Same package-entry export deviation as vitest.config.ts (0.17.0 has no
// `/config` subpath): both come off the main entrypoint.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

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
      setupFiles: ['./test/e2e/setup.ts'],
      // The built worker eagerly WebAssembly.compile()s es-module-lexer at module
      // init; the test pool blocks buffer-compiled WASM, but that lexer is never
      // used at request time, so the rejection is benign noise — don't fail on it.
      // (Ported verbatim from the reference stack's e2e config.)
      dangerouslyIgnoreUnhandledErrors: true,
    },
  };
});
