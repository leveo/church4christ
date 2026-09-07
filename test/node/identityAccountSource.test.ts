import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('identity account query shape', () => {
  it('does not materialize the people table to decide signup ambiguity', () => {
    const source = readFileSync(new URL('../../src/lib/identityAccount.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/SELECT\s+id\s*,\s*email\s*,\s*display_name\s+FROM\s+people/iu);
    expect(source).toContain('identity_person_canonical_keys');
    const canonical = readFileSync(new URL('../../src/lib/identityCanonical.ts', import.meta.url), 'utf8');
    expect(canonical).toMatch(/LIMIT\s+\?1/iu);
    expect(canonical).not.toMatch(/SELECT\s+p\.id\s*,\s*p\.email\s*,\s*p\.display_name\s+FROM\s+people(?![\s\S]*LIMIT)/iu);
  });
});
