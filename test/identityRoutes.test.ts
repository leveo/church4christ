import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import signupPage from '../src/pages/[locale]/signup.astro?raw';
import signinPage from '../src/pages/[locale]/signin.astro?raw';
import authPage from '../src/pages/auth/[token].astro?raw';
import baseLayout from '../src/layouts/Base.astro?raw';
import securityPage from '../src/pages/[locale]/settings/security.astro?raw';
import reauthPage from '../src/pages/[locale]/reauth.astro?raw';
import legacyEmailChangePage from '../src/pages/email-change/[token].astro?raw';
import recoveryAdminPage from '../src/pages/admin/people/identity/recovery/[id].astro?raw';
import teamApplyPage from '../src/pages/[locale]/serve/apply.astro?raw';
import continuationStartRoute from '../src/pages/api/identity/continuation/start.ts?raw';
import continuationPage from '../src/pages/[locale]/identity/continue.astro?raw';
import { sendIdentityContactChangeOtp, sendIdentityOldContactNotice, sendIdentityRecoveryCompletedNotice, sendIdentitySigninLink, sendIdentitySignupOtp, sendIdentityStepUpOtp } from '../src/lib/identityNotify';

describe('identity route boundaries', () => {
  it('keeps signup profile creation behind verified OTP completion', () => {
    expect(signupPage).toContain('beginSignup');
    expect(signupPage).toContain('completeVerifiedSignup');
    expect(signupPage).toContain('claimSignupSessionDelivery');
    expect(signupPage).toContain('identityTrustedRequestContext');
    expect(signupPage).toContain('sendIdentitySignupOtp');
    expect(signupPage).toContain("authMethod: 'email_otp'");
    expect(signupPage).not.toContain('getPersonByEmail');
    expect(signupPage).not.toContain('sendMagicLink');
    expect(signupPage).not.toMatch(/INSERT\s+INTO\s+people/i);
  });

  it('uses the existence-neutral verified-owner signin gateway', () => {
    expect(signinPage).toContain('beginSignin');
    expect(signinPage).toContain('identityTrustedRequestContext');
    expect(signinPage).toContain('sendIdentitySigninLink');
    expect(signinPage).toContain('scheduleIdentityDelivery');
    expect(signinPage).not.toContain('await sendIdentitySigninLink');
    expect(signinPage).toContain('resolveIdentityDeviceCookie');
    expect(signupPage).toContain('resolveIdentityDeviceCookie');
    expect(signinPage).not.toContain('getPersonByEmail');
    expect(signinPage).not.toContain('sendMagicLink');
  });

  it('schedules Team OTP delivery and hardens every OTP/session response against storage and referrers', () => {
    expect(teamApplyPage).toContain('scheduleIdentityDelivery');
    expect(teamApplyPage).toContain('Astro.locals.cfContext');
    expect(teamApplyPage).not.toContain('await sendIdentitySignupOtp');
    expect(teamApplyPage).toContain("headers.set('Cache-Control', 'no-store')");
    expect(teamApplyPage).toContain("headers.set('Referrer-Policy', 'no-referrer')");
    expect(teamApplyPage).toContain("'cache-control': 'no-store'");
    expect(teamApplyPage).toContain("'referrer-policy': 'no-referrer'");
    expect(teamApplyPage).not.toContain('return Astro.redirect');
  });

  it('schedules business continuation OTP delivery and protects the continuation page', () => {
    expect(continuationStartRoute).toContain('scheduleIdentityDelivery');
    expect(continuationStartRoute).toContain('locals.cfContext');
    expect(continuationStartRoute).not.toContain('await sendIdentitySignupOtp');
    expect(continuationPage).toContain("Astro.response.headers.set('cache-control', 'no-store')");
    expect(continuationPage).toContain("Astro.response.headers.set('referrer-policy', 'no-referrer')");
  });

  it('supports scanner-safe bound identity links and the legacy grace path', () => {
    expect(authPage).toContain('peekEmailLinkChallenge');
    expect(authPage).toContain('completeSigninLink');
    expect(authPage).toContain("searchParams.get('campus')");
    expect(authPage).toContain('consumeToken');
    expect(authPage).toContain('modern && vars.SESSION_SECRET');
    expect(authPage).toContain('loadSessionUser');
    expect(authPage).toContain("authMethod: 'magic_link'");
    expect(authPage).toContain('privateMetadata');
    expect(baseLayout).toContain('privateMetadata?: boolean');
    expect(baseLayout).toContain('!privateMetadata');
  });

  it('routes sensitive member account changes through the Security Center', () => {
    expect(securityPage).toContain('beginContactChange');
    expect(securityPage).toContain('completeContactChange');
    expect(securityPage).toContain('recentStepUpContext');
    expect(securityPage).toContain('revokeIdentitySessions');
    expect(securityPage).toContain('clearSessionCookie');
    expect(securityPage).toContain('shared / reachability');
    expect(securityPage).not.toContain('requestEmailChange');
    expect(securityPage).toContain('WHERE l.person_id=?1 AND l.ended_at IS NULL');
  });

  it('requires a target-bound OTP step-up and a safe relative return path', () => {
    expect(reauthPage).toContain('beginStepUp');
    expect(reauthPage).toContain('completeStepUp');
    expect(reauthPage).toContain("'email_otp'");
    expect(reauthPage).toContain('stepUpTime');
    expect(reauthPage).toContain('safeNext');
    expect(reauthPage).toContain('resolveIdentityDeviceCookie');
    expect(securityPage).toContain('resolveIdentityDeviceCookie');
    expect(reauthPage).not.toContain('Astro.redirect(next');
  });

  it('keeps the old email-change token endpoint permanently expired and mutation-free', () => {
    expect(legacyEmailChangePage).not.toContain('consumeEmailChange');
    expect(legacyEmailChangePage).not.toContain('peekEmailChange');
    expect(legacyEmailChangePage).not.toContain('requestEmailChange');
    expect(legacyEmailChangePage).toContain('portal.emailChange.error.title');
  });

  it('sends the completed recovery warning instead of the pending-request notice after execution', () => {
    expect(recoveryAdminPage).toContain('notificationLocale: lang');
    expect(recoveryAdminPage).toContain('deliverIdentityRecoveryNotifications');
    expect(recoveryAdminPage).not.toContain('enqueueIdentityRecoveryNotification');
    expect(recoveryAdminPage).not.toContain('sendIdentityRecoveryNotice');
  });

  it('requires explicit server-checked approval confirmation and renders a resolved target summary', () => {
    expect(recoveryAdminPage).toContain('confirm_review');
    expect(recoveryAdminPage).toContain("form.get('confirm_review')");
    expect(recoveryAdminPage).toContain('getIdentityRecoveryTargetSummary');
    expect(recoveryAdminPage).toContain('verifiedContactCategories');
    expect(recoveryAdminPage).toContain('riskCategories');
    expect(recoveryAdminPage).not.toContain('<dd>{recovery.personId');
  });
});

