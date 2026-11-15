// Pure translation-quality checks shared by `scripts/i18n/check.mjs` (CLI) and the
// vitest parity suites. No filesystem access: callers pass the dictionaries in, so
// it runs in Node and in the Workers test pool alike.
//
// A locale is COMPLETE unless it is listed in config/i18n-status.json
// (`inProgress`). Complete locales must translate everything and are held to every
// rule; in-progress locales may omit keys (the app falls back to English) but
// whatever they DO supply must still be structurally sound.
import status from '../../config/i18n-status.json' with { type: 'json' };
import allowlist from '../../config/i18n-allowlist.json' with { type: 'json' };
import localesConfig from '../../config/locales.json' with { type: 'json' };

export const SUPPORTED_CODES = Object.freeze(localesConfig.supported.map((entry) => entry.code));
export const IN_PROGRESS_LOCALES = new Set(status.inProgress);
/** en is the source; every other locale not listed in-progress is complete. */
export const isComplete = (code) => !IN_PROGRESS_LOCALES.has(code);

/** Characters a translated value of this language must contain at least once. */
export const SCRIPT_REQUIREMENTS = {
  zh: /\p{Script=Han}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  ko: /\p{Script=Hangul}/u,
  hi: /\p{Script=Devanagari}/u,
};
/** Latin-script languages must not contain any of these (a pasted zh/ja/ko/hi copy). */
const FOREIGN_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Devanagari}]/u;
const LATIN_LOCALES = new Set(localesConfig.supported.map((e) => e.code).filter((c) => !(c in SCRIPT_REQUIREMENTS) && c !== 'en'));

export const LENGTH_RATIO_LIMIT = 1.6;
const SHORT_KEY = /(?:^|\.)nav\.|(?:^|\.)(?:save|cancel|submit|delete|remove|add|edit|back|next|continue|send|close|search|apply|confirm|create|download|upload|join|signin|signup|button|btn|cta)(?:$|[A-Z.])/;

