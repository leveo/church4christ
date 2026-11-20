// The roster exports beyond the per-registration CSV in regDb.ts: one row PER PERSON (a family of four is four
// rows), for name tags, door lists and mail merges. Every cell goes through csvCell (formula injection is
// neutralized); the route adds the UTF-8 byte-order mark so Excel reads accents and Chinese correctly.
import type { AppDb } from './appDb';
import { csvCell } from './csv';
import type { Locale } from './locales';
import { answerDisplayText, listQuestions, listTicketTypes } from './regDb';

/** UTF-8 byte-order mark, written before the first header cell of every roster CSV. */
export const CSV_BOM = '﻿';

/**
 * Header: Confirmation, Person, Ticket type, Status, Contact name, Email, Phone, Checked in, Registered, then one
 * column per once-per-registration question (the registration's answer repeated on each of its people) and one
 * per per-person question (that person's own answer). Rows: every ACTIVE person of every registration, newest
 * registration first, people in form order. Labels and option names are in `locale`.
 */
export async function registrationPeopleCsv(db: AppDb, locale: Locale, eventId: number): Promise<string> {
  const questions = (await listQuestions(db, locale, eventId)).filter((q) => q.type !== 'section');
  const regQuestions = questions.filter((q) => q.scope === 'registration');
  const personQuestions = questions.filter((q) => q.scope === 'attendee');
  const tickets = new Map((await listTicketTypes(db, locale, eventId)).map((t) => [t.id, t.label]));

  const { results: people } = await db
    .prepare(
      `SELECT a.id AS id, a.name AS person, a.ticket_type_id AS ticket_type_id,
              r.id AS registration_id, r.confirmation_no AS confirmation_no, r.status AS status, r.name AS contact_name,
              r.email AS email, r.phone AS phone, r.created_at AS created_at,
              c.checked_in_at AS checked_in_at, c.checked_out_at AS checked_out_at
       FROM reg_attendees a
       JOIN registrations r ON r.id = a.registration_id
       LEFT JOIN reg_checkins c ON c.attendee_id = a.id
       WHERE r.event_id = ?1 AND a.status = 'active'
       ORDER BY r.created_at DESC, r.id DESC, a.sort, a.id`,
    )
    .bind(eventId)
    .all<{
      id: number; person: string; ticket_type_id: number | null; registration_id: number; confirmation_no: string | null;
      status: string; contact_name: string; email: string; phone: string | null; created_at: string;
      checked_in_at: string | null; checked_out_at: string | null;
    }>();
  const { results: regAnswers } = await db
    .prepare(`SELECT a.registration_id AS registration_id, a.question_id AS question_id, a.value AS value FROM reg_answers a JOIN registrations r ON r.id = a.registration_id WHERE r.event_id = ?1`)
    .bind(eventId)
    .all<{ registration_id: number; question_id: number; value: string }>();
  const { results: personAnswers } = await db
    .prepare(
      `SELECT aa.attendee_id AS attendee_id, aa.question_id AS question_id, aa.value AS value
       FROM reg_attendee_answers aa JOIN reg_attendees a ON a.id = aa.attendee_id JOIN registrations r ON r.id = a.registration_id WHERE r.event_id = ?1`,
    )
    .bind(eventId)
    .all<{ attendee_id: number; question_id: number; value: string }>();
  const byReg = new Map<number, Map<number, string>>();
  for (const a of regAnswers) (byReg.get(a.registration_id) ?? byReg.set(a.registration_id, new Map()).get(a.registration_id)!).set(a.question_id, a.value);
  const byPerson = new Map<number, Map<number, string>>();
  for (const a of personAnswers) (byPerson.get(a.attendee_id) ?? byPerson.set(a.attendee_id, new Map()).get(a.attendee_id)!).set(a.question_id, a.value);

  const header = [
    'Confirmation', 'Person', 'Ticket type', 'Status', 'Contact name', 'Email', 'Phone', 'Checked in', 'Registered',
    ...regQuestions.map((q) => q.label), ...personQuestions.map((q) => q.label),
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const p of people) {
    const mine = byReg.get(p.registration_id);
    const own = byPerson.get(p.id);
    const cells = [
      p.confirmation_no ?? '', p.person, p.ticket_type_id === null ? '' : (tickets.get(p.ticket_type_id) ?? ''), p.status,
      p.contact_name, p.email, p.phone ?? '', p.checked_in_at !== null && p.checked_out_at === null ? 'yes' : 'no', p.created_at,
      ...regQuestions.map((q) => (mine?.get(q.id) === undefined ? '' : answerDisplayText(q, mine.get(q.id)!))),
      ...personQuestions.map((q) => (own?.get(q.id) === undefined ? '' : answerDisplayText(q, own.get(q.id)!))),
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return lines.join('\r\n');
}
