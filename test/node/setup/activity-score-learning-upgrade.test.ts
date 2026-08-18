import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sqlite(database: string, sql: string): string {
  return execFileSync('sqlite3', ['-batch', '-noheader', '-separator', '|', database], {
    encoding: 'utf8', input: sql,
  });
}

describe('Activity Score 0016 to 0026 D1 history upgrade', () => {
  it('preserves the complete existing model and adds Learning disabled with weight zero', () => {
    const directory = mkdtempSync(join(tmpdir(), 'c4c-activity-learning-d1-'));
    const database = join(directory, 'upgrade.sqlite3');
    try {
      sqlite(database, readFileSync('migrations/0001_init.sql', 'utf8'));
      sqlite(database, readFileSync('migrations/0003_people.sql', 'utf8'));
      sqlite(database, readFileSync('migrations/0016_activity_score.sql', 'utf8'));
      sqlite(database, `
        INSERT INTO people (id,display_name,email) VALUES (26,'Config owner','owner-26@example.test');
        UPDATE activity_score_config SET window_days=60, active_threshold=80,
          watch_threshold=25, revision=7, last_mutation_id='preserved', updated_by_person_id=26
          WHERE id=1;
        UPDATE activity_score_dimensions SET enabled=1,weight=70 WHERE dimension_key='group_attendance';
        UPDATE activity_score_dimensions SET enabled=1,weight=30,target_count=9 WHERE dimension_key='serving';
      `);

      sqlite(database, readFileSync('migrations/0026_activity_score_learning.sql', 'utf8'));

      expect(sqlite(database, `
        SELECT window_days,active_threshold,watch_threshold,revision,last_mutation_id,updated_by_person_id
          FROM activity_score_config WHERE id=1;
        SELECT dimension_key,enabled,weight,COALESCE(target_count,'NULL')
          FROM activity_score_dimensions ORDER BY dimension_key;
      `).trim()).toBe([
        '60|80|25|7|preserved|26',
        'group_attendance|1|70|NULL',
        'learning_engagement|0|0|3',
        'registration|0|0|2',
        'serving|1|30|9',
      ].join('\n'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
