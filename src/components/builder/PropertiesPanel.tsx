// Properties for the selected block. Text-bearing props edit the CURRENT
// editing locale's exact string (no fallback here — that's a render-time
// behavior); everything else maps 1:1 onto layout enums.
import { useRef, useState } from 'react';
import type { AnyNode, L10nString } from '../../lib/pageLayout';
import { tin, lab } from '../../lib/adminUi';

export interface PropertiesPanelProps {
  node: AnyNode | null;
  editLocale: 'en' | 'zh';
  media: { path: string; filename: string }[];
  strings: Record<string, string>;
  onUpdate: (id: string, props: Record<string, unknown>) => void;
  onUpload: (file: File) => Promise<string | null>; // resolves to /media/... path or null on failure
}

export default function PropertiesPanel({ node, editLocale, media, strings, onUpdate, onUpload }: PropertiesPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  if (!node) return <p className="text-sm text-ink-subtle">{strings.propsNone}</p>;
  const set = (props: Record<string, unknown>) => onUpdate(node.id, props);
  const setL10n = (key: string, current: L10nString, value: string) =>
    set({ [key]: { ...current, [editLocale]: value } });

  const select = (label: string, value: string | number, options: [string | number, string][], onChange: (v: string) => void) => (
    <label className="block">
      <span className={lab}>{label}</span>
      <select className={tin} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, text]) => (
          <option key={String(v)} value={String(v)}>{text}</option>
        ))}
      </select>
    </label>
  );

  const alignSelect = (value: string) =>
    select(strings['prop.align'], value, [['left', strings['opt.left']], ['center', strings['opt.center']], ['right', strings['opt.right']]], (v) => set({ align: v }));

  const sizeOptions: [string, string][] = [['sm', strings['opt.sm']], ['md', strings['opt.md']], ['lg', strings['opt.lg']], ['xl', strings['opt.xl']]];

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        {strings.props} — {strings[`block.${node.type}`]}
      </h2>

      {node.type === 'section' && (
        <>
          {select(strings['prop.background'], node.props.bg, [['none', strings['opt.none']], ['soft', strings['opt.soft']], ['primary', strings['opt.primary']], ['accent', strings['opt.accent']]], (v) => set({ bg: v }))}
          {select(strings['prop.width'], node.props.width, [['narrow', strings['opt.narrow']], ['content', strings['opt.content']], ['wide', strings['opt.wide']]], (v) => set({ width: v }))}
          {select(strings['prop.padding'], node.props.padY, [['sm', strings['opt.sm']], ['md', strings['opt.md']], ['lg', strings['opt.lg']]], (v) => set({ padY: v }))}
        </>
      )}

      {node.type === 'columns' && (
        <>
          {select(strings['prop.columns'], node.props.count, [[2, '2'], [3, '3'], [4, '4']], (v) => set({ count: Number(v) }))}
          {select(strings['prop.gap'], node.props.gap, [['sm', strings['opt.sm']], ['md', strings['opt.md']], ['lg', strings['opt.lg']]], (v) => set({ gap: v }))}
        </>
      )}

      {node.type === 'heading' && (
        <>
          <label className="block">
            <span className={lab}>{strings['prop.text']}</span>
            <textarea className={tin} rows={2} value={node.props.text[editLocale]} onChange={(e) => setL10n('text', node.props.text, e.target.value)} />
          </label>
          {select(strings['prop.level'], node.props.level, [[1, 'H1'], [2, 'H2'], [3, 'H3']], (v) => set({ level: Number(v) }))}
          {select(strings['prop.size'], node.props.size, sizeOptions, (v) => set({ size: v }))}
          <label className="block">
            <span className={lab}>{strings['prop.customSize']}</span>
            <input
              className={tin}
              type="number"
              min={10}
              max={120}
              value={node.props.customSizePx ?? ''}
              onChange={(e) => {
                const n = e.target.value === '' ? undefined : Math.min(120, Math.max(10, Number(e.target.value)));
                set({ customSizePx: n });
              }}
            />
          </label>
          {alignSelect(node.props.align)}
        </>
      )}

      {node.type === 'text' && (
        <>
          <label className="block">
            <span className={lab}>{strings['prop.text']}</span>
            <textarea className={`${tin} font-mono`} rows={8} value={node.props.md[editLocale]} onChange={(e) => setL10n('md', node.props.md, e.target.value)} />
          </label>
          <p className="text-xs text-ink-subtle">{strings['prop.markdownHint']}</p>
          {alignSelect(node.props.align)}
        </>
      )}

      {node.type === 'image' && (
        <>
          <label className="block">
            <span className={lab}>{strings['prop.imageUrl']}</span>
            <input className={`${tin} font-mono`} value={node.props.src} onChange={(e) => set({ src: e.target.value })} />
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setUploading(true);
              const path = await onUpload(file);
              setUploading(false);
              if (path) set({ src: path });
              e.target.value = '';
            }}
          />
          <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-sunken" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? strings.uploading : strings.upload}
          </button>
          {media.length > 0 && (
            <div>
              <span className={lab}>{strings.recentUploads}</span>
              <div className="mt-1 grid max-h-40 grid-cols-4 gap-1 overflow-y-auto">
                {media.map((m) => (
                  <button key={m.path} type="button" title={m.filename} onClick={() => set({ src: m.path })} className="aspect-square overflow-hidden rounded border border-border hover:ring-2 hover:ring-ring">
                    <img src={m.path} alt={m.filename} className="h-full w-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="block">
            <span className={lab}>{strings['prop.altText']}</span>
            <input className={tin} value={node.props.alt[editLocale]} onChange={(e) => setL10n('alt', node.props.alt, e.target.value)} />
          </label>
          {select(strings['prop.width'], node.props.width, [['full', strings['opt.full']], ['wide', strings['opt.wide']], ['medium', strings['opt.md']], ['small', strings['opt.sm']]], (v) => set({ width: v }))}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={node.props.rounded} onChange={(e) => set({ rounded: e.target.checked })} /> {strings['prop.rounded']}
          </label>
          {alignSelect(node.props.align)}
        </>
      )}

      {node.type === 'button' && (
        <>
          <label className="block">
            <span className={lab}>{strings['prop.label']}</span>
            <input className={tin} value={node.props.label[editLocale]} onChange={(e) => setL10n('label', node.props.label, e.target.value)} />
          </label>
          <label className="block">
            <span className={lab}>{strings['prop.href']}</span>
            <input className={`${tin} font-mono`} value={node.props.href} onChange={(e) => set({ href: e.target.value })} />
          </label>
          {select(strings['prop.variant'], node.props.variant, [['primary', strings['prop.variantPrimary']], ['secondary', strings['prop.variantSecondary']]], (v) => set({ variant: v }))}
          {alignSelect(node.props.align)}
        </>
      )}

      {node.type === 'spacer' &&
        select(strings['prop.height'], node.props.size, sizeOptions, (v) => set({ size: v }))}
    </div>
  );
}
