#!/usr/bin/env node
// Dump the translation source for translators as JSON.
//   node scripts/i18n/export-keys.mjs [--locale es] [--missing] [--out keys.json]
// Output: { en: {dictionary, design, catalog}, zh: {...} } (zh is a reference only).
// With --locale and --missing, only entries that locale has not translated yet are
// included, which makes it easy to translate a language in batches.
import { writeFileSync } from 'node:fs';
import { SUPPORTED_CODES } from './lib.mjs';
import { loadI18nData } from './load.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const locale = option('--locale');
if (locale !== undefined && !SUPPORTED_CODES.includes(locale)) {
  console.error(`Unknown locale "${locale}". Supported: ${SUPPORTED_CODES.join(', ')}`);
  process.exit(2);
}
const missingOnly = args.includes('--missing');
const data = await loadI18nData();

function catalogFor(code) {
  const out = { capabilities: {}, presets: {}, readiness: {} };
  for (const [id, def] of Object.entries(data.catalogBase.capabilities)) out.capabilities[id] = { label: def.labels[code], description: def.descriptions[code] };
  for (const [id, def] of Object.entries(data.catalogBase.presets)) out.presets[id] = { label: def.labels[code], description: def.descriptions[code] };
  for (const check of data.catalogBase.readiness) out.readiness[check.id] = { title: check.title[code], description: check.description[code], remediation: check.remediation[code] };
  return out;
}

function snapshot(code) {
  // modules.* dictionary keys are generated from the catalog copy (src/i18n/catalog/<code>.json).
  const dictionary = Object.fromEntries(Object.entries(data.dicts[code]).filter(([key]) => !key.startsWith('modules.')));
  return {
    dictionary,
    design: Object.fromEntries(Object.entries(data.designSources).map(([section, source]) => [section, { ...source[code] }])),
    catalog: catalogFor(code),
  };
}

const result = { en: snapshot('en'), zh: snapshot('zh') };
if (locale && missingOnly) {
  const have = { dictionary: data.dicts[locale] ?? {}, design: data.designs[locale] ?? {}, catalog: data.catalogs[locale] ?? {} };
  for (const key of Object.keys(result.en.dictionary)) {
    if (have.dictionary[key]) {
      delete result.en.dictionary[key];
      delete result.zh.dictionary[key];
    }
  }
  for (const [section, map] of Object.entries(result.en.design)) {
    for (const key of Object.keys(map)) {
      if (have.design[section]?.[key]) {
        delete map[key];
        delete result.zh.design[section][key];
      }
    }
  }
  for (const kind of ['capabilities', 'presets', 'readiness']) {
    for (const [id, fields] of Object.entries(result.en.catalog[kind])) {
      for (const field of Object.keys(fields)) {
        if (have.catalog[kind]?.[id]?.[field]) {
          delete fields[field];
          delete result.zh.catalog[kind][id][field];
        }
      }
    }
  }
}
const text = `${JSON.stringify(result, null, 2)}\n`;
const out = option('--out');
if (out) writeFileSync(out, text);
else process.stdout.write(text);
