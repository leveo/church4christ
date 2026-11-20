// Registration emails, as pure builders: a RegistrationSummary in, a { subject, html,
// text, attachments } out. Confirmation (confirmed, waitlist, or paid), promotion off
// the waitlist, and cancellation (the whole registration or one person). Sending,
// token rotation and the `confirmation_sent_at` stamp live in regNotify.ts.
//
// One language per message: the caller resolves `locale` (the registration's own
// language when it is enabled, else the installation default) and loads its
// dictionary. Copy lives in the `reg.email.*` dictionary keys; t() would HTML-escape
// substituted values, so values are substituted raw here and escaped exactly once
// where they enter the HTML part (the plain-text part and the subject stay raw).
import type { AppDb } from './appDb';
import { escapeHtml, type EmailAttachment } from './email';
import { t } from './i18n';
import { formatDateWithWeekday, utcToDatetimeLocal } from './dates';
import { registrationICalendar } from './ical';
import { localeMeta, type Locale } from './locales';
import { CONFIRMATION_NO_RE } from './qrPng';
import type { RegistrationSummary } from './regManage';

export interface RegEmailOptions {
  locale: Locale;
  /** `${origin}/{locale}/register/manage#t=<token>`; the button and link are omitted without it. */
  manageUrl?: string | null;
  /** The public QR image URL; shown only for a confirmed registration. */
  qrUrl?: string | null;
  /** The site origin, for the calendar UID host. */
  origin?: string;
}

export interface BuiltRegEmail {
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
}

type Variant = 'confirmed' | 'waitlist' | 'paid' | 'promoted' | 'cancelled' | 'cancelledPerson';

// Email clients cannot read CSS variables, so the markup carries inline literals.
const C_INK = '#1f2937'; /* tokens-ok */
const C_MUTED = '#6b7280'; /* tokens-ok */
const C_RULE = '#e5e7eb'; /* tokens-ok */
const C_BRAND = '#2f4a7d'; /* tokens-ok */
const BUTTON = `display:inline-block;padding:12px 24px;border-radius:999px;background:${C_BRAND};color:#ffffff;font-weight:600;text-decoration:none`; /* tokens-ok */

/** The manage page link. The token rides in the fragment so it never reaches a server log. */
export function registrationManageUrl(origin: string, locale: Locale, token: string, campusSlug?: string | null): string {
  // The campus selector keeps the link on the registration's own campus when it is opened with no campus cookie.
  return `${origin}/${locale}/register/manage${campusQuery(campusSlug)}#t=${token}`;
}

const campusQuery = (slug?: string | null): string => (slug ? `?campus=${encodeURIComponent(slug)}` : '');

