import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import raw from '../../../config/capabilities.json';
import {
  renderCapabilityTable,
  replaceGeneratedSection,
} from '../../../scripts/docs/generate-capabilities.mjs';

const docs = [
  'README.md',
  'docs/features/modules.md',
  'docs/architecture.md',
  'docs/deploy.md',
  'docs/cloudflare-setup.md',
  'docs/supabase-setup.md',
  'docs/why-this-stack.md',
  'CONTRIBUTING.md',
];

describe('catalog-owned docs', () => {
  it('renders all 16 modules and exactly three Supabase requirements', () => {
    const table = renderCapabilityTable(raw);
    expect(raw.order.every((key) => table.includes(`\`${key}\``))).toBe(true);
    expect((table.match(/Supabase/g) ?? [])).toHaveLength(3);
  });

  it('has current generated markers and no unsupported migration promise', () => {
    for (const path of docs) {
      const text = readFileSync(path, 'utf8');
      expect(text).not.toMatch(
        /15 modules|two modules need|everything except (online )?giving and registration/i,
      );
      expect(text).not.toMatch(/switch later[^.\n]*(nothing is lost|without losing)/i);
    }

    for (const path of ['README.md', 'docs/features/modules.md', 'docs/architecture.md']) {
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('<!-- capabilities:start -->');
      expect(text).toContain('<!-- capabilities:end -->');
    }

    const moduleDoc = readFileSync('docs/features/modules.md', 'utf8');
    expect(moduleDoc).toContain('Member Portal');
    expect(moduleDoc).toMatch(/`registration`[^\n]*Registration/);
  });

  it('replacing a generated section preserves surrounding prose', () => {
    expect(
      replaceGeneratedSection(
        'before\n<!-- capabilities:start -->\nold\n<!-- capabilities:end -->\nafter\n',
        'new',
      ),
    ).toBe('before\n<!-- capabilities:start -->\nnew\n<!-- capabilities:end -->\nafter\n');
  });

  it('rejects missing, duplicated, or out-of-order marker pairs', () => {
    expect(() => replaceGeneratedSection('no markers', 'new')).toThrow();
    expect(() =>
      replaceGeneratedSection(
        '<!-- capabilities:end -->\n<!-- capabilities:start -->',
        'new',
      ),
    ).toThrow();
    expect(() =>
      replaceGeneratedSection(
        '<!-- capabilities:start -->\na\n<!-- capabilities:start -->\nb\n<!-- capabilities:end -->',
        'new',
      ),
    ).toThrow();
  });
});
