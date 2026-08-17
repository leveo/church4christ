import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Learning connection administration page', () => {
  it('renders safe create/update/health/reconnect/disconnect forms from metadata only', () => {
    const page = readFileSync('src/pages/admin/learning/index.astro', 'utf8');
    expect(page).toContain('listLearningConnections');
    expect(page).toContain('action="/admin/learning/connections"');
    for (const action of ['create', 'update', 'health_check', 'reconnect', 'disconnect']) {
      expect(page).toContain(`value="${action}"`);
    }
    expect(page).toContain('type="password"');
    expect(page).toContain('autocomplete="off"');
    expect(page).not.toMatch(/\bciphertext\b|\bnonce\b|\bkeyVersion\b|\bclientSecret\b|\bkey_version\b|\bclient_secret\b/);
  });
});
