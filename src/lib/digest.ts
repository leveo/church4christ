// Scheduled serving mail: the daily reminder pass and the weekly digest, both
// fired by the crons in worker.ts and both gated by the email_rules toggles the
// admin Email tab controls. Ported from the reference stack's src/lib/digest.ts, adapted to
// church-cms: names come from *_i18n companion tables (English used for the mail
// variables), sendEmail takes (env, db, msg), and dates run in America/Chicago.
import { addDays, todayInTz } from './dates';
import { i18nJoin } from './db';
import { escapeHtml, sendEmail, type EmailEnv } from './email';
import { isRuleEnabled } from './emailSettingsDb';
import { t } from './i18n';
import { type Locale } from './locales';
import { sendSchedulingRequest } from './notify';

const TZ = 'America/Chicago';

interface DigestRow {
  person_id: number;
  person_name: string;
  email: string;
  lang: string | null;
  plan_date: string;
  status: 'U' | 'C';
  position_name: string;
  team_name: string;
  service_type_name: string;
}

/**
 * Weekly digest (Thursday cron): one email per person listing their non-declined
 * assignments in the next 7 days. Gated by the `digestAM` rule. Returns the
 * recipient emails (for logging/tests). One bad recipient never stops the rest.
 */
export async function sendWeeklyDigest(env: EmailEnv, db: D1Database, now: Date = new Date()): Promise<string[]> {
  if (!(await isRuleEnabled(db, 'digestAM'))) return [];

  const start = todayInTz(TZ, now);
  const end = addDays(start, 7);
  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], 'en');
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], 'en');
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], 'en');
  const { results } = await db
    .prepare(
      `SELECT people.id AS person_id, people.display_name AS person_name, people.email AS email, people.lang AS lang,
              plans.plan_date AS plan_date, ra.status AS status,
              COALESCE(pos_l.name, pos_d.name) AS position_name,
              COALESCE(tm_l.name, tm_d.name) AS team_name,
              COALESCE(st_l.name, st_d.name) AS service_type_name
       FROM roster_assignments ra
       JOIN people ON people.id = ra.person_id
         AND people.email IS NOT NULL AND people.active = 1 AND people.deleted_at IS NULL
       JOIN plans ON plans.id = ra.plan_id AND plans.deleted_at IS NULL
       JOIN service_types st ON st.id = plans.service_type_id
       ${stJ.joins}
       JOIN positions pos ON pos.id = ra.position_id
       ${posJ.joins}
       JOIN teams tm ON tm.id = pos.team_id
       ${tmJ.joins}
       WHERE ra.status != 'D' AND ra.deleted_at IS NULL
         AND plans.plan_date >= ?1 AND plans.plan_date < ?2
       ORDER BY people.id, plans.plan_date`,
    )
    .bind(start, end)
    .all<DigestRow>();

  const byPerson = new Map<number, DigestRow[]>();
  for (const row of results) {
    const list = byPerson.get(row.person_id) ?? [];
    list.push(row);
    byPerson.set(row.person_id, list);
  }

  const origin = env.APP_ORIGIN ?? '';
  const sent: string[] = [];
  for (const rows of byPerson.values()) {
    const { person_name, email } = rows[0];
    const only = rows[0].lang === 'en' || rows[0].lang === 'zh' ? (rows[0].lang as Locale) : null;
    const langs: Locale[] = only ? [only] : ['zh', 'en'];
    const lines = rows.map((r) => {
      const respond = r.status === 'U' ? ' ' + langs.map((l) => t(l, 'email.digestRespond')).join(' ') : '';
      return `${r.plan_date} — ${r.position_name} (${r.team_name}) · ${r.service_type_name}${respond}`;
    });
    // HTML branch only: position/team/service names are leader-editable free
    // text, so they must be escaped before interpolation into markup (the
    // plain-text branch above stays raw; t() output is trusted dictionary copy).
    const htmlLines = rows.map((r) => {
      const respond = r.status === 'U' ? ' ' + langs.map((l) => t(l, 'email.digestRespond')).join(' ') : '';
      return `${r.plan_date} — ${escapeHtml(r.position_name)} (${escapeHtml(r.team_name)}) · ${escapeHtml(r.service_type_name)}${respond}`;
    });
    const intro = langs.map((l) => t(l, 'email.digestIntro', { name: person_name })).join('\n');
    const footer = langs.map((l) => t(l, 'email.digestFooter')).join(' ');
    const link = `${origin}/${only ?? 'en'}/my`;
    try {
      await sendEmail(
        env,
        db,
        {
          to: email,
          toName: person_name,
          kind: 'digest',
          detail: `${rows.length} item(s)`,
          subject: langs.map((l) => t(l, 'email.digestSubject')).join(' · '),
          text: `${intro}\n\n${lines.join('\n')}\n\n${footer} ${link}\n`,
          html: `<p>${langs.map((l) => t(l, 'email.digestIntro', { name: person_name })).join('<br>')}</p><ul>${htmlLines.map((l) => `<li>${l}</li>`).join('')}</ul><p>${footer} <a href="${link}">${link}</a></p>`,
        },
      );
      sent.push(email);
    } catch (e) {
      console.error(`digest send failed for ${email}`, e);
    }
  }
  return sent;
}

/**
 * Daily reminder pass: for each enabled reminder rule (remind7 / remind3),
 * re-send the scheduling request to anyone still unconfirmed exactly that many
 * days before the service. Returns the number of reminders sent.
 */
export async function sendReminders(env: EmailEnv, db: D1Database, now: Date = new Date()): Promise<number> {
  const today = todayInTz(TZ, now);
  const offsets: number[] = [];
  if (await isRuleEnabled(db, 'remind7')) offsets.push(7);
  if (await isRuleEnabled(db, 'remind3')) offsets.push(3);
  if (offsets.length === 0) return 0;

  let sent = 0;
  for (const off of offsets) {
    const { results } = await db
      .prepare(
        `SELECT ra.id AS id FROM roster_assignments ra
         JOIN plans ON plans.id = ra.plan_id AND plans.deleted_at IS NULL
         WHERE ra.status = 'U' AND ra.deleted_at IS NULL AND plans.plan_date = ?`,
      )
      .bind(addDays(today, off))
      .all<{ id: number }>();
    for (const r of results) {
      await sendSchedulingRequest(env, db, r.id);
      sent++;
    }
  }
  return sent;
}
