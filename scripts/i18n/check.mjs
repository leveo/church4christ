#!/usr/bin/env node
// Validate translations: `node scripts/i18n/check.mjs [--locale es] [--strict] [--json]`.
//
// Without --locale every supported language is checked. A language listed in
// config/i18n-status.json (`inProgress`) is checked structurally only; use --strict
// to hold it to the full completeness rules, which is what to run before removing
// it from that list. Exit code 1 on any error; length-ratio warnings never fail.
import { SUPPORTED_CODES, IN_PROGRESS_LOCALES, checkLocale } from './lib.mjs';
import { loadI18nData } from './load.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const requested = option('--locale');
if (requested !== undefined && !SUPPORTED_CODES.includes(requested)) {
  console.error(`Unknown locale "${requested}". Supported: ${SUPPORTED_CODES.join(', ')}`);
  process.exit(2);
}
const strict = flag('--strict');
const data = await loadI18nData();
const targets = requested ? [requested] : SUPPORTED_CODES.filter((code) => code !== 'en');
const report = {};
let failed = false;
for (const code of targets) {
  const complete = strict || !IN_PROGRESS_LOCALES.has(code);
  const { errors, warnings } = checkLocale(code, data, { complete });
  report[code] = { complete, errors, warnings, keys: Object.keys(data.dicts[code] ?? {}).length };
  if (errors.length) failed = true;
}

if (flag('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const total = Object.keys(data.dicts.en).length;
  for (const [code, entry] of Object.entries(report)) {
    const mode = entry.complete ? 'complete' : 'in progress';
    console.log(`${code} (${mode}): ${entry.keys}/${total} dictionary keys, ${entry.errors.length} errors, ${entry.warnings.length} warnings`);
    for (const message of entry.errors.slice(0, 50)) console.log(`  error   ${message}`);
    if (entry.errors.length > 50) console.log(`  ... ${entry.errors.length - 50} more errors`);
    for (const message of entry.warnings.slice(0, 20)) console.log(`  warning ${message}`);
  }
}
process.exit(failed ? 1 : 0);
