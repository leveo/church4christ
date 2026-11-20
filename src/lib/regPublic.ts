// Public registration flow, server-side helpers shared by the register page (form
// and review step), the member submit endpoint and the guest continuation start:
// turning a posted form into the shared SubmissionInput, mapping validation codes to
// copy, echoing the form's identity fields safely, and the party-versus-seats rule.
// Pure functions only (no database, no Astro), so they unit-test directly.
import type { RegQuestion } from './regDb';
import type { SelfEditInput, SubmissionInput } from './regManage';
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

/** The per-row form fields: the chosen ticket type (`ticket_<row>`) and one person's answer to a per-person question (`pq_<row>_<questionId>`). */
export const ticketField = (row: number): string => `ticket_${row}`;
export const personAnswerField = (row: number, questionId: number): string => `pq_${row}_${questionId}`;
/** The edit form's per-person answer field (`pa_<attendeeId>_<questionId>`) and its marker (`pa_<attendeeId>`: this person's answers are in the form). */
export const attendeeAnswerField = (attendeeId: number, questionId: number): string => `pa_${attendeeId}_${questionId}`;
export const attendeeAnswersMarker = (attendeeId: number): string => `pa_${attendeeId}`;

/**
 * Read a registration form: the contact, the people (row 0 is the contact person and
 * is sent blank, which validateSubmission reads as the contact's own name; rows
 * 1..max-1 come from `person_name_<i>` / `person_id_<i>`), each row's ticket type
 * (`ticket_<i>`) and per-person answers (`pq_<i>_<questionId>`), and the answers to the
 * once-per-registration questions (keyed by question id). `contact` overrides the posted
 * name/email (a signed-in member's are their account's). Nothing here validates; run
 * validateSubmission on the result.
 */
