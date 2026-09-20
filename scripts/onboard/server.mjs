import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateCss } from '../build-tokens.mjs';
import { resolveProvider } from '../setup/resolve-provider.mjs';
import { defaultPreferences, normalizePreferences, readPreferences, savePreferences, readLogo, PREFERENCES_PATH } from './preferences.mjs';

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function reply(res, status, value, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }

async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw httpError('Expected application/json', 415);
  const declaredLength = Number(req.headers['content-length']);
  if (declaredLength > MAX_BODY_BYTES) throw httpError('Request is too large', 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw httpError('Request is too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError('Invalid JSON'); }
}

export async function hasExistingInstallation(root) {
  for (const path of ['church.config.json', '.church/setup-state.json']) {
    try { await lstat(join(root, path)); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return false;
}

export async function startOnboardingServer({ root, catalog, port = 0 }) {
  catalog ??= JSON.parse(await readFile(new URL('../../config/capabilities.json', import.meta.url), 'utf8'));
  const foundation = JSON.parse(await readFile(new URL('../../design/foundation.json', import.meta.url), 'utf8'));
  const theme = JSON.parse(await readFile(new URL('../../design/themes/sanctuary.json', import.meta.url), 'utf8'));
  const tokenCss = generateCss(foundation, [theme]);
  const defaults = defaultPreferences(catalog);
  defaults.branding.primaryColor = theme.modes.light.primary;
  defaults.branding.secondaryColor = theme.modes.light.accent;
  // Fail visibly on corrupt local preferences rather than silently replacing them.
  await readPreferences(root, catalog);
  const token = randomBytes(32).toString('hex');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  let origin;
  let saving = false;
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) throw httpError('Unexpected host', 403);
      if (req.headers.origin && req.headers.origin !== origin) throw httpError('Unexpected origin', 403);
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const authorization = Buffer.from(req.headers.authorization ?? '');
        if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) throw httpError('Open the full onboarding URL printed in your terminal', 401);
        if (req.method === 'GET' && url.pathname === '/api/state') {
          return reply(res, 200, { catalog, defaults, preferences: await readPreferences(root, catalog), existingInstallation: await hasExistingInstallation(root) });
        }
        if (req.method === 'GET' && url.pathname === '/api/logo') {
          const preferences = await readPreferences(root, catalog);
          if (!preferences?.branding.logo) throw httpError('No logo saved', 404);
          return reply(res, 200, await readLogo(root, preferences.branding.logo), preferences.branding.logo.mimeType);
        }
        if (req.method === 'POST' && url.pathname === '/api/preferences') {
          if (saving) throw httpError('A save is already in progress. Try again.', 409);
          saving = true;
          try {
            const input = await jsonBody(req);
            normalizePreferences(input, catalog);
            const selected = input.setup.modules.map((key) => typeof key === 'string' ? key.trim() : key).filter(Boolean);
            const resolved = resolveProvider(selected, undefined, catalog);
            const existingInstallation = await hasExistingInstallation(root);
            const preferences = await savePreferences(root, input, catalog);
            return reply(res, 200, { preferences, backend: resolved.backend, addedDependencies: resolved.addedDependencies,
              preferencesPath: PREFERENCES_PATH, existingInstallation,
              commands: existingInstallation ? {} : {
                preview: `npm run setup -- --preferences ${PREFERENCES_PATH} --dry-run --json`,
                apply: `npm run setup -- --preferences ${PREFERENCES_PATH} --yes --json`,
              },
            });
          } finally { saving = false; }
        }
        throw httpError('Unknown onboarding API route or method', 404);
      }
      if (req.method !== 'GET') throw httpError('Method not allowed', 405);
      if (url.pathname === '/tokens.css') return reply(res, 200, tokenCss, 'text/css; charset=utf-8');
      const asset = ASSETS.get(url.pathname);
      if (!asset) throw httpError('Not found', 404);
      return reply(res, 200, await readFile(new URL(`web/${asset[0]}`, import.meta.url)), asset[1]);
    } catch (error) {
      const status = error.status ?? (['EACCES', 'EPERM', 'EIO'].includes(error.code) ? 500 : 400);
      reply(res, status, { error: error.message || 'Unable to save local preferences' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, token, url: `${origin}/#token=${token}`,
    close: () => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections(); }),
  };
}
