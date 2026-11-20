// The page-builder registration card: its layout node, the shared "full" rule, the view model and
// HTML for every state (pure), and the loader against D1 (hidden, template and unknown events render
// nothing; per-type limits decide full).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { validateLayout } from '../src/lib/pageLayout';
import { newBlock } from '../src/components/builder/newBlock';
import { canDrop } from '../src/components/builder/model';
import { seatState } from '../src/lib/regPublic';
import { loadRegistrationCard, registrationCardHtml, registrationCardView, type RegCardCopy } from '../src/lib/regBlock';
import type { RegPublicEvent, RegTicketType } from '../src/lib/regDb';

const l10n = (en = '', zh = '') => ({ en, zh });
const section = (children: unknown[]) => ({ id: 's1', type: 'section', props: { bg: 'none', width: 'content', padY: 'md' }, children });
const node = (props: unknown, id = 'r1') => ({ id, type: 'registration', props });
const wrap = (children: unknown[]) => JSON.stringify({ v: 1, blocks: [section(children)] });

describe('registration layout node', () => {
  it('accepts a chosen event and an unchosen one, and rebuilds the node from known fields only', () => {
    const ok = validateLayout(wrap([node({ eventId: 7, showSeats: true, buttonLabel: l10n('Sign up', '报名'), extra: 'x' })]));
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) expect((ok.layout.blocks[0].children[0] as { props: object }).props).toEqual({ eventId: 7, showSeats: true, buttonLabel: l10n('Sign up', '报名') });
    expect(validateLayout(wrap([node({ eventId: null, showSeats: false, buttonLabel: l10n() })])).ok).toBe(true);
  });

  it('is allowed inside columns', () => {
    const columns = { id: 'c1', type: 'columns', props: { count: 2, gap: 'md' }, columns: [[node({ eventId: 1, showSeats: true, buttonLabel: l10n() }, 'r2')], []] };
    expect(validateLayout(wrap([columns])).ok).toBe(true);
  });

  it.each([
    ['zero id', { eventId: 0, showSeats: true, buttonLabel: l10n() }],
    ['negative id', { eventId: -3, showSeats: true, buttonLabel: l10n() }],
    ['fractional id', { eventId: 1.5, showSeats: true, buttonLabel: l10n() }],
    ['string id', { eventId: '7', showSeats: true, buttonLabel: l10n() }],
    ['missing id', { showSeats: true, buttonLabel: l10n() }],
    ['non-boolean seats', { eventId: 7, showSeats: 'yes', buttonLabel: l10n() }],
    ['plain-string label', { eventId: 7, showSeats: true, buttonLabel: 'Go' }],
    ['unknown label locale', { eventId: 7, showSeats: true, buttonLabel: { ...l10n(), xx: 'Go' } }],
    ['label too long', { eventId: 7, showSeats: true, buttonLabel: l10n('x'.repeat(501)) }],
  ])('rejects %s', (_name, props) => {
    expect(validateLayout(wrap([node(props)]))).toEqual({ ok: false, error: 'bad_node' });
  });

  it('a layout saved before the block existed parses unchanged', () => {
    const old = wrap([{ id: 'h1', type: 'heading', props: { level: 2, text: l10n('Hi'), align: 'left', size: 'md' } }]);
    const res = validateLayout(old);
    expect(res.ok && JSON.stringify(res.layout)).toBe(old);
  });

  it('newBlock makes a valid default that drops into sections and columns only', () => {
    const block = newBlock('registration');
    expect(block).toMatchObject({ type: 'registration', props: { eventId: null, showSeats: true, buttonLabel: l10n() } });
    expect(validateLayout(wrap([block])).ok).toBe(true);
    expect(canDrop('registration', 'root')).toBe(false);
    expect(canDrop('registration', 'sec:s1')).toBe(true);
    expect(canDrop('registration', 'col:c1:0')).toBe(true);
  });
});

