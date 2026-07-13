import { missingAnswers, normalizeSetupAnswers } from './answers.mjs';
import { resolveProvider } from './resolve-provider.mjs';
import { validateProviderResources } from './manifest.mjs';

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export function buildSetupPlan(answers, catalog, currentState = {}) {
  const normalized = normalizeSetupAnswers(answers, catalog);
  const selected = normalized.modules ?? catalog.presets?.[normalized.preset]?.modules;
  if (!selected?.length) throw new Error('Choose a preset or custom modules');

  const missing = missingAnswers(normalized).filter((key) => key !== 'featureChoice');
  if (missing.length) {
    if (normalized.mode === 'deploy' && missing.some((key) => key === 'appOrigin' || key === 'emailFrom')) {
      throw new Error(`Deploy setup requires ${missing.join(' and ')}`);
    }
    throw new Error(`Missing setup answer: ${missing[0]}`);
  }

  const resolved = resolveProvider(selected, normalized.backendOverride, catalog);
  if (currentState.existingBackend && currentState.existingBackend !== resolved.backend) {
    const migrationDetail =
      currentState.existingBackend === 'd1' && resolved.backend === 'supabase'
        ? 'D1-to-Supabase content migration is not implemented'
        : 'content migration between database providers is not implemented';
    throw new Error(
      `Existing ${currentState.existingBackend} installation cannot change to ${resolved.backend}: ${migrationDetail}`,
    );
  }
  const existingResources = currentState.resources
    ? { ...validateProviderResources(currentState.resources, resolved.backend, { requireBindingIds: true }) }
    : undefined;

  const enabled = new Set(resolved.modules);
  const moduleSettings = Object.fromEntries(
    catalog.order.map((key) => [`module.${key}`, enabled.has(key) ? '1' : '0']),
  );
  const services = [
    ...new Set([
      ...catalog.providers[resolved.backend].requiredServices,
      ...resolved.modules.flatMap((key) => catalog.capabilities[key].requiredServices),
    ]),
  ].sort();

  const actions = [
    'verify-provider',
    'ensure-resources',
    'write-manifest',
    'write-config',
    'configure-secrets',
    'migrate',
    ...(normalized.demoData ? ['seed', 'seed-media'] : []),
    'initialize-modules',
    'bootstrap-admin',
    'doctor',
  ];

  let existingInstallation;
  let proposedChanges;
  if (currentState.existingBackend) {
    existingInstallation = {
      backend: currentState.existingBackend,
      mode: currentState.mode ?? currentState.existingMode ?? normalized.mode,
      modules: Array.isArray(currentState.modules) ? [...currentState.modules] : [],
      siteSlug: currentState.siteSlug,
      churchName: currentState.churchName,
      locale: currentState.locale,
      adminEmail: currentState.adminEmail,
      adminName: currentState.adminName,
      appOrigin: currentState.appOrigin,
      emailFrom: currentState.emailFrom,
      resources: { ...(currentState.currentResources ?? currentState.resources ?? {}) },
    };
    proposedChanges = [];
    const changed = (label, before, after) => {
      if (before !== after) proposedChanges.push(`${label}: ${before ?? 'unknown'} -> ${after ?? 'unknown'}`);
    };
    changed('mode', currentState.mode ?? currentState.existingMode, normalized.mode);
    changed('site', currentState.churchName, normalized.churchName);
    changed('site slug', currentState.siteSlug, normalized.siteSlug);
    changed('locale', currentState.locale, normalized.locale);
    changed('admin', currentState.adminEmail, normalized.adminEmail);
    changed('app origin', currentState.appOrigin, normalized.appOrigin ?? 'http://localhost:4321');
    changed('email sender', currentState.emailFrom, normalized.emailFrom ?? `serve@${normalized.siteSlug}.invalid`);
    if (Array.isArray(currentState.modules) &&
        (currentState.modules.length !== resolved.modules.length || currentState.modules.some((key) => !resolved.modules.includes(key)))) {
      proposedChanges.push(`capabilities: ${currentState.modules.join(', ')} -> ${resolved.modules.join(', ')}`);
    }
  }

  return deepFreeze({
    planVersion: 1,
    mode: normalized.mode,
    site: {
      slug: normalized.siteSlug,
      name: normalized.churchName,
      locale: normalized.locale,
      appOrigin: normalized.appOrigin ?? 'http://localhost:4321',
      emailFrom: normalized.emailFrom ?? `serve@${normalized.siteSlug}.invalid`,
    },
    adminEmail: normalized.adminEmail,
    adminName: normalized.adminName,
    preset: normalized.preset ?? null,
    modules: resolved.modules,
    moduleSettings,
    backend: resolved.backend,
    providerSelectionReason: normalized.backendOverride
      ? 'explicit-override'
      : resolved.reasons.length ? 'capability-requirement' : 'default',
    providerReasons: resolved.reasons,
    addedDependencies: resolved.addedDependencies,
    services,
    ...(existingResources ? { resources: existingResources } : {}),
    demoData: Boolean(normalized.demoData),
    actions,
    ...(existingInstallation ? { existingInstallation, proposedChanges } : {}),
  });
}
