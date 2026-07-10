#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Reusable public-site screenshot harness.
//
// Drives system Chrome in headless mode over the Chrome DevTools Protocol (CDP)
// via Node's built-in global WebSocket + fetch — no third-party dependency. It
// captures every page in the PAGES table below at a fixed 1280x800 viewport and
// writes PNGs under docs/images/**, asserting each is exactly 1280x800 and
// larger than 20 KB (guards against blank/failed captures).
//
// PREREQUISITES
//   1. A seeded local D1 dev server is already running:
//        npm run db:migrate:local && npm run db:seed:local
//        npm run dev                       # astro dev on http://localhost:4321
//      (Admin pages — none in the default table — additionally need the dev
//       server started with AUTH_DEV_BYPASS_EMAIL=admin@example.com so the
//       import.meta.env.DEV auth bypass grants an admin session.)
//   2. Google Chrome / Chromium installed. Override the binary with CHROME_PATH.
//
// USAGE
//   npm run screenshots
//   node scripts/screenshots.mjs --base http://localhost:4321
//   node scripts/screenshots.mjs --only person-detail.png,opportunities.png
//
// AUTH'D SHOTS (admin + member)
//   The dev bypass is a single global env (AUTH_DEV_BYPASS_EMAIL) the dev server
//   reads at boot, so a page needing a *different* identity than the running
//   server can't be shot in the same pass. Each authed PAGES row carries a
//   `bypass` email documenting whose session it needs (admin rows imply
//   admin@example.com). Capture them in separate passes, each with a dev server
//   booted for that identity and `--only` selecting the matching shot(s):
//     # public + admin pass
//     AUTH_DEV_BYPASS_EMAIL=admin@example.com npm run dev &
//     node scripts/screenshots.mjs --only opportunities.png,person-detail.png
//     # member (David Chen) pass — the Chen-household self-service card
//     AUTH_DEV_BYPASS_EMAIL=pastor.david@example.com npm run dev &
//     node scripts/screenshots.mjs --only profile-household.png
//   `--only <substr[,substr...]>` keeps only rows whose `out` contains a token.
//
// VARIANTS (see PAGES rows)
//   theme + mode : the theme is normally driven by the DB `theme.name` /
//     `theme.default_mode` settings. Rather than mutate the database per shot,
//     this harness flips data-theme / data-mode on <html> via CDP *after* load
//     (document.documentElement.setAttribute) and waits a frame. Because every
//     token is a CSS custom property keyed off those attributes, the result is
//     pixel-identical to a real settings flip — an honest demo of each theme.
//   hant : Traditional-Chinese shots reproduce the "繁" header toggle, which
//     persists localStorage `c4c-hant='1'` and reloads. The harness seeds that
//     same key at document-start (addScriptToEvaluateOnNewDocument) so the page
//     traditionalizes itself on first paint — same end state as a user click,
//     without a reload race. The baseline script also clears the key for every
//     other shot, so capture order never cross-contaminates localStorage.
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VIEWPORT = { width: 1280, height: 800 };
const MIN_BYTES = 20 * 1024;

