// Notification mail. Beyond the magic sign-in link this now carries the slice-6
// scheduling touchpoints: request emails (with a single-use respond link),
// decline notices to team leaders, and application received / result emails.
// Every touchpoint is best-effort — each function catches its own errors so a
// mail failure can never fail the request that triggered it. Bodies are written
// in the recipient's saved language (`lang`) when they have one, otherwise
// bilingually (zh then en stacked); every interpolated variable is HTML-escaped
// by `t()` before it reaches the message.
import type { AppDb } from './appDb';
import { createLoginToken, createRespondToken } from './auth';
import { i18nJoin } from './db';
import { escapeHtml, sendEmail, type EmailEnv } from './email';
import { t } from './i18n';
import { type Locale } from './locales';

/** The person fields sendMagicLink needs (subset of the people row). */
interface MagicLinkPerson {
  id: number;
  email: string;
  display_name: string;
  lang: string | null;
}

/**
 * Issue a one-time login token and email its magic link. The email is written in
 * the person's saved language when they have one, otherwise bilingually (leading
 * with the locale they were viewing sign-in in). Returns false without sending
 * when the person has hit the login rate limit — the sign-in page shows the same
 * "check your email" state either way (anti-enumeration).
 */
export async function sendMagicLink(
  env: EmailEnv,
  db: AppDb,
  person: MagicLinkPerson,
  locale: Locale,
): Promise<boolean> {
  const token = await createLoginToken(db, person.id);
  if ('rateLimited' in token) return false;

  const link = `${env.APP_ORIGIN ?? ''}/auth/${token.raw}`;
  const langs: Locale[] =
    person.lang === 'en' || person.lang === 'zh'
      ? [person.lang]
      : locale === 'zh'
        ? ['zh', 'en']
        : ['en', 'zh'];

  const subject = langs.map((l) => t(l, 'auth.email.subject', { site: t(l, 'site.name') })).join(' · ');
  const text = `${langs.map((l) => t(l, 'auth.email.body')).join('\n\n')}\n\n${link}\n`;
  const html = `${langs.map((l) => `<p>${t(l, 'auth.email.body')}</p>`).join('')}<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`;

  return sendEmail(env, db, {
    to: person.email,
    toName: person.display_name,
    kind: 'signin',
    subject,
    html,
    text,
  });
}

/**
 * Email the confirmation link for a pending email change to the NEW address (the
 * caller has already minted `raw` via requestEmailChange). Written in the
 * person's saved language when they have one, otherwise bilingually. Delivery to
 * the new address is itself the proof the member controls it.
 */
export async function sendEmailChangeLink(
  env: EmailEnv,
  db: AppDb,
  person: MagicLinkPerson,
  raw: string,
  newEmail: string,
  locale: Locale,
): Promise<boolean> {
  const link = `${env.APP_ORIGIN ?? ''}/email-change/${raw}`;
  const langs: Locale[] =
    person.lang === 'en' || person.lang === 'zh'
      ? [person.lang]
      : locale === 'zh'
        ? ['zh', 'en']
        : ['en', 'zh'];

  const subject = langs
    .map((l) => t(l, 'portal.emailChange.email.subject', { site: t(l, 'site.name') }))
    .join(' · ');
  const text = `${langs.map((l) => t(l, 'portal.emailChange.email.body')).join('\n\n')}\n\n${link}\n`;
  const html = `${langs.map((l) => `<p>${t(l, 'portal.emailChange.email.body')}</p>`).join('')}<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`;

  return sendEmail(env, db, {
    to: newEmail,
    toName: person.display_name,
    kind: 'emailchange',
    subject,
    html,
    text,
  });
}

/**
 * After an email change is confirmed, notify the FORMER address so a hijack is
 * visible to the original owner. Best-effort (swallows its own errors). Written
 * in the member's saved language, otherwise both stacked.
 */
