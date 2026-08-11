export interface CsvParseLimits {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
  maxCellChars: number;
}

export type CsvParseErrorCode =
  | 'file_too_large'
  | 'invalid_utf8'
  | 'nul_byte'
  | 'unclosed_quote'
  | 'illegal_quote'
  | 'lone_cr'
  | 'too_many_rows'
  | 'too_many_columns'
  | 'cell_too_long';

type CsvParseFailure = { ok: false; code: CsvParseErrorCode; row: number | null; column: number | null };

export type CsvParseResult = { ok: true; rows: string[][] } | CsvParseFailure;

export type CsvParseWithRowNumbersResult =
  | { ok: true; rows: string[][]; rowNumbers: number[] }
  | CsvParseFailure;

type CsvState = 'fieldStart' | 'unquoted' | 'quoted' | 'afterQuote';

function csvError(code: CsvParseErrorCode, row: number | null, column: number | null): CsvParseFailure {
  return { ok: false, code, row, column };
}

function assertLimits(limits: CsvParseLimits): void {
  for (const value of [limits.maxBytes, limits.maxRows, limits.maxColumns, limits.maxCellChars]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError('CSV parse limits must be safe positive integers');
    }
  }
}

export function parseUtf8CsvWithRowNumbers(
  bytes: Uint8Array,
  limits: CsvParseLimits,
): CsvParseWithRowNumbersResult {
  assertLimits(limits);

  if (bytes.byteLength > limits.maxBytes) {
    return csvError('file_too_large', null, null);
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return csvError('invalid_utf8', null, null);
  }

  if (source.includes('\0')) {
    return csvError('nul_byte', null, null);
  }

  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  let record: string[] = [];
  let field = '';
  let fieldChars = 0;
  let row = 1;
  let column = 1;
  let state: CsvState = 'fieldStart';
  let recordStarted = false;

  const append = (value: string): CsvParseFailure | null => {
    fieldChars += 1;
    if (fieldChars > limits.maxCellChars) {
      return csvError('cell_too_long', row, column);
    }
    field += value;
    return null;
  };

  const finishField = (): CsvParseFailure | null => {
    if (record.length + 1 > limits.maxColumns) {
      return csvError('too_many_columns', row, column);
    }
    record.push(field);
    field = '';
    fieldChars = 0;
    return null;
  };

  const finishRecord = (): CsvParseFailure | null => {
    const fieldError = finishField();
    if (fieldError) return fieldError;

    if (record.some((cell) => cell !== '')) {
      if (rows.length + 1 > limits.maxRows) {
        return csvError('too_many_rows', row, 1);
      }
      rows.push(record);
      rowNumbers.push(row);
    }

    record = [];
    field = '';
    fieldChars = 0;
    row += 1;
    column = 1;
    state = 'fieldStart';
    recordStarted = false;
    return null;
  };

  let offset = 0;
  while (offset < source.length) {
    const codePoint = source.codePointAt(offset);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const width = char.length;

    if (state === 'quoted') {
      if (char === '"') {
        state = 'afterQuote';
        offset += width;
        continue;
      }
      if (char === '\r') {
        if (source[offset + 1] !== '\n') return csvError('lone_cr', row, column);
        const appendError = append('\n');
        if (appendError) return appendError;
        offset += 2;
        continue;
      }

      const appendError = append(char);
      if (appendError) return appendError;
      offset += width;
      continue;
    }

    if (state === 'afterQuote') {
      if (char === '"') {
        const appendError = append('"');
        if (appendError) return appendError;
        state = 'quoted';
        offset += width;
        continue;
      }
      if (char !== ',' && char !== '\n' && char !== '\r') {
        return csvError('illegal_quote', row, column);
      }
    } else if (char === '"') {
      if (state === 'unquoted') return csvError('illegal_quote', row, column);
      state = 'quoted';
      recordStarted = true;
      offset += width;
      continue;
    }

    if (char === ',') {
      const fieldError = finishField();
      if (fieldError) return fieldError;
      column += 1;
      if (column > limits.maxColumns) {
        return csvError('too_many_columns', row, column);
      }
      state = 'fieldStart';
      recordStarted = true;
      offset += width;
      continue;
    }

    if (char === '\n') {
      const recordError = finishRecord();
      if (recordError) return recordError;
      offset += width;
      continue;
    }

    if (char === '\r') {
      if (source[offset + 1] !== '\n') return csvError('lone_cr', row, column);
      const recordError = finishRecord();
      if (recordError) return recordError;
      offset += 2;
      continue;
    }

    const appendError = append(char);
    if (appendError) return appendError;
    state = 'unquoted';
    recordStarted = true;
    offset += width;
  }

  if (state === 'quoted') {
    return csvError('unclosed_quote', row, column);
  }

  if (recordStarted || record.length > 0 || field !== '') {
    const recordError = finishRecord();
    if (recordError) return recordError;
  }

  return { ok: true, rows, rowNumbers };
}

export function parseUtf8Csv(bytes: Uint8Array, limits: CsvParseLimits): CsvParseResult {
  const result = parseUtf8CsvWithRowNumbers(bytes, limits);
  if (!result.ok) return result;
  return { ok: true, rows: result.rows };
}
