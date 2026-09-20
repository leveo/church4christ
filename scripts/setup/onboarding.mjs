import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { normalizePreferences, readLogo } from '../onboard/preferences.mjs';
import { normalizeSetupAnswers } from './answers.mjs';
import { fingerprintPlan } from './state.mjs';
import { writeAtomic } from './files.mjs';
import { applyMediaPlan, uploadKey } from './media.mjs';

const BRANDING_FILE = '.church/branding.json';
const INITIALIZED_KEY = 'site.onboarding_initialized';

/** Read user data, never code. Logo paths are relative to the repository. */
export async function loadSetupPreferences(root, source, catalog) {
  if (typeof source !== 'string' || !source.trim() || /[\0\r\n]/.test(source)) throw new Error('--preferences requires a file path');
  const file = resolve(root, source);
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
    throw new Error('Preferences must be a regular JSON file smaller than 64 KiB');
  }
  let input;
  try { input = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('Preferences file contains invalid JSON'); }
  const preferences = normalizePreferences(input, catalog);
  if (preferences.branding.logo) await readLogo(root, preferences.branding.logo);
  return preferences;
}

/** Explicit flags win. A feature flag replaces the entire saved selection. */
export function mergePreferenceAnswers(parsed, preferences, catalog) {
  const values = {
    mode: 'local',
    modules: preferences.setup.modules,
    siteSlug: preferences.setup.siteSlug,
    churchName: preferences.organization.name,
    locale: preferences.setup.locale,
    adminEmail: preferences.setup.adminEmail,
    adminName: preferences.setup.adminName,
    demoData: preferences.setup.demoData,
  };
  if (parsed.preset || parsed.modules !== undefined) delete values.modules;
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined && key !== 'demoData') values[key] = value;
  }
  if (parsed.demoDataSpecified) values.demoData = parsed.demoData;
  return { ...parsed, ...normalizeSetupAnswers(values, catalog), demoDataSpecified: true };
}

export function withOnboardingPlan(plan, preferences, source, requestedModules) {
  const actions = [...plan.actions];
  actions.splice(actions.indexOf('initialize-modules'), 0, 'initialize-branding');
  return Object.freeze({
    ...plan,
    actions: Object.freeze(actions),
    onboarding: Object.freeze({
      source,
      // Recovery must repeat the requested selection, including its order, so
      // dependency additions and the resumable plan fingerprint stay identical.
      ...(!plan.preset && plan.addedDependencies.length && Array.isArray(requestedModules)
        ? { requestedModules: Object.freeze([...requestedModules]) } : {}),
      organization: Object.freeze({ ...preferences.organization, name: plan.site.name }),
      branding: Object.freeze({ ...preferences.branding }),
      brandingFile: BRANDING_FILE,
      application: 'Initialize site name, tagline, address, optional logo, and Sanctuary brand colors once; preserve later administrator edits.',
      agentPreferences: 'Organization type and timezone are recorded preferences; they do not change terminology or scheduling automatically.',
    }),
  });
}

