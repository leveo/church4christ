import { describe, expect, it } from 'vitest';
import raw from '../../../config/capabilities.json';
import { missingAnswers } from '../../../scripts/setup/answers.mjs';
import { parseSetupArgs, SETUP_HELP } from '../../../scripts/setup/args.mjs';

describe('parseSetupArgs', () => {
  it('normalizes a complete noninteractive request and boolean controls', () => {
    expect(
      parseSetupArgs(
        [
          '--preset',
          'website',
          '--mode',
          'local',
          '--site-slug',
          'grace-church',
          '--church-name',
          '  Grace Church  ',
          '--locale',
          'en',
          '--admin-email',
          ' Admin@Example.com ',
          '--admin-name',
          '  Grace Admin ',
          '--app-origin',
          'https://church.example/',
          '--email-from',
          ' Serve@Church.Example ',
          '--backend',
          'd1',
          '--demo-data',
          '--yes',
          '--dry-run',
          '--json',
          '--force-config',
          '--promote-existing-admin',
        ],
        raw,
      ),
    ).toMatchObject({
      preset: 'website',
      mode: 'local',
      siteSlug: 'grace-church',
      churchName: 'Grace Church',
      locale: 'en',
      adminEmail: 'admin@example.com',
      adminName: 'Grace Admin',
      appOrigin: 'https://church.example',
      emailFrom: 'serve@church.example',
      backendOverride: 'd1',
      demoData: true,
      yes: true,
      dryRun: true,
      json: true,
      forceConfig: true,
      promoteExistingAdmin: true,
      doctor: false,
      strict: false,
      help: false,
    });
  });

  it('collects repeated and comma-separated module flags', () => {
    expect(
      parseSetupArgs(
        ['--modules', 'sermons, events', '--modules', 'sermons', '--modules', 'articles'],
        raw,
      ).modules,
    ).toEqual(['sermons', 'events', 'articles']);
  });

  it.each([
    [['--preset', 'website', '--modules', 'sermons'], /preset.*modules/i],
    [['--preset', 'missing'], /unknown preset.*missing/i],
    [['--modules', 'sermons,missing,also-missing'], /unknown capabilities.*missing.*also-missing/i],
    [['--mode', 'remote'], /mode.*local.*deploy/i],
    [['--locale', 'fr'], /locale.*en.*zh/i],
    [['--backend', 'D1'], /backend.*d1.*supabase/i],
    [['--admin-email', 'not-an-email'], /admin-email.*valid/i],
    [['--email-from', 'not-an-email'], /email-from.*valid/i],
    [['--site-slug', 'Grace_Church'], /site-slug.*kebab/i],
    [['--app-origin', 'http://church.example'], /app-origin.*HTTPS origin/i],
    [['--app-origin', 'https://church.example/path'], /app-origin.*without a path/i],
    [['--app-origin', 'https://church.example?x=1'], /app-origin.*without a path/i],
    [['--app-origin', 'not a URL'], /app-origin.*HTTPS origin/i],
    [['--strict'], /strict.*doctor/i],
    [['--doctor', '--mode', 'local'], /doctor.*setup answers/i],
    [['--doctor', '--backend', 'd1'], /doctor.*setup answers/i],
    [['--doctor', '--force-config'], /doctor.*only.*strict.*json/i],
    [['--doctor', '--promote-existing-admin'], /doctor.*only.*strict.*json/i],
    [['--doctor', '--yes'], /doctor.*only.*strict.*json/i],
  ])('rejects invalid argument combination %#', (argv, message) => {
    expect(() => parseSetupArgs(argv, raw)).toThrow(message);
  });

  it('supports doctor strict mode and documents every public option', () => {
    expect(parseSetupArgs(['--doctor', '--strict', '--json'], raw)).toMatchObject({
      doctor: true,
      strict: true,
      json: true,
    });
    for (const option of [
      '--mode',
      '--preset',
      '--modules',
      '--site-slug',
      '--church-name',
      '--locale',
      '--admin-email',
      '--admin-name',
      '--app-origin',
      '--email-from',
      '--backend',
      '--demo-data',
      '--yes',
      '--dry-run',
      '--json',
      '--force-config',
      '--promote-existing-admin',
      '--doctor',
      '--strict',
      '--help',
    ]) {
      expect(SETUP_HELP).toContain(option);
    }
  });

  it('short-circuits semantic validation when help is requested', () => {
    expect(
      parseSetupArgs(
        ['--help', '--strict', '--mode', 'invalid', '--admin-email', 'not-an-email'],
        raw,
      ),
    ).toEqual({ help: true });
  });

  it.each([
    'admin@example..com',
    'admin@.example.com',
    'admin@example.com.',
    'admin@example-.com',
    'admin@-example.com',
    '.admin@example.com',
    'admin.@example.com',
    'ad..min@example.com',
    'admin@example.com,other@example.com',
    'admin@example.com;other@example.com',
  ])('rejects malformed mailbox %s', (address) => {
    expect(() => parseSetupArgs(['--admin-email', address], raw)).toThrow(/admin-email.*valid/i);
    expect(() => parseSetupArgs(['--email-from', address], raw)).toThrow(/email-from.*valid/i);
  });
});

describe('missingAnswers', () => {
  const complete = {
    mode: 'local',
    preset: 'website',
    siteSlug: 'grace-church',
    churchName: 'Grace Church',
    locale: 'en',
    adminEmail: 'admin@example.com',
    adminName: 'Grace Admin',
  };

  it('returns missing setup answers in prompt order', () => {
    expect(missingAnswers({})).toEqual([
      'mode',
      'featureChoice',
      'siteSlug',
      'churchName',
      'locale',
      'adminEmail',
      'adminName',
    ]);
    expect(missingAnswers(complete)).toEqual([]);
    expect(missingAnswers({ ...complete, preset: undefined, modules: ['sermons'] })).toEqual([]);
  });

  it('requires deployment origin and sender only in deploy mode', () => {
    expect(missingAnswers({ ...complete, mode: 'deploy' })).toEqual(['appOrigin', 'emailFrom']);
  });
});
