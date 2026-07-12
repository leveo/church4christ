const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonblank = (value) => typeof value === 'string' && value.trim().length > 0;

export function validateCapabilityCatalog(input) {
  if (!isObject(input)) throw new Error('capability catalog must be an object');

  const errors = [];
  const fail = (message) => errors.push(message);
  const objectField = (value, name) => {
    if (!isObject(value)) {
      fail(`${name} must be an object`);
      return {};
    }
    return value;
  };
  const arrayField = (value, name) => {
    if (!Array.isArray(value)) {
      fail(`${name} must be an array`);
      return [];
    }
    return value;
  };

  if (input.schemaVersion !== 1) fail('schemaVersion must be 1');

  const providersObject = objectField(input.providers, 'providers');
  const presetsObject = objectField(input.presets, 'presets');
  const capabilities = objectField(input.capabilities, 'capabilities');
  const order = arrayField(input.order, 'order');
  const serviceList = arrayField(input.services, 'services');
  const groupList = arrayField(input.groups, 'groups');
  const keys = Object.keys(capabilities);
  const known = new Set(keys);
  const services = new Set(serviceList);
  const groups = new Set(groupList);
  const providers = new Set(Object.keys(providersObject));

  if (new Set(order).size !== order.length) fail('order contains duplicates');
  if ([...order].sort().join('\0') !== [...keys].sort().join('\0')) {
    fail('order must contain every capability key exactly once');
  }

  for (const [provider, rawDef] of Object.entries(providersObject)) {
    const def = objectField(rawDef, `provider ${provider}`);
    for (const field of ['requiredServices', 'optionalServices']) {
      for (const service of arrayField(def[field], `provider ${provider}.${field}`)) {
        if (!services.has(service)) fail(`provider ${provider} has unknown service ${service}`);
      }
    }
  }

  const exactOwners = new Map();
  for (const key of keys) {
    const def = objectField(capabilities[key], `capability ${key}`);
    for (const locale of ['en', 'zh']) {
      if (!isNonblank(def.labels?.[locale])) fail(`${key}.labels.${locale} is required`);
      if (!isNonblank(def.descriptions?.[locale])) {
        fail(`${key}.descriptions.${locale} is required`);
      }
    }

    if (!Number.isInteger(def.order) || def.order < 1) {
      fail(`${key}.order must be a positive integer`);
    }
    if (!groups.has(def.group)) fail(`${key} has unknown group ${String(def.group)}`);
    if (def.requiresBackend !== undefined && !providers.has(def.requiresBackend)) {
      fail(`${key} has unknown provider ${String(def.requiresBackend)}`);
    }

    for (const field of ['uses', 'dependsOn']) {
      for (const ref of arrayField(def[field], `${key}.${field}`)) {
        if (!known.has(ref)) fail(`${key} has unknown capability ${ref}`);
      }
    }
    for (const field of ['requiredServices', 'optionalServices']) {
      for (const service of arrayField(def[field], `${key}.${field}`)) {
        if (!services.has(service)) fail(`${key} has unknown service ${service}`);
      }
    }
    for (const field of ['publicPrefixes', 'adminPrefixes']) {
      for (const prefix of arrayField(def[field], `${key}.${field}`)) {
        if (typeof prefix !== 'string' || !prefix.startsWith('/')) {
          fail(`${key}.${field} contains invalid route; every route prefix must start with a slash`);
          continue;
        }
        const ownerKey = `${field}:${prefix}`;
        const owner = exactOwners.get(ownerKey);
        if (owner) {
          const kind = field === 'publicPrefixes' ? 'public' : 'admin';
          fail(`duplicate route prefix: ${kind} prefix ${prefix} is owned by ${owner} and ${key}`);
        } else {
          exactOwners.set(ownerKey, key);
        }
      }
    }
  }

  const numericOrders = keys.map((key) => capabilities[key]?.order);
  if (new Set(numericOrders).size !== numericOrders.length) {
    fail('capability numeric order contains duplicates');
  }
  if (order.some((key, index) => capabilities[key]?.order !== index + 1)) {
    fail('order array and capability numeric order position disagree');
  }

  for (const [preset, rawDef] of Object.entries(presetsObject)) {
    const def = objectField(rawDef, `preset ${preset}`);
    for (const locale of ['en', 'zh']) {
      if (!isNonblank(def.labels?.[locale])) fail(`preset ${preset}.labels.${locale} is required`);
      if (!isNonblank(def.descriptions?.[locale])) {
        fail(`preset ${preset}.descriptions.${locale} is required`);
      }
    }
    const modules = arrayField(def.modules, `preset ${preset}.modules`);
    if (new Set(modules).size !== modules.length) {
      fail(`preset ${preset} contains duplicate capabilities`);
    }
    for (const key of modules) {
      if (!known.has(key)) fail(`preset ${preset} has unknown capability ${key}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (key, trail) => {
    if (visiting.has(key)) {
      fail(`hard dependency cycle: ${[...trail, key].join(' -> ')}`);
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    const dependencies = Array.isArray(capabilities[key]?.dependsOn)
      ? capabilities[key].dependsOn
      : [];
    for (const next of dependencies) {
      if (known.has(next)) visit(next, [...trail, key]);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of keys) visit(key, []);

  if (errors.length) throw new Error(`Invalid capability catalog:\n- ${errors.join('\n- ')}`);
  return input;
}
