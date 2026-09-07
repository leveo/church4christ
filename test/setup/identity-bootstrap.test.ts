import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCommandRunner } from '../../scripts/setup/commands.mjs';
import { D1CliDb } from '../../scripts/setup/providers/d1.mjs';
import { bootstrapFirstAdmin, isBootstrapAdminReady } from '../../src/lib/setupDb.mjs';
import { beginSignin, completeSigninLink } from '../../src/lib/identityAccount';
import { identityTrustedRequestContext } from '../../src/lib/identityAuth';
import type { AppDb, AppStatement } from '../../src/lib/appDb';
import { createCleanWorkspace } from './fixtures';

vi.mock('../../src/lib/identityRecoveryOutbox', () => ({
  prepareIdentityRecoveryNotification: () => { throw new Error('unexpected recovery notification'); },
}));

describe('clean-room CLI administrator identity', () => {
  it.each([false, true])('completes real sign-in with bundled design preserved (demo=%s)', async (demoData) => {
    const workspace = await createCleanWorkspace();
    const email = 'custom-owner@clean.invalid';
    const flags = ['--mode', 'local', '--preset', 'website', '--site-slug', 'identity-clean',
      '--church-name', 'Identity Clean Church', '--locale', 'en', '--admin-email', email, '--admin-name', 'Custom Owner',
      '--app-origin', 'http://127.0.0.1:4321', '--email-from', 'serve@clean.invalid',
      demoData ? '--demo-data' : '--no-demo-data', '--yes', '--json'];
    const localEnv = { WRANGLER_PERSIST_TO: '.identity-state', ASTRO_DEV_BACKGROUND: '0' };
    const result = JSON.parse((await workspace.execNode(flags, localEnv, 300_000)).stdout);
    expect(result.doctor.status).toBe('ready-with-limitations');
    expect(result.apply.actions.includes('seed')).toBe(demoData);
    expect(result.apply.actions.includes('seed-media')).toBe(demoData);
    const manifest = JSON.parse(await readFile(join(workspace.root, 'church.config.json'), 'utf8'));
    expect(manifest.demoData).toBe(demoData);
    const vars = await readFile(join(workspace.root, '.dev.vars'), 'utf8');
    const verificationSecret = /^IDENTITY_VERIFICATION_SECRET=(.+)$/m.exec(vars)?.[1];
    expect(verificationSecret).toBeTruthy();
    expect(vars).toMatch(/^IDENTITY_SOURCE_KEY_SECRET=.+$/m);
    expect(vars).toMatch(/^IDENTITY_RECOVERY_KEY_SECRET=.+$/m);
    // Use the same D1 CLI adapter as setup, including the nondefault persistence
    // directory. No dev middleware or AUTH_DEV_BYPASS_EMAIL is involved.
    const db = new D1CliDb({ runner: createCommandRunner(), wranglerBin: join(workspace.root, 'node_modules/.bin/wrangler'),
      configPath: join(workspace.root, 'wrangler.jsonc'), mode: 'local', persistTo: join(workspace.root, localEnv.WRANGLER_PERSIST_TO) }) as AppDb;
    expect(await isBootstrapAdminReady(db, email)).toBe(true);
    expect(await db.prepare("SELECT value FROM settings WHERE key='site.demo_content'").first('value')).toBe(String(demoData));
    expect(await db.prepare('SELECT count(*) n FROM people').first('n')).toBe(demoData ? 12 : 1);
    const authEnv = { IDENTITY_VERIFICATION_SECRET: verificationSecret! };
    const begun = await beginSignin(db, authEnv, { campusId: 1, email, now: '2035-01-01 00:00:00',
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.47' }), `clean-setup-${demoData}`) });
    expect(begun.delivery?.to).toBe(email);
    await expect(completeSigninLink(db, authEnv, { campusId: 1, publicId: begun.delivery!.publicId,
      token: begun.delivery!.token, now: '2035-01-01 00:01:00' })).resolves.toMatchObject({ status: 'authenticated', sessionEpoch: 0 });

    const before = await db.prepare("SELECT count(*) n FROM identity_audit_events WHERE event_type='setup_admin_bootstrapped'").first('n');
    const rerun = JSON.parse((await workspace.execNode(flags, localEnv, 300_000)).stdout);
    expect(rerun.apply.results.every(({ status }: { status: string }) => ['already-complete', 'verified'].includes(status))).toBe(true);
    expect(await db.prepare("SELECT count(*) n FROM identity_audit_events WHERE event_type='setup_admin_bootstrapped'").first('n')).toBe(before);
    expect(await readFile(join(workspace.root, '.dev.vars'), 'utf8')).toBe(vars);

    // Verify real Wrangler batching rolls back a failure after all identity
    // writes, not merely that the in-process Worker binding is transactional.
    const failingDb = { prepare: db.prepare.bind(db), batch: (statements: AppStatement[]) =>
      db.batch([...statements, db.prepare('INSERT INTO identity_audit_events(event_type) VALUES(NULL)')]) } as AppDb;
    const failedEmail = 'failed-owner@clean.invalid';
    await expect(bootstrapFirstAdmin(failingDb, { email: failedEmail, displayName: 'Failed Owner', locale: 'en' })).rejects.toThrow();
    expect(await db.prepare('SELECT id FROM people WHERE email=?').bind(failedEmail).first()).toBeNull();
    expect(await db.prepare("SELECT id FROM contact_points WHERE kind='email' AND normalized_value=?").bind(failedEmail).first()).toBeNull();
    const designManifest = JSON.parse(await readFile(join(workspace.root, 'public/images/design/manifest.json'), 'utf8'));
    expect(designManifest).toBeTruthy();
  }, 600_000);
});
