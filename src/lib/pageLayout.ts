// Page-builder layout tree: types + the validation gate between untrusted
// island JSON and the server renderer (spec: docs/superpowers/specs/
// 2026-07-10-page-builder-design.md). Pure and dependency-free so the same
// module runs in workerd (save/render) and the browser island (canvas).
// Containment: sections at top level only; columns only inside sections;
// leaves inside sections or columns. Text is localized per-field ({en,zh}),
// structure is shared across locales by design.

export interface L10nString { en: string; zh: string }
export type Align = 'left' | 'center' | 'right';
export type LeafType = 'heading' | 'text' | 'image' | 'button' | 'spacer' | 'divider';

export interface HeadingNode { id: string; type: 'heading'; props: { level: 1 | 2 | 3; text: L10nString; align: Align; size: 'sm' | 'md' | 'lg' | 'xl'; customSizePx?: number } }
export interface TextNode { id: string; type: 'text'; props: { md: L10nString; align: Align } }
export interface ImageNode { id: string; type: 'image'; props: { src: string; alt: L10nString; width: 'full' | 'wide' | 'medium' | 'small'; rounded: boolean; align: Align } }
export interface ButtonNode { id: string; type: 'button'; props: { label: L10nString; href: string; variant: 'primary' | 'secondary'; align: Align } }
export interface SpacerNode { id: string; type: 'spacer'; props: { size: 'sm' | 'md' | 'lg' | 'xl' } }
export interface DividerNode { id: string; type: 'divider'; props: Record<string, never> }
export type LeafNode = HeadingNode | TextNode | ImageNode | ButtonNode | SpacerNode | DividerNode;

export interface ColumnsNode { id: string; type: 'columns'; props: { count: 2 | 3 | 4; gap: 'sm' | 'md' | 'lg' }; columns: LeafNode[][] }
export interface SectionNode { id: string; type: 'section'; props: { bg: 'none' | 'soft' | 'primary' | 'accent'; width: 'narrow' | 'content' | 'wide'; padY: 'sm' | 'md' | 'lg' }; children: (ColumnsNode | LeafNode)[] }
export type AnyNode = SectionNode | ColumnsNode | LeafNode;

export interface PageLayout { v: 1; blocks: SectionNode[] }

export const LAYOUT_LIMITS = { maxNodes: 300, maxJsonBytes: 200_000, maxTextLen: 20_000, maxShortLen: 500 } as const;

