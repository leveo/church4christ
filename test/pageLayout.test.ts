// Layout-tree validation matrix (pure module, workers project). validateLayout
// is the ONLY gate between untrusted island JSON and the server renderer, so
// every containment/enum/cap rule gets a case.
import { describe, expect, it } from 'vitest';
import { validateLayout, emptyLayout, LAYOUT_LIMITS } from '../src/lib/pageLayout';

const l10n = (en: string, zh = '') => ({ en, zh });
const heading = (id = 'h1') => ({ id, type: 'heading', props: { level: 2, text: l10n('Hi'), align: 'left', size: 'md' } });
const section = (id: string, children: unknown[]) => ({ id, type: 'section', props: { bg: 'none', width: 'content', padY: 'md' }, children });
const wrap = (blocks: unknown[]) => JSON.stringify({ v: 1, blocks });

describe('validateLayout', () => {
  it('accepts an empty layout and a full kitchen-sink page', () => {
    expect(validateLayout(JSON.stringify(emptyLayout())).ok).toBe(true);
    const full = wrap([
      section('s1', [
        heading('h1'),
        { id: 't1', type: 'text', props: { md: l10n('Hello **world**'), align: 'left' } },
        { id: 'c1', type: 'columns', props: { count: 2, gap: 'md' }, columns: [
          [{ id: 'i1', type: 'image', props: { src: '/media/uploads/abc-x.png', alt: l10n('pic'), width: 'medium', rounded: true, align: 'center' } }],
          [{ id: 'b1', type: 'button', props: { label: l10n('Go'), href: '/en/visit', variant: 'primary', align: 'center' } },
           { id: 'sp1', type: 'spacer', props: { size: 'md' } },
           { id: 'd1', type: 'divider', props: {} }],
        ] },
      ]),
    ]);
    const res = validateLayout(full);
    expect(res).toMatchObject({ ok: true });
  });

  it('rejects non-JSON, oversized JSON, wrong version, and non-array blocks', () => {
    expect(validateLayout('nope').ok).toBe(false);
    expect(validateLayout(JSON.stringify({ v: 2, blocks: [] })).ok).toBe(false);
    expect(validateLayout(JSON.stringify({ v: 1, blocks: {} })).ok).toBe(false);
    const big = wrap([section('s1', [{ ...heading('h1'), props: { ...heading('h1').props, text: l10n('x'.repeat(LAYOUT_LIMITS.maxJsonBytes)) } }])]);
    expect(validateLayout(big)).toEqual({ ok: false, error: 'too_large' });
  });

  it('enforces containment: leaves at top level, columns-in-columns, sections in sections all rejected', () => {
    expect(validateLayout(wrap([heading('h1')])).ok).toBe(false);
    expect(validateLayout(wrap([section('s1', [section('s2', [])])])).ok).toBe(false);
    const nested = { id: 'c1', type: 'columns', props: { count: 2, gap: 'md' }, columns: [[{ id: 'c2', type: 'columns', props: { count: 2, gap: 'md' }, columns: [[], []] }], []] };
    expect(validateLayout(wrap([section('s1', [nested])])).ok).toBe(false);
  });

  it('rejects unknown types, bad enums, bad/duplicate ids, and count/columns mismatch', () => {
    expect(validateLayout(wrap([section('s1', [{ id: 'x1', type: 'video', props: {} }])])).ok).toBe(false);
    expect(validateLayout(wrap([section('s1', [{ ...heading('h1'), props: { ...heading().props, align: 'justify' } }])])).ok).toBe(false);
    expect(validateLayout(wrap([section('bad id!', [])])).ok).toBe(false);
    expect(validateLayout(wrap([section('s1', [heading('h1'), heading('h1')])])).ok).toBe(false);
    const mismatch = { id: 'c1', type: 'columns', props: { count: 3, gap: 'md' }, columns: [[], []] };
    expect(validateLayout(wrap([section('s1', [mismatch])])).ok).toBe(false);
  });

  it('gates href and image src schemes', () => {
    const evil = { id: 'b1', type: 'button', props: { label: l10n('x'), href: 'javascript:alert(1)', variant: 'primary', align: 'left' } };
    expect(validateLayout(wrap([section('s1', [evil])])).ok).toBe(false);
    const httpImg = { id: 'i1', type: 'image', props: { src: 'http://x/y.png', alt: l10n(''), width: 'full', rounded: false, align: 'left' } };
    expect(validateLayout(wrap([section('s1', [httpImg])])).ok).toBe(false); // https or /media/uploads/ only
    const emptyImg = { id: 'i2', type: 'image', props: { src: '', alt: l10n(''), width: 'full', rounded: false, align: 'left' } };
    expect(validateLayout(wrap([section('s1', [emptyImg])])).ok).toBe(true); // fresh block, no src chosen yet
  });

  it('strips unknown props during rebuild (strict allowlist)', () => {
    const sec = {
      id: 's1', type: 'section', props: { bg: 'none', width: 'content', padY: 'md', evil: 'x' },
      children: [{ ...heading('h1'), onClick: 'alert(1)' }],
    };
    const res = validateLayout(JSON.stringify({ v: 1, blocks: [sec] }));
    if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
    const json = JSON.stringify(res.layout);
    expect(json).not.toContain('evil');
    expect(json).not.toContain('onClick');
  });

  it('enforces the size cap in UTF-8 bytes, not UTF-16 code units', () => {
    // 8 text blocks x 15k CJK chars = ~120k UTF-16 units (under the 200k cap)
    // but ~360KB UTF-8 — the byte cap must still trip.
    const blocks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, type: 'text', props: { md: l10n('中'.repeat(15_000)), align: 'left' } }));
    const layout = wrap([section('s1', blocks)]);
    expect(layout.length).toBeLessThan(LAYOUT_LIMITS.maxJsonBytes); // sanity: a UTF-16 length check would pass this
    expect(validateLayout(layout)).toEqual({ ok: false, error: 'too_large' });
  });

  it('clamps customSizePx and enforces node count cap', () => {
    const sized = { ...heading('h1'), props: { ...heading().props, customSizePx: 9 } };
    expect(validateLayout(wrap([section('s1', [sized])])).ok).toBe(false); // below 10
    const many = section('s1', Array.from({ length: LAYOUT_LIMITS.maxNodes + 1 }, (_, i) => heading(`h${i}`)));
    expect(validateLayout(wrap([many]))).toEqual({ ok: false, error: 'too_many_nodes' });
  });
});
