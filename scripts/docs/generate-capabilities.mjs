import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCapabilityCatalog } from '../lib/validate-capability-catalog.mjs';
import { writeAtomic } from '../setup/files.mjs';

export const START = '<!-- capabilities:start -->';
export const END = '<!-- capabilities:end -->';
export const GENERATED_DOCS = [
  'README.md',
  'docs/features/modules.md',
  'docs/architecture.md',
];

export function replaceGeneratedSection(document, generated) {
  const start = document.indexOf(START);
  const end = document.indexOf(END);
  const secondStart = start < 0 ? -1 : document.indexOf(START, start + START.length);
  const secondEnd = end < 0 ? -1 : document.indexOf(END, end + END.length);
  if (start < 0 || end < start || secondStart >= 0 || secondEnd >= 0) {
    throw new Error('expected exactly one ordered capabilities marker pair');
  }
  return `${document.slice(0, start + START.length)}\n${generated.trim()}\n${document.slice(end)}`;
}

export function escapeMarkdownCell(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '<br>')
    .replace(/\|/g, '\\|');
}

export function renderCapabilityTable(inputCatalog) {
  const catalog = validateCapabilityCatalog(inputCatalog);
  const rows = catalog.order.map((key) => {
    const definition = catalog.capabilities[key];
    const database = definition.requiresBackend === 'supabase' ? 'Supabase' : 'Either';
    return `| \`${escapeMarkdownCell(key)}\` | ${escapeMarkdownCell(definition.labels.en)} | ${escapeMarkdownCell(definition.labels.zh)} | ${escapeMarkdownCell(database)} |`;
  });
  return ['| Key | English | 中文 | Required database |', '|---|---|---|---|', ...rows].join('\n');
}

export function desiredCapabilityDocs(root = process.cwd()) {
  const catalog = JSON.parse(readFileSync(`${root}/config/capabilities.json`, 'utf8'));
  const table = renderCapabilityTable(catalog);
  return new Map(
    GENERATED_DOCS.map((path) => [
      path,
      replaceGeneratedSection(readFileSync(`${root}/${path}`, 'utf8'), table),
    ]),
  );
}

export async function generateCapabilityDocs(
  root = process.cwd(),
  { writer = writeAtomic, output = console.log } = {},
) {
  for (const [path, contents] of desiredCapabilityDocs(root)) {
    const target = `${root}/${path}`;
    const current = readFileSync(target, 'utf8');
    await writer(target, contents, {
      allowReplace: true,
      backup: false,
      expectedContent: current,
    });
    output(`generated ${path}`);
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) await generateCapabilityDocs(fileURLToPath(new URL('../..', import.meta.url)));
