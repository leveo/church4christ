import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import catalog from '../../../config/capabilities.json';
import { startOnboardingServer } from '../../../scripts/onboard/server.mjs';
import { defaultPreferences } from '../../../scripts/onboard/preferences.mjs';
import { parseOnboardArgs } from '../../../scripts/onboard/index.mjs';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function session() {
  const root = await mkdtemp(join(tmpdir(), 'c4c-onboard-http-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = await startOnboardingServer({ root, catalog });
  cleanup.push(() => server.close());
  const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', Origin: server.origin };
  const draft = { ...defaultPreferences(catalog), organization: { type: 'campus', name: 'Campus Center', tagline: '', address: '', timezone: 'UTC' }, setup: { ...defaultPreferences(catalog).setup, siteSlug: 'campus', adminEmail: 'admin@example.test', adminName: 'Campus Admin' } };
  return { ...server, root, headers, draft };
}

describe('onboarding local HTTP boundary', () => {
  it('uses an ephemeral loopback server, authenticates reads, and rejects foreign origin/host', async () => {
    const s = await session();
    expect(s.server.address()).toMatchObject({ address: '127.0.0.1' });
    expect(s.url).toBe(`${s.origin}/#token=${s.token}`);
    expect((await fetch(`${s.origin}/api/state`)).status).toBe(401);
    expect((await fetch(`${s.origin}/api/state`, { headers: { ...s.headers, Origin: 'https://foreign.example' } })).status).toBe(403);
    const response = await fetch(`${s.origin}/api/state`, { headers: s.headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ preferences: null, existingInstallation: false, defaults: { setup: { demoData: true } } });
    expect(await readdir(s.root)).toEqual([]);
  });

  it('saves a validated plan, reopens it, and never starts provisioning', async () => {
    const s = await session();
    s.draft.setup.modules = [' learning '];
    const response = await fetch(`${s.origin}/api/preferences`, { method: 'POST', headers: s.headers, body: JSON.stringify(s.draft) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ backend: 'd1', preferencesPath: '.church/preferences.json', addedDependencies: [{ capability: 'learning', added: 'people' }], preferences: { setup: { modules: ['people', 'learning'] } }, commands: { preview: expect.stringContaining('--dry-run --json') } });
    const state = await (await fetch(`${s.origin}/api/state`, { headers: s.headers })).json() as { preferences: { organization: { name: string } } };
    expect(state.preferences.organization.name).toBe('Campus Center');
    expect(await readdir(s.root)).toEqual(['.church']);
    expect(await readdir(join(s.root, '.church'))).toEqual(['preferences.json']);
    const bad = await fetch(`${s.origin}/api/preferences`, { method: 'POST', headers: s.headers, body: JSON.stringify({ ...s.draft, setup: { ...s.draft.setup, modules: ['unknown'] } }) });
    expect(bad.status).toBe(400);
    const reopened = await (await fetch(`${s.origin}/api/state`, { headers: s.headers })).json() as { preferences: unknown };
    expect(reopened.preferences).toEqual(state.preferences);
  });

  it('treats existing installs as preference edits without suggesting re-provisioning', async () => {
    const s = await session();
    await writeFile(join(s.root, 'church.config.json'), '{"preserve":true}');
    const response = await fetch(`${s.origin}/api/preferences`, { method: 'POST', headers: s.headers, body: JSON.stringify(s.draft) });
    expect(await response.json()).toMatchObject({ existingInstallation: true, commands: {} });
  });

  it('rejects unauthenticated saves, unsafe content types and oversized bodies', async () => {
    const s = await session();
    expect((await fetch(`${s.origin}/api/preferences`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(`${s.origin}/api/preferences`, { method: 'POST', headers: { ...s.headers, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await fetch(`${s.origin}/api/preferences`, { method: 'POST', headers: s.headers, body: 'x'.repeat(3 * 1024 * 1024 + 1) })).status).toBe(413);
    expect((await fetch(`${s.origin}/.church/preferences.json`, { headers: s.headers })).status).toBe(404);
    expect(await readdir(s.root)).toEqual([]);
  });

  it('serves the wizard and design tokens locally', async () => {
    const s = await session();
    const page = await fetch(s.origin);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('Church4Christ');
    expect(await (await fetch(`${s.origin}/tokens.css`)).text()).toContain('--color-primary');
  });
});

describe('onboard CLI', () => {
  it('supports headless launch and validates port flags', () => {
    expect(parseOnboardArgs(['--no-open', '--port', '0'])).toEqual({ help: false, open: false, port: 0 });
    expect(parseOnboardArgs(['--help'])).toEqual({ help: true });
    for (const port of ['-1', '65536', '3.2', 'NaN']) expect(() => parseOnboardArgs(['--port', port])).toThrow();
    expect(() => parseOnboardArgs(['--host', '0.0.0.0'])).toThrow();
  });
});
