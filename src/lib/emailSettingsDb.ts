// Email automation settings + send log for the admin console Email tab. Rules
// are global on/off toggles (remind7 / remind3 / digestAM); templates are
// editable subject/body with {placeholder} variables, stored per locale
// (template_key + locale primary key); the log is written by lib/email.ts on
// every send. Ported from dcfc-serve's emailSettingsDb, adapted to church-cms's
// per-locale email_templates table (migration 0002).

export type RuleKey = 'remind7' | 'remind3' | 'digestAM';
export type TemplateKey = 'remind' | 'request' | 'appResult' | 'digestAM';

export interface EmailTemplate {
  template_key: string;
  locale: string;
  subject: string;
  body: string;
}

export interface EmailLogRow {
  id: number;
  to_email: string;
  to_name: string | null;
  kind: string;
  detail: string | null;
  status: string;
  created_at: string;
}

/** All rules as a { key: enabled } map, for rendering the toggle list. */
export async function listRules(db: D1Database): Promise<Record<string, boolean>> {
  const { results } = await db.prepare(`SELECT rule_key, enabled FROM email_rules`).all<{ rule_key: string; enabled: number }>();
  return Object.fromEntries(results.map((r) => [r.rule_key, r.enabled === 1]));
}

export async function isRuleEnabled(db: D1Database, key: RuleKey): Promise<boolean> {
  const row = await db.prepare(`SELECT enabled FROM email_rules WHERE rule_key = ?`).bind(key).first<{ enabled: number }>();
  return row?.enabled === 1;
}

export async function setRule(db: D1Database, key: string, enabled: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_rules (rule_key, enabled) VALUES (?1, ?2)
       ON CONFLICT(rule_key) DO UPDATE SET enabled = excluded.enabled`,
    )
    .bind(key, enabled ? 1 : 0)
    .run();
}

/** One template row for a (key, locale) pair, or null when unset. */
export async function getTemplate(db: D1Database, key: TemplateKey, locale: string): Promise<EmailTemplate | null> {
  return db
    .prepare(`SELECT template_key, locale, subject, body FROM email_templates WHERE template_key = ? AND locale = ?`)
    .bind(key, locale)
    .first<EmailTemplate>();
}

/** Every template row, template_key then locale, for the editor grid. */
export async function listTemplates(db: D1Database): Promise<EmailTemplate[]> {
  const { results } = await db
    .prepare(`SELECT template_key, locale, subject, body FROM email_templates ORDER BY template_key, locale`)
    .all<EmailTemplate>();
  return results;
}

export async function saveTemplate(
  db: D1Database,
  key: string,
  locale: string,
  subject: string,
  body: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_templates (template_key, locale, subject, body) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(template_key, locale) DO UPDATE SET subject = excluded.subject, body = excluded.body`,
    )
    .bind(key, locale, subject, body)
    .run();
}

/** Most recent send-log rows, newest first. */
export async function listEmailLog(db: D1Database, limit = 50): Promise<EmailLogRow[]> {
  const { results } = await db
    .prepare(`SELECT id, to_email, to_name, kind, detail, status, created_at FROM email_log ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(limit)
    .all<EmailLogRow>();
  return results;
}

/** Direct email_log insert (lib/email.ts logs its own sends; this is for tests/tools). */
export async function logEmail(
  db: D1Database,
  entry: { to_email: string; to_name?: string | null; kind: string; detail?: string | null; status: string },
): Promise<void> {
  await db
    .prepare(`INSERT INTO email_log (to_email, to_name, kind, detail, status) VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(entry.to_email, entry.to_name ?? '', entry.kind, entry.detail ?? null, entry.status)
    .run();
}

/** Substitute {var} placeholders in a template string. Unknown vars are left intact. */
export function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{([^}]+)\}/g, (match, key) => (key in vars ? vars[key] : match));
}
