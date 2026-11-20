// The check-in desk's request logic on BOTH backends (performDeskAction): who may act (desk, registrar and
// registration admins yes; viewers and strangers no), that an attendee or registration from another event is a
// plain 404, the confirm step for anyone not simply confirmed, idempotent repeats, whole-party check-in, and
// that the search a scanned QR sends (the confirmation number) finds exactly that party without contact data.
// Run against D1 (test/regDesk.d1.test.ts) and Postgres (test/pg/regDesk.pg.test.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import type { SessionUser } from '../../src/lib/types';
import { createRegistration, saveEvent } from '../../src/lib/regDb';
import { grantEventRole } from '../../src/lib/regAccess';
import { deskCounts, deskVersion, findForDesk } from '../../src/lib/regCheckin';
import { performDeskAction } from '../../src/lib/regDesk';

const DAY = 24 * 3600_000;
const tsAt = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
let seq = 0;

const user = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 1, email: 'x@example.com', displayName: 'X', role: 'member', isAdmin: false, isEditor: false, finance: 0,
  memberTeamIds: [], leaderTeamIds: [], lang: null, isSuperAdmin: false, adminAreas: [], ...over,
});

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

export function defineRegDeskCases(label: string, getDb: () => AppDb): void {
  const db = () => getDb();
  const newEvent = (over: Partial<Parameters<typeof saveEvent>[1]> = {}) =>
    saveEvent(db(), { title_en: 'Picnic', title_zh: '野餐', starts_at: tsAt(10 * DAY), active: 1, max_party_size: 6, ...over });
  const register = async (eventId: number, names: string[], over: Partial<Parameters<typeof createRegistration>[1]> = {}) => {
    const n = ++seq;
    const created = await createRegistration(db(), {
      eventId, personId: null, name: names[0], email: `desk${n}-${Date.now()}@example.com`, phone: '555 0101', status: 'confirmed', amountCents: 0,
      currency: 'usd', answers: [], attendees: names.map((name) => ({ name })), submissionKey: `desk-${Date.now()}-${n}`, locale: 'en', ...over,
    });
    const { results } = await db().prepare(`SELECT id FROM reg_attendees WHERE registration_id = ?1 ORDER BY sort, id`).bind(created.id).all<{ id: number }>();
    return { id: created.id, confirmationNo: created.confirmationNo, attendees: results.map((r) => r.id) };
  };
  const person = async (name: string) => {
    const row = await db().prepare(`INSERT INTO people (display_name, email) VALUES (?1, ?2) RETURNING id`).bind(name, `${name.toLowerCase()}-${++seq}-${Date.now()}@example.com`).first<{ id: number }>();
    return row!.id;
  };
  const checkedIn = async (attendeeId: number) =>
    (await db().prepare(`SELECT checked_in_at, checked_out_at FROM reg_checkins WHERE attendee_id = ?1`).bind(attendeeId).first<{ checked_in_at: string; checked_out_at: string | null }>()) ?? null;

  describe(`check-in desk actions (${label})`, () => {
    const areaAdmin = user({ id: 9101, role: 'admin', isAdmin: true, adminAreas: ['registration'] });
    beforeEach(async () => {
      await db().prepare(`INSERT INTO people (id, display_name, email) VALUES (?1, 'Desk Admin', 'desk-admin@example.com') ON CONFLICT (id) DO NOTHING`).bind(areaAdmin.id).run();
    });

    it('desk, registrar and registration admins may check in; viewers and strangers may not', async () => {
      const eventId = await newEvent();
      const party = await register(eventId, ['Ana']);
      const deskId = await person('Desk');
      const viewerId = await person('Viewer');
      const registrarId = await person('Registrar');
      const strangerId = await person('Stranger');
      await grantEventRole(db(), eventId, deskId, 'desk');
      await grantEventRole(db(), eventId, viewerId, 'viewer');
      await grantEventRole(db(), eventId, registrarId, 'registrar');
      const act = (u: SessionUser, op = 'checkin') => performDeskAction(db(), u, eventId, form({ op, attendee_id: String(party.attendees[0]) }));

      expect(await act(user({ id: viewerId }))).toEqual({ ok: false, status: 403, code: 'forbidden' });
      expect(await act(user({ id: strangerId }))).toEqual({ ok: false, status: 403, code: 'forbidden' });
      expect(await act(user({ id: strangerId, role: 'admin', isAdmin: true, adminAreas: ['people'] }))).toEqual({ ok: false, status: 403, code: 'forbidden' });
      expect(await checkedIn(party.attendees[0])).toBeNull();

      expect(await act(user({ id: deskId }))).toEqual({ ok: true, done: 'checkin' });
      expect(await act(user({ id: registrarId }), 'undo')).toEqual({ ok: true, done: 'undo' });
      expect(await act(areaAdmin)).toEqual({ ok: true, done: 'checkin' });
    });

    it('refuses a person or registration from another event with a plain 404, and bad input with 400', async () => {
      const eventA = await newEvent();
      const eventB = await newEvent();
      const deskId = await person('DeskA');
      await grantEventRole(db(), eventA, deskId, 'desk');
      const other = await register(eventB, ['Bo', 'Cy']);
      const desk = user({ id: deskId });
      expect(await performDeskAction(db(), desk, eventA, form({ op: 'checkin', attendee_id: String(other.attendees[0]) }))).toEqual({ ok: false, status: 404, code: 'not_found' });
      expect(await performDeskAction(db(), desk, eventA, form({ op: 'party', registration_id: String(other.id) }))).toEqual({ ok: false, status: 404, code: 'not_found' });
      expect(await checkedIn(other.attendees[0])).toBeNull();
      // The desk role on event A gives nothing on event B itself.
      expect(await performDeskAction(db(), desk, eventB, form({ op: 'checkin', attendee_id: String(other.attendees[0]) }))).toEqual({ ok: false, status: 403, code: 'forbidden' });
      expect(await performDeskAction(db(), desk, eventA, form({ op: 'explode', attendee_id: '1' }))).toEqual({ ok: false, status: 400, code: 'bad_request' });
      expect(await performDeskAction(db(), desk, eventA, form({ op: 'checkin', attendee_id: 'abc' }))).toEqual({ ok: false, status: 400, code: 'bad_request' });
      expect(await performDeskAction(db(), desk, eventA, form({ op: 'checkin', attendee_id: '999999999' }))).toEqual({ ok: false, status: 404, code: 'not_found' });
    });

    it('needs a confirm for a waitlisted party, and then checks them in', async () => {
      const eventId = await newEvent({ capacity: 1 });
      await register(eventId, ['First']);
      const waiting = await register(eventId, ['Later']);
      const row = await db().prepare(`SELECT status FROM registrations WHERE id = ?1`).bind(waiting.id).first<{ status: string }>();
      expect(row?.status).toBe('waitlist');
      const first = await performDeskAction(db(), areaAdmin, eventId, form({ op: 'checkin', attendee_id: String(waiting.attendees[0]) }));
      expect(first).toEqual({ ok: false, status: 409, code: 'NEEDS_CONFIRM', reason: 'status_waitlist' });
      expect(await checkedIn(waiting.attendees[0])).toBeNull();
      expect(await performDeskAction(db(), areaAdmin, eventId, form({ op: 'checkin', attendee_id: String(waiting.attendees[0]), confirm: '1' }))).toEqual({ ok: true, done: 'checkin' });
      expect(await checkedIn(waiting.attendees[0])).not.toBeNull();
    });

    it('is idempotent, checks out and back in, and checks a whole party in once', async () => {
      const eventId = await newEvent();
      const party = await register(eventId, ['Dee', 'Eli', 'Fay']);
      const act = (fields: Record<string, string>) => performDeskAction(db(), areaAdmin, eventId, form(fields));
      expect(await act({ op: 'checkin', attendee_id: String(party.attendees[0]) })).toEqual({ ok: true, done: 'checkin' });
      expect(await act({ op: 'checkin', attendee_id: String(party.attendees[0]) })).toEqual({ ok: true, done: 'already' });
      expect(await act({ op: 'party', registration_id: String(party.id) })).toEqual({ ok: true, done: 'party', count: 2 });
      expect(await act({ op: 'party', registration_id: String(party.id) })).toEqual({ ok: true, done: 'party', count: 0 });
      expect(await deskCounts(db(), eventId)).toEqual({ checkedIn: 3, expected: 3 });

      expect(await act({ op: 'checkout', attendee_id: String(party.attendees[1]) })).toEqual({ ok: true, done: 'checkout' });
      expect((await checkedIn(party.attendees[1]))?.checked_out_at).not.toBeNull();
      expect(await deskCounts(db(), eventId)).toEqual({ checkedIn: 2, expected: 3 });
      expect(await act({ op: 'checkin', attendee_id: String(party.attendees[1]) })).toEqual({ ok: true, done: 'checkin' });
      expect((await checkedIn(party.attendees[1]))?.checked_out_at).toBeNull();

      const never = await register(eventId, ['Gus']);
      expect(await act({ op: 'checkout', attendee_id: String(never.attendees[0]) })).toEqual({ ok: false, status: 409, code: 'not_checked_in' });
    });

    it('moves the change marker the desks poll, and the scanned confirmation number finds exactly that party', async () => {
      const eventId = await newEvent();
      const party = await register(eventId, ['Hal', 'Ivy']);
      await register(eventId, ['Hallie']);
      const before = await deskVersion(db(), eventId);
      await performDeskAction(db(), areaAdmin, eventId, form({ op: 'checkin', attendee_id: String(party.attendees[0]) }));
      expect(await deskVersion(db(), eventId)).not.toBe(before);

      const scanned = await findForDesk(db(), eventId, ` ${party.confirmationNo!.toLowerCase()} `, 'en');
      expect(scanned.exact).toBe(true);
      expect(scanned.parties.map((p) => p.registrationId)).toEqual([party.id]);
      expect(scanned.parties[0].people.map((p) => [p.name, p.checkedIn])).toEqual([['Hal', true], ['Ivy', false]]);
      // The desk never carries contact details or answers.
      expect(JSON.stringify(scanned)).not.toMatch(/@example\.com|555 0101/);
      const byName = await findForDesk(db(), eventId, 'hal', 'en');
      expect(byName.exact).toBe(false);
      expect(byName.parties.length).toBe(2);
    });
  });
}
