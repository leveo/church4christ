// e2e setup: migrate the isolated D1, then load the demo seed so every e2e file
// runs SELF.fetch against a populated site. Runs once per isolated-storage unit
// (per test file); the seeded rows become the baseline each test starts from
// (isolated storage rolls back per-test writes). The ?raw import + comment-strip
// + ';'-split is the exact pattern test/seed.test.ts uses.
import { applyD1Migrations, env } from 'cloudflare:test';
import seedSql from '../../seed/dev-seed.sql?raw';

function seedStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
for (const statement of seedStatements(seedSql)) {
  await env.DB.prepare(statement).run();
}
