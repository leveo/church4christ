const PLAIN = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function variants(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new TypeError('redaction secrets must be an array of strings');
  }
  const found = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || value.length < 8) return;
    found.add(value);
    try {
      const decoded = decodeURIComponent(value);
      if (decoded.length >= 8) found.add(decoded);
    } catch {}
    const encoded = encodeURIComponent(value);
    if (encoded.length >= 8) found.add(encoded);
  };
  const addUrl = (value) => {
    if (!/^\w+:\/\//.test(value)) return;
    try {
      const url = new URL(value);
      add(url.username);
      add(url.password);
      for (const queryValue of url.searchParams.values()) add(queryValue);
    } catch {}
  };
  for (const value of values) {
    add(value);
    addUrl(value);
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      add(trimmed);
      const equals = trimmed.indexOf('=');
      if (equals >= 0) add(trimmed.slice(equals + 1));
    }
  }
  return [...found].filter(Boolean).sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function redactText(value, secrets) {
  let output = value;
  for (const secret of secrets) output = output.replaceAll(secret, '[REDACTED]');
  return output;
}

export function redact(value, secrets = []) {
  const registered = variants(secrets);
  const visiting = new Set();
  const visit = (entry) => {
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'number') {
      if (typeof entry === 'number' && !Number.isFinite(entry)) throw new TypeError('redaction accepts plain JSON values only');
      return entry;
    }
    if (typeof entry === 'string') return redactText(entry, registered);
    if (typeof entry !== 'object' || (!Array.isArray(entry) && !PLAIN(entry))) {
      throw new TypeError('redaction accepts plain JSON values only');
    }
    if (visiting.has(entry)) throw new TypeError('redaction cannot process cyclic JSON');
    visiting.add(entry);
    let output;
    if (Array.isArray(entry)) {
      output = entry.map(visit);
    } else {
      output = {};
      for (const [key, child] of Object.entries(entry)) {
        const safeKey = redactText(key, registered);
        if (Object.hasOwn(output, safeKey)) throw new Error('redaction produced a duplicate object key');
        output[safeKey] = visit(child);
      }
    }
    visiting.delete(entry);
    return output;
  };
  const freeze = (entry) => {
    if (entry && typeof entry === 'object' && !Object.isFrozen(entry)) {
      Object.freeze(entry);
      for (const child of Object.values(entry)) freeze(child);
    }
    return entry;
  };
  return freeze(visit(value));
}

export { variants as registeredSecretVariants };
