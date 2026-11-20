// Registration admin write actions against D1: saving the editor form (all languages,
// waitlist switch, prefix, poster key, the "no price on D1" rule) and the list buttons
// (Open now / Close now / Hide / Show / Duplicate).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyEventAction, saveEventFromForm } from '../src/lib/regAdminActions';
import { getEventAdmin, saveEvent } from '../src/lib/regDb';

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  return fd;
};

const BASE = { title_en: 'Retreat', starts_at: '2031-05-01T10:00' };

async function newEvent(extra: Partial<Parameters<typeof saveEvent>[1]> = {}): Promise<number> {
  return saveEvent(env.DB, { titles: { en: { title: 'Seed' } }, starts_at: '2031-05-01 10:00:00', active: 1, ...extra });
}

describe('saveEventFromForm', () => {
  it('saves every language, the waitlist switch, an upper-cased prefix and a valid poster key', async () => {
    const fd = form({
      ...BASE, title_zh: '退修会', title_de: 'Rüstzeit', description_en: 'Away day', active: '1',
      waitlist_enabled: '0', confirmation_prefix: 'spr1', poster: 'uploads/abc123-poster.webp',
    });
    const result = await saveEventFromForm(env.DB, 'd1', fd, { id: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const saved = await getEventAdmin(env.DB, result.id);
    expect(saved).toMatchObject({
      titles: { en: 'Retreat', zh: '退修会', de: 'Rüstzeit' },
      waitlist_enabled: 0, confirmation_prefix: 'SPR1', poster: 'uploads/abc123-poster.webp', price_cents: null,
    });
  });

  it('drops a poster that is not an uploaded media key, and lets the page replace or clear it', async () => {
    const bad = await saveEventFromForm(env.DB, 'd1', form({ ...BASE, poster: 'https://elsewhere.example/x.png' }), { id: null });
    if (!bad.ok) throw new Error('expected ok');
    expect((await getEventAdmin(env.DB, bad.id))?.poster).toBeNull();

    const id = await newEvent({ poster: 'uploads/old.png' });
    await saveEventFromForm(env.DB, 'd1', form({ ...BASE, poster: 'uploads/old.png' }), { id, poster: null });
    expect((await getEventAdmin(env.DB, id))?.poster).toBeNull();
  });

  it('refuses a price on D1 but accepts it on the Postgres backend', async () => {
    const count = () => env.DB.prepare(`SELECT count(*) n FROM reg_events`).first<number>('n');
    const before = await count();
    const refused = await saveEventFromForm(env.DB, 'd1', form({ ...BASE, price: '25' }), { id: null });
    expect(refused).toEqual({ ok: false, errors: { price: 'admin.reg.priceD1Error' } });
    expect(await count()).toBe(before);

    const allowed = await saveEventFromForm(env.DB, 'supabase', form({ ...BASE, price: '25' }), { id: null });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect((await getEventAdmin(env.DB, allowed.id))?.price_cents).toBe(2500);
  });

  it('reports form errors without saving', async () => {
    const result = await saveEventFromForm(env.DB, 'd1', form({ ...BASE, title_en: '', confirmation_prefix: 'much too long' }), { id: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.title_en).toBe('errors.required');
      expect(result.errors.confirmation_prefix).toBe('errors.invalidOption');
    }
  });
});

describe('applyEventAction', () => {
  const past = '2020-01-01 10:00:00';

  it('hides and shows an event', async () => {
    const id = await newEvent();
    expect(await applyEventAction(env.DB, form({ id: String(id), op: 'hide' }))).toEqual({ ok: true, notice: 'updated', id });
    expect((await getEventAdmin(env.DB, id))?.phase).toBe('hidden');
    await applyEventAction(env.DB, form({ id: String(id), op: 'show' }));
    expect((await getEventAdmin(env.DB, id))?.active).toBe(1);
  });

  it('closes now, then asks for a new closing time before opening again', async () => {
    const id = await newEvent();
    await applyEventAction(env.DB, form({ id: String(id), op: 'close_now' }));
    expect((await getEventAdmin(env.DB, id))?.phase).toBe('closed');

    expect(await applyEventAction(env.DB, form({ id: String(id), op: 'open_now' }))).toEqual({ ok: false, error: 'close_required', id });
    expect(await applyEventAction(env.DB, form({ id: String(id), op: 'open_now', closes_at: 'garbage' }))).toEqual({ ok: false, error: 'close_required', id });

    const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);
    expect(await applyEventAction(env.DB, form({ id: String(id), op: 'open_now', closes_at: future }))).toEqual({ ok: true, notice: 'updated', id });
    expect((await getEventAdmin(env.DB, id))?.phase).toBe('open');
  });

  it('opens a preview event immediately without needing a closing time', async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    const id = await newEvent({ opens_at: future, closes_at: null });
    expect((await getEventAdmin(env.DB, id))?.phase).toBe('preview');
    expect((await applyEventAction(env.DB, form({ id: String(id), op: 'open_now' }))).ok).toBe(true);
    expect((await getEventAdmin(env.DB, id))?.phase).toBe('open');
  });

  it('duplicates an event as an inactive copy', async () => {
    const id = await newEvent({ opens_at: past });
    const result = await applyEventAction(env.DB, form({ id: String(id), op: 'duplicate' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notice).toBe('duplicated');
    expect(result.id).not.toBe(id);
    expect(await getEventAdmin(env.DB, result.id)).toMatchObject({ active: 0, phase: 'hidden', titles: { en: 'Seed' } });
  });

  it('rejects a bad id, an unknown op and an unknown event', async () => {
    expect(await applyEventAction(env.DB, form({ id: 'x', op: 'hide' }))).toEqual({ ok: false, error: 'invalid', id: null });
    const id = await newEvent();
    expect(await applyEventAction(env.DB, form({ id: String(id), op: 'explode' }))).toEqual({ ok: false, error: 'invalid', id });
    expect(await applyEventAction(env.DB, form({ id: '999999', op: 'hide' }))).toEqual({ ok: false, error: 'not_found', id: 999999 });
    expect(await applyEventAction(env.DB, form({ id: '999999', op: 'duplicate' }))).toEqual({ ok: false, error: 'not_found', id: 999999 });
  });
});

describe('template actions', () => {
  const op = (id: number, name: string) => applyEventAction(env.DB, form({ id: String(id), op: name }));

  it('saves an event as a template, creates a new event from it, and deletes only templates', async () => {
    const id = await newEvent();
    const saved = await op(id, 'save_template');
    expect(saved).toMatchObject({ ok: true, notice: 'template_saved' });
    if (!saved.ok) return;
    expect((await getEventAdmin(env.DB, saved.id))?.is_template).toBe(1);

    const created = await op(saved.id, 'from_template');
    expect(created).toMatchObject({ ok: true, notice: 'template_created' });
    if (!created.ok) return;
    expect(await getEventAdmin(env.DB, created.id)).toMatchObject({ is_template: 0, active: 0 });

    // a regular event is never deleted, even by id; a template is
    expect(await op(created.id, 'delete_template')).toEqual({ ok: false, error: 'not_found', id: created.id });
    expect(await getEventAdmin(env.DB, created.id)).not.toBeNull();
    expect(await op(saved.id, 'delete_template')).toEqual({ ok: true, notice: 'template_deleted', id: saved.id });
    expect(await getEventAdmin(env.DB, saved.id)).toBeNull();
  });

  it('refuses the wrong source kind and every lifecycle button on a template', async () => {
    const id = await newEvent();
    expect(await op(id, 'from_template')).toEqual({ ok: false, error: 'not_found', id });
    const saved = await op(id, 'save_template');
    if (!saved.ok) throw new Error('expected ok');
    expect(await op(saved.id, 'save_template')).toEqual({ ok: false, error: 'not_found', id: saved.id });
    for (const name of ['open_now', 'close_now', 'hide', 'show']) {
      expect(await op(saved.id, name), name).toEqual({ ok: false, error: 'invalid', id: saved.id });
    }
    expect(await getEventAdmin(env.DB, saved.id)).toMatchObject({ active: 0, opens_at: null });
  });
});