export function submissionFromBag(
  bag: FieldBag,
  questions: RegQuestion[],
  maxPartySize: number,
  contact?: { name: string; email: string },
): SubmissionInput {
  const rows = partyRowCount(maxPartySize);
  const personQuestions = questions.filter((q) => q.scope === 'attendee' && q.type !== 'section');
  const extras = (row: number): { ticketTypeId?: string; answers?: Record<string, string[]> } => {
    const out: { ticketTypeId?: string; answers?: Record<string, string[]> } = {};
    const ticket = bag[ticketField(row)];
    if (ticket !== undefined) out.ticketTypeId = ticket[0] ?? '';
    if (personQuestions.length > 0) {
      out.answers = {};
      for (const question of personQuestions) out.answers[String(question.id)] = bag[personAnswerField(row, question.id)] ?? [];
    }
    return out;
  };
  const attendees: NonNullable<SubmissionInput['attendees']> = [{ name: '', ...extras(0) }];
  for (let i = 1; i < rows; i++) {
    const personId = Number(bagFirst(bag, `person_id_${i}`));
    attendees.push({
      name: bagFirst(bag, `person_name_${i}`),
      personId: Number.isSafeInteger(personId) && personId > 0 ? personId : null,
      ...extras(i),
    });
  }
  const answers: Record<string, string[]> = {};
  for (const question of questions) if (question.scope === 'registration') answers[String(question.id)] = bag[String(question.id)] ?? [];
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

/** The member's edit form: contact name and phone, each person's name (`attendee_<id>`), each person's
 *  full per-person answer set (`pa_<id>_<questionId>`, with the `pa_<id>` marker so an all-cleared set still
 *  counts as edited) and the full registration answer set (`a_<questionId>`). Always carries an answers
 *  object, so a cleared checkbox group is read as "nothing chosen" rather than "not edited". */
export function editFromBag(bag: FieldBag): SelfEditInput {
  const attendees: Array<{ id: number; name: string; answers?: Record<string, string[]> }> = [];
  const personAnswers = new Map<number, Record<string, string[]>>();
  const answers: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(bag)) {
    const person = /^attendee_(\d{1,12})$/.exec(key);
    if (person) attendees.push({ id: Number(person[1]), name: values[0] ?? '' });
    const answer = /^a_(\d{1,12})$/.exec(key);
    if (answer) answers[answer[1]] = values;
    const marker = /^pa_(\d{1,12})$/.exec(key);
    if (marker && !personAnswers.has(Number(marker[1]))) personAnswers.set(Number(marker[1]), {});
    const personAnswer = /^pa_(\d{1,12})_(\d{1,12})$/.exec(key);
    if (personAnswer) {
      const id = Number(personAnswer[1]);
      (personAnswers.get(id) ?? personAnswers.set(id, {}).get(id)!)[personAnswer[2]] = values;
    }
  }
  for (const attendee of attendees) {
    const mine = personAnswers.get(attendee.id);
    if (mine) attendee.answers = mine;
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
  const ticket = /^attendees\.(\d+)\.ticket$/.exec(path);
  if (ticket) return `f-ticket-${ticket[1]}`;
  const personQuestion = /^attendees\.(\d+)\.q\.(\d+)$/.exec(path);
  if (personQuestion) return `f-pq-${personQuestion[1]}-${personQuestion[2]}`;
  const question = /^q\.(\d+)$/.exec(path);
  if (question) return `f-q-${question[1]}`;
  return 'f-form';
}

// ── Party versus seats ──────────────────────────────────────────────────────

export type PartyFit = 'fits' | 'waitlist' | 'no_room';

/** The ticket types' seat counts the fit rule needs (see listTicketTypes). */
export type FitTicketType = { id: number; seats_left: number | null };

/**
 * Whether a party of `partySize` fits the event now. Seats left = capacity - taken
 * (unlimited without a capacity), and each ticket type's own limit holds the people
 * of that type (`picks` = the ticket type id of each person). A party that does not
 * fit joins the waitlist together (free events that offer one); otherwise there is
 * no room and the form says so instead of bouncing the submit. `free` overrides the
 * event price test: an event with ticket types is free when the party's total is 0.
 */
export function partyFit(
  event: { capacity: number | null; taken_count: number; price_cents: number | null; waitlist_enabled: number },
  partySize: number,
  opts: { types?: readonly FitTicketType[]; picks?: ReadonlyArray<number | null>; free?: boolean } = {},
): PartyFit {
  const eventFits = event.capacity === null || partySize <= event.capacity - event.taken_count;
  const counts = new Map<number, number>();
  for (const pick of opts.picks ?? []) if (pick != null) counts.set(pick, (counts.get(pick) ?? 0) + 1);
  const typesFit = (opts.types ?? []).every((type) => type.seats_left === null || (counts.get(type.id) ?? 0) <= type.seats_left);
  if (eventFits && typesFit) return 'fits';
  const free = opts.free ?? (event.price_cents === null || event.price_cents <= 0);
  return free && event.waitlist_enabled === 1 ? 'waitlist' : 'no_room';
}

/** Seats still free (null = unlimited). With ticket types that are ALL limited the seats cannot exceed their total. */
export function seatsLeft(
  event: { capacity: number | null; taken_count: number },
  types: readonly Pick<FitTicketType, 'seats_left'>[] = [],
): number | null {
  const eventLeft = event.capacity === null ? null : Math.max(0, event.capacity - event.taken_count);
  if (types.length === 0 || types.some((type) => type.seats_left === null)) return eventLeft;
  const typed = types.reduce((sum, type) => sum + (type.seats_left ?? 0), 0);
  return eventLeft === null ? typed : Math.min(eventLeft, typed);
}

// ── Redirect targets ────────────────────────────────────────────────────────

/** Where a freshly created registration lands. The token rides in the fragment only: it never reaches a server log. */
export function manageLanding(locale: string, token: string, campusSlug?: string | null): string {
  return `/${locale}/register/manage?new=1${campusSlug ? `&campus=${encodeURIComponent(campusSlug)}` : ''}#t=${token}`;
}

/** Where a replayed submission (the token exists only on the call that created the row) lands. */
export function myEventLanding(locale: string, registrationId: number | undefined): string {
  return registrationId === undefined ? `/${locale}/my/events` : `/${locale}/my/events/${registrationId}?new=1`;
}
