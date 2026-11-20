// The registration form builder's save endpoint, kept out of the Astro page so it can be tested against a
// real database: parse the island's JSON, run saveEventForm (validation + one batch), and answer with the
// stored questions and ticket types so the island can adopt server ids and generated option keys.
import type { AppDb } from './appDb';
import type { DbBackend } from './dbProvider';
import type { Locale } from './locales';
import { listQuestionsAdmin, listTicketTypesAdmin, saveEventForm, type FormError, type RegQuestionAdmin, type RegTicketTypeAdmin } from './regDb';

export type FormSaveResponse =
  | { status: 200; body: { ok: true; questions: RegQuestionAdmin[]; tickets: RegTicketTypeAdmin[] } }
  | { status: 400 | 404 | 422; body: { ok: false; error: 'bad_request' | 'not_found' | 'invalid'; errors?: FormError[] } };

/** Save one event's (or template's) questions and ticket types from the builder's JSON body. */
export async function saveFormRequest(
  db: AppDb,
  eventId: number,
  rawBody: string,
  opts: { backend: DbBackend; defaultLocale: Locale },
): Promise<FormSaveResponse> {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { ok: false, error: 'bad_request' } };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { status: 400, body: { ok: false, error: 'bad_request' } };
  const result = await saveEventForm(db, eventId, payload, opts);
  if (!result.ok) {
    if (result.errors.some((e) => e.code === 'event_not_found')) return { status: 404, body: { ok: false, error: 'not_found' } };
    return { status: 422, body: { ok: false, error: 'invalid', errors: result.errors } };
  }
  const [questions, tickets] = await Promise.all([listQuestionsAdmin(db, eventId), listTicketTypesAdmin(db, eventId)]);
  return { status: 200, body: { ok: true, questions, tickets } };
}
