import { describe, expect, it, vi } from 'vitest';
import catalog from '../../../config/capabilities.json';
import { parseSetupArgs, SETUP_HELP } from '../../../scripts/setup/args.mjs';
import { collectInteractiveAnswers } from '../../../scripts/setup/prompts.mjs';
import { buildSetupPlan } from '../../../scripts/setup/plan.mjs';
import { formatPlan } from '../../../scripts/setup/index.mjs';
import { buildSetupRerunCommand } from '../../../scripts/setup/failure.mjs';

const flags = ['--mode', 'local', '--preset', 'website', '--site-slug', 'grace',
  '--church-name', 'Grace Church', '--locale', 'en', '--admin-email', 'owner@example.test', '--admin-name', 'Owner'];

describe('first-install content choice', () => {
  it('supports an explicit no-demo choice while preserving the omitted-flag default', () => {
    expect(parseSetupArgs([...flags, '--no-demo-data'], catalog)).toMatchObject({ demoData: false, demoDataSpecified: true });
    expect(parseSetupArgs(flags, catalog)).toMatchObject({ demoData: false, demoDataSpecified: false });
    expect(SETUP_HELP).toContain('--no-demo-data');
  });

  it.each([
    ['--demo-data', '--no-demo-data'],
    ['--no-demo-data', '--demo-data'],
  ])('rejects conflicting content flags before planning: %j', (...contentFlags) => {
    expect(() => parseSetupArgs([...flags, ...contentFlags], catalog)).toThrow(/--demo-data and --no-demo-data cannot be combined/);
  });

  it.each([true, false])('offers both content choices and explains the shared design: %s', async (demoData) => {
    const ask = vi.fn(async (_question: unknown) => demoData);
    const answers = await collectInteractiveAnswers(parseSetupArgs(flags, catalog), catalog, ask);
    expect(answers.demoData).toBe(demoData);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][0]).toMatchObject({
      key: 'demoData',
      message: expect.stringMatching(/both.*design/i),
      choices: [
        { value: true, label: expect.stringMatching(/include demo content/i) },
        { value: false, label: expect.stringMatching(/no demo content/i) },
      ],
    });
  });

  it.each(['--demo-data', '--no-demo-data'])('does not prompt again for an explicit content choice: %s', async (flag) => {
    const ask = vi.fn();
    const answers = await collectInteractiveAnswers(parseSetupArgs([...flags, flag], catalog), catalog, ask);
    expect(answers.demoData).toBe(flag === '--demo-data');
    expect(ask).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized interactive answer instead of silently choosing no demo', async () => {
    await expect(collectInteractiveAnswers(parseSetupArgs(flags, catalog), catalog, async () => 'perhaps'))
      .rejects.toThrow(/demo content.*yes or no/i);
  });

  it.each(['website', 'website-community', 'full-church'])('keeps setup infrastructure identical for both content modes: %s', (preset) => {
    const answers = parseSetupArgs(flags.map((flag) => flag === 'website' ? preset : flag), catalog);
    const demo = buildSetupPlan({ ...answers, demoData: true }, catalog);
    const clean = buildSetupPlan({ ...answers, demoData: false }, catalog);
    expect(clean.actions).toEqual(demo.actions.filter((action: string) => !['seed', 'seed-media'].includes(action)));
    expect(clean.actions).toEqual(expect.arrayContaining(['migrate', 'initialize-modules', 'bootstrap-admin', 'doctor']));
    expect(clean.modules).toEqual(demo.modules);
    expect(clean.moduleSettings).toEqual(demo.moduleSettings);
    expect(clean.site).toEqual(demo.site);
    expect(formatPlan(clean)).toContain('Content: No demo content');
    expect(formatPlan(demo)).toContain('Content: Include demo content');
    expect(formatPlan(clean)).toContain('bundled design');
    expect(buildSetupRerunCommand(clean)).toContain('--no-demo-data');
    expect(buildSetupRerunCommand(demo)).toContain('--demo-data');
  });
});
