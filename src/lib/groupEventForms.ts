// FormData parsers for the group-admin console (the routine-event editor and the
// inline add-member form on src/pages/[locale]/groups/[id]/manage.astro). Same
// contract as src/lib/validate.ts: each returns { ok: true, data } or
// { ok: false, errors } where every error VALUE is a dictionary KEY rendered
// through t() at display time — never localized prose. Pure (no db, no Astro), so
// the validation unit-tests away from the request lifecycle. Kept in a dedicated
// file (rather than validate.ts) to stay collision-free with the concurrently
// authored group form parsers.
import { isValidDateStr } from './dates';
import { isEmail, type FormResult } from './validate';
import { RECURRENCES, type GroupEventInput, type Recurrence } from './groupEventDb';
import type { InlineMemberInput } from './groupDb';

// Error dictionary keys. The generic ones live in the shared errors.* namespace
// (parity-enforced); the three group-specific ones live under groups.manage.*.
const ERR = {
  required: 'errors.required',
  date: 'errors.dateFormat',
  tooLong: 'errors.tooLong',
  option: 'errors.invalidOption',
  email: 'errors.emailInvalid',
  time: 'groups.manage.errTime',
  duration: 'groups.manage.errDuration',
  endsBeforeStart: 'groups.manage.errEndsBeforeStart',
} as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // strict HH:MM 24h

function str(fd: FormData, name: string): string {
  return String(fd.get(name) ?? '').trim();
}
function checkbox(fd: FormData, name: string): boolean {
  return fd.get(name) !== null;
}

/**
 * Parse the routine-event create/edit form. `active` is handled by the page (it
 * is not part of GroupEventInput). Validation: title required and ≤200; recurrence
 * in the enum; starts_on a real YYYY-MM-DD; start_time a real HH:MM (24h); duration
 * an integer 15..720; ends_on, when present, a real date that is ≥ starts_on.
 */
export function parseGroupEventForm(fd: FormData): FormResult<GroupEventInput> {
  const errors: Record<string, string> = {};

  const title = str(fd, 'title');
  if (!title) errors.title = ERR.required;
  else if (title.length > 200) errors.title = ERR.tooLong;

  const description = str(fd, 'description');
  const location = str(fd, 'location') || null;

  const recurrenceRaw = str(fd, 'recurrence');
  let recurrence: Recurrence = 'none';
  if ((RECURRENCES as readonly string[]).includes(recurrenceRaw)) recurrence = recurrenceRaw as Recurrence;
  else errors.recurrence = ERR.option;

  const startsOn = str(fd, 'starts_on');
  if (!isValidDateStr(startsOn)) errors.starts_on = ERR.date;

  const startTime = str(fd, 'start_time');
  if (!TIME_RE.test(startTime)) errors.start_time = ERR.time;

  const durationRaw = str(fd, 'duration_min');
  const durationMin = Number(durationRaw);
  if (!/^\d+$/.test(durationRaw) || durationMin < 15 || durationMin > 720) errors.duration_min = ERR.duration;

  const endsOnRaw = str(fd, 'ends_on');
  let endsOn: string | null = null;
  if (endsOnRaw !== '') {
    if (!isValidDateStr(endsOnRaw)) errors.ends_on = ERR.date;
    else if (!errors.starts_on && endsOnRaw < startsOn) errors.ends_on = ERR.endsBeforeStart;
    else endsOn = endsOnRaw;
  }

  const trackAttendance = checkbox(fd, 'track_attendance');

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: { title, description, location, recurrence, startsOn, startTime, durationMin, endsOn, trackAttendance },
  };
}

/**
 * Parse the inline "add a new person" member form. first + last are required,
 * trimmed non-empty and ≤100 chars; email is optional but must be a valid address
 * when supplied (lowercased, matching people.email storage); phone is optional and
 * ≤40 chars. Mirrors groupDb.InlineMemberInput so the result feeds addMemberInline.
 */
export function parseInlineMemberForm(fd: FormData): FormResult<InlineMemberInput> {
  const errors: Record<string, string> = {};

  const firstName = str(fd, 'first_name');
  if (!firstName) errors.first_name = ERR.required;
  else if (firstName.length > 100) errors.first_name = ERR.tooLong;

  const lastName = str(fd, 'last_name');
  if (!lastName) errors.last_name = ERR.required;
  else if (lastName.length > 100) errors.last_name = ERR.tooLong;

  const emailRaw = str(fd, 'email').toLowerCase();
  let email: string | null = null;
  if (emailRaw !== '') {
    if (!isEmail(emailRaw)) errors.email = ERR.email;
    else email = emailRaw;
  }

  const phoneRaw = str(fd, 'phone');
  if (phoneRaw.length > 40) errors.phone = ERR.tooLong;
  const phone = phoneRaw || null;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, data: { firstName, lastName, email, phone } };
}
