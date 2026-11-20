// Registration admin write actions, kept out of the Astro pages so they can be
// unit-tested against a real database: save an event from the editor form (with
// the backend rule that paid events need Postgres) and apply a lifecycle or
// duplicate button. The pages only translate the result into a redirect or banner.
import type { AppDb } from './appDb';
import type { DbBackend } from './dbProvider';
import { datetimeLocalToUtc } from './dates';
import { parseRegEventForm } from './regForms';
import { cloneEvent, createFromTemplate, deleteTemplate, saveAsTemplate, saveEvent, setEventLifecycle, type RegLifecycleAction } from './regDb';

/** A stored poster is always an uploaded media key; anything else is dropped. */
const POSTER_KEY = /^uploads\/[a-z0-9][a-z0-9.-]*$/;

export type SaveEventResult =
  | { ok: true; id: number }
  | { ok: false; errors: Record<string, string> };

/**
 * Parse and save the event editor form. `poster` (when not undefined) replaces the
 * posted poster key, so the page can pass a freshly uploaded key or null for "remove".
 * On D1 a price is refused (paid registration needs Postgres + Stripe).
 */
export async function saveEventFromForm(
  db: AppDb,
  backend: DbBackend,
  fd: FormData,
  opts: { id: number | null; poster?: string | null },
): Promise<SaveEventResult> {
  const parsed = parseRegEventForm(fd);
  if (!parsed.ok) return parsed;
  const data = { ...parsed.data };
  if (opts.poster !== undefined) data.poster = opts.poster;
  if (data.poster !== undefined && data.poster !== null && !POSTER_KEY.test(data.poster)) data.poster = null;
  if (backend === 'd1' && data.price_cents !== null) {
    return { ok: false, errors: { price: 'admin.reg.priceD1Error' } };
  }
  const id = await saveEvent(db, { ...(opts.id !== null ? { id: opts.id } : {}), ...data });
  return { ok: true, id };
}

const LIFECYCLE_ACTIONS: readonly RegLifecycleAction[] = ['open_now', 'close_now', 'hide', 'show'];

export type EventActionResult =
  | { ok: true; notice: 'updated' | 'duplicated' | 'template_saved' | 'template_created' | 'template_deleted'; id: number }
  | { ok: false; error: 'close_required' | 'invalid' | 'not_found'; id: number | null };

/**
 * Apply one list button. Form fields: `id`, `op` (open_now | close_now | hide | show |
 * duplicate | save_template | from_template | delete_template) and, for open_now on an event whose closing time has passed, `closes_at`
 * (datetime-local). Duplicate returns the new (inactive) event's id.
 */
export async function applyEventAction(db: AppDb, fd: FormData): Promise<EventActionResult> {
  const idRaw = String(fd.get('id') ?? '');
  if (!/^\d+$/.test(idRaw)) return { ok: false, error: 'invalid', id: null };
  const id = Number(idRaw);
  const op = String(fd.get('op') ?? '');
  try {
    if (op === 'duplicate') return { ok: true, notice: 'duplicated', id: await cloneEvent(db, id) };
    // Templates: "Save as template" copies an event (never a template) into one; "New event from
    // template" copies a template into a regular, inactive event; only a template can be deleted.
    if (op === 'save_template') return { ok: true, notice: 'template_saved', id: await saveAsTemplate(db, id) };
    if (op === 'from_template') return { ok: true, notice: 'template_created', id: await createFromTemplate(db, id) };
    if (op === 'delete_template') {
      return (await deleteTemplate(db, id)) ? { ok: true, notice: 'template_deleted', id } : { ok: false, error: 'not_found', id };
    }
    if (!LIFECYCLE_ACTIONS.includes(op as RegLifecycleAction)) return { ok: false, error: 'invalid', id };
    const closesRaw = String(fd.get('closes_at') ?? '').trim();
    let closesAt: string | null = null;
    if (closesRaw !== '') {
      closesAt = datetimeLocalToUtc(closesRaw);
      if (closesAt === null) return { ok: false, error: 'close_required', id };
    }
    await setEventLifecycle(db, id, op as RegLifecycleAction, { closesAt });
    return { ok: true, notice: 'updated', id };
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'close_required') return { ok: false, error: 'close_required', id };
    if (message === 'event_not_found' || message === 'template_not_found') return { ok: false, error: 'not_found', id };
    // a lifecycle button aimed at a template: refused like any invalid button
    if (message === 'template_not_allowed') return { ok: false, error: 'invalid', id };
    throw error;
  }
}
