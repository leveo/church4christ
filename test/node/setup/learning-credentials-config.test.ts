import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Learning credential secret declaration', () => {
  it('declares only the secret name in Wrangler and a value-free local example', () => {
    const config = readFileSync('wrangler.jsonc', 'utf8');
    const example = readFileSync('.dev.vars.example', 'utf8');
    expect(config).toContain('"secrets": { "required": [');
    for (const name of [
      'LEARNING_CREDENTIAL_KEYS', 'GOOGLE_CLASSROOM_CLIENT_ID', 'GOOGLE_CLASSROOM_CLIENT_SECRET',
    ]) {
      expect(config).toContain(`"${name}"`);
      expect(config).not.toMatch(new RegExp(`${name}\\s*[:=]\\s*["'][A-Za-z0-9+/={]`));
      expect(example).toContain(`# ${name}=`);
      expect(example).not.toMatch(new RegExp(`^${name}=.+$`, 'm'));
      expect(example).toContain(`wrangler secret put ${name}`);
    }
    expect(example).toContain('AES-256-GCM');
  });
});
