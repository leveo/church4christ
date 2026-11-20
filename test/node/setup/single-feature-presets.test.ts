import { describe, expect, it } from 'vitest';

import rawCatalog from '../../../config/capabilities.json';
import { SETUP_HELP } from '../../../scripts/setup/args.mjs';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';

const base = {
  mode: 'local',
  siteSlug: 'single-feature',
  churchName: 'Single Feature Church',
  locale: 'en',
  adminEmail: 'admin@example.test',
  adminName: 'Admin',
  demoData: false,
};

describe('single-feature setup presets', () => {
  it.each([
    ['checkin', ['people', 'children']],
    ['volunteer-scheduling', ['serve', 'gifts', 'people']],
    ['small-groups', ['fellowships', 'groups', 'people']],
    ['event-registration', ['registration']],
  ])('%s enables exactly its modules on D1 and leaves the rest off', (preset, modules) => {
    const plan = buildSetupPlan({ ...base, preset }, rawCatalog);
    expect(plan.backend).toBe('d1');
    expect([...plan.modules].sort()).toEqual([...modules].sort());
    const enabled = Object.entries(plan.moduleSettings)
      .filter(([, value]) => value === '1')
      .map(([key]) => key.replace(/^module\./, ''));
    expect(enabled.sort()).toEqual([...modules].sort());
    expect(Object.keys(plan.moduleSettings)).toHaveLength(rawCatalog.order.length);
  });

  it('lists every catalog preset in the installer help', () => {
    for (const preset of Object.keys(rawCatalog.presets)) expect(SETUP_HELP).toContain(preset);
  });
});
