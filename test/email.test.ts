// Email choke-point tests (workers project, live D1). The devlog path (driven by
// EMAIL_DEV_LOG='1' in test/wrangler.test.jsonc) returns true and writes an
// email_log row without touching the provider; the no-sender path proves
// sendEmail never throws — it logs 'failed' and returns false.
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendEmail } from '../src/lib/email';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM email_log').run();
});

const base = {
  to: 'a@example.com',
  toName: 'Ann',
  kind: 'signin',
  subject: 'Sign in 登录',
  html: '<p>hi</p>',
  text: 'hi',
  detail: 'detail-x',
};

describe('sendEmail dev-log', () => {
  it('returns true and records a devlog row without sending', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await sendEmail(env, env.DB, base)).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    const row = await env.DB.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 1').first<{
      to_email: string;
      to_name: string;
      kind: string;
      detail: string;
      status: string;
    }>();
    expect(row).toMatchObject({
      to_email: 'a@example.com',
      to_name: 'Ann',
      kind: 'signin',
      detail: 'detail-x',
      status: 'devlog',
    });
  });
});

describe('sendEmail with no sender configured', () => {
  it('returns false, logs failed, and never throws', async () => {
    const noSender = { EMAIL_DEV_LOG: undefined, EMAIL: undefined, EMAIL_FROM: undefined };
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await sendEmail(noSender, env.DB, { ...base, kind: 'nosender' })).toBe(false);
    spy.mockRestore();

    const row = await env.DB.prepare(`SELECT status FROM email_log WHERE kind = 'nosender'`).first<{
      status: string;
    }>();
    expect(row).toMatchObject({ status: 'failed' });
  });
});