export async function sendEmailChangedNotice(
  env: EmailEnv,
  db: AppDb,
  args: { oldEmail: string; newEmail: string; name: string; lang: string | null },
): Promise<void> {
  try {
    const only = toLang(args.lang);
    const built = bilingualEmail({
      subjectKey: 'portal.emailChange.notice.subject',
      bodyKey: 'portal.emailChange.notice.body',
      vars: { name: args.name, email: args.newEmail },
      only,
    });
    await sendEmail(env, db, {
      to: args.oldEmail,
      toName: args.name,
      kind: 'emailchangeNotice',
      detail: args.newEmail,
      ...built,
    });
  } catch (e) {
    console.error(`email-changed notice failed for ${args.oldEmail}`, e);
  }
}

// ── Bilingual message builder (shared by every scheduling touchpoint) ──

/** Narrow a stored `lang` value to a Locale, or null (→ send both stacked). */
function toLang(lang: string | null): Locale | null {
  return lang === 'en' || lang === 'zh' ? lang : null;
}

interface BilingualArgs {
  subjectKey: string;
  bodyKey: string;
  vars?: Record<string, string | number>;
  link?: string;
  /** When set, emit only that locale; otherwise stack zh then en. */
  only?: Locale | null;
}

/**
 * Build a { subject, html, text } message from dictionary keys. When `only` is a
 * locale the message is single-language; otherwise both locales are stacked
 * (zh then en). Interpolated `vars` are HTML-escaped by `t()`; the trailing link
 * is appended once (escaped in the HTML anchor).
 */
export function bilingualEmail({ subjectKey, bodyKey, vars, link, only }: BilingualArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const langs: Locale[] = only ? [only] : ['zh', 'en'];
  const subject = langs.map((l) => t(l, subjectKey, vars)).join(' · ');
  const bodyText = langs.map((l) => t(l, bodyKey, vars)).join('\n\n');
  const text = link ? `${bodyText}\n\n${link}\n` : `${bodyText}\n`;
  const html =
    langs.map((l) => `<p>${t(l, bodyKey, vars)}</p>`).join('') +
    (link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : '');
  return { subject, html, text };
}

// ── Detail reads (English/default names for the email variables) ──

interface AssignmentDetail {
  person_id: number;
  person_name: string;
  person_email: string | null;
  person_lang: string | null;
  position_name: string;
  team_id: number;
  team_name: string;
  plan_id: number;
  plan_date: string;
  service_type_name: string;
}

async function getAssignmentDetail(db: AppDb, assignmentId: number): Promise<AssignmentDetail | null> {
  const stJ = i18nJoin('service_type_i18n', 'st', 'service_type_id', ['name'], 'en');
  const posJ = i18nJoin('position_i18n', 'pos', 'position_id', ['name'], 'en');
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], 'en');
  return db
    .prepare(
      `SELECT ra.person_id AS person_id, people.display_name AS person_name,
              people.email AS person_email, people.lang AS person_lang,
              COALESCE(pos_l.name, pos_d.name) AS position_name,
              tm.id AS team_id, COALESCE(tm_l.name, tm_d.name) AS team_name,
              ra.plan_id AS plan_id, plans.plan_date AS plan_date,
              COALESCE(st_l.name, st_d.name) AS service_type_name
       FROM roster_assignments ra
       JOIN people ON people.id = ra.person_id
       JOIN plans ON plans.id = ra.plan_id AND plans.deleted_at IS NULL
       JOIN service_types st ON st.id = plans.service_type_id
       ${stJ.joins}
       JOIN positions pos ON pos.id = ra.position_id
       ${posJ.joins}
       JOIN teams tm ON tm.id = pos.team_id
       ${tmJ.joins}
       WHERE ra.id = ? AND ra.deleted_at IS NULL`,
    )
    .bind(assignmentId)
    .first<AssignmentDetail>();
}

interface ApplicationDetail {
  person_id: number;
  applicant_name: string;
  applicant_email: string | null;
  applicant_lang: string | null;
  team_id: number;
  team_name: string;
}

async function getApplicationDetail(db: AppDb, applicationId: number): Promise<ApplicationDetail | null> {
  const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], 'en');
  return db
    .prepare(
      `SELECT ta.person_id AS person_id, people.display_name AS applicant_name,
              people.email AS applicant_email, people.lang AS applicant_lang,
              tm.id AS team_id, COALESCE(tm_l.name, tm_d.name) AS team_name
       FROM team_applications ta
       JOIN people ON people.id = ta.person_id
       JOIN teams tm ON tm.id = ta.team_id
       ${tmJ.joins}
       WHERE ta.id = ?`,
    )
    .bind(applicationId)
    .first<ApplicationDetail>();
}

