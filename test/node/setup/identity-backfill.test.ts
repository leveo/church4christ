import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sqlite(database: string, sql: string): string {
  return execFileSync('sqlite3', ['-batch', '-noheader', '-separator', '|', database], { encoding: 'utf8', input: sql });
}

describe('member identity legacy-email backfill', () => {
  it('backfills only unique eligible ASCII emails and fails normalized collisions closed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'c4c-member-identity-'));
    const database = join(directory, 'upgrade.sqlite3');
    try {
      for (const file of readdirSync('migrations').filter((file) => file < '0028_member_identity.sql').sort()) {
        sqlite(database, readFileSync(`migrations/${file}`, 'utf8'));
      }
      sqlite(database, `
        INSERT INTO people (id,display_name,email) VALUES
          (88251,'Unique','Unique@Example.Test'),
          (88252,'Collision one','Collision@Example.Test'),
          (88253,'Collision two','collision@example.test'),
          (88254,'Deleted','deleted@example.test'),
          (88255,'Inactive','inactive@example.test'),
          (88256,'Unicode','tést@example.test'),
          (88257,'Whitespace alias','Unique@Example.Test '),
          (88258,'Second at','second@at@example.test');
        UPDATE people SET deleted_at=datetime('now') WHERE id=88254;
        UPDATE people SET active=0 WHERE id=88255;
      `);
      sqlite(database, readFileSync('migrations/0028_member_identity.sql', 'utf8'));
      expect(sqlite(database, `
        SELECT normalized_value FROM contact_points WHERE kind='email' ORDER BY normalized_value;
        SELECT point.normalized_value,owner.person_id FROM verified_contact_owners owner JOIN contact_points point ON point.id=owner.contact_point_id ORDER BY point.normalized_value;
      `).trim()).toBe([
        'collision@example.test',
        'unique@example.test',
        'unique@example.test|88251',
      ].join('\n'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
