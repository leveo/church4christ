import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  acknowledgeOnboardingCheck,
  listOnboardingReadiness,
} from '../src/lib/onboardingDb';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM onboarding_acknowledgements').run();
  await env.DB.prepare("INSERT OR IGNORE INTO people (id,display_name,email,role,super_admin) VALUES (1,'Release admin','release@example.test','admin',1)").run();
});

describe('onboarding acknowledgements', () => {
  it('accepts only catalog manual ids and persists actor, time, and definition version', async () => {
    await expect(acknowledgeOnboardingCheck(env.DB, {
      checkId: 'database-schema', actorPersonId: 1, now: '2026-08-12 12:00:00',
    })).rejects.toThrow(/manual/i);
    await acknowledgeOnboardingCheck(env.DB, {
      checkId: 'restore-drill', actorPersonId: 1, now: '2026-08-12 12:00:00',
    });
    expect(await env.DB.prepare('SELECT * FROM onboarding_acknowledgements').first()).toMatchObject({
      check_id: 'restore-drill', actor_person_id: 1, acknowledged_at: '2026-08-12 12:00:00', definition_version: 1,
    });
  });

  it('expires restore drills after 90 days but keeps matching-version manual acknowledgements', async () => {
    await acknowledgeOnboardingCheck(env.DB, {
      checkId: 'restore-drill', actorPersonId: 1, now: '2026-01-01 00:00:00',
    });
    const rows = await listOnboardingReadiness(env.DB, new Set(['people', 'newcomers', 'attendance']), '2026-04-02 00:00:01');
    expect(rows.find((row) => row.checkId === 'restore-drill')).toMatchObject({ status: 'manual', acknowledged: false });
    expect(rows.find((row) => row.checkId === 'routes-jobs')?.status).not.toBe('pass');
    expect(rows.find((row) => row.checkId === 'backups')?.status).not.toBe('pass');
  });

  it('gates the bilingual Learning provider checklist by the Learning capability', async () => {
    const disabled = await listOnboardingReadiness(env.DB, new Set(['people']), '2026-08-18 12:00:00');
    expect(disabled.find((row) => row.checkId === 'learning-provider-operations')).toMatchObject({
      status: 'not_applicable', acknowledged: false,
    });

    const enabled = await listOnboardingReadiness(env.DB, new Set(['people', 'learning']), '2026-08-18 12:00:00');
    expect(enabled.find((row) => row.checkId === 'learning-provider-operations')).toMatchObject({
      status: 'manual', acknowledged: false,
      title: { en: 'Learning provider operations', zh: '学习平台供应商运维' },
      adminPath: '/admin/learning',
    });

    await acknowledgeOnboardingCheck(env.DB, {
      checkId: 'learning-provider-operations', actorPersonId: 1, now: '2026-08-18 12:00:00',
    });
    const acknowledged = await listOnboardingReadiness(
      env.DB, new Set(['people', 'learning']), '2026-08-18 12:00:01',
    );
    expect(acknowledged.find((row) => row.checkId === 'learning-provider-operations')).toMatchObject({
      status: 'pass', acknowledged: true, acknowledgedAt: '2026-08-18 12:00:00',
    });
  });
});