interface LeaderRecipient {
  email: string;
  name: string;
  lang: string | null;
}

/** Active team leaders with an email (recipients of decline / application mail). */
async function listTeamLeaders(db: AppDb, teamId: number): Promise<LeaderRecipient[]> {
  const { results } = await db
    .prepare(
      `SELECT people.email AS email, people.display_name AS name, people.lang AS lang
       FROM team_members
       JOIN people ON people.id = team_members.person_id
         AND people.deleted_at IS NULL AND people.active = 1 AND people.email IS NOT NULL
       WHERE team_members.team_id = ? AND team_members.is_leader = 1
       ORDER BY people.display_name`,
    )
    .bind(teamId)
    .all<LeaderRecipient>();
  return results;
}

// ── Scheduling touchpoints (all best-effort) ──

/**
 * Email a scheduling request to the assignee with a single-use accept/decline
 * link, and stamp `notified_at`. No-op when the assignment is gone or the person
 * has no email. Also used by the daily reminder cron to re-nudge unconfirmed
 * requests.
 */
export async function sendSchedulingRequest(env: EmailEnv, db: AppDb, assignmentId: number): Promise<void> {
  try {
    const d = await getAssignmentDetail(db, assignmentId);
    if (!d?.person_email) return;
    const { raw } = await createRespondToken(db, d.person_id, assignmentId);
    const link = `${env.APP_ORIGIN ?? ''}/respond/${raw}`;
    const built = bilingualEmail({
      subjectKey: 'email.requestSubject',
      bodyKey: 'email.requestBody',
      vars: { name: d.person_name, position: d.position_name, team: d.team_name, date: d.plan_date, service: d.service_type_name },
      link,
      only: toLang(d.person_lang),
    });
    await sendEmail(env, db, { to: d.person_email, toName: d.person_name, kind: 'request', detail: `${d.plan_date} ${d.position_name}`, ...built });
    await db.prepare(`UPDATE roster_assignments SET notified_at = datetime('now') WHERE id = ?`).bind(assignmentId).run();
  } catch (e) {
    console.error(`scheduling request failed for assignment ${assignmentId}`, e);
  }
}

/**
 * When a volunteer declines, notify the leaders of the position's team so they
 * can find a replacement instead of discovering the hole on Sunday. Each leader
 * gets the mail in their own language with a link to the plan.
 */
export async function sendDeclineNotice(
  env: EmailEnv,
  db: AppDb,
  assignmentId: number,
  reason: string | null,
): Promise<void> {
  try {
    const d = await getAssignmentDetail(db, assignmentId);
    if (!d) return;
    const leaders = await listTeamLeaders(db, d.team_id);
    const origin = env.APP_ORIGIN ?? '';
    for (const ldr of leaders) {
      const only = toLang(ldr.lang);
      const link = `${origin}/${only ?? 'en'}/serve/plans/${d.plan_id}`;
      const built = bilingualEmail({
        subjectKey: 'email.declineSubject',
        bodyKey: 'email.declineBody',
        vars: { name: d.person_name, position: d.position_name, team: d.team_name, date: d.plan_date, service: d.service_type_name, reason: reason ?? '—' },
        link,
        only,
      });
      await sendEmail(env, db, { to: ldr.email, toName: ldr.name, kind: 'decline', detail: `${d.plan_date} ${d.position_name}`, ...built });
    }
  } catch (e) {
    console.error(`decline notice failed for assignment ${assignmentId}`, e);
  }
}

