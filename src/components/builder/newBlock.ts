// Factory for freshly dropped blocks. Defaults are chosen so a new block is
// immediately visible on the canvas AND already passes validateLayout —
// except image, which starts with src:'' (validation allows the empty src;
// the public renderer skips the <img> until one is chosen).
import type { AnyNode } from '../../lib/pageLayout';
import { uid } from './uid';

const l10n = (en = '') => ({ en, zh: '' });

export function newBlock(type: AnyNode['type']): AnyNode {
  const id = uid();
  switch (type) {
    case 'section':
      return { id, type, props: { bg: 'none', width: 'content', padY: 'md' }, children: [] };
    case 'columns':
      return { id, type, props: { count: 2, gap: 'md' }, columns: [[], []] };
    case 'heading':
      return { id, type, props: { level: 2, text: l10n('Heading'), align: 'left', size: 'md' } };
    case 'text':
      return { id, type, props: { md: l10n('Write something…'), align: 'left' } };
    case 'image':
      return { id, type, props: { src: '', alt: l10n(), width: 'medium', rounded: false, align: 'center' } };
    case 'button':
      return { id, type, props: { label: l10n('Learn more'), href: '/', variant: 'primary', align: 'left' } };
    case 'spacer':
      return { id, type, props: { size: 'md' } };
    case 'divider':
      return { id, type, props: {} };
  }
}
