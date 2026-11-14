// Parsers for the Service Planning forms. Pure: they take FormData / query
// params and return validated, trimmed values or a map of field -> dictionary key.
import { isValidDateStr, addDays } from './dates';
import { ITEM_KINDS, type EventInput, type ItemInput, type SessionInput } from './planningDb';
import { MAX_ITEM_MINUTES, MAX_SEARCH_DAYS, parseHM, serializeWeekdays } from './planningModel';

export type FormResult<T> = { ok: true; data: T } | { ok: false; errors: Record<string, string> };

const ERR = {
  title: 'planning.err.title',
  date: 'planning.err.date',
  time: 'planning.err.time',
  endBefore: 'planning.err.endBeforeStart',
  duration: 'planning.err.duration',
  window: 'planning.err.window',
  range: 'planning.err.range',
} as const;

const text = (fd: FormData | URLSearchParams, key: string, max = 2000): string =>
  String(fd.get(key) ?? '').trim().slice(0, max);

const idOrNull = (value: string): number | null => (/^\d{1,12}$/.test(value) && Number(value) > 0 ? Number(value) : null);

const hmOrNull = (value: string): string | null => (parseHM(value) !== null ? value.padStart(5, '0') : null);

export function parseEventForm(fd: FormData): FormResult<EventInput> {
  const errors: Record<string, string> = {};
  const title_en = text(fd, 'title_en', 200);
  const title_zh = text(fd, 'title_zh', 200);
  if (!title_en && !title_zh) errors.title_en = ERR.title;
  const event_date = text(fd, 'event_date');
  if (!isValidDateStr(event_date)) errors.event_date = ERR.date;
  const start = hmOrNull(text(fd, 'start_time'));
  if (start === null) errors.start_time = ERR.time;
  const endRaw = text(fd, 'end_time');
  const end = endRaw === '' ? null : hmOrNull(endRaw);
  if (endRaw !== '' && end === null) errors.end_time = ERR.time;
  else if (start !== null && end !== null && end <= start) errors.end_time = ERR.endBefore;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      title_en,
      title_zh,
      event_date,
      start_time: start!,
      end_time: end,
      location_en: text(fd, 'location_en', 200),
      location_zh: text(fd, 'location_zh', 200),
      notes_en: text(fd, 'notes_en'),
      notes_zh: text(fd, 'notes_zh'),
      plan_id: idOrNull(text(fd, 'plan_id')),
    },
  };
}

export function parseItemForm(fd: FormData): FormResult<ItemInput> {
  const errors: Record<string, string> = {};
  const title_en = text(fd, 'title_en', 200);
  const title_zh = text(fd, 'title_zh', 200);
  if (!title_en && !title_zh) errors.title_en = ERR.title;
  const kindRaw = text(fd, 'kind');
  const kind = ITEM_KINDS.find((k) => k === kindRaw) ?? 'segment';
  const durationRaw = text(fd, 'duration_min') || '0';
  const duration = Number(durationRaw);
  if (!/^\d{1,4}$/.test(durationRaw) || duration > MAX_ITEM_MINUTES) errors.duration_min = ERR.duration;
  const fixedRaw = text(fd, 'fixed_start_time');
  const fixed = fixedRaw === '' ? null : hmOrNull(fixedRaw);
  if (fixedRaw !== '' && fixed === null) errors.fixed_start_time = ERR.time;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      kind,
      duration_min: duration,
      fixed_start_time: fixed,
      title_en,
      title_zh,
      details_en: text(fd, 'details_en'),
      details_zh: text(fd, 'details_zh'),
      owner_team_id: idOrNull(text(fd, 'owner_team_id')),
      owner_person_id: idOrNull(text(fd, 'owner_person_id')),
      owner_label: text(fd, 'owner_label', 120) || null,
      cue_notes: text(fd, 'cue_notes'),
    },
  };
}

export function parseSessionForm(fd: FormData): FormResult<SessionInput> {
  const errors: Record<string, string> = {};
  const title_en = text(fd, 'title_en', 200);
  const title_zh = text(fd, 'title_zh', 200);
  if (!title_en && !title_zh) errors.title_en = ERR.title;
  const session_date = text(fd, 'session_date');
  if (!isValidDateStr(session_date)) errors.session_date = ERR.date;
  const start = hmOrNull(text(fd, 'start_time'));
  const end = hmOrNull(text(fd, 'end_time'));
  if (start === null) errors.start_time = ERR.time;
  if (end === null) errors.end_time = ERR.time;
  else if (start !== null && end <= start) errors.end_time = ERR.endBefore;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      title_en,
      title_zh,
      session_date,
      start_time: start!,
      end_time: end!,
      location_en: text(fd, 'location_en', 200),
      location_zh: text(fd, 'location_zh', 200),
      note_en: text(fd, 'note_en'),
      note_zh: text(fd, 'note_zh'),
    },
  };
}

export interface AvailabilityFormData {
  starts_on: string;
  ends_on: string;
  weekdays: number[];
  start_minute: number;
  end_minute: number;
  note: string;
}

/** A one-off window (a single date) or a weekly one (a range plus weekdays). */
export function parseAvailabilityForm(fd: FormData): FormResult<AvailabilityFormData> {
  const errors: Record<string, string> = {};
  const starts_on = text(fd, 'starts_on');
  const ends_on = text(fd, 'ends_on') || starts_on;
  if (!isValidDateStr(starts_on) || !isValidDateStr(ends_on) || ends_on < starts_on) errors.starts_on = ERR.date;
  else if (ends_on > addDays(starts_on, 400)) errors.ends_on = ERR.range;
  const start = parseHM(text(fd, 'start_time'));
  const end = parseHM(text(fd, 'end_time'));
  if (start === null || end === null || end <= start) errors.start_time = ERR.window;
  const weekdays = fd
    .getAll('weekday')
    .map((v) => String(v))
    .filter((v) => /^[0-6]$/.test(v))
    .map(Number);
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: {
      starts_on,
      ends_on,
      weekdays: serializeWeekdays(weekdays).split(',').filter(Boolean).map(Number),
      start_minute: start!,
      end_minute: end!,
      note: text(fd, 'note', 300),
    },
  };
}

export interface FindTimeQuery {
  dateFrom: string;
  dateTo: string;
  durationMin: number;
  weekdays: number[];
  earliestMin: number;
  latestMin: number;
}

/** Find-a-time query: at most 31 days, 15..600 minutes, optional weekdays and time bounds. */
export function parseFindTimeQuery(params: URLSearchParams): FormResult<FindTimeQuery> {
  const errors: Record<string, string> = {};
  const dateFrom = text(params, 'from');
  const dateTo = text(params, 'to') || dateFrom;
  if (!isValidDateStr(dateFrom) || !isValidDateStr(dateTo) || dateTo < dateFrom) errors.from = ERR.date;
  else if (dateTo > addDays(dateFrom, MAX_SEARCH_DAYS - 1)) errors.to = ERR.range;
  const duration = Number(text(params, 'duration') || '90');
  if (!Number.isInteger(duration) || duration < 15 || duration > 600) errors.duration = ERR.duration;
  const earliest = parseHM(text(params, 'earliest') || '08:00');
  const latest = parseHM(text(params, 'latest') || '21:00');
  if (earliest === null || latest === null || latest <= earliest) errors.earliest = ERR.time;
  const weekdays = params
    .getAll('weekday')
    .filter((v) => /^[0-6]$/.test(v))
    .map(Number);
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    data: { dateFrom, dateTo, durationMin: duration, weekdays, earliestMin: earliest!, latestMin: latest! },
  };
}
