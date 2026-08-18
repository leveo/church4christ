#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.map']);
const SCREENSHOT_DEV_MARKERS = Object.freeze([
  'screenshotSessionDev',
  'loadScreenshotSessionUser',
  'SCREENSHOT_SESSION_SECRET',
  'c4c-learning-screenshot-session-dev-only',
]);

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** Fail the production build if any screenshot-only authentication path leaks. */
export function assertNoScreenshotSessionInBundle(root = 'dist') {
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot)) throw new Error(`Production bundle is missing: ${absoluteRoot}`);
  for (const path of filesUnder(absoluteRoot)) {
    const name = relative(absoluteRoot, path);
    const markerInName = SCREENSHOT_DEV_MARKERS.some((marker) => name.includes(marker));
    const contents = TEXT_EXTENSIONS.has(extname(path)) ? readFileSync(path, 'utf8') : '';
    const markerInContents = SCREENSHOT_DEV_MARKERS.some((marker) => contents.includes(marker));
    if (markerInName || markerInContents) {
      throw new Error(`Screenshot-only session code found in production bundle: ${name}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  assertNoScreenshotSessionInBundle(process.argv[2] ?? 'dist');
  console.log('production bundle excludes screenshot-only session code');
}
