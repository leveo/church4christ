// A capturing stand-in for src/lib/email.ts, shared by the D1 and Postgres registration
// mail suites (vi.mock factories cannot be shared, but the module they build can).
// sendEmail records the message and writes the same email_log row the real one does;
// `mail.fail` makes the next sends report failure.
import type { AppDb } from '../../src/lib/appDb';

export interface CapturedMail {
  to: string;
  toName?: string;
  kind: string;
  subject: string;
  html: string;
  text: string;
  detail?: string;
  redactDevLogBody?: boolean;
  attachments?: Array<{ filename: string; contentType: string; content: string | Uint8Array }>;
}

/** `fail`: every send reports failure. `failTo` / `throwTo`: only sends to those addresses fail / throw. */
export const mail = { sent: [] as CapturedMail[], fail: false, failTo: new Set<string>(), throwTo: new Set<string>() };

export function mockEmailModule() {
  return {
    escapeHtml: (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!),
    sendEmail: async (_env: unknown, db: AppDb, msg: CapturedMail): Promise<boolean> => {
      if (mail.throwTo.has(msg.to)) throw new Error('mail transport exploded');
      const failing = mail.fail || mail.failTo.has(msg.to);
      const status = failing ? 'failed' : 'devlog';
      await db
        .prepare(`INSERT INTO email_log (to_email, to_name, kind, detail, status) VALUES (?1, ?2, ?3, ?4, ?5)`)
        .bind(msg.to, msg.toName ?? '', msg.kind, msg.detail ?? null, status)
        .run();
      if (failing) return false;
      mail.sent.push(msg);
      return true;
    },
  };
}
