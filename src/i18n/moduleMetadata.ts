import { CAPABILITIES, CAPABILITY_KEYS, type CapabilityKey } from '../lib/capabilityCatalog';
import type { Locale } from '../lib/locales';

type ModuleCopyKey = `modules.${CapabilityKey}.${'label' | 'desc'}`;

/** Settings uses the same localized module inventory as setup and documentation.
 * Catalog validation guarantees both languages for every capability. */
export function moduleMetadata(locale: Locale): Record<ModuleCopyKey, string> {
  return Object.fromEntries(CAPABILITY_KEYS.flatMap((key) => [
    [`modules.${key}.label`, CAPABILITIES[key].labels[locale]],
    [`modules.${key}.desc`, CAPABILITIES[key].descriptions[locale]],
  ])) as Record<ModuleCopyKey, string>;
}
