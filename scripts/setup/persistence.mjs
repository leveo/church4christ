import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** @param {string} root @param {Record<string, string | undefined>} [environment] */
export function resolveLocalPersistence(root, environment = process.env) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('persistence root must be absolute');
  const configured = environment?.WRANGLER_PERSIST_TO;
  if (configured !== undefined && (typeof configured !== 'string' || !configured.trim() || configured !== configured.trim() || /[\0-\x1f\x7f]/.test(configured) || configured.startsWith('-'))) {
    throw new Error('WRANGLER_PERSIST_TO must be a non-empty safe path');
  }
  const portable = (configured ?? '.wrangler/state').replaceAll('\\', '/');
  if (portable === '..' || portable.startsWith('../') || portable.includes('/../')) throw new Error('WRANGLER_PERSIST_TO must stay inside the project workspace');
  const realRoot = realpathSync(root);
  const path = resolve(realRoot, configured ?? '.wrangler/state');
  const rel = relative(realRoot, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error('WRANGLER_PERSIST_TO must stay inside the project workspace');
  }
  let cursor = realRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('WRANGLER_PERSIST_TO cannot traverse a symlink');
    const real = realpathSync(cursor);
    const fromRoot = relative(realRoot, real);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error('WRANGLER_PERSIST_TO escapes the project workspace');
  }
  return path;
}
