import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import catalog from '../../../config/capabilities.json';
import { defaultPreferences, normalizePreferences, readPreferences, savePreferences, readLogo } from '../../../scripts/onboard/preferences.mjs';

const draft = () => ({ ...defaultPreferences(catalog), organization: { type: 'nonprofit', name: 'Our Community', tagline: 'Together', address: 'Chicago', timezone: 'America/Chicago' }, setup: { ...defaultPreferences(catalog).setup, siteSlug: 'our-community', adminName: 'Admin', adminEmail: 'Admin@Example.com' } });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=';

describe('local onboarding preferences', () => {
  it('recommends the catalog D1 starter and normalizes identity and dependencies', () => {
    const defaults = defaultPreferences(catalog);
    expect(defaults.setup.modules).toEqual(catalog.presets['website-community'].modules);
    expect(defaults.setup.modules).not.toContain('portal');
    const input = draft();
    input.setup.modules = ['learning'];
    const result = normalizePreferences(input, catalog);
    expect(result.setup.modules).toEqual(['people', 'learning']);
    expect(result.setup.adminEmail).toBe('admin@example.com');
  });

  it('retains an explicit PostgreSQL feature choice', () => {
    const input = draft();
    input.setup.modules = ['portal'];
    expect(normalizePreferences(input, catalog).setup.modules).toContain('portal');
  });

  it.each([
    (p: any) => { p.schemaVersion = 2; },
    (p: any) => { p.organization.type = 'unknown'; },
    (p: any) => { p.organization.name = ''; },
    (p: any) => { p.organization.timezone = 'Invalid/Timezone'; },
    (p: any) => { p.branding.primaryColor = 'red; background:url(https://example.com)'; },
    (p: any) => { p.branding.logo = { path: '../../private.png', mimeType: 'image/png' }; },
    (p: any) => { p.setup.modules = []; },
    (p: any) => { p.setup.modules = ['missing']; },
    (p: any) => { p.setup.adminEmail = 'not-an-email'; },
    (p: any) => { p.setup.demoData = 'true'; },
  ])('rejects invalid preferences before writing %#', (change) => {
    const input = draft();
    change(input);
    expect(() => normalizePreferences(input, catalog)).toThrow();
  });

  it('saves and reloads local identity, feature choices and a content-addressed logo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-onboard-'));
    try {
      expect(await readPreferences(root, catalog)).toBeNull();
      const saved = await savePreferences(root, { ...draft(), logoUpload: { name: '../../logo.png', dataUrl: png } }, catalog);
      expect(saved.branding.logo?.path).toMatch(/^\.church\/onboarding-logo-[a-f0-9]{64}\.png$/);
      expect(await readPreferences(root, catalog)).toEqual(saved);
      expect(await readLogo(root, saved.branding.logo)).toEqual(Buffer.from(png.split(',')[1], 'base64'));
      const again = await savePreferences(root, { ...saved, organization: { ...saved.organization, name: 'Edited' } }, catalog);
      expect(again.branding.logo).toEqual(saved.branding.logo);
      expect((await readPreferences(root, catalog))?.organization.name).toBe('Edited');
      const raw = await readFile(join(root, '.church/preferences.json'), 'utf8');
      expect(raw).not.toContain('data:image');
      await expect(savePreferences(root, { ...draft(), logoUpload: { name: 'wrong.png', dataUrl: 'data:image/png;base64,PHNjcmlwdD4=' } }, catalog)).rejects.toThrow(/logo/i);
      expect((await readPreferences(root, catalog))?.organization.name).toBe('Edited');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not follow local symlinks or corrupt a prior preference file on bad input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'c4c-onboard-'));
    const outside = await mkdtemp(join(tmpdir(), 'c4c-outside-'));
    try {
      await symlink(outside, join(root, '.church'));
      await expect(savePreferences(root, draft(), catalog)).rejects.toThrow(/symbolic link/i);
      await rm(join(root, '.church'));
      await mkdir(join(root, '.church'));
      await writeFile(join(outside, 'keep.json'), 'preserve');
      await symlink(join(outside, 'keep.json'), join(root, '.church/preferences.json'));
      await expect(savePreferences(root, draft(), catalog)).rejects.toThrow(/symbolic link/i);
      expect(await readFile(join(outside, 'keep.json'), 'utf8')).toBe('preserve');
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
});
