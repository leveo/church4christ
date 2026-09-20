#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { startOnboardingServer } from './server.mjs';

export const ONBOARD_HELP = `Usage: npm run onboard -- [options]

Open a local browser guide for your church, nonprofit, or campus.
Saves identity, brand, logo, and initial features to .church/preferences.json.
Use the existing setup installer to review and apply those preferences afterward.

  --no-open       Print the URL without opening a browser (headless/remote sessions)
  --port NUMBER   Choose a loopback port; default 0 finds an available port
  --help         Show this help

The server binds to 127.0.0.1 only. Press Ctrl+C when finished.
`;

export function parseOnboardArgs(argv) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    help: { type: 'boolean' }, 'no-open': { type: 'boolean' }, port: { type: 'string' },
  } });
  if (values.help) return { help: true };
  if (values.port !== undefined && !/^\d{1,5}$/.test(values.port)) throw new Error('--port must be an integer from 0 to 65535');
  const port = Number(values.port ?? 0);
  if (port > 65535) throw new Error('--port must be an integer from 0 to 65535');
  return { help: false, open: !values['no-open'], port };
}

export function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('Browser could not be opened')));
  });
}

async function main() {
  const args = parseOnboardArgs(process.argv.slice(2));
  if (args.help) { console.log(ONBOARD_HELP); return; }
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const session = await startOnboardingServer({ root, port: args.port });
  console.log(`\nChurch4Christ — let's make it yours\n\n${session.url}\n\nPreferences stay in this checkout's .church/ directory.\nKeep this terminal open; press Ctrl+C after saving.\n`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await session.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (args.open) await openBrowser(session.url).catch(() => console.error('Open the full URL above in your browser to continue.'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`Onboarding: ${error.message}`); process.exitCode = 1; });
}