const holders = (s) => (s.match(/\{\w+\}/g) ?? []).sort();
const tags = (s) => (s.match(/<\/?[a-zA-Z][^>]*>/g) ?? []).map((tag) => `<${tag.startsWith('</') ? '/' : ''}${/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)[1].toLowerCase()}>`).sort();
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Text that still needs translating: placeholders, tags, entities, URLs and digits removed. */
export function translatableText(value) {
  return value
    .replace(/\{\w+\}/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[#a-zA-Z0-9]+;/g, ' ')
    .replace(/https?:\/\/\S+|\b[\w.+-]+@[\w.-]+\b/g, ' ')
    .replace(/[^\p{L}]+/gu, ' ')
    .trim();
}

function allowed(code, key, englishValue) {
  const local = allowlist.locales?.[code] ?? { keys: [], values: [] };
  return allowlist.common.keys.includes(key) || local.keys.includes(key)
    || allowlist.common.values.includes(englishValue) || local.values.includes(englishValue);
}

/**
 * Check one set of key->text pairs against the English source.
 * `label` prefixes allowlist keys (e.g. `design.care.`), `strict` adds completeness,
 * identical-to-English, and script rules.
 */
function checkMap({ code, label = '', en, translated, strict, errors, warnings, placeholders = true }) {
  const where = (key) => `${code}:${label}${key}`;
  for (const key of Object.keys(translated)) {
    if (!(key in en)) errors.push(`${where(key)} is not a key of the English source`);
  }
  for (const key of Object.keys(en)) {
    const source = en[key];
    const value = translated[key];
    if (value === undefined) {
      if (strict) errors.push(`${where(key)} is missing`);
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${where(key)} is empty`);
      continue;
    }
    if (placeholders) {
      if (!equal(holders(value), holders(source))) errors.push(`${where(key)} placeholders ${JSON.stringify(holders(value))} differ from English ${JSON.stringify(holders(source))}`);
      if (!equal(tags(value), tags(source))) errors.push(`${where(key)} HTML tags ${JSON.stringify(tags(value))} differ from English ${JSON.stringify(tags(source))}`);
    }
    const needsText = translatableText(source) !== '';
    if (LATIN_LOCALES.has(code) && FOREIGN_SCRIPT.test(value)) errors.push(`${where(key)} contains non-Latin script`);
    if (!strict || !needsText || allowed(code, `${label}${key}`, source)) continue;
    if (value === source) errors.push(`${where(key)} is identical to English (translate it, or allowlist it in config/i18n-allowlist.json)`);
    else if (SCRIPT_REQUIREMENTS[code] && !SCRIPT_REQUIREMENTS[code].test(value)) errors.push(`${where(key)} has no ${code} script characters`);
    if (SHORT_KEY.test(`${label}${key}`) && source.length >= 4 && value.length > source.length * LENGTH_RATIO_LIMIT && !SCRIPT_REQUIREMENTS[code]) {
      warnings.push(`${where(key)} is ${(value.length / source.length).toFixed(1)}x the English length (${value.length} vs ${source.length}); check the layout`);
    }
  }
}

/** Dictionary parity for one locale: `en` and `dict` are flat key->text maps. */
export function checkDictionary(code, en, dict, { complete = isComplete(code) } = {}) {
  const errors = [];
  const warnings = [];
  if (code !== 'en') checkMap({ code, en, translated: dict, strict: complete, errors, warnings });
  return { errors, warnings };
}

/**
 * Design copy parity. `sources` is `{ [section]: { en, zh } }` (src/i18n/designRegistry);
 * `overrides` is the locale file's `design` export, or for zh the sources' own zh maps.
 */
export function checkDesign(code, sources, overrides, { complete = isComplete(code) } = {}) {
  const errors = [];
  const warnings = [];
  if (code === 'en') return { errors, warnings };
  for (const section of Object.keys(overrides ?? {})) {
    if (!(section in sources)) errors.push(`${code}:design.${section} is not a design section`);
  }
  for (const [section, source] of Object.entries(sources)) {
    const translated = code === 'zh' ? source.zh : (overrides?.[section] ?? {});
    checkMap({ code, label: `design.${section}.`, en: source.en, translated, strict: complete, errors, warnings, placeholders: false });
  }
  return { errors, warnings };
}

/**
 * Catalog copy parity (capability, preset, readiness text). `base` is the English and
 * Chinese copy from config/*.json: `{ capabilities: {key: {labels, descriptions}}, presets: {...},
 * readiness: [{id, title, description, remediation}] }`; `translations` is the locale's
 * src/i18n/catalog/<code>.json. Inline `{ [code]: text }` entries in the config JSON also count.
 */
export function checkCatalog(code, base, translations, { complete = isComplete(code) } = {}) {
  const errors = [];
  const warnings = [];
  if (code === 'en') return { errors, warnings };
  const en = {};
  const translated = {};
  const add = (kind, id, field, text) => {
    const key = `${kind}.${id}.${field}`;
    en[key] = text.en;
    const value = code === 'zh' ? text.zh : (translations?.[kind]?.[id]?.[field] ?? text[code]);
    if (value !== undefined) translated[key] = value;
  };
  for (const [id, def] of Object.entries(base.capabilities)) {
    add('capabilities', id, 'label', def.labels);
    add('capabilities', id, 'description', def.descriptions);
  }
  for (const [id, def] of Object.entries(base.presets)) {
    add('presets', id, 'label', def.labels);
    add('presets', id, 'description', def.descriptions);
  }
  for (const check of base.readiness) {
    for (const field of ['title', 'description', 'remediation']) add('readiness', check.id, field, check[field]);
  }
  for (const kind of ['capabilities', 'presets', 'readiness']) {
    for (const id of Object.keys(translations?.[kind] ?? {})) {
      const known = kind === 'readiness' ? base.readiness.some((check) => check.id === id) : id in base[kind];
      if (!known) errors.push(`${code}:catalog.${kind}.${id} is not in the catalog`);
    }
  }
  checkMap({ code, label: 'catalog.', en, translated, strict: complete, errors, warnings, placeholders: false });
  return { errors, warnings };
}

/** Everything for one locale; `data` carries the loaded dictionaries (see check.mjs). */
export function checkLocale(code, data, options = {}) {
  const parts = [
    checkDictionary(code, data.dicts.en, data.dicts[code] ?? {}, options),
    checkDesign(code, data.designSources, data.designs?.[code], options),
    checkCatalog(code, data.catalogBase, data.catalogs?.[code], options),
  ];
  return { errors: parts.flatMap((p) => p.errors), warnings: parts.flatMap((p) => p.warnings) };
}