/** Only a byte-equivalent plan may resume a preferences-driven installation. */
export async function assertOnboardingInstallation(root, plan, currentState) {
  try {
    const directory = await lstat(resolve(root, '.church'));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Local .church state must be a regular directory, not a symbolic link');
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  let state;
  try { state = JSON.parse(await readFile(resolve(root, '.church/setup-state.json'), 'utf8')); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Cannot verify existing setup state; preserve it and follow docs/upgrade.md');
  }
  if (!currentState.existingBackend && !state) {
    const existingBranding = await readBrandingFile(root);
    if (existingBranding !== null && existingBranding !== `${JSON.stringify(brandingConfig(plan), null, 2)}\n`) {
      throw new Error('Existing .church/branding.json differs from onboarding preferences; preserve it and review the customization');
    }
    return;
  }
  if (state?.planFingerprint === fingerprintPlan(plan) && state?.installationOrigin === 'managed') return;
  throw new Error('Onboarding preferences are for first setup. An existing installation or different setup plan was found; preserve its configuration and use docs/upgrade.md or the admin settings. Resume with the original preferences and flags.');
}

export function brandingConfig(plan) {
  return {
    schemaVersion: 1,
    theme: 'sanctuary',
    primaryColor: plan.onboarding.branding.primaryColor,
    secondaryColor: plan.onboarding.branding.secondaryColor,
  };
}

export function onboardingSettings(plan) {
  const { organization } = plan.onboarding;
  // One supplied name/tagline applies to both locales. Administrators can add
  // translations later; fictional seed translations must not mask their name.
  return {
    'site.name.en': plan.site.name,
    'site.name.zh': plan.site.name,
    'site.tagline.en': organization.tagline,
    'site.tagline.zh': organization.tagline,
    'site.address': organization.address,
    'locale.default': plan.site.locale,
    'theme.name': 'sanctuary',
    'theme.default_mode': 'light',
  };
}

function initializationMarker(plan) {
  return createHash('sha256').update(JSON.stringify({
    settings: onboardingSettings(plan), branding: plan.onboarding.branding,
  })).digest('hex');
}

async function readBrandingFile(root) {
  const file = resolve(root, BRANDING_FILE);
  try {
    const directory = await lstat(resolve(root, '.church'));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Local .church state must be a regular directory, not a symbolic link');
    const stats = await lstat(file);
    const actualRoot = await realpath(root);
    const target = relative(actualRoot, await realpath(file));
    if (!stats.isFile() || stats.isSymbolicLink() || target.startsWith('..') || isAbsolute(target)) {
      throw new Error('Local branding must be a regular file inside this repository');
    }
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Initial branding is its own resumable installer step, after fictional media. */
export function createOnboardingStep({ root, db, uploadObject, buildTokens }) {
  if (typeof buildTokens !== 'function') throw new TypeError('buildTokens is required');
  const marker = (plan) => db.prepare('SELECT value FROM settings WHERE key=?').bind(INITIALIZED_KEY).first('value');
  return Object.freeze({
    async verify({ plan, managedInstallation }) {
      if (!managedInstallation) throw new Error('Refusing to apply onboarding branding to an imported installation');
      const saved = await marker(plan);
      if (saved && saved !== initializationMarker(plan)) throw new Error('This database already has different onboarding preferences; use admin settings to customize it');
      // The marker owns initialization, not the continuing values. An admin
      // changing the logo, text, or local palette must never trigger a reset.
      return Boolean(saved && await readBrandingFile(root));
    },
    async apply({ plan, managedInstallation }) {
      if (!managedInstallation) throw new Error('Refusing to apply onboarding branding to an imported installation');
      const saved = await marker(plan);
      if (saved && saved !== initializationMarker(plan)) throw new Error('This database already has different onboarding preferences; use admin settings to customize it');
      const content = `${JSON.stringify(brandingConfig(plan), null, 2)}\n`;
      const current = await readBrandingFile(root);
      if (!saved && current !== null && current !== content) throw new Error('Existing .church/branding.json differs from onboarding preferences; preserve it and review the customization');
      if (current === null) await writeAtomic(resolve(root, BRANDING_FILE), content, { expectedContent: null });
      await buildTokens();
      if (saved) return { changed: current === null };
      const { logo } = plan.onboarding.branding;
      if (logo) {
        const bytes = await readLogo(root, logo);
        const file = `logo.${logo.mimeType === 'image/jpeg' ? 'jpg' : logo.mimeType.split('/')[1]}`;
        const mediaPlan = {
          uploadedBy: plan.adminEmail,
          assets: [{ file, key: uploadKey(bytes, file), contentType: logo.mimeType, size: bytes.length,
            contentBase64: bytes.toString('base64'), target: { type: 'setting', key: 'site.logo_image_key' } }],
          objects: [],
        };
        await applyMediaPlan({ mediaPlan, db, uploadObject });
      }
      await db.batch(Object.entries({ ...onboardingSettings(plan), [INITIALIZED_KEY]: initializationMarker(plan) })
        .map(([key, value]) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value)));
      return { changed: true };
    },
  });
}
