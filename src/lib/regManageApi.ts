// The registrant's own view of a registration and the actions on it, shared by the
// private manage API (authorized by the manage token) and /my/events/<id> (authorized
// by the signed-in owner). One builder produces the display-ready RegistrationView
// (no token, no hash, no internal ids beyond the attendee ids the actions need); one
// function runs an action and reports the outcome; the callers only authorize.
import type { AppDb } from './appDb';
import type { Locale } from './locales';
import { toUtcSql, formatDateWithWeekday, utcToDatetimeLocal } from './dates';
import { formatCents } from './money';
import { t } from './i18n';
import { registrationICalendar } from './ical';
import { decodeChoices, listQuestions } from './regDb';
import { registrationCampusSlug, registrationQrUrl } from './regEmails';
import {
  cancelAttendee,
  cancelRegistrationSelf,
  registrationSummary,
  updateRegistrationSelf,
  type RegistrationRef,
  type RegistrationSummary,
} from './regManage';
import { editFromBag, type FieldBag } from './regPublic';
import { toViewQuestion, type RegistrationView, type ViewError, type ViewQuestion } from './regViewHtml';

/** 'Sunday, July 5, 2026 18:00' (church time), with the end time when it is the same day. */
function whenText(startsAt: string, endsAt: string | null, locale: Locale): string {
  const [date, time] = utcToDatetimeLocal(startsAt).split('T');
  if (!date) return startsAt;
  const [endDate, endTime] = utcToDatetimeLocal(endsAt).split('T');
  const range = endTime && endDate === date ? `${time} – ${endTime}` : time;
  return `${formatDateWithWeekday(date, locale)} ${range}`;
}

/** The display-ready view of one registration in `locale`, or null when it does not exist. */
export async function buildRegistrationView(
  db: AppDb,
  registrationId: number,
  locale: Locale,
  now: string = toUtcSql(),
  summary?: RegistrationSummary | null,
): Promise<RegistrationView | null> {
  const s = summary ?? (await registrationSummary(db, registrationId, locale, now));
  if (!s) return null;
  const { event, registration: reg } = s;

  let questions: ViewQuestion[] = [];
  let personQuestions: ViewQuestion[] = [];
  const personValues = new Map<number, Record<string, string[]>>();
  const defs = await listQuestions(db, locale, event.id);
  // The summary's answer text is the stored value for yes/no and terms; the page shows them as people read them.
  const typeById = new Map(defs.map((q) => [q.id, q.type]));
  const readable = (a: { question_id: number; label: string; value: string }): { label: string; value: string } => {
    const type = typeById.get(a.question_id);
    return {
      label: a.label,
      value: type === 'yesno' ? t(locale, a.value === 'yes' ? 'register.yes' : 'register.no') : type === 'terms' ? t(locale, 'register.review.accepted') : a.value,
    };
  };
  if (s.canEdit) {
    const { results } = await db
      .prepare(`SELECT question_id, value FROM reg_answers WHERE registration_id = ?1`)
      .bind(registrationId)
      .all<{ question_id: number; value: string }>();
    const stored = new Map(results.map((r) => [r.question_id, r.value]));
    const valueOf = (q: { id: number; type: string }, raw: string | undefined): string[] =>
      raw === undefined ? [] : q.type === 'checkbox' ? decodeChoices(raw) : [raw];
    // Both scopes keep their section headings (a heading shows where the questions it introduces start).
    questions = defs.filter((q) => q.scope === 'registration').map((q) => toViewQuestion(q, valueOf(q, stored.get(q.id))));
    personQuestions = defs.filter((q) => q.scope === 'attendee').map((q) => toViewQuestion(q));
    if (personQuestions.length > 0) {
      const { results: given } = await db
        .prepare(
          `SELECT aa.attendee_id AS attendee_id, aa.question_id AS question_id, aa.value AS value
           FROM reg_attendee_answers aa JOIN reg_attendees a ON a.id = aa.attendee_id
           WHERE a.registration_id = ?1`,
        )
        .bind(registrationId)
        .all<{ attendee_id: number; question_id: number; value: string }>();
      const byId = new Map(defs.map((q) => [q.id, q]));
      for (const row of given) {
        const q = byId.get(row.question_id);
        if (!q) continue;
        const mine = personValues.get(row.attendee_id) ?? personValues.set(row.attendee_id, {}).get(row.attendee_id)!;
        mine[String(row.question_id)] = valueOf(q, row.value);
      }
    }
  }

  const paid = reg.amount_cents > 0;
  return {
    event: {
      id: event.id,
      title: event.title,
      when: whenText(event.starts_at, event.ends_at, locale),
      where: event.location,
      notes: event.notes,
      // With ticket types the event price is ignored (each person's own price is on their line), so it is not shown.
      priceText: s.attendees.some((a) => a.ticket_type_id !== null)
        ? null
        : event.price_cents !== null && event.price_cents > 0 ? formatCents(event.price_cents, event.currency, locale) : t(locale, 'register.free'),
    },
    registration: {
      confirmationNo: reg.confirmation_no,
      status: reg.status,
      name: reg.name,
      email: reg.email,
      phone: reg.phone,
      partySize: reg.party_size,
      amountText: paid ? formatCents(reg.amount_cents, reg.currency, locale) : null,
      paid,
    },
    qrUrl: registrationQrUrl('', event.id, reg.confirmation_no, await registrationCampusSlug(db, registrationId)),
    attendees: s.attendees.map((a) => ({
      id: a.id,
      name: a.name,
      active: a.status === 'active',
      ticketText: a.ticket_label
        ? (a.ticket_price_cents ?? 0) > 0 ? `${a.ticket_label} · ${formatCents(a.ticket_price_cents!, reg.currency, locale)}` : a.ticket_label
        : null,
      answers: a.answers.map(readable),
      ...(s.canEdit ? { values: personValues.get(a.id) ?? {} } : {}),
    })),
    // Answers show for the people who gave them; the labels are localized by the summary.
    answers: s.answers.map(readable),
    questions,
    personQuestions,
    canEdit: s.canEdit,
    canCancel: s.canCancel,
  };
}

