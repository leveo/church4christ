// Applies all D1 migrations once per isolated-storage unit (per test file in
// pool >=0.13). migrations/ is empty in slice 1, so TEST_MIGRATIONS is [] and
// this is a no-op — applyD1Migrations tolerates zero migrations. The wiring is
// here so slices that add schema get a migrated DB for free.
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
