import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { desiredCapabilityDocs } from './generate-capabilities.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const changed = [];
for (const [path, desired] of desiredCapabilityDocs(root)) {
  if (readFileSync(`${root}/${path}`, 'utf8') !== desired) changed.push(path);
}

if (changed.length > 0) {
  console.error(`capability documentation is stale: ${changed.join(', ')}`);
  console.error('run npm run docs:generate');
  process.exitCode = 1;
} else {
  console.log('capability documentation is current');
}
