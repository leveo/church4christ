import ts from 'typescript';

export function parseJsoncObject(content, label = 'configuration') {
  if (typeof content !== 'string') throw new TypeError(`${label} must be a string`);
  const parsed = ts.parseConfigFileTextToJson(label, content);
  if (parsed.error || !parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
    throw new Error(`${label} is invalid JSONC`);
  }
  return parsed.config;
}
