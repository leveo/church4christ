import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const d1Path = 'migrations/0027_multi_campus.sql';
const pgPath = 'migrations-supabase/0027_multi_campus.sql';
const pgE2eSetupPath = 'test/e2e-pg/setup.ts';

const stableAlterTables = (sql: string): string[] => [...sql.matchAll(
  /ALTER TABLE\s+((?:church_private\.)?[a-z_][a-z0-9_]*)\s+ADD COLUMN campus_id/gi,
)].map((match) => match[1]).sort();

describe('multi-campus D1 / Supabase schema parity', () => {
  it('ships a matching numbered Supabase migration', () => {
    expect(existsSync(d1Path)).toBe(true);
    expect(existsSync(pgPath)).toBe(true);
  });

  it('defines the same campus authority tables and default-campus upgrade', () => {
    if (!existsSync(pgPath)) return;
    const d1 = readFileSync(d1Path, 'utf8');
    const pg = readFileSync(pgPath, 'utf8');
    for (const table of ['campuses', 'campus_memberships', 'campus_modules', 'campus_settings']) {
      expect(d1).toMatch(new RegExp(`CREATE TABLE ${table}\\b`));
      expect(pg).toMatch(new RegExp(`CREATE TABLE ${table}\\b`));
    }
    for (const sql of [d1, pg]) {
      expect(sql).toContain("'main'");
      expect(sql).toContain("'Main Campus'");
      expect(sql).toContain('INSERT INTO campus_memberships');
    }
  });

  it('partitions every D1 tenant table on Postgres plus its backend-only feature tables', () => {
    if (!existsSync(pgPath)) return;
    const d1Tables = stableAlterTables(readFileSync(d1Path, 'utf8'));
    const pgTables = stableAlterTables(readFileSync(pgPath, 'utf8'));
    for (const table of d1Tables) expect(pgTables, table).toContain(table);
    for (const table of [
      'funds',
      'fund_i18n',
      'gifts',
      'recurring_gifts',
      'reg_events',
      'registrations',
      'group_files',
      'prayer_items',
      'church_private.stripe_webhook_events',
      'church_private.stripe_checkout_requests',
    ]) expect(pgTables, table).toContain(table);
  });

  it('installs automatic home-campus membership lifecycle logic on both backends', () => {
    if (!existsSync(pgPath)) return;
    const d1 = readFileSync(d1Path, 'utf8');
    const pg = readFileSync(pgPath, 'utf8');
    expect(d1).toContain('campus_membership_after_person_insert');
    expect(pg).toContain('campus_membership_after_person_insert');
    expect(d1).toMatch(/ALTER TABLE people ADD COLUMN home_campus_id INTEGER NOT NULL DEFAULT 1/);
    expect(pg).toMatch(/ALTER TABLE people\s+ADD COLUMN home_campus_id INTEGER NOT NULL DEFAULT 1;/);
    expect(pg).not.toMatch(/home_campus_id[^;]*REFERENCES campuses/i);
    expect(d1).toContain('WHERE id = NEW.home_campus_id');
    expect(pg).toContain('WHERE id = NEW.home_campus_id');
    expect(pg).toMatch(/ON DELETE CASCADE/);
  });

  it('preserves the migration-owned default campus across each Postgres e2e reseed', () => {
    const setup = readFileSync(pgE2eSetupPath, 'utf8');
    const resetExclusions = setup.match(/tablename NOT IN \(([\s\S]*?)\)/)?.[1] ?? '';
    expect(resetExclusions).toMatch(/['"]campuses['"]/);
  });
});
