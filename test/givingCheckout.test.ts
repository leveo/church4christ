// Pure checkout-form parsing (workers project — no Astro, no DB). parseAmountToCents
// turns a dollars string into integer cents and enforces the $1.00–$99,999.99
// band; parseFrequency whitelists the three cadences. These are the bits of the
// checkout endpoint that are worth unit-testing away from the request lifecycle.
import { describe, expect, it } from 'vitest';
import { parseAmountToCents, parseFrequency } from '../src/lib/givingCheckout';

describe('parseAmountToCents', () => {
  const ok: [string, number][] = [
    ['50', 5000],
    ['50.00', 5000],
    ['1', 100], // exactly the floor
    ['1.00', 100],
    ['0.99', -1], // below floor → rejected (sentinel replaced below)
    ['99999.99', 9_999_999], // exactly the ceiling
    ['  25  ', 2500], // trimmed
    ['12.5', 1250],
    ['12.34', 1234],
  ];
  for (const [input, expected] of ok) {
    if (expected < 0) continue;
    it(`"${input}" → ${expected}`, () => {
      expect(parseAmountToCents(input)).toBe(expected);
    });
  }

  const rejected = ['', '0', '0.99', '0.50', 'abc', '-5', '5.005', '1e3', '100000', '1000000', '.5', '50.', '  '];
  for (const input of rejected) {
    it(`rejects "${input}"`, () => {
      expect(parseAmountToCents(input)).toBeNull();
    });
  }
});

describe('parseFrequency', () => {
  it('accepts the three cadences', () => {
    expect(parseFrequency('once')).toBe('once');
    expect(parseFrequency('week')).toBe('week');
    expect(parseFrequency('month')).toBe('month');
  });
  it('rejects anything else (defaults handled by caller)', () => {
    expect(parseFrequency('year')).toBeNull();
    expect(parseFrequency('')).toBeNull();
    expect(parseFrequency(null)).toBeNull();
    expect(parseFrequency('ONCE')).toBeNull();
  });
});