// --- config -----------------------------------------------------------------
// Each row: { path, out, admin?, bypass?, hant?, theme?, mode?, backend? }
//   path   — URL path on --base (default http://localhost:4321)
//   out    — repo-relative PNG destination
//   admin  — page needs an admin dev-bypass session (AUTH_DEV_BYPASS_EMAIL=
//            admin@example.com); default false
//   bypass — page needs a specific non-admin member session; the value is the
//            email the dev server must be booted with (see AUTH'D SHOTS above)
//   hant   — seed localStorage c4c-hant='1' so the page renders Traditional
//   theme  — inject data-theme (sanctuary | harvest | midnight) after load
//   mode   — inject data-mode (light | dark) after load
//   anchor — heading text to frame: clip the 1280x800 shot to start just above
//            the first heading containing it (for below-the-fold panels)
//   backend — documentation only, not enforced by this script: 'supabase' means
//            the page 404s on the default D1 backend and needs its own dev-server
//            pass with DB_BACKEND=supabase plus a migrated+seeded local Postgres
//            (WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE in .dev.vars;
//            see docs/supabase-setup.md §9). Capture these together with --only.
const PAGES = [
  // Public tour — sanctuary theme, light mode (the shipped default), /en/ unless noted.
  { path: '/en/', out: 'docs/images/public/home-en.png' },
  { path: '/zh/', out: 'docs/images/public/home-zh.png' },
  { path: '/zh/', out: 'docs/images/public/home-zh-hant.png', hant: true },
  { path: '/en/sermons', out: 'docs/images/public/sermons.png' },
  { path: '/en/bulletin', out: 'docs/images/public/bulletin.png' },
  { path: '/en/prayer', out: 'docs/images/public/prayer.png' },
  { path: '/en/events', out: 'docs/images/public/events.png' },
  { path: '/en/ministries', out: 'docs/images/public/ministries.png' },
  { path: '/en/ministries/worship', out: 'docs/images/public/ministry-detail.png' },
  { path: '/en/visit', out: 'docs/images/public/visit.png' },
  { path: '/en/about/staff', out: 'docs/images/public/staff.png' },
  { path: '/en/articles', out: 'docs/images/public/articles.png' },
  { path: '/en/articles/psalms-of-ascent', out: 'docs/images/public/article.png' },
  { path: '/en/fellowships', out: 'docs/images/public/fellowships.png' },
  { path: '/en/give', out: 'docs/images/public/give.png' },
  { path: '/en/signin', out: 'docs/images/public/signin.png' },

  // People module (Slice 9). The opportunity board is public; the household
  // self-service card needs David Chen's member session; the admin person detail
  // (person 2) needs an admin session. See AUTH'D SHOTS in the header.
  { path: '/en/serve/opportunities', out: 'docs/images/serve/opportunities.png' },
  { path: '/en/profile', out: 'docs/images/public/profile-household.png', bypass: 'pastor.david@example.com', anchor: 'Household' },
  { path: '/admin/people/2', out: 'docs/images/admin/person-detail.png', admin: true, anchor: 'Household' },

  // Groups module — public directory (one public group, seeded) and the
  // site-admin console (CRUD over every group). D1 works fine; no backend flag.
  { path: '/en/groups', out: 'docs/images/groups/directory.png' },
  { path: '/admin/groups', out: 'docs/images/admin/groups.png', admin: true },

  // dcfc design-parity stat rows. prayer-wall runs on D1 like the rows above;
  // giving/registration/give-form are Supabase-only (see `backend` above) — they
  // 404 on D1 and need a separate dev-server pass against a migrated+seeded
  // local Postgres. give-form is the module-ON checkout branch of /en/give
  // (distinct from the module-OFF public/give.png row above).
  { path: '/admin/prayer-wall', out: 'docs/images/admin/prayer-wall.png', admin: true },
  { path: '/en/give', out: 'docs/images/giving/give-form.png', backend: 'supabase' },
  { path: '/admin/giving', out: 'docs/images/admin/giving.png', admin: true, backend: 'supabase' },
  { path: '/admin/registration', out: 'docs/images/admin/registration.png', admin: true, backend: 'supabase' },

  // Theme matrix — 3 themes x light/dark, home page, applied via injection.
  { path: '/en/', out: 'docs/images/themes/home-sanctuary-light.png', theme: 'sanctuary', mode: 'light' },
  { path: '/en/', out: 'docs/images/themes/home-sanctuary-dark.png', theme: 'sanctuary', mode: 'dark' },
  { path: '/en/', out: 'docs/images/themes/home-harvest-light.png', theme: 'harvest', mode: 'light' },
  { path: '/en/', out: 'docs/images/themes/home-harvest-dark.png', theme: 'harvest', mode: 'dark' },
  { path: '/en/', out: 'docs/images/themes/home-midnight-dark.png', theme: 'midnight', mode: 'dark' },
  { path: '/en/', out: 'docs/images/themes/home-midnight-light.png', theme: 'midnight', mode: 'light' },
];