/** Notify a team's leaders that a new serving application is awaiting review. */
export async function sendApplicationReceived(env: EmailEnv, db: AppDb, applicationId: number): Promise<void> {
  try {
    const a = await getApplicationDetail(db, applicationId);
    if (!a) return;
    const leaders = await listTeamLeaders(db, a.team_id);
    const origin = env.APP_ORIGIN ?? '';
    for (const ldr of leaders) {
      const only = toLang(ldr.lang);
      const link = `${origin}/${only ?? 'en'}/serve/teams/${a.team_id}`;
      const built = bilingualEmail({
        subjectKey: 'email.appReceivedSubject',
        bodyKey: 'email.appReceivedBody',
        vars: { name: a.applicant_name, team: a.team_name },
        link,
        only,
      });
      await sendEmail(env, db, { to: ldr.email, toName: ldr.name, kind: 'appReceived', detail: a.team_name, ...built });
    }
  } catch (e) {
    console.error(`application-received notice failed for application ${applicationId}`, e);
  }
}

// ── Outreach (people module: "proactively reach out") ──

interface InviteRecipient {
  name: string;
  email: string | null;
  lang: string | null;
  active: number;
}

/**
 * Invite a person to serve on a team (people-module outreach). Best-effort: reads
 * the recipient from the people row and no-ops (returns false) when the person is
 * inactive, soft-deleted, or has no email, or when the team is gone. The mail is
 * written in the person's saved language (otherwise both stacked) and links the
 * team's apply flow; it is logged in email_log as kind 'outreach' (its detail
 * records the team and the inviting leader/admin for the audit trail). The
 * caller (admin page / leader surface) is responsible for the authorization to
 * invite for THIS team; this function only derives the recipient. Returns whether
 * a mail was sent (or dev-logged).
 */
