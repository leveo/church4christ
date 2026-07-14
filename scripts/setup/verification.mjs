import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { missingRequiredTables, qualifiedBaseTableNames } from './checks/database.mjs';

export async function verifyCanonicalDemoSeed(db) {
  try {
    const people = await db.prepare('SELECT COUNT(*) AS count FROM people').first();
    const admin = await db.prepare('SELECT email, display_name, role FROM people WHERE id=?').bind(1).first();
    const ministry = await db.prepare('SELECT slug FROM ministries WHERE id=?').bind(10).first();
    const sermons = await db.prepare('SELECT COUNT(*) AS count FROM sermons').first();
    return Number(people?.count) >= 10 && admin?.email === 'admin@example.com' &&
      admin?.display_name === 'Alex Admin' && admin?.role === 'admin' && ministry?.slug === 'av-tech' && Number(sermons?.count) >= 1;
  } catch { return false; }
}

export async function verifyMigrationCompleteness({ db, backend, catalog, root }) {
  try {
    if (backend === 'd1') {
      const rows = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).results;
      if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.name !== 'string')) return false;
      if (missingRequiredTables(catalog, backend, new Set(rows.map((row) => row.name))).length !== 0) return false;
      const expected = (await readdir(resolve(root, 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
      const history = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results;
      return Array.isArray(history) && history.length === expected.length && history.every((row, index) => row?.name === expected[index]);
    }
    const tableRows = (await db.prepare(
      'SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema IN (?,?) AND table_type=? ORDER BY table_schema, table_name',
    ).bind('public', 'church_private', 'BASE TABLE').all()).results;
    const relations = qualifiedBaseTableNames(tableRows);
    if (missingRequiredTables(catalog, backend, relations).length !== 0) return false;
    const expected = (await readdir(resolve(root, 'migrations-supabase'))).filter((name) => name.endsWith('.sql')).sort();
    const rows = (await db.prepare('SELECT name FROM _migrations ORDER BY name').all()).results;
    return Array.isArray(rows) && rows.length === expected.length && rows.every((row, index) => row?.name === expected[index]);
  } catch { return false; }
}