// --- Chrome discovery + launch ----------------------------------------------
function resolveChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium binary.');
}

async function launchChrome() {
  const bin = resolveChrome();
  const userDataDir = await mkdtemp(join(tmpdir(), 'c4c-shots-'));
  const proc = spawn(
    bin,
    [
      '--headless=new',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      `--user-data-dir=${userDataDir}`,
      '--remote-debugging-port=0', // 0 → Chrome picks a free port, written to DevToolsActivePort
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  // Read the chosen port from DevToolsActivePort (line 1 = port, line 2 = ws path).
  const portFile = join(userDataDir, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) {
      const [line] = (await readFile(portFile, 'utf8')).split('\n');
      if (line && line.trim()) { port = line.trim(); break; }
    }
    await sleep(100);
  }
  if (!port) { proc.kill('SIGKILL'); throw new Error('Chrome did not report a debugging port'); }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return { proc, userDataDir, wsUrl: version.webSocketDebuggerUrl };
}

// --- minimal CDP client (flat protocol over one browser WebSocket) -----------
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket error')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const eventHandlers = new Set();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const h of eventHandlers) h(msg);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const onceEvent = (method, sessionId, timeoutMs) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => { eventHandlers.delete(h); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      const h = (msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(timer); eventHandlers.delete(h); resolve(msg.params);
        }
      };
      eventHandlers.add(h);
    });
  return { ws, send, onceEvent };
}

