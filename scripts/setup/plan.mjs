import { missingAnswers } from './answers.mjs';
import { resolveProvider } from './resolve-provider.mjs';

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export function buildSetupPlan(answers, catalog, currentState = {}) {
  const selected = answers.modules ?? catalog.presets?.[answers.preset]?.modules;
  if (!selected?.length) throw new Error('Choose a preset or custom modules');

  const missing = missingAnswers(answers).filter((key) => key !== 'featureChoice');
  if (missing.length) {
    if (answers.mode === 'deploy' && missing.some((key) => key === 'appOrigin' || key === 'emailFrom')) {
      throw new Error(`Deploy setup requires ${missing.join(' and ')}`);
    }
    throw new Error(`Missing setup answer: ${missing[0]}`);
  }

  const resolved = resolveProvider(selected, answers.backendOverride, catalog);
  if (currentState.existingBackend && currentState.existingBackend !== resolved.backend) {
    const migrationDetail =
      currentState.existingBackend === 'd1' && resolved.backend === 'supabase'
        ? 'D1-to-Supabase content migration is not implemented'
        : 'content migration between database providers is not implemented';
    throw new Error(
      `Existing ${currentState.existingBackend} installation cannot change to ${resolved.backend}: ${migrationDetail}`,
    );
  }

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
    ...(answers.demoData ? ['seed', 'seed-media'] : []),
    'initialize-modules',
    'bootstrap-admin',
    'doctor',
  ];

  return deepFreeze({
    planVersion: 1,
    mode: answers.mode,
    site: {
      slug: answers.siteSlug,
      name: answers.churchName,
      locale: answers.locale,
      appOrigin: answers.appOrigin ?? 'http://localhost:4321',
      emailFrom: answers.emailFrom ?? `serve@${answers.siteSlug}.invalid`,
    },
    adminEmail: answers.adminEmail,
    adminName: answers.adminName,
    preset: answers.preset ?? null,
    modules: resolved.modules,
    moduleSettings,
    backend: resolved.backend,
    providerReasons: resolved.reasons,
    addedDependencies: resolved.addedDependencies,
    services,
    demoData: Boolean(answers.demoData),
    actions,
  });
}
