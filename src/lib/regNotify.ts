// Sending the registration emails: the confirmation (free, waitlist, paid), the
// waitlist-promotion notice, the cancellation notice, the durable-send stamp and the
// cron retry sweep. Every function is best-effort and never throws: a mail failure must
// not fail the request, webhook or cron pass that triggered it.
//
// Manage-link tokens: only the SHA-256 is stored, so a link can only be mailed in the
// call that created it, or after ROTATING (issueManageToken), which kills the previous
// link. The creation-time token is used for the first confirmation of a free or guest
// registration; promotion, the cron retry and the paid confirmation rotate. A rotation
// whose mail then fails is rolled back, so a broken mail sender can never invalidate
// working links. A token is never written to a log, a query string or email_log.
import type { AppDb } from './appDb';
import { getBackend, type DbEnv } from './dbProvider';
import { getEffectiveCampusModules } from './campusDb';
import { toUtcSql } from './dates';
import { sendEmail, type EmailEnv } from './email';
import { getLocaleSettings, LEGACY_LOCALE_SETTINGS } from './localeSettings';
import { loadDict } from './i18n';
import { isSupportedLocale, type Locale } from './locales';
import { getEnabledModules } from './modules';
import { cancelRegistrationPromoting, hashManageToken } from './regDb';
import { cancelledEmail, confirmationEmail, promotedEmail, registrationManageUrl, registrationQrUrl, type BuiltRegEmail } from './regEmails';
import { issueManageToken, registrationSummary, type RegistrationSummary } from './regManage';

export type RegNotifyEnv = EmailEnv & { APP_ORIGIN?: string };

/** Sweep tuning: at most this many registrations per run, and only ones older than this. */
export const SWEEP_LIMIT = 50;
export const SWEEP_GRACE_MS = 15 * 60_000;

/** The registration's own language when that language is enabled, else the installation default. */
async function emailLocale(db: AppDb, registrationLocale: string | null): Promise<Locale> {
  let settings = LEGACY_LOCALE_SETTINGS;
  try {
    settings = await getLocaleSettings(db);
  } catch {
    /* fail safe to the legacy en + zh state */
  }
  const locale: Locale = isSupportedLocale(registrationLocale) && settings.enabled.includes(registrationLocale)
    ? registrationLocale
    : settings.default;
  await loadDict(locale);
  return locale;
}

async function loadSummary(db: AppDb, id: number): Promise<{ summary: RegistrationSummary; locale: Locale } | null> {
  const row = await db.prepare(`SELECT locale FROM registrations WHERE id = ?1`).bind(id).first<{ locale: string | null }>();
  if (!row) return null;
  const locale = await emailLocale(db, row.locale);
  const summary = await registrationSummary(db, id, locale);
  return summary ? { summary, locale } : null;
}

const originOf = (env: RegNotifyEnv): string => env.APP_ORIGIN ?? '';

/** Rotate the manage token; returns the new plaintext and a function that restores the old link. */
async function rotateToken(db: AppDb, id: number): Promise<{ token: string; restore: () => Promise<void> } | null> {
  const before = await db.prepare(`SELECT manage_token_hash FROM registrations WHERE id = ?1`).bind(id).first<{ manage_token_hash: string | null }>();
  if (!before) return null;
  const token = await issueManageToken(db, id);
  if (!token) return null;
  const issued = await hashManageToken(token);
  return {
    token,
    // Only if nobody rotated again in between.
    restore: async () => {
      await db
        .prepare(`UPDATE registrations SET manage_token_hash = ?1 WHERE id = ?2 AND manage_token_hash = ?3`)
        .bind(before.manage_token_hash, id, issued)
        .run();
    },
  };
}

async function deliver(
  env: RegNotifyEnv,
  db: AppDb,
  summary: RegistrationSummary,
  kind: string,
  built: BuiltRegEmail,
  hasLink: boolean,
): Promise<boolean> {
  return sendEmail(env, db, {
    to: summary.registration.email,
    toName: summary.registration.name,
    kind,
    detail: `registration ${summary.registration.id}`,
    subject: built.subject,
    html: built.html,
    text: built.text,
    attachments: built.attachments,
    redactDevLogBody: hasLink,
  });
}

async function stampSent(db: AppDb, id: number): Promise<void> {
  await db
    .prepare(`UPDATE registrations SET confirmation_sent_at = datetime('now') WHERE id = ?1 AND confirmation_sent_at IS NULL`)
    .bind(id)
    .run();
}

/**
 * Send the confirmation (confirmed, waitlist, or paid) and stamp `confirmation_sent_at`
 * when the mail was accepted. Pass the creation-time `manageToken` to link it; without
 * one the token is rotated and the new link sent (rolled back if the send fails).
 * Returns whether the mail went out.
 */
export async function sendConfirmation(
  env: RegNotifyEnv,
  db: AppDb,
  registrationId: number,
  opts: { manageToken?: string | null } = {},
): Promise<boolean> {
  try {
    const loaded = await loadSummary(db, registrationId);
    if (!loaded) return false;
    const { summary, locale } = loaded;
    if (summary.registration.status !== 'confirmed' && summary.registration.status !== 'waitlist') return false;
    if (!summary.registration.email) return false;

    let token = opts.manageToken ?? null;
    let restore: (() => Promise<void>) | null = null;
    if (!token) {
      const rotated = await rotateToken(db, registrationId);
      token = rotated?.token ?? null;
      restore = rotated?.restore ?? null;
    }
    const origin = originOf(env);
    const built = confirmationEmail(summary, {
      locale,
      origin,
      manageUrl: token ? registrationManageUrl(origin, locale, token) : null,
      qrUrl: registrationQrUrl(origin, summary.event.id, summary.registration.confirmation_no),
    });
    const ok = await deliver(env, db, summary, 'regConfirm', built, token !== null);
    if (ok) await stampSent(db, registrationId);
    else await restore?.();
    return ok;
  } catch (e) {
    console.error(`registration confirmation failed for registration ${registrationId}`, e instanceof Error ? e.name : 'unknown');
    return false;
  }
}

