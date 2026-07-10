// Group attendance: expiring tracker links (SHA-256-at-rest, the auth.tokens
// precedent — but a dedicated table since tokens.purpose's CHECK can't be altered
// in SQLite), the hourly cron that mails group admins a link once a tracked
// occurrence ends, the attendance upsert, and the session-auth check. Emails are
// best-effort (email_log records the attempt) and module-gated on 'groups'.
import type { AppDb } from './appDb';
import { sha256Hex } from './auth';
import { addDays, todayInTz } from './dates';
import { getBackend, type DbEnv } from './dbProvider';
import { escapeHtml, sendEmail, type EmailEnv } from './email';
import { ensureOccurrences, listOccurrencesNeedingAttendance } from './groupEventDb';
import { t } from './i18n';
import { type Locale } from './locales';
import { getEnabledModules } from './modules';

const TZ = 'America/Chicago';
const TOKEN_TTL = '+72 hours';
const TOPUP_DAYS = 35;

/** A raw 32-byte base64url token (auth.ts shape; only its SHA-256 hex is stored). */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Narrow a stored `lang` to a Locale, or null (→ send both stacked). */
function toLang(lang: string | null): Locale | null {
  return lang === 'en' || lang === 'zh' ? lang : null;
}

// ── Tokens ─────────────────────────────────────────────────────────────────

/** Mint a 72h attendance-tracker token bound to (occurrence, person). Returns the
 *  raw token (embed in the emailed link); only its SHA-256 hex hash is persisted. */
export async function createAttendanceToken(db: AppDb, occurrenceId: number, personId: number): Promise<string> {
  const raw = randomToken();
  await db
    .prepare(
      `INSERT INTO group_attendance_tokens (occurrence_id, person_id, token_hash, expires_at)
       VALUES (?1, ?2, ?3, datetime('now', ?4))`,
    )
    .bind(occurrenceId, personId, await sha256Hex(raw), TOKEN_TTL)
    .run();
  return raw;
}

export interface AttendanceTokenRow {
  occurrence_id: number;
  person_id: number;
}

/**
 * Verify an attendance token WITHOUT consuming it: valid (unexpired) tokens are
 * multi-use until expiry so an admin can correct a mistake. `used_at` is stamped
 * on first use for audit only (never a gate). Returns the bound occurrence +
 * person, or null when the token is unknown or expired.
 */
export async function verifyAttendanceToken(db: AppDb, rawToken: string): Promise<AttendanceTokenRow | null> {
  const hash = await sha256Hex(rawToken);
  const row = await db
    .prepare(
      `SELECT id, occurrence_id, person_id FROM group_attendance_tokens
       WHERE token_hash = ?1 AND expires_at > datetime('now')`,
    )
    .bind(hash)
    .first<{ id: number; occurrence_id: number; person_id: number }>();
  if (!row) return null;
  // Audit-only first-use stamp; non-consuming (does not affect validity).
  await db
    .prepare(`UPDATE group_attendance_tokens SET used_at = datetime('now') WHERE id = ?1 AND used_at IS NULL`)
    .bind(row.id)
    .run();
  return { occurrence_id: row.occurrence_id, person_id: row.person_id };
}

/**
 * Authorize a session (not token) actor to record attendance for an occurrence:
 * a site admin (people.role = 'admin') always, otherwise an active group-admin of
 * the occurrence's group.
 */
export async function canRecordAttendance(db: AppDb, occurrenceId: number, personId: number): Promise<boolean> {
  const person = await db
    .prepare(`SELECT role FROM people WHERE id = ?1 AND deleted_at IS NULL AND active = 1`)
    .bind(personId)
    .first<{ role: string }>();
  if (person?.role === 'admin') return true;
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM group_event_occurrences geo
       JOIN group_events ge ON ge.id = geo.event_id
       JOIN group_members gm ON gm.group_id = ge.group_id AND gm.person_id = ?2 AND gm.is_admin = 1 AND gm.removed_at IS NULL
       WHERE geo.id = ?1`,
    )
    .bind(occurrenceId, personId)
    .first<{ x: number }>();
  return row !== null;
}

// ── Attendance upsert ──────────────────────────────────────────────────────

/**
 * Record attendance for an occurrence: for every ACTIVE member of the occurrence's
 * group, upsert a row with present = 1 when its id is in `presentMemberIds`, else
 * 0 (so unchecking someone persists as absent). Idempotent via
 * ON CONFLICT(occurrence_id, member_id). `recordedBy` is the acting person's id
 * (audit; null for none). No-op when the occurrence is missing.
 */
export async function saveAttendance(
  db: AppDb,
  occurrenceId: number,
  presentMemberIds: number[],
  recordedBy: number | null = null,
): Promise<void> {
  const occ = await db
    .prepare(
      `SELECT ge.group_id AS group_id FROM group_event_occurrences geo
       JOIN group_events ge ON ge.id = geo.event_id WHERE geo.id = ?1`,
    )
    .bind(occurrenceId)
    .first<{ group_id: number }>();
  if (!occ) return;
  const { results: members } = await db
    .prepare(`SELECT id FROM group_members WHERE group_id = ?1 AND removed_at IS NULL`)
    .bind(occ.group_id)
    .all<{ id: number }>();
  if (members.length === 0) return;
  const present = new Set(presentMemberIds);
  await db.batch(
    members.map((m) =>
      db
        .prepare(
          `INSERT INTO group_attendance (occurrence_id, member_id, present, recorded_by, recorded_at)
           VALUES (?1, ?2, ?3, ?4, datetime('now'))
           ON CONFLICT(occurrence_id, member_id)
           DO UPDATE SET present = excluded.present, recorded_by = excluded.recorded_by, recorded_at = datetime('now')`,
        )
        .bind(occurrenceId, m.id, present.has(m.id) ? 1 : 0, recordedBy),
    ),
  );
}

/**
 * The existing attendance for an occurrence as a `member_id → present (0|1)` map
 * — what the attendance sheet pre-checks its boxes from. A member absent from the
 * map has no recorded row yet (rendered unchecked); present = 1 is checked, a
 * recorded present = 0 stays unchecked.
 */
export async function getAttendanceMap(db: AppDb, occurrenceId: number): Promise<Record<number, number>> {
  const { results } = await db
    .prepare(`SELECT member_id, present FROM group_attendance WHERE occurrence_id = ?1`)
    .bind(occurrenceId)
    .all<{ member_id: number; present: number }>();
  return Object.fromEntries(results.map((r) => [r.member_id, r.present]));
}

// ── Cron: attendance emails ─────────────────────────────────────────────────

/** Atomically claim an occurrence for the attendance email so two concurrent cron
 *  passes can never both send. Returns true when THIS call won the claim. */
export async function claimOccurrenceForEmail(db: AppDb, occurrenceId: number): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE group_event_occurrences SET attendance_email_sent_at = datetime('now')
       WHERE id = ?1 AND attendance_email_sent_at IS NULL RETURNING id`,
    )
    .bind(occurrenceId)
    .first<{ id: number }>();
  return row !== null;
}

