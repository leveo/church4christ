import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import raw from '../../../config/capabilities.json';
import {
  GENERATED_DOCS,
  generateCapabilityDocs,
  renderCapabilityTable,
  replaceGeneratedSection,
} from '../../../scripts/docs/generate-capabilities.mjs';
import { writeAtomic } from '../../../scripts/setup/files.mjs';

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
    expect(raw.order).toHaveLength(16);
    expect(Object.keys(raw.capabilities)).toHaveLength(16);
    expect(new Set(raw.order)).toEqual(new Set(Object.keys(raw.capabilities)));
    expect(
      raw.order.filter(
        (key) =>
          (raw.capabilities as Record<string, { requiresBackend?: string }>)[key]
            .requiresBackend === 'supabase',
      ),
    ).toEqual(['portal', 'giving', 'registration']);

    const table = renderCapabilityTable(raw);
    expect(raw.order.every((key) => table.includes(`\`${key}\``))).toBe(true);
    expect((table.match(/Supabase/g) ?? [])).toHaveLength(3);
  });

  it('validates the canonical catalog before rendering', () => {
    const extraCapability = structuredClone(raw) as any;
    extraCapability.capabilities.extra = structuredClone(extraCapability.capabilities.events);
    extraCapability.capabilities.extra.order = 17;
    expect(() => renderCapabilityTable(extraCapability)).toThrow(/order must contain every/i);

    const extraOrder = structuredClone(raw) as any;
    extraOrder.order.push('missing');
    expect(() => renderCapabilityTable(extraOrder)).toThrow(/order must contain every/i);

    const malformed = structuredClone(raw) as any;
    malformed.capabilities.events.labels = null;
    expect(() => renderCapabilityTable(malformed)).toThrow(/labels\.en/i);
  });

  it('escapes catalog labels without corrupting table rows or cells', () => {
    const mutated = structuredClone(raw) as any;
    mutated.capabilities.events.labels.en = 'Events | Groups\\Teams\r\nCalendar';
    const table = renderCapabilityTable(mutated);
    const row = table.split('\n').find((line) => line.includes('`events`'));
    expect(row).toContain('Events \\| Groups\\\\Teams<br>Calendar');
    expect(row?.split(/(?<!\\)\|/)).toHaveLength(6);
    expect(table.split('\n').filter((line) => line.includes('`events`'))).toHaveLength(1);
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

  it('keeps guided sign-in and demo prose tied to setup answers', () => {
    const readme = readFileSync('README.md', 'utf8');
    const guidedSignIn = readme.slice(
      readme.indexOf('**Signing in to the admin area.**'),
      readme.indexOf('Setup offers **Website**'),
    );
    expect(guidedSignIn).toMatch(/first-admin email[^.]*setup (?:handoff|answers)/i);
    expect(guidedSignIn).not.toContain('admin@example.com');
    expect(readme).toMatch(/if you (?:choose|chose|selected?) (?:to load )?demo data/i);
    expect(readme).not.toMatch(/updates? the local D1 rows that point at those objects/i);

    const contributing = readFileSync('CONTRIBUTING.md', 'utf8');
    expect(contributing).toMatch(/first-admin email[^.]*setup (?:handoff|answers)/i);
    expect(contributing).not.toContain('sign in as `admin@example.com`');
  });

  it('keeps capability defaults, account requirements, and secrets mode-specific', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).not.toMatch(/Everything starts on/i);
    expect(readme).toMatch(/local D1[^.]*no external account/i);
    expect(readme).toMatch(/deployed? D1[^.]*Cloudflare account/i);
    expect(readme).toMatch(
      /local\s+Supabase needs a Supabase account or compatible local Postgres/i,
    );
    expect(readme).toMatch(/deployed? Supabase[^.]*Cloudflare and Supabase/i);

    const supabase = readFileSync('docs/supabase-setup.md', 'utf8');
    expect(supabase).toMatch(/setup is capability-driven/i);
    expect(supabase).not.toMatch(/default setup uses Cloudflare \*\*D1\*\*/i);

    const cloudflare = readFileSync('docs/cloudflare-setup.md', 'utf8');
    expect(cloudflare).toMatch(/Supabase database URL[^.]*Stripe[^.]*backup[^.]*secrets/i);
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

  it('uses atomic expected-content writes and preserves a target on replacement failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'church-docs-'));
    try {
      mkdirSync(join(root, 'config'), { recursive: true });
      cpSync('config/capabilities.json', join(root, 'config/capabilities.json'));
      for (const path of GENERATED_DOCS) {
        mkdirSync(join(root, path, '..'), { recursive: true });
        cpSync(path, join(root, path));
      }
      const readmePath = join(root, 'README.md');
      const original = replaceGeneratedSection(readFileSync(readmePath, 'utf8'), 'stale');
      writeFileSync(readmePath, original);
      const optionsSeen: unknown[] = [];

      await expect(
        generateCapabilityDocs(root, {
          writer: async (path, contents, options) => {
            optionsSeen.push(options);
            return writeAtomic(path, contents, {
              ...options,
              beforeReplace: () => {
                throw new Error('injected replacement failure');
              },
            });
          },
          output: () => {},
        }),
      ).rejects.toThrow(/injected replacement failure/);

      expect(optionsSeen).toEqual([
        expect.objectContaining({ allowReplace: true, backup: false, expectedContent: original }),
      ]);
      expect(readFileSync(readmePath, 'utf8')).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
