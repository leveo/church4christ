// Public registration flow, server-side helpers shared by the register page (form
// and review step), the member submit endpoint and the guest continuation start:
// turning a posted form into the shared SubmissionInput, mapping validation codes to
// copy, echoing the form's identity fields safely, and the party-versus-seats rule.
// Pure functions only (no database, no Astro), so they unit-test directly.
import type { RegQuestion } from './regDb';
import type { SelfEditInput, SubmissionError, SubmissionInput } from './regManage';
import { MAX_PARTY_SIZE_LIMIT } from './regManage';

/** Form fields grouped by name (a checkbox group has several values). */
export type FieldBag = Record<string, string[]>;

/** Group a FormData's text fields by name; files and nothing else are dropped. */
export function bagFromFormData(form: FormData): FieldBag {
  const bag: FieldBag = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string') continue;
    (bag[key] ??= []).push(value);
  }
  return bag;
}

/** The first value of a field, or ''. */
export const bagFirst = (bag: FieldBag, name: string): string => bag[name]?.[0] ?? '';

/** How many person rows the form shows: the event's max party size, capped (a missing value means one). */
export function partyRowCount(maxPartySize: number | undefined): number {
  const n = Math.trunc(Number(maxPartySize));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_PARTY_SIZE_LIMIT) : 1;
}

/**
 * Read a registration form: the contact, the people (row 0 is the contact person and
 * is sent blank, which validateSubmission reads as the contact's own name; rows
 * 1..max-1 come from `person_name_<i>` / `person_id_<i>`), and the answers (keyed by
 * question id). `contact` overrides the posted name/email (a signed-in member's are
 * their account's). Nothing here validates; run validateSubmission on the result.
 */
export function submissionFromBag(
  bag: FieldBag,
  questions: RegQuestion[],
  maxPartySize: number,
  contact?: { name: string; email: string },
): SubmissionInput {
  const attendees: NonNullable<SubmissionInput['attendees']> = [{ name: '' }];
  for (let i = 1; i < partyRowCount(maxPartySize); i++) {
    const personId = Number(bagFirst(bag, `person_id_${i}`));
    attendees.push({
      name: bagFirst(bag, `person_name_${i}`),
      personId: Number.isSafeInteger(personId) && personId > 0 ? personId : null,
    });
  }
  const answers: Record<string, string[]> = {};
  for (const question of questions) answers[String(question.id)] = bag[String(question.id)] ?? [];
  return {
    contact: {
      name: contact?.name ?? bagFirst(bag, 'name'),
      email: contact?.email ?? bagFirst(bag, 'email'),
      phone: bagFirst(bag, 'phone'),
    },
    attendees,
    answers,
  };
}

/** The member's edit form: contact name and phone, each person's name (`attendee_<id>`) and
 *  the full answer set (`a_<questionId>`). Always carries an answers object, so a cleared
 *  checkbox group is read as "nothing chosen" rather than "not edited". */
export function editFromBag(bag: FieldBag): SelfEditInput {
  const attendees: Array<{ id: number; name: string }> = [];
  const answers: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(bag)) {
    const person = /^attendee_(\d{1,12})$/.exec(key);
    if (person) attendees.push({ id: Number(person[1]), name: values[0] ?? '' });
    const answer = /^a_(\d{1,12})$/.exec(key);
    if (answer) answers[answer[1]] = values;
  }
  return {
    ...(bag.name !== undefined ? { name: bagFirst(bag, 'name') } : {}),
    ...(bag.phone !== undefined ? { phone: bagFirst(bag, 'phone') } : {}),
    attendees,
    answers,
  };
}

// ── Echoing the form's identity fields ──────────────────────────────────────

const SUBMISSION_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/u;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A posted idempotency key when it is well formed, else a fresh one; carried unchanged through review. */
export function echoSubmissionKey(posted: string): string {
  return SUBMISSION_KEY_RE.test(posted) ? posted : crypto.randomUUID().replaceAll('-', '');
}

/** A posted guest-continuation intent id when it is a v4 UUID, else a fresh one. */
export function echoIntentId(posted: string): string {
  const lower = posted.trim().toLowerCase();
  return UUID_V4_RE.test(lower) ? lower : crypto.randomUUID();
}

// ── Validation messages ─────────────────────────────────────────────────────

export { submissionErrorKey } from './regViewHtml';

/** The DOM id of the control a validation path belongs to (for focus and aria-describedby). */
export function fieldIdForPath(path: string): string {
  if (path === 'contact.name') return 'f-name';
  if (path === 'contact.email') return 'f-email';
  if (path === 'contact.phone') return 'f-phone';
  if (path === 'attendees') return 'f-party';
  const person = /^attendees\.(\d+)\.name$/.exec(path);
  if (person) return Number(person[1]) === 0 ? 'f-name' : `f-person-${person[1]}`;
  const question = /^q\.(\d+)$/.exec(path);
  if (question) return `f-q-${question[1]}`;
  return 'f-form';
}

// ── Party versus seats ──────────────────────────────────────────────────────

export type PartyFit = 'fits' | 'waitlist' | 'no_room';

/**
 * Whether a party of `partySize` fits the event now. Seats left = capacity - taken
 * (unlimited without a capacity). A party that does not fit joins the waitlist
 * together (free events that offer one); otherwise there is no room and the form
 * says so instead of bouncing the submit.
 */
export function partyFit(
  event: { capacity: number | null; taken_count: number; price_cents: number | null; waitlist_enabled: number },
  partySize: number,
): PartyFit {
  if (event.capacity === null) return 'fits';
  if (partySize <= event.capacity - event.taken_count) return 'fits';
  const free = event.price_cents === null || event.price_cents <= 0;
  return free && event.waitlist_enabled === 1 ? 'waitlist' : 'no_room';
}

/** Seats still free (null = unlimited). */
export function seatsLeft(event: { capacity: number | null; taken_count: number }): number | null {
  return event.capacity === null ? null : Math.max(0, event.capacity - event.taken_count);
}

// ── Redirect targets ────────────────────────────────────────────────────────

/** Where a freshly created registration lands. The token rides in the fragment only: it never reaches a server log. */
export function manageLanding(locale: string, token: string): string {
  return `/${locale}/register/manage?new=1#t=${token}`;
}

/** Where a replayed submission (the token exists only on the call that created the row) lands. */
export function myEventLanding(locale: string, registrationId: number | undefined): string {
  return registrationId === undefined ? `/${locale}/my/events` : `/${locale}/my/events/${registrationId}?new=1`;
}
