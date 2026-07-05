// Notification mail. This slice ships only the magic sign-in link; scheduling
// request / decline notices arrive in slice 6. Callers treat a failure as
// non-fatal (sendEmail already never throws and returns a boolean).
import { createLoginToken } from './auth';
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
  db: D1Database,
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
