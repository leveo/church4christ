// Top bar: page meta (slug/titles/published), locale toggle for text entry,
// undo/redo, save actions, and the dirty/saved indicator.
import { btn, btnSecondary, tin, lab } from '../../lib/adminUi';

export interface TopBarProps {
  slug: string;
  titleEn: string;
  titleZh: string;
  published: boolean;
  editLocale: 'en' | 'zh';
  dirty: boolean;
  saving: boolean;
  savedFlash: boolean;
  canUndo: boolean;
  canRedo: boolean;
  viewHref: string | null;
  error: string | null;
  strings: Record<string, string>;
  onMeta: (patch: Partial<{ slug: string; titleEn: string; titleZh: string; published: boolean }>) => void;
  onLocale: (l: 'en' | 'zh') => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: (publish?: boolean) => void;
}

export default function TopBar(p: TopBarProps) {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface-raised p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className={lab}>{p.strings.slug}</span>
          <input className={`${tin} font-mono`} value={p.slug} onChange={(e) => p.onMeta({ slug: e.target.value })} />
        </label>
        <label className="block">
          <span className={lab}>{p.strings.titleEn}</span>
          <input className={tin} value={p.titleEn} onChange={(e) => p.onMeta({ titleEn: e.target.value })} />
        </label>
        <label className="block">
          <span className={lab}>{p.strings.titleZh}</span>
          <input className={tin} value={p.titleZh} onChange={(e) => p.onMeta({ titleZh: e.target.value })} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <a href="/admin/pages" className="text-sm text-primary hover:underline">← {p.strings.back}</a>
        <span className="text-sm text-ink-subtle">{p.strings.editingIn}:</span>
        <div className="flex overflow-hidden rounded-md border border-border text-sm">
          {(['en', 'zh'] as const).map((l) => (
            <button key={l} type="button" onClick={() => p.onLocale(l)}
              className={`px-3 py-1 ${p.editLocale === l ? 'bg-primary text-on-primary' : 'bg-surface hover:bg-surface-sunken'}`}>
              {l === 'en' ? p.strings.localeEn : p.strings.localeZh}
            </button>
          ))}
        </div>
        <button type="button" className={btnSecondary} disabled={!p.canUndo} onClick={p.onUndo} title={p.strings.undo}>↩</button>
        <button type="button" className={btnSecondary} disabled={!p.canRedo} onClick={p.onRedo} title={p.strings.redo}>↪</button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.published} onChange={(e) => p.onMeta({ published: e.target.checked })} /> {p.strings.published}
        </label>
        <span className="grow" />
        {p.error && <span className="text-sm text-danger">{p.error}</span>}
        {!p.error && p.dirty && !p.saving && <span className="text-sm text-warn">{p.strings.unsaved}</span>}
        {!p.error && p.savedFlash && !p.dirty && <span className="text-sm text-success">{p.strings.saved}</span>}
        {p.viewHref && <a href={p.viewHref} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">{p.strings.view}</a>}
        <button type="button" className={btnSecondary} disabled={p.saving} onClick={() => p.onSave()}>
          {p.saving ? p.strings.saving : p.strings.save}
        </button>
        <button type="button" className={btn} disabled={p.saving} onClick={() => p.onSave(true)}>
          {p.strings.savePublish}
        </button>
      </div>
    </div>
  );
}