/** "A place opened up": rotate the token, mail the promoted registrant, mark the confirmation sent. */
export async function sendPromoted(env: RegNotifyEnv, db: AppDb, registrationId: number): Promise<boolean> {
  try {
    const loaded = await loadSummary(db, registrationId);
    if (!loaded) return false;
    const { summary, locale } = loaded;
    if (summary.registration.status !== 'confirmed' || !summary.registration.email) return false;
    const rotated = await rotateToken(db, registrationId);
    const origin = originOf(env);
    const built = promotedEmail(summary, {
      locale,
      origin,
      manageUrl: rotated ? registrationManageUrl(origin, locale, rotated.token) : null,
      qrUrl: registrationQrUrl(origin, summary.event.id, summary.registration.confirmation_no),
    });
    const ok = await deliver(env, db, summary, 'regPromoted', built, rotated !== null);
    // A promotion mail IS the registrant's confirmation: the sweep must not send another.
    if (ok) await stampSent(db, registrationId);
    else await rotated?.restore();
    return ok;
  } catch (e) {
    console.error(`registration promotion mail failed for registration ${registrationId}`, e instanceof Error ? e.name : 'unknown');
    return false;
  }
}

/** Tell the registrant their registration (or one person on it) was cancelled. No manage link. */
export async function sendCancellation(
  env: RegNotifyEnv,
  db: AppDb,
  registrationId: number,
  opts: { attendeeName?: string } = {},
): Promise<boolean> {
  try {
    const loaded = await loadSummary(db, registrationId);
    if (!loaded || !loaded.summary.registration.email) return false;
    const { summary, locale } = loaded;
    const built = cancelledEmail(summary, { locale, origin: originOf(env), attendeeName: opts.attendeeName });
    return await deliver(env, db, summary, 'regCancelled', built, false);
  } catch (e) {
    console.error(`registration cancellation mail failed for registration ${registrationId}`, e instanceof Error ? e.name : 'unknown');
    return false;
  }
}

/**
 * After seats were released: email the cancelled registrant (`cancelledId`, with
 * `attendeeName` when only that person left a registration that goes on) and every
 * waitlisted registration that was promoted. Never throws.
 */
export async function notifyAfterRelease(
  env: RegNotifyEnv,
  db: AppDb,
  input: { cancelledId?: number; attendeeName?: string; promoted: number[] },
): Promise<void> {
  if (input.cancelledId !== undefined) {
    await sendCancellation(env, db, input.cancelledId, { attendeeName: input.attendeeName });
  }
  for (const id of input.promoted) await sendPromoted(env, db, id);
}

/**
 * The admin cancel action: cancel the registration, promote the waitlist on a free event,
 * and email the cancelled registrant and every promoted one. Returns whether it was
 * cancelled (false when it already was, or does not exist). Mail failures never surface.
 */
export async function cancelAndNotify(env: RegNotifyEnv, db: AppDb, registrationId: number): Promise<boolean> {
  const released = await cancelRegistrationPromoting(db, registrationId);
  if (released.cancelled) {
    await notifyAfterRelease(env, db, { cancelledId: registrationId, promoted: released.promoted });
  }
  return released.cancelled;
}

/**
 * The durable-send backstop: confirmations that were never sent (the mail failed, or the
 * process stopped after the write). Up to SWEEP_LIMIT confirmed/waitlisted registrations
 * with `confirmation_sent_at IS NULL`, older than 15 minutes, for events that have not
 * ended, whose campus has registration on; each is mailed (rotating its link). Rows from
 * before the manage link existed (no token hash) are never swept, so an upgrade does not
 * mail old registrants. Returns how many mails went out.
 */
export async function sweepUnsentConfirmations(env: RegNotifyEnv, db: AppDb, now: Date = new Date()): Promise<number> {
  try {
    const globalModules = await getEnabledModules(db, getBackend(env as unknown as DbEnv));
    if (!globalModules.has('registration')) return 0;
    const { results } = await db
      .prepare(
        `SELECT r.id AS id, r.campus_id AS campus_id
         FROM registrations r
         JOIN reg_events e ON e.id = r.event_id
         WHERE r.confirmation_sent_at IS NULL
           AND r.status IN ('confirmed', 'waitlist')
           AND r.manage_token_hash IS NOT NULL
           AND r.created_at < ?1
           AND COALESCE(e.ends_at, e.starts_at) > ?2
         ORDER BY r.id
         LIMIT ${SWEEP_LIMIT}`,
      )
      .bind(toUtcSql(new Date(now.getTime() - SWEEP_GRACE_MS)), toUtcSql(now))
      .all<{ id: number; campus_id: number }>();
    const campusModules = new Map<number, Set<string>>();
    let sent = 0;
    for (const row of results) {
      let modules = campusModules.get(row.campus_id);
      if (!modules) {
        modules = await getEffectiveCampusModules(db, row.campus_id, globalModules);
        campusModules.set(row.campus_id, modules);
      }
      if (!modules.has('registration')) continue;
      if (await sendConfirmation(env, db, row.id)) sent++;
    }
    return sent;
  } catch (e) {
    console.error('registration confirmation sweep failed', e instanceof Error ? e.name : 'unknown');
    return 0;
  }
}
