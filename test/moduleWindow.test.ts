// Public date windows for schedulable modules (Settings -> Modules). Pure rules
// first (inclusive dates, open bounds, validation), then the cached settings read
// against a live D1, then the catalog contract: only pledges and missions are
// schedulable, and a window never touches their admin prefixes.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { setSetting } from '../src/lib/settings';
import {
  MODULES,
  SCHEDULABLE_MODULE_KEYS,
  clearModuleWindowCache,
  getModuleWindows,
  isPublicModulePath,
  moduleWindowKeys,
  moduleWindowState,
  parseModuleWindow,
  publicModuleSet,
} from '../src/lib/modules';
import { validateCapabilityCatalog } from '../scripts/lib/validate-capability-catalog.mjs';
import { CAPABILITY_CATALOG } from '../src/lib/capabilityCatalog';

describe('moduleWindowState', () => {
  const win = { start: '2027-01-01', end: '2027-01-31' };
  it('is open on both inclusive bounds and between them', () => {
    expect(moduleWindowState(win, '2027-01-01')).toBe('open');
    expect(moduleWindowState(win, '2027-01-15')).toBe('open');
    expect(moduleWindowState(win, '2027-01-31')).toBe('open');
  });
  it('is upcoming before the start and ended after the end', () => {
    expect(moduleWindowState(win, '2026-12-31')).toBe('upcoming');
    expect(moduleWindowState(win, '2027-02-01')).toBe('ended');
  });
  it('treats a missing bound or a missing window as open-ended', () => {
    expect(moduleWindowState(undefined, '1999-01-01')).toBe('open');
    expect(moduleWindowState({ start: null, end: '2027-01-31' }, '2000-01-01')).toBe('open');
    expect(moduleWindowState({ start: '2027-01-01', end: null }, '2099-01-01')).toBe('open');
  });
});

describe('publicModuleSet', () => {
  it('drops only enabled modules outside their window', () => {
    const modules = new Set(['pledges', 'missions', 'sermons']);
    const out = publicModuleSet(modules, { pledges: { start: '2027-03-01', end: null }, missions: { start: null, end: '2027-12-31' } }, '2027-02-01');
    expect([...out].sort()).toEqual(['missions', 'sermons']);
  });
  it('never adds a disabled module back', () => {
    const out = publicModuleSet(new Set(['sermons']), { pledges: { start: null, end: null } }, '2027-02-01');
    expect(out.has('pledges')).toBe(false);
  });
});

describe('parseModuleWindow', () => {
  it('accepts empty, one-sided, and ordered windows', () => {
    expect(parseModuleWindow('', '')).toEqual({ ok: true, window: { start: null, end: null } });
    expect(parseModuleWindow(' 2027-01-01 ', '')).toEqual({ ok: true, window: { start: '2027-01-01', end: null } });
    expect(parseModuleWindow('2027-01-01', '2027-01-01')).toEqual({ ok: true, window: { start: '2027-01-01', end: '2027-01-01' } });
  });
  it('rejects impossible dates and windows that end before they start', () => {
    expect(parseModuleWindow('2027-02-30', '')).toEqual({ ok: false, error: 'date' });
    expect(parseModuleWindow('', 'tomorrow')).toEqual({ ok: false, error: 'date' });
    expect(parseModuleWindow('2027-02-01', '2027-01-31')).toEqual({ ok: false, error: 'order' });
  });
});

describe('catalog contract', () => {
  it('makes exactly pledges and missions schedulable', () => {
    expect([...SCHEDULABLE_MODULE_KEYS]).toEqual(['pledges', 'missions']);
  });
  it('limits a window to public prefixes, never admin pages', () => {
    expect(isPublicModulePath('/pledge/building-fund', 'pledges')).toBe(true);
    expect(isPublicModulePath('/pledges', 'pledges')).toBe(false);
    expect(isPublicModulePath('/admin/pledges', 'pledges')).toBe(false);
    expect(isPublicModulePath('/missions/kenya-2026', 'missions')).toBe(true);
    expect(isPublicModulePath('/admin/missions/3', 'missions')).toBe(false);
    expect(MODULES.missions.adminPrefixes).toEqual(['/admin/missions']);
  });
  it('rejects a non-boolean flag and a schedulable module without public pages', () => {
    const copy = structuredClone(CAPABILITY_CATALOG) as unknown as { capabilities: Record<string, Record<string, unknown>> };
    copy.capabilities.sermons.schedulable = 'yes';
    copy.capabilities['event-logistics'].schedulable = true;
    expect(() => validateCapabilityCatalog(copy)).toThrow(/sermons\.schedulable must be a boolean[\s\S]*event-logistics\.schedulable needs at least one public route prefix/);
  });
  it('keeps window rows outside the module.<key> namespace setup checks', () => {
    const k = moduleWindowKeys('pledges');
    expect(k).toEqual({ start: 'moduleWindow.pledges.start', end: 'moduleWindow.pledges.end' });
    expect(k.start.startsWith('module.')).toBe(false);
  });
});

describe('getModuleWindows (D1)', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM settings').run();
    clearModuleWindowCache();
  });

  it('reads stored windows, ignores malformed and empty values', async () => {
    await setSetting(env.DB, 'moduleWindow.pledges.start', '2027-01-01');
    await setSetting(env.DB, 'moduleWindow.pledges.end', 'not-a-date');
    await setSetting(env.DB, 'moduleWindow.missions.start', '');
    expect(await getModuleWindows(env.DB)).toEqual({ pledges: { start: '2027-01-01', end: null } });
  });

  it('serves the cached value until the cache is cleared', async () => {
    expect(await getModuleWindows(env.DB)).toEqual({});
    await setSetting(env.DB, 'moduleWindow.missions.end', '2027-06-30');
    expect(await getModuleWindows(env.DB)).toEqual({});
    clearModuleWindowCache();
    expect(await getModuleWindows(env.DB)).toEqual({ missions: { start: null, end: '2027-06-30' } });
  });
});
