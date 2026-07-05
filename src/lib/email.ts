// The single choke point for all outgoing mail, so the provider lives in one
// file. Provider: the Cloudflare `send_email` Workers binding (env.EMAIL.send)
// with a hand-built RFC 5322 MIME message wrapped in EmailMessage from
// 'cloudflare:email'. sendEmail NEVER throws to its caller — a mail failure must
// not fail the request that triggered it — it logs to email_log and returns a
// boolean. When env.EMAIL_DEV_LOG === '1' the mail (including any magic link) is
// logged to the console and recorded as 'devlog' instead of being sent.
import { EmailMessage } from 'cloudflare:email';

// Structural env: EMAIL/EMAIL_FROM/APP_ORIGIN come from Cloudflare.Env, but
// EMAIL_DEV_LOG is a .dev.vars/secret that `wrangler types` cannot see, so it is
// optional here and callers cast their Worker env into this shape.
export interface EmailEnv {
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  EMAIL_DEV_LOG?: string;
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

/** Build a multipart/alternative MIME message (base64 text + html parts). */
function buildMime(from: string, msg: SendEmailInput): string {
  const boundary = `b_${crypto.randomUUID().replace(/-/g, '')}`;
  const lines = [
    `From: ${FROM_NAME} <${from}>`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
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
    '',
  ];
  return lines.join('\r\n');
}

type EmailStatus = 'sent' | 'failed' | 'devlog';

/** Record a send attempt in email_log. Swallows its own errors so logging can
 *  never be the thing that breaks (or masks) a send. */
async function logEmail(db: D1Database, msg: SendEmailInput, status: EmailStatus): Promise<void> {
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
  db: D1Database,
  msg: SendEmailInput,
): Promise<boolean> {
  if (env.EMAIL_DEV_LOG === '1') {
    // Dev mode: no real send. The full text (magic link included) goes to the
    // console so a developer can complete the flow from the terminal.
    console.log(`[email dev-log] to=${msg.to} kind=${msg.kind} subject=${msg.subject}\n${msg.text}`);
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
