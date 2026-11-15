// Which language(s) an email is written in. Policy:
//  - the recipient's saved language when it is ENABLED;
//  - otherwise (no/unknown/disabled language) stack two languages ONLY when
//    exactly two are enabled, which preserves today's en+zh bilingual mail;
//  - with one enabled language, use it; with three or more, the default alone.
// Never more than two languages per message.
import type { AppDb } from './appDb';
import { loadDict } from './i18n';
import { LEGACY_LOCALE_SETTINGS, getLocaleSettings, type LocaleSettings } from './localeSettings';
import { isSupportedLocale, type SupportedLocale } from './locales';

export function emailLanguages(
  recipientLang: string | null | undefined,
  settings: LocaleSettings,
  viewing?: SupportedLocale | null,
): SupportedLocale[] {
  if (isSupportedLocale(recipientLang) && settings.enabled.includes(recipientLang)) return [recipientLang];
  const { enabled } = settings;
  if (enabled.length === 1) return [enabled[0]];
  if (enabled.length === 2) {
    if (viewing && enabled.includes(viewing)) return [viewing, enabled.find((c) => c !== viewing)!];
    // Legacy en+zh stacking leads with zh (the historical bilingualEmail order).
    if (enabled.includes('en') && enabled.includes('zh')) return ['zh', 'en'];
    const other = enabled.find((c) => c !== settings.default)!;
    return [settings.default, other];
  }
  return [settings.default];
}

/** Resolve the languages for one recipient and make their dictionaries resident
 *  so the synchronous t() calls that follow can render them. */
export async function emailLanguagesFor(
  db: AppDb,
  recipientLang: string | null | undefined,
  viewing?: SupportedLocale | null,
): Promise<SupportedLocale[]> {
  let settings = LEGACY_LOCALE_SETTINGS;
  try {
    settings = await getLocaleSettings(db);
  } catch {
    /* fail safe to the legacy en+zh state */
  }
  const langs = emailLanguages(recipientLang, settings, viewing);
  for (const lang of langs) await loadDict(lang);
  return langs;
}
