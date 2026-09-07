import { describe, expect, it } from 'vitest';
import reauthPage from '../../src/pages/[locale]/reauth.astro?raw';
import securityPage from '../../src/pages/[locale]/settings/security.astro?raw';
import applyPage from '../../src/pages/[locale]/serve/apply.astro?raw';
import groupManagePage from '../../src/pages/[locale]/groups/[id]/manage.astro?raw';
import groupDb from '../../src/lib/groupDb.ts?raw';
import revocationHelper from '../../src/lib/identitySessionRevocation.ts?raw';
import middleware from '../../src/middleware.ts?raw';
import d1Cutover from '../../migrations/0030_identity_security_cutover.sql?raw';
import pgCutover from '../../migrations-supabase/0030_identity_security_cutover.sql?raw';
import en from '../../src/i18n/en';
import zh from '../../src/i18n/zh';

describe('member Security Center source boundaries', () => {
  it('opens the request database before dispatching the pinned-configuration canary', () => {
    const dbOpen = middleware.indexOf('const { db, backend, end } = openDb');
    const rawDbAssignment = middleware.indexOf('context.locals.rawDb = db');
    const canaryDispatch = middleware.indexOf("pathname === '/api/health/identity-verification'");

    expect(dbOpen).toBeGreaterThan(-1);
    expect(rawDbAssignment).toBeGreaterThan(dbOpen);
    expect(canaryDispatch).toBeGreaterThan(rawDbAssignment);
  });

  it('narrows the route locale before helpers capture it and has no unused legacy cookie import', () => {
    expect(reauthPage).toContain("const parsedLocale = parseLocale(Astro.params.locale ?? '');");
    expect(reauthPage).toContain('if (!parsedLocale)');
    expect(reauthPage).toContain('const locale = parsedLocale;');
    expect(reauthPage).not.toContain('clearSessionCookie');
  });

  it('centralizes global session invalidation in the atomic repository helper', () => {
    expect(securityPage).toContain('revokeIdentitySessions');
    expect(revocationHelper).toContain('RETURNING session_epoch');
    expect(revocationHelper).toContain('ownership_consumed_at IS NULL');
    expect(revocationHelper).toContain('db.batch');
  });

  it('keeps the D1 and PostgreSQL legacy-cutover guards in parity', () => {
    for (const migration of [d1Cutover, pgCutover]) {
      expect(migration).toContain("UPDATE tokens SET used_at=datetime('now') WHERE purpose='email_change'");
      expect(migration).toContain('UPDATE people SET pending_email=NULL');
      expect(migration).toContain('identity_legacy_email_change_token_insert_retired');
      expect(migration).toContain('identity_legacy_email_change_token_update_retired');
      expect(migration).toContain('identity_legacy_pending_email_insert_retired');
      expect(migration).toContain('identity_legacy_pending_email_update_retired');
    }
  });

  it('requires a one-time email proof for anonymous serve applications without raw-contact matching', () => {
    expect(applyPage).toContain('beginTeamApplicationIntent');
    expect(applyPage).toContain('completeTeamApplicationIntent');
    expect(applyPage).toContain('claimTeamApplicationSessionDelivery');
    expect(applyPage).toContain('sendIdentitySignupOtp');
    expect(applyPage).not.toContain('signin=1');
    expect(applyPage).not.toContain('sendMagicLink');
    expect(applyPage).not.toContain('getPersonByEmail');
    expect(applyPage).not.toContain('findOrCreatePersonByEmail');
    expect(applyPage).not.toContain('apply.checkEmail');
    expect(en['signup.codeSentBody']).toContain('six-digit code');
    expect(zh['signup.codeSentBody']).toContain('六位验证码');
    expect('apply.checkEmail' in en).toBe(false);
    expect('apply.checkEmail' in zh).toBe(false);
  });

  it('routes contact-bearing Group roster entries through observation-only identity handling', () => {
    expect(groupManagePage).toContain('createGroupMemberObservation');
    expect(groupManagePage).toContain('Astro.locals.rawDb');
    expect(groupDb).toContain('group_identity_gateway_required');
    expect(groupDb).not.toContain('findOrCreatePersonByEmail');
    expect(groupDb).not.toContain('getPersonByEmail');
  });
});
