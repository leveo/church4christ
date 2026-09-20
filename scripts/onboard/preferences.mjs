import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeSetupAnswers, missingAnswers } from '../setup/answers.mjs';
import { resolveProvider } from '../setup/resolve-provider.mjs';

export const PREFERENCES_PATH = '.church/preferences.json';
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_PATH = /^\.church\/onboarding-logo-([a-f0-9]{64})\.(png|jpg|webp)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function text(value, label, max, required = false) {
  if (typeof value !== 'string' || /[\0-\x1f\x7f]/.test(value) || value.length > max || (required && !value.trim())) {
    throw new Error(`${label} must be ${required ? 'nonempty ' : ''}text, at most ${max} characters`);
  }
  return value.trim();
}

function color(value, label) {
  if (typeof value !== 'string' || !/^#[a-f\d]{6}$/i.test(value)) throw new Error(`${label} must be a six-digit hex color`);
  return value.toUpperCase();
}

function logoReference(value) {
  if (value == null) return null;
  const logo = object(value, 'Logo');
  const match = typeof logo.path === 'string' && LOGO_PATH.exec(logo.path);
  if (!match || MIME[match[2]] !== logo.mimeType) throw new Error('Logo must reference a local onboarding image');
  return { path: logo.path, mimeType: logo.mimeType };
}

export function defaultPreferences(catalog) {
  return {
    schemaVersion: 1,
    organization: { type: 'church', name: '', tagline: '', address: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
    branding: { primaryColor: '#183D35', secondaryColor: '#C29A5B', logo: null },
    setup: { siteSlug: '', locale: 'en', adminName: '', adminEmail: '', demoData: true,
      modules: [...catalog.presets['website-community'].modules] },
  };
}

/** This file is data, never executable instructions. Return only known fields. */
export function normalizePreferences(input, catalog) {
  object(input, 'Preferences');
  if (input.schemaVersion !== 1) throw new Error('Unsupported preferences schemaVersion (expected 1)');
  const organization = object(input.organization, 'Organization');
  const branding = object(input.branding, 'Branding');
  const setup = object(input.setup, 'Setup');
  if (!['church', 'nonprofit', 'campus'].includes(organization.type)) throw new Error('Organization type must be church, nonprofit, or campus');
  const timezone = text(organization.timezone, 'Timezone', 100, true);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('Timezone must be a valid IANA timezone, such as America/Chicago'); }
  const name = text(organization.name, 'Organization name', 120, true);
  const adminName = text(setup.adminName, 'Administrator name', 120, true);
  if (typeof setup.demoData !== 'boolean') throw new Error('demoData must be a boolean');
  const siteSlug = text(setup.siteSlug, 'Site slug', 57, true);
  const answers = normalizeSetupAnswers({ mode: 'local', churchName: name, siteSlug,
    locale: setup.locale, adminName, adminEmail: setup.adminEmail, modules: setup.modules, demoData: setup.demoData }, catalog);
  const missing = missingAnswers(answers);
  if (missing.length) throw new Error(`Missing onboarding answers: ${missing.join(', ')}`);
  const { modules } = resolveProvider(answers.modules, undefined, catalog);
  return { schemaVersion: 1,
    organization: { type: organization.type, name, tagline: text(organization.tagline, 'Tagline', 240), address: text(organization.address, 'Address', 500), timezone },
    branding: { primaryColor: color(branding.primaryColor, 'Primary color'), secondaryColor: color(branding.secondaryColor, 'Secondary color'), logo: logoReference(branding.logo) },
    setup: { siteSlug, locale: answers.locale, adminName, adminEmail: answers.adminEmail, demoData: setup.demoData, modules },
  };
}

async function safePath(path, directory = false) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Unexpected local file type: ${path}`);
    return stat;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function privateRead(path, limit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Local onboarding file is invalid or too large');
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function readPreferences(root, catalog) {
  if (!await safePath(join(root, '.church'), true)) return null;
  if (!await safePath(join(root, PREFERENCES_PATH))) return null;
  const bytes = await privateRead(join(root, PREFERENCES_PATH), 64 * 1024);
  return normalizePreferences(JSON.parse(bytes.toString('utf8')), catalog);
}

function imageExtension(bytes, mimeType) {
  if (mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (mimeType === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (mimeType === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('Logo must contain a PNG, JPEG, or WebP image matching its type');
}

export async function readLogo(root, input) {
  const logo = logoReference(input);
  if (!logo) throw new Error('No logo selected');
  await safePath(join(root, '.church'), true);
  await safePath(join(root, logo.path));
  const bytes = await privateRead(join(root, logo.path), MAX_LOGO_BYTES);
  imageExtension(bytes, logo.mimeType);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (LOGO_PATH.exec(logo.path)[1] !== hash) throw new Error('Saved logo content does not match its fingerprint');
  return bytes;
}

async function atomicWrite(path, bytes) {
  await safePath(path);
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await safePath(path);
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function savePreferences(root, input, catalog) {
  const preferences = normalizePreferences(input, catalog);
  let uploaded;
  if (input.logoUpload != null) {
    object(input.logoUpload, 'Logo upload');
    const dataUrl = input.logoUpload.dataUrl;
    const match = typeof dataUrl === 'string' && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z\d+/]+={0,2})$/.exec(dataUrl);
    if (!match || match[2].length > Math.ceil(MAX_LOGO_BYTES / 3) * 4) throw new Error('Logo must be PNG, JPEG, or WebP, at most 2 MiB');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > MAX_LOGO_BYTES || bytes.toString('base64') !== match[2]) throw new Error('Invalid logo encoding or size');
    const extension = imageExtension(bytes, match[1]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    preferences.branding.logo = { path: `.church/onboarding-logo-${hash}.${extension}`, mimeType: match[1] };
    uploaded = bytes;
  } else if (preferences.branding.logo) {
    await readLogo(root, preferences.branding.logo);
  }
  await safePath(join(root, '.church'), true);
  await mkdir(join(root, '.church'), { recursive: true, mode: 0o700 });
  await safePath(join(root, '.church'), true);
  await safePath(join(root, PREFERENCES_PATH));
  if (uploaded) await atomicWrite(join(root, preferences.branding.logo.path), uploaded);
  await atomicWrite(join(root, PREFERENCES_PATH), `${JSON.stringify(preferences, null, 2)}\n`);
  return preferences;
}
