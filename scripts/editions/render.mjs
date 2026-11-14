#!/usr/bin/env node
// Render the files of a single-feature edition repository from config/editions.json.
// An edition holds no application code: it describes one setup preset of the main repo
// and pins the released tag to install. Output is deterministic and needs no network.
//
//   node scripts/editions/render.mjs <edition-repo> <out-dir>
//   node scripts/editions/render.mjs --all <out-root>
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export async function loadEditionInputs(root = ROOT) {
  const read = (path) => readFile(join(root, path), 'utf8');
  const [config, catalog, pkg, license] = await Promise.all([
    read('config/editions.json').then(JSON.parse),
    read('config/capabilities.json').then(JSON.parse),
    read('package.json').then(JSON.parse),
    read('LICENSE'),
  ]);
  return { config, catalog, version: `v${pkg.version}`, license };
}

function presetLabel(catalog, edition) {
  const preset = catalog.presets?.[edition.preset];
  if (!preset) throw new Error(`Edition ${edition.repo} uses unknown preset ${edition.preset}`);
  return preset.labels.en;
}

function readme(edition, { config, catalog, version }) {
  const main = `https://github.com/${config.mainRepo}`;
  const blob = (path) => `${main}/blob/${version}/${path}`;
  const raw = (path) => `https://raw.githubusercontent.com/${config.mainRepo}/${version}/${path}`;
  const label = presetLabel(catalog, edition);
  const modules = catalog.presets[edition.preset].modules
    .map((key) => catalog.capabilities[key].labels.en).join(', ');
  const shots = edition.screenshots.map((s) => `![${s.alt}](${raw(s.path)})`).join('\n\n');
  const docs = edition.docs.map((d) => `- [${d.label}](${blob(d.path)})`).join('\n');
  const list = (items) => items.map((item) => `- ${item}`).join('\n');
  return `# ${edition.title}

${edition.tagline}

This repository is the **${label}** edition of [Church4Christ](${main}), an open-source
church management system and website. It contains no separate code: the quick start below
installs Church4Christ ${version} with only the ${label} features switched on (${modules}).
Everything else stays off until you turn it on.

**[Try the live demo](${config.demoUrl})** · [Main repository](${main}) · [Setup guide](${blob('docs/setup.md')})

## What you get

${list(edition.features)}

## Screenshots

${shots}

## Try the live demo

Open the [public sandbox](${config.demoUrl}). ${edition.demo} All data is fictional and resets every night.

## Quick start

You need [Git](https://git-scm.com/) and [Node.js](https://nodejs.org/) 22.22.1 or newer.
These commands work in macOS and Linux terminals and in Windows PowerShell.

\`\`\`bash
git clone --depth 1 --branch ${version} ${main}.git my-church
cd my-church
npm ci
npm run onboard -- --preset ${edition.preset}
\`\`\`

\`npm run onboard\` opens a local form in your browser for your church's name, colors, logo,
and first administrator, with the ${label} features already checked. Save the form, press
Ctrl+C in the terminal, then apply it and start the site:

\`\`\`bash
node scripts/setup/index.mjs --preferences .church/preferences.json --yes --dry-run
node scripts/setup/index.mjs --preferences .church/preferences.json --yes
npm run dev
\`\`\`

Prefer the terminal only? Run \`npm run setup -- --mode local --preset ${edition.preset}\`
instead of the form and answer the prompts.

Open the address the installer prints (usually \`http://localhost:4321\`). On your own
computer, sign-in links print to the terminal instead of being emailed.

## Good to know

${list(edition.limits)}

## Grow into the full system

This is the complete Church4Christ codebase with a focused starting point. When you are
ready, an administrator can turn on more features (sermons, events, volunteers, groups,
check-in, and more) in **Settings → Modules**, without reinstalling. Upgrades follow the
main repository's [upgrade guide](${blob('docs/upgrade.md')}).

## Learn more

${docs}
- [Putting it online with Cloudflare](${blob('docs/setup.md')})

## 中文简介

### ${edition.zh.title}

${edition.zh.summary}

${list(edition.zh.features)}

本仓库是 [Church4Christ](${main}) 的单一功能版本，不包含另外的代码。按上面的快速开始安装后，
得到的是完整的 Church4Christ ${version}，只预先开启了这一组功能；以后可以在「设置 → 模块」里开启更多功能。

## Questions and issues

Please open issues and questions in the [main repository](${main}/issues), where all the code
lives. Report security problems privately through its
[security advisories](${main}/security/advisories/new).

## License

[GNU GPL v3](LICENSE), the same license as Church4Christ.
`;
}

function agents(edition, { config, version }) {
  const main = `https://github.com/${config.mainRepo}`;
  return `# Instructions for AI coding agents

This repository holds no application code. It is the \`${edition.preset}\` edition of
Church4Christ (${main}).

To install it for a person:

1. Clone the pinned release: \`git clone --depth 1 --branch ${version} ${main}.git <dir>\`.
2. In that checkout, follow its own \`AGENTS.md\` (or \`CLAUDE.md\`) and \`docs/setup.md\`.
3. When the person runs onboarding, start it with \`npm run onboard -- --preset ${edition.preset}\`
   so the form pre-checks this edition's features. Let the person complete and save the form;
   never invent their preferences or submit it for them.
4. Apply with \`node scripts/setup/index.mjs --preferences .church/preferences.json --yes\`,
   after reviewing the \`--dry-run\` plan.

Make code changes in the main repository, not here.
`;
}

function issueConfig(_edition, { config }) {
  const main = `https://github.com/${config.mainRepo}`;
  return `blank_issues_enabled: false
contact_links:
  - name: Open an issue in the main Church4Christ repository
    url: ${main}/issues/new/choose
    about: All code lives in the main repository, so issues and questions are tracked there.
  - name: Try the live demo
    url: ${config.demoUrl}
    about: Explore the public sandbox with fictional data.
  - name: Report a security vulnerability
    url: ${main}/security/advisories/new
    about: Please report vulnerabilities privately, not in a public issue.
`;
}

function manifest(edition, { config, version }) {
  return `${JSON.stringify({
    mainRepo: config.mainRepo,
    version,
    preset: edition.preset,
    homepage: config.demoUrl,
    description: edition.description,
    topics: edition.topics,
  }, null, 2)}\n`;
}

/** Returns { relativePath: contents } for one edition repository. */
export function renderEdition(edition, inputs) {
  presetLabel(inputs.catalog, edition);
  return {
    'README.md': readme(edition, inputs),
    'AGENTS.md': agents(edition, inputs),
    'LICENSE': inputs.license,
    'edition.json': manifest(edition, inputs),
    '.github/ISSUE_TEMPLATE/config.yml': issueConfig(edition, inputs),
  };
}

async function writeEdition(files, outDir) {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(outDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

async function main(argv) {
  const inputs = await loadEditionInputs();
  if (argv[0] === '--all' && argv[1]) {
    for (const edition of inputs.config.editions) {
      await writeEdition(renderEdition(edition, inputs), join(argv[1], edition.repo));
    }
    return;
  }
  const [repo, outDir] = argv;
  const edition = inputs.config.editions.find((e) => e.repo === repo);
  if (!edition || !outDir) {
    throw new Error('usage: render.mjs <edition-repo> <out-dir> | --all <out-root>');
  }
  await writeEdition(renderEdition(edition, inputs), outDir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
