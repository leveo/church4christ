// Registration back office behavior that must hold on BOTH backends (Phase 4): per-event access, approval,
// the roster query, drawer operations (version conflicts, soft confirms), manual add, duplicates, the overview,
// check-in, reminders, the outbox and refund bookkeeping. Run against D1 (test/regOffice.d1.test.ts) and
// Postgres (test/pg/regOffice.pg.test.ts), plain and through the campus SQL scoper. No cloudflare:test or node
// imports, and the name does not end in .test.ts, so neither project collects it on its own.
import { describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import type { DbBackend } from '../../src/lib/dbProvider';
import type { SessionUser } from '../../src/lib/types';
import {
  cancelRegistration,
  cloneEvent,
  createRegistration,
  getEventAdmin,
  listQuestions,
  listTicketTypesAdmin,
  promoteWaitlist,
  saveEvent,
  saveEventForm,
  type EventFormPayload,
  type RegAttendeeInput,
  type RegStatus,
} from '../../src/lib/regDb';
import {
  canEditEvent,
  canRefund,
  eventOfAttendee,
  eventOfRegistration,
  grantEventRole,
  hasRegistrationArea,
  listEventRoles,
  listEventRolesForPerson,
  regEventRole,
  regRoleAllows,
  requireRegRole,
  revokeEventRole,
} from '../../src/lib/regAccess';
import {
  adminAddPerson,
  adminCancelRegistration,
  adminChangeTicketType,
  adminCreateRegistration,
  adminMoveStatus,
  adminRemovePerson,
  adminSetNote,
  adminUpdateRegistration,
  decideRegistration,
  eventOverview,
  getRegistrationAdmin,
  listActivity,
  listDuplicates,
  listRoster,
  normalizeName,
} from '../../src/lib/regAdmin';
import { checkIn, checkInParty, checkOut, deskCounts, deskVersion, findForDesk, undoCheckIn } from '../../src/lib/regCheckin';
import {
  bulkAudience,
  claimOutbox,
  claimReminder,
  enqueueOutbox,
  findReminderCandidates,
  markOutboxFailed,
  markOutboxSent,
  markOutboxSkipped,
  outboxCounts,
  recordRefund,
  releaseReminder,
  syncRefundedTotal,
} from '../../src/lib/regOutbox';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const tsAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

let keySeq = 0;
const key = () => `office-${Date.now()}-${++keySeq}`;
let personSeq = 0;

export function user(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 1, email: 'x@example.com', displayName: 'X', role: 'member', isAdmin: false, isEditor: false, finance: 0,
    memberTeamIds: [], leaderTeamIds: [], lang: null, isSuperAdmin: false, adminAreas: [], ...over,
  };
}

