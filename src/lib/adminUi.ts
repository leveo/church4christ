// Shared Tailwind class-constant strings for the /admin surfaces. Token
// utilities only (no literal colors/fonts) so a theme swap restyles admin for
// free — same idea as dcfc-serve's adminUi.ts, rewritten against our tokens.
// Pages compose these; keeping them here keeps the markup declarative and the
// look consistent across every admin page.

/** Text input / select / search box. */
export const tin =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none';
/** Field label above an input. */
export const lab = 'block text-sm font-semibold text-ink-muted mb-1';
/** Card / section wrapper. */
export const card = 'rounded-xl border border-border bg-surface-raised p-6 shadow-sm';
/** Inline validation message under a field. */
export const errorText = 'mt-1 text-sm text-danger';

/** Primary action button. */
export const btn =
  'inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover';
/** Secondary / neutral button. */
export const btnSecondary =
  'inline-flex items-center rounded-md border border-border px-4 py-2 text-sm font-semibold text-ink hover:bg-surface-sunken';
/** Destructive button (soft delete). */
export const btnDanger =
  'inline-flex items-center rounded-md border border-danger px-4 py-2 text-sm font-semibold text-danger hover:bg-danger-soft';

/** Table header cell. */
export const th = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-caps text-ink-subtle';
/** Table body cell. */
export const td = 'px-3 py-2 text-sm';

/** Pill badge base; combine with a variant below. */
export const badge = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';
export const badgeRole: Record<'member' | 'editor' | 'admin', string> = {
  member: 'bg-surface-sunken text-ink-muted',
  editor: 'bg-accent-soft text-on-accent-soft',
  admin: 'bg-primary-soft text-on-primary-soft',
};
export const badgeActive = 'bg-success-soft text-success';
export const badgeInactive = 'bg-surface-sunken text-ink-muted';

/** Success banner (e.g. the ?saved=1 confirmation). */
export const noticeOk = 'rounded-md border border-success bg-success-soft px-4 py-2 text-sm text-success';
/** Error banner (e.g. the form-wide validation summary). */
export const noticeErr = 'rounded-md border border-danger bg-danger-soft px-4 py-2 text-sm text-danger';
