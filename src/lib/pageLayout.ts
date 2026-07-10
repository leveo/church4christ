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

function checkLeaf(node: Record<string, unknown>): boolean {
  const p = node.props;
  if (!isObj(p)) return false;
  switch (node.type) {
    case 'heading':
      return oneOf(p.level, [1, 2, 3] as const) && isL10n(p.text, LAYOUT_LIMITS.maxShortLen) &&
        oneOf(p.align, ALIGNS) && oneOf(p.size, ['sm', 'md', 'lg', 'xl'] as const) &&
        (p.customSizePx === undefined || (typeof p.customSizePx === 'number' && p.customSizePx >= 10 && p.customSizePx <= 120));
    case 'text':
      return isL10n(p.md, LAYOUT_LIMITS.maxTextLen) && oneOf(p.align, ALIGNS);
    case 'image':
      // '' allowed: a freshly dropped image block has no src yet (the public
      // renderer skips the <img> until one is chosen).
      return typeof p.src === 'string' && (p.src === '' || SAFE_IMG_SRC.test(p.src)) && p.src.length <= LAYOUT_LIMITS.maxShortLen &&
        isL10n(p.alt, LAYOUT_LIMITS.maxShortLen) &&
        oneOf(p.width, ['full', 'wide', 'medium', 'small'] as const) &&
        typeof p.rounded === 'boolean' && oneOf(p.align, ALIGNS);
    case 'button':
      return isL10n(p.label, LAYOUT_LIMITS.maxShortLen) &&
        typeof p.href === 'string' && SAFE_HREF.test(p.href) && p.href.length <= LAYOUT_LIMITS.maxShortLen &&
        oneOf(p.variant, ['primary', 'secondary'] as const) && oneOf(p.align, ALIGNS);
    case 'spacer':
      return oneOf(p.size, ['sm', 'md', 'lg', 'xl'] as const);
    case 'divider':
      return true;
    default:
      return false;
  }
}

/**
 * Parse + validate an untrusted layout JSON string. Returns the parsed tree on
 * success so callers render/persist exactly what was validated. Error codes
 * (not prose): bad_json, too_large, bad_root, too_many_nodes, bad_node.
 */
export function validateLayout(raw: string): { ok: true; layout: PageLayout } | Fail {
  if (raw.length > LAYOUT_LIMITS.maxJsonBytes) return fail('too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('bad_json');
  }
  if (!isObj(parsed) || parsed.v !== 1 || !Array.isArray(parsed.blocks)) return fail('bad_root');

  const seen = new Set<string>();
  let count = 0;
  const claimId = (node: Record<string, unknown>): boolean => {
    count += 1;
    if (typeof node.id !== 'string' || !ID_RE.test(node.id) || seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  };

  for (const sec of parsed.blocks) {
    if (!isObj(sec) || sec.type !== 'section' || !claimId(sec)) return fail('bad_node');
    const sp = sec.props;
    if (!isObj(sp) || !oneOf(sp.bg, ['none', 'soft', 'primary', 'accent'] as const) ||
        !oneOf(sp.width, ['narrow', 'content', 'wide'] as const) ||
        !oneOf(sp.padY, ['sm', 'md', 'lg'] as const) || !Array.isArray(sec.children)) return fail('bad_node');
    for (const child of sec.children) {
      if (!isObj(child) || !claimId(child)) return fail('bad_node');
      if (child.type === 'columns') {
        const cp = child.props;
        if (!isObj(cp) || !oneOf(cp.count, [2, 3, 4] as const) || !oneOf(cp.gap, ['sm', 'md', 'lg'] as const) ||
            !Array.isArray(child.columns) || child.columns.length !== cp.count) return fail('bad_node');
        for (const col of child.columns) {
          if (!Array.isArray(col)) return fail('bad_node');
          for (const leaf of col) {
            if (!isObj(leaf) || !claimId(leaf) || !checkLeaf(leaf)) return fail('bad_node');
          }
        }
      } else if (!checkLeaf(child)) {
        return fail('bad_node');
      }
    }
  }
  if (count > LAYOUT_LIMITS.maxNodes) return fail('too_many_nodes');
  return { ok: true, layout: parsed as unknown as PageLayout };
}
