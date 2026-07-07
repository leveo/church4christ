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
  it('numbers a bare ? as one past the largest numbered placeholder (SQLite rule)', () => {
    // A numbered head query (?1, ?2) splicing an anonymous IN-list (?) must number
    // the bare ? as $3 — NOT restart at $1 and collide with ?1. This is the
    // getNeedsAttention leader-scope query that produced `integer = text` on
    // Postgres before the fix, and it mirrors SQLite's "largest assigned so far + 1".
    expect(translatePlaceholders('WHERE d >= ?1 AND d <= ?2 AND id IN (?)')).toBe(
      'WHERE d >= $1 AND d <= $2 AND id IN ($3)',
    );
  });
  it('a bare ? continues past a higher explicit number', () => {
    expect(translatePlaceholders('VALUES (?5, ?)')).toBe('VALUES ($5, $6)');
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
