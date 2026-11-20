// The check-in desk's request logic, kept out of the page so it can be tested against a real database. The
// middleware already refused anyone without the 'checkin' capability for the event in the URL; this checks it
// again before every action and then requires the person (or registration) acted on to belong to that same
// event, so an id from another event is a plain 404. The data layer (regCheckin.ts) does the writing and the
// idempotence; this maps form fields to calls and results to a small outcome the page and its script share.
import type { AppDb } from './appDb';
import type { SessionUser } from './types';
import { eventOfAttendee, eventOfRegistration, requireRegRole } from './regAccess';
import { checkIn, checkInParty, checkOut, undoCheckIn } from './regCheckin';

export type DeskOp = 'checkin' | 'undo' | 'checkout' | 'party';
export const DESK_OPS: readonly DeskOp[] = ['checkin', 'undo', 'checkout', 'party'];

export type DeskDone = 'checkin' | 'already' | 'undo' | 'checkout' | 'party';

export type DeskOutcome =
  | { ok: true; done: DeskDone; count?: number }
  | { ok: false; status: 400 | 403 | 404; code: 'forbidden' | 'not_found' | 'bad_request' }
  | { ok: false; status: 409; code: 'NEEDS_CONFIRM'; reason: string }
  | { ok: false; status: 409; code: 'not_checked_in' };

const positiveInt = (value: FormDataEntryValue | null): number | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,15}$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Run one desk action from a submitted form: `op`, `attendee_id` or `registration_id`, optional `confirm=1`. */
export async function performDeskAction(db: AppDb, user: SessionUser | null, eventId: number, form: FormData): Promise<DeskOutcome> {
  const role = await requireRegRole(db, user, eventId, 'checkin');
  if (!role.ok) return { ok: false, status: role.status, code: role.status === 404 ? 'not_found' : 'forbidden' };
  const op = String(form.get('op') ?? '') as DeskOp;
  if (!DESK_OPS.includes(op)) return { ok: false, status: 400, code: 'bad_request' };
  const actor = user?.id ?? null;
  const confirm = form.get('confirm') === '1';

  if (op === 'party') {
    const registrationId = positiveInt(form.get('registration_id'));
    if (registrationId === null) return { ok: false, status: 400, code: 'bad_request' };
    if ((await eventOfRegistration(db, registrationId)) !== eventId) return { ok: false, status: 404, code: 'not_found' };
    const result = await checkInParty(db, registrationId, actor, { confirm });
    if (result.ok) return { ok: true, done: 'party', count: result.checkedIn };
    if (result.code === 'NEEDS_CONFIRM') return { ok: false, status: 409, code: 'NEEDS_CONFIRM', reason: result.reason };
    return { ok: false, status: 404, code: 'not_found' };
  }

  const attendeeId = positiveInt(form.get('attendee_id'));
  if (attendeeId === null) return { ok: false, status: 400, code: 'bad_request' };
  const owner = await eventOfAttendee(db, attendeeId);
  if (!owner || owner.eventId !== eventId) return { ok: false, status: 404, code: 'not_found' };

  if (op === 'checkin') {
    const result = await checkIn(db, attendeeId, actor, { confirm });
    if (result.ok) return { ok: true, done: result.already ? 'already' : 'checkin' };
    if (result.code === 'NEEDS_CONFIRM') return { ok: false, status: 409, code: 'NEEDS_CONFIRM', reason: result.reason };
    return { ok: false, status: 404, code: 'not_found' };
  }
  if (op === 'undo') {
    const result = await undoCheckIn(db, attendeeId, actor);
    return result.ok ? { ok: true, done: 'undo' } : { ok: false, status: 404, code: 'not_found' };
  }
  const result = await checkOut(db, attendeeId, actor);
  if (result.ok) return { ok: true, done: 'checkout' };
  return result.code === 'not_checked_in'
    ? { ok: false, status: 409, code: 'not_checked_in' }
    : { ok: false, status: 404, code: 'not_found' };
}
