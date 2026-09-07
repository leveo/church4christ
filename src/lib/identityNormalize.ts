export type PhoneNormalizationOptions = {
  /** Digits-only country calling code supplied by the trusted caller context. */
  defaultCountryCode?: string;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]+$/u;
const E164 = /^\+[1-9]\d{7,14}$/;
const COUNTRY_CODE = /^[1-9]\d{0,2}$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function hasIdentityControlCharacters(value: string): boolean { return CONTROL.test(value); }

/**
 * Stable contact-key normalization. Mailbox punctuation is deliberately kept:
 * providers differ on whether dots and plus tags are aliases.
 */
export function normalizeEmail(value: string): string | null {
  if (hasIdentityControlCharacters(value)) return null;
  const normalized = value.trim().normalize('NFC').toLocaleLowerCase('und');
  return normalized.length <= 254 && EMAIL.test(normalized) ? normalized : null;
}

/**
 * Returns E.164 only when the country context is explicit. National numbers
 * without a caller-provided country code are intentionally ambiguous.
 */
export function normalizePhone(value: string, options: PhoneNormalizationOptions = {}): string | null {
  if (hasIdentityControlCharacters(value)) return null;
  const compact = value.trim().replace(/[\s().-]/g, '');
  if (E164.test(compact)) return compact;
  if (!options.defaultCountryCode || !COUNTRY_CODE.test(options.defaultCountryCode)) return null;
  if (!/^\d{4,14}$/.test(compact) || compact.startsWith('0')) return null;
  const e164 = `+${options.defaultCountryCode}${compact}`;
  return E164.test(e164) ? e164 : null;
}

/** Comparison form only; display names remain separately stored without transliteration. */
export function normalizeName(value: string): string | null {
  if (hasIdentityControlCharacters(value)) return null;
  const normalized = value
    .trim()
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\p{P}\p{S}_]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized && normalized.length <= 512 ? normalized : null;
}
