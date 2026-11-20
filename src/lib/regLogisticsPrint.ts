// The gate every event-logistics print runs (room list, door signs, table list, table cards, group list). The
// route class is `regEventStaff` and the middleware has already required 'view' on the event in the URL; this
// checks it again, then the module (event-logistics on for the campus), the event (a real event, not a template)
// and the event's own switch for the area. Anything else is a plain 404, so a print of an area that is off looks
// like a page that does not exist. Prints show names only: never an email, a phone or an answer.
import type { AppDb } from './appDb';
import type { Locale } from './locales';
import type { SessionUser } from './types';
import { logisticsModuleEnabled } from './modules';
import { requireRegRole } from './regAccess';
import { getEventAdmin } from './regDb';
import { getLogisticsSettings, listLogisticsPeople, type LogisticsArea } from './regLogistics';

export interface LogisticsPrintContext {
  eventId: number;
  lang: Locale;
  eventTitle: string;
  /** Attendee id -> name, for everyone still on the event. */
  names: Map<number, string>;
}

export async function logisticsPrintGate(
  locals: { user: SessionUser | null | undefined; db: AppDb; modules: ReadonlySet<string>; locales: { default: Locale } },
  rawId: string | undefined,
  area: LogisticsArea,
): Promise<LogisticsPrintContext | Response> {
  const user = locals.user ?? null;
  if (!user) return new Response(null, { status: 403 });
  if (!/^\d{1,15}$/.test(rawId ?? '')) return new Response(null, { status: 404 });
  const eventId = Number(rawId);
  const role = await requireRegRole(locals.db, user, eventId, 'view');
  if (!role.ok) return new Response(null, { status: role.status });
  if (!logisticsModuleEnabled(locals.modules)) return new Response(null, { status: 404 });
  const event = await getEventAdmin(locals.db, eventId);
  if (!event || event.is_template === 1) return new Response(null, { status: 404 });
  const settings = await getLogisticsSettings(locals.db, eventId);
  if (!settings || !settings[area]) return new Response(null, { status: 404 });
  const lang: Locale = user.lang ?? 'en';
  const people = await listLogisticsPeople(locals.db, eventId);
  return {
    eventId,
    lang,
    eventTitle: event.titles[lang] || event.titles[locals.locales.default] || event.title_en || `#${eventId}`,
    names: new Map(people.map((p) => [p.attendeeId, p.name])),
  };
}
