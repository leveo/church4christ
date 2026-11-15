import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../../src/lib/locales';

// Native names shown in the README language bar, in registry order.
const BAR_NAMES: Record<(typeof SUPPORTED_LOCALES)[number], string> = {
  en: 'English', zh: '简体中文', es: 'Español', pt: 'Português (Brasil)', fr: 'Français', de: 'Deutsch',
  ja: '日本語', ko: '한국어', ms: 'Bahasa Melayu', id: 'Bahasa Indonesia', vi: 'Tiếng Việt', hi: 'हिन्दी',
};
const root = fileURLToPath(new URL('../../', import.meta.url));
const fileFor = (code: string) => (code === 'en' ? 'README.md' : `README.${code}.md`);
const bar = (current: string) =>
  '<p align="center">' +
  SUPPORTED_LOCALES.map((code) => (code === current ? `<b>${BAR_NAMES[code]}</b>` : `<a href="${fileFor(code)}">${BAR_NAMES[code]}</a>`)).join(' · ') +
  '</p>';

const withoutCode = (md: string) => md.replace(/```[\s\S]*?```/g, '');
const targets = (md: string) => {
  const body = withoutCode(md);
  return [
    ...[...body.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]),
    ...[...body.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
  ];
};
// GitHub heading anchors: lowercase, punctuation removed (letters, marks, digits kept), spaces to hyphens.
const headingSlugs = (md: string) => {
  const seen = new Map<string, number>();
  const slugs = new Set<string>();
  for (const [, text] of withoutCode(md).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = text.trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n ? `${base}-${n}` : base);
  }
  return slugs;
};

describe('README translations', () => {
  it.each([...SUPPORTED_LOCALES])('%s has a README with the twelve-language bar and working links', (code) => {
    const file = fileFor(code);
    expect(existsSync(root + file), `${file} is missing`).toBe(true);
    const md = readFileSync(root + file, 'utf8');
    expect(md).toContain(bar(code));
    const slugs = headingSlugs(md);
    for (const target of targets(md)) {
      if (/^(?:https?:|mailto:)/.test(target)) continue;
      if (target.startsWith('#')) {
        expect(slugs.has(decodeURIComponent(target.slice(1))), `${file}: anchor ${target}`).toBe(true);
        continue;
      }
      const path = decodeURIComponent(target.split('#')[0]);
      expect(existsSync(root + path), `${file}: ${target}`).toBe(true);
    }
  });

  it('keeps the generated capability markers only in the English README', () => {
    for (const code of SUPPORTED_LOCALES.filter((c) => c !== 'en')) {
      expect(readFileSync(root + fileFor(code), 'utf8')).not.toMatch(/capabilities:(?:start|end)/);
    }
  });
});
