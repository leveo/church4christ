import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const EXACT_MANIFEST_KEYS = ['version', 'generatedWith', 'contentType', 'uploadedBy', 'assets'];
const EXACT_ASSET_KEYS = ['file', 'key', 'target'];
const CONTENT_TYPE = /^image\/(?:webp|png|jpeg|gif)$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SETTING_KEY = /^[a-z][a-z0-9_.-]*$/;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) throw new Error(`${label} has invalid fields`);
}

export function sanitizeFilename(filename) {
  if (typeof filename !== 'string' || filename !== basename(filename) || filename.includes('\\')) {
    throw new Error('media filename must be a plain filename');
  }
  const cleaned = filename.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'file';
  if (cleaned.length <= 64) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, Math.max(1, 64 - extension.length)) + extension;
}

export function uploadKey(bytes, filename) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('media bytes are required');
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `uploads/${hash.slice(0, 16)}-${sanitizeFilename(filename)}`;
}

function validateTarget(target, index) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error(`media asset ${index} target is invalid`);
  if (target.type === 'setting') {
    exactKeys(target, ['type', 'key'], `media asset ${index} target`);
    if (typeof target.key !== 'string' || !SETTING_KEY.test(target.key)) throw new Error(`media asset ${index} setting target is invalid`);
  } else if (['event', 'ministry', 'person'].includes(target.type)) {
    exactKeys(target, ['type', 'id'], `media asset ${index} target`);
    if (!Number.isSafeInteger(target.id) || target.id <= 0) throw new Error(`media asset ${index} target id is invalid`);
  } else {
    throw new Error(`media asset ${index} target type is invalid`);
  }
  return Object.freeze({ ...target });
}

export function loadMediaPlan({ root, manifestPath = 'seed/media/manifest.json' }) {
  if (typeof root !== 'string' || !isAbsolute(resolve(root))) throw new TypeError('media root is invalid');
  if (typeof manifestPath !== 'string' || isAbsolute(manifestPath)) throw new Error('media manifest path must be relative');
  const canonicalRoot = realpathSync(root);
  const absoluteManifest = resolve(canonicalRoot, manifestPath);
  const manifestRelative = relative(canonicalRoot, absoluteManifest);
  if (manifestRelative.startsWith('..') || isAbsolute(manifestRelative)) throw new Error('media manifest escapes root');
  const manifestStats = lstatSync(absoluteManifest);
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) throw new Error('media manifest must be a regular file');
  const canonicalManifest = realpathSync(absoluteManifest);
  const canonicalManifestRelative = relative(canonicalRoot, canonicalManifest);
  if (canonicalManifestRelative.startsWith('..') || isAbsolute(canonicalManifestRelative)) throw new Error('media manifest escapes root');
  let manifest;
  try { manifest = JSON.parse(readFileSync(canonicalManifest, 'utf8')); } catch { throw new Error('media manifest is invalid JSON'); }
  exactKeys(manifest, EXACT_MANIFEST_KEYS, 'media manifest');
  if (manifest.version !== 1) throw new Error('media manifest version must be 1');
  if (typeof manifest.generatedWith !== 'string' || !manifest.generatedWith) throw new Error('media generatedWith is invalid');
  if (typeof manifest.contentType !== 'string' || !CONTENT_TYPE.test(manifest.contentType)) throw new Error('media content type is invalid');
  if (typeof manifest.uploadedBy !== 'string' || !EMAIL.test(manifest.uploadedBy)) throw new Error('media uploadedBy is invalid');
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) throw new Error('media assets must be a non-empty array');
  const mediaDirectory = realpathSync(dirname(canonicalManifest));
  const seenFiles = new Set(); const seenKeys = new Set(); const seenTargets = new Set();
  const assets = manifest.assets.map((asset, index) => {
    exactKeys(asset, EXACT_ASSET_KEYS, `media asset ${index}`);
    sanitizeFilename(asset.file);
    if (seenFiles.has(asset.file)) throw new Error(`duplicate media file: ${asset.file}`);
    const filePath = join(mediaDirectory, asset.file);
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`media file must be a regular non-symlink: ${asset.file}`);
    const canonicalFile = realpathSync(filePath);
    const fileRelative = relative(mediaDirectory, canonicalFile);
    if (fileRelative.startsWith('..') || isAbsolute(fileRelative)) throw new Error(`media file escapes media directory: ${asset.file}`);
    const bytes = readFileSync(canonicalFile);
    const computed = uploadKey(bytes, asset.file);
    if (asset.key !== computed) throw new Error(`Key mismatch for ${asset.file}: manifest has ${asset.key}, computed ${computed}`);
    if (seenKeys.has(asset.key)) throw new Error(`duplicate media key: ${asset.key}`);
    const target = validateTarget(asset.target, index);
    const targetIdentity = JSON.stringify(target);
    if (seenTargets.has(targetIdentity)) throw new Error(`duplicate media target for ${asset.file}`);
    seenFiles.add(asset.file); seenKeys.add(asset.key); seenTargets.add(targetIdentity);
    return Object.freeze({ file: asset.file, filePath: canonicalFile, key: asset.key, contentType: manifest.contentType, size: bytes.length, target });
  });
  return Object.freeze({ version: 1, contentType: manifest.contentType, uploadedBy: manifest.uploadedBy, assets: Object.freeze(assets) });
}

function targetStatement(db, asset) {
  const { target, key } = asset;
  if (target.type === 'setting') return db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(target.key, key);
  if (target.type === 'event') return db.prepare('UPDATE events SET image_key = ? WHERE id = ?').bind(key, target.id);
  if (target.type === 'ministry') return db.prepare('UPDATE ministries SET cover_key = ? WHERE id = ?').bind(key, target.id);
  return db.prepare('UPDATE people SET avatar_url = ? WHERE id = ?').bind(`/media/${key}`, target.id);
}

export async function applyMediaPlan({ mediaPlan, db, uploadObject }) {
  if (!mediaPlan || !Array.isArray(mediaPlan.assets)) throw new TypeError('validated media plan is required');
  if (!db || typeof db.prepare !== 'function') throw new TypeError('AppDb is required');
  if (typeof uploadObject !== 'function') throw new TypeError('uploadObject is required');
  for (const asset of mediaPlan.assets) {
    await uploadObject({ key: asset.key, filePath: asset.filePath, contentType: asset.contentType });
    await db.prepare('INSERT INTO media (r2_key, filename, content_type, size, uploaded_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(r2_key) DO UPDATE SET filename = excluded.filename, content_type = excluded.content_type, size = excluded.size, uploaded_by = excluded.uploaded_by')
      .bind(asset.key, asset.file, asset.contentType, asset.size, mediaPlan.uploadedBy).run();
    const targetResult = await targetStatement(db, asset).run();
    if (!targetResult?.meta || !Number.isFinite(targetResult.meta.changes) || targetResult.meta.changes < 1) {
      throw new Error(`Media target did not exist for ${asset.file}`);
    }
  }
  return Object.freeze({ changed: true, uploaded: mediaPlan.assets.length });
}
