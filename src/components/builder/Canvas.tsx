// Canvas: renders the layout tree through the SAME blockStyles maps the
// public renderer uses (visual parity), wrapped in selection/drag chrome.
// Drop model: explicit gap droppables between blocks (Wix-style insertion
// lines) rather than sortable lists — one mechanism covers palette drops,
// reorders, and cross-container moves.
import { useDraggable, useDroppable } from '@dnd-kit/core';
import type { AnyNode, ColumnsNode, LeafNode, PageLayout, SectionNode, L10nString } from '../../lib/pageLayout';
import {
  sectionOuterClass, sectionInnerClass, columnsClass, headingRender,
  textClass, imageRender, buttonRender, spacerClass, dividerClass,
} from '../../lib/blockStyles';
import { renderMarkdown } from '../../lib/markdown';
import { canDrop, type ContainerRef } from './model';

export interface CanvasProps {
  layout: PageLayout;
  selectedId: string | null;
  editLocale: 'en' | 'zh';
  draggingType: AnyNode['type'] | null;
  strings: Record<string, string>;
  onSelect: (id: string | null) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
}

function pickL10n(s: L10nString, locale: 'en' | 'zh'): string {
  return locale === 'zh' ? s.zh || s.en : s.en || s.zh;
}

function DropGap({ container, index, draggingType }: { container: ContainerRef; index: number; draggingType: AnyNode['type'] | null }) {
  const { isOver, setNodeRef } = useDroppable({ id: `gap|${container}|${index}`, data: { container, index } });
  const valid = draggingType !== null && canDrop(draggingType, container);
  if (draggingType !== null && !valid) return <div className="h-1" />;
  return (
    <div
      ref={setNodeRef}
      className={`rounded transition-all ${draggingType ? 'h-3' : 'h-1'} ${isOver && valid ? 'bg-primary h-6' : draggingType ? 'bg-surface-sunken' : ''}`}
    />
  );
}

function LeafView({ node, editLocale }: { node: LeafNode; editLocale: 'en' | 'zh' }) {
  switch (node.type) {
    case 'heading': {
      const r = headingRender(node.props);
      const Tag = `h${node.props.level}` as 'h1' | 'h2' | 'h3';
      return <Tag className={r.className} style={r.style}>{pickL10n(node.props.text, editLocale)}</Tag>;
    }
    case 'text':
      return (
        <div
          className={textClass(node.props)}
          // Safe: renderMarkdown fully escapes its input before transforming.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(pickL10n(node.props.md, editLocale)) }}
        />
      );
    case 'image': {
      const r = imageRender(node.props);
      return (
        <div className={r.wrapperClass}>
          {node.props.src ? (
            <img src={node.props.src} alt={pickL10n(node.props.alt, editLocale)} className={r.imgClass} />
          ) : (
            <div className={`${r.imgClass} flex h-40 items-center justify-center border border-dashed border-border-strong bg-surface-sunken text-sm text-ink-subtle`}>
              🖼
            </div>
          )}
        </div>
      );
    }
    case 'button': {
      const r = buttonRender(node.props);
      return (
        <div className={r.wrapperClass}>
          <span className={r.linkClass}>{pickL10n(node.props.label, editLocale)}</span>
        </div>
      );
    }
    case 'spacer':
      return <div className={`${spacerClass(node.props)} rounded bg-surface-sunken/50`} aria-hidden="true" />;
    case 'divider':
      return <hr className={dividerClass()} />;
  }
}

function BlockFrame({
  node, selected, strings, onSelect, onRemove, onDuplicate, children,
}: {
  node: AnyNode; selected: boolean; strings: Record<string, string>;
  onSelect: (id: string) => void; onRemove: (id: string) => void; onDuplicate: (id: string) => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `blk|${node.id}`,
    data: { from: 'canvas', id: node.id, nodeType: node.type },
  });
  return (
    <div
      ref={setNodeRef}
      onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
      className={`relative rounded ${isDragging ? 'opacity-40' : ''} ${selected ? 'ring-2 ring-ring' : 'hover:ring-1 hover:ring-border-strong'}`}
    >
      {selected && (
        <div className="absolute -top-3 right-2 z-10 flex gap-1 rounded-md border border-border bg-surface-raised px-1 py-0.5 text-xs shadow-sm">
          <button type="button" className="cursor-grab px-1" title={strings['block.' + node.type]} {...listeners} {...attributes}>⠿</button>
          <button type="button" className="px-1" title={strings.duplicate} onClick={(e) => { e.stopPropagation(); onDuplicate(node.id); }}>⧉</button>
          <button type="button" className="px-1 text-danger" title={strings.delete} onClick={(e) => { e.stopPropagation(); onRemove(node.id); }}>✕</button>
        </div>
      )}
      {children}
    </div>
  );
}

export default function Canvas(props: CanvasProps) {
  const { layout, selectedId, editLocale, draggingType, strings } = props;
  const frame = (node: AnyNode, children: React.ReactNode) => (
    <BlockFrame
      key={node.id}
      node={node}
      selected={selectedId === node.id}
      strings={strings}
      onSelect={props.onSelect}
      onRemove={props.onRemove}
      onDuplicate={props.onDuplicate}
    >
      {children}
    </BlockFrame>
  );

  const renderLeaves = (leaves: LeafNode[], container: ContainerRef) => (
    <>
      <DropGap container={container} index={0} draggingType={draggingType} />
      {leaves.map((leaf, i) => (
        <div key={leaf.id}>
          {frame(leaf, <LeafView node={leaf} editLocale={editLocale} />)}
          <DropGap container={container} index={i + 1} draggingType={draggingType} />
        </div>
      ))}
      {leaves.length === 0 && draggingType === null && (
        <p className="py-3 text-center text-xs text-ink-subtle">{strings.emptySection}</p>
      )}
    </>
  );

  return (
    <div className="min-h-[60vh] rounded-xl border border-border bg-surface p-2" onClick={() => props.onSelect(null)}>
      <DropGap container="root" index={0} draggingType={draggingType} />
      {layout.blocks.map((section: SectionNode, i) => (
        <div key={section.id}>
          {frame(
            section,
            <section className={`${sectionOuterClass(section.props)} rounded border border-dashed border-border`}>
              <div className={`${sectionInnerClass(section.props)} space-y-2`}>
                {section.children.length === 0 && <p className="py-6 text-center text-xs text-ink-subtle">{strings.emptySection}</p>}
                <DropGap container={`sec:${section.id}`} index={0} draggingType={draggingType} />
                {section.children.map((child, j) => (
                  <div key={child.id}>
                    {child.type === 'columns'
                      ? frame(
                          child,
                          <div className={columnsClass((child as ColumnsNode).props)}>
                            {(child as ColumnsNode).columns.map((col, c) => (
                              <div key={c} className="min-h-16 space-y-2 rounded border border-dashed border-border p-1">
                                {renderLeaves(col, `col:${child.id}:${c}`)}
                              </div>
                            ))}
                          </div>,
                        )
                      : frame(child, <LeafView node={child as LeafNode} editLocale={editLocale} />)}
                    <DropGap container={`sec:${section.id}`} index={j + 1} draggingType={draggingType} />
                  </div>
                ))}
              </div>
            </section>,
          )}
          <DropGap container="root" index={i + 1} draggingType={draggingType} />
        </div>
      ))}
      {layout.blocks.length === 0 && (
        <p className="py-16 text-center text-sm text-ink-muted">{strings.emptyCanvas}</p>
      )}
    </div>
  );
}
