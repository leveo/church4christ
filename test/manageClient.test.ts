// The manage page script reads its credential from the URL fragment only.
import { describe, expect, it } from 'vitest';
import { tokenFromHash } from '../src/lib/manage-client';

describe('tokenFromHash', () => {
  const token = 'A'.repeat(21) + '-_' + 'b'.repeat(20);
  it('reads a well-formed #t= fragment', () => {
    expect(token).toHaveLength(43);
    expect(tokenFromHash(`#t=${token}`)).toBe(token);
  });
  it('rejects anything else, including a token in a query-like position or the wrong length', () => {
    for (const hash of ['', '#', `#${token}`, `#t=${token}x`, `#t=${token.slice(1)}`, `#x=1&t=${token}`, `?t=${token}`, '#t=%3Cscript%3E']) {
      expect(tokenFromHash(hash)).toBeNull();
    }
  });
});