const ev = (over: Partial<RegPublicEvent> = {}): RegPublicEvent => ({
  id: 5, title: 'Fall <Retreat>', description: null, starts_at: '2031-10-04 15:00:00', ends_at: null, location: 'Camp "Oak"',
  capacity: 10, price_cents: null, currency: 'USD', opens_at: null, closes_at: null, active: 1, visible_from: null, waitlist_enabled: 0,
  confirmation_prefix: null, poster: null, notes: null, max_party_size: 4, allow_self_edit: 1, confirmed_count: 0, taken_count: 0, waitlist_count: 0,
  phase: 'open', ...over,
});
const type = (id: number, capacity: number | null, taken: number, price_cents = 0): RegTicketType => ({
  id, sort: id, price_cents, capacity, active: 1, label: `T${id}`, description: null, taken, seats_left: capacity === null ? null : Math.max(0, capacity - taken),
});

describe('seatState (the shared full rule)', () => {
  it('judges an untyped event by its capacity', () => {
    expect(seatState(ev({ taken_count: 9 }))).toEqual({ full: false, waitlist: false });
    expect(seatState(ev({ taken_count: 10 }))).toEqual({ full: true, waitlist: false });
    expect(seatState(ev({ capacity: null, taken_count: 999 })).full).toBe(false);
  });

  it('is full when every active type is at its limit, never when one is unlimited or has room', () => {
    expect(seatState(ev(), [type(1, 2, 2), type(2, 3, 3)]).full).toBe(true);
    expect(seatState(ev(), [type(1, 2, 2), type(2, null, 50)]).full).toBe(false);
    expect(seatState(ev(), [type(1, 2, 2), type(2, 3, 2)]).full).toBe(false);
  });

  it('is full by event capacity even when a type has room', () => {
    expect(seatState(ev({ taken_count: 10 }), [type(1, 5, 0)]).full).toBe(true);
  });

  it('offers the waitlist only when free, with the waitlist on', () => {
    const full = ev({ taken_count: 10, waitlist_enabled: 1 });
    expect(seatState(full)).toEqual({ full: true, waitlist: true });
    expect(seatState({ ...full, price_cents: 500 }).waitlist).toBe(false);
    expect(seatState(full, [type(1, 1, 1, 0), type(2, 1, 1, 0)]).waitlist).toBe(true);
    expect(seatState(full, [type(1, 1, 1, 0), type(2, 1, 1, 2500)]).waitlist).toBe(false);
    // with active types the event price is ignored
    expect(seatState({ ...full, price_cents: 500 }, [type(1, 1, 1, 0)]).waitlist).toBe(true);
  });
});

const copy: RegCardCopy = {
  cta: 'Register',
  opensOn: (date) => `Registration opens ${date}`,
  seatsLeft: (count) => `Seats left: ${count}`,
  full: 'Full',
  fullWaitlist: 'Full — join the waitlist',
  closed: 'Registration closed',
};
const html = (event: RegPublicEvent, types: RegTicketType[] = [], showSeats = true, label = '') =>
  registrationCardHtml(registrationCardView(event, types, 'en', showSeats), copy, label);

describe('registration card states', () => {
  it('open: title, date, location, seats left and the default button to the sign-up page', () => {
    const out = html(ev({ taken_count: 4 }));
    expect(out).toContain('data-reg-state="open"');
    expect(out).toContain('Fall &lt;Retreat&gt;');
    expect(out).toContain('Camp &quot;Oak&quot;');
    expect(out).toContain('October 4, 2031 10:00');
    expect(out).toContain('Seats left: 6');
    expect(out).toContain('href="/en/register/5"');
    expect(out).toContain('>Register</a>');
  });

  it('uses a custom button label, hides seats when not shown, and shows the poster', () => {
    const out = html(ev({ poster: 'uploads/abc-poster.png' }), [], false, 'Save my spot');
    expect(out).toContain('>Save my spot</a>');
    expect(out).not.toContain('Seats left');
    expect(out).toContain('src="/media/uploads/abc-poster.png"');
  });

  it('seats left follow per-type limits when every type is limited', () => {
    expect(html(ev(), [type(1, 2, 1), type(2, 3, 0)])).toContain('Seats left: 4');
    expect(html(ev(), [type(1, 2, 1), type(2, null, 0)])).toContain('Seats left: 10');
  });

  it('an unlimited event shows no seats line', () => {
    expect(html(ev({ capacity: null }))).not.toContain('Seats left');
  });

  it('preview: says when registration opens', () => {
    const out = html(ev({ phase: 'preview', opens_at: '2031-09-01 14:00:00' }));
    expect(out).toContain('data-reg-state="preview"');
    expect(out).toContain('Registration opens September 1, 2031 09:00');
    expect(out).not.toContain('Seats left');
  });

  it('full with a waitlist, full without one (also by per-type limits)', () => {
    const waitlist = html(ev({ taken_count: 10, waitlist_enabled: 1 }));
    expect(waitlist).toContain('data-reg-state="waitlist"');
    expect(waitlist).toContain('Full — join the waitlist');
    const plain = html(ev({ taken_count: 10 }));
    expect(plain).toContain('data-reg-state="full"');
    expect(plain).toContain('>Full</p>');
    expect(plain).not.toContain('Seats left');
    expect(html(ev(), [type(1, 2, 2), type(2, 2, 2)])).toContain('data-reg-state="full"');
    expect(html(ev({ waitlist_enabled: 1 }), [type(1, 2, 2), type(2, 2, 2)])).toContain('data-reg-state="waitlist"');
  });

  it('closed: says so and offers no button', () => {
    const out = html(ev({ phase: 'closed' }));
    expect(out).toContain('Registration closed');
    expect(out).not.toContain('<a ');
  });

  it('localizes the link', () => {
    expect(registrationCardView(ev(), [], 'zh', true).href).toBe('/zh/register/5');
  });
});