describe('identity verification notifications', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM email_log').run();
  });

  it('delivers signup OTP only to the gateway instruction and never logs the code', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sent = await sendIdentitySignupOtp(env, env.DB, {
      to: 'verified-target@example.test',
      publicId: '11111111-1111-4111-8111-111111111111',
      code: '123456',
      expiresAt: '2030-01-01 00:10:00',
    }, 'zh');
    const output = spy.mock.calls.flat().join('\n');
    spy.mockRestore();

    expect(sent).toBe(true);
    expect(output).toContain('to=verified-target@example.test');
    expect(output).not.toContain('123456');
    expect(output).toContain('[sensitive email body omitted]');
    const log = await env.DB.prepare('SELECT kind,detail FROM email_log ORDER BY id DESC LIMIT 1')
      .first<{ kind: string; detail: string | null }>();
    expect(log).toEqual({ kind: 'identitySignupOtp', detail: null });
  });

  it('builds the target-bound campus link without putting its secret in email_log', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sent = await sendIdentitySigninLink(env, env.DB, {
      to: 'owner@example.test',
      publicId: '22222222-2222-4222-8222-222222222222',
      token: 'secret-link-token',
      expiresAt: '2030-01-01 00:10:00',
    }, 'en', 'north-campus');
    const output = spy.mock.calls.flat().join('\n');
    spy.mockRestore();

    expect(sent).toBe(true);
    expect(output).toContain('/auth/22222222-2222-4222-8222-222222222222.secret-link-token?campus=north-campus');
    const log = await env.DB.prepare('SELECT kind,detail FROM email_log ORDER BY id DESC LIMIT 1')
      .first<{ kind: string; detail: string | null }>();
    expect(log).toEqual({ kind: 'identitySignin', detail: null });
  });

  it('delivers member-security OTPs and the old-contact alert without storing secrets in the log', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendIdentityStepUpOtp(env, env.DB, { to: 'member@example.test', publicId: crypto.randomUUID(), code: '654321', expiresAt: '2030-01-01 00:10:00' }, 'en');
    await sendIdentityContactChangeOtp(env, env.DB, { to: 'new@example.test', publicId: crypto.randomUUID(), code: '123456', expiresAt: '2030-01-01 00:10:00' }, 'zh');
    await sendIdentityOldContactNotice(env, env.DB, { to: 'old@example.test', locale: 'en' });
    spy.mockRestore();
    const { results } = await env.DB.prepare('SELECT kind,detail FROM email_log ORDER BY id').all<{ kind: string; detail: string | null }>();
    expect(results).toEqual([
      { kind: 'identityStepUpOtp', detail: null },
      { kind: 'identityContactChangeOtp', detail: null },
      { kind: 'identityOldContactNotice', detail: null },
    ]);
  });

  it('warns every old contact in the requested language after recovery ownership is replaced', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendIdentityRecoveryCompletedNotice(env, env.DB, { to: 'old-en@example.test', locale: 'en' });
    await sendIdentityRecoveryCompletedNotice(env, env.DB, { to: 'old-zh@example.test', locale: 'zh' });
    const output = spy.mock.calls.flat().join('\n');
    spy.mockRestore();

    expect(output).toContain('to=old-en@example.test');
    expect(output).toContain('verified sign-in ownership was replaced');
    expect(output).toContain('sessions were revoked');
    expect(output).toContain('report suspected fraud');
    expect(output).toContain('to=old-zh@example.test');
    expect(output).toContain('登录邮箱所有权已被替换');
    expect(output).toContain('会话已被撤销');
    expect(output).toContain('举报疑似欺诈');
    const { results } = await env.DB.prepare('SELECT kind,to_email,detail FROM email_log ORDER BY id')
      .all<{ kind: string; to_email: string; detail: string | null }>();
    expect(results).toEqual([
      { kind: 'identityRecoveryCompleted', to_email: 'old-en@example.test', detail: null },
      { kind: 'identityRecoveryCompleted', to_email: 'old-zh@example.test', detail: null },
    ]);
  });
});
