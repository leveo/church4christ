import { validateCapabilityCatalog } from '../lib/validate-capability-catalog.mjs';

export function resolveProvider(selectedModules, override, inputCatalog) {
  const catalog = validateCapabilityCatalog(inputCatalog);
  const selected = new Set(selectedModules);

  for (const key of selected) {
    if (!catalog.capabilities[key]) throw new Error(`Unknown capability: ${key}`);
  }
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
  const incompatible = modules.filter(
    (key) => catalog.capabilities[key].requiresBackend === 'supabase',
  );
  if (override === 'd1' && incompatible.length) {
    throw new Error(`${incompatible.join(', ')} require Supabase and cannot run on D1`);
  }

  return {
    backend: override ?? (incompatible.length ? 'supabase' : 'd1'),
    modules,
    addedDependencies,
    reasons: incompatible.map((key) => ({ capability: key, requiresBackend: 'supabase' })),
  };
}
