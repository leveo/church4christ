import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PLAIN = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CODE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const EXACT = (value, keys) => PLAIN(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const bilingual = (value) => EXACT(value, ['en', 'zh']) &&
  typeof value.en === 'string' && value.en.trim() !== '' && typeof value.zh === 'string' && value.zh.trim() !== '';

export function validateReadinessCatalog(value) {
  if (!EXACT(value, ['schemaVersion', 'categories', 'checks']) || value.schemaVersion !== 1) throw new TypeError('readiness catalog root is invalid');
  if (!Array.isArray(value.categories) || value.categories.length === 0 || value.categories.some((x) => typeof x !== 'string' || !ID.test(x)) || new Set(value.categories).size !== value.categories.length) {
    throw new TypeError('readiness categories are invalid');
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0) throw new TypeError('readiness checks are invalid');
  const ids = new Set();
  const codes = new Set();
  for (const check of value.checks) {
    if (!EXACT(check, ['id', 'category', 'severity', 'selectors', 'surfaces', 'title', 'description', 'remediation', 'adminPath', 'manualVersion', 'legacyCodes'])) throw new TypeError('readiness check fields are invalid');
    if (typeof check.id !== 'string' || !ID.test(check.id) || ids.has(check.id)) throw new TypeError(`readiness check id is invalid or duplicated: ${String(check.id)}`);
    ids.add(check.id);
    if (!value.categories.includes(check.category) || !['error', 'warning', 'info'].includes(check.severity)) throw new TypeError(`readiness check category or severity is invalid: ${check.id}`);
    if (!EXACT(check.selectors, ['capabilities', 'services'])) throw new TypeError(`readiness selectors are invalid: ${check.id}`);
    for (const key of ['capabilities', 'services']) {
      const selected = check.selectors[key];
      if (!Array.isArray(selected) || selected.some((x) => typeof x !== 'string' || !ID.test(x)) || new Set(selected).size !== selected.length) throw new TypeError(`readiness selector ${key} is invalid: ${check.id}`);
    }
    if (!Array.isArray(check.surfaces) || check.surfaces.length === 0 || check.surfaces.some((x) => !['cli', 'admin'].includes(x)) || new Set(check.surfaces).size !== check.surfaces.length) throw new TypeError(`readiness surfaces are invalid: ${check.id}`);
    if (!bilingual(check.title) || !bilingual(check.description) || !bilingual(check.remediation)) throw new TypeError(`readiness bilingual copy is invalid: ${check.id}`);
    if (!(check.adminPath === null || (typeof check.adminPath === 'string' && /^\/admin(?:\/|$)/.test(check.adminPath)))) throw new TypeError(`readiness admin path is invalid: ${check.id}`);
    if (!(check.manualVersion === null || (Number.isSafeInteger(check.manualVersion) && check.manualVersion > 0))) throw new TypeError(`readiness manual version is invalid: ${check.id}`);
    if (check.surfaces.includes('admin') && check.manualVersion === null && check.legacyCodes.length === 0) throw new TypeError(`admin-only readiness check needs a manual version: ${check.id}`);
    if (!Array.isArray(check.legacyCodes) || check.legacyCodes.some((code) => typeof code !== 'string' || !CODE.test(code) || codes.has(code))) throw new TypeError(`readiness legacy codes are invalid: ${check.id}`);
    for (const code of check.legacyCodes) codes.add(code);
  }
  return value;
}

export function productionReadinessCodes(root) {
  const found = new Set(['manifest.exception', 'config.exception', 'database.exception', 'services.exception']);
  for (const file of ['manifest.mjs', 'config.mjs', 'database.mjs', 'services.mjs']) {
    const source = readFileSync(resolve(root, 'scripts/setup/checks', file), 'utf8');
    for (const match of source.matchAll(/\b(?:result|issue)\('([^']+)'/g)) found.add(match[1]);
  }
  return found;
}

export function loadReadinessCatalog(path = 'config/readiness.json') {
  return validateReadinessCatalog(JSON.parse(readFileSync(path, 'utf8')));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  loadReadinessCatalog(process.argv[2]);
}
