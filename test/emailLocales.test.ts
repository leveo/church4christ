import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { emailLanguages, emailLanguagesFor } from '../src/lib/emailLocales';
import { bilingualEmail } from '../src/lib/notify';
import { clearLocaleSettingsCache, saveLocaleSettings } from '../src/lib/localeSettings';
import { getTemplateWithFallback, saveTemplate } from '../src/lib/emailSettingsDb';
import { setRuntimeDefaultLocale } from '../src/lib/locales';

const db = env.DB;
const both = { enabled: ['en', 'zh'], default: 'en' } as const;

describe('emailLanguages policy', () => {
  it('uses the recipient language when enabled', () => {
    expect(emailLanguages('zh', both)).toEqual(['zh']);
    expect(emailLanguages('en', both)).toEqual(['en']);
  });

  it('stacks zh then en for an unknown recipient when exactly en+zh are enabled (legacy)', () => {
    expect(emailLanguages(null, both)).toEqual(['zh', 'en']);
    expect(emailLanguages('fr', both)).toEqual(['zh', 'en']);
  });

  it('leads with the viewed language for sign-in style mail', () => {
    expect(emailLanguages(null, both, 'en')).toEqual(['en', 'zh']);
    expect(emailLanguages(null, both, 'zh')).toEqual(['zh', 'en']);
  });

  it('never stacks with a single enabled language and ignores a disabled recipient language', () => {
    expect(emailLanguages(null, { enabled: ['en'], default: 'en' })).toEqual(['en']);
    expect(emailLanguages('zh', { enabled: ['en'], default: 'en' })).toEqual(['en']);
    expect(emailLanguages(null, { enabled: ['zh'], default: 'zh' })).toEqual(['zh']);
  });

  it('never exceeds two languages (three or more enabled falls to the default)', () => {
    const many = { enabled: ['en', 'zh', 'es'], default: 'zh' } as unknown as Parameters<typeof emailLanguages>[1];
    expect(emailLanguages(null, many)).toEqual(['zh']);
  });

  it('stacks default then the other for a non en+zh pair', () => {
    const pair = { enabled: ['zh', 'es'], default: 'es' } as unknown as Parameters<typeof emailLanguages>[1];
    expect(emailLanguages(null, pair)).toEqual(['es', 'zh']);
  });
});

describe('emailLanguagesFor + bilingualEmail', () => {
  beforeEach(async () => {
    await db.prepare("DELETE FROM settings WHERE key LIKE 'locale.%'").run();
    clearLocaleSettingsCache();
    setRuntimeDefaultLocale('en');
  });

  it('keeps today\'s stacked zh+en message for an untouched install', async () => {
    const langs = await emailLanguagesFor(db, null);
    expect(langs).toEqual(['zh', 'en']);
    const stacked = bilingualEmail({ subjectKey: 'auth.email.subject', bodyKey: 'auth.email.body', langs });
    const legacy = bilingualEmail({ subjectKey: 'auth.email.subject', bodyKey: 'auth.email.body' });
    expect(stacked).toEqual(legacy);
  });

  it('sends a single language once only one is enabled', async () => {
    await saveLocaleSettings(db, ['en'], 'en');
    expect(await emailLanguagesFor(db, null)).toEqual(['en']);
    expect(await emailLanguagesFor(db, 'zh')).toEqual(['en']);
  });
});

describe('email template fallback', () => {
  it('falls through requested, default, then en', async () => {
    await db.prepare("DELETE FROM email_templates WHERE template_key = 'request'").run();
    await saveTemplate(db, 'request' as never, 'en', 'EN subject', 'EN body');
    const hit = await getTemplateWithFallback(db, 'request' as never, 'zh');
    expect(hit?.locale).toBe('en');
    await saveTemplate(db, 'request' as never, 'zh', 'ZH subject', 'ZH body');
    expect((await getTemplateWithFallback(db, 'request' as never, 'zh'))?.locale).toBe('zh');
  });
});
