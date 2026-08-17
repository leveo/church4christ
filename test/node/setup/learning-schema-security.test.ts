import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LEARNING_TABLES = [
  'learning_activities',
  'learning_activity_events',
  'learning_courses',
  'learning_enrollments',
  'learning_identity_links',
  'learning_programs',
  'learning_provider_connections',
  'learning_provider_credentials',
  'learning_resources',
  'learning_submission_snapshots',
  'learning_sync_runs',
];

const migration = readFileSync('migrations-supabase/0017_learning.sql', 'utf8');

function tableList(value: string): string[] {
  return value.split(',').map((table) => table.trim()).sort();
}

describe('Learning Supabase server-only migration boundary', () => {
  it('enables RLS on exactly every Learning table without adding browser policies', () => {
    const rlsTables = [...migration.matchAll(
      /ALTER TABLE\s+(learning_[a-z_]+)\s+ENABLE ROW LEVEL SECURITY\s*;/gi,
    )].map((match) => match[1]).sort();
    expect(rlsTables).toEqual(LEARNING_TABLES);
    expect(migration).not.toMatch(/\bCREATE\s+POLICY\b/i);
  });

  it('unconditionally revokes every Learning table privilege from PUBLIC', () => {
    const revoke = migration.match(/REVOKE ALL ON TABLE\s+([\s\S]*?)\s+FROM PUBLIC\s*;/i);
    expect(revoke).not.toBeNull();
    expect(tableList(revoke?.[1] ?? '')).toEqual(LEARNING_TABLES);
  });

  it('conditionally revokes every Learning table privilege from anon and authenticated', () => {
    expect(migration).toMatch(/ARRAY\s*\[\s*'anon'\s*,\s*'authenticated'\s*\]/i);
    expect(migration).toMatch(/IF EXISTS\s*\(\s*SELECT 1 FROM pg_roles WHERE rolname\s*=\s*client_role\s*\)/i);
    const revoke = migration.match(
      /EXECUTE format\(\s*'REVOKE ALL ON TABLE\s+([\s\S]*?)\s+FROM %I'\s*,\s*client_role\s*\)/i,
    );
    expect(revoke).not.toBeNull();
    expect(tableList(revoke?.[1] ?? '')).toEqual(LEARNING_TABLES);
  });
});
