import { describe, it, expect } from 'vitest';
import { translatePlaceholders } from '../../src/lib/pgAdapter';

describe('translatePlaceholders', () => {
  it('numbers anonymous placeholders in order', () => {
    expect(translatePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });
  it('maps numbered placeholders directly', () => {
    expect(translatePlaceholders('WHERE (?1 = \'\' OR name LIKE ?2)')).toBe(
      "WHERE ($1 = '' OR name LIKE $2)",
    );
  });
  it('ignores ? inside single-quoted strings (with escaped quotes)', () => {
    expect(translatePlaceholders("SELECT 'a?b', 'it''s?' , ?")).toBe("SELECT 'a?b', 'it''s?' , $1");
  });
  it('ignores ? inside double-quoted identifiers and comments', () => {
    expect(translatePlaceholders('SELECT "we?ird" FROM t -- what?\nWHERE x = ?')).toBe(
      'SELECT "we?ird" FROM t -- what?\nWHERE x = $1',
    );
    expect(translatePlaceholders('SELECT /* ?? */ ?')).toBe('SELECT /* ?? */ $1');
  });
});