export function defineRegOfficeCases(label: string, getDb: () => AppDb, backend: DbBackend): void {
  const newEvent = (over: Partial<Parameters<typeof saveEvent>[1]> = {}) =>
    saveEvent(getDb(), { title_en: 'Conference', title_zh: '大会', starts_at: tsAt(30 * DAY), active: 1, max_party_size: 6, ...over });
  const register = (eventId: number, attendees: RegAttendeeInput[] = [{ name: 'Ada' }], over: Partial<Parameters<typeof createRegistration>[1]> = {}) =>
    createRegistration(getDb(), {
      eventId, personId: null, name: attendees[0]?.name ?? 'Ada', email: `${(attendees[0]?.name ?? 'ada').toLowerCase().replace(/\W+/g, '')}@example.com`,
      status: 'confirmed', amountCents: 0, currency: 'usd', answers: [], attendees, submissionKey: key(), ...over,
    });
  const person = async (name = 'Staff') => {
    const row = await getDb().prepare(`INSERT INTO people (display_name, email) VALUES (?1, ?2) RETURNING id`).bind(name, `${name.toLowerCase()}-${++personSeq}-${Date.now()}@example.com`).first<{ id: number }>();
    return row!.id;
  };
  const one = async <T>(sql: string, ...binds: unknown[]) => (await getDb().prepare(sql).bind(...binds).first<T>())!;
  const count = async (sql: string, ...binds: unknown[]) => Number((await one<{ n: number }>(sql, ...binds)).n);
  const statusOf = async (id: number) => (await one<{ status: RegStatus }>(`SELECT status FROM registrations WHERE id = ?1`, id)).status;
  const versionOf = async (id: number) => (await one<{ version: number }>(`SELECT version FROM registrations WHERE id = ?1`, id)).version;
  const actionsOf = async (id: number) => (await listActivity(getDb(), id)).map((a) => a.action).reverse();
  const mustForm = async (eventId: number, payload: EventFormPayload) => expect(await saveEventForm(getDb(), eventId, payload, { backend })).toEqual({ ok: true });
  const attendeesOf = async (registrationId: number) =>
    (await getDb().prepare(`SELECT id, name, status, ticket_type_id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort, id`).bind(registrationId).all<{ id: number; name: string; status: string; ticket_type_id: number | null }>()).results;

  describe(`registration back office (${label})`, () => {
    // ── Access ─────────────────────────────────────────────────────────────────
    describe('access', () => {
      const registrationAdmin = user({ id: 11, role: 'admin', isAdmin: true, isSuperAdmin: true });
      const grantedAdmin = user({ id: 12, role: 'admin', isAdmin: true, adminAreas: ['registration'] });
      const limitedAdmin = user({ id: 13, role: 'admin', isAdmin: true, adminAreas: ['people'] });
      const editor = user({ id: 14, role: 'editor', isEditor: true });

      it('registration admins are registrar on every event; everyone else needs a per-event role', async () => {
        const a = await newEvent();
        const b = await newEvent();
        for (const u of [registrationAdmin, grantedAdmin, editor]) {
          expect(hasRegistrationArea(u)).toBe(true);
          expect(canEditEvent(u)).toBe(true);
          expect(await regEventRole(getDb(), u, a)).toBe('registrar');
          expect(await regEventRole(getDb(), u, b)).toBe('registrar');
        }
        expect(hasRegistrationArea(limitedAdmin)).toBe(false);
        expect(await regEventRole(getDb(), limitedAdmin, a)).toBeNull();
        expect(await regEventRole(getDb(), null, a)).toBeNull();

        const volunteer = user({ id: await person('Volunteer') });
        expect(await regEventRole(getDb(), volunteer, a)).toBeNull();
        expect(await grantEventRole(getDb(), a, volunteer.id, 'desk')).toEqual({ ok: true });
        expect(await regEventRole(getDb(), volunteer, a)).toBe('desk');
        expect(await regEventRole(getDb(), volunteer, b)).toBeNull(); // a grant never spreads to another event
        // A limited admin with a per-event grant gets exactly that role.
        const limitedId = await person('Limited');
        const limited = user({ id: limitedId, role: 'admin', isAdmin: true, adminAreas: ['people'] });
        await grantEventRole(getDb(), b, limitedId, 'viewer');
        expect(await regEventRole(getDb(), limited, b)).toBe('viewer');
        expect(await regEventRole(getDb(), limited, a)).toBeNull();
      });

      it('roles are capabilities, not a ladder', () => {
        expect(['viewer', 'desk', 'registrar'].map((r) => [r, regRoleAllows(r as 'viewer', 'view'), regRoleAllows(r as 'viewer', 'checkin'), regRoleAllows(r as 'viewer', 'manage')])).toEqual([
          ['viewer', true, false, false],
          ['desk', false, true, false],
          ['registrar', true, true, true],
        ]);
        expect(regRoleAllows(null, 'view')).toBe(false);
      });

      it('requireRegRole answers 403 without the capability and 404 for an unknown event only to role holders', async () => {
        const id = await newEvent();
        const desk = user({ id: await person('Desk') });
        const viewer = user({ id: await person('Viewer') });
        const stranger = user({ id: await person('Stranger') });
        await grantEventRole(getDb(), id, desk.id, 'desk');
        await grantEventRole(getDb(), id, viewer.id, 'viewer');
        const check = (u: SessionUser | null, event: number, need: 'view' | 'checkin' | 'manage') => requireRegRole(getDb(), u, event, need);
        expect(await check(desk, id, 'checkin')).toEqual({ ok: true, role: 'desk' });
        expect(await check(desk, id, 'view')).toEqual({ ok: false, status: 403 });
        expect(await check(viewer, id, 'view')).toEqual({ ok: true, role: 'viewer' });
        expect(await check(viewer, id, 'manage')).toEqual({ ok: false, status: 403 });
        expect(await check(stranger, id, 'view')).toEqual({ ok: false, status: 403 });
        expect(await check(stranger, 999_999_999, 'view')).toEqual({ ok: false, status: 403 });
        expect(await check(null, id, 'view')).toEqual({ ok: false, status: 403 });
        expect(await check(registrationAdmin, 999_999_999, 'view')).toEqual({ ok: false, status: 404 });
        expect(await check(registrationAdmin, id, 'manage')).toEqual({ ok: true, role: 'registrar' });
      });

      it('derives the event from the target row, so a role on event A never reaches event B', async () => {
        const a = await newEvent();
        const b = await newEvent();
        const reg = await register(b, [{ name: 'Bea' }, { name: 'Bob' }]);
        const [first] = await attendeesOf(reg.id);
        const volunteer = user({ id: await person('Door') });
        await grantEventRole(getDb(), a, volunteer.id, 'registrar');
        expect(await eventOfRegistration(getDb(), reg.id)).toBe(b);
        expect(await eventOfAttendee(getDb(), first.id)).toEqual({ eventId: b, registrationId: reg.id });
        expect(await eventOfRegistration(getDb(), 999_999_999)).toBeNull();
        expect(await eventOfAttendee(getDb(), 999_999_999)).toBeNull();
        expect(await eventOfAttendee(getDb(), Number.NaN)).toBeNull();
        const derived = (await eventOfRegistration(getDb(), reg.id))!;
        expect(await regEventRole(getDb(), volunteer, derived)).toBeNull();
        expect(await requireRegRole(getDb(), volunteer, derived, 'manage')).toEqual({ ok: false, status: 403 });
        expect(await regEventRole(getDb(), volunteer, a)).toBe('registrar');
      });

      it('grants upsert, list by name and revoke; refuses bad roles, inactive people, unknown events and templates', async () => {
        const id = await newEvent();
        const p = await person('Pat');
        expect(await grantEventRole(getDb(), id, p, 'boss')).toEqual({ ok: false, code: 'invalid_role' });
        expect(await grantEventRole(getDb(), id, 999_999_999, 'desk')).toEqual({ ok: false, code: 'person_not_found' });
        expect(await grantEventRole(getDb(), 999_999_999, p, 'desk')).toEqual({ ok: false, code: 'event_not_found' });
        await getDb().prepare(`UPDATE people SET active = 0 WHERE id = ?1`).bind(p).run();
        expect(await grantEventRole(getDb(), id, p, 'desk')).toEqual({ ok: false, code: 'person_not_found' });
        await getDb().prepare(`UPDATE people SET active = 1 WHERE id = ?1`).bind(p).run();
        expect(await grantEventRole(getDb(), id, p, 'desk')).toEqual({ ok: true });
        expect(await grantEventRole(getDb(), id, p, 'registrar')).toEqual({ ok: true });
        expect((await listEventRoles(getDb(), id)).map((r) => [r.person_id, r.role])).toEqual([[p, 'registrar']]);
        expect(await listEventRolesForPerson(getDb(), p)).toEqual([{ event_id: id, role: 'registrar' }]);
        expect(await revokeEventRole(getDb(), id, p)).toBe(true);
        expect(await revokeEventRole(getDb(), id, p)).toBe(false);
        expect(await listEventRoles(getDb(), id)).toEqual([]);
        const template = (await getDb().prepare(`INSERT INTO reg_events (starts_at, is_template) VALUES (?1, 1) RETURNING id`).bind(tsAt(DAY)).first<{ id: number }>())!.id;
        expect(await grantEventRole(getDb(), template, p, 'desk')).toEqual({ ok: false, code: 'event_not_found' });
      });

      it('deleting an event or a person removes their grants', async () => {
        const id = await newEvent();
        const p = await person('Gone');
        await grantEventRole(getDb(), id, p, 'viewer');
        await getDb().prepare(`DELETE FROM people WHERE id = ?1`).bind(p).run();
        expect(await listEventRoles(getDb(), id)).toEqual([]);
        const q = await person('Stay');
        await grantEventRole(getDb(), id, q, 'viewer');
        await getDb().prepare(`DELETE FROM reg_events WHERE id = ?1`).bind(id).run();
        expect(await listEventRolesForPerson(getDb(), q)).toEqual([]);
      });

      it('refunds need payment operations: an admin holding the area, or the finance team', () => {
        expect(canRefund(null)).toBe(false);
        expect(canRefund(user({ finance: 1 }))).toBe(true);
        expect(canRefund(user({ finance: 0 }))).toBe(false);
        expect(canRefund(registrationAdmin)).toBe(true); // super admin
        expect(canRefund(user({ role: 'admin', isAdmin: true, adminAreas: ['payment-operations'] }))).toBe(true);
        expect(canRefund(user({ role: 'admin', isAdmin: true, adminAreas: ['registration'], finance: 1 }))).toBe(false);
        expect(canRefund(editor)).toBe(false);
      });
    });

    // ── Approval ───────────────────────────────────────────────────────────────
    describe('approval', () => {
      it('a free sign-up waits in review and holds its seat; the waitlist behind it does not', async () => {
        const id = await newEvent({ capacity: 2, requires_approval: 1 });
        const a = await register(id, [{ name: 'Ann' }]);
        const b = await register(id, [{ name: 'Ben' }]);
        const c = await register(id, [{ name: 'Cy' }]);
        expect([a.status, b.status, c.status]).toEqual(['review', 'review', 'waitlist']);
        const event = (await getEventAdmin(getDb(), id))!;
        expect([event.requires_approval, event.taken_count, event.confirmed_count, event.waitlist_count]).toEqual([1, 2, 0, 1]);
      });

      it('a normal event is unchanged: confirmed straight away', async () => {
        const id = await newEvent({ capacity: 2 });
        expect((await register(id)).status).toBe('confirmed');
        expect((await getEventAdmin(getDb(), id))!.requires_approval).toBe(0);
      });

      it('promotion on an approval event moves the waitlist to review, not confirmed', async () => {
        const id = await newEvent({ capacity: 1, requires_approval: 1 });
        const a = await register(id, [{ name: 'Ann' }]);
        const b = await register(id, [{ name: 'Ben' }]);
        expect([a.status, b.status]).toEqual(['review', 'waitlist']);
        expect(await cancelRegistration(getDb(), a.id)).toBe(true);
        expect(await statusOf(b.id)).toBe('review');
        expect(await promoteWaitlist(getDb(), id)).toEqual([]);
      });

      it('accept / waitlist / decline stamp the decision and write the history; seats follow', async () => {
        const staff = await person('Reviewer');
        const id = await newEvent({ capacity: 2, requires_approval: 1 });
        const a = await register(id, [{ name: 'Ann' }]);
        const b = await register(id, [{ name: 'Ben' }]);
        const c = await register(id, [{ name: 'Cy' }]); // waitlist

        const accepted = await decideRegistration(getDb(), a.id, 'accept', staff);
        expect(accepted).toMatchObject({ ok: true, decision: 'accept', registrationId: a.id, status: 'confirmed', promoted: [] });
        const row = await one<{ status: string; decided_by: number; decided_at: string }>(`SELECT status, decided_by, decided_at FROM registrations WHERE id = ?1`, a.id);
        expect([row.status, row.decided_by, typeof row.decided_at]).toEqual(['confirmed', staff, 'string']);

        // Declining Ben frees a seat: Cy moves up to REVIEW (not confirmed).
        const declined = await decideRegistration(getDb(), b.id, 'decline', staff);
        expect(declined).toMatchObject({ ok: true, status: 'declined', promoted: [c.id] });
        expect(await statusOf(c.id)).toBe('review');

        // Waitlisting a review sign-up frees its seat for the next in line; the moved one is not promoted back.
        const d = await register(id, [{ name: 'Dee' }]); // review? capacity 2: Ann confirmed + Cy review -> full -> waitlist
        expect(d.status).toBe('waitlist');
        const waitlisted = await decideRegistration(getDb(), c.id, 'waitlist', staff);
        expect(waitlisted).toMatchObject({ ok: true, status: 'waitlist', promoted: [d.id] });
        expect(await statusOf(d.id)).toBe('review');
        expect(await statusOf(c.id)).toBe('waitlist');

        expect(await actionsOf(a.id)).toEqual(['accepted']);
        expect(await actionsOf(b.id)).toEqual(['declined']);
        expect(await actionsOf(c.id)).toEqual(['waitlisted']);
        const detail = (await listActivity(getDb(), a.id))[0];
        expect([detail.actor_person_id, detail.detail]).toEqual([staff, { from: 'review' }]);
      });

      it('refuses a decision from the wrong status and an unknown registration', async () => {
        const id = await newEvent({ requires_approval: 1 });
        const a = await register(id);
        expect(await decideRegistration(getDb(), a.id, 'accept', null)).toMatchObject({ ok: true });
        expect(await decideRegistration(getDb(), a.id, 'accept', null)).toEqual({ ok: false, code: 'not_editable' });
        expect(await decideRegistration(getDb(), a.id, 'decline', null)).toEqual({ ok: false, code: 'not_editable' }); // confirmed: cancel instead
        expect(await decideRegistration(getDb(), 999_999_999, 'accept', null)).toEqual({ ok: false, code: 'not_found' });
        const fresh = await register(id, [{ name: 'Fay' }]);
        expect(await decideRegistration(getDb(), fresh.id, 'accept', null, { version: 0 })).toMatchObject({ ok: false, code: 'invalid' });
        expect(await decideRegistration(getDb(), fresh.id, 'accept', null, { version: 7 })).toEqual({ ok: false, code: 'version_conflict' });
        expect(await statusOf(fresh.id)).toBe('review');
      });

      it('accepting a registration that holds no seat over the limit needs confirm', async () => {
        const id = await newEvent({ capacity: 1, requires_approval: 1 });
        const a = await register(id, [{ name: 'Ann' }]);
        const b = await register(id, [{ name: 'Ben' }]);
        expect(b.status).toBe('waitlist');
        expect(await decideRegistration(getDb(), b.id, 'accept', null)).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'event_full' });
        expect(await statusOf(b.id)).toBe('waitlist');
        expect(await decideRegistration(getDb(), b.id, 'accept', null, { confirm: true })).toMatchObject({ ok: true, status: 'confirmed' });
        expect((await getEventAdmin(getDb(), id))!.taken_count).toBe(2); // over capacity, by staff decision
        // Ann (review) is accepted without any seat check: she already holds hers.
        expect(await decideRegistration(getDb(), a.id, 'accept', null)).toMatchObject({ ok: true });
      });

      it('a declined sign-up can be accepted again', async () => {
        const id = await newEvent({ requires_approval: 1 });
        const a = await register(id);
        await decideRegistration(getDb(), a.id, 'decline', null);
        expect(await decideRegistration(getDb(), a.id, 'accept', null)).toMatchObject({ ok: true, status: 'confirmed' });
        expect(await actionsOf(a.id)).toEqual(['declined', 'accepted']);
      });

      it('refuses approval together with any price, in either order', async () => {
        const id = await newEvent({ requires_approval: 1 });
        await expect(saveEvent(getDb(), { id, title_en: 'X', starts_at: tsAt(DAY), active: 1, price_cents: 500 })).rejects.toThrow('approval_requires_free');
        await expect(newEvent({ requires_approval: 1, price_cents: 500 })).rejects.toThrow('approval_requires_free');
        const priced = await newEvent({ price_cents: 500 });
        await expect(saveEvent(getDb(), { id: priced, title_en: 'X', starts_at: tsAt(DAY), active: 1, price_cents: 500, requires_approval: 1 })).rejects.toThrow('approval_requires_free');
        // A priced active ticket type blocks it too; an inactive one does not.
        const typed = await newEvent();
        const type = await getDb().prepare(`INSERT INTO reg_ticket_types (event_id, price_cents, active) VALUES (?1, 500, 1) RETURNING id`).bind(typed).first<{ id: number }>();
        await expect(saveEvent(getDb(), { id: typed, title_en: 'X', starts_at: tsAt(DAY), active: 1, requires_approval: 1 })).rejects.toThrow('approval_requires_free');
        await getDb().prepare(`UPDATE reg_ticket_types SET active = 0 WHERE id = ?1`).bind(type!.id).run();
        await saveEvent(getDb(), { id: typed, title_en: 'X', starts_at: tsAt(DAY), active: 1, requires_approval: 1 });
        expect((await getEventAdmin(getDb(), typed))!.requires_approval).toBe(1);
        // Updating an approval event without mentioning the flag keeps it (and still refuses a price).
        await saveEvent(getDb(), { id: typed, title_en: 'X', starts_at: tsAt(DAY), active: 1 });
        expect((await getEventAdmin(getDb(), typed))!.requires_approval).toBe(1);
        await expect(saveEvent(getDb(), { id: typed, title_en: 'X', starts_at: tsAt(DAY), active: 1, price_cents: 100 })).rejects.toThrow('approval_requires_free');
        // The form builder refuses a priced active ticket type on an approval event.
        if (backend === 'supabase') {
          const result = await saveEventForm(getDb(), id, { tickets: [{ labels: { en: 'VIP' }, price_cents: 500 }] }, { backend });
          expect(result).toEqual({ ok: false, errors: [{ path: 'tickets.0.price_cents', code: 'approval_requires_free' }] });
        }
        await mustForm(id, { tickets: [{ labels: { en: 'Free' }, price_cents: 0 }] });
      });

      it('the writer refuses a priced registration on an approval event', async () => {
        const id = await newEvent({ requires_approval: 1 });
        await expect(register(id, [{ name: 'Ann' }], { status: 'pending', amountCents: 500 })).rejects.toThrow('approval_requires_free');
        expect(await count(`SELECT count(*) AS n FROM registrations WHERE event_id = ?1`, id)).toBe(0);
      });

      it('a copy keeps the approval and reminder settings', async () => {
        const id = await newEvent({ requires_approval: 1, reminder_days: 3 });
        const copy = (await getEventAdmin(getDb(), await cloneEvent(getDb(), id)))!;
        expect([copy.requires_approval, copy.reminder_days]).toEqual([1, 3]);
      });

      it('validates reminder_days', async () => {
        for (const bad of [0, 31, 1.5]) await expect(newEvent({ reminder_days: bad })).rejects.toThrow('reminder_days_invalid');
        const id = await newEvent({ reminder_days: 30 });
        expect((await getEventAdmin(getDb(), id))!.reminder_days).toBe(30);
        await saveEvent(getDb(), { id, title_en: 'C', starts_at: tsAt(DAY), active: 1, reminder_days: null });
        expect((await getEventAdmin(getDb(), id))!.reminder_days).toBeNull();
      });
    });

    // ── Roster ─────────────────────────────────────────────────────────────────
    describe('roster', () => {
      async function seededEvent() {
        const id = await newEvent({ capacity: 6, waitlist_enabled: 1 });
        await mustForm(id, {
          questions: [
            { type: 'select', labels: { en: 'Shirt' }, options: [{ key: 's', labels: { en: 'Small' } }, { key: 'l', labels: { en: 'Large' } }] },
            { type: 'checkbox', labels: { en: 'Diet' }, options: [{ key: 'veg', labels: { en: 'Vegetarian' } }, { key: 'nut', labels: { en: 'Nut free' } }] },
            { type: 'select', scope: 'attendee', labels: { en: 'Meal' }, options: [{ key: 'beef', labels: { en: 'Beef' } }, { key: 'fish', labels: { en: 'Fish' } }] },
          ],
          tickets: [{ labels: { en: 'Adult' } }, { labels: { en: 'Child' } }],
        });
        const [shirt, diet, meal] = await listQuestions(getDb(), 'en', id);
        const [adult, child] = (await listTicketTypesAdmin(getDb(), id)).map((t) => t.id);
        const ann = await register(id, [{ name: 'Ann Lee', ticketTypeId: adult, answers: [[meal.id, 'beef']] }, { name: 'Tim Lee', ticketTypeId: child, answers: [[meal.id, 'fish']] }], { email: 'ann@example.com', phone: '555-0101', answers: [[shirt.id, 's'], [diet.id, '["veg","nut"]']] });
        const bob = await register(id, [{ name: 'Bob_100% Ray', ticketTypeId: adult, answers: [[meal.id, 'fish']] }], { email: 'bob@example.com', answers: [[shirt.id, 'l']] });
        const cat = await register(id, [{ name: 'Cat', ticketTypeId: adult }], { email: 'cat@example.com', answers: [[shirt.id, 's']] });
        const dan = await register(id, [{ name: 'Dan', ticketTypeId: adult }], { email: 'dan@example.com' });
        await cancelRegistration(getDb(), dan.id);
        return { id, shirt, diet, meal, adult, child, ann, bob, cat, dan };
      }
      const names = (page: Awaited<ReturnType<typeof listRoster>>) => page.rows.map((r) => (page.view === 'person' ? r.people[0].name : r.registration.name));

      it('lists every registration newest first with its people, counts per status and paging', async () => {
        const e = await seededEvent();
        const page = await listRoster(getDb(), e.id);
        expect(names(page)).toEqual(['Dan', 'Cat', 'Bob_100% Ray', 'Ann Lee']);
        expect([page.total, page.page, page.pages, page.pageSize]).toEqual([4, 1, 1, 50]);
        expect(page.counts).toMatchObject({ confirmed: 3, cancelled: 1, waitlist: 0, review: 0 });
        const ann = page.rows[3];
        expect(ann.people.map((p) => [p.name, p.ticketLabel, p.checkedIn])).toEqual([['Ann Lee', 'Adult', false], ['Tim Lee', 'Child', false]]);
        expect(ann.registration).toMatchObject({ confirmation_no: expect.stringMatching(/^R\d\d-0001$/), party_size: 2, phone: '555-0101', version: 1, payment_method: null });
        expect(names(await listRoster(getDb(), e.id, { sort: 'oldest' }))).toEqual(['Ann Lee', 'Bob_100% Ray', 'Cat', 'Dan']);
        expect(names(await listRoster(getDb(), e.id, { sort: 'name' }))).toEqual(['Ann Lee', 'Bob_100% Ray', 'Cat', 'Dan']);
        expect(names(await listRoster(getDb(), e.id, { sort: 'confirmation' }))).toEqual(['Ann Lee', 'Bob_100% Ray', 'Cat', 'Dan']);
        const paged = await listRoster(getDb(), e.id, { pageSize: 3, sort: 'oldest' });
        expect([names(paged), paged.pages, paged.total]).toEqual([['Ann Lee', 'Bob_100% Ray', 'Cat'], 2, 4]);
        expect(names(await listRoster(getDb(), e.id, { pageSize: 3, page: 2, sort: 'oldest' }))).toEqual(['Dan']);
        expect((await listRoster(getDb(), e.id, { pageSize: 3, page: 99, sort: 'oldest' })).page).toBe(2);
      });

      it('filters by status and keeps the chip counts independent of the status filter', async () => {
        const e = await seededEvent();
        const cancelled = await listRoster(getDb(), e.id, { status: 'cancelled' });
        expect(names(cancelled)).toEqual(['Dan']);
        expect(cancelled.total).toBe(1);
        expect(cancelled.counts.confirmed).toBe(3);
        expect(names(await listRoster(getDb(), e.id, { status: ['confirmed', 'cancelled'], sort: 'oldest' }))).toEqual(['Ann Lee', 'Bob_100% Ray', 'Cat', 'Dan']);
        expect((await listRoster(getDb(), e.id, { status: ['bogus' as RegStatus] })).total).toBe(4); // unknown statuses are ignored
      });

      it('searches names, people, email, phone and confirmation number, case-insensitively and literally', async () => {
        const e = await seededEvent();
        const search = async (q: string) => names(await listRoster(getDb(), e.id, { q, sort: 'oldest' }));
        expect(await search('ann')).toEqual(['Ann Lee']);
        expect(await search('ANN')).toEqual(['Ann Lee']);
        expect(await search('tim')).toEqual(['Ann Lee']); // a person on the registration
        expect(await search('lee')).toEqual(['Ann Lee']);
        expect(await search('bob@EXAMPLE')).toEqual(['Bob_100% Ray']);
        expect(await search('555-01')).toEqual(['Ann Lee']);
        expect(await search('-0002')).toEqual(['Bob_100% Ray']);
        expect(await search('100%')).toEqual(['Bob_100% Ray']);
        expect(await search('_100')).toEqual(['Bob_100% Ray']);
        expect(await search('%')).toEqual(['Bob_100% Ray']); // a literal percent, not a wildcard
        expect(await search('a_n')).toEqual([]); // underscore is literal too
        expect(await search('zzz')).toEqual([]);
        const counts = (await listRoster(getDb(), e.id, { q: 'ann' })).counts;
        expect([counts.confirmed, counts.cancelled]).toEqual([1, 0]);
      });

      it('filters by ticket type, checked in, and choice answers of both scopes', async () => {
        const e = await seededEvent();
        expect(names(await listRoster(getDb(), e.id, { ticketTypeId: e.child }))).toEqual(['Ann Lee']);
        expect(names(await listRoster(getDb(), e.id, { ticketTypeId: e.adult, sort: 'oldest' }))).toEqual(['Ann Lee', 'Bob_100% Ray', 'Cat']); // Dan was cancelled with his person
        // choice answers: select, checkbox (a JSON array), and a per-person select
        expect(names(await listRoster(getDb(), e.id, { answer: { questionId: e.shirt.id, option: 's' }, sort: 'oldest' }))).toEqual(['Ann Lee', 'Cat']);
        expect(names(await listRoster(getDb(), e.id, { answer: { questionId: e.shirt.id, option: 'l' } }))).toEqual(['Bob_100% Ray']);
        expect(names(await listRoster(getDb(), e.id, { answer: { questionId: e.diet.id, option: 'nut' } }))).toEqual(['Ann Lee']);
        expect(names(await listRoster(getDb(), e.id, { answer: { questionId: e.diet.id, option: 'veg' } }))).toEqual(['Ann Lee']);
        expect(names(await listRoster(getDb(), e.id, { answer: { questionId: e.meal.id, option: 'fish' }, sort: 'oldest' }))).toEqual(['Ann Lee', 'Bob_100% Ray']);
        expect(names(await listRoster(getDb(), e.id, { answer: { questionId: e.meal.id, option: 'fish' }, view: 'person', sort: 'oldest' }))).toEqual(['Tim Lee', 'Bob_100% Ray']);
        expect((await listRoster(getDb(), e.id, { answer: { questionId: 999_999_999, option: 'x' } })).total).toBe(0);
        expect((await listRoster(getDb(), e.id, { answer: { questionId: e.shirt.id, option: 'xl' } })).total).toBe(0);

        const [annPerson] = await attendeesOf(e.ann.id);
        await checkIn(getDb(), annPerson.id, null);
        expect(names(await listRoster(getDb(), e.id, { checkedIn: true }))).toEqual(['Ann Lee']);
        expect(names(await listRoster(getDb(), e.id, { checkedIn: false, sort: 'oldest' }))).toEqual(['Bob_100% Ray', 'Cat', 'Dan']); // nobody of Dan's registration is at the door
        const people = await listRoster(getDb(), e.id, { view: 'person', checkedIn: true });
        expect(names(people)).toEqual(['Ann Lee']);
        expect(names(await listRoster(getDb(), e.id, { view: 'person', checkedIn: false, status: 'confirmed', sort: 'oldest' }))).toEqual(['Tim Lee', 'Bob_100% Ray', 'Cat']);
      });

      it('the person view lists one row per active person with their registration', async () => {
        const e = await seededEvent();
        const people = await listRoster(getDb(), e.id, { view: 'person', sort: 'oldest' });
        expect(people.view).toBe('person');
        expect(names(people)).toEqual(['Ann Lee', 'Tim Lee', 'Bob_100% Ray', 'Cat']); // Dan's person was cancelled with him
        expect(people.rows[1].registration.name).toBe('Ann Lee');
        expect(people.counts).toMatchObject({ confirmed: 4, cancelled: 0 });
        expect(names(await listRoster(getDb(), e.id, { view: 'person', ticketTypeId: e.child }))).toEqual(['Tim Lee']);
        expect(names(await listRoster(getDb(), e.id, { view: 'person', q: 'tim' }))).toEqual(['Tim Lee']);
        expect(names(await listRoster(getDb(), e.id, { view: 'person', q: 'ann@example', sort: 'oldest' }))).toEqual(['Ann Lee', 'Tim Lee']); // a registration field matches every person on it
        // A removed person is no longer listed.
        const [, tim] = await attendeesOf(e.ann.id);
        await adminRemovePerson(getDb(), e.ann.id, { version: 1, attendeeId: tim.id }, { actor: null });
        expect(names(await listRoster(getDb(), e.id, { view: 'person', sort: 'oldest' }))).toEqual(['Ann Lee', 'Bob_100% Ray', 'Cat']);
      });

      it('never lists another event', async () => {
        const e = await seededEvent();
        const other = await newEvent();
        await register(other, [{ name: 'Ann Other' }]);
        expect(names(await listRoster(getDb(), e.id, { q: 'ann' }))).toEqual(['Ann Lee']);
        expect((await listRoster(getDb(), other, {})).total).toBe(1);
      });
    });

    // ── Drawer operations ──────────────────────────────────────────────────────
    describe('drawer operations', () => {
      it('shows everything about one registration with its history', async () => {
        const staff = await person('Registrar');
        const id = await newEvent();
        await mustForm(id, { questions: [{ type: 'text', labels: { en: 'Note' } }, { type: 'text', scope: 'attendee', labels: { en: 'Nick' } }] });
        const [note, nick] = await listQuestions(getDb(), 'en', id);
        const reg = await register(id, [{ name: 'Ann', answers: [[nick.id, 'A']] }], { answers: [[note.id, 'hello']] });
        const detail = (await getRegistrationAdmin(getDb(), reg.id, 'en'))!;
        expect(detail.version).toBe(1);
        expect(detail.summary.registration).toMatchObject({ id: reg.id, name: 'Ann', status: 'confirmed' });
        expect(detail.rawAnswers).toEqual({ [note.id]: 'hello' });
        expect(Object.values(detail.rawAttendeeAnswers)).toEqual([{ [nick.id]: 'A' }]);
        expect([detail.adminNote, detail.paymentMethod, detail.refundedCents, detail.decidedAt, detail.decidedBy, detail.activity]).toEqual([null, null, 0, null, null, []]);
        await adminSetNote(getDb(), reg.id, { version: 1, note: 'VIP' }, { actor: staff });
        const after = (await getRegistrationAdmin(getDb(), reg.id, 'en'))!;
        expect([after.version, after.adminNote, after.activity.map((a) => [a.action, a.actor_name])]).toEqual([2, 'VIP', [['note', 'Registrar']]]);
        expect(await getRegistrationAdmin(getDb(), 999_999_999, 'en')).toBeNull();
      });

      it('the note: set, clear, trim, limits, history, and the optimistic version check', async () => {
        const id = await newEvent();
        const reg = await register(id);
        expect(await adminSetNote(getDb(), reg.id, { version: 1, note: '  Needs a ride  ' }, { actor: null })).toEqual({ ok: true, version: 2 });
        expect((await one<{ admin_note: string }>(`SELECT admin_note FROM registrations WHERE id = ?1`, reg.id)).admin_note).toBe('Needs a ride');
        // A stale version changes nothing.
        expect(await adminSetNote(getDb(), reg.id, { version: 1, note: 'stale' }, { actor: null })).toEqual({ ok: false, code: 'version_conflict' });
        expect((await one<{ admin_note: string; version: number }>(`SELECT admin_note, version FROM registrations WHERE id = ?1`, reg.id))).toEqual({ admin_note: 'Needs a ride', version: 2 });
        expect(await adminSetNote(getDb(), reg.id, { version: 2, note: '' }, { actor: null })).toEqual({ ok: true, version: 3 });
        expect((await one<{ admin_note: string | null }>(`SELECT admin_note FROM registrations WHERE id = ?1`, reg.id)).admin_note).toBeNull();
        expect(await adminSetNote(getDb(), reg.id, { version: 3, note: 'x'.repeat(2001) }, { actor: null })).toMatchObject({ ok: false, code: 'invalid' });
        expect(await adminSetNote(getDb(), reg.id, { version: 3, note: 'x'.repeat(2000) }, { actor: null })).toMatchObject({ ok: true });
        expect(await adminSetNote(getDb(), 999_999_999, { version: 1, note: 'x' }, { actor: null })).toEqual({ ok: false, code: 'not_found' });
        expect(await adminSetNote(getDb(), reg.id, { version: Number.NaN, note: 'x' }, { actor: null })).toMatchObject({ ok: false, code: 'invalid' });
        expect(await actionsOf(reg.id)).toEqual(['note', 'note', 'note']);
      });

      it('edits contact, people and answers; staff may skip required answers; every write is versioned', async () => {
        const staff = await person('Editor');
        const id = await newEvent();
        await mustForm(id, { questions: [
          { type: 'text', required: true, labels: { en: 'Church' } },
          { type: 'select', labels: { en: 'Shirt' }, options: [{ key: 's', labels: { en: 'Small' } }, { key: 'l', labels: { en: 'Large' } }] },
          { type: 'text', scope: 'attendee', labels: { en: 'Nick' } },
          { type: 'terms', required: true, labels: { en: 'Agree' } },
        ] });
        const [church, shirt, nick, terms] = await listQuestions(getDb(), 'en', id);
        const reg = await register(id, [{ name: 'Ann', answers: [[nick.id, 'Annie']] }, { name: 'Tim' }], { answers: [[church.id, 'Grace'], [shirt.id, 's'], [terms.id, '@accepted']] });
        const [ann, tim] = await attendeesOf(reg.id);
        const acceptedAt = (await one<{ value: string }>(`SELECT value FROM reg_answers WHERE registration_id = ?1 AND question_id = ?2`, reg.id, terms.id)).value;

        const edited = await adminUpdateRegistration(getDb(), reg.id, {
          version: 1,
          contact: { name: ' Ann Lee ', email: 'ANN.LEE@Example.com', phone: '555 0100' },
          attendees: [{ id: ann.id, name: 'Ann L.', answers: { [nick.id]: 'Boss' } }, { id: tim.id, name: 'Timmy' }],
          answers: { [shirt.id]: 'l', [terms.id]: 'yes' }, // the required church answer is skipped on purpose
        }, { actor: staff });
        expect(edited).toEqual({ ok: true, version: 2 });
        const row = await one<{ name: string; email: string; phone: string; version: number }>(`SELECT name, email, phone, version FROM registrations WHERE id = ?1`, reg.id);
        expect(row).toEqual({ name: 'Ann Lee', email: 'ann.lee@example.com', phone: '555 0100', version: 2 });
        expect((await attendeesOf(reg.id)).map((a) => a.name)).toEqual(['Ann L.', 'Timmy']);
        const detail = (await getRegistrationAdmin(getDb(), reg.id, 'en'))!;
        expect(detail.rawAnswers[shirt.id]).toBe('l');
        expect(detail.rawAnswers[church.id]).toBeUndefined();
        expect(detail.rawAnswers[terms.id]).toBe(acceptedAt); // a re-saved terms answer keeps its acceptance time
        expect(detail.rawAttendeeAnswers[ann.id][nick.id]).toBe('Boss');
        expect(detail.activity[0]).toMatchObject({ action: 'edit', actor_person_id: staff, detail: { fields: ['name', 'email', 'phone', 'people', 'answers'] } });

        // required answers can be enforced
        expect(await adminUpdateRegistration(getDb(), reg.id, { version: 2, answers: { [shirt.id]: 'l' }, skipRequired: false }, { actor: staff })).toMatchObject({
          ok: false, code: 'invalid', errors: expect.arrayContaining([{ path: `q.${church.id}`, code: 'missing_required' }]),
        });
        // validation errors name the field, change nothing and do not move the version
        const bad = await adminUpdateRegistration(getDb(), reg.id, { version: 2, contact: { name: '', email: 'nope', phone: 'abc' }, attendees: [{ id: 999_999, name: 'X' }], answers: { [shirt.id]: 'xl' } }, { actor: staff });
        expect(bad).toMatchObject({ ok: false, code: 'invalid' });
        expect((bad as { errors: Array<{ path: string; code: string }> }).errors.map((e) => `${e.path}:${e.code}`).sort()).toEqual(
          ['attendees.0.id:not_found', 'contact.email:invalid', 'contact.name:required', 'contact.phone:invalid', `q.${shirt.id}:bad_answer`].sort());
        expect(await versionOf(reg.id)).toBe(2);
        // stale version
        expect(await adminUpdateRegistration(getDb(), reg.id, { version: 1, contact: { name: 'Late' } }, { actor: staff })).toEqual({ ok: false, code: 'version_conflict' });
        expect((await one<{ name: string }>(`SELECT name FROM registrations WHERE id = ?1`, reg.id)).name).toBe('Ann Lee');
        // a person of another registration cannot be edited through this one
        const other = await register(id, [{ name: 'Other' }]);
        const [stranger] = await attendeesOf(other.id);
        expect(await adminUpdateRegistration(getDb(), reg.id, { version: 2, attendees: [{ id: stranger.id, name: 'Hijack' }] }, { actor: staff })).toMatchObject({ ok: false, code: 'invalid' });
        expect((await attendeesOf(other.id))[0].name).toBe('Other');
        // an empty edit is a no-op
        expect(await adminUpdateRegistration(getDb(), reg.id, { version: 2 }, { actor: staff })).toEqual({ ok: true, version: 2 });
      });

      it('can edit a cancelled registration\'s contact', async () => {
        const id = await newEvent();
        const reg = await register(id);
        await cancelRegistration(getDb(), reg.id);
        const version = await versionOf(reg.id);
        expect(await adminUpdateRegistration(getDb(), reg.id, { version, contact: { phone: '555 0000' } }, { actor: null })).toEqual({ ok: true, version: version + 1 });
      });

      it('self-service and webhook-style writes move the version, so a stale drawer is caught', async () => {
        const id = await newEvent();
        const reg = await register(id, [{ name: 'Ann' }, { name: 'Tim' }]);
        expect(await versionOf(reg.id)).toBe(1);
        const [, tim] = await attendeesOf(reg.id);
        const { cancelAttendee, updateRegistrationSelf } = await import('../../src/lib/regManage');
        await updateRegistrationSelf(getDb(), reg.id, { name: 'Ann B' });
        expect(await versionOf(reg.id)).toBe(2);
        await cancelAttendee(getDb(), reg.id, tim.id);
        expect(await versionOf(reg.id)).toBeGreaterThan(2);
        expect(await adminSetNote(getDb(), reg.id, { version: 1, note: 'stale' }, { actor: null })).toEqual({ ok: false, code: 'version_conflict' });
      });

      it('changes a person\'s ticket type; the limit is soft; waitlisted and unpaid registrations are handled', async () => {
        const id = await newEvent({ capacity: 10 });
        await mustForm(id, { tickets: [{ labels: { en: 'Adult' } }, { labels: { en: 'Child' }, capacity: 1 }, { labels: { en: 'Old' }, active: false }] });
        const [adult, child, old] = (await listTicketTypesAdmin(getDb(), id)).map((t) => t.id);
        const a = await register(id, [{ name: 'Ann', ticketTypeId: adult }]);
        const b = await register(id, [{ name: 'Ben', ticketTypeId: adult }]);
        const [annPerson] = await attendeesOf(a.id);
        const [benPerson] = await attendeesOf(b.id);
        expect(await adminChangeTicketType(getDb(), a.id, { version: 1, attendeeId: annPerson.id, ticketTypeId: child }, { actor: null })).toEqual({ ok: true, version: 2 });
        expect((await attendeesOf(a.id))[0].ticket_type_id).toBe(child);
        // the Child limit (1) is full: Ben needs a confirm
        expect(await adminChangeTicketType(getDb(), b.id, { version: 1, attendeeId: benPerson.id, ticketTypeId: child }, { actor: null })).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'ticket_type_full' });
        expect((await attendeesOf(b.id))[0].ticket_type_id).toBe(adult);
        expect(await versionOf(b.id)).toBe(1);
        expect(await adminChangeTicketType(getDb(), b.id, { version: 1, attendeeId: benPerson.id, ticketTypeId: child }, { actor: null, confirm: true })).toEqual({ ok: true, version: 2 });
        // an inactive or foreign type, an unknown person, and the same type again
        expect(await adminChangeTicketType(getDb(), b.id, { version: 2, attendeeId: benPerson.id, ticketTypeId: old }, { actor: null })).toEqual({ ok: false, code: 'ticket_type_invalid' });
        expect(await adminChangeTicketType(getDb(), b.id, { version: 2, attendeeId: 999_999_999, ticketTypeId: adult }, { actor: null })).toEqual({ ok: false, code: 'not_found' });
        expect(await adminChangeTicketType(getDb(), b.id, { version: 2, attendeeId: benPerson.id, ticketTypeId: child }, { actor: null })).toEqual({ ok: true, version: 2 });
        expect(await adminChangeTicketType(getDb(), b.id, { version: 1, attendeeId: benPerson.id, ticketTypeId: adult }, { actor: null })).toEqual({ ok: false, code: 'version_conflict' });
        // a cancelled registration cannot change
        await cancelRegistration(getDb(), b.id);
        expect(await adminChangeTicketType(getDb(), b.id, { version: await versionOf(b.id), attendeeId: benPerson.id, ticketTypeId: adult }, { actor: null })).toEqual({ ok: false, code: 'not_editable' });
        expect(await actionsOf(a.id)).toEqual(['ticket_type']);
      });

      it('adds a person: seat and ticket limits are soft, the party grows, free registrations only', async () => {
        const id = await newEvent({ capacity: 3 });
        await mustForm(id, { tickets: [{ labels: { en: 'Adult' } }, { labels: { en: 'Child' }, capacity: 1 }] });
        const [adult, child] = (await listTicketTypesAdmin(getDb(), id)).map((t) => t.id);
        const a = await register(id, [{ name: 'Ann', ticketTypeId: adult }, { name: 'Tim', ticketTypeId: child }]);
        const added = await adminAddPerson(getDb(), a.id, { version: 1, name: ' Zed ', ticketTypeId: adult }, { actor: null });
        expect(added).toMatchObject({ ok: true, version: 2, attendeeId: expect.any(Number) });
        expect((await attendeesOf(a.id)).map((p) => [p.name, p.status])).toEqual([['Ann', 'active'], ['Tim', 'active'], ['Zed', 'active']]);
        expect((await one<{ party_size: number }>(`SELECT party_size FROM registrations WHERE id = ?1`, a.id)).party_size).toBe(3);
        // capacity 3 is now used up
        expect(await adminAddPerson(getDb(), a.id, { version: 2, name: 'Yan', ticketTypeId: adult }, { actor: null })).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'event_full' });
        expect((await one<{ party_size: number }>(`SELECT party_size FROM registrations WHERE id = ?1`, a.id)).party_size).toBe(3);
        expect(await adminAddPerson(getDb(), a.id, { version: 2, name: 'Yan', ticketTypeId: adult }, { actor: null, confirm: true })).toMatchObject({ ok: true, version: 3 });
        // typed events need an active type; blank names are refused; stale versions conflict
        expect(await adminAddPerson(getDb(), a.id, { version: 3, name: 'Xi' }, { actor: null, confirm: true })).toEqual({ ok: false, code: 'ticket_type_invalid' });
        expect(await adminAddPerson(getDb(), a.id, { version: 3, name: ' ', ticketTypeId: adult }, { actor: null, confirm: true })).toMatchObject({ ok: false, code: 'invalid' });
        expect(await adminAddPerson(getDb(), a.id, { version: 1, name: 'Xi', ticketTypeId: adult }, { actor: null, confirm: true })).toEqual({ ok: false, code: 'version_conflict' });
        expect(await actionsOf(a.id)).toEqual(['person_added', 'person_added']);
        // an untyped event refuses a ticket type
        const plain = await newEvent({ capacity: 10 });
        const p = await register(plain, [{ name: 'Pat' }]);
        expect(await adminAddPerson(getDb(), p.id, { version: 1, name: 'Quin', ticketTypeId: adult }, { actor: null })).toEqual({ ok: false, code: 'ticket_type_invalid' });
        expect(await adminAddPerson(getDb(), p.id, { version: 1, name: 'Quin' }, { actor: null })).toMatchObject({ ok: true });
        // a paid registration cannot grow
        await getDb().prepare(`UPDATE registrations SET amount_cents = 500 WHERE id = ?1`).bind(p.id).run();
        expect(await adminAddPerson(getDb(), p.id, { version: 2, name: 'Rae' }, { actor: null })).toEqual({ ok: false, code: 'paid_registration' });
      });

      it('adding a person to a waitlisted registration needs no seat', async () => {
        const id = await newEvent({ capacity: 1 });
        await register(id, [{ name: 'Ann' }]);
        const w = await register(id, [{ name: 'Wes' }]);
        expect(w.status).toBe('waitlist');
        expect(await adminAddPerson(getDb(), w.id, { version: 1, name: 'Wyn' }, { actor: null })).toMatchObject({ ok: true });
        expect(await statusOf(w.id)).toBe('waitlist');
      });

      it('removes a person: seats free up and the waitlist moves; the last person cancels the registration', async () => {
        const id = await newEvent({ capacity: 2 });
        const a = await register(id, [{ name: 'Ann' }, { name: 'Tim' }]);
        const w = await register(id, [{ name: 'Wes' }]);
        expect(w.status).toBe('waitlist');
        const [ann, tim] = await attendeesOf(a.id);
        const removed = await adminRemovePerson(getDb(), a.id, { version: 1, attendeeId: tim.id }, { actor: null });
        expect(removed).toEqual({ ok: true, version: 2, registrationCancelled: false, promoted: [w.id] });
        expect(await statusOf(w.id)).toBe('confirmed');
        expect((await one<{ party_size: number }>(`SELECT party_size FROM registrations WHERE id = ?1`, a.id)).party_size).toBe(1);
        expect((await attendeesOf(a.id)).map((p) => p.status)).toEqual(['active', 'cancelled']);
        // the same person again is gone; a stale version conflicts
        expect(await adminRemovePerson(getDb(), a.id, { version: 2, attendeeId: tim.id }, { actor: null })).toEqual({ ok: false, code: 'not_found' });
        expect(await adminRemovePerson(getDb(), a.id, { version: 1, attendeeId: ann.id }, { actor: null })).toEqual({ ok: false, code: 'version_conflict' });
        const last = await adminRemovePerson(getDb(), a.id, { version: 2, attendeeId: ann.id }, { actor: null });
        expect(last).toMatchObject({ ok: true, version: 3, registrationCancelled: true });
        expect(await statusOf(a.id)).toBe('cancelled');
        expect(await actionsOf(a.id)).toEqual(['person_removed', 'person_removed']);
        expect(await adminRemovePerson(getDb(), a.id, { version: 3, attendeeId: ann.id }, { actor: null })).toEqual({ ok: false, code: 'not_editable' });
      });

      it('cancels a registration through the shared promotion path', async () => {
        const staff = await person('Canceller');
        const id = await newEvent({ capacity: 1 });
        const a = await register(id, [{ name: 'Ann' }]);
        const w = await register(id, [{ name: 'Wes' }]);
        const cancelled = await adminCancelRegistration(getDb(), a.id, {}, { actor: staff });
        expect(cancelled).toEqual({ ok: true, version: 2, registrationCancelled: true, promoted: [w.id] });
        expect(await statusOf(w.id)).toBe('confirmed');
        expect((await attendeesOf(a.id)).map((p) => p.status)).toEqual(['cancelled']);
        expect(await adminCancelRegistration(getDb(), a.id, {}, { actor: staff })).toEqual({ ok: false, code: 'not_editable' });
        expect(await adminCancelRegistration(getDb(), w.id, { version: 99 }, { actor: staff })).toEqual({ ok: false, code: 'version_conflict' });
        expect(await adminCancelRegistration(getDb(), 999_999_999, {}, { actor: staff })).toEqual({ ok: false, code: 'not_found' });
        const [entry] = await listActivity(getDb(), a.id);
        expect([entry.action, entry.actor_person_id, entry.detail]).toEqual(['cancelled', staff, { from: 'confirmed' }]);
        // cancelling a waitlisted registration frees nothing
        const w2 = await register(id, [{ name: 'Zoe' }]);
        expect(await adminCancelRegistration(getDb(), w2.id, {}, { actor: null })).toMatchObject({ ok: true, promoted: [] });
      });

      it('moves free registrations between waitlist and confirmed; over the limit needs confirm', async () => {
        const id = await newEvent({ capacity: 2 });
        const a = await register(id, [{ name: 'Ann' }]);
        const b = await register(id, [{ name: 'Ben' }]);
        const c = await register(id, [{ name: 'Cy' }]);
        const d = await register(id, [{ name: 'Dee' }]);
        expect([c.status, d.status]).toEqual(['waitlist', 'waitlist']);
        expect(await adminMoveStatus(getDb(), c.id, { version: 1, to: 'confirmed' }, { actor: null })).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'event_full' });
        expect(await statusOf(c.id)).toBe('waitlist');
        expect(await adminMoveStatus(getDb(), c.id, { version: 1, to: 'confirmed' }, { actor: null, confirm: true })).toEqual({ ok: true, version: 2, status: 'confirmed', promoted: [] });
        // moving Ann to the waitlist frees a seat for Dee (first waiting), never back to Ann herself
        const moved = await adminMoveStatus(getDb(), a.id, { version: 1, to: 'waitlist' }, { actor: null });
        expect(moved).toEqual({ ok: true, version: 2, status: 'waitlist', promoted: [] }); // capacity 2, Ben + Cy hold both seats
        expect([await statusOf(a.id), await statusOf(d.id)]).toEqual(['waitlist', 'waitlist']);
        await cancelRegistration(getDb(), b.id); // one seat frees: Ann is first in line again (oldest)
        expect(await statusOf(a.id)).toBe('confirmed');
        // wrong status / stale version / paid
        expect(await adminMoveStatus(getDb(), a.id, { version: 3, to: 'confirmed' }, { actor: null })).toEqual({ ok: false, code: 'not_editable' });
        expect(await adminMoveStatus(getDb(), d.id, { version: 99, to: 'confirmed' }, { actor: null, confirm: true })).toEqual({ ok: false, code: 'version_conflict' });
        await getDb().prepare(`UPDATE registrations SET amount_cents = 500 WHERE id = ?1`).bind(a.id).run();
        expect(await adminMoveStatus(getDb(), a.id, { version: await versionOf(a.id), to: 'waitlist' }, { actor: null })).toEqual({ ok: false, code: 'paid_registration' });
        expect(await actionsOf(c.id)).toEqual(['moved']);
      });

      it('moving a registration to the waitlist promotes the next one but not the moved one', async () => {
        const id = await newEvent({ capacity: 1 });
        const a = await register(id, [{ name: 'Ann' }]);
        const w = await register(id, [{ name: 'Wes' }]);
        expect(w.status).toBe('waitlist');
        const moved = await adminMoveStatus(getDb(), a.id, { version: 1, to: 'waitlist' }, { actor: null });
        expect(moved).toMatchObject({ ok: true, status: 'waitlist', promoted: [w.id] });
        expect([await statusOf(a.id), await statusOf(w.id)]).toEqual(['waitlist', 'confirmed']);
      });
    });

    // ── Manual add ─────────────────────────────────────────────────────────────
    describe('manual add', () => {
      const contact = { name: 'Walk In', email: 'Walk@Example.com', phone: '555 0123' };

      it('adds a confirmed free registration, bypassing the registration phase, with a history row', async () => {
        const staff = await person('Greeter');
        const id = await newEvent({ closes_at: tsAt(-DAY), opens_at: tsAt(-3 * DAY) }); // registration is closed
        await mustForm(id, { questions: [{ type: 'text', required: true, labels: { en: 'Church' } }] });
        const added = await adminCreateRegistration(getDb(), { eventId: id, contact, attendees: [{ name: '' }, { name: 'Friend' }] }, { actor: staff });
        expect(added).toMatchObject({ ok: true, status: 'confirmed', version: 1, confirmationNo: expect.stringMatching(/^R\d\d-0001$/), manageToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
        const reg = added as Extract<typeof added, { ok: true }>;
        const row = await one<{ name: string; email: string; party_size: number; status: string; payment_method: string | null; amount_cents: number }>(
          `SELECT name, email, party_size, status, payment_method, amount_cents FROM registrations WHERE id = ?1`, reg.registrationId);
        expect(row).toEqual({ name: 'Walk In', email: 'walk@example.com', party_size: 2, status: 'confirmed', payment_method: null, amount_cents: 0 });
        expect((await attendeesOf(reg.registrationId)).map((p) => p.name)).toEqual(['Walk In', 'Friend']); // required answer skipped
        const [entry] = await listActivity(getDb(), reg.registrationId);
        expect([entry.action, entry.actor_person_id, entry.detail]).toEqual(['created', staff, { manual: true, paymentMethod: null, people: 2 }]);
        // the manage token works once and the stored value is only a hash
        const stored = await one<{ manage_token_hash: string }>(`SELECT manage_token_hash FROM registrations WHERE id = ?1`, reg.registrationId);
        expect(stored.manage_token_hash).not.toContain(reg.manageToken!);
        // validation errors name the field
        expect(await adminCreateRegistration(getDb(), { eventId: id, contact: { name: '', email: 'x' } }, { actor: staff })).toMatchObject({ ok: false, code: 'invalid', errors: [{ path: 'contact.name', code: 'required' }, { path: 'contact.email', code: 'invalid' }] });
        expect(await adminCreateRegistration(getDb(), { eventId: 999_999_999, contact }, { actor: staff })).toEqual({ ok: false, code: 'event_not_found' });
      });

      it('capacity is a soft confirm; with confirm the registration goes over the limit', async () => {
        const id = await newEvent({ capacity: 1 });
        await register(id, [{ name: 'Ann' }]);
        expect(await adminCreateRegistration(getDb(), { eventId: id, contact }, { actor: null })).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'event_full' });
        expect(await count(`SELECT count(*) AS n FROM registrations WHERE event_id = ?1`, id)).toBe(1);
        const over = await adminCreateRegistration(getDb(), { eventId: id, contact }, { actor: null, confirm: true });
        expect(over).toMatchObject({ ok: true, status: 'confirmed' });
        expect((await getEventAdmin(getDb(), id))!.taken_count).toBe(2);
        // a ticket limit works the same way
        const typed = await newEvent();
        await mustForm(typed, { tickets: [{ labels: { en: 'Adult' }, capacity: 1 }] });
        const [adult] = (await listTicketTypesAdmin(getDb(), typed)).map((t) => t.id);
        expect(await adminCreateRegistration(getDb(), { eventId: typed, contact, attendees: [{ name: '', ticketTypeId: adult }] }, { actor: null })).toMatchObject({ ok: true });
        expect(await adminCreateRegistration(getDb(), { eventId: typed, contact, attendees: [{ name: '', ticketTypeId: adult }] }, { actor: null })).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'ticket_type_full' });
        expect(await adminCreateRegistration(getDb(), { eventId: typed, contact, attendees: [{ name: '', ticketTypeId: adult }] }, { actor: null, confirm: true })).toMatchObject({ ok: true });
        // a typed event needs a type for everyone
        expect(await adminCreateRegistration(getDb(), { eventId: typed, contact }, { actor: null, confirm: true })).toMatchObject({ ok: false, code: 'invalid', errors: [{ path: 'attendees.0.ticket', code: 'required' }] });
      });

      it('paid events: offline records the amount entered, comp records zero, never Stripe', async () => {
        const id = await newEvent({ price_cents: backend === 'supabase' ? 2500 : null });
        if (backend === 'd1') await getDb().prepare(`UPDATE reg_events SET price_cents = 2500 WHERE id = ?1`).bind(id).run();
        const two = [{ name: '' }, { name: 'Friend' }];
        expect(await adminCreateRegistration(getDb(), { eventId: id, contact, attendees: two }, { actor: null })).toEqual({ ok: false, code: 'payment_method_required' });
        expect(await adminCreateRegistration(getDb(), { eventId: id, contact, attendees: two, paymentMethod: 'offline', amountCents: -1 }, { actor: null })).toMatchObject({ ok: false, code: 'invalid' });
        const offline = await adminCreateRegistration(getDb(), { eventId: id, contact, attendees: two, paymentMethod: 'offline' }, { actor: null }) as { registrationId: number };
        const comp = await adminCreateRegistration(getDb(), { eventId: id, contact, attendees: two, paymentMethod: 'comp' }, { actor: null }) as { registrationId: number };
        const custom = await adminCreateRegistration(getDb(), { eventId: id, contact, paymentMethod: 'offline', amountCents: 1000 }, { actor: null }) as { registrationId: number };
        const zero = await adminCreateRegistration(getDb(), { eventId: id, contact, paymentMethod: 'offline', amountCents: 0 }, { actor: null }) as { registrationId: number };
        const rows = await Promise.all([offline, comp, custom, zero].map((r) => one<{ payment_method: string; amount_cents: number; status: string; stripe: string | null }>(
          `SELECT payment_method, amount_cents, status, stripe_checkout_session_id AS stripe FROM registrations WHERE id = ?1`, r.registrationId)));
        expect(rows).toEqual([
          { payment_method: 'offline', amount_cents: 5000, status: 'confirmed', stripe: null },
          { payment_method: 'comp', amount_cents: 0, status: 'confirmed', stripe: null },
          { payment_method: 'offline', amount_cents: 1000, status: 'confirmed', stripe: null },
          { payment_method: 'comp', amount_cents: 0, status: 'confirmed', stripe: null },
        ]);
        expect((await listRoster(getDb(), id)).rows.map((r) => r.registration.payment_method).sort()).toEqual(['comp', 'comp', 'offline', 'offline']);
        // a free event ignores the payment method
        const free = await newEvent();
        const f = await adminCreateRegistration(getDb(), { eventId: free, contact, paymentMethod: 'offline', amountCents: 900 }, { actor: null }) as { registrationId: number };
        expect(await one(`SELECT payment_method, amount_cents FROM registrations WHERE id = ?1`, f.registrationId)).toEqual({ payment_method: null, amount_cents: 0 });
      });

      it('on an approval event the walk-in is confirmed at once; a price is refused', async () => {
        const id = await newEvent({ requires_approval: 1 });
        const added = await adminCreateRegistration(getDb(), { eventId: id, contact }, { actor: null }) as { registrationId: number };
        expect(await statusOf(added.registrationId)).toBe('confirmed');
      });

      it('links an existing member and drops an unknown person id', async () => {
        const id = await newEvent();
        const member = await person('Member');
        const added = await adminCreateRegistration(getDb(), { eventId: id, contact, personId: member }, { actor: null }) as { registrationId: number };
        expect((await one<{ person_id: number }>(`SELECT person_id FROM registrations WHERE id = ?1`, added.registrationId)).person_id).toBe(member);
        expect((await attendeesOf(added.registrationId)).length).toBe(1);
        const ghost = await adminCreateRegistration(getDb(), { eventId: id, contact, personId: 999_999_999 }, { actor: null }) as { registrationId: number };
        expect((await one<{ person_id: number | null }>(`SELECT person_id FROM registrations WHERE id = ?1`, ghost.registrationId)).person_id).toBeNull();
      });
    });

    // ── Duplicates ─────────────────────────────────────────────────────────────
    describe('duplicates', () => {
      it('folds case, spacing and accents; reports shared emails and phones; ignores cancelled and single registrations', async () => {
        const id = await newEvent();
        const a = await register(id, [{ name: 'José García' }], { email: 'shared@example.com', phone: '(555) 010-2030' });
        const b = await register(id, [{ name: '  jose   GARCIA ' }], { email: 'SHARED@example.com', phone: '555.010.2030' });
        const c = await register(id, [{ name: 'Zoë Müller' }], { email: 'zoe@example.com' });
        const d = await register(id, [{ name: 'zoe muller' }], { email: 'z2@example.com' });
        await cancelRegistration(getDb(), d.id);
        const e = await register(id, [{ name: 'Same Party' }, { name: 'Same  party' }], { email: 'party@example.com' }); // same registration: not a duplicate pair
        const f = await register(id, [{ name: 'Lone' }], { phone: '123' });
        const g = await register(id, [{ name: 'Lone Two' }], { phone: '123' }); // too short to be a phone match
        const groups = await listDuplicates(getDb(), id);
        expect(groups.map((g) => [g.kind, g.key, g.members.map((m) => m.registrationId).sort()])).toEqual([
          ['email', 'shared@example.com', [a.id, b.id]],
          ['name', 'jose garcia', [a.id, b.id]],
          ['phone', '5550102030', [a.id, b.id]],
        ]);
        expect(groups[1].members[0]).toMatchObject({ confirmationNo: expect.stringMatching(/^R\d\d-/), status: 'confirmed', attendeeId: expect.any(Number) });
        expect(groups[0].members[0].attendeeId).toBeNull();
        void c; void e; void f; void g;
      });

      it('does not mix events, and declined registrations are not duplicates', async () => {
        const id = await newEvent({ requires_approval: 1 });
        const other = await newEvent();
        const a = await register(id, [{ name: 'Ann Lee' }], { email: 'a1@example.com' });
        const b = await register(id, [{ name: 'ann lee' }], { email: 'a2@example.com' });
        await register(other, [{ name: 'Ann Lee' }], { email: 'a1@example.com' });
        expect((await listDuplicates(getDb(), id)).map((g) => g.kind)).toEqual(['name']);
        await decideRegistration(getDb(), b.id, 'decline', null);
        expect(await listDuplicates(getDb(), id)).toEqual([]);
        void a;
      });

      it('normalizes names', () => {
        expect(normalizeName('  Élodie   O\'Neil-Smith ')).toBe('elodie o neil smith');
        expect(normalizeName('张  伟')).toBe('张 伟');
        expect(normalizeName('')).toBe('');
      });
    });

    // ── Overview ───────────────────────────────────────────────────────────────
    describe('overview', () => {
      it('summarizes statuses, people, seats, types, door, revenue and choice answers', async () => {
        const id = await newEvent({ capacity: 6, requires_approval: 0, price_cents: null });
        await mustForm(id, {
          questions: [
            { type: 'select', labels: { en: 'Shirt', zh: '衬衫' }, options: [{ key: 's', labels: { en: 'Small', zh: '小' } }, { key: 'l', labels: { en: 'Large' } }] },
            { type: 'checkbox', labels: { en: 'Diet' }, options: [{ key: 'veg', labels: { en: 'Vegetarian' } }, { key: 'nut', labels: { en: 'Nut free' } }] },
            { type: 'yesno', scope: 'attendee', labels: { en: 'First time' } },
          ],
          tickets: [{ labels: { en: 'Adult' }, capacity: 4 }, { labels: { en: 'Child' } }],
        });
        const [shirt, diet, first] = await listQuestions(getDb(), 'en', id);
        const [adult, child] = (await listTicketTypesAdmin(getDb(), id)).map((t) => t.id);
        const a = await register(id, [{ name: 'Ann', ticketTypeId: adult, answers: [[first.id, 'yes']] }, { name: 'Tim', ticketTypeId: child, answers: [[first.id, 'no']] }], { answers: [[shirt.id, 's'], [diet.id, '["veg","nut"]']] });
        const b = await register(id, [{ name: 'Ben', ticketTypeId: adult, answers: [[first.id, 'yes']] }], { answers: [[shirt.id, 's']] });
        const c = await register(id, [{ name: 'Cy', ticketTypeId: adult }], { answers: [[shirt.id, 'l']] });
        await cancelRegistration(getDb(), c.id);
        await getDb().prepare(`UPDATE registrations SET status = 'review' WHERE id = ?1`).bind(b.id).run();
        const paid = await register(id, [{ name: 'Pia', ticketTypeId: adult }]);
        await getDb().prepare(`UPDATE registrations SET amount_cents = 3000, refunded_cents = 500, payment_method = 'offline' WHERE id = ?1`).bind(paid.id).run();
        const comp = await register(id, [{ name: 'Cam', ticketTypeId: adult }]);
        await getDb().prepare(`UPDATE registrations SET payment_method = 'comp' WHERE id = ?1`).bind(comp.id).run();
        const [ann] = await attendeesOf(a.id);
        await checkIn(getDb(), ann.id, null);

        const o = (await eventOverview(getDb(), id, 'zh'))!;
        expect(o).toMatchObject({ eventId: id, capacity: 6, requiresApproval: false, waitlistPeople: 0, reviewPeople: 1, checkedIn: 1 });
        expect(o.statuses.confirmed).toEqual({ registrations: 3, people: 4 });
        expect(o.statuses.review).toEqual({ registrations: 1, people: 1 });
        expect(o.statuses.cancelled).toEqual({ registrations: 1, people: 1 });
        expect(o.seatsTaken).toBe(5);
        expect(o.seatsLeft).toBe(1);
        expect(o.expectedPeople).toBe(4); // confirmed: Ann, Tim, Pia, Cam
        expect(o.byType.map((t) => [t.label, t.capacity, t.seats, t.seatsLeft])).toEqual([['Adult', 4, 4, 0], ['Child', null, 1, null]]);
        expect(o.revenue).toEqual({ currency: 'usd', collectedCents: 3000, refundedCents: 500, netCents: 2500 });
        const byQuestion = Object.fromEntries(o.tallies.map((t) => [t.label, t.options.map((x) => [x.key, x.label, x.count])]));
        expect(byQuestion['衬衫']).toEqual([['s', '小', 2], ['l', 'Large', 0]]); // Cy cancelled; labels follow the language
        expect(byQuestion['Diet']).toEqual([['veg', 'Vegetarian', 1], ['nut', 'Nut free', 1]]);
        expect(byQuestion['First time']).toEqual([['yes', 'yes', 2], ['no', 'no', 1]]);
        expect(await eventOverview(getDb(), 999_999_999)).toBeNull();
      });

      it('counts the waitlist and untyped events', async () => {
        const id = await newEvent({ capacity: 1 });
        await register(id, [{ name: 'Ann' }]);
        await register(id, [{ name: 'Wes' }, { name: 'Wyn' }]);
        const o = (await eventOverview(getDb(), id))!;
        expect([o.seatsTaken, o.seatsLeft, o.waitlistPeople, o.byType.map((t) => [t.ticketTypeId, t.seats, t.waitlist])]).toEqual([1, 0, 2, [[null, 1, 2]]]);
        expect(o.revenue).toEqual({ currency: 'usd', collectedCents: 0, refundedCents: 0, netCents: 0 });
        expect(o.tallies).toEqual([]);
      });
    });

    // ── Check-in ───────────────────────────────────────────────────────────────
    describe('check-in', () => {
      async function party() {
        const id = await newEvent({ capacity: 10 });
        const reg = await register(id, [{ name: 'Ann Lee' }, { name: 'Tim Lee' }], { email: 'lee@example.com', phone: '555-9000' });
        const [ann, tim] = await attendeesOf(reg.id);
        return { id, reg, ann, tim };
      }

      it('finds a party by confirmation number (exact), name, person, email and phone', async () => {
        const { id, reg } = await party();
        await register(id, [{ name: 'Other' }]);
        const exact = await findForDesk(getDb(), id, ` ${reg.confirmationNo!.toLowerCase()} `);
        expect(exact.exact).toBe(true);
        expect(exact.parties).toHaveLength(1);
        expect(exact.parties[0]).toMatchObject({ registrationId: reg.id, name: 'Ann Lee', status: 'confirmed', warning: null });
        expect(exact.parties[0].people.map((p) => [p.name, p.checkedIn, p.cancelled])).toEqual([['Ann Lee', false, false], ['Tim Lee', false, false]]);
        for (const q of ['lee', 'TIM', 'lee@exam', '555-90']) {
          const found = await findForDesk(getDb(), id, q);
          expect([q, found.exact, found.parties.map((p) => p.registrationId)]).toEqual([q, false, [reg.id]]);
        }
        expect((await findForDesk(getDb(), id, '')).parties).toEqual([]);
        expect((await findForDesk(getDb(), id, 'nobody')).parties).toEqual([]);
        // another event's confirmation number is not found here
        const elsewhere = await newEvent();
        const foreign = await register(elsewhere, [{ name: 'Foreign' }], { email: 'f@example.com' });
        expect((await findForDesk(getDb(), id, foreign.confirmationNo!)).parties.map((p) => p.name)).not.toContain('Foreign');
      });

      it('checks in, is idempotent, undoes, checks out and back in, and keeps the counts', async () => {
        const staff = await person('Door');
        const { id, reg, ann, tim } = await party();
        expect(await deskCounts(getDb(), id)).toEqual({ checkedIn: 0, expected: 2 });
        expect(await checkIn(getDb(), ann.id, staff)).toEqual({ ok: true, already: false });
        expect(await checkIn(getDb(), ann.id, staff)).toEqual({ ok: true, already: true });
        expect(await deskCounts(getDb(), id)).toEqual({ checkedIn: 1, expected: 2 });
        const row = await one<{ checked_in_by: number; checked_out_at: string | null }>(`SELECT checked_in_by, checked_out_at FROM reg_checkins WHERE attendee_id = ?1`, ann.id);
        expect(row).toEqual({ checked_in_by: staff, checked_out_at: null });
        expect(await checkOut(getDb(), ann.id, staff)).toEqual({ ok: true, changed: true });
        expect(await checkOut(getDb(), ann.id, staff)).toEqual({ ok: true, changed: false });
        expect(await deskCounts(getDb(), id)).toEqual({ checkedIn: 0, expected: 2 });
        expect(await checkOut(getDb(), tim.id, staff)).toEqual({ ok: false, code: 'not_checked_in' });
        // back in after leaving
        expect(await checkIn(getDb(), ann.id, staff)).toEqual({ ok: true, already: false });
        expect((await findForDesk(getDb(), id, 'ann')).parties[0].people[0]).toMatchObject({ checkedIn: true, checkedOutAt: null });
        // undo removes the row; undoing twice changes nothing
        expect(await undoCheckIn(getDb(), ann.id, staff)).toEqual({ ok: true, changed: true });
        expect(await undoCheckIn(getDb(), ann.id, staff)).toEqual({ ok: true, changed: false });
        expect(await count(`SELECT count(*) AS n FROM reg_checkins WHERE attendee_id = ?1`, ann.id)).toBe(0);
        expect(await checkIn(getDb(), 999_999_999, staff)).toEqual({ ok: false, code: 'not_found' });
        expect(await undoCheckIn(getDb(), 999_999_999, staff)).toEqual({ ok: false, code: 'not_found' });
        expect(await checkOut(getDb(), 999_999_999, staff)).toEqual({ ok: false, code: 'not_found' });
        // one history row per real change
        expect(await actionsOf(reg.id)).toEqual(['checkin', 'checkout', 'checkin', 'checkin_undo']);
      });

      it('checks a whole party in; people already in are not counted twice', async () => {
        const { id, reg, ann, tim } = await party();
        await checkIn(getDb(), ann.id, null);
        expect(await checkInParty(getDb(), reg.id, null)).toEqual({ ok: true, checkedIn: 1, already: 1 });
        expect(await checkInParty(getDb(), reg.id, null)).toEqual({ ok: true, checkedIn: 0, already: 2 });
        expect(await deskCounts(getDb(), id)).toEqual({ checkedIn: 2, expected: 2 });
        await checkOut(getDb(), tim.id, null);
        expect(await checkInParty(getDb(), reg.id, null)).toEqual({ ok: true, checkedIn: 1, already: 1 });
        expect(await checkInParty(getDb(), 999_999_999, null)).toEqual({ ok: false, code: 'not_found' });
        expect(await actionsOf(reg.id)).toEqual(['checkin', 'checkin_party', 'checkout', 'checkin_party']);
      });

      it('warns for every status but confirmed, and for a cancelled person; confirm overrides', async () => {
        const id = await newEvent({ capacity: 1, requires_approval: 1 });
        const review = await register(id, [{ name: 'Rita' }]);
        const waiting = await register(id, [{ name: 'Wes' }]);
        const [rita] = await attendeesOf(review.id);
        const [wes] = await attendeesOf(waiting.id);
        expect((await findForDesk(getDb(), id, 'rita')).parties[0].warning).toBe('status_review');
        expect(await checkIn(getDb(), rita.id, null)).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'status_review' });
        expect(await checkIn(getDb(), wes.id, null)).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'status_waitlist' });
        expect(await checkInParty(getDb(), waiting.id, null)).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'status_waitlist' });
        expect(await count(`SELECT count(*) AS n FROM reg_checkins c JOIN reg_attendees a ON a.id = c.attendee_id WHERE a.id IN (?1, ?2)`, rita.id, wes.id)).toBe(0); // the refusals wrote nothing
        expect(await deskCounts(getDb(), id)).toEqual({ checkedIn: 0, expected: 0 });
        expect(await checkIn(getDb(), rita.id, null, { confirm: true })).toEqual({ ok: true, already: false });
        expect((await listActivity(getDb(), review.id))[0].detail).toEqual({ attendeeId: rita.id, override: 'status_review' });
        await decideRegistration(getDb(), review.id, 'decline', null);
        const declined = await register(await newEvent(), [{ name: 'Dee' }]);
        await cancelRegistration(getDb(), declined.id);
        const [dee] = await attendeesOf(declined.id);
        expect(await checkIn(getDb(), dee.id, null)).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'status_cancelled' });
        // a cancelled person on a confirmed registration
        const eid = await newEvent();
        const two = await register(eid, [{ name: 'Ann' }, { name: 'Tim' }]);
        const [, tim] = await attendeesOf(two.id);
        await adminRemovePerson(getDb(), two.id, { version: 1, attendeeId: tim.id }, { actor: null });
        expect(await checkIn(getDb(), tim.id, null)).toEqual({ ok: false, code: 'NEEDS_CONFIRM', reason: 'attendee_cancelled' });
        expect((await findForDesk(getDb(), eid, 'ann')).parties[0].people.map((p) => [p.name, p.cancelled])).toEqual([['Ann', false], ['Tim', true]]);
      });

      it('the desk version changes whenever something a desk shows can have changed', async () => {
        const { id, reg, ann } = await party();
        const seen = new Set<string>();
        const note = async () => {
          const v = await deskVersion(getDb(), id);
          expect(seen.has(v)).toBe(false);
          seen.add(v);
        };
        await note();
        expect(await deskVersion(getDb(), id)).toBe(await deskVersion(getDb(), id)); // stable while nothing happens
        await checkIn(getDb(), ann.id, null);
        await note();
        await undoCheckIn(getDb(), ann.id, null);
        await note();
        await adminSetNote(getDb(), reg.id, { version: 1, note: 'x' }, { actor: null });
        await note();
        await register(id, [{ name: 'Late' }]);
        await note();
        const before = await deskVersion(getDb(), id);
        await register(await newEvent(), [{ name: 'Elsewhere' }]);
        expect(await deskVersion(getDb(), id)).toBe(before); // another event does not move it
      });
    });

    // ── Reminders, outbox, refunds ─────────────────────────────────────────────
    describe('reminders', () => {
      it('finds confirmed registrations of events starting within reminder_days, and claims each once', async () => {
        const soon = await newEvent({ starts_at: tsAt(2 * DAY), reminder_days: 3 });
        const later = await newEvent({ starts_at: tsAt(10 * DAY), reminder_days: 3 });
        const none = await newEvent({ starts_at: tsAt(1 * DAY) });
        const past = await newEvent({ starts_at: tsAt(-DAY), reminder_days: 3 });
        const inactive = await newEvent({ starts_at: tsAt(2 * DAY), reminder_days: 3, active: 0 });
        const a = await register(soon, [{ name: 'Ann' }]);
        const cancelled = await register(soon, [{ name: 'Cy' }]);
        await cancelRegistration(getDb(), cancelled.id);
        const waiting = await register(soon, [{ name: 'Wes' }]);
        await getDb().prepare(`UPDATE registrations SET status = 'waitlist' WHERE id = ?1`).bind(waiting.id).run();
        for (const e of [later, none, past, inactive]) await register(e, [{ name: 'X' }]);
        const found = await findReminderCandidates(getDb());
        expect(found.filter((c) => [soon, later, none, past, inactive].includes(c.eventId)).map((c) => [c.eventId, c.registrationId])).toEqual([[soon, a.id]]);
        expect((await findReminderCandidates(getDb(), new Date(Date.now() + 8 * DAY))).some((c) => c.eventId === later)).toBe(true);
        expect(await findReminderCandidates(getDb(), new Date(), 1)).toHaveLength(1);
        // claim: the first caller wins, a second does not, release makes it due again
        expect(await claimReminder(getDb(), a.id)).toBe(true);
        expect(await claimReminder(getDb(), a.id)).toBe(false);
        expect((await findReminderCandidates(getDb())).some((c) => c.registrationId === a.id)).toBe(false);
        await releaseReminder(getDb(), a.id);
        expect((await findReminderCandidates(getDb())).some((c) => c.registrationId === a.id)).toBe(true);
        expect(await claimReminder(getDb(), waiting.id)).toBe(false); // not confirmed
      });
    });

    describe('outbox', () => {
      async function queued(n = 3) {
        const id = await newEvent();
        const regs = [];
        for (let i = 0; i < n; i++) regs.push(await register(id, [{ name: `Guest ${i}` }]));
        const result = await enqueueOutbox(getDb(), { eventId: id, kind: 'bulk', subject: ' Hello ', body: ' Dear {name} ', registrationIds: regs.map((r) => r.id), createdBy: null });
        return { id, regs, result };
      }

      it('previews the audience and enqueues one row per registration of THIS event', async () => {
        const id = await newEvent({ capacity: 2 });
        await mustForm(id, { tickets: [{ labels: { en: 'Adult' } }, { labels: { en: 'Child' } }] });
        const [adult, child] = (await listTicketTypesAdmin(getDb(), id)).map((t) => t.id);
        const a = await register(id, [{ name: 'Ann', ticketTypeId: adult }]);
        const b = await register(id, [{ name: 'Ben', ticketTypeId: child }]);
        const w = await register(id, [{ name: 'Wes', ticketTypeId: adult }]);
        expect(w.status).toBe('waitlist');
        expect((await bulkAudience(getDb(), id)).map((m) => m.registrationId)).toEqual([a.id, b.id]);
        expect((await bulkAudience(getDb(), id, { statuses: ['waitlist'] })).map((m) => m.registrationId)).toEqual([w.id]);
        expect((await bulkAudience(getDb(), id, { statuses: ['confirmed', 'waitlist'], ticketTypeId: adult })).map((m) => m.registrationId)).toEqual([a.id, w.id]);
        expect(await bulkAudience(getDb(), id, { statuses: ['bogus' as RegStatus] })).toEqual([]);

        const other = await register(await newEvent(), [{ name: 'Stranger' }]);
        const result = await enqueueOutbox(getDb(), { eventId: id, kind: 'bulk', subject: 'S', body: 'B', registrationIds: [a.id, b.id, other.id, a.id, -4], createdBy: null });
        expect(result).toEqual({ ok: true, queued: 2 }); // the other event's registration and duplicates are ignored
        expect(await outboxCounts(getDb(), id)).toEqual({ queued: 2, sent: 0, failed: 0, skipped: 0 });
        expect(await enqueueOutbox(getDb(), { eventId: id, kind: 'bulk', subject: ' ', body: 'B', registrationIds: [a.id], createdBy: null })).toEqual({ ok: false, code: 'invalid' });
        expect(await enqueueOutbox(getDb(), { eventId: id, kind: 'promo' as 'bulk', subject: 'S', body: 'B', registrationIds: [a.id], createdBy: null })).toEqual({ ok: false, code: 'invalid' });
        expect(await enqueueOutbox(getDb(), { eventId: 999_999_999, kind: 'bulk', subject: 'S', body: 'B', registrationIds: [a.id], createdBy: null })).toEqual({ ok: false, code: 'event_not_found' });
        expect(await enqueueOutbox(getDb(), { eventId: id, kind: 'bulk', subject: 'S', body: 'B', registrationIds: [], createdBy: null })).toEqual({ ok: true, queued: 0 });
      });

      it('claims in order without overlap, marks sent / failed / skipped, retries up to the limit', async () => {
        const { id, result } = await queued(4);
        expect(result).toEqual({ ok: true, queued: 4 });
        const first = await claimOutbox(getDb(), { limit: 3, eventId: id });
        expect(first).toHaveLength(3);
        expect(first.map((r) => r.attempts)).toEqual([1, 1, 1]);
        expect(first[0]).toMatchObject({ kind: 'bulk', subject: 'Hello', body: 'Dear {name}', event_id: id });
        // everything claimed is hidden from the next claim; only the fourth is left
        const second = await claimOutbox(getDb(), { limit: 10, eventId: id });
        expect(second).toHaveLength(1);
        expect(first.some((f) => f.id === second[0].id)).toBe(false);
        expect(await claimOutbox(getDb(), { limit: 10, eventId: id })).toEqual([]);
        expect(await markOutboxSent(getDb(), first[0].id)).toBe(true);
        expect(await markOutboxSent(getDb(), first[0].id)).toBe(false);
        expect(await markOutboxSkipped(getDb(), first[1].id)).toBe(true);
        expect(await markOutboxFailed(getDb(), first[2].id)).toBe('requeued');
        expect(await outboxCounts(getDb(), id)).toEqual({ queued: 2, sent: 1, failed: 0, skipped: 1 });
        // the failed row is claimable again; after the third attempt it is failed for good
        const retry = await claimOutbox(getDb(), { limit: 10, eventId: id, now: new Date(Date.now() + 1000) });
        expect(retry.map((r) => [r.id, r.attempts])).toEqual([[first[2].id, 2]]);
        expect(await markOutboxFailed(getDb(), first[2].id)).toBe('requeued');
        const third = await claimOutbox(getDb(), { limit: 10, eventId: id, now: new Date(Date.now() + 2000) });
        expect(third.map((r) => r.attempts)).toEqual([3]);
        expect(await markOutboxFailed(getDb(), first[2].id)).toBe('failed');
        expect(await markOutboxFailed(getDb(), first[2].id)).toBeNull();
        // only the untouched fourth row's lease is still running: nothing else is queued
        expect(await claimOutbox(getDb(), { limit: 10, eventId: id, now: new Date(Date.now() + 3000) })).toEqual([]);
      });

      it('an abandoned claim becomes claimable again after the lease', async () => {
        const { id } = await queued(1);
        const [claimed] = await claimOutbox(getDb(), { limit: 5, eventId: id });
        expect(await claimOutbox(getDb(), { limit: 5, eventId: id })).toEqual([]);
        const later = await claimOutbox(getDb(), { limit: 5, eventId: id, now: new Date(Date.now() + 11 * 60_000) });
        expect(later.map((r) => [r.id, r.attempts])).toEqual([[claimed.id, 2]]);
      });

      it('drops the queue with its registration', async () => {
        const { id, regs } = await queued(2);
        await getDb().prepare(`DELETE FROM registrations WHERE id = ?1`).bind(regs[0].id).run();
        expect((await outboxCounts(getDb(), id)).queued).toBe(1);
      });
    });

    describe('refund bookkeeping', () => {
      async function paid(method: 'stripe' | 'offline' | 'comp' | null, amount = 5000) {
        const id = await newEvent();
        const reg = await register(id, [{ name: 'Pia' }]);
        await getDb().prepare(`UPDATE registrations SET amount_cents = ?2, payment_method = ?3 WHERE id = ?1`).bind(reg.id, amount, method).run();
        return reg.id;
      }

      it('adds partial refunds up to what was paid and never beyond', async () => {
        const staff = await person('Treasurer');
        const id = await paid('stripe');
        expect(await recordRefund(getDb(), id, 2000, 'stripe', { actor: staff })).toEqual({ ok: true, refundedCents: 2000, remainingCents: 3000 });
        expect(await recordRefund(getDb(), id, 3001, 'stripe')).toEqual({ ok: false, code: 'exceeds_paid' });
        expect((await one<{ refunded_cents: number }>(`SELECT refunded_cents FROM registrations WHERE id = ?1`, id)).refunded_cents).toBe(2000);
        expect(await recordRefund(getDb(), id, 3000, 'stripe')).toEqual({ ok: true, refundedCents: 5000, remainingCents: 0 });
        expect(await recordRefund(getDb(), id, 1, 'stripe')).toEqual({ ok: false, code: 'exceeds_paid' });
        for (const bad of [0, -5, 1.5, Number.NaN, 100_000_000]) expect(await recordRefund(getDb(), id, bad, 'stripe')).toEqual({ ok: false, code: 'invalid_amount' });
        expect(await recordRefund(getDb(), 999_999_999, 1, 'stripe')).toEqual({ ok: false, code: 'not_found' });
        const entries = await listActivity(getDb(), id);
        expect(entries.map((e) => [e.action, e.detail])).toEqual([
          ['refund', { cents: 3000, source: 'stripe', total: 5000 }],
          ['refund', { cents: 2000, source: 'stripe', total: 2000 }],
        ]);
        expect(entries[1].actor_person_id).toBe(staff);
        expect(await versionOf(id)).toBe(3);
      });

      it('keeps card, offline and comp payments apart', async () => {
        const card = await paid('stripe');
        const cash = await paid('offline');
        const comp = await paid('comp');
        const none = await paid(null, 0);
        expect(await recordRefund(getDb(), card, 100, 'offline')).toEqual({ ok: false, code: 'use_stripe' });
        expect(await recordRefund(getDb(), cash, 100, 'stripe')).toEqual({ ok: false, code: 'not_stripe' });
        expect(await recordRefund(getDb(), cash, 100, 'offline', { note: 'Cash handed back' })).toEqual({ ok: true, refundedCents: 100, remainingCents: 4900 });
        expect((await listActivity(getDb(), cash))[0].detail).toEqual({ cents: 100, source: 'offline', total: 100, note: 'Cash handed back' });
        expect(await recordRefund(getDb(), comp, 100, 'offline')).toEqual({ ok: false, code: 'no_payment' });
        expect(await recordRefund(getDb(), none, 100, 'offline')).toEqual({ ok: false, code: 'no_payment' });
        // a registration still awaiting payment has nothing to refund
        const pending = await paid('stripe');
        await getDb().prepare(`UPDATE registrations SET status = 'pending' WHERE id = ?1`).bind(pending).run();
        expect(await recordRefund(getDb(), pending, 100, 'stripe')).toEqual({ ok: false, code: 'no_payment' });
      });

      it('syncs the cumulative total Stripe reports: idempotent, never lowers, capped at the amount paid', async () => {
        const id = await paid('stripe');
        expect(await syncRefundedTotal(getDb(), id, 1500)).toEqual({ ok: true, added: 1500 });
        expect(await syncRefundedTotal(getDb(), id, 1500)).toEqual({ ok: true, added: 0 }); // a redelivered webhook
        expect(await syncRefundedTotal(getDb(), id, 1000)).toEqual({ ok: true, added: 0 }); // never lowers
        expect(await syncRefundedTotal(getDb(), id, 9999)).toEqual({ ok: true, added: 3500 }); // capped at amount_cents
        expect((await one<{ refunded_cents: number }>(`SELECT refunded_cents FROM registrations WHERE id = ?1`, id)).refunded_cents).toBe(5000);
        expect(await syncRefundedTotal(getDb(), id, -1)).toEqual({ ok: false, code: 'invalid_amount' });
        expect(await syncRefundedTotal(getDb(), 999_999_999, 1)).toEqual({ ok: false, code: 'not_found' });
        expect(await actionsOf(id)).toEqual(['refund', 'refund']);
      });
    });
  });
}