describe('loadRegistrationCard on D1', () => {
  const props = (eventId: number | null) => ({ eventId, showSeats: true, buttonLabel: l10n() });
  const seed = async (id: number, extra: { active?: number; template?: number; waitlist?: number } = {}) => {
    await env.DB.prepare(
      `INSERT INTO reg_events (id, starts_at, capacity, active, is_template, waitlist_enabled)
       VALUES (?1, datetime('now','+30 days'), 4, ?2, ?3, ?4)`,
    ).bind(id, extra.active ?? 1, extra.template ?? 0, extra.waitlist ?? 0).run();
    await env.DB.prepare(`INSERT INTO reg_event_i18n (event_id, locale, title) VALUES (?1, 'en', ?2)`).bind(id, `Event ${id}`).run();
  };

  it('renders an open event and nothing for unknown, unchosen, hidden and template events', async () => {
    await seed(8101);
    await seed(8102, { active: 0 });
    await seed(8103, { template: 1 });
    expect(await loadRegistrationCard(env.DB, 'en', props(8101), copy)).toContain('Event 8101');
    expect(await loadRegistrationCard(env.DB, 'en', props(8101), copy)).toContain('Seats left: 4');
    for (const id of [8102, 8103, 999999, null]) expect(await loadRegistrationCard(env.DB, 'en', props(id), copy)).toBe('');
  });

  it('shows the preview and closed phases and counts per-type limits', async () => {
    await seed(8104);
    await env.DB.prepare(`UPDATE reg_events SET opens_at = datetime('now','+5 days') WHERE id = 8104`).run();
    expect(await loadRegistrationCard(env.DB, 'en', props(8104), copy)).toContain('Registration opens');
    await seed(8105);
    await env.DB.prepare(`UPDATE reg_events SET closes_at = datetime('now','-1 day'), starts_at = datetime('now','-1 hour') WHERE id = 8105`).run();
    expect(await loadRegistrationCard(env.DB, 'en', props(8105), copy)).toContain('Registration closed');
    await seed(8106);
    const t = await env.DB.prepare(`INSERT INTO reg_ticket_types (event_id, price_cents, capacity) VALUES (8106, 0, 1) RETURNING id`).first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO reg_ticket_type_i18n (ticket_type_id, locale, label) VALUES (?1, 'en', 'Adult')`).bind(t!.id).run();
    const open = await loadRegistrationCard(env.DB, 'en', props(8106), copy);
    expect(open).toContain('Seats left: 1');
    const r = await env.DB.prepare(`INSERT INTO registrations (event_id, name, email, submission_key, party_size, status) VALUES (8106, 'A', 'a@example.com', 'blk-1', 1, 'confirmed') RETURNING id`).first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO reg_attendees (registration_id, name, ticket_type_id) VALUES (?1, 'A', ?2)`).bind(r!.id, t!.id).run();
    expect(await loadRegistrationCard(env.DB, 'en', props(8106), copy)).toContain('data-reg-state="full"');
  });
});