/** The slug of the campus a registration belongs to (not secret), or null when unknown. */
export async function registrationCampusSlug(db: AppDb, registrationId: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT c.slug AS slug FROM registrations r JOIN campuses c ON c.id = r.campus_id WHERE r.id = ?1`)
    .bind(registrationId)
    .first<{ slug: string }>();
  return row?.slug ?? null;
}

/** The QR image URL for a confirmed registration, or null when it has no usable confirmation number. */
export function registrationQrUrl(origin: string, eventId: number, confirmationNo: string | null, campusSlug?: string | null): string | null {
  return confirmationNo && CONFIRMATION_NO_RE.test(confirmationNo)
    ? `${origin}/register/qr/${eventId}/${confirmationNo}.png${campusQuery(campusSlug)}`
    : null;
}

/** Copy with `{name}` placeholders filled by RAW values (callers escape for HTML). */
function copy(locale: Locale, key: string, vars: Record<string, string | number> = {}): string {
  return t(locale, `reg.email.${key}`).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** "Sunday, July 5, 2026 18:00–20:00" in the church time zone (local to the event). */
function whenText(event: RegistrationSummary['event'], locale: Locale): string {
  const [date, time] = utcToDatetimeLocal(event.starts_at).split('T');
  if (!date) return '';
  let out = `${formatDateWithWeekday(date, locale)} ${time}`;
  const [endDate, endTime] = utcToDatetimeLocal(event.ends_at).split('T');
  if (endDate && endTime) {
    out += endDate === date ? `–${endTime}` : ` – ${formatDateWithWeekday(endDate, locale)} ${endTime}`;
  }
  return out;
}

function moneyText(cents: number, currency: string, locale: Locale): string {
  try {
    return new Intl.NumberFormat(localeMeta(locale).intl, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function host(origin: string | undefined): string {
  try {
    return origin ? new URL(origin).host || 'localhost' : 'localhost';
  } catch {
    return 'localhost';
  }
}

const multiline = (value: string): string => escapeHtml(value).replace(/\r?\n/g, '<br>');

function build(summary: RegistrationSummary, variant: Variant, opts: RegEmailOptions, person?: string): BuiltRegEmail {
  const { locale } = opts;
  const { event, registration } = summary;
  const title = event.title;
  const active = summary.attendees.filter((a) => a.status === 'active').map((a) => a.name);
  const showDetails = variant !== 'cancelled';

  const statusKey = variant === 'cancelled' ? 'cancelled' : registration.status === 'waitlist' ? 'waitlist' : 'confirmed';
  const intro = copy(locale, `intro.${variant}`, { person: person ?? '' });
  const subject = copy(locale, `subject.${variant}`, { title });
  const greeting = copy(locale, 'greeting', { name: registration.name });

  const rows: Array<[string, string, string]> = []; // [label, raw value, html value]
  const add = (label: string, value: string | null | undefined, html?: string) => {
    if (value) rows.push([label, value, html ?? escapeHtml(value)]);
  };
  add(copy(locale, 'label.confirmation'), registration.confirmation_no);
  add(copy(locale, 'label.status'), copy(locale, `status.${statusKey}`));
  if (showDetails) {
    add(copy(locale, 'label.when'), whenText(event, locale));
    add(copy(locale, 'label.where'), event.location);
    if (active.length > 0) add(copy(locale, 'label.people'), active.join(', '));
    if (variant === 'paid' && registration.amount_cents > 0) {
      add(copy(locale, 'label.amount'), moneyText(registration.amount_cents, registration.currency, locale));
    }
    if (event.notes) add(copy(locale, 'label.notes'), event.notes, multiline(event.notes));
  }

  const manageLabel = copy(locale, 'manage.button');
  const showManage = variant !== 'cancelled' && variant !== 'cancelledPerson' && Boolean(opts.manageUrl);
  const showQr = (variant === 'confirmed' || variant === 'paid' || variant === 'promoted')
    && registration.status === 'confirmed' && Boolean(opts.qrUrl);
  const attach = (variant === 'confirmed' || variant === 'paid' || variant === 'promoted' || variant === 'waitlist');

  const textParts = [greeting, '', intro, '', title];
  if (rows.length > 0) textParts.push('', ...rows.map(([label, value]) => `${label}: ${value}`));
  if (showManage) textParts.push('', `${manageLabel}: ${opts.manageUrl}`, copy(locale, 'manage.note'));
  if (showQr) textParts.push('', copy(locale, 'qr.caption'));
  if (attach) textParts.push('', copy(locale, 'ics.note'));
  if (variant === 'cancelled' || variant === 'cancelledPerson') textParts.push('', copy(locale, 'cancelled.hint'));

  const cell = 'padding:6px 12px 6px 0;vertical-align:top';
  const table = rows.length === 0 ? '' : `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0">${rows
    .map(([label, , html]) => `<tr><td style="${cell};color:${C_MUTED}">${escapeHtml(label)}</td><td style="${cell};color:${C_INK}">${html}</td></tr>`)
    .join('')}</table>`;
  const html = [
    `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:16px;line-height:1.5;color:${C_INK};max-width:560px">`, /* tokens-ok */
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<h2 style="margin:20px 0 4px;font-size:20px;color:${C_INK}">${escapeHtml(title)}</h2>`,
    table,
    showQr
      ? `<p style="margin:16px 0 4px"><img src="${escapeHtml(opts.qrUrl!)}" alt="${escapeHtml(copy(locale, 'qr.alt'))}" width="160" height="160" style="display:block;border:1px solid ${C_RULE}"></p><p style="margin:0 0 16px;color:${C_MUTED};font-size:14px">${escapeHtml(copy(locale, 'qr.caption'))}</p>`
      : '',
    showManage
      ? `<p style="margin:20px 0 8px"><a href="${escapeHtml(opts.manageUrl!)}" style="${BUTTON}">${escapeHtml(manageLabel)}</a></p><p style="margin:0 0 16px;color:${C_MUTED};font-size:14px">${escapeHtml(copy(locale, 'manage.note'))}</p>`
      : '',
    attach ? `<p style="color:${C_MUTED};font-size:14px">${escapeHtml(copy(locale, 'ics.note'))}</p>` : '',
    variant === 'cancelled' || variant === 'cancelledPerson'
      ? `<p style="color:${C_MUTED};font-size:14px">${escapeHtml(copy(locale, 'cancelled.hint'))}</p>`
      : '',
    '</div>',
  ].filter(Boolean).join('');

  const attachments: EmailAttachment[] = attach
    ? [{
        filename: 'event.ics',
        contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
        content: registrationICalendar(
          {
            id: registration.id,
            title,
            starts_at: event.starts_at,
            ends_at: event.ends_at,
            location: event.location,
            description: [registration.confirmation_no, event.notes].filter(Boolean).join('\n'),
          },
          host(opts.origin),
        ),
      }]
    : [];
  return { subject, html, text: textParts.join('\n') + '\n', attachments };
}

/**
 * The confirmation: "you're registered" (confirmed), "you're on the waitlist", or, for
 * a paid registration, "payment received" (a priced registration that is confirmed).
 */
export function confirmationEmail(summary: RegistrationSummary, opts: RegEmailOptions): BuiltRegEmail {
  const variant: Variant = summary.registration.status === 'waitlist'
    ? 'waitlist'
    : summary.registration.amount_cents > 0 ? 'paid' : 'confirmed';
  return build(summary, variant, opts);
}

/** "A place opened up": a waitlisted registration that is now confirmed. */
export function promotedEmail(summary: RegistrationSummary, opts: RegEmailOptions): BuiltRegEmail {
  return build(summary, 'promoted', opts);
}

/**
 * Cancellation. With `attendeeName`, one person left a registration that goes on (the
 * remaining people are listed); without it the whole registration was cancelled. No
 * manage link is ever included.
 */
export function cancelledEmail(
  summary: RegistrationSummary,
  opts: Omit<RegEmailOptions, 'manageUrl' | 'qrUrl'> & { attendeeName?: string },
): BuiltRegEmail {
  return build(summary, opts.attendeeName ? 'cancelledPerson' : 'cancelled', opts, opts.attendeeName);
}
