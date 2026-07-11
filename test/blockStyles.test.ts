// Style-map totality: every enum value must map to a non-empty, token-only
// class string (the class literals living HERE is what makes Tailwind 4's
// static analysis keep them — the "safelist" is this module's source).
import { describe, expect, it } from 'vitest';
import {
  sectionOuterClass, sectionInnerClass, columnsClass, headingRender,
  textClass, imageRender, buttonRender, spacerClass, dividerClass,
} from '../src/lib/blockStyles';

const BASE_HEADING = { level: 2 as const, text: { en: '', zh: '' }, align: 'left' as const, size: 'md' as const };

describe('blockStyles totality', () => {
  it('every section bg/width/padY combination yields classes', () => {
    for (const bg of ['none', 'soft', 'primary', 'accent'] as const)
      for (const width of ['narrow', 'content', 'wide'] as const)
        for (const padY of ['sm', 'md', 'lg'] as const) {
          const outer = sectionOuterClass({ bg, width, padY });
          const inner = sectionInnerClass({ bg, width, padY });
          expect(inner).toContain(`container-${width}`);
          expect(inner).toMatch(/py-/);
          if (bg !== 'none') expect(outer.length).toBeGreaterThan(0);
        }
  });

  it('columns map count and gap', () => {
    for (const count of [2, 3, 4] as const)
      for (const gap of ['sm', 'md', 'lg'] as const) {
        const cls = columnsClass({ count, gap });
        expect(cls).toContain('grid');
        expect(cls).toMatch(/gap-/);
      }
  });

  it('heading sizes map; customSizePx becomes an inline style override', () => {
    for (const size of ['sm', 'md', 'lg', 'xl'] as const)
      expect(headingRender({ ...BASE_HEADING, size }).className).toMatch(/text-/);
    const custom = headingRender({ ...BASE_HEADING, customSizePx: 43 });
    expect(custom.style).toEqual({ fontSize: '43px' });
  });

  it('image, button, spacer, divider, text all render classes', () => {
    for (const width of ['full', 'wide', 'medium', 'small'] as const) {
      const r = imageRender({ src: '', alt: { en: '', zh: '' }, width, rounded: true, align: 'center' });
      expect(r.imgClass.length).toBeGreaterThan(0);
      expect(r.wrapperClass).toContain('flex');
    }
    for (const variant of ['primary', 'secondary'] as const)
      expect(buttonRender({ label: { en: '', zh: '' }, href: '/', variant, align: 'left' }).linkClass).toMatch(/rounded-full/);
    for (const size of ['sm', 'md', 'lg', 'xl'] as const) expect(spacerClass({ size })).toMatch(/h-/);
    expect(dividerClass()).toContain('border-t');
    expect(textClass({ md: { en: '', zh: '' }, align: 'right' })).toContain('prose');
  });

  it('no literal colors anywhere in the emitted classes', () => {
    const all = [
      sectionOuterClass({ bg: 'accent', width: 'wide', padY: 'lg' }),
      buttonRender({ label: { en: '', zh: '' }, href: '/', variant: 'primary', align: 'left' }).linkClass,
    ].join(' ');
    expect(all).not.toMatch(/#[0-9a-fA-F]{3}|rgb|hsl/);
  });
});
