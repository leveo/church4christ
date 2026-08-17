import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Learning credential secret declaration', () => {
  it('declares only the secret name in Wrangler and a value-free local example', () => {
    const config = readFileSync('wrangler.jsonc', 'utf8');
    const example = readFileSync('.dev.vars.example', 'utf8');
    expect(config).toContain('"secrets": { "required": ["LEARNING_CREDENTIAL_KEYS"] }');
    expect(config).not.toMatch(/LEARNING_CREDENTIAL_KEYS\s*[:=]\s*["'][A-Za-z0-9+/={]/);
    expect(example).toContain('# LEARNING_CREDENTIAL_KEYS=');
    expect(example).not.toMatch(/^LEARNING_CREDENTIAL_KEYS=.+$/m);
    expect(example).toContain('AES-256-GCM');
    expect(example).toContain('wrangler secret put LEARNING_CREDENTIAL_KEYS');
  });
});
