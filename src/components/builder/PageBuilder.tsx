// Page-builder island root: owns the reducer state, the DndContext, page meta,
// and the save/upload calls to its own route (same-page JSON POST — the CSRF
// middleware validates Origin on every non-GET). Everything below the fold is
// split into Canvas / Palette / PropertiesPanel / TopBar.
import { useMemo, useReducer, useRef, useState, useEffect, useCallback } from 'react';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { AnyNode, PageLayout } from '../../lib/pageLayout';
import { builderReducer, canDrop, findNode, initialState, type ContainerRef } from './model';
import { newBlock } from './newBlock';
import Canvas from './Canvas';
import Palette from './Palette';
import PropertiesPanel from './PropertiesPanel';
import TopBar from './TopBar';

export interface PageBuilderProps {
  pageId: string | null;
  slug: string;
  published: boolean;
  titleEn: string;
  titleZh: string;
  layoutJson: string;
  media: { path: string; filename: string }[];
  strings: Record<string, string>;
  uiLang: 'en' | 'zh';
}

export default function PageBuilder(props: PageBuilderProps) {
  const [state, dispatch] = useReducer(builderReducer, JSON.parse(props.layoutJson) as PageLayout, initialState);
  const [meta, setMeta] = useState({ slug: props.slug, titleEn: props.titleEn, titleZh: props.titleZh, published: props.published });
  const [pageId, setPageId] = useState(props.pageId);
  const [editLocale, setEditLocale] = useState<'en' | 'zh'>(props.uiLang);
  const [draggingType, setDraggingType] = useState<AnyNode['type'] | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedSnapshot = useRef(JSON.stringify({ layout: JSON.parse(props.layoutJson), meta: { slug: props.slug, titleEn: props.titleEn, titleZh: props.titleZh, published: props.published } }));

  const snapshot = JSON.stringify({ layout: state.layout, meta });
  const dirty = snapshot !== savedSnapshot.current;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragStart = (e: DragStartEvent) => {
    setDraggingType((e.active.data.current?.nodeType as AnyNode['type']) ?? null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDraggingType(null);
    const over = e.over?.data.current as { container: ContainerRef; index: number } | undefined;
    const active = e.active.data.current as { from: 'palette' | 'canvas'; nodeType: AnyNode['type']; id?: string } | undefined;
    if (!over || !active) return;
    if (active.from === 'palette') {
      dispatch({ type: 'insert', container: over.container, index: over.index, node: newBlock(active.nodeType) });
    } else if (active.id) {
      dispatch({ type: 'move', container: over.container, index: over.index, id: active.id });
    }
  };

  // Click-to-add fallback: sections go to the end of the page; anything else
  // lands in the selected section/column, else the last section (created on
  // demand for an empty page).
  const quickAdd = useCallback((type: AnyNode['type']) => {
    if (type === 'section') {
      dispatch({ type: 'insert', container: 'root', index: state.layout.blocks.length, node: newBlock(type) });
      return;
    }
    let container: ContainerRef | null = null;
    if (state.selectedId) {
      const found = findNode(state.layout, state.selectedId);
      if (found) {
        if (found.node.type === 'section' && canDrop(type, `sec:${found.node.id}`)) container = `sec:${found.node.id}`;
        else if (canDrop(type, found.container)) container = found.container;
      }
    }
    if (!container) {
      const last = state.layout.blocks[state.layout.blocks.length - 1];
      if (last) container = `sec:${last.id}`;
      else {
        const section = newBlock('section');
        dispatch({ type: 'insert', container: 'root', index: 0, node: section });
        // The reducer call above hasn't landed yet in `state`; append into the
        // new section on the next tick via its id.
        setTimeout(() => dispatch({ type: 'insert', container: `sec:${section.id}`, index: 0, node: newBlock(type) }), 0);
        return;
      }
    }
    dispatch({ type: 'insert', container, index: Number.MAX_SAFE_INTEGER, node: newBlock(type) });
  }, [state]);

  const save = async (publish?: boolean) => {
    setSaving(true);
    setError(null);
    const published = publish ? true : meta.published;
    try {
      const res = await fetch(window.location.pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save', id: pageId, slug: meta.slug, published,
          title_en: meta.titleEn, title_zh: meta.titleZh, layout: state.layout,
        }),
      });
      const body = (await res.json()) as { ok: boolean; id?: string; error?: string };
      if (!body.ok) {
        setError(
          body.error === 'slug_taken' ? props.strings['err.slugTaken']
          : body.error === 'invalid_layout' ? props.strings['err.invalidLayout']
          : props.strings['err.saveFailed'],
        );
        return;
      }
      const newMeta = { ...meta, published };
      setMeta(newMeta);
      if (body.id && !pageId) {
        setPageId(body.id);
        window.history.replaceState(null, '', `/admin/pages/builder/${body.id}`);
      }
      savedSnapshot.current = JSON.stringify({ layout: state.layout, meta: newMeta });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch {
      setError(props.strings['err.saveFailed']);
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File): Promise<string | null> => {
    try {
      const fd = new FormData();
      fd.append('action', 'upload');
      fd.append('file', file);
      const res = await fetch(window.location.pathname, { method: 'POST', body: fd });
      const body = (await res.json()) as { ok: boolean; path?: string };
      if (!body.ok || !body.path) {
        setError(props.strings['err.uploadFailed']);
        return null;
      }
      return body.path;
    } catch {
      setError(props.strings['err.uploadFailed']);
      return null;
    }
  };

  const selectedNode = useMemo(
    () => (state.selectedId ? findNode(state.layout, state.selectedId)?.node ?? null : null),
    [state.layout, state.selectedId],
  );
  const viewHref = pageId && meta.published && !dirty ? `/${props.uiLang}/p/${meta.slug}` : null;

  return (
    <div className="space-y-4">
      <TopBar
        slug={meta.slug}
        titleEn={meta.titleEn}
        titleZh={meta.titleZh}
        published={meta.published}
        editLocale={editLocale}
        dirty={dirty}
        saving={saving}
        savedFlash={savedFlash}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        viewHref={viewHref}
        error={error}
        strings={props.strings}
        onMeta={(patch) => setMeta((m) => ({ ...m, ...patch }))}
        onLocale={setEditLocale}
        onUndo={() => dispatch({ type: 'undo' })}
        onRedo={() => dispatch({ type: 'redo' })}
        onSave={save}
      />
      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDraggingType(null)}>
        <div className="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)_18rem]">
          <Palette strings={props.strings} onQuickAdd={quickAdd} />
          <Canvas
            layout={state.layout}
            selectedId={state.selectedId}
            editLocale={editLocale}
            draggingType={draggingType}
            strings={props.strings}
            onSelect={(id) => dispatch({ type: 'select', id })}
            onRemove={(id) => dispatch({ type: 'remove', id })}
            onDuplicate={(id) => dispatch({ type: 'duplicate', id })}
          />
          <PropertiesPanel
            node={selectedNode}
            editLocale={editLocale}
            media={props.media}
            strings={props.strings}
            onUpdate={(id, p) => dispatch({ type: 'update', id, props: p })}
            onUpload={upload}
          />
        </div>
        <DragOverlay>
          {draggingType && (
            <div className="rounded-md border border-border bg-surface-raised px-3 py-2 text-sm shadow-md">
              {props.strings[`block.${draggingType}`]}
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
