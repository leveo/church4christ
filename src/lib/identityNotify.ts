import type { AppDb } from './appDb';
import { escapeHtml, sendEmail, type EmailEnv } from './email';
import { t } from './i18n';
import type { Locale } from './locales';

type OtpDelivery = Readonly<{ to: string; publicId: string; code: string; expiresAt: string }>;
type LinkDelivery = Readonly<{ to: string; publicId: string; token: string; expiresAt: string }>;

export async function sendIdentitySignupOtp(
  env: EmailEnv,
  db: AppDb,
  delivery: OtpDelivery,
  locale: Locale,
): Promise<boolean> {
  const subject = t(locale, 'identity.email.signupOtp.subject', { site: t(locale, 'site.name') });
  const body = t(locale, 'identity.email.signupOtp.body', { code: delivery.code });
  return sendEmail(env, db, {
    to: delivery.to,
    kind: 'identitySignupOtp',
    subject,
    text: `${body}\n`,
    html: `<p>${body}</p>`,
    redactDevLogBody: true,
  });
}

export async function sendIdentitySigninLink(
  env: EmailEnv,
  db: AppDb,
  delivery: LinkDelivery,
  locale: Locale,
  campusSlug: string,
): Promise<boolean> {
  const origin = env.APP_ORIGIN?.replace(/\/$/u, '') ?? '';
  const link = `${origin}/auth/${delivery.publicId}.${delivery.token}?campus=${encodeURIComponent(campusSlug)}`;
  const subject = t(locale, 'identity.email.signin.subject', { site: t(locale, 'site.name') });
  const body = t(locale, 'identity.email.signin.body');
  return sendEmail(env, db, {
    to: delivery.to,
    kind: 'identitySignin',
    subject,
    text: `${body}\n\n${link}\n`,
    html: `<p>${body}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
  });
}

/** Email proof for a logged-in member's sensitive action. The opaque challenge
 * id/code are delivery material only: neither is written to email_log detail. */
export async function sendIdentityStepUpOtp(
  env: EmailEnv,
  db: AppDb,
  delivery: OtpDelivery,
  locale: Locale,
): Promise<boolean> {
  const subject = t(locale, 'identity.email.stepUpOtp.subject', { site: t(locale, 'site.name') });
  const body = t(locale, 'identity.email.stepUpOtp.body', { code: delivery.code });
  return sendEmail(env, db, {
    to: delivery.to,
    kind: 'identityStepUpOtp',
    subject,
    text: `${body}\n`,
    html: `<p>${body}</p>`,
    redactDevLogBody: true,
  });
}

/** Proof sent to the new address; it deliberately says nothing about account
 * ownership so a mailbox recipient cannot learn which profile requested it. */
export async function sendIdentityContactChangeOtp(
  env: EmailEnv,
  db: AppDb,
  delivery: OtpDelivery,
  locale: Locale,
): Promise<boolean> {
  const subject = t(locale, 'identity.email.contactChangeOtp.subject', { site: t(locale, 'site.name') });
  const body = t(locale, 'identity.email.contactChangeOtp.body', { code: delivery.code });
  return sendEmail(env, db, { to: delivery.to, kind: 'identityContactChangeOtp', subject, text: `${body}\n`, html: `<p>${body}</p>` });
}

/** Mailbox reachability proof only. The wording never claims an account match. */
export async function sendIdentityRecoveryOtp(
  env: EmailEnv,
  db: AppDb,
  delivery: OtpDelivery,
  locale: Locale,
): Promise<boolean> {
  const subject = t(locale, 'identity.email.recoveryOtp.subject', { site: t(locale, 'site.name') });
  const body = t(locale, 'identity.email.recoveryOtp.body', { code: delivery.code });
  return sendEmail(env, db, { to: delivery.to, kind: 'identityRecoveryOtp', subject, text: `${body}\n`, html: `<p>${body}</p>` });
}

export async function sendIdentityRecoveryNotice(
  env: EmailEnv,
  db: AppDb,
  input: Readonly<{ to: string; locale: Locale }>,
): Promise<boolean> {
  const subject = t(input.locale, 'identity.email.recoveryRequested.subject', { site: t(input.locale, 'site.name') });
  const body = t(input.locale, 'identity.email.recoveryRequested.body');
  return sendEmail(env, db, { to: input.to, kind: 'identityRecoveryRequested', subject, text: `${body}\n`, html: `<p>${body}</p>` });
}

/** Final, unambiguous security warning sent to every formerly verified mailbox
 * only after the reviewed ownership replacement commits. */
export async function sendIdentityRecoveryCompletedNotice(
  env: EmailEnv,
  db: AppDb,
  input: Readonly<{ to: string; locale: Locale }>,
): Promise<boolean> {
  const subject = t(input.locale, 'identity.email.recoveryCompleted.subject', { site: t(input.locale, 'site.name') });
  const body = t(input.locale, 'identity.email.recoveryCompleted.body');
  return sendEmail(env, db, { to: input.to, kind: 'identityRecoveryCompleted', subject, text: `${body}\n`, html: `<p>${body}</p>` });
}

/** The veto URL contains only a random bearer token and uses a no-referrer page. */
export async function sendIdentityRecoveryHoldNotice(
  env: EmailEnv,
  db: AppDb,
  input: Readonly<{ to: string; locale: Locale; vetoToken: string }>,
): Promise<boolean> {
  const origin = env.APP_ORIGIN?.replace(/\/$/u, '') ?? '';
  const link = `${origin}/${input.locale}/recovery-veto/${encodeURIComponent(input.vetoToken)}`;
  const subject = t(input.locale, 'identity.email.recoveryHold.subject', { site: t(input.locale, 'site.name') });
  const body = t(input.locale, 'identity.email.recoveryHold.body');
  return sendEmail(env, db, {
    to: input.to,
    kind: 'identityRecoveryHold',
    subject,
    text: `${body}\n\n${link}\n`,
    html: `<p>${body}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
  });
}

/** Non-secret alert sent only after the old verified owner has been revoked. */
export async function sendIdentityOldContactNotice(
  env: EmailEnv,
  db: AppDb,
  input: Readonly<{ to: string; locale: Locale }>,
): Promise<boolean> {
  const subject = t(input.locale, 'identity.email.oldContactNotice.subject', { site: t(input.locale, 'site.name') });
  const body = t(input.locale, 'identity.email.oldContactNotice.body');
  return sendEmail(env, db, { to: input.to, kind: 'identityOldContactNotice', subject, text: `${body}\n`, html: `<p>${body}</p>` });
}
