import { isAbsolute, relative, resolve } from 'node:path';

/** @param {string} root @param {Record<string, string | undefined>} [environment] */
export function resolveLocalPersistence(root, environment = process.env) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('persistence root must be absolute');
  const configured = environment?.WRANGLER_PERSIST_TO;
  if (configured !== undefined && (typeof configured !== 'string' || !configured.trim() || configured !== configured.trim() || /[\0-\x1f\x7f]/.test(configured) || configured.startsWith('-'))) {
    throw new Error('WRANGLER_PERSIST_TO must be a non-empty safe path');
  }
  const path = resolve(root, configured ?? '.wrangler/state');
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('WRANGLER_PERSIST_TO must stay inside the project workspace');
  return path;
}
