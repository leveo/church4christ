import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { missingRequiredTables, qualifiedBaseTableNames } from './checks/database.mjs';

export async function verifyCanonicalDemoSeed(db) {
  try {
    const state = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM people) AS people_count,
      (SELECT email FROM people WHERE id=?) AS admin_email,
      (SELECT display_name FROM people WHERE id=?) AS admin_display_name,
      (SELECT role FROM people WHERE id=?) AS admin_role,
      (SELECT slug FROM ministries WHERE id=?) AS ministry_slug,
      (SELECT COUNT(*) FROM sermons) AS sermon_count,
      (SELECT display_name FROM learning_courses WHERE id=?) AS learning_course_name,
      (SELECT COUNT(*) FROM learning_enrollments WHERE course_id=? AND state=?) AS learning_enrollment_count,
      (SELECT COUNT(*) FROM learning_provider_credentials WHERE connection_id=?) AS learning_credential_count`)
      .bind(1, 1, 1, 10, 21000, 21000, 'active', 21000).first();
    return Number(state?.people_count) >= 10 && state?.admin_email === 'admin@example.com' &&
      state?.admin_display_name === 'Alex Admin' && state?.admin_role === 'admin' &&
      state?.ministry_slug === 'av-tech' && Number(state?.sermon_count) >= 1 &&
      state?.learning_course_name === 'Genesis 1: Creation / 创世记第一章：创造' &&
      Number(state?.learning_enrollment_count) === 2 && Number(state?.learning_credential_count) === 0;
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