// --- PNG IHDR dimensions -----------------------------------------------------
function pngDimensions(buf) {
  // 8-byte signature, 4-byte length, "IHDR", then width/height (big-endian u32).
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG (missing IHDR)');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// --- capture one page --------------------------------------------------------
async function capture(cdp, base, row) {
  const { send, onceEvent } = cdp;
  // Fresh target per shot → isolated page lifecycle.
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  try {
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride',
      { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false }, sessionId);

    // Document-start baseline: deterministically set the localStorage state this
    // shot needs (c4c-hant on/off, c4c-mode cleared) before any page script runs.
    const hantExpr = row.hant ? "localStorage.setItem('c4c-hant','1');" : "localStorage.removeItem('c4c-hant');";
    await send('Page.addScriptToEvaluateOnNewDocument',
      { source: `try{ ${hantExpr} localStorage.removeItem('c4c-mode'); }catch(e){}` }, sessionId);

    const url = new URL(row.path, base).href;
    const loaded = onceEvent('Page.loadEventFired', sessionId, 20000).catch(() => {});
    await send('Page.navigate', { url }, sessionId);
    await loaded;

    // Wait for webfonts, then for the 繁 conversion (lang flips to zh-Hant) if applicable.
    await send('Runtime.evaluate',
      { expression: 'document.fonts.ready.then(()=>true)', awaitPromise: true, returnByValue: true }, sessionId);
    if (row.hant) {
      for (let i = 0; i < 30; i++) {
        const { result } = await send('Runtime.evaluate',
          { expression: "document.documentElement.lang==='zh-Hant'", returnByValue: true }, sessionId);
        if (result.value) break;
        await sleep(100);
      }
      await sleep(400); // let the text-node conversion pass settle
    }

    // Theme/mode: flip the CSS-var-driving attributes on <html> after load.
    if (row.theme || row.mode) {
      const set = [];
      if (row.theme) set.push(`d.setAttribute('data-theme',${JSON.stringify(row.theme)});`);
      if (row.mode) set.push(`d.setAttribute('data-mode',${JSON.stringify(row.mode)});`);
      await send('Runtime.evaluate',
        { expression: `(()=>{const d=document.documentElement;${set.join('')}})()` }, sessionId);
    }
    await sleep(300); // paint settle

    // Drop the Astro dev-toolbar overlay so it never bleeds into a shot (a no-op
    // in preview/prod builds, where the element does not exist).
    await send('Runtime.evaluate',
      { expression: "document.querySelectorAll('astro-dev-toolbar, #astro-dev-toolbar-root').forEach(e=>e.remove())" }, sessionId);

    // Anchored shots frame a below-the-fold panel (e.g. the household / notes
    // cards): find the first heading containing `anchor` and clip a 1280x800
    // window starting `anchorMargin` px above it (captureBeyondViewport renders
    // the region even below the live viewport). Falls back to a top-of-page shot
    // if the anchor is missing.
    let clip;
    if (row.anchor) {
      const { result } = await send('Runtime.evaluate', {
        expression: `(()=>{const h=[...document.querySelectorAll('h1,h2,h3')].find(e=>e.textContent.includes(${JSON.stringify(row.anchor)}));return h?Math.round(h.getBoundingClientRect().top+window.scrollY):-1;})()`,
        returnByValue: true,
      }, sessionId);
      if (typeof result.value === 'number' && result.value >= 0) {
        const y = Math.max(0, result.value - (row.anchorMargin ?? 40));
        clip = { x: 0, y, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 };
      }
    }

    const { data } = await send('Page.captureScreenshot',
      clip ? { format: 'png', clip, captureBeyondViewport: true } : { format: 'png' }, sessionId);
    const buf = Buffer.from(data, 'base64');

    const { width, height } = pngDimensions(buf);
    if (width !== VIEWPORT.width || height !== VIEWPORT.height) {
      throw new Error(`${row.out}: expected ${VIEWPORT.width}x${VIEWPORT.height}, got ${width}x${height}`);
    }
    if (buf.length < MIN_BYTES) {
      throw new Error(`${row.out}: ${buf.length} bytes < ${MIN_BYTES} (likely blank)`);
    }

    const outPath = join(ROOT, row.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, buf);
    console.log(`  ok  ${row.out}  ${width}x${height}  ${(buf.length / 1024).toFixed(0)}KB`);
  } finally {
    await send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

// --- main --------------------------------------------------------------------
async function main() {
  const baseIdx = process.argv.indexOf('--base');
  const base = baseIdx !== -1 ? process.argv[baseIdx + 1] : 'http://localhost:4321';

  // `--only <substr[,substr...]>` captures just the rows whose `out` contains a
  // token — used to shoot the admin/member pages against a dev server booted for
  // that identity without re-capturing the whole table.
  const onlyIdx = process.argv.indexOf('--only');
  const onlyTokens = onlyIdx !== -1 ? (process.argv[onlyIdx + 1] ?? '').split(',').filter(Boolean) : null;
  const pages = onlyTokens ? PAGES.filter((p) => onlyTokens.some((tok) => p.out.includes(tok))) : PAGES;
  if (pages.length === 0) throw new Error(`--only matched no pages (tokens: ${onlyTokens?.join(', ')})`);

  // Fail fast if the dev server is not up.
  try {
    await fetch(new URL('/en/', base).href, { redirect: 'manual' });
  } catch {
    throw new Error(`Dev server unreachable at ${base}. Start it with: npm run dev`);
  }

  console.log(`Capturing ${pages.length} pages from ${base}`);
  const { proc, userDataDir, wsUrl } = await launchChrome();
  const cdp = await connect(wsUrl);
  let failures = 0;
  try {
    for (const row of pages) {
      try {
        await capture(cdp, base, row);
      } catch (err) {
        failures++;
        console.error(`  FAIL ${row.out}: ${err.message}`);
      }
    }
  } finally {
    try { cdp.ws.close(); } catch {}
    proc.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
  if (failures) { console.error(`\n${failures} capture(s) failed.`); process.exit(1); }
  console.log(`\nAll ${pages.length} captures passed (1280x800, >20KB).`);
}

main().catch((err) => { console.error(err); process.exit(1); });
