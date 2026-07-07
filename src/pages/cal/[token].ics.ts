// Public, token-authenticated iCal feed of a person's serving schedule (route
// policy: /cal/ is a public prefix; the token IS the credential). Subscribed to
// by Google/Apple Calendar, so magic-link-only volunteers still see their
// dates. Regenerating people.calendar_token revokes the subscription. Ported
// from the reference stack's src/pages/cal/[token].ics.ts, adapted to church-cms: names
// come from the *_i18n companion tables (English — calendar clients cache one
// feed for everyone), and the UID host derives from APP_ORIGIN.
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { buildICal, type ICalEvent } from '../../lib/ical';
import { i18nJoin } from '../../lib/db';
import { addDays, todayInTz } from '../../lib/dates';

export const GET: APIRoute = async ({ params, url, locals }) => {
  const token = params.token ?? '';
  const vars = env as unknown as { APP_ORIGIN?: string };
  const db = locals.db;
  if (!token) return new Response('Not found', { status: 404 });

  const person = await db
    .prepare(`SELECT id, display_name FROM people WHERE calendar_token = ? AND active = 1 AND deleted_at IS NULL`)
    .bind(token)
    .first<{ id: number; display_name: string }>();
  if (!person) return new Response('Not found', { status: 404 });

  // Rolling window: 30 days of history (so a subscriber keeps recent context)
  // through every future non-declined assignment.
  const from = addDays(todayInTz(), -30);
  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], 'en');
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], 'en');
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], 'en');
  const { results } = await db
    .prepare(
      `SELECT ra.id AS id, plans.plan_date AS plan_date, ra.status AS status,
              COALESCE(pos_l.name, pos_d.name) AS position_name,
              COALESCE(tm_l.name, tm_d.name) AS team_name,
              COALESCE(st_l.name, st_d.name) AS service_name,
              st.start_time AS start_time, st.end_time AS end_time
       FROM roster_assignments ra
       JOIN plans ON plans.id = ra.plan_id AND plans.deleted_at IS NULL
       JOIN service_types st ON st.id = plans.service_type_id
       ${stJ.joins}
       JOIN positions pos ON pos.id = ra.position_id
       ${posJ.joins}
       JOIN teams tm ON tm.id = pos.team_id
       ${tmJ.joins}
       WHERE ra.person_id = ?1 AND ra.status != 'D' AND ra.deleted_at IS NULL
         AND plans.plan_date >= ?2
       ORDER BY plans.plan_date, ra.id`,
    )
    .bind(person.id, from)
    .all<{
      id: number;
      plan_date: string;
      status: string;
      position_name: string;
      team_name: string;
      service_name: string;
      start_time: string | null;
      end_time: string | null;
    }>();

  // Stable UID domain: the configured origin's host (falls back to the request
  // host in dev), so UIDs survive across requests and deploys.
  let host = url.host;
  try {
    if (vars.APP_ORIGIN) host = new URL(vars.APP_ORIGIN).host || host;
  } catch {
    /* malformed APP_ORIGIN — keep the request host */
  }

  const events: ICalEvent[] = results.map((r) => ({
    uid: `c4c-assignment-${r.id}@${host}`,
    date: r.plan_date,
    summary: `${r.position_name} — ${r.service_name}${r.status === 'U' ? ' (?)' : ''}`,
    description: `${r.team_name} · ${r.service_name}`,
    startTime: r.start_time,
    endTime: r.end_time,
  }));

  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}T000000Z`;
  const ics = buildICal(`Church4Christ Serve — ${person.display_name}`, events, stamp);

  return new Response(ics, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'content-disposition': 'inline; filename="church4christ-serve.ics"',
    },
  });
};
