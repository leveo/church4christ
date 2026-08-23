import { describe, expect, it } from 'vitest';
import { hasValidMutationProvenance } from '../src/lib/csrf';

describe('Planning Center webhook mutation provenance', () => {
  it('lets the exact signed-webhook route reach its HMAC handler without browser headers', () => {
    expect(hasValidMutationProvenance(new Request(
      'https://church.example/api/planning-center/webhook/123',
      { method: 'POST' },
    ))).toBe(true);
  });

  it('does not exempt lookalike Planning Center paths', () => {
    expect(hasValidMutationProvenance(new Request(
      'https://church.example/api/planning-center/webhook-evil/123',
      { method: 'POST' },
    ))).toBe(false);
  });
});
