// id UI strings: PLACEHOLDER. Empty until the translation lands, so every key
// falls back along the chain (requested, default, en). Fill it in following
// docs/i18n.md, validate with `node scripts/i18n/check.mjs --locale id`, then
// remove "id" from config/i18n-status.json.
import type en from './en';
import type { DesignOverrides } from './designRegistry';
import catalogCopy from './catalog/id.json';
import { moduleMetadata } from './moduleMetadata';

const dict: Partial<Record<keyof typeof en, string>> = {
  ...moduleMetadata('id', catalogCopy),
};

export default dict as Record<string, string>;
/** Partial overrides for the per-surface design copy (src/i18n/design*.ts). */
export const design: DesignOverrides = {};
/** Translated capability, preset, and readiness copy. */
export const catalog = catalogCopy;
