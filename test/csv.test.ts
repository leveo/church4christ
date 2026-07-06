import { describe, expect, it } from 'vitest';
import { csvCell } from '../src/lib/csv';

describe('csvCell — formula-injection neutralization', () => {
  it('prefixes a single quote on cells starting with = + - @ tab or CR', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+cmd')).toBe("'+cmd");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tvalue')).toBe("'\tvalue");
  });

  it('quotes cells containing a comma, quote, or newline (after neutralizing)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=danger,too')).toBe('"\'=danger,too"');
  });

  it('leaves plain cells untouched and renders null/number safely', () => {
    expect(csvCell('Sarah Johnson')).toBe('Sarah Johnson');
    expect(csvCell(7)).toBe('7');
    expect(csvCell(null)).toBe('');
  });
});
