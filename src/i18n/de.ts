// de UI strings: PLACEHOLDER. Empty until the translation lands, so every key
// falls back along the chain (requested, default, en). Fill it in following
// docs/i18n.md, validate with `node scripts/i18n/check.mjs --locale de`, then
// remove "de" from config/i18n-status.json.
import type en from './en';
import type { DesignOverrides } from './designRegistry';
import catalogCopy from './catalog/de.json';
import { moduleMetadata } from './moduleMetadata';

const dict: Partial<Record<keyof typeof en, string>> = {
  ...moduleMetadata('de', catalogCopy),
};

export default dict as Record<string, string>;
/** Partial overrides for the per-surface design copy (src/i18n/design*.ts). */
export const design: DesignOverrides = {};
/** Translated capability, preset, and readiness copy. */
export const catalog = catalogCopy;