interface AdminRecipient {
  person_id: number;
  name: string;
  email: string;
  lang: string | null;
}

/** Build the { subject, html, text } attendance email (bilingual, or the admin's
 *  saved lang). Interpolated values are HTML-escaped by t(); the link is escaped
 *  separately in the HTML anchor. */
function buildAttendanceEmail(args: {
  name: string;
  group: string;
  title: string;
  date: string;
  link: string;
  only: Locale | null;
}): { subject: string; html: string; text: string } {
  const langs: Locale[] = args.only ? [args.only] : ['zh', 'en'];
  const vars = { name: args.name, group: args.group, title: args.title, date: args.date };
  const subject = langs.map((l) => t(l, 'attendance.email.subject', vars)).join(' · ');
  const intro = langs.map((l) => t(l, 'attendance.email.intro', vars));
  const cta = langs.map((l) => t(l, 'attendance.email.cta')).join(' · ');
  const expiry = langs.map((l) => t(l, 'attendance.email.expiry')).join(' ');
  const text = `${intro.join('\n\n')}\n\n${cta}: ${args.link}\n\n${expiry}\n`;
  const html =
    `${intro.map((p) => `<p>${p}</p>`).join('')}` +
    `<p><a href="${escapeHtml(args.link)}">${cta}</a></p>` +
    `<p>${expiry}</p>`;
  return { subject, html, text };
}

/**
 * Hourly cron pass. Gated on the 'groups' module (skips entirely when off). Tops
 * up occurrences for every active event through +35 days first (so a just-ended
 * meeting always has its row), then finds tracked occurrences that ended in the
 * last 24h, atomically claims each, and emails a fresh 72h tracker link to every
 * group admin who has a linked person with an email. Best-effort — one bad
 * recipient never stops the rest. Returns the number of emails sent (or
 * dev-logged).
 */
export async function sendAttendanceEmails(env: EmailEnv, db: AppDb, now: Date = new Date()): Promise<number> {
  if (!(await getEnabledModules(db, getBackend(env as unknown as DbEnv))).has('groups')) {
    console.log('attendance: groups module disabled — skipping');
    return 0;
  }

  // Top-up: keep every active event's occurrences generated through +35 days.
  const through = addDays(todayInTz(TZ, now), TOPUP_DAYS);
  const { results: events } = await db
    .prepare(
      `SELECT id, recurrence, starts_on, start_time, duration_min, ends_on
       FROM group_events WHERE deleted_at IS NULL AND active = 1`,
    )
    .all<{ id: number; recurrence: 'none' | 'weekly' | 'biweekly' | 'monthly'; starts_on: string; start_time: string; duration_min: number; ends_on: string | null }>();
  for (const ev of events) await ensureOccurrences(db, ev, through, now);

  const occurrences = await listOccurrencesNeedingAttendance(db, now);
  const origin = env.APP_ORIGIN ?? '';
  let sent = 0;
  for (const occ of occurrences) {
    if (!(await claimOccurrenceForEmail(db, occ.id))) continue; // lost the race / already sent
    const { results: admins } = await db
      .prepare(
        `SELECT gm.person_id AS person_id, p.display_name AS name, p.email AS email, p.lang AS lang
         FROM group_members gm
         JOIN people p ON p.id = gm.person_id AND p.deleted_at IS NULL AND p.active = 1 AND p.email IS NOT NULL
         WHERE gm.group_id = ?1 AND gm.is_admin = 1 AND gm.removed_at IS NULL`,
      )
      .bind(occ.group_id)
      .all<AdminRecipient>();
    for (const admin of admins) {
      try {
        const raw = await createAttendanceToken(db, occ.id, admin.person_id);
        const link = `${origin}/attendance/${raw}`;
        const built = buildAttendanceEmail({
          name: admin.name,
          group: occ.group_name,
          title: occ.title,
          date: occ.occurs_on,
          link,
          only: toLang(admin.lang),
        });
        await sendEmail(env, db, {
          to: admin.email,
          toName: admin.name,
          kind: 'attendance',
          detail: `${occ.group_name} · ${occ.occurs_on}`,
          ...built,
        });
        sent++;
      } catch (e) {
        console.error(`attendance email failed for occurrence ${occ.id} admin ${admin.person_id}`, e);
      }
    }
  }
  return sent;
}
