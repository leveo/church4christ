#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifestPath = join(root, 'seed/media/manifest.json');
const mediaDir = join(root, 'seed/media');
const portalFilesManifestPath = join(root, 'seed/portal-files/manifest.json');
const portalFilesDir = join(root, 'seed/portal-files');
const dryRun = process.argv.includes('--dry-run');

function sanitizeFilename(filename) {
  const cleaned =
    filename
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'file';
  if (cleaned.length <= 64) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, Math.max(1, 64 - ext.length)) + ext;
}

function uploadKey(bytes, filename) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `uploads/${hash.slice(0, 16)}-${sanitizeFilename(filename)}`;
}

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readBucketName() {
  if (process.env.MEDIA_BUCKET) return process.env.MEDIA_BUCKET;
  const config = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
  const match = config.match(/"bucket_name"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? 'church4christ-media';
}

function wranglerCommand() {
  if (process.env.WRANGLER_BIN) return [process.env.WRANGLER_BIN];
  // Run wrangler's JS entry with the current Node binary — identical on every
  // platform, and avoids spawning .cmd shims, which Node refuses without a shell.
  const local = join(root, 'node_modules/wrangler/bin/wrangler.js');
  if (!existsSync(local)) throw new Error('wrangler not found — run `npm install` first (or set WRANGLER_BIN)');
  return [process.execPath, local];
}

function runWrangler(args) {
  const [bin, ...prefix] = wranglerCommand();
  const persistedArgs = process.env.WRANGLER_PERSIST_TO ? [...args, '--persist-to', process.env.WRANGLER_PERSIST_TO] : args;
  const finalArgs = [...prefix, ...persistedArgs];
  if (dryRun) {
    console.log([bin, ...finalArgs].join(' '));
    return;
  }
  const result = spawnSync(bin, finalArgs, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function targetSql(asset, key) {
  const target = asset.target;
  if (target.type === 'setting') {
    return `INSERT INTO settings (key, value) VALUES (${sql(target.key)}, ${sql(key)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }
  if (target.type === 'event') {
    return `UPDATE events SET image_key = ${sql(key)} WHERE id = ${Number(target.id)}`;
  }
  if (target.type === 'ministry') {
    return `UPDATE ministries SET cover_key = ${sql(key)} WHERE id = ${Number(target.id)}`;
  }
  if (target.type === 'person') {
    return `UPDATE people SET avatar_url = ${sql(`/media/${key}`)} WHERE id = ${Number(target.id)}`;
  }
  throw new Error(`Unknown media target type: ${target.type}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const portalFilesManifest = existsSync(portalFilesManifestPath)
  ? JSON.parse(readFileSync(portalFilesManifestPath, 'utf8'))
  : { files: [] };
const bucket = readBucketName();
const contentType = manifest.contentType ?? 'image/webp';
const uploadedBy = manifest.uploadedBy ?? 'admin@example.com';
const statements = [];

for (const asset of manifest.assets) {
  const filePath = join(mediaDir, asset.file);
  const bytes = readFileSync(filePath);
  const key = uploadKey(bytes, asset.file);
  if (key !== asset.key) {
    throw new Error(`Key mismatch for ${asset.file}: manifest has ${asset.key}, computed ${key}`);
  }
  runWrangler([
    'r2',
    'object',
    'put',
    `${bucket}/${key}`,
    '--file',
    filePath,
    '--content-type',
    contentType,
    '--local',
    '--force',
  ]);
  statements.push(
    `INSERT INTO media (r2_key, filename, content_type, size, uploaded_by) VALUES (${sql(key)}, ${sql(asset.file)}, ${sql(contentType)}, ${bytes.length}, ${sql(uploadedBy)}) ON CONFLICT(r2_key) DO UPDATE SET filename = excluded.filename, content_type = excluded.content_type, size = excluded.size, uploaded_by = excluded.uploaded_by`,
  );
  statements.push(targetSql(asset, key));
}

// group_files is a portal-only Postgres table, so its metadata is seeded by
// seed/portal-seed.sql rather than this D1-oriented script. The object bytes do
// still belong in local R2, using the exact stable portal-seed key.
for (const file of portalFilesManifest.files) {
  const filePath = join(portalFilesDir, file.file);
  if (!existsSync(filePath)) throw new Error(`Portal seed file missing: ${file.file}`);
  runWrangler([
    'r2',
    'object',
    'put',
    `${bucket}/${file.key}`,
    '--file',
    filePath,
    '--content-type',
    file.contentType,
    '--local',
    '--force',
  ]);
}

const command = statements.join('; ');
if (dryRun) {
  console.log(command);
} else {
  runWrangler(['d1', 'execute', 'DB', '--local', '--command', command]);
  console.log(`Seeded ${manifest.assets.length} media assets and ${portalFilesManifest.files.length} portal files into local R2 and D1`);
}
