import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DESIGN_IMAGES } from '../../src/lib/designAssets';

describe('bundled design imagery', () => {
  it('ships every same-origin image for both empty and demo installs within a small payload', () => {
    const manifest = JSON.parse(readFileSync(resolve('public/images/design/manifest.json'), 'utf8'));
    let bytes = 0;
    for (const url of Object.values(DESIGN_IMAGES)) {
      expect(url.startsWith('/images/design/')).toBe(true);
      const file = url.split('/').at(-1);
      const asset = manifest.assets.find((entry: {file: string}) => entry.file === file);
      expect(asset, `${url} has a provenance and dimension record`).toBeDefined();
      const actual = readFileSync(resolve(`public${url}`));
      expect(actual.subarray(0,4).toString()).toBe('RIFF');
      expect(actual.subarray(8,12).toString()).toBe('WEBP');
      expect(statSync(resolve(`public${url}`)).size).toBe(asset.bytes);
      expect(asset.width).toBeGreaterThanOrEqual(1200);
      expect(asset.height).toBeGreaterThan(600);
      expect(asset.bytes).toBeLessThan(200_000);
      bytes += asset.bytes;
    }
    expect(bytes).toBeLessThan(1_000_000);
  });
});
