// Block palette: drag onto the canvas, or click to append somewhere sensible
// (root for sections, the selected/last section otherwise — PageBuilder owns
// that logic via onQuickAdd).
import { useDraggable } from '@dnd-kit/core';
import type { AnyNode } from '../../lib/pageLayout';

const TYPES: AnyNode['type'][] = ['section', 'columns', 'heading', 'text', 'image', 'button', 'spacer', 'divider'];
const ICONS: Record<AnyNode['type'], string> = {
  section: '▭', columns: '◫', heading: 'H', text: '¶', image: '🖼', button: '⏺', spacer: '↕', divider: '—',
};

function PaletteItem({ type, label, onQuickAdd }: { type: AnyNode['type']; label: string; onQuickAdd: (t: AnyNode['type']) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pal|${type}`,
    data: { from: 'palette', nodeType: type },
  });
  return (
    <button
      type="button"
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onQuickAdd(type)}
      className={`flex w-full cursor-grab items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-left text-sm hover:border-border-strong ${isDragging ? 'opacity-40' : ''}`}
    >
      <span aria-hidden="true" className="w-5 text-center text-ink-muted">{ICONS[type]}</span>
      {label}
    </button>
  );
}

export default function Palette({ strings, onQuickAdd }: { strings: Record<string, string>; onQuickAdd: (t: AnyNode['type']) => void }) {
  return (
    <div className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">{strings.blocks}</h2>
      {TYPES.map((type) => (
        <PaletteItem key={type} type={type} label={strings[`block.${type}`]} onQuickAdd={onQuickAdd} />
      ))}
      <p className="text-xs text-ink-subtle">{strings.dragHint}</p>
    </div>
  );
}
