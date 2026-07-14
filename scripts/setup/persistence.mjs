import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function localD1StateFile(databaseId) {
  if (typeof databaseId !== 'string' || !databaseId) throw new TypeError('local D1 database id is required');
  const key = createHash('sha256').update('miniflare-D1DatabaseObject').digest();
  const nameHmac = createHmac('sha256', key).update(databaseId).digest().subarray(0, 16);
  const hmac = createHmac('sha256', key).update(nameHmac).digest().subarray(0, 16);
  return `${Buffer.concat([nameHmac, hmac]).toString('hex')}.sqlite`;
}

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

/** Read-only discovery of actual Wrangler v3 D1 database files. */
export async function inspectLocalD1Persistence(root, environment = process.env, databaseId = 'YOUR_D1_DATABASE_ID') {
  const persistTo = resolveLocalPersistence(root, environment);
  const directory = resolve(persistTo, 'v3/d1/miniflare-D1DatabaseObject');
  let realDirectory;
  try {
    realDirectory = await realpath(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ persistTo, hasState: false, stateFiles: Object.freeze([]) });
    throw error;
  }
  const fromPersistence = relative(persistTo, realDirectory);
  if (fromPersistence === '..' || fromPersistence.startsWith(`..${sep}`) || isAbsolute(fromPersistence)) {
    throw new Error('Wrangler D1 persistence escapes the validated persistence root');
  }
  const expected = localD1StateFile(databaseId);
  const stateFiles = (await readdir(realDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name === expected)
    .map((entry) => entry.name)
    .sort();
  return Object.freeze({ persistTo, hasState: stateFiles.length > 0, stateFiles: Object.freeze(stateFiles) });
}
