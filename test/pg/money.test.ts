// formatCents display helper — PURE (no DB, no skipIf). Lives under test/pg/ so
// it runs in the plain-node `pg` project, but touches no Postgres, so it runs
// (and must stay green) whether or not DATABASE_URL is set. Money is integer
// cents everywhere in the giving module; this is the single seam that turns cents
// into human money for the member/admin views.
import { describe, it, expect } from 'vitest';
import { formatCents } from '../../src/lib/money';

describe('formatCents', () => {
  it('formats USD as $X,XXX.XX (grouping + 2 decimals)', () => {
    expect(formatCents(123456, 'usd')).toBe('$1,234.56');
  });

  it('formats zero', () => {
    expect(formatCents(0, 'usd')).toBe('$0.00');
  });

  it('pads sub-dollar amounts with a leading zero', () => {
    expect(formatCents(5, 'usd')).toBe('$0.05');
    expect(formatCents(50, 'usd')).toBe('$0.50');
  });

  it('groups thousands in large amounts', () => {
    expect(formatCents(100000000, 'usd')).toBe('$1,000,000.00');
  });

  it('renders negatives (refunds) sanely with a leading minus', () => {
    expect(formatCents(-123456, 'usd')).toBe('-$1,234.56');
  });

  it('defaults to USD when the currency is omitted', () => {
    expect(formatCents(1000)).toBe('$10.00');
  });

  it('is case-insensitive on the currency code', () => {
    expect(formatCents(1000, 'USD')).toBe('$10.00');
  });

  it('falls back to an uppercase code prefix for non-USD currencies', () => {
    expect(formatCents(1234, 'cad')).toBe('CAD 12.34');
  });

  it('keeps the sign in the non-USD fallback', () => {
    expect(formatCents(-1234, 'cad')).toBe('-CAD 12.34');
  });
});
