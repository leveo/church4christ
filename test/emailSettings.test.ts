// Email-settings DB (workers project, migrated D1 with 0002 seeds): rule
// upsert/read, per-locale template upsert, fillTemplate substitution, log
// ordering, and the sendEmail devlog path writing a row.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fillTemplate,
  getTemplate,
  isRuleEnabled,
  listEmailLog,
  listRules,
  logEmail,
  saveTemplate,
  setRule,
} from '../src/lib/emailSettingsDb';
import { sendEmail } from '../src/lib/email';

describe('email rules', () => {
  it('set + read, upsert flips value', async () => {
    await setRule(env.DB, 'remind7', true);
    await setRule(env.DB, 'remind3', false);
    expect(await isRuleEnabled(env.DB, 'remind7')).toBe(true);
    expect(await isRuleEnabled(env.DB, 'remind3')).toBe(false);
    await setRule(env.DB, 'remind3', true);
    expect(await isRuleEnabled(env.DB, 'remind3')).toBe(true);
    expect((await listRules(env.DB)).remind7).toBe(true);
  });
});

describe('email templates (per locale)', () => {
  it('save + read; upsert overwrites; locales are independent', async () => {
    await saveTemplate(env.DB, 'request', 'en', 'S-en', 'B-en');
    await saveTemplate(env.DB, 'request', 'zh', 'S-zh', 'B-zh');
    expect(await getTemplate(env.DB, 'request', 'en')).toMatchObject({ subject: 'S-en', body: 'B-en' });
    expect(await getTemplate(env.DB, 'request', 'zh')).toMatchObject({ subject: 'S-zh', body: 'B-zh' });
    await saveTemplate(env.DB, 'request', 'en', 'S2', 'B2');
    expect(await getTemplate(env.DB, 'request', 'en')).toMatchObject({ subject: 'S2', body: 'B2' });
    expect(await getTemplate(env.DB, 'request', 'zh')).toMatchObject({ subject: 'S-zh' }); // untouched
  });
});

describe('fillTemplate', () => {
  it('substitutes known vars and leaves unknown intact', () => {
    expect(fillTemplate('{name} on {date}', { name: 'Leo', date: '7/5' })).toBe('Leo on 7/5');
    expect(fillTemplate('{missing}', {})).toBe('{missing}');
  });
});

describe('email log', () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM email_log`).run();
  });

  it('logs and lists newest-first', async () => {
    await logEmail(env.DB, { to_email: 'a@x.com', to_name: 'A', kind: 'k1', status: 'sent' });
    await logEmail(env.DB, { to_email: 'b@x.com', to_name: 'B', kind: 'k2', status: 'bounced' });
    const log = await listEmailLog(env.DB, 5);
    expect(log[0].to_email).toBe('b@x.com');
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it('sendEmail dev-log path writes a devlog row', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendEmail({ EMAIL_DEV_LOG: '1' }, env.DB, { to: 'c@x.com', toName: 'C', kind: 'test', subject: 's', html: 'h', text: 't', detail: 'd' });
    spy.mockRestore();
    const row = await env.DB.prepare(`SELECT status, kind, detail FROM email_log WHERE to_email = 'c@x.com'`).first<{ status: string; kind: string; detail: string }>();
    expect(row).toMatchObject({ status: 'devlog', kind: 'test', detail: 'd' });
  });
});
