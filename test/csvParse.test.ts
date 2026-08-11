import { describe, expect, it } from 'vitest';
import { parseUtf8Csv, type CsvParseLimits } from '../src/lib/csvParse';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const limits = (overrides: Partial<CsvParseLimits> = {}): CsvParseLimits => ({
  maxBytes: 1_024,
  maxRows: 20,
  maxColumns: 20,
  maxCellChars: 100,
  ...overrides,
});

describe('parseUtf8Csv', () => {
  it('parses CRLF and quoted commas and newlines', () => {
    expect(parseUtf8Csv(encode('a,b\r\n"x,y","line 1\nline 2"\r\n'), limits())).toEqual({
      ok: true,
      rows: [
        ['a', 'b'],
        ['x,y', 'line 1\nline 2'],
      ],
    });
  });

  it('normalizes CRLF inside quoted fields to LF', () => {
    expect(parseUtf8Csv(encode('a,"line 1\r\nline 2"\n'), limits())).toEqual({
      ok: true,
      rows: [['a', 'line 1\nline 2']],
    });
  });

  it('accepts and removes one leading UTF-8 BOM', () => {
    expect(parseUtf8Csv(encode('\uFEFFa,b\n1,2\n'), limits())).toEqual({
      ok: true,
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
    });
  });

  it('preserves a second leading BOM as data', () => {
    expect(parseUtf8Csv(encode('\uFEFF\uFEFFa\n'), limits())).toEqual({ ok: true, rows: [['\uFEFFa']] });
  });

  it('unescapes doubled quotes in quoted fields', () => {
    expect(parseUtf8Csv(encode('a,"b""c"\n'), limits())).toEqual({ ok: true, rows: [['a', 'b"c']] });
  });

  it('preserves empty cells including a trailing empty field', () => {
    expect(parseUtf8Csv(encode(',a,\n'), limits())).toEqual({ ok: true, rows: [['', 'a', '']] });
  });

  it('ignores records whose cells are all empty strings', () => {
    expect(parseUtf8Csv(encode('\n,\r\na,b\n,,\n'), limits())).toEqual({ ok: true, rows: [['a', 'b']] });
  });

  it('does not treat whitespace-only cells as empty records', () => {
    expect(parseUtf8Csv(encode(' ,\n'), limits())).toEqual({ ok: true, rows: [[' ', '']] });
  });

  it('parses a final record without a newline', () => {
    expect(parseUtf8Csv(encode('a,b'), limits())).toEqual({ ok: true, rows: [['a', 'b']] });
  });

  it('does not create a spurious record for a terminal newline', () => {
    expect(parseUtf8Csv(encode('a,b\n'), limits())).toEqual({ ok: true, rows: [['a', 'b']] });
  });

  it('returns no rows for an empty file or newline-only file', () => {
    expect(parseUtf8Csv(encode(''), limits())).toEqual({ ok: true, rows: [] });
    expect(parseUtf8Csv(encode('\n\r\n'), limits())).toEqual({ ok: true, rows: [] });
  });

  it('rejects malformed UTF-8 before parsing CSV', () => {
    expect(parseUtf8Csv(new Uint8Array([0xc3, 0x28]), limits())).toEqual({
      ok: false,
      code: 'invalid_utf8',
      row: null,
      column: null,
    });
  });

  it('rejects NUL bytes as a file-level error', () => {
    expect(parseUtf8Csv(encode('a,\0b'), limits())).toEqual({
      ok: false,
      code: 'nul_byte',
      row: null,
      column: null,
    });
  });

  it('reports the opening field for an unclosed quote', () => {
    expect(parseUtf8Csv(encode('a,"unterminated'), limits())).toEqual({
      ok: false,
      code: 'unclosed_quote',
      row: 1,
      column: 2,
    });
  });

  it('rejects a quote inside an unquoted field', () => {
    expect(parseUtf8Csv(encode('a,b"c\n'), limits())).toEqual({
      ok: false,
      code: 'illegal_quote',
      row: 1,
      column: 2,
    });
  });

  it('rejects any character after a closing quote before a delimiter', () => {
    expect(parseUtf8Csv(encode('a,"b" c\n'), limits())).toEqual({
      ok: false,
      code: 'illegal_quote',
      row: 1,
      column: 2,
    });
  });

  it('rejects a lone CR at a record boundary', () => {
    expect(parseUtf8Csv(encode('a,b\rc,d'), limits())).toEqual({
      ok: false,
      code: 'lone_cr',
      row: 1,
      column: 2,
    });
  });

  it('rejects a lone CR inside a quoted field', () => {
    expect(parseUtf8Csv(encode('a,"b\rc"'), limits())).toEqual({
      ok: false,
      code: 'lone_cr',
      row: 1,
      column: 2,
    });
  });

  it('enforces the byte cap before decoding and accepts the exact boundary', () => {
    const bytes = encode('a,b');
    expect(parseUtf8Csv(bytes, limits({ maxBytes: bytes.length }))).toEqual({ ok: true, rows: [['a', 'b']] });
    expect(parseUtf8Csv(bytes, limits({ maxBytes: bytes.length - 1 }))).toEqual({
      ok: false,
      code: 'file_too_large',
      row: null,
      column: null,
    });
  });

  it('counts only retained rows toward maxRows and reports the first excess logical record', () => {
    expect(parseUtf8Csv(encode('a\n\n,\nb\n'), limits({ maxRows: 1 }))).toEqual({
      ok: false,
      code: 'too_many_rows',
      row: 4,
      column: 1,
    });
  });

  it('accepts maxRows at the exact boundary', () => {
    expect(parseUtf8Csv(encode('a\nb\n'), limits({ maxRows: 2 }))).toEqual({
      ok: true,
      rows: [['a'], ['b']],
    });
  });

  it('enforces maxColumns on every logical record, including ignored empty records', () => {
    expect(parseUtf8Csv(encode(',,\na\n'), limits({ maxColumns: 2 }))).toEqual({
      ok: false,
      code: 'too_many_columns',
      row: 1,
      column: 3,
    });
  });

  it('reports a new over-limit column before parsing its contents', () => {
    expect(parseUtf8Csv(encode('a,"unterminated'), limits({ maxColumns: 1 }))).toEqual({
      ok: false,
      code: 'too_many_columns',
      row: 1,
      column: 2,
    });
  });

  it('accepts maxColumns at the exact boundary', () => {
    expect(parseUtf8Csv(encode('a,b\n'), limits({ maxColumns: 2 }))).toEqual({
      ok: true,
      rows: [['a', 'b']],
    });
  });

  it('enforces maxCellChars while appending and reports field coordinates', () => {
    expect(parseUtf8Csv(encode('a\nxy\nz\n'), limits({ maxCellChars: 1 }))).toEqual({
      ok: false,
      code: 'cell_too_long',
      row: 2,
      column: 1,
    });
  });

  it('counts Unicode code points rather than UTF-16 code units', () => {
    expect(parseUtf8Csv(encode('😀\n'), limits({ maxCellChars: 1 }))).toEqual({ ok: true, rows: [['😀']] });
    expect(parseUtf8Csv(encode('😀x\n'), limits({ maxCellChars: 1 }))).toEqual({
      ok: false,
      code: 'cell_too_long',
      row: 1,
      column: 1,
    });
  });

  it('counts a normalized quoted newline as one cell code point', () => {
    expect(parseUtf8Csv(encode('"a\r\nb"\n'), limits({ maxCellChars: 3 }))).toEqual({
      ok: true,
      rows: [['a\nb']],
    });
  });

  it.each([
    ['zero maxBytes', { maxBytes: 0 }],
    ['negative maxRows', { maxRows: -1 }],
    ['fractional maxColumns', { maxColumns: 1.5 }],
    ['infinite maxCellChars', { maxCellChars: Number.POSITIVE_INFINITY }],
  ])('throws RangeError for invalid limits: %s', (_label, overrides) => {
    expect(() => parseUtf8Csv(encode('a'), limits(overrides))).toThrow(RangeError);
  });
});
