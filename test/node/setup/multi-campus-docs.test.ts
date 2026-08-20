import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
const readme = read('README.md');
const feature = read('docs/features/multi-campus.md');
const harness = read('scripts/screenshots.mjs');

const screenshots = [
  'docs/images/admin/campuses-overview.png',
  'docs/images/admin/campus-roles.png',
] as const;

function expectReleasePng(path: string): void {
  expect(existsSync(path), `${path} should exist`).toBe(true);
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii'), path).toBe('PNG');
  expect(bytes.subarray(12, 16).toString('ascii'), path).toBe('IHDR');
  expect(bytes.readUInt32BE(16), `${path} width`).toBe(1280);
  expect(bytes.readUInt32BE(20), `${path} height`).toBe(800);
  expect(statSync(path).size, `${path} bytes`).toBeGreaterThan(20 * 1024);
}

describe('multi-campus landing documentation', () => {
  it('lists the feature in the README showcase with a clickable screenshot', () => {
    expect(readme).toMatch(
      /\[!\[\]\(docs\/images\/admin\/campuses-overview\.png\)\]\(docs\/features\/multi-campus\.md\)/,
    );
    expect(readme).toMatch(/Multi-campus[^\n]*docs\/features\/multi-campus\.md/i);
    expect(readme).toMatch(/master admin[^\n]*all campuses/i);
  });

  it('explains campus isolation, local roles, switching, and the master-admin boundary', () => {
    expect(feature).toContain('../images/admin/campuses-overview.png');
    expect(feature).toContain('../images/admin/campus-roles.png');
    expect(feature).toMatch(/one shared (?:D1 or Supabase\/Postgres )?backend/i);
    expect(feature).toMatch(/campus-specific admin roles/i);
    expect(feature).toMatch(/Only (?:a )?master admin[^\n]*all campuses/i);
    expect(feature).toMatch(/Admin[^\n]*Campuses/i);
    expect(feature).toContain('/campus/switch');
  });

  it('registers both authenticated pages in the screenshot harness', () => {
    expect(harness).toContain("path: '/admin/campuses', out: 'docs/images/admin/campuses-overview.png'");
    expect(harness).toContain("path: '/admin/campuses', out: 'docs/images/admin/campus-roles.png'");
    expect(harness).toMatch(/campus-roles\.png'[^\n]*anchor: 'Campus roles'/);
    expect(harness).toMatch(/campuses-overview\.png'[^\n]*expectedText: 'Campus management'/);
  });

  it('embeds complete real screenshots at the release viewport', () => {
    for (const path of screenshots) expectReleasePng(path);
  });
});
