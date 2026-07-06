// CSV helpers shared by export routes. Pure + unit-tested so the
// formula-injection neutralization can be verified without a live worker.

/**
 * Serialize one cell. First neutralizes spreadsheet formula injection: Excel and
 * Google Sheets treat a cell beginning with =, +, -, @, tab, or CR as a formula,
 * so such a cell (e.g. a crafted display name) is prefixed with a single quote.
 * Then RFC-4180-quotes any cell containing a quote, comma, or newline.
 */
export function csvCell(v: string | number | null): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