export async function sendServeInvite(
  env: EmailEnv,
  db: AppDb,
  args: { personId: number; teamId: number; invitedByEmail: string },
): Promise<boolean> {
  try {
    const person = await db
      .prepare(
        `SELECT display_name AS name, email, lang, active FROM people
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(args.personId)
      .first<InviteRecipient>();
    if (!person || person.active !== 1 || !person.email) return false;

    // Resolve the team name in the RECIPIENT's language (i18nJoin COALESCEs to
    // en when no localized row exists); no saved lang → en name inside the
    // bilingual stacked body.
    const only = toLang(person.lang);
    const tmJ = i18nJoin('team_i18n', 'tm', 'team_id', ['name'], only ?? 'en');
    const team = await db
      .prepare(
        `SELECT tm.id AS id, COALESCE(tm_l.name, tm_d.name) AS name
         FROM teams tm ${tmJ.joins}
         WHERE tm.id = ? AND tm.deleted_at IS NULL`,
      )
      .bind(args.teamId)
      .first<{ id: number; name: string }>();
    if (!team) return false;
    const link = `${env.APP_ORIGIN ?? ''}/${only ?? 'en'}/serve/apply?team=${team.id}`;
    const built = bilingualEmail({
      subjectKey: 'invite.email.subject',
      bodyKey: 'invite.email.body',
      vars: { name: person.name, team: team.name },
      link,
      only,
    });
    return await sendEmail(env, db, {
      to: person.email,
      toName: person.name,
      kind: 'outreach',
      detail: `${team.name} · ${args.invitedByEmail}`,
      ...built,
    });
  } catch (e) {
    console.error(`serve invite failed for person ${args.personId} team ${args.teamId}`, e);
    return false;
  }
}

/** Tell the applicant whether their serving application was approved or rejected. */
export async function sendApplicationResult(
  env: EmailEnv,
  db: AppDb,
  applicationId: number,
  approved: boolean,
): Promise<void> {
  try {
    const a = await getApplicationDetail(db, applicationId);
    if (!a?.applicant_email) return;
    const only = toLang(a.applicant_lang);
    const link = `${env.APP_ORIGIN ?? ''}/${only ?? 'en'}/my`;
    const built = bilingualEmail({
      subjectKey: approved ? 'email.appApprovedSubject' : 'email.appRejectedSubject',
      bodyKey: approved ? 'email.appApprovedBody' : 'email.appRejectedBody',
      vars: { name: a.applicant_name, team: a.team_name },
      link,
      only,
    });
    await sendEmail(env, db, { to: a.applicant_email, toName: a.applicant_name, kind: 'appResult', detail: a.team_name, ...built });
  } catch (e) {
    console.error(`application-result notice failed for application ${applicationId}`, e);
  }
}

// ── Groups (member portal: fellowships + Sunday School classes) — mirrors the
// team-application pair above (getApplicationDetail/listTeamLeaders/
// sendApplicationReceived/sendApplicationResult), adapted to group_applications'
// shape (no position_id; group_members carries is_leader the same way
// team_members does). ──

interface GroupApplicationDetail {
  person_id: number;
  applicant_name: string;
  applicant_email: string | null;
  applicant_lang: string | null;
  group_id: number;
  group_name: string;
}

async function getGroupApplicationDetail(db: AppDb, applicationId: number): Promise<GroupApplicationDetail | null> {
  const gJ = i18nJoin('member_group_i18n', 'g', 'group_id', ['name'], 'en');
  return db
    .prepare(
      `SELECT ga.person_id AS person_id, people.display_name AS applicant_name,
              people.email AS applicant_email, people.lang AS applicant_lang,
              g.id AS group_id, COALESCE(g_l.name, g_d.name) AS group_name
       FROM group_applications ga
       JOIN people ON people.id = ga.person_id
       JOIN member_groups g ON g.id = ga.group_id
       ${gJ.joins}
       WHERE ga.id = ?`,
    )
    .bind(applicationId)
    .first<GroupApplicationDetail>();
}

async function listGroupLeaders(db: AppDb, groupId: number): Promise<LeaderRecipient[]> {
  const { results } = await db
    .prepare(
      `SELECT people.email AS email, people.display_name AS name, people.lang AS lang
       FROM group_members gm
       JOIN people ON people.id = gm.person_id
         AND people.deleted_at IS NULL AND people.active = 1 AND people.email IS NOT NULL
       WHERE gm.group_id = ? AND gm.is_leader = 1
       ORDER BY people.display_name`,
    )
    .bind(groupId)
    .all<LeaderRecipient>();
  return results;
}

/** Notify a group's leaders that a new membership application is awaiting review. */
export async function sendGroupApplicationReceived(env: EmailEnv, db: AppDb, applicationId: number): Promise<void> {
  try {
    const a = await getGroupApplicationDetail(db, applicationId);
    if (!a) return;
    const leaders = await listGroupLeaders(db, a.group_id);
    const origin = env.APP_ORIGIN ?? '';
    for (const ldr of leaders) {
      const only = toLang(ldr.lang);
      const link = `${origin}/${only ?? 'en'}/my/groups/${a.group_id}`;
      const built = bilingualEmail({
        subjectKey: 'email.groupAppReceivedSubject',
        bodyKey: 'email.groupAppReceivedBody',
        vars: { name: a.applicant_name, group: a.group_name },
        link,
        only,
      });
      await sendEmail(env, db, { to: ldr.email, toName: ldr.name, kind: 'groupAppReceived', detail: a.group_name, ...built });
    }
  } catch (e) {
    console.error(`group application-received notice failed for application ${applicationId}`, e);
  }
}

/** Tell the applicant whether their group membership application was approved or rejected. */
export async function sendGroupApplicationResult(
  env: EmailEnv,
  db: AppDb,
  applicationId: number,
  approved: boolean,
): Promise<void> {
  try {
    const a = await getGroupApplicationDetail(db, applicationId);
    if (!a?.applicant_email) return;
    const only = toLang(a.applicant_lang);
    // Links to the portal groups index, not the group detail page: a rejected
    // applicant is never a member, so /my/groups/<id> (member-gated) would 404
    // for them — the same reasoning sendApplicationResult applies for teams.
    const link = `${env.APP_ORIGIN ?? ''}/${only ?? 'en'}/my/groups`;
    const built = bilingualEmail({
      subjectKey: approved ? 'email.groupAppApprovedSubject' : 'email.groupAppRejectedSubject',
      bodyKey: approved ? 'email.groupAppApprovedBody' : 'email.groupAppRejectedBody',
      vars: { name: a.applicant_name, group: a.group_name },
      link,
      only,
    });
    await sendEmail(env, db, { to: a.applicant_email, toName: a.applicant_name, kind: 'groupAppResult', detail: a.group_name, ...built });
  } catch (e) {
    console.error(`group application-result notice failed for application ${applicationId}`, e);
  }
}
