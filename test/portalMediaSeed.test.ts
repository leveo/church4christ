import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('portal group-file R2 demo fixture', () => {
  it('declares the seeded group-file object and includes it in the local R2 dry run', () => {
    const manifest = JSON.parse(readFileSync('seed/portal-files/manifest.json', 'utf8')) as {
      files: Array<{ file: string; key: string; contentType: string }>;
    };
    expect(manifest.files).toEqual([
      {
        file: 'young-adults-welcome.pdf',
        key: 'group-files/1/demo-young-adults-welcome.pdf',
        contentType: 'application/pdf',
      },
    ]);

    const output = execFileSync('node', ['scripts/db/seed-media-local.mjs', '--dry-run'], { encoding: 'utf8' });
    expect(output).toContain('church4christ-media/group-files/1/demo-young-adults-welcome.pdf');
    expect(output).toContain('seed/portal-files/young-adults-welcome.pdf');
  });
});
