import { validateCapabilityCatalog } from '../lib/validate-capability-catalog.mjs';

const SUPPORTED_PROVIDERS = new Set(['d1', 'supabase']);
const providerLabel = (provider) => (provider === 'supabase' ? 'Supabase' : provider);

export function resolveProvider(selectedModules, override, inputCatalog) {
  const declaredProviders = Object.keys(inputCatalog?.providers ?? {});
  const requiredProviders = Object.values(inputCatalog?.capabilities ?? {})
    .map((definition) => definition?.requiresBackend)
    .filter((provider) => provider !== undefined);
  const unsupportedProviders = [...new Set([...declaredProviders, ...requiredProviders])].filter(
    (provider) => !SUPPORTED_PROVIDERS.has(provider),
  );
  if (unsupportedProviders.length) {
    throw new Error(`Unsupported database provider(s): ${unsupportedProviders.join(', ')}`);
  }

  const catalog = validateCapabilityCatalog(inputCatalog);
  const selected = new Set(selectedModules);
  const known = new Set(catalog.order);
  const unknown = [...selected].filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`Unknown capabilities: ${unknown.join(', ')}`);
  if (override !== undefined && override !== 'd1' && override !== 'supabase') {
    throw new Error(`Unknown database override: ${override}`);
  }

  const addedDependencies = [];
  const expand = (key) => {
    for (const dependency of catalog.capabilities[key].dependsOn ?? []) {
      if (selected.has(dependency)) continue;
      selected.add(dependency);
      addedDependencies.push({ capability: key, added: dependency });
      expand(dependency);
    }
  };
  for (const key of [...selected]) expand(key);

  const modules = catalog.order.filter((key) => selected.has(key));
  const requirements = modules
    .map((capability) => ({
      capability,
      requiresBackend: catalog.capabilities[capability].requiresBackend,
    }))
    .filter(({ requiresBackend }) => requiresBackend !== undefined);

  if (override !== undefined) {
    const incompatible = requirements.filter(
      ({ requiresBackend }) => requiresBackend !== override,
    );
    if (incompatible.length) {
      const providers = new Set(incompatible.map(({ requiresBackend }) => requiresBackend));
      const requirement =
        providers.size === 1
          ? `require ${providerLabel(incompatible[0].requiresBackend)}`
          : `have incompatible requirements (${incompatible
              .map(({ capability, requiresBackend }) =>
                `${capability}: ${providerLabel(requiresBackend)}`,
              )
              .join(', ')})`;
      throw new Error(
        `${incompatible.map(({ capability }) => capability).join(', ')} ${requirement} and cannot run on ${providerLabel(override)}`,
      );
    }
  }

  const requiredBackends = new Set(requirements.map(({ requiresBackend }) => requiresBackend));
  if (override === undefined && requiredBackends.size > 1) {
    throw new Error(
      `Conflicting database requirements: ${requirements
        .map(
          ({ capability, requiresBackend }) =>
            `${capability} requires ${providerLabel(requiresBackend)}`,
        )
        .join('; ')}`,
    );
  }
  const requiredBackend = requiredBackends.values().next().value;

  return {
    backend: override ?? requiredBackend ?? 'd1',
    modules,
    addedDependencies,
    reasons: requirements,
  };
}