/** Same scheme gate markdown.ts applies to links. */
export const SAFE_HREF = /^(https?:\/\/|\/|#|mailto:)/i;
/** Uploaded media path or an absolute https URL (no http/data/js schemes). */
export const SAFE_IMG_SRC = /^(\/media\/uploads\/[a-z0-9][a-z0-9.-]*|https:\/\/.+)$/;

const ID_RE = /^[A-Za-z0-9_-]{1,36}$/;

export function emptyLayout(): PageLayout {
  return { v: 1, blocks: [] };
}

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

// --- tiny structural checkers (no schema lib: 8 node shapes don't earn one) ---
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isL10n = (x: unknown, max: number): x is L10nString =>
  isObj(x) && typeof x.en === 'string' && typeof x.zh === 'string' && x.en.length <= max && x.zh.length <= max;
const oneOf = <T,>(x: unknown, values: readonly T[]): x is T => values.includes(x as T);

const ALIGNS = ['left', 'center', 'right'] as const;

/** Copy only {en, zh} so unknown keys inside an l10n object are dropped too. */
const l10nCopy = (x: L10nString): L10nString => ({ en: x.en, zh: x.zh });

// Validate AND rebuild a leaf from only its known fields (strict allowlist):
// unknown node types or bad props return null; unknown/extra keys never make
// it into the returned node, so the caller persists exactly the schema.
function buildLeaf(id: string, node: Record<string, unknown>): LeafNode | null {
  const p = node.props;
  if (!isObj(p)) return null;
  switch (node.type) {
    case 'heading': {
      const { level, text, align, size, customSizePx } = p;
      if (!oneOf(level, [1, 2, 3] as const) || !isL10n(text, LAYOUT_LIMITS.maxShortLen) ||
          !oneOf(align, ALIGNS) || !oneOf(size, ['sm', 'md', 'lg', 'xl'] as const)) return null;
      if (customSizePx !== undefined && !(typeof customSizePx === 'number' && customSizePx >= 10 && customSizePx <= 120)) return null;
      const props: HeadingNode['props'] = { level, text: l10nCopy(text), align, size };
      if (customSizePx !== undefined) props.customSizePx = customSizePx;
      return { id, type: 'heading', props };
    }
    case 'text': {
      const { md, align } = p;
      if (!isL10n(md, LAYOUT_LIMITS.maxTextLen) || !oneOf(align, ALIGNS)) return null;
      return { id, type: 'text', props: { md: l10nCopy(md), align } };
    }
    case 'image': {
      const { src, alt, width, rounded, align } = p;
      // '' allowed: a freshly dropped image block has no src yet (the public
      // renderer skips the <img> until one is chosen).
      if (typeof src !== 'string' || !(src === '' || SAFE_IMG_SRC.test(src)) || src.length > LAYOUT_LIMITS.maxShortLen ||
          !isL10n(alt, LAYOUT_LIMITS.maxShortLen) ||
          !oneOf(width, ['full', 'wide', 'medium', 'small'] as const) ||
          typeof rounded !== 'boolean' || !oneOf(align, ALIGNS)) return null;
      return { id, type: 'image', props: { src, alt: l10nCopy(alt), width, rounded, align } };
    }
    case 'button': {
      const { label, href, variant, align } = p;
      if (!isL10n(label, LAYOUT_LIMITS.maxShortLen) ||
          typeof href !== 'string' || !SAFE_HREF.test(href) || href.length > LAYOUT_LIMITS.maxShortLen ||
          !oneOf(variant, ['primary', 'secondary'] as const) || !oneOf(align, ALIGNS)) return null;
      return { id, type: 'button', props: { label: l10nCopy(label), href, variant, align } };
    }
    case 'spacer': {
      const { size } = p;
      if (!oneOf(size, ['sm', 'md', 'lg', 'xl'] as const)) return null;
      return { id, type: 'spacer', props: { size } };
    }
    case 'divider':
      return { id, type: 'divider', props: {} };
    default:
      return null;
  }
}

/**
 * Parse + validate an untrusted layout JSON string. On success the returned
 * layout is REBUILT from only the known fields (never the parsed object), so
 * unknown/extra properties are stripped and callers render/persist exactly
 * the schema. Error codes (not prose): bad_json, too_large, bad_root,
 * too_many_nodes, bad_node.
 */
export function validateLayout(raw: string): { ok: true; layout: PageLayout } | Fail {
  // Byte-accurate cap: CJK text is 1 UTF-16 code unit but ~3 UTF-8 bytes, so
  // raw.length would under-count Chinese-heavy layouts by ~3x.
  if (new TextEncoder().encode(raw).length > LAYOUT_LIMITS.maxJsonBytes) return fail('too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('bad_json');
  }
  if (!isObj(parsed) || parsed.v !== 1 || !Array.isArray(parsed.blocks)) return fail('bad_root');

  const seen = new Set<string>();
  let count = 0;
  const claimId = (node: Record<string, unknown>): string | null => {
    count += 1;
    const id = node.id;
    if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) return null;
    seen.add(id);
    return id;
  };

  const blocks: SectionNode[] = [];
  for (const sec of parsed.blocks) {
    if (!isObj(sec) || sec.type !== 'section') return fail('bad_node');
    const secId = claimId(sec);
    const sp = sec.props;
    if (!secId || !isObj(sp)) return fail('bad_node');
    const { bg, width, padY } = sp;
    if (!oneOf(bg, ['none', 'soft', 'primary', 'accent'] as const) ||
        !oneOf(width, ['narrow', 'content', 'wide'] as const) ||
        !oneOf(padY, ['sm', 'md', 'lg'] as const) || !Array.isArray(sec.children)) return fail('bad_node');
    const children: (ColumnsNode | LeafNode)[] = [];
    for (const child of sec.children) {
      if (!isObj(child)) return fail('bad_node');
      const childId = claimId(child);
      if (!childId) return fail('bad_node');
      if (child.type === 'columns') {
        const cp = child.props;
        if (!isObj(cp)) return fail('bad_node');
        const { count: colCount, gap } = cp;
        if (!oneOf(colCount, [2, 3, 4] as const) || !oneOf(gap, ['sm', 'md', 'lg'] as const) ||
            !Array.isArray(child.columns) || child.columns.length !== colCount) return fail('bad_node');
        const columns: LeafNode[][] = [];
        for (const col of child.columns) {
          if (!Array.isArray(col)) return fail('bad_node');
          const leaves: LeafNode[] = [];
          for (const leaf of col) {
            if (!isObj(leaf)) return fail('bad_node');
            const leafId = claimId(leaf);
            const built = leafId ? buildLeaf(leafId, leaf) : null;
            if (!built) return fail('bad_node');
            leaves.push(built);
          }
          columns.push(leaves);
        }
        children.push({ id: childId, type: 'columns', props: { count: colCount, gap }, columns });
      } else {
        const built = buildLeaf(childId, child);
        if (!built) return fail('bad_node');
        children.push(built);
      }
    }
    blocks.push({ id: secId, type: 'section', props: { bg, width, padY }, children });
  }
  if (count > LAYOUT_LIMITS.maxNodes) return fail('too_many_nodes');
  return { ok: true, layout: { v: 1, blocks } };
}
