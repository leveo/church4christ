import { defineConfig } from 'vitest/config';
// In @cloudflare/vitest-pool-workers@0.17.0, both `cloudflareTest` and
// `readD1Migrations` are exported from the package's main entrypoint (there is
// no `/config` subpath export) — same deviation as the dcfc-serve config.
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Two projects in one config:
//  - `node`:    pure logic tests (tokens, locales, i18n) in a plain node env.
//  - `workers`: runs in workerd via the pool with a live D1 binding (asserted
//               queryable in test/security-headers.test.ts). migrations/0001_init.sql
//               (added in slice 2) is applied by test/setup.ts's applyD1Migrations
//               call before test/schema.test.ts's assertions run.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    test: {
      projects: [
        {
          test: {
            name: 'node',
            include: [
              'test/tokens.test.ts',
              'test/locales.test.ts',
              'test/i18n.test.ts',
              'test/validate.test.ts',
              'test/dates.test.ts',
              'test/youtube.test.ts',
            ],
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
            include: [
              'test/security-headers.test.ts',
              'test/schema.test.ts',
              'test/db.test.ts',
              'test/settings.test.ts',
            ],
            setupFiles: ['./test/setup.ts'],
          },
        },
      ],
    },
  };
});
