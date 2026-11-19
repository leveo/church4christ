// The single choke point for all outgoing mail, so the provider lives in one
// file. Provider: the Cloudflare `send_email` Workers binding (env.EMAIL.send)
// with a hand-built RFC 5322 MIME message wrapped in EmailMessage from
// 'cloudflare:email'. sendEmail NEVER throws to its caller — a mail failure must
// not fail the request that triggered it — it logs to email_log and returns a
// boolean. In development only, EMAIL_DEV_LOG='1' logs mail to the console and
// records it as 'devlog' instead of sending it; production builds ignore it.
import type { AppDb } from './appDb';
import { EmailMessage } from 'cloudflare:email';

// Structural env: EMAIL/EMAIL_FROM/APP_ORIGIN come from Cloudflare.Env, but
// EMAIL_DEV_LOG is a .dev.vars/secret that `wrangler types` cannot see, so it is
// optional here and callers cast their Worker env into this shape.
export interface EmailEnv {
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  EMAIL_DEV_LOG?: string;
  /** Built-worker tests only; production builds tree-shake this branch. */
  EMAIL_E2E_SINK?: string;
  APP_ORIGIN?: string;
}

export interface SendEmailInput {
  to: string;
  toName?: string;
  kind: string;
  subject: string;
  html: string;
  text: string;
  detail?: string;
  /** Keep proof material out of console logs even when EMAIL_DEV_LOG is enabled. */
  redactDevLogBody?: boolean;
  /** Files sent with the message (e.g. a calendar invite). Absent: the mail is exactly as before. */
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  /** Full media type, parameters included (e.g. `text/calendar; charset=utf-8; method=PUBLISH`). */
  contentType: string;
  /** Text is sent as UTF-8. */
  content: string | Uint8Array;
}

const FROM_NAME = 'Church4Christ';

/** Escape user-controlled text before it is interpolated into an HTML email. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** base64-encode raw bytes, chunking so large bodies don't overflow the stack. */
function base64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64utf8(value: string): string {
  return base64(new TextEncoder().encode(value));
}

/** RFC 2047 encoded-word for a header value; pure-ASCII passes through as-is so
 *  a plain English subject stays human-readable on the wire. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(value) ? value : `=?UTF-8?B?${b64utf8(value)}?=`;
}

/** Collapse CR/LF in a value interpolated into a MIME header — header-injection
 *  hardening so no future caller can smuggle extra headers through to/subject. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/** base64 wrapped at 76 characters per line (RFC 2045). */
function base64Lines(bytes: Uint8Array): string {
  return (base64(bytes).match(/.{1,76}/g) ?? []).join('\r\n');
}

/** A header-safe media type: no CR/LF, and nothing that could end the header value early. */
function contentTypeSafe(value: string): string {
  return headerSafe(value).replace(/[^\x20-\x7E]/g, '').trim() || 'application/octet-stream';
}

/** `filename` / `filename*` parameters for a Content-Disposition (RFC 2231 for non-ASCII). */
function dispositionFilename(raw: string): string {
  const cleaned = headerSafe(raw).replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').trim() || 'attachment';
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(cleaned)) return `filename="${cleaned}"`;
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, '_');
  const encoded = [...new TextEncoder().encode(cleaned)]
    .map((b) => (/[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`))
    .join('');
  return `filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Build the MIME message: multipart/alternative (base64 text + html parts), wrapped
 *  in multipart/mixed when there are attachments. */
export function buildMime(from: string, msg: SendEmailInput): string {
  const boundary = `b_${crypto.randomUUID().replace(/-/g, '')}`;
  const attachments = msg.attachments ?? [];
  const mixed = attachments.length > 0 ? `m_${crypto.randomUUID().replace(/-/g, '')}` : null;
  const lines = [
    `From: ${FROM_NAME} <${headerSafe(from)}>`,
    `To: ${headerSafe(msg.to)}`,
    `Subject: ${encodeHeader(headerSafe(msg.subject))}`,
    'MIME-Version: 1.0',
    ...(mixed
      ? [`Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`]
      : []),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64utf8(msg.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64utf8(msg.html),
    `--${boundary}--`,
  ];
  if (mixed) {
    for (const file of attachments) {
      const bytes = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content;
      lines.push(
        '',
        `--${mixed}`,
        `Content-Type: ${contentTypeSafe(file.contentType)}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; ${dispositionFilename(file.filename)}`,
        '',
        base64Lines(bytes),
      );
    }
    lines.push(`--${mixed}--`);
  }
  lines.push('');
  return lines.join('\r\n');
}

type EmailStatus = 'sent' | 'failed' | 'devlog';

/** Record a send attempt in email_log. Swallows its own errors so logging can
 *  never be the thing that breaks (or masks) a send. */
async function logEmail(db: AppDb, msg: SendEmailInput, status: EmailStatus): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO email_log (to_email, to_name, kind, detail, status) VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(msg.to, msg.toName ?? '', msg.kind, msg.detail ?? null, status)
      .run();
  } catch (e) {
    console.error('email log write failed', e);
  }
}

/**
 * Send one email through the provider. Returns true when the mail was sent (or
 * dev-logged), false when it could not be sent. Never throws: any provider error
 * is caught, logged to email_log as 'failed', and reported as `false`.
 */
export async function sendEmail(
  env: EmailEnv,
  db: AppDb,
  msg: SendEmailInput,
): Promise<boolean> {
  if (import.meta.env.DEV && env.EMAIL_DEV_LOG === '1') {
    // Dev mode: no real send. The full text (magic link included) goes to the
    // console so a developer can complete the flow from the terminal.
    const body = msg.redactDevLogBody ? '[sensitive email body omitted]' : msg.text;
    console.log(`[email dev-log] to=${msg.to} kind=${msg.kind} subject=${msg.subject}\n${body}`);
    await logEmail(db, msg, 'devlog');
    return true;
  }
  // Built-worker E2E needs successful delivery semantics without a live email
  // provider. This mode never logs the body, and the normal production build's
  // bundle gate proves the branch and binding name were tree-shaken away.
  if (import.meta.env.MODE === 'e2e' && env.EMAIL_E2E_SINK === '1') {
    await logEmail(db, msg, 'devlog');
    return true;
  }
  try {
    if (!env.EMAIL || !env.EMAIL_FROM) {
      console.warn(`[email] no sender configured; dropped mail to=${msg.to} kind=${msg.kind}`);
      await logEmail(db, msg, 'failed');
      return false;
    }
    await env.EMAIL.send(new EmailMessage(env.EMAIL_FROM, msg.to, buildMime(env.EMAIL_FROM, msg)));
    await logEmail(db, msg, 'sent');
    return true;
  } catch (e) {
    console.error('email send failed', e);
    await logEmail(db, msg, 'failed');
    return false;
  }
}
