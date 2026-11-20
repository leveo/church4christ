import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

// The option-key statement of 0052: every existing option string becomes its own key and is
// copied into option_labels for each language row; malformed options are skipped, not fatal.
const sql = readFileSync('migrations/0052_registration_builder.sql', 'utf8');
const start = sql.indexOf('UPDATE reg_question_i18n');
const statement = sql.slice(start, sql.indexOf(';', start) + 1);

describe('0052 option-key migration on D1', () => {
  it('copies option strings into option_labels per language and skips malformed options', () => {
    expect(statement).toContain('json_each');
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE reg_questions (id INTEGER PRIMARY KEY, options TEXT);
      CREATE TABLE reg_question_i18n (question_id INTEGER NOT NULL, locale TEXT NOT NULL, label TEXT NOT NULL, option_labels TEXT);
      INSERT INTO reg_questions VALUES (1, '["Small","Large (XL)"]'), (2, NULL), (3, 'not json'), (4, '[1,2]'), (5, '{"a":"b"}');
      INSERT INTO reg_question_i18n (question_id, locale, label) VALUES
        (1,'en','Size'), (1,'zh','尺寸'), (2,'en','Notes'), (3,'en','Broken'), (4,'en','Numbers'), (5,'en','Object');
    `);
    db.exec(statement);
    const rows = db.prepare('SELECT question_id, locale, option_labels FROM reg_question_i18n ORDER BY question_id, locale').all() as Array<{ question_id: number; locale: string; option_labels: string | null }>;
    const expected = { Small: 'Small', 'Large (XL)': 'Large (XL)' };
    expect(rows.map((r) => [r.question_id, r.locale, r.option_labels === null ? null : JSON.parse(r.option_labels)])).toEqual([
      [1, 'en', expected], [1, 'zh', expected], [2, 'en', null], [3, 'en', null], [4, 'en', null], [5, 'en', null],
    ]);
  });
});
