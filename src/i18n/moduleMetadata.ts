import { CAPABILITIES, CAPABILITY_KEYS, type CapabilityKey } from '../lib/capabilityCatalog';
import type { CatalogTranslations } from '../lib/i18n';

type ModuleCopyKey = `modules.${CapabilityKey}.${'label' | 'desc'}`;

/** Settings uses the same localized module inventory as setup and documentation.
 * English and Chinese come from config/capabilities.json (the validator requires
 * both). Other languages come from their src/i18n/catalog/<code>.json; entries a
 * translator has not written yet are simply absent and fall back to English. */
export function moduleMetadata(locale: 'en' | 'zh'): Record<ModuleCopyKey, string>;
export function moduleMetadata(locale: string, translations: CatalogTranslations): Partial<Record<ModuleCopyKey, string>>;
export function moduleMetadata(locale: string, translations?: CatalogTranslations): Partial<Record<ModuleCopyKey, string>> {
  const entries: [string, string][] = [];
  for (const key of CAPABILITY_KEYS) {
    const def = CAPABILITIES[key];
    const label = locale === 'en' || locale === 'zh' ? def.labels[locale] : translations?.capabilities?.[key]?.label;
    const desc = locale === 'en' || locale === 'zh' ? def.descriptions[locale] : translations?.capabilities?.[key]?.description;
    if (label) entries.push([`modules.${key}.label`, label]);
    if (desc) entries.push([`modules.${key}.desc`, desc]);
  }
  return Object.fromEntries(entries) as Partial<Record<ModuleCopyKey, string>>;
}
