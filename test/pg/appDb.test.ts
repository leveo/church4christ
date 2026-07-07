import { describe, it, expect } from 'vitest';
import { hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('pg project wiring', () => {
  it('connects and round-trips a value', async () => {
    const sql = pgClient();
    try {
      await resetSchema(sql);
      const rows = await sql.unsafe('SELECT 1 + 1 AS two');
      expect(rows[0].two).toBe(2);
    } finally {
      await sql.end();
    }
  });
});