export type ManageAction =
  | { action: 'view' }
  | { action: 'update'; fields: FieldBag }
  | { action: 'cancel_attendee'; attendeeId: number }
  | { action: 'cancel_all' }
  | { action: 'ics'; host: string };

export type ManageOutcome =
  | { kind: 'view'; view: RegistrationView; notice: 'saved' | 'cancelled' | null }
  | { kind: 'ics'; filename: string; content: string }
  | { kind: 'invalid'; errors: ViewError[]; view: RegistrationView }
  | { kind: 'not_allowed'; view: RegistrationView | null }
  | { kind: 'not_found' };

/** What runs after seats are released: email the cancelled registrant and everyone promoted. */
export type NotifyRelease = (input: { cancelledId?: number; attendeeName?: string; promoted: number[] }) => Promise<void>;

/**
 * Run one registrant action against a registration they are already authorized for.
 * Writes go through regManage (which enforces the open-or-preview and allow_self_edit
 * rule again). A cancel on a registration that goes on carries the person's name to
 * the notification; cancelling the last person (or everyone) is a plain cancellation.
 */
export async function performManageAction(
  db: AppDb,
  ref: RegistrationRef,
  locale: Locale,
  request: ManageAction,
  notify: NotifyRelease,
  now: string = toUtcSql(),
): Promise<ManageOutcome> {
  const current = await registrationSummary(db, ref.id, locale, now);
  if (!current) return { kind: 'not_found' };
  const reload = async (notice: 'saved' | 'cancelled' | null): Promise<ManageOutcome> => {
    const view = await buildRegistrationView(db, ref.id, locale, now);
    return view ? { kind: 'view', view, notice } : { kind: 'not_found' };
  };

  if (request.action === 'view') return reload(null);

  if (request.action === 'ics') {
    return {
      kind: 'ics',
      filename: 'event.ics',
      content: registrationICalendar(
        {
          id: ref.id,
          title: current.event.title,
          starts_at: current.event.starts_at,
          ends_at: current.event.ends_at,
          location: current.event.location,
          description: [current.registration.confirmation_no, current.event.notes].filter(Boolean).join('\n'),
        },
        request.host,
      ),
    };
  }

  if (request.action === 'update') {
    const result = await updateRegistrationSelf(db, ref.id, editFromBag(request.fields), now);
    if (!result.ok) {
      const notAllowed = result.errors.some((e) => e.path === '' && (e.code === 'not_allowed' || e.code === 'not_found'));
      const view = await buildRegistrationView(db, ref.id, locale, now);
      if (notAllowed) return { kind: 'not_allowed', view };
      return view ? { kind: 'invalid', errors: result.errors, view } : { kind: 'not_found' };
    }
    return reload('saved');
  }

  if (request.action === 'cancel_attendee') {
    const person = current.attendees.find((a) => a.id === request.attendeeId && a.status === 'active');
    if (!person) return { kind: 'not_allowed', view: await buildRegistrationView(db, ref.id, locale, now) };
    const result = await cancelAttendee(db, ref.id, person.id, now);
    if (!result.ok) return { kind: 'not_allowed', view: await buildRegistrationView(db, ref.id, locale, now) };
    await notify({
      cancelledId: ref.id,
      ...(result.registrationCancelled ? {} : { attendeeName: person.name }),
      promoted: result.promoted,
    });
    return reload(result.registrationCancelled ? 'cancelled' : null);
  }

  const result = await cancelRegistrationSelf(db, ref.id, now);
  if (!result.ok) return { kind: 'not_allowed', view: await buildRegistrationView(db, ref.id, locale, now) };
  await notify({ cancelledId: ref.id, promoted: result.promoted });
  return reload('cancelled');
}
